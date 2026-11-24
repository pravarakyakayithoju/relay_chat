import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import pino from 'pino';
import client from 'prom-client';
import { topics } from '@relay/shared';
import { config } from './config';

export const logger = pino({
  level: config.logLevel,
  base: { service: 'gateway', instance: config.instance },
});

/**
 * Two Redis connections. A connection that has issued SUBSCRIBE can do nothing
 * else, so one is dedicated to receiving and one to commands (PUBLISH, presence).
 */
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
export const subscriber = new Redis(config.redisUrl);
redis.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis error'));
subscriber.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis subscriber error'));

/** The gateway only reads memberships, so a small pool is enough. */
export const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
pool.on('error', (err: Error) => logger.error({ err: err.message }, 'idle postgres client error'));

/** Same check as the API: any instance can verify a token with the shared secret. */
export function verifyToken(token: string): { id: string; username: string } | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload === 'string') return null;
    if (typeof payload.sub !== 'string' || typeof payload.username !== 'string') return null;
    return { id: payload.sub, username: payload.username };
  } catch {
    return null;
  }
}

/** Every topic a user should receive: their channels, their workspaces, and their own. */
export async function loadTopics(userId: string): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT 'c' AS kind, channel_id AS id FROM channel_members WHERE user_id = $1
     UNION ALL
     SELECT 'w' AS kind, workspace_id AS id FROM workspace_members WHERE user_id = $1`,
    [userId],
  );
  const wanted = new Set<string>([topics.user(userId)]);
  for (const row of rows as { kind: string; id: string }[]) {
    wanted.add(row.kind === 'c' ? topics.channel(row.id) : topics.workspace(row.id));
  }
  return wanted;
}

// --- metrics ---------------------------------------------------------------

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'gateway' });
client.collectDefaultMetrics({ register: registry });

export const connectionsGauge = new client.Gauge({
  name: 'ws_connections',
  help: 'Open WebSocket connections on this gateway instance',
  registers: [registry],
});

export const eventsDelivered = new client.Counter({
  name: 'ws_events_delivered_total',
  help: 'Events written to client sockets',
  registers: [registry],
});

export const slowConsumersDropped = new client.Counter({
  name: 'ws_slow_consumers_dropped_total',
  help: 'Connections closed because the client could not keep up',
  registers: [registry],
});

export const subscribedTopics = new client.Gauge({
  name: 'ws_subscribed_topics',
  help: 'Redis topics this gateway instance is subscribed to',
  registers: [registry],
});
