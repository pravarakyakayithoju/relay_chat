import { type Channel, topics } from '@relay/shared';
import { pool, withTransaction } from '../../db/pool';
import { conflict, forbidden, isUniqueViolation, notFound } from '../../lib/errors';
import { cacheRequests } from '../../lib/metrics';
import { cacheDel, cacheGet, cacheSet, publish } from '../../lib/redis';
import type { AuthUser } from '../../middleware/auth';

export const memberCacheKey = (channelId: string, userId: string) =>
  `member:${channelId}:${userId}`;
const MEMBER_CACHE_TTL_SECONDS = 60;

interface ChannelRow {
  id: string;
  workspace_id: string;
  name: string;
  is_private: boolean;
}

async function assertWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  );
  if (rowCount === 0) throw forbidden('You are not a member of this workspace');
}

async function getChannel(channelId: string): Promise<ChannelRow> {
  const { rows } = await pool.query(
    'SELECT id, workspace_id, name, is_private FROM channels WHERE id = $1',
    [channelId],
  );
  if (!rows[0]) throw notFound('Channel not found');
  return rows[0];
}

/**
 * Is this user in this channel? Asked on every message send and history read,
 * so the answer is cached in Redis (cache-aside: check cache, fall back to the
 * database, store the result).
 *
 * Invalidation: join/leave delete the key. The 60 s TTL is the safety net if
 * a delete is ever missed, so a stale answer is wrong for at most a minute.
 */
export async function isChannelMember(channelId: string, userId: string): Promise<boolean> {
  const key = memberCacheKey(channelId, userId);
  const cached = await cacheGet(key);
  if (cached !== null) {
    cacheRequests.inc({ cache: 'membership', result: 'hit' });
    return cached === '1';
  }
  cacheRequests.inc({ cache: 'membership', result: 'miss' });

  const { rowCount } = await pool.query(
    'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
    [channelId, userId],
  );
  const isMember = (rowCount ?? 0) > 0;
  await cacheSet(key, isMember ? '1' : '0', MEMBER_CACHE_TTL_SECONDS);
  return isMember;
}

export async function assertChannelMember(channelId: string, userId: string): Promise<void> {
  if (!(await isChannelMember(channelId, userId))) {
    throw forbidden('You are not a member of this channel');
  }
}

/** Channels the user can see: every public channel, plus private ones they belong to. */
export async function listChannels(workspaceId: string, userId: string): Promise<Channel[]> {
  await assertWorkspaceMember(workspaceId, userId);
  const { rows } = await pool.query(
    `SELECT c.id, c.workspace_id, c.name, c.is_private,
            (cm.user_id IS NOT NULL) AS is_member,
            (cm.user_id IS NOT NULL AND COALESCE(
               (SELECT max(m.id) FROM messages m WHERE m.channel_id = c.id)
                 > COALESCE(cm.last_read_message_id, 0),
               false)) AS unread
     FROM channels c
     LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2
     WHERE c.workspace_id = $1 AND (NOT c.is_private OR cm.user_id IS NOT NULL)
     ORDER BY c.name`,
    [workspaceId, userId],
  );
  return rows.map(
    (row: ChannelRow & { is_member: boolean; unread: boolean }): Channel => ({
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      isPrivate: row.is_private,
      isMember: row.is_member,
      unread: row.unread,
    }),
  );
}

export async function createChannel(
  user: AuthUser,
  workspaceId: string,
  name: string,
  isPrivate: boolean,
): Promise<Channel> {
  await assertWorkspaceMember(workspaceId, user.id);
  let channelId: string;
  try {
    channelId = await withTransaction(async (client) => {
      const created = await client.query(
        `INSERT INTO channels (workspace_id, name, is_private, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [workspaceId, name, isPrivate, user.id],
      );
      await client.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [
        created.rows[0].id,
        user.id,
      ]);
      return created.rows[0].id as string;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`A channel named "${name}" already exists`);
    throw err;
  }

  await publish(topics.user(user.id), { type: 'membership.changed' });
  // Everyone else in the workspace should see a new public channel appear.
  if (!isPrivate) {
    await publish(topics.workspace(workspaceId), { type: 'channels.changed', workspaceId });
  }
  return { id: channelId, workspaceId, name, isPrivate, isMember: true, unread: false };
}

async function addToChannel(channelId: string, userId: string): Promise<void> {
  await pool.query(
    'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [channelId, userId],
  );
  await cacheDel(memberCacheKey(channelId, userId));
  await publish(topics.user(userId), { type: 'membership.changed' });
}

/** Join a public channel in a workspace you belong to. */
export async function joinChannel(user: AuthUser, channelId: string): Promise<void> {
  const channel = await getChannel(channelId);
  await assertWorkspaceMember(channel.workspace_id, user.id);
  if (channel.is_private) throw forbidden('This channel is private; ask a member to add you');
  await addToChannel(channelId, user.id);
}

export async function leaveChannel(user: AuthUser, channelId: string): Promise<void> {
  await pool.query('DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2', [
    channelId,
    user.id,
  ]);
  await cacheDel(memberCacheKey(channelId, user.id));
  await publish(topics.user(user.id), { type: 'membership.changed' });
}

/** An existing member adds another workspace member (the only way into a private channel). */
export async function addChannelMember(
  user: AuthUser,
  channelId: string,
  username: string,
): Promise<void> {
  const channel = await getChannel(channelId);
  await assertChannelMember(channelId, user.id);
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
     JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = $1
     WHERE u.username = $2`,
    [channel.workspace_id, username],
  );
  if (!rows[0]) throw notFound(`No one called "${username}" in this workspace`);
  await addToChannel(channelId, rows[0].id);
}
