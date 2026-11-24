import { lookup } from 'node:dns/promises';
import {
  type LinkPreview,
  type MessageCreatedEvent,
  type ServerEvent,
  extractFirstUrl,
  topics,
} from '@relay/shared';
import { isForeignKeyViolation, logger, pool, redis } from '../lib';
import { isPrivateAddress, parsePreview } from './previewParser';

const FETCH_TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Refuse URLs that point inside our own network (SSRF protection - see
 * previewParser.ts). Every hostname is resolved and every address it maps to
 * must be public.
 *
 * Known gap, kept simple on purpose: the address is checked here and resolved
 * again by fetch(), so a hostile DNS server could answer differently the
 * second time ("DNS rebinding"). A hardened version pins the checked IP for
 * the request, or runs this worker in a network with no route to internal
 * services.
 */
async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('address is not public');
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString('utf8');
}

/** Fetch a page and extract its title/description. Returns null if there is nothing usable. */
export async function fetchPreview(rawUrl: string): Promise<LinkPreview | null> {
  let url = new URL(rawUrl);
  // Redirects are followed by hand so that every hop is checked, not just the first.
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'RelayLinkPreview/1.0', accept: 'text/html' },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) return null;
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) return null;

    const { title, description } = parsePreview(await readCapped(response, MAX_BODY_BYTES));
    if (!title && !description) return null;
    return { url: url.toString(), title, description };
  }
  return null;
}

/**
 * Adds a link preview to messages that contain a URL, then tells the channel.
 *
 * This is the textbook reason for a queue: fetching someone else's website can
 * take seconds or hang. Doing it inside the "send message" request would make
 * every send as slow as the slowest site anyone links to.
 */
export async function handleLinkPreview(event: MessageCreatedEvent): Promise<void> {
  const { message } = event;
  const url = extractFirstUrl(message.content);
  if (!url) return;

  // Idempotency: a redelivered event must not fetch the page again.
  const existing = await pool.query('SELECT 1 FROM link_previews WHERE message_id = $1', [message.id]);
  if ((existing.rowCount ?? 0) > 0) return;

  let preview: LinkPreview | null;
  try {
    preview = await fetchPreview(url);
  } catch (err) {
    // A site being down or refusing us is normal, not an error worth retrying.
    logger.debug({ url, err: (err as Error).message }, 'link preview skipped');
    return;
  }
  if (!preview) return;

  try {
    await pool.query(
      `INSERT INTO link_previews (message_id, channel_id, url, title, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id) DO NOTHING`,
      [message.id, message.channelId, preview.url, preview.title, preview.description],
    );
  } catch (err) {
    if (isForeignKeyViolation(err)) return;
    throw err;
  }

  // The cached first page of this channel was built without the preview.
  await redis.del(`recent:${message.channelId}`);
  const update: ServerEvent = {
    type: 'message.preview',
    channelId: message.channelId,
    messageId: message.id,
    preview,
  };
  await redis.publish(topics.channel(message.channelId), JSON.stringify(update));
}
