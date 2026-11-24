import type { LinkPreview, Message, Notification } from './types';

/**
 * Redis pub/sub topic names. A gateway subscribes to a topic only while at
 * least one of its connected users cares about it.
 */
export const topics = {
  /** Everything that happens inside one channel: new messages, typing, previews. */
  channel: (channelId: string) => `channel:${channelId}`,
  /** Workspace-wide signals: presence changes, channel list changes. */
  workspace: (workspaceId: string) => `workspace:${workspaceId}`,
  /** Events addressed to one user on any device: notifications, membership changes. */
  user: (userId: string) => `user:${userId}`,
};

/** Kafka topic names. */
export const KAFKA_TOPICS = {
  messageEvents: 'chat.message-events',
  deadLetter: 'chat.message-events.dlq',
} as const;

/**
 * The durable event written to the outbox table in the same transaction as
 * the message, then relayed to Kafka. Consumers must be idempotent because
 * delivery is at-least-once: use `eventId` (or the message id) to deduplicate.
 */
export interface MessageCreatedEvent {
  eventId: string;
  type: 'message.created';
  occurredAt: string;
  workspaceId: string;
  message: Message;
}

/** Events the server pushes to browsers over the WebSocket. */
export type ServerEvent =
  | { type: 'ready'; userId: string }
  | { type: 'pong' }
  | { type: 'error'; message: string }
  | { type: 'message.new'; message: Message }
  | { type: 'message.preview'; channelId: string; messageId: string; preview: LinkPreview }
  | { type: 'typing'; channelId: string; userId: string; username: string }
  | { type: 'presence.update'; userId: string; status: 'online' | 'offline' }
  | { type: 'notification.new'; notification: Notification }
  | { type: 'membership.changed' }
  | { type: 'channels.changed'; workspaceId: string }
  | { type: 'members.changed'; workspaceId: string };

/** Events a browser may send to the server over the WebSocket. */
export type ClientEvent =
  | { type: 'auth'; token: string }
  | { type: 'ping' }
  | { type: 'typing'; channelId: string };
