import Redis from 'ioredis';
import type { ServerEvent } from '@relay/shared';
import { config } from '../config';
import { logger } from './logger';

/**
 * One Redis connection for commands: cache, rate limits, presence lookups and
 * PUBLISH. (Subscribing needs a dedicated connection; only the gateway does that.)
 */
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });

redis.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis error'));

/**
 * Publish a real-time event for the gateways to fan out.
 *
 * Best effort by design: the message is already committed in Postgres, so if
 * Redis is down the send still succeeds and clients catch up from history
 * when they next load the channel or reconnect.
 */
export async function publish(topic: string, event: ServerEvent): Promise<void> {
  try {
    await redis.publish(topic, JSON.stringify(event));
  } catch (err) {
    logger.warn({ err: (err as Error).message, topic, type: event.type }, 'publish failed');
  }
}

/** Cache helpers that never throw: a cache outage must degrade speed, not correctness. */
export async function cacheGet(key: string): Promise<string | null> {
  try {
    return await redis.get(key);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(key, value, 'EX', ttlSeconds);
  } catch {
    /* ignore */
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch {
    /* ignore */
  }
}
