import { Redis } from 'ioredis';
import pino, { type Logger } from 'pino';
import type pg from 'pg';
import type { Clock, ToolGateway } from '@aio/agent-core';
import { createProvider, PriceTable, type LlmProvider } from '@aio/llm';
import type { AgentConfig } from './config';
import { createDb, type Db } from './db/client';
import { Metrics } from './metrics';
import { ApprovalService } from './services/approvals';
import { AuthService } from './services/auth';
import { BopClient } from './services/bop';
import { EventBus } from './services/events';
import { DbPolicyCounters, PolicyService, type PolicyCounters } from './services/policy';
import { TeamDirectory } from './services/prompt';
import { createTelemetry, startTracing, type TracingHandle } from './tracing';
import type { Dispatcher } from './runtime/dispatch';
import type { Telemetry } from '@aio/agent-core';
import type { RunState } from '@aio/agent-core';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

export interface MutableClock extends Clock {
  offsetMs: number;
  frozenAt: number | null;
}

export function createClock(offsetMs: number): MutableClock {
  const clock: MutableClock = {
    offsetMs,
    frozenAt: null,
    now: () => new Date(clock.frozenAt ?? Date.now() + clock.offsetMs),
  };
  return clock;
}

export interface AppContext {
  config: AgentConfig;
  db: Db;
  pool: pg.Pool;
  redis: Redis;
  sub: Redis;
  bop: BopClient;
  auth: AuthService;
  policy: PolicyService;
  counters: PolicyCounters;
  events: EventBus;
  team: TeamDirectory;
  llm: LlmProvider;
  prices: PriceTable;
  metrics: Metrics;
  telemetry: Telemetry;
  tracing: TracingHandle;
  clock: MutableClock;
  logger: Logger;
  dispatcher: Dispatcher;
  approvals: ApprovalService;
  toolGatewayFactory: ((token: string, run: RunState) => ToolGateway) | null;
  close(): Promise<void>;
}

export interface ContextOptions {
  dispatcher: Dispatcher;
  llm?: LlmProvider;
  toolGatewayFactory?: (token: string, run: RunState) => ToolGateway;
  spanExporter?: SpanExporter;
  metrics?: Metrics;
  logger?: Logger;
}

export function createAppContext(config: AgentConfig, options: ContextOptions): AppContext {
  const { db, pool } = createDb(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: false });
  const sub = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
  const logger =
    options.logger ?? pino({ level: config.logLevel, base: { service: 'aio-agent', worker: config.workerId } });
  const bop = new BopClient(config.bopApiUrl);
  const auth = new AuthService(db, bop, config.sessionSecret, config.credentialsKey);
  const metrics = options.metrics ?? new Metrics();
  const tracing = startTracing('aio-agent', config.otlpEndpoint, options.spanExporter);
  const clock = createClock(config.clockOffsetMs);
  const llm =
    options.llm ??
    createProvider({
      kind: config.llm.provider,
      model: config.llm.model,
      ...(config.llm.anthropicApiKey !== undefined ? { anthropicApiKey: config.llm.anthropicApiKey } : {}),
      ...(config.llm.anthropicEffort !== undefined ? { anthropicEffort: config.llm.anthropicEffort } : {}),
      ...(config.llm.openaiBaseUrl !== undefined ? { openaiBaseUrl: config.llm.openaiBaseUrl } : {}),
      ...(config.llm.openaiApiKey !== undefined ? { openaiApiKey: config.llm.openaiApiKey } : {}),
      cassetteDir: config.llm.cassetteDir,
    });
  const policy = new PolicyService(db);
  const events = new EventBus(redis, sub, config.redisPrefix);
  const ctx: AppContext = {
    config,
    db,
    pool,
    redis,
    sub,
    bop,
    auth,
    policy,
    counters: new DbPolicyCounters(db),
    events,
    team: new TeamDirectory(bop),
    llm,
    prices: PriceTable.fromEnv(config.llm.pricesJson),
    metrics,
    telemetry: createTelemetry(tracing.tracer, metrics),
    tracing,
    clock,
    logger,
    dispatcher: options.dispatcher,
    approvals: null as unknown as ApprovalService,
    toolGatewayFactory: options.toolGatewayFactory ?? null,
    async close() {
      await tracing.shutdown().catch(() => undefined);
      redis.disconnect();
      sub.disconnect();
      await pool.end().catch(() => undefined);
    },
  };
  return ctx;
}
