import { randomBytes } from 'node:crypto';
import { type Member, type Workspace, topics } from '@relay/shared';
import { pool, withTransaction } from '../../db/pool';
import { forbidden, notFound } from '../../lib/errors';
import { cacheDel, publish, redis } from '../../lib/redis';
import type { AuthUser } from '../../middleware/auth';
import { memberCacheKey } from '../channels/service';

interface WorkspaceRow {
  id: string;
  name: string;
  invite_code: string;
  role: 'owner' | 'member';
}

const toWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  name: row.name,
  inviteCode: row.invite_code,
  role: row.role,
});

export async function listWorkspaces(userId: string): Promise<Workspace[]> {
  const { rows } = await pool.query(
    `SELECT w.id, w.name, w.invite_code, m.role
     FROM workspaces w
     JOIN workspace_members m ON m.workspace_id = w.id
     WHERE m.user_id = $1
     ORDER BY w.name`,
    [userId],
  );
  return rows.map(toWorkspace);
}

/** Creates the workspace, makes the creator its owner, and adds a #general channel. */
export async function createWorkspace(user: AuthUser, name: string): Promise<Workspace> {
  const inviteCode = randomBytes(9).toString('base64url');
  const workspace = await withTransaction(async (client) => {
    const created = await client.query(
      `INSERT INTO workspaces (name, owner_id, invite_code) VALUES ($1, $2, $3) RETURNING id`,
      [name, user.id, inviteCode],
    );
    const workspaceId: string = created.rows[0].id;
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [workspaceId, user.id],
    );
    const channel = await client.query(
      `INSERT INTO channels (workspace_id, name, created_by) VALUES ($1, 'general', $2) RETURNING id`,
      [workspaceId, user.id],
    );
    await client.query(`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, [
      channel.rows[0].id,
      user.id,
    ]);
    return toWorkspace({ id: workspaceId, name, invite_code: inviteCode, role: 'owner' });
  });

  // Tell this user's open sockets to subscribe to the new workspace and channel.
  await publish(topics.user(user.id), { type: 'membership.changed' });
  return workspace;
}

/** Joins via invite code. Safe to call twice: joining again changes nothing. */
export async function joinWorkspace(user: AuthUser, inviteCode: string): Promise<Workspace> {
  const { workspace, joinedChannelIds } = await withTransaction(async (client) => {
    const found = await client.query(
      'SELECT id, name, invite_code FROM workspaces WHERE invite_code = $1',
      [inviteCode],
    );
    if (found.rowCount === 0) throw notFound('No workspace with that invite code');
    const row = found.rows[0];

    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [row.id, user.id],
    );
    const joined = await client.query(
      `INSERT INTO channel_members (channel_id, user_id)
       SELECT id, $2 FROM channels WHERE workspace_id = $1 AND name = 'general'
       ON CONFLICT DO NOTHING
       RETURNING channel_id`,
      [row.id, user.id],
    );
    const membership = await client.query(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [row.id, user.id],
    );
    return {
      workspace: toWorkspace({ ...row, role: membership.rows[0].role }),
      joinedChannelIds: joined.rows.map((r: { channel_id: string }) => r.channel_id),
    };
  });

  await cacheDel(...joinedChannelIds.map((id) => memberCacheKey(id, user.id)));
  await publish(topics.user(user.id), { type: 'membership.changed' });
  // Existing members see the newcomer appear in the member list.
  await publish(topics.workspace(workspace.id), { type: 'members.changed', workspaceId: workspace.id });
  return workspace;
}

export async function assertWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  );
  if (rowCount === 0) throw forbidden('You are not a member of this workspace');
}

/** Members with their online status, read from the presence keys the gateways maintain. */
export async function listMembers(workspaceId: string): Promise<Member[]> {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, m.role
     FROM workspace_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = $1
     ORDER BY u.username`,
    [workspaceId],
  );

  let online: boolean[] = rows.map(() => false);
  try {
    // One round trip for all members instead of one EXISTS per member.
    const pipeline = redis.pipeline();
    for (const row of rows) pipeline.exists(`presence:${row.id}`);
    const results = await pipeline.exec();
    if (results) online = results.map(([err, value]) => !err && value === 1);
  } catch {
    // Presence is a nice-to-have: show everyone offline rather than fail the request.
  }

  return rows.map((row: { id: string; username: string; role: 'owner' | 'member' }, i: number) => ({
    id: row.id,
    username: row.username,
    role: row.role,
    online: online[i] ?? false,
  }));
}
