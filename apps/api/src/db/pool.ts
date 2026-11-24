import { Pool, type PoolClient } from 'pg';
import { config } from '../config';
import { logger } from '../lib/logger';

/**
 * Connection pool for the primary database (all writes, and reads that must
 * see the latest data).
 *
 * Pool size matters when scaling out: every API instance opens up to `max`
 * connections, and Postgres has a hard limit (100 by default). 10 instances
 * x 10 connections is already at the limit - that is when you add PgBouncer.
 */
export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

/**
 * Pool for read-only queries that tolerate slightly stale data (message
 * history, search). Points at a replica when DATABASE_READ_URL is set,
 * otherwise it is simply the primary pool.
 */
export const readPool = config.databaseReadUrl
  ? new Pool({ connectionString: config.databaseReadUrl, max: 10 })
  : pool;

for (const p of new Set([pool, readPool])) {
  p.on('error', (err: Error) => logger.error({ err: err.message }, 'idle postgres client error'));
}

/** Run `fn` inside a transaction: commit if it resolves, roll back if it throws. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.all([...new Set([pool, readPool])].map((p) => p.end()));
}
