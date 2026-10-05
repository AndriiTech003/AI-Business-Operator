import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

const here = dirname(fileURLToPath(import.meta.url));

export const migrationsFolder =
  [
    join(here, 'migrations'),
    join(here, '..', 'migrations'),
    join(here, '..', 'src', 'db', 'migrations'),
    join(here, '..', '..', 'src', 'db', 'migrations'),
  ].find((dir) => existsSync(join(dir, 'meta', '_journal.json'))) ?? join(here, 'migrations');

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function assertName(name: string): void {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`invalid database name ${name}`);
}

export async function ensureDatabase(url: string): Promise<boolean> {
  const name = databaseName(url);
  assertName(name);
  const client = new pg.Client({ connectionString: withDatabase(url, 'postgres') });
  await client.connect();
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if ((found.rowCount ?? 0) > 0) return false;
    await client.query(`CREATE DATABASE "${name}"`);
    return true;
  } finally {
    await client.end();
  }
}

export async function dropDatabase(url: string): Promise<void> {
  const name = databaseName(url);
  assertName(name);
  const client = new pg.Client({ connectionString: withDatabase(url, 'postgres') });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

export async function runMigrations(url: string): Promise<void> {
  await ensureDatabase(url);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("SELECT pg_advisory_lock(hashtext('aio_migrations'))");
    try {
      await migrate(drizzle(pool), { migrationsFolder });
    } finally {
      await pool.query("SELECT pg_advisory_unlock(hashtext('aio_migrations'))");
    }
  } finally {
    await pool.end();
  }
}

export function createDb(url: string, max = 10): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max });
  return { db: drizzle(pool, { schema }), pool };
}
