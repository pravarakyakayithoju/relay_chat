import net from 'node:net';

/**
 * Pure helpers for link previews. No network access here, so they are unit-tested.
 */

/**
 * True for addresses a link-preview fetcher must never call: loopback, private
 * networks, link-local (which includes cloud metadata at 169.254.169.254),
 * carrier-grade NAT, multicast and reserved ranges.
 *
 * Why this matters: the worker fetches URLs that users typed. Without this
 * check, posting "http://169.254.169.254/..." or "http://postgres:5432" would
 * make our own server request internal services on the attacker's behalf
 * (server-side request forgery, SSRF).
 */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    // IPv4-mapped IPv6 (::ffff:10.0.0.1): judge the embedded IPv4 address.
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice('::ffff:'.length);
      return net.isIPv4(mapped) ? isPrivateAddress(mapped) : true;
    }
    return (
      lower.startsWith('fc') || // unique local fc00::/7
      lower.startsWith('fd') ||
      /^fe[89ab]/.test(lower) || // link-local fe80::/10
      lower.startsWith('ff') // multicast
    );
  }
  return true; // not an IP address at all: refuse
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function clean(value: string | undefined, maxLength: number): string | null {
  if (!value) return null;
  const text = value
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39|#x27);/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function metaContent(html: string, name: string): string | undefined {
  // Attributes can come in either order: <meta property=".." content=".."> or the reverse.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forward = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
    'i',
  );
  const reverse = new RegExp(
    `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${escaped}["']`,
    'i',
  );
  return html.match(forward)?.[1] ?? html.match(reverse)?.[1];
}

/** Title and description from a page's Open Graph tags, falling back to <title> and meta description. */
export function parsePreview(html: string): { title: string | null; description: string | null } {
  const title = metaContent(html, 'og:title') ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const description = metaContent(html, 'og:description') ?? metaContent(html, 'description');
  return { title: clean(title, 200), description: clean(description, 300) };
}
