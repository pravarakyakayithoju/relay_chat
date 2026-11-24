/** Usernames are lowercase letters, digits and underscores, 3-32 characters. */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;

/** Channel names look like Slack's: lowercase, digits, dashes, underscores. */
export const CHANNEL_NAME_PATTERN = /^[a-z0-9_-]{1,40}$/;

// An @mention must start the text or follow a character that is not part of a
// word or another @, so "mail@example.com" does not mention "example".
const MENTION_RE = /(^|[^a-z0-9_@])@([a-z0-9_]{3,32})(?![a-z0-9_])/gi;

/** Unique, lowercased usernames mentioned in a message, in order of appearance. */
export function extractMentions(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(MENTION_RE)) {
    found.add(match[2].toLowerCase());
  }
  return [...found];
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/i;

/** First http(s) URL in a message, without trailing sentence punctuation. */
export function extractFirstUrl(content: string): string | null {
  const match = content.match(URL_RE);
  if (!match) return null;
  return match[0].replace(/[.,!?;:]+$/, '');
}
