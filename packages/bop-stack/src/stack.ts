import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Redis } from 'ioredis';
import pg from 'pg';

export interface BopPorts {
  api: number;
  mcp: number;
  workerMetrics: number;
  schedulerMetrics: number;
}

export interface BopStackOptions {
  ports: BopPorts;
  database: string;
  pgBaseUrl?: string;
  redisUrl?: string;
  redisPrefix: string;
  jwtSecret?: string;
  publicWebUrl?: string;
  scheduler?: boolean;
  worker?: boolean;
  logDir: string;
  bopRoot?: string;
  env?: Record<string, string>;
  clockOffsetMs?: number;
}

export function fakeClockModule(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'assets', 'fake-clock.mjs'), join(here, 'assets', 'fake-clock.mjs')])
    if (existsSync(candidate)) return candidate;
  throw new Error('fake-clock.mjs not found');
}

export async function freezeDatabaseClock(databaseUrl: string, database: string, offsetMs: number): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error(`invalid database name ${database}`);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT pg_catalog.now() + (coalesce(nullif(current_setting('aio.now_offset_ms', true), ''), '0')::float8 * interval '1 millisecond') $$`,
    );
    await client.query(`ALTER DATABASE "${database}" SET search_path TO public, pg_catalog`);
    await client.query(`ALTER DATABASE "${database}" SET aio.now_offset_ms = '${Math.trunc(offsetMs)}'`);
  } finally {
    await client.end();
  }
}

export type BopProcess = 'api' | 'worker' | 'scheduler' | 'mcp';

export function defaultBopRoot(): string {
  if (process.env['BOP_ROOT'] !== undefined && process.env['BOP_ROOT'] !== '') return resolve(process.env['BOP_ROOT']);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, '05-business-operations-platform');
    if (existsSync(join(candidate, 'apps', 'ops-mcp'))) return candidate;
    dir = resolve(dir, '..');
  }
  throw new Error('Cannot locate project 05 (set BOP_ROOT)');
}

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export async function adminQuery(pgBaseUrl: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: withDatabase(pgBaseUrl, 'postgres') });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(pgBaseUrl: string, name: string): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`invalid database name ${name}`);
  await adminQuery(pgBaseUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

export async function deleteRedisPrefix(redisUrl: string, prefix: string): Promise<number> {
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();
  let deleted = 0;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) deleted += await redis.del(...keys);
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
  return deleted;
}

async function waitHttp(url: string, timeoutMs: number, proc?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc !== undefined && proc.exitCode !== null)
      throw new Error(`process exited with ${proc.exitCode} while waiting for ${url}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function runNode(script: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) =>
      code === 0 ? resolvePromise(out) : reject(new Error(`${script} failed (${code}): ${out.slice(-2000)}`)),
    );
  });
}

export class BopStack {
  readonly root: string;
  readonly pgBaseUrl: string;
  readonly redisUrl: string;
  readonly jwtSecret: string;
  private readonly procs = new Map<BopProcess, ChildProcess>();

  constructor(readonly options: BopStackOptions) {
    this.root = options.bopRoot ?? defaultBopRoot();
    this.pgBaseUrl = options.pgBaseUrl ?? 'postgres://127.0.0.1:5432';
    this.redisUrl = options.redisUrl ?? 'redis://127.0.0.1:6379/5';
    this.jwtSecret = options.jwtSecret ?? 'aio-harness-bop-jwt-secret';
    mkdirSync(options.logDir, { recursive: true });
  }

  get databaseUrl(): string {
    return withDatabase(this.pgBaseUrl, this.options.database);
  }

  get apiUrl(): string {
    return `http://127.0.0.1:${this.options.ports.api}`;
  }

  get mcpUrl(): string {
    return `http://127.0.0.1:${this.options.ports.mcp}/mcp`;
  }

  env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: this.databaseUrl,
      REDIS_URL: this.redisUrl,
      REDIS_PREFIX: this.options.redisPrefix,
      API_HOST: '127.0.0.1',
      API_PORT: String(this.options.ports.api),
      PUBLIC_API_URL: this.apiUrl,
      PUBLIC_WEB_URL: this.options.publicWebUrl ?? 'http://127.0.0.1:4511',
      JWT_SECRET: this.jwtSecret,
      REALTIME_URL: '',
      S3_PREFIX: `aio/${this.options.redisPrefix}/`,
      LOG_LEVEL: 'warn',
      OUTBOX_POLL_MS: '100',
      EMAIL_POLL_MS: '200',
      SWEEP_INTERVAL_MS: '1000',
      SCAN_INTERVAL_MS: '3600000',
      BOP_API_URL: this.apiUrl,
      MCP_PORT: String(this.options.ports.mcp),
      MCP_HOST: '127.0.0.1',
      WORKER_METRICS_PORT: String(this.options.ports.workerMetrics),
      SCHEDULER_METRICS_PORT: String(this.options.ports.schedulerMetrics),
      ...(this.options.clockOffsetMs !== undefined && this.options.clockOffsetMs !== 0
        ? {
            AIO_CLOCK_OFFSET_MS: String(Math.trunc(this.options.clockOffsetMs)),
            NODE_OPTIONS:
              `${process.env['NODE_OPTIONS'] ?? ''} --import=${pathToFileURL(fakeClockModule()).href}`.trim(),
          }
        : {}),
      ...(this.options.env ?? {}),
    };
  }

  async migrate(): Promise<string> {
    return runNode(join(this.root, 'packages/core/dist/cli/migrate.js'), this.root, this.env());
  }

  async seed(): Promise<string> {
    await this.migrate();
    return runNode(join(this.root, 'packages/core/dist/cli/seed.js'), this.root, this.env());
  }

  private spawnProcess(
    name: BopProcess,
    script: string,
    args: string[] = [],
    extra: Record<string, string> = {},
  ): ChildProcess {
    const log = createWriteStream(join(this.options.logDir, `bop-${name}.log`), { flags: 'a' });
    const child = spawn(process.execPath, ['--enable-source-maps', join(this.root, script), ...args], {
      cwd: this.root,
      env: { ...this.env(), ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    this.procs.set(name, child);
    return child;
  }

  async start(): Promise<void> {
    const api = this.spawnProcess('api', 'apps/api/dist/main.js');
    const mcp = this.spawnProcess('mcp', 'apps/ops-mcp/dist/main.js', ['--http']);
    let worker: ChildProcess | undefined;
    if (this.options.worker !== false)
      worker = this.spawnProcess('worker', 'apps/worker/dist/main.js', [], {
        WORKER_ID: `aio-${this.options.redisPrefix}`,
      });
    let scheduler: ChildProcess | undefined;
    if (this.options.scheduler === true) scheduler = this.spawnProcess('scheduler', 'apps/scheduler/dist/main.js');
    await waitHttp(`${this.apiUrl}/health`, 90_000, api);
    await waitHttp(`http://127.0.0.1:${this.options.ports.mcp}/health`, 30_000, mcp);
    if (worker !== undefined)
      await waitHttp(`http://127.0.0.1:${this.options.ports.workerMetrics}/health`, 60_000, worker);
    if (scheduler !== undefined)
      await waitHttp(`http://127.0.0.1:${this.options.ports.schedulerMetrics}/health`, 60_000, scheduler);
  }

  pids(): Record<string, number | undefined> {
    return Object.fromEntries([...this.procs.entries()].map(([k, v]) => [k, v.pid]));
  }

  async stop(): Promise<void> {
    const all = [...this.procs.values()];
    for (const p of all) if (p.exitCode === null) p.kill('SIGTERM');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && all.some((p) => p.exitCode === null && p.signalCode === null))
      await new Promise((r) => setTimeout(r, 100));
    for (const p of all) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    this.procs.clear();
  }

  async destroy(): Promise<void> {
    await this.stop();
    await dropDatabase(this.pgBaseUrl, this.options.database).catch(() => undefined);
    await deleteRedisPrefix(this.redisUrl, this.options.redisPrefix).catch(() => 0);
  }
}
