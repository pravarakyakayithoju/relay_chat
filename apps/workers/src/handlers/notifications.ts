import {
  type MessageCreatedEvent,
  type Notification,
  type ServerEvent,
  extractMentions,
  topics,
} from '@relay/shared';
import { isForeignKeyViolation, pool, redis } from '../lib';

const PREVIEW_LENGTH = 140;

/**
 * Creates a notification for every @mentioned user who is in the channel.
 *
 * Idempotent: notifications has UNIQUE (user_id, message_id, type), so
 * handling the same event twice inserts nothing the second time - and because
 * we only push to users whose row was actually inserted, nobody is pinged twice.
 */
export async function handleNotifications(event: MessageCreatedEvent): Promise<void> {
  const { message } = event;
  const usernames = extractMentions(message.content);
  if (usernames.length === 0) return;

  const preview =
    message.content.length > PREVIEW_LENGTH
      ? `${message.content.slice(0, PREVIEW_LENGTH)}...`
      : message.content;

  let rows: { id: string; user_id: string; created_at: Date }[];
  try {
    const result = await pool.query(
      `INSERT INTO notifications (user_id, type, channel_id, message_id, actor_id, preview)
       SELECT u.id, 'mention', $1, $2, $3, $4
       FROM users u
       JOIN channel_members cm ON cm.user_id = u.id AND cm.channel_id = $1
       WHERE u.username = ANY($5::text[]) AND u.id <> $3
       ON CONFLICT (user_id, message_id, type) DO NOTHING
       RETURNING id, user_id, created_at`,
      [message.channelId, message.id, message.userId, preview, usernames],
    );
    rows = result.rows;
  } catch (err) {
    // The channel or the author was deleted after the message was sent: nothing to notify.
    if (isForeignKeyViolation(err)) return;
    throw err;
  }

  await Promise.all(
    rows.map((row) => {
      const notification: Notification = {
        id: row.id,
        type: 'mention',
        channelId: message.channelId,
        messageId: message.id,
        actorUsername: message.username,
        preview,
        createdAt: row.created_at.toISOString(),
        read: false,
      };
      const push: ServerEvent = { type: 'notification.new', notification };
      return redis.publish(topics.user(row.user_id), JSON.stringify(push));
    }),
  );
}
