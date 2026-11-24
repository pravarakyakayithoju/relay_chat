import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { config } from '../config';

/**
 * Minimal migration runner.
 *
 * - Applies every .sql file in ./migrations, in filename order, exactly once.
 * - Each file runs in its own transaction, so a failing migration leaves no half-applied changes.
 * - A Postgres advisory lock means two processes starting at the same moment
 *   cannot both run migrations.
 *
 * Usage: npm run migrate
 */
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 727274;

async function main(): Promise<void> {
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const result = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set<string>(result.rows.map((row: { name: string }) => row.name));
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      console.log(`applied ${file}`);
      count++;
    }
    console.log(count === 0 ? 'database is up to date' : `applied ${count} migration(s)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
