import type { ServerEvent } from '@relay/shared';
import { hasFreshConnection } from './freshness';
import { logger, redis } from './lib';

/**
 * Presence: who is online right now.
 *
 * A user can be connected to several gateways at once (laptop + phone), so no
 * single gateway knows the answer. The shared truth lives in Redis:
 *
 *   presence:{userId}   hash   { connectionId -> last heartbeat (ms) }   TTL 90 s
 *
 * - connect:    add this connection's field
 * - heartbeat:  refresh the timestamp and the key's TTL (every 30 s)
 * - disconnect: remove the field
 *
 * The user is online while the hash holds at least one fresh field. If a
 * gateway crashes without cleaning up, its fields stop being refreshed and
 * are ignored once stale; when nothing refreshes the key, Redis expires it.
 * So a crash can leave someone "online" for at most ~90 seconds - never forever.
 */
const KEY_TTL_SECONDS = 90;
const key = (userId: string) => `presence:${userId}`;

async function broadcast(
  userId: string,
  status: 'online' | 'offline',
  workspaceTopics: string[],
): Promise<void> {
  const event: ServerEvent = { type: 'presence.update', userId, status };
  const payload = JSON.stringify(event);
  // Only people who share a workspace with this user hear about it.
  await Promise.all(workspaceTopics.map((topic) => redis.publish(topic, payload)));
}

export async function connected(
  userId: string,
  connId: string,
  workspaceTopics: string[],
): Promise<void> {
  try {
    const now = Date.now();
    const wasOnline = hasFreshConnection(await redis.hgetall(key(userId)), now);
    await redis.multi().hset(key(userId), connId, String(now)).expire(key(userId), KEY_TTL_SECONDS).exec();
    if (!wasOnline) await broadcast(userId, 'online', workspaceTopics);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'presence connect failed');
  }
}

export async function disconnected(
  userId: string,
  connId: string,
  workspaceTopics: string[],
): Promise<void> {
  try {
    await redis.hdel(key(userId), connId);
    const stillOnline = hasFreshConnection(await redis.hgetall(key(userId)), Date.now());
    if (!stillOnline) {
      await redis.del(key(userId));
      await broadcast(userId, 'offline', workspaceTopics);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'presence disconnect failed');
  }
}

/** Refresh every local connection in a single pipeline (one network round trip). */
export async function heartbeat(connections: { userId: string; connId: string }[]): Promise<void> {
  if (connections.length === 0) return;
  try {
    const now = String(Date.now());
    const pipeline = redis.pipeline();
    for (const { userId, connId } of connections) {
      pipeline.hset(key(userId), connId, now);
      pipeline.expire(key(userId), KEY_TTL_SECONDS);
    }
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'presence heartbeat failed');
  }
}
