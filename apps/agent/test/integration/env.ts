import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  AIO_PORTS,
  BOP_PORTS,
  BopApi,
  BopStack,
  FixtureLoader,
  deleteRedisPrefix,
  type FixtureMeta,
} from '@aio/bop-stack';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../../../..');

export interface Infra {
  pgBaseUrl: string;
  redisUrl: string;
  agentRedisUrl: string;
  stop(): Promise<void>;
}

let infraPromise: Promise<Infra> | null = null;

export function infra(): Promise<Infra> {
  if (infraPromise !== null) return infraPromise;
  infraPromise = (async (): Promise<Infra> => {
    if (process.env['TESTCONTAINERS'] !== '1')
      return {
        pgBaseUrl: 'postgres://127.0.0.1:5432',
        redisUrl: 'redis://127.0.0.1:6379/5',
        agentRedisUrl: 'redis://127.0.0.1:6379/6',
        stop: async () => undefined,
      };
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const { RedisContainer } = await import('@testcontainers/redis');
    const pgc = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withUsername('asnh')
      .withPassword('asnh')
      .start();
    const rc = await new RedisContainer('redis:8').start();
    const pgBase = `postgres://asnh:asnh@${pgc.getHost()}:${pgc.getPort()}`;
    const redis = `redis://${rc.getHost()}:${rc.getPort()}`;
    return {
      pgBaseUrl: pgBase,
      redisUrl: `${redis}/5`,
      agentRedisUrl: `${redis}/6`,
      stop: async () => {
        await pgc.stop();
        await rc.stop();
      },
    };
  })();
  return infraPromise;
}

export interface Bop {
  stack: BopStack;
  meta: FixtureMeta;
  loader: FixtureLoader;
  secret: string;
  sql<T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function startBop(
  name: string,
  fixture = 'crm-redteam',
  bopEnv: Record<string, string> = {},
): Promise<Bop> {
  const id = `${name}_${Date.now()}`;
  const meta = JSON.parse(
    readFileSync(join(ROOT, 'scenarios/fixtures', `${fixture}.meta.json`), 'utf8'),
  ) as FixtureMeta;
  const secret = `aio-int-${id}`;
  const logDir = join(ROOT, '.integration', id);
  mkdirSync(logDir, { recursive: true });
  const inf = await infra();
  const stack = new BopStack({
    ports: BOP_PORTS.integration,
    database: `bop_test_aio_${id}`,
    redisPrefix: `bop_test_aio_${id}`,
    logDir,
    jwtSecret: secret,
    scheduler: true,
    pgBaseUrl: inf.pgBaseUrl,
    redisUrl: inf.redisUrl,
    env: bopEnv,
  });
  await stack.migrate();
  const loader = new FixtureLoader(
    stack.databaseUrl,
    { path: join(ROOT, 'scenarios/fixtures', `${fixture}.sql`) },
    meta,
  );
  await loader.restore(new Date());
  await stack.start();
  const pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
  return {
    stack,
    meta,
    loader,
    secret,
    sql: async <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) =>
      (await pool.query<T>(text, params)).rows,
    close: async () => {
      await pool.end();
      await stack.destroy();
    },
  };
}

export interface AgentProc {
  url: string;
  proc: ChildProcess;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export interface AgentEnv {
  dbUrl: string;
  redisPrefix: string;
  logDir: string;
}

export function agentEnv(name: string): AgentEnv {
  const id = `${name}_${Date.now()}`;
  const logDir = join(ROOT, '.integration', `agent_${id}`);
  mkdirSync(logDir, { recursive: true });
  const base = process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://127.0.0.1:5432';
  return { dbUrl: `${base.replace(/\/$/, '')}/aio_test_${id}`, redisPrefix: `aio_test_${id}`, logDir };
}

export async function startAgent(
  bop: Bop,
  env: AgentEnv,
  port: number = AIO_PORTS.integration.agentA,
  extra: Record<string, string> = {},
): Promise<AgentProc> {
  const url = `http://127.0.0.1:${port}`;
  const log = createWriteStream(join(env.logDir, `agent-${port}-${Date.now()}.log`), { flags: 'a' });
  const proc = spawn(process.execPath, ['--enable-source-maps', join(ROOT, 'apps/agent/dist/main.js')], {
    env: {
      ...process.env,
      AGENT_PORT: String(port),
      AGENT_PUBLIC_URL: url,
      DATABASE_URL: env.dbUrl,
      REDIS_URL: process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/6',
      REDIS_PREFIX: env.redisPrefix,
      BOP_API_URL: bop.stack.apiUrl,
      BOP_MCP_URL: bop.stack.mcpUrl,
      BOP_WEBHOOK_SECRET: bop.secret,
      LLM_PROVIDER: 'fake',
      LOG_LEVEL: 'warn',
      LEASE_MS: '4000',
      HEARTBEAT_MS: '1000',
      SWEEP_INTERVAL_MS: '1000',
      WORKER_ID: `agent-${port}-${Date.now()}`,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.pipe(log);
  proc.stderr?.pipe(log);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`agent exited with ${proc.exitCode}`);
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return {
    url,
    proc,
    kill: async (signal: NodeJS.Signals = 'SIGTERM') => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill(signal);
      const until = Date.now() + 8000;
      while (proc.exitCode === null && proc.signalCode === null && Date.now() < until)
        await new Promise((r) => setTimeout(r, 100));
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    },
  };
}

export async function dropAgentEnv(env: AgentEnv): Promise<void> {
  const u = new URL(env.dbUrl);
  const name = u.pathname.slice(1);
  u.pathname = '/postgres';
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await c.end();
  await deleteRedisPrefix(process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/6', env.redisPrefix);
}

export async function agentSql<T extends pg.QueryResultRow = Record<string, unknown>>(
  env: AgentEnv,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: env.dbUrl });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

export class Client {
  token = '';

  constructor(readonly base: string) {}

  async login(email: string, password = 'demo1234'): Promise<this> {
    const res = await this.raw('POST', '/auth/login', { email, password }, false);
    if (res.status !== 200) throw new Error(`login failed ${res.status}`);
    this.token = ((await res.json()) as { token: string }).token;
    return this;
  }

  raw(
    method: string,
    path: string,
    body?: unknown,
    auth = true,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(auth ? { authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async json<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return (text === '' ? null : JSON.parse(text)) as T;
  }
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 60_000,
  interval = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined && v !== false) return v;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${(last as Error).message}` : ''}`);
}

export async function runStatus(
  c: Client,
  runId: string,
): Promise<{ status: string; stopReason: string | null } & Record<string, unknown>> {
  return c.json('GET', `/runs/${runId}`);
}

export async function bopLogin(bop: Bop, email: string): Promise<string> {
  return (await new BopApi(bop.stack.apiUrl).login(email, 'demo1234')).accessToken;
}
