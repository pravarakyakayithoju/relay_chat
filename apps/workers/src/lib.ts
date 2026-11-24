import Redis from 'ioredis';
import { Kafka, logLevel } from 'kafkajs';
import { Pool } from 'pg';
import pino from 'pino';
import client from 'prom-client';
import { KAFKA_TOPICS } from '@relay/shared';
import { config } from './config';

export const logger = pino({
  level: config.logLevel,
  base: { service: 'workers', instance: config.instance },
});

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (err: Error) => logger.error({ err: err.message }, 'idle postgres client error'));

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
redis.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis error'));

// kafkajs 2.x prints a notice about its default partitioner on startup.
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

export const kafka = new Kafka({
  clientId: `relay-workers-${config.instance}`,
  brokers: config.kafkaBrokers,
  logLevel: logLevel.WARN,
  // The broker may still be starting when we do: keep retrying for a while.
  retry: { initialRetryTime: 500, retries: 12 },
});

export const producer = kafka.producer();

/**
 * Create the topics up front with an explicit partition count instead of
 * relying on auto-creation (which gives 1 partition).
 *
 * Partitions are Kafka's unit of parallelism: a consumer group can have at
 * most one active consumer per partition, so 3 partitions means each worker
 * type can scale to 3 instances.
 */
export async function ensureTopics(): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        { topic: KAFKA_TOPICS.messageEvents, numPartitions: 3, replicationFactor: 1 },
        { topic: KAFKA_TOPICS.deadLetter, numPartitions: 1, replicationFactor: 1 },
      ],
    });
  } finally {
    await admin.disconnect();
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}
/** The row we point at was deleted (for example the channel was removed). */
export const isForeignKeyViolation = (err: unknown) => pgErrorCode(err) === '23503';

// --- metrics ---------------------------------------------------------------

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'workers' });
client.collectDefaultMetrics({ register: registry });

export const outboxPublished = new client.Counter({
  name: 'outbox_published_total',
  help: 'Outbox rows relayed to Kafka',
  registers: [registry],
});

export const outboxPending = new client.Gauge({
  name: 'outbox_pending',
  help: 'Outbox rows waiting to be relayed. Should stay near zero; growth means the relay is behind.',
  registers: [registry],
});

export const eventsProcessed = new client.Counter({
  name: 'worker_events_total',
  help: 'Events handled by each worker, by result (ok, retried, dead_letter, invalid)',
  labelNames: ['worker', 'result'],
  registers: [registry],
});
