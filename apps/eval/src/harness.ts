import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import {
  AIO_PORTS,
  BOP_PORTS,
  BopStack,
  FixtureLoader,
  deleteRedisPrefix,
  freezeDatabaseClock,
  type FixtureMeta,
} from '@aio/bop-stack';
import {
  buildApp,
  createAppContext,
  createServices,
  dropDatabase,
  FaultInjectingGateway,
  InlineDispatcher,
  loadConfig,
  McpToolGateway,
  runMigrations,
  schema,
  type AppContext,
  type FaultSpec,
  type Identity,
  type Services,
} from '@aio/agent';
import type { LlmProvider } from '@aio/llm';
import type { AgentOptions } from '@aio/agent-core';
import { paths } from './paths';

export interface HarnessOptions {
  id: string;
  llm: LlmProvider;
  model: string;
  logDir: string;
}

export interface FixtureHandle {
  name: string;
  meta: FixtureMeta;
  loader: FixtureLoader;
}

export class EvalHarness {
  stack: BopStack | null = null;
  ctx: AppContext | null = null;
  services: Services | null = null;
  app: Awaited<ReturnType<typeof buildApp>> | null = null;
  readonly dispatcher = new InlineDispatcher();
  private currentFixture: string | null = null;
  readonly agentDbUrl: string;
  private scenarioId = '';
  private faults: FaultSpec[] = [];
  agentOptions: Partial<AgentOptions> = {};
  readonly fixtures = new Map<string, FixtureHandle>();

  constructor(private readonly options: HarnessOptions) {
    this.agentDbUrl = `postgres://127.0.0.1:5432/aio_eval_${options.id}`;
  }

  get bopDatabase(): string {
    return `bop_eval_${this.options.id}`;
  }

  fixture(name: string): FixtureHandle {
    const base = name.replace(/^fixtures\//, '').replace(/\.sql$/, '');
    const existing = this.fixtures.get(base);
    if (existing !== undefined) return existing;
    const meta = JSON.parse(readFileSync(join(paths.fixtures(), `${base}.meta.json`), 'utf8')) as FixtureMeta;
    const handle: FixtureHandle = {
      name: base,
      meta,
      loader: new FixtureLoader(
        `postgres://127.0.0.1:5432/${this.bopDatabase}`,
        { path: join(paths.fixtures(), `${base}.sql`) },
        meta,
      ),
    };
    this.fixtures.set(base, handle);
    return handle;
  }

  async startAgent(): Promise<void> {
    await runMigrations(this.agentDbUrl);
    const config = {
      ...loadConfig({
        ...process.env,
        DATABASE_URL: this.agentDbUrl,
        REDIS_URL: 'redis://127.0.0.1:6379/6',
        REDIS_PREFIX: `aio_eval_${this.options.id}`,
        BOP_API_URL: `http://127.0.0.1:${BOP_PORTS.eval.api}`,
        BOP_MCP_URL: `http://127.0.0.1:${BOP_PORTS.eval.mcp}/mcp`,
        BOP_WEBHOOK_SECRET: `aio-eval-${this.options.id}`,
        AGENT_PORT: String(AIO_PORTS.eval.callback),
        AGENT_PUBLIC_URL: `http://127.0.0.1:${AIO_PORTS.eval.callback}`,
        LLM_PROVIDER: 'fake',
        LLM_MODEL: this.options.model,
        DEMO_DAILY_COST_LIMIT_USD: '1000',
        LOG_LEVEL: 'error',
      }),
    };
    const ctx = createAppContext(config, {
      dispatcher: this.dispatcher,
      llm: this.options.llm,
      logger: pino({ level: 'error' }),
      toolGatewayFactory: (token) => {
        const inner = new McpToolGateway(config.bopMcpUrl, token);
        return this.faults.length > 0 ? new FaultInjectingGateway(inner, this.faults) : inner;
      },
    });
    const services = createServices(ctx, null);
    this.dispatcher.setHandler(async (job) => {
      await services.executor.execute(job, { scenarioId: this.scenarioId, agentOptions: this.agentOptions });
    });
    this.app = await buildApp(ctx, services);
    await this.app.listen({ host: '127.0.0.1', port: AIO_PORTS.eval.callback });
    this.ctx = ctx;
    this.services = services;
  }

  async useFixture(name: string): Promise<FixtureHandle> {
    const fx = this.fixture(name);
    if (this.currentFixture === fx.name && this.stack !== null) return fx;
    if (this.stack !== null) await this.stack.stop();
    const offset = Date.parse(fx.meta.referenceTime) - Date.now();
    this.stack = new BopStack({
      ports: BOP_PORTS.eval,
      database: this.bopDatabase,
      redisPrefix: `bop_test_aio_eval_${this.options.id}`,
      logDir: this.options.logDir,
      jwtSecret: `aio-eval-${this.options.id}`,
      clockOffsetMs: offset,
      scheduler: false,
    });
    await this.stack.migrate();
    await freezeDatabaseClock(this.stack.databaseUrl, this.bopDatabase, offset);
    await fx.loader.restore(new Date(fx.meta.referenceTime));
    await this.stack.start();
    if (this.ctx === null) throw new Error('agent not started');
    this.ctx.clock.offsetMs = offset;
    this.currentFixture = fx.name;
    await this.registerTenant(fx);
    return fx;
  }

  async registerTenant(fx: FixtureHandle): Promise<void> {
    const ctx = this.ctx as AppContext;
    const meta = fx.meta;
    await ctx.db
      .insert(schema.tenantSettings)
      .values({
        tenantId: meta.tenantId,
        name: meta.tenantName,
        domain: meta.domain,
        timezone: meta.timezone,
        instructions:
          'Write in a friendly, concise tone. Never promise discounts. Sign e-mails with your name and the company name.',
        serviceTokenEnc: ctx.auth.sealSecret(meta.serviceToken),
      })
      .onConflictDoUpdate({
        target: schema.tenantSettings.tenantId,
        set: {
          serviceTokenEnc: ctx.auth.sealSecret(meta.serviceToken),
          domain: meta.domain,
          timezone: meta.timezone,
          name: meta.tenantName,
        },
      });
    for (const u of Object.values(meta.users)) await ctx.auth.storeCredential(this.identity(fx, u.key), u.token);
  }

  identity(fx: FixtureHandle, key: string): Identity {
    const u = fx.meta.users[key];
    if (u === undefined) throw new Error(`unknown fixture user ${key}`);
    return {
      userId: u.id,
      tenantId: fx.meta.tenantId,
      name: u.name,
      email: u.email,
      role: u.role,
      scopes: scopesFor(u.role),
      tenantName: fx.meta.tenantName,
    };
  }

  async prepareScenario(fx: FixtureHandle, scenarioId: string, faults: FaultSpec[]): Promise<void> {
    this.scenarioId = scenarioId;
    this.faults = faults.map((f) => ({ ...f }));
    await fx.loader.waitForQuiescence(20_000);
    await fx.loader.restoreStable(new Date(fx.meta.referenceTime));
    if (this.ctx !== null) {
      this.ctx.clock.offsetMs = Date.parse(fx.meta.referenceTime) - Date.now();
      this.ctx.clock.frozenAt = Date.parse(fx.meta.referenceTime);
    }
  }

  async setPolicy(tenantId: string, yaml: string, userId: string): Promise<number> {
    const ctx = this.ctx as AppContext;
    const current = await ctx.policy.current(tenantId, userId);
    if (current.source === yaml) return current.version;
    return (await ctx.policy.save(tenantId, yaml, userId)).version;
  }

  async close(): Promise<void> {
    if (this.app !== null) await this.app.close().catch(() => undefined);
    if (this.stack !== null) await this.stack.destroy();
    if (this.ctx !== null) await this.ctx.close();
    await dropDatabase(this.agentDbUrl).catch(() => undefined);
    await deleteRedisPrefix('redis://127.0.0.1:6379/6', `aio_eval_${this.options.id}`).catch(() => 0);
  }
}

export function scopesFor(role: string): string[] {
  const read = ['records:read', 'approvals:read', 'workflows:read', 'reports:read'];
  if (role === 'viewer') return read;
  if (role === 'member') return [...read, 'records:write', 'email:send', 'invoices:send'];
  if (role === 'manager')
    return [
      ...read,
      'records:write',
      'email:send',
      'invoices:send',
      'invoices:void',
      'approvals:decide',
      'approvals:create',
      'workflows:write',
    ];
  return [
    ...read,
    'records:write',
    'email:send',
    'invoices:send',
    'invoices:void',
    'approvals:decide',
    'approvals:create',
    'workflows:write',
    'admin',
  ];
}
