import type { MessageCreatedEvent } from '@relay/shared';
import { isForeignKeyViolation, pool } from '../lib';

/**
 * Copies each message into the search read model.
 *
 * This is the "CQRS" idea in miniature: writes go to `messages`, searches read
 * from `message_search`, and this worker keeps the second in step with the
 * first by following the event stream. The read model can be dropped and
 * rebuilt at any time by replaying the topic from the beginning.
 *
 * Idempotent: the primary key is the message id, so a redelivered event is a no-op.
 */
export async function handleSearchIndex(event: MessageCreatedEvent): Promise<void> {
  const { message, workspaceId } = event;
  try {
    await pool.query(
      `INSERT INTO message_search (message_id, channel_id, workspace_id, user_id, content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (message_id) DO NOTHING`,
      [message.id, message.channelId, workspaceId, message.userId, message.content, message.createdAt],
    );
  } catch (err) {
    // The channel was deleted before we got here: there is nothing left to index.
    if (isForeignKeyViolation(err)) return;
    throw err;
  }
}
