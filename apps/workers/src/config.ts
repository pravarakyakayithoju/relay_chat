import os from 'node:os';

const env = process.env;

export type WorkerName = 'outbox' | 'notifications' | 'search' | 'previews';
const ALL_WORKERS: WorkerName[] = ['outbox', 'notifications', 'search', 'previews'];

function parseWorkers(value: string | undefined): WorkerName[] {
  if (!value) return ALL_WORKERS;
  const names = value.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !ALL_WORKERS.includes(name as WorkerName));
  if (unknown.length > 0) {
    throw new Error(`Unknown worker(s) in WORKERS: ${unknown.join(', ')}. Valid: ${ALL_WORKERS.join(', ')}`);
  }
  return names as WorkerName[];
}

export const config = {
  databaseUrl: env.DATABASE_URL ?? 'postgres://chat:chat@localhost:5432/chat',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  kafkaBrokers: (env.KAFKA_BROKERS ?? 'localhost:19092').split(',').map((b) => b.trim()),
  /**
   * Which workers this process runs. One process runs all of them by default;
   * in production each would be its own deployment so they scale separately.
   */
  workers: parseWorkers(env.WORKERS),
  metricsPort: Number(env.WORKERS_METRICS_PORT ?? 9100),
  logLevel: env.LOG_LEVEL ?? 'info',
  instance: os.hostname(),

  outboxBatchSize: 100,
  outboxIdleDelayMs: 250,
  /** Attempts per event before it is parked on the dead-letter topic. */
  maxHandlerAttempts: 3,
};
