import os from 'node:os';
import { nodeIdFromString } from '@relay/shared';

const env = process.env;
const DEV_SECRET = 'dev-secret-change-me';

export const config = {
  env: env.NODE_ENV ?? 'development',
  port: Number(env.PORT ?? 3000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://chat:chat@localhost:5432/chat',
  /** Optional read replica. History and search read from it when set. */
  databaseReadUrl: env.DATABASE_READ_URL || null,
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: env.JWT_SECRET ?? DEV_SECRET,
  jwtExpiresInSeconds: Number(env.JWT_EXPIRES_IN_SECONDS ?? 7 * 24 * 60 * 60),
  logLevel: env.LOG_LEVEL ?? 'info',
  /** How long the first page of a channel's history is cached. 0 turns the cache off. */
  recentCacheTtlSeconds: Number(env.RECENT_CACHE_TTL_SECONDS ?? 30),
  /** Rate limits. Raised via the environment when load testing from a single machine. */
  authRateLimitPerMinute: Number(env.AUTH_RATE_LIMIT ?? 20),
  sendRateLimitPer10s: Number(env.SEND_RATE_LIMIT ?? 30),
  /** Shown in logs, metrics and the X-Instance response header. */
  instance: os.hostname(),
  /** Snowflake node id. Must differ between API processes running at the same time. */
  nodeId: env.NODE_ID ? Number(env.NODE_ID) : nodeIdFromString(`${os.hostname()}:${process.pid}`),
};

if (config.env === 'production' && config.jwtSecret === DEV_SECRET) {
  throw new Error('JWT_SECRET must be set to a real secret when NODE_ENV=production');
}
