// Postgres access for our own state database (never the Mattermost or Buzz databases, CLAUDE.md rule 5).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return `"${name}"`;
}

/**
 * Apply the `.sql` files in `dir` that have not run yet, in name order, each in its own transaction.
 * A per-schema advisory lock makes concurrent starts safe. Returns the files applied.
 */
export async function migrate(pool: pg.Pool, schema: string, dir: string): Promise<string[]> {
  const s = quoteIdent(schema);
  const lockKey = `migrate:${schema}`;
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${s}.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>(`SELECT name FROM ${s}.schema_migrations`)).rows.map((row) => row.name));
    const files = readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO ${s}.schema_migrations (name) VALUES ($1)`, [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${schema}/${file} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
    client.release();
  }
}
