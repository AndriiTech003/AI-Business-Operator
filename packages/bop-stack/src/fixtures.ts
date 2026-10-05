import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import pg from 'pg';

const run = promisify(execFile);

export const SKIP_TABLES = ['_prisma_migrations'];

export interface FixtureUser {
  key: string;
  id: string;
  email: string;
  name: string;
  role: string;
  token: string;
}

export interface FixtureMeta {
  name: string;
  referenceTime: string;
  tenantId: string;
  tenantName: string;
  domain: string;
  timezone: string;
  users: Record<string, FixtureUser>;
  serviceToken: string;
  ids: Record<string, string>;
  values: Record<string, unknown>;
}

export async function dumpData(databaseUrl: string): Promise<string> {
  const { stdout } = await run(
    'pg_dump',
    [
      '--data-only',
      '--column-inserts',
      '--rows-per-insert=200',
      '--no-owner',
      '--no-privileges',
      '--no-comments',
      ...SKIP_TABLES.flatMap((t) => ['--exclude-table', t]),
      databaseUrl,
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  return stdout
    .split('\n')
    .filter((line) => !line.startsWith('--') && !line.startsWith('\\') && line.trim() !== '')
    .filter((line) => !/^SET (transaction_timeout|default_table_access_method)/.test(line))
    .filter((line) => !/^SELECT pg_catalog\.set_config\('search_path'/.test(line))
    .join('\n');
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
}

export class FixtureLoader {
  private sql: string;
  private tables: string[] | null = null;
  private columns: ColumnRow[] | null = null;

  constructor(
    readonly databaseUrl: string,
    sqlOrPath: { sql: string } | { path: string },
    readonly meta: FixtureMeta,
  ) {
    this.sql = 'sql' in sqlOrPath ? sqlOrPath.sql : readFileSync(sqlOrPath.path, 'utf8');
  }

  private async introspect(client: pg.Client): Promise<void> {
    if (this.tables !== null) return;
    const t = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    this.tables = t.rows.map((r) => r.tablename).filter((n) => !SKIP_TABLES.includes(n));
    const c = await client.query<ColumnRow>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type IN ('timestamp with time zone', 'timestamp without time zone', 'date')`,
    );
    this.columns = c.rows.filter((r) => !SKIP_TABLES.includes(r.table_name));
  }

  async waitForQuiescence(timeoutMs = 30_000): Promise<boolean> {
    const client = new pg.Client({ connectionString: this.databaseUrl });
    await client.connect();
    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const r = await client.query<{ busy: string }>(
          `SELECT (SELECT count(*) FROM outbox WHERE published_at IS NULL)
                + (SELECT count(*) FROM email_messages WHERE status IN ('queued', 'sending'))
                + (SELECT count(*) FROM step_runs WHERE status IN ('pending', 'running'))
                + (SELECT count(*) FROM workflow_runs WHERE status = 'running') AS busy`,
        );
        if (Number(r.rows[0]?.busy ?? 0) === 0) {
          const a = await this.fingerprint(client);
          await new Promise((res) => setTimeout(res, 400));
          if ((await this.fingerprint(client)) === a) return true;
          continue;
        }
        await new Promise((res) => setTimeout(res, 200));
      }
      return false;
    } finally {
      await client.end();
    }
  }

  private async fingerprint(client: pg.Client): Promise<string> {
    const r = await client.query<{ f: string }>(
      `SELECT concat_ws(':', (SELECT count(*) FROM activities), (SELECT count(*) FROM tasks), (SELECT count(*) FROM email_messages),
              (SELECT count(*) FROM notifications), (SELECT count(*) FROM search_documents), (SELECT max(updated_at)::text FROM search_documents)) AS f`,
    );
    return r.rows[0]?.f ?? '';
  }

  async restoreStable(now: Date = new Date(), attempts = 4): Promise<{ shiftMs: number }> {
    let out = await this.restore(now);
    for (let i = 0; i < attempts; i += 1) {
      const client = new pg.Client({ connectionString: this.databaseUrl });
      await client.connect();
      try {
        const a = await this.fingerprint(client);
        await new Promise((res) => setTimeout(res, 300));
        if ((await this.fingerprint(client)) === a) return out;
      } finally {
        await client.end();
      }
      await this.waitForQuiescence(10_000);
      out = await this.restore(now);
    }
    return out;
  }

  async restore(now: Date = new Date()): Promise<{ shiftMs: number }> {
    const client = new pg.Client({ connectionString: this.databaseUrl });
    await client.connect();
    const shiftMs = now.getTime() - Date.parse(this.meta.referenceTime);
    try {
      await this.introspect(client);
      const tables = this.tables ?? [];
      await client.query('BEGIN');
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
      await client.query(this.sql);
      await client.query("SET LOCAL session_replication_role = 'replica'");
      const byTable = new Map<string, ColumnRow[]>();
      for (const col of this.columns ?? []) byTable.set(col.table_name, [...(byTable.get(col.table_name) ?? []), col]);
      const shiftDays = Math.round(shiftMs / 86_400_000);
      for (const [table, cols] of byTable) {
        const sets = cols.map((c) =>
          c.data_type === 'date'
            ? `"${c.column_name}" = "${c.column_name}" + ${shiftDays}`
            : `"${c.column_name}" = "${c.column_name}" + ($1::float8 * interval '1 millisecond')`,
        );
        const usesParam = cols.some((c) => c.data_type !== 'date');
        await client.query(`UPDATE "${table}" SET ${sets.join(', ')}`, usesParam ? [shiftMs] : []);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
    return { shiftMs };
  }
}
