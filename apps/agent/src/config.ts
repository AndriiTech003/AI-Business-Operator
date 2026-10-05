import { DEFAULT_BUDGET, type Budget } from '@aio/contracts';
import type { ProviderKind } from '@aio/llm';

export interface AgentConfig {
  role: 'api' | 'worker' | 'all';
  host: string;
  port: number;
  publicUrl: string;
  consoleUrl: string;
  corsOrigins: string[];
  databaseUrl: string;
  redisUrl: string;
  redisPrefix: string;
  bopApiUrl: string;
  bopMcpUrl: string;
  bopWebhookSecret: string;
  sessionSecret: string;
  credentialsKey: string;
  llm: {
    provider: ProviderKind;
    model: string;
    anthropicApiKey?: string;
    anthropicEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    openaiBaseUrl?: string;
    openaiApiKey?: string;
    cassetteDir: string;
    pricesJson?: string;
  };
  budget: Budget;
  leaseMs: number;
  heartbeatMs: number;
  sweepIntervalMs: number;
  approvalPollMs: number;
  workerId: string;
  workerConcurrency: number;
  clockOffsetMs: number;
  otlpEndpoint: string | null;
  demoDailyCostLimitUsd: number;
  logLevel: string;
  operatorToken: string | null;
  workflowStepWaitMs: number;
}

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}

function opt(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === '' ? undefined : v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const port = int(env, 'AGENT_PORT', 4600);
  const role = str(env, 'AGENT_ROLE', 'all');
  const provider = str(env, 'LLM_PROVIDER', 'fake') as ProviderKind;
  return {
    role: role === 'api' || role === 'worker' ? role : 'all',
    host: str(env, 'AGENT_HOST', '127.0.0.1'),
    port,
    publicUrl: str(env, 'AGENT_PUBLIC_URL', `http://127.0.0.1:${port}`),
    consoleUrl: str(env, 'CONSOLE_URL', 'http://127.0.0.1:4610'),
    corsOrigins: str(
      env,
      'CORS_ORIGINS',
      'http://127.0.0.1:4610,http://127.0.0.1:4611,http://localhost:4610,http://localhost:4611',
    )
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    databaseUrl: str(env, 'DATABASE_URL', 'postgres://127.0.0.1:5432/aio'),
    redisUrl: str(env, 'REDIS_URL', 'redis://127.0.0.1:6379/6'),
    redisPrefix: str(env, 'REDIS_PREFIX', 'aio'),
    bopApiUrl: str(env, 'BOP_API_URL', 'http://127.0.0.1:4500'),
    bopMcpUrl: str(env, 'BOP_MCP_URL', 'http://127.0.0.1:4530/mcp'),
    bopWebhookSecret: str(env, 'BOP_WEBHOOK_SECRET', 'dev-only-jwt-secret-change-me'),
    sessionSecret: str(env, 'SESSION_SECRET', 'dev-only-aio-session-secret-change-me'),
    credentialsKey: str(env, 'CREDENTIALS_KEY', 'dev-only-aio-credentials-key-change-me-32b'),
    llm: {
      provider,
      model: str(
        env,
        'LLM_MODEL',
        provider === 'fake' || provider === 'replay' || provider === 'record' ? 'fake-planner' : 'claude-opus-5-5',
      ),
      anthropicApiKey: opt(env, 'ANTHROPIC_API_KEY'),
      anthropicEffort: (opt(env, 'ANTHROPIC_EFFORT') as AgentConfig['llm']['anthropicEffort']) ?? 'medium',
      openaiBaseUrl: opt(env, 'OPENAI_BASE_URL'),
      openaiApiKey: opt(env, 'OPENAI_API_KEY'),
      cassetteDir: str(env, 'CASSETTE_DIR', 'scenarios/cassettes'),
      pricesJson: opt(env, 'LLM_PRICES_JSON'),
    },
    budget: {
      maxSteps: int(env, 'BUDGET_MAX_STEPS', DEFAULT_BUDGET.maxSteps),
      maxToolCalls: int(env, 'BUDGET_MAX_TOOL_CALLS', DEFAULT_BUDGET.maxToolCalls),
      maxInputTokens: int(env, 'BUDGET_MAX_INPUT_TOKENS', DEFAULT_BUDGET.maxInputTokens),
      maxCostUsd: int(env, 'BUDGET_MAX_COST_USD', DEFAULT_BUDGET.maxCostUsd),
      maxWallClockMs: int(env, 'BUDGET_MAX_WALL_CLOCK_MS', DEFAULT_BUDGET.maxWallClockMs),
      maxExternalActions: int(env, 'BUDGET_MAX_EXTERNAL_ACTIONS', DEFAULT_BUDGET.maxExternalActions),
    },
    leaseMs: int(env, 'LEASE_MS', 30_000),
    heartbeatMs: int(env, 'HEARTBEAT_MS', 10_000),
    sweepIntervalMs: int(env, 'SWEEP_INTERVAL_MS', 5_000),
    approvalPollMs: int(env, 'APPROVAL_POLL_MS', 0),
    workerId: str(env, 'WORKER_ID', `agent-${process.pid}`),
    workerConcurrency: int(env, 'WORKER_CONCURRENCY', 4),
    clockOffsetMs: int(env, 'AIO_CLOCK_OFFSET_MS', 0),
    otlpEndpoint: opt(env, 'OTEL_EXPORTER_OTLP_ENDPOINT') ?? null,
    demoDailyCostLimitUsd: int(env, 'DEMO_DAILY_COST_LIMIT_USD', 5),
    logLevel: str(env, 'LOG_LEVEL', 'info'),
    operatorToken: opt(env, 'OPERATOR_TOKEN') ?? null,
    workflowStepWaitMs: int(env, 'WORKFLOW_STEP_WAIT_MS', 10_000),
  };
}
