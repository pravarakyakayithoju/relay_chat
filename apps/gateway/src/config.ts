import os from 'node:os';

const env = process.env;

export const config = {
  port: Number(env.GATEWAY_PORT ?? env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://chat:chat@localhost:5432/chat',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: env.JWT_SECRET ?? 'dev-secret-change-me',
  logLevel: env.LOG_LEVEL ?? 'info',
  instance: os.hostname(),

  /** A new socket must authenticate within this time or it is closed. */
  authTimeoutMs: 5_000,
  /** How often every socket is pinged and presence is refreshed. */
  heartbeatIntervalMs: 30_000,
  /** A client whose unsent data exceeds this is too slow and gets disconnected. */
  maxBufferedBytes: 1024 * 1024,
  /** Largest frame a client may send. Clients only send tiny control messages. */
  maxPayloadBytes: 16 * 1024,
};
