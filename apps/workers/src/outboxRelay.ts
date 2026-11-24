import { config } from './config';
import { logger, outboxPending, outboxPublished, pool, producer, sleep } from './lib';

/**
 * Outbox relay: moves events from the `outbox` table to Kafka.
 *
 * The problem it solves ("dual write"): the API must both save a message and
 * announce it. If it wrote to Postgres and then to Kafka directly, a crash
 * between the two would lose the event - or, in the other order, announce a
 * message that was never saved. So the API writes the event into Postgres in
 * the same transaction as the message, and this relay publishes it afterwards.
 *
 * Delivery is at-least-once: if we crash after sending to Kafka but before
 * marking rows published, they are sent again on restart. Consumers therefore
 * have to be idempotent (see the handlers).
 *
 * FOR UPDATE SKIP LOCKED lets several relay instances run side by side: each
 * locks a different batch instead of queueing behind the others.
 */
interface OutboxRow {
  id: string;
  topic: string;
  key: string;
  payload: unknown;
}

async function relayBatch(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, topic, key, payload
       FROM outbox
       WHERE published_at IS NULL
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [config.outboxBatchSize],
    );
    const batch = rows as OutboxRow[];
    if (batch.length === 0) {
      await client.query('COMMIT');
      return 0;
    }

    const byTopic = new Map<string, { key: string; value: string }[]>();
    for (const row of batch) {
      const messages = byTopic.get(row.topic) ?? [];
      messages.push({ key: row.key, value: JSON.stringify(row.payload) });
      byTopic.set(row.topic, messages);
    }
    await producer.sendBatch({
      topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })),
    });

    await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [
      batch.map((row) => row.id),
    ]);
    await client.query('COMMIT');
    outboxPublished.inc(batch.length);
    return batch.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function startOutboxRelay(): { stop: () => Promise<void> } {
  let running = true;

  const loop = (async () => {
    while (running) {
      try {
        const relayed = await relayBatch();
        // A full batch probably means more is waiting: go again immediately.
        if (relayed < config.outboxBatchSize) await sleep(config.outboxIdleDelayMs);
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'outbox relay failed, retrying');
        await sleep(1000);
      }
    }
  })();

  // Housekeeping: report the backlog, and delete rows published over a day ago.
  const housekeeping = setInterval(() => {
    pool
      .query('SELECT count(*)::int AS pending FROM outbox WHERE published_at IS NULL')
      .then(({ rows }) => outboxPending.set(rows[0].pending))
      .catch(() => undefined);
    pool
      .query(`DELETE FROM outbox WHERE published_at < now() - interval '1 day'`)
      .catch(() => undefined);
  }, 15_000);

  logger.info('outbox relay started');
  return {
    stop: async () => {
      running = false;
      clearInterval(housekeeping);
      await loop;
    },
  };
}
