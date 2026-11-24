import { Router } from 'express';
import { z } from 'zod';
import type { SearchHit } from '@relay/shared';
import { readPool } from '../../db/pool';
import { asyncHandler, currentUser } from '../../lib/http';
import { assertWorkspaceMember } from '../workspaces/service';

const searchSchema = z.object({
  workspaceId: z.string().uuid(),
  q: z.string().trim().min(2, 'type at least 2 characters').max(100),
});

/**
 * Full-text search over the `message_search` read model.
 *
 * That table is filled by the search-indexer worker from Kafka, so results are
 * eventually consistent: a message becomes searchable a moment after it is
 * sent. The permission filter runs at query time, so a private channel's
 * messages are only ever returned to its members.
 */
const SEARCH_SQL = `
  SELECT s.message_id, s.channel_id, c.name AS channel_name, u.username, s.content, s.created_at
  FROM message_search s
  JOIN channels c ON c.id = s.channel_id
  JOIN users u ON u.id = s.user_id
  WHERE s.workspace_id = $1
    AND s.tsv @@ websearch_to_tsquery('english', $2)
    AND (NOT c.is_private OR EXISTS (
          SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.user_id = $3))
  ORDER BY s.message_id DESC
  LIMIT 20`;

export const searchRouter = Router();

searchRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const { workspaceId, q } = searchSchema.parse(req.query);
    await assertWorkspaceMember(workspaceId, user.id);
    const { rows } = await readPool.query(SEARCH_SQL, [workspaceId, q, user.id]);
    const hits: SearchHit[] = rows.map(
      (row: {
        message_id: string;
        channel_id: string;
        channel_name: string;
        username: string;
        content: string;
        created_at: Date;
      }) => ({
        messageId: row.message_id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        username: row.username,
        content: row.content,
        createdAt: row.created_at.toISOString(),
      }),
    );
    res.json({ hits });
  }),
);
