import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { Metrics } from '../../src/metrics';
import { loadConfig } from '../../src/config';
import { createAppContext, type AppContext } from '../../src/context';
import { runMigrations } from '../../src/db/client';
import { InlineDispatcher } from '../../src/runtime/dispatch';
import { createServices, type Services } from '../../src/services';
import { agentEnv, dropAgentEnv, startBop, type AgentEnv, type Bop } from './env';

let bop: Bop;
let env: AgentEnv;
let ctx: AppContext;
let services: Services;
const exporter = new InMemorySpanExporter();
const metrics = new Metrics(false);

beforeAll(async () => {
  bop = await startBop('otel', 'crm-small');
  env = agentEnv('otel');
  await runMigrations(env.dbUrl);
  const dispatcher = new InlineDispatcher();
  ctx = createAppContext(
    loadConfig({
      ...process.env,
      DATABASE_URL: env.dbUrl,
      REDIS_PREFIX: env.redisPrefix,
      BOP_API_URL: bop.stack.apiUrl,
      BOP_MCP_URL: bop.stack.mcpUrl,
      LLM_PROVIDER: 'fake',
    }),
    { dispatcher, spanExporter: exporter, metrics, logger: pino({ level: 'silent' }) },
  );
  services = createServices(ctx, null);
  dispatcher.setHandler(async (job) => void (await services.executor.execute(job)));
}, 240_000);

afterAll(async () => {
  await ctx?.close();
  await bop?.close();
  if (env !== undefined) await dropAgentEnv(env);
});

describe('observability', () => {
  it('emits OpenTelemetry GenAI spans and Prometheus metrics for a run', async () => {
    const { me } = await ctx.auth.login('maria@demo.dev', 'demo1234');
    const identity = {
      userId: me.userId,
      tenantId: me.tenantId,
      name: me.name,
      email: me.email,
      role: me.role,
      scopes: me.scopes,
      tenantName: me.tenantName,
    };
    const run = await services.runs.create(identity, { goal: 'Void invoice INV-2026-0003.' });
    await services.runs.start(run.id);
    const run2 = await services.runs.create(identity, {
      goal: 'Who owns the Fabrikam Inc account and how many open deals do they have?',
    });
    await services.runs.start(run2.id);
    const spans = exporter.getFinishedSpans();
    const agentSpan = spans.find((s) => s.name === 'invoke_agent operator');
    expect(agentSpan?.attributes['gen_ai.operation.name']).toBe('invoke_agent');
    const chat = spans.find((s) => s.name === 'chat fake-planner');
    expect(chat?.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'fake-planner',
      'gen_ai.provider.name': 'fake',
    });
    expect(Number(chat?.attributes['gen_ai.usage.input_tokens'])).toBeGreaterThan(0);
    expect(chat?.attributes['gen_ai.response.finish_reasons']).toBeDefined();
    const tool = spans.find((s) => s.name === 'execute_tool search_records');
    expect(tool?.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'search_records',
      'aio.policy.decision': 'allow',
    });
    expect(tool?.parentSpanContext?.spanId).toBeDefined();
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/aio_runs_finished_total\{status="completed",stop_reason="end_turn"\} 2/);
    expect(text).toMatch(/aio_llm_calls_total\{model="fake-planner",provider="fake",outcome="ok"\} \d+/);
    expect(text).toMatch(/aio_tool_calls_total\{tool="get_company",decision="allow",outcome="ok"\} 1/);
    const detail = await services.runs.detail(identity, run.id);
    expect(detail.summary).toContain('no-void');
  }, 120_000);
});
