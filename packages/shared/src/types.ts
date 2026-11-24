/**
 * API data shapes. These are the JSON bodies the REST API returns and the
 * payloads carried inside real-time events, so the API, the gateway, the
 * workers and the web app all agree on one definition.
 *
 * IDs are strings everywhere: UUIDs for users/workspaces/channels, and
 * Snowflake IDs (64-bit integers, too big for a JS number) for messages.
 */

export interface PublicUser {
  id: string;
  username: string;
}

export interface Workspace {
  id: string;
  name: string;
  inviteCode: string;
  role: 'owner' | 'member';
}

export interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  isPrivate: boolean;
  /** Whether the requesting user has joined this channel. */
  isMember: boolean;
  /** True when the channel has messages newer than the user's read marker. */
  unread: boolean;
}

export interface Member extends PublicUser {
  role: 'owner' | 'member';
  online: boolean;
}

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
}

export interface Message {
  id: string;
  channelId: string;
  userId: string;
  username: string;
  content: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** Idempotency key supplied by the client, if any. */
  clientMessageId: string | null;
  /** Filled in asynchronously by the link-preview worker. */
  preview: LinkPreview | null;
}

export interface MessagePage {
  /** Newest first. */
  messages: Message[];
  /** Pass as `before` to fetch the next (older) page. Null when there is no more history. */
  nextCursor: string | null;
}

export interface SearchHit {
  messageId: string;
  channelId: string;
  channelName: string;
  username: string;
  content: string;
  createdAt: string;
}

export interface Notification {
  id: string;
  type: 'mention';
  channelId: string;
  messageId: string;
  actorUsername: string;
  preview: string;
  createdAt: string;
  read: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
