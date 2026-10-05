import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  AIO_PORTS,
  BOP_PORTS,
  BOP_WEB_PORTS,
  BopStack,
  FixtureLoader,
  buildBopWeb,
  deleteRedisPrefix,
  serveStatic,
  type BopPorts,
  type FixtureMeta,
  type StaticServer,
} from '@aio/bop-stack';
import { paths } from './paths';

export type Profile = 'dev' | 'e2e' | 'smoke';

const PROFILE_PORTS: Record<Profile, { bop: BopPorts; agent: number; console: number; bopWeb: number }> = {
  dev: {
    bop: { api: 4590, mcp: 4591, workerMetrics: 4592, schedulerMetrics: 4593 },
    agent: AIO_PORTS.dev.agent,
    console: AIO_PORTS.dev.preview,
    bopWeb: BOP_WEB_PORTS.dev,
  },
  e2e: { bop: BOP_PORTS.e2e, agent: AIO_PORTS.e2e.agent, console: AIO_PORTS.e2e.console, bopWeb: BOP_WEB_PORTS.e2e },
  smoke: {
    bop: BOP_PORTS.smoke,
    agent: AIO_PORTS.smoke.agent,
    console: AIO_PORTS.smoke.console,
    bopWeb: BOP_WEB_PORTS.smoke,
  },
};

export interface LaunchOptions {
  profile: Profile;
  fixture?: string;
  withConsole?: boolean;
  withBopWeb?: boolean;
  agentEnv?: Record<string, string>;
}

export interface Launched {
  profile: Profile;
  id: string;
  bop: BopStack;
  meta: FixtureMeta;
  agentUrl: string;
  consoleUrl: string | null;
  bopApiUrl: string;
  bopWebUrl: string | null;
  operatorToken: string;
  agentDatabaseUrl: string;
  agentRedisPrefix: string;
  logDir: string;
  agent: ChildProcess;
  restartAgent(extraEnv?: Record<string, string>): Promise<void>;
  killAgent(signal?: NodeJS.Signals): Promise<void>;
  stop(): Promise<void>;
}

async function waitHttp(url: string, timeoutMs: number, proc?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc !== undefined && proc.exitCode !== null)
      throw new Error(`process exited (${proc.exitCode}) before ${url} came up`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function dropDb(url: string): Promise<void> {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name)) return;
  u.pathname = '/postgres';
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await c.end();
  }
}

export async function launch(options: LaunchOptions): Promise<Launched> {
  const id = `${Date.now()}`;
  const profile = options.profile;
  const ports = PROFILE_PORTS[profile];
  const logDir = join(paths.root(), `.${profile}`, id);
  mkdirSync(logDir, { recursive: true });
  const fixtureName = options.fixture ?? 'crm-redteam';
  const meta = JSON.parse(readFileSync(join(paths.fixtures(), `${fixtureName}.meta.json`), 'utf8')) as FixtureMeta;
  const secret = `aio-${profile}-${id}`;
  const database = profile === 'dev' ? 'bop_test_aio_dev' : `bop_test_aio_${profile}_${id}`;
  const consoleUrl = options.withConsole === true ? `http://127.0.0.1:${ports.console}` : null;
  const bopWebUrl = (options.withBopWeb ?? options.withConsole === true) ? `http://127.0.0.1:${ports.bopWeb}` : null;
  const agentUrl = `http://127.0.0.1:${ports.agent}`;
  const operatorToken = `aio-operator-${profile}-${id}`;
  const bop = new BopStack({
    ports: ports.bop,
    database,
    redisPrefix: `bop_test_aio_${profile}_${id}`,
    logDir,
    jwtSecret: secret,
    scheduler: true,
    publicWebUrl: bopWebUrl ?? 'http://127.0.0.1:4511',
    env: {
      OPERATOR_URL: `${agentUrl}/integrations/bop/ai-step`,
      OPERATOR_TOKEN: operatorToken,
      OPERATOR_AGENT_URL: agentUrl,
      ...(consoleUrl !== null
        ? { OPERATOR_EMBED_URL: `${consoleUrl}/embed/ask-operator.js`, OPERATOR_CONSOLE_URL: consoleUrl }
        : {}),
    },
  });
  await bop.migrate();
  const loader = new FixtureLoader(bop.databaseUrl, { path: join(paths.fixtures(), `${fixtureName}.sql`) }, meta);
  await loader.restore(new Date());
  await bop.start();
  const agentDatabaseUrl =
    profile === 'dev' ? 'postgres://127.0.0.1:5432/aio' : `postgres://127.0.0.1:5432/aio_test_${profile}_${id}`;
  const agentRedisPrefix = profile === 'dev' ? 'aio' : `aio_test_${profile}_${id}`;
  let agentLogN = 0;
  const startAgent = async (extraEnv: Record<string, string> = {}): Promise<ChildProcess> => {
    agentLogN += 1;
    const log = createWriteStream(join(logDir, `agent-${agentLogN}.log`), { flags: 'a' });
    const child = spawn(process.execPath, ['--enable-source-maps', join(paths.root(), 'apps/agent/dist/main.js')], {
      env: {
        ...process.env,
        AGENT_PORT: String(ports.agent),
        AGENT_PUBLIC_URL: agentUrl,
        CONSOLE_URL: consoleUrl ?? `http://127.0.0.1:${AIO_PORTS.dev.console}`,
        CORS_ORIGINS: [
          consoleUrl,
          bopWebUrl,
          'http://127.0.0.1:4610',
          'http://127.0.0.1:4611',
          'http://127.0.0.1:4510',
          'http://127.0.0.1:4511',
        ]
          .filter((x) => x !== null)
          .join(','),
        DATABASE_URL: agentDatabaseUrl,
        REDIS_URL: 'redis://127.0.0.1:6379/6',
        REDIS_PREFIX: agentRedisPrefix,
        BOP_API_URL: bop.apiUrl,
        BOP_MCP_URL: bop.mcpUrl,
        BOP_WEBHOOK_SECRET: secret,
        OPERATOR_TOKEN: operatorToken,
        LLM_PROVIDER: 'fake',
        LOG_LEVEL: 'warn',
        SWEEP_INTERVAL_MS: '1000',
        LEASE_MS: '6000',
        HEARTBEAT_MS: '2000',
        WORKER_ID: `${profile}-${agentLogN}`,
        ...(options.agentEnv ?? {}),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    await waitHttp(`${agentUrl}/health`, 60_000, child);
    return child;
  };
  let agent = await startAgent();
  const login = (await (
    await fetch(`${agentUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'maria@demo.dev', password: 'demo1234' }),
    })
  ).json()) as { token: string };
  await fetch(`${agentUrl}/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` },
    body: JSON.stringify({
      serviceToken: meta.serviceToken,
      domain: meta.domain,
      instructions:
        'Write in a friendly, concise tone. Never promise discounts. Sign e-mails with your name and the company name.',
    }),
  });
  const killProc = async (p: ChildProcess | null, signal: NodeJS.Signals): Promise<void> => {
    if (p === null || p.exitCode !== null || p.signalCode !== null) return;
    p.kill(signal);
    const deadline = Date.now() + 8000;
    while (p.exitCode === null && p.signalCode === null && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  };
  const servers: StaticServer[] = [];
  let consoleDir: string | null = null;
  let bopWebDir: string | null = null;
  try {
    if (consoleUrl !== null) {
      const dist = join(paths.root(), 'apps/console/dist');
      if (!existsSync(join(dist, 'index.html'))) throw new Error('console is not built (pnpm build)');
      consoleDir = join(logDir, 'console');
      cpSync(dist, consoleDir, { recursive: true });
      writeFileSync(
        join(consoleDir, 'config.json'),
        JSON.stringify({ agentUrl, bopWebUrl: bopWebUrl ?? 'http://127.0.0.1:4511' }),
      );
      servers.push(
        await serveStatic(consoleDir, ports.console, { corsPrefixes: ['/embed/'], noStore: ['/config.json'] }),
      );
    }
    if (bopWebUrl !== null) {
      bopWebDir = join(logDir, 'bop-web');
      writeFileSync(join(logDir, 'bop-web-build.log'), await buildBopWeb(bop.root, bop.apiUrl, bopWebDir));
      servers.push(await serveStatic(bopWebDir, ports.bopWeb));
    }
  } catch (error) {
    for (const srv of servers) await srv.close();
    await killProc(agent, 'SIGTERM');
    await bop.destroy();
    throw error;
  }
  const launched: Launched = {
    profile,
    id,
    bop,
    meta,
    agentUrl,
    consoleUrl,
    bopApiUrl: bop.apiUrl,
    bopWebUrl,
    operatorToken,
    agentDatabaseUrl,
    agentRedisPrefix,
    logDir,
    agent,
    async restartAgent(extraEnv = {}) {
      await killProc(agent, 'SIGTERM');
      agent = await startAgent(extraEnv);
      launched.agent = agent;
    },
    async killAgent(signal = 'SIGKILL') {
      await killProc(agent, signal);
    },
    async stop() {
      for (const srv of servers) await srv.close();
      await killProc(agent, 'SIGTERM');
      await bop.destroy();
      if (profile !== 'dev') {
        await dropDb(agentDatabaseUrl).catch(() => undefined);
        await deleteRedisPrefix('redis://127.0.0.1:6379/6', agentRedisPrefix).catch(() => 0);
      }
      if (consoleDir !== null) rmSync(consoleDir, { recursive: true, force: true });
      if (bopWebDir !== null) rmSync(bopWebDir, { recursive: true, force: true });
    },
  };
  return launched;
}
