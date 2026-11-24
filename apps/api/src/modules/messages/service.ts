import {
  KAFKA_TOPICS,
  type Message,
  type MessageCreatedEvent,
  type MessagePage,
  topics,
} from '@relay/shared';
import { config } from '../../config';
import { pool, readPool, withTransaction } from '../../db/pool';
import { nextMessageId } from '../../lib/ids';
import { cacheRequests, messagesSent } from '../../lib/metrics';
import { cacheDel, cacheGet, cacheSet, publish } from '../../lib/redis';
import type { AuthUser } from '../../middleware/auth';
import { assertChannelMember } from '../channels/service';

export const DEFAULT_PAGE_SIZE = 50;
const recentCacheKey = (channelId: string) => `recent:${channelId}`;

interface MessageRow {
  id: string;
  channel_id: string;
  user_id: string;
  username: string;
  content: string;
  created_at: Date;
  client_msg_id: string | null;
  preview_url: string | null;
  preview_title: string | null;
  preview_description: string | null;
}

const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  channelId: row.channel_id,
  userId: row.user_id,
  username: row.username,
  content: row.content,
  createdAt: row.created_at.toISOString(),
  clientMessageId: row.client_msg_id,
  preview: row.preview_url
    ? { url: row.preview_url, title: row.preview_title, description: row.preview_description }
    : null,
});

const SELECT_MESSAGE = `
  SELECT m.id, m.channel_id, m.user_id, u.username, m.content, m.created_at, m.client_msg_id,
         p.url AS preview_url, p.title AS preview_title, p.description AS preview_description
  FROM messages m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN link_previews p ON p.message_id = m.id`;

/**
 * Send a message.
 *
 * 1. Authorise: the sender must be in the channel (cached lookup).
 * 2. One transaction writes the message AND an outbox row describing it.
 *    Both commit or neither does, so background work can never miss a message
 *    and can never act on one that was rolled back.
 * 3. After commit, publish to Redis so gateways push it to connected clients.
 *
 * Idempotency: if the client passes `clientMessageId` and retries (timeout,
 * flaky network, double click), the unique constraint makes the second insert
 * a no-op and we return the message that already exists.
 */
export async function sendMessage(
  user: AuthUser,
  channelId: string,
  content: string,
  clientMessageId: string | null,
): Promise<{ message: Message; duplicate: boolean }> {
  await assertChannelMember(channelId, user.id);
  const id = nextMessageId();

  const result = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO messages (id, channel_id, user_id, content, client_msg_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_id, user_id, client_msg_id) DO NOTHING
       RETURNING created_at`,
      [id, channelId, user.id, content, clientMessageId],
    );

    if (inserted.rowCount === 0) {
      const existing = await client.query(
        `${SELECT_MESSAGE}
         WHERE m.channel_id = $1 AND m.user_id = $2 AND m.client_msg_id = $3`,
        [channelId, user.id, clientMessageId],
      );
      return { message: toMessage(existing.rows[0]), duplicate: true };
    }

    const message: Message = {
      id,
      channelId,
      userId: user.id,
      username: user.username,
      content,
      createdAt: (inserted.rows[0].created_at as Date).toISOString(),
      clientMessageId,
      preview: null,
    };

    const channel = await client.query('SELECT workspace_id FROM channels WHERE id = $1', [
      channelId,
    ]);
    const event: MessageCreatedEvent = {
      eventId: id,
      type: 'message.created',
      occurredAt: message.createdAt,
      workspaceId: channel.rows[0].workspace_id,
      message,
    };
    // Keyed by channel so all events for one channel land on one Kafka partition, in order.
    await client.query('INSERT INTO outbox (topic, key, payload) VALUES ($1, $2, $3)', [
      KAFKA_TOPICS.messageEvents,
      channelId,
      JSON.stringify(event),
    ]);
    return { message, duplicate: false };
  });

  if (!result.duplicate) {
    messagesSent.inc();
    // Invalidate before publishing: a client that reacts to the event by
    // refetching must not be served the page cached before this message.
    await cacheDel(recentCacheKey(channelId));
    await publish(topics.channel(channelId), { type: 'message.new', message: result.message });
  }
  return result;
}

/**
 * One page of history, newest first.
 *
 * Cursor (keyset) pagination: "messages with id < cursor", answered straight
 * from the (channel_id, id) index in the same time for page 1 and page 10,000.
 * OFFSET pagination would read and throw away every skipped row, and would
 * skip or repeat messages whenever new ones arrive between two requests.
 */
export async function listMessages(
  user: AuthUser,
  channelId: string,
  before: string | null,
  limit: number,
): Promise<MessagePage> {
  await assertChannelMember(channelId, user.id);

  // The first page of a busy channel is requested far more than any other
  // (every time someone opens the channel), so that is the one worth caching.
  const cacheable =
    config.recentCacheTtlSeconds > 0 && before === null && limit === DEFAULT_PAGE_SIZE;
  if (cacheable) {
    const cached = await cacheGet(recentCacheKey(channelId));
    if (cached) {
      cacheRequests.inc({ cache: 'recent_messages', result: 'hit' });
      return JSON.parse(cached) as MessagePage;
    }
    cacheRequests.inc({ cache: 'recent_messages', result: 'miss' });
  }

  const { rows } = before
    ? await readPool.query(
        `${SELECT_MESSAGE} WHERE m.channel_id = $1 AND m.id < $2 ORDER BY m.id DESC LIMIT $3`,
        [channelId, before, limit],
      )
    : await readPool.query(
        `${SELECT_MESSAGE} WHERE m.channel_id = $1 ORDER BY m.id DESC LIMIT $2`,
        [channelId, limit],
      );

  const messages = rows.map(toMessage);
  const page: MessagePage = {
    messages,
    nextCursor: messages.length === limit ? messages[messages.length - 1].id : null,
  };
  if (cacheable) {
    await cacheSet(recentCacheKey(channelId), JSON.stringify(page), config.recentCacheTtlSeconds);
  }
  return page;
}

/** Move the user's read marker forward (never backwards). */
export async function markRead(user: AuthUser, channelId: string, messageId: string): Promise<void> {
  await pool.query(
    `UPDATE channel_members
     SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), $3::bigint)
     WHERE channel_id = $1 AND user_id = $2`,
    [channelId, user.id, messageId],
  );
}
