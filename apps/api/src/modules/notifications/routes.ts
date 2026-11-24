import { Router } from 'express';
import type { Notification } from '@relay/shared';
import { pool } from '../../db/pool';
import { asyncHandler, currentUser } from '../../lib/http';

/** Notifications are created by the notifications worker; the API only reads and clears them. */
export const notificationsRouter = Router();

notificationsRouter.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT n.id, n.type, n.channel_id, n.message_id, a.username AS actor_username,
              n.preview, n.created_at, n.read_at
       FROM notifications n
       JOIN users a ON a.id = n.actor_id
       WHERE n.user_id = $1
       ORDER BY n.id DESC
       LIMIT 30`,
      [currentUser(req).id],
    );
    const notifications: Notification[] = rows.map(
      (row: {
        id: string;
        channel_id: string;
        message_id: string;
        actor_username: string;
        preview: string;
        created_at: Date;
        read_at: Date | null;
      }) => ({
        id: row.id,
        type: 'mention' as const,
        channelId: row.channel_id,
        messageId: row.message_id,
        actorUsername: row.actor_username,
        preview: row.preview,
        createdAt: row.created_at.toISOString(),
        read: row.read_at !== null,
      }),
    );
    res.json({ notifications, unread: notifications.filter((n) => !n.read).length });
  }),
);

notificationsRouter.post(
  '/notifications/read',
  asyncHandler(async (req, res) => {
    await pool.query(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
      [currentUser(req).id],
    );
    res.status(204).end();
  }),
);
