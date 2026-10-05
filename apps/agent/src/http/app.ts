import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { ZodError, z } from 'zod';
import {
  decideSchema,
  encodeSse,
  interveneSchema,
  loginSchema,
  playbookCreateSchema,
  playbookUpdateSchema,
  putPolicySchema,
  runsQuerySchema,
  settingsSchema,
  simulateSchema,
  startRunSchema,
  usageQuerySchema,
  type EvalResultDto,
  type EvalRunDto,
  type RunEvent,
  type ToolDescriptor,
} from '@aio/contracts';
import { compilePolicy } from '@aio/policy';
import type { AppContext } from '../context';
import { evalResults, evalRuns, tenantSettings } from '../db/schema';
import { McpToolGateway } from '../services/mcp';
import { ApprovalError } from '../services/approvals';
import { AuthError, toMeDto, type Identity } from '../services/auth';
import type { Services } from '../services';
import { AgentPolicyGateway, PolicyValidationError, STATIC_RISKS } from '../services/policy';
import { loadTenant } from '../services/prompt';
import { RunError } from '../services/runs';
import { WorkflowStepError } from '../services/workflow-step';
import { openApiDocument } from './openapi';

declare module 'fastify' {
  interface FastifyRequest {
    identity?: Identity;
  }
}

function statusOf(error: unknown): number {
  if (error instanceof ZodError) return 400;
  if (
    error instanceof RunError ||
    error instanceof ApprovalError ||
    error instanceof AuthError ||
    error instanceof WorkflowStepError
  )
    return error.status;
  if (error instanceof PolicyValidationError) return 422;
  const s = (error as { statusCode?: number }).statusCode;
  return typeof s === 'number' ? s : 500;
}

function evalRunDto(r: typeof evalRuns.$inferSelect): EvalRunDto {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    mode: r.mode as EvalRunDto['mode'],
    models: r.models as string[],
    scenarioCount: r.scenarioCount,
    passed: r.passed,
    failed: r.failed,
    violations: r.violations,
    injectionSuccess: r.injectionSuccess,
    gatesPassed: r.gatesPassed,
    avgSteps: r.avgSteps,
    avgCostUsd: r.avgCostUsd,
    reportPath: r.reportPath,
  };
}

function evalResultDto(r: typeof evalResults.$inferSelect): EvalResultDto {
  return {
    id: r.id,
    evalRunId: r.evalRunId,
    scenarioId: r.scenarioId,
    category: r.category,
    model: r.model,
    passed: r.passed,
    violations: r.violations,
    injectionSuccess: r.injectionSuccess,
    steps: r.steps,
    toolCalls: r.toolCalls,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
    firstTokenMs: r.firstTokenMs,
    judgeScore: r.judgeScore,
    failures: r.failures as string[],
    trajectory: r.trajectory,
    agentRunId: r.agentRunId,
  };
}

export async function buildApp(ctx: AppContext, services: Services): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, {
    origin: (origin, cb) =>
      cb(null, origin === undefined || ctx.config.corsOrigins.includes(origin) || ctx.config.corsOrigins.includes('*')),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    if (body === '') return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (error) {
      const e = error as Error & { statusCode?: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });
  app.setErrorHandler((error, _req, reply) => {
    const status = statusOf(error);
    if (status >= 500)
      ctx.logger.error({ err: (error as Error).message, stack: (error as Error).stack }, 'request failed');
    const body: Record<string, unknown> = {
      status,
      title: status >= 500 ? 'Internal error' : (error as Error).message,
    };
    if (error instanceof ZodError)
      body['errors'] = error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    if (error instanceof PolicyValidationError) body['diagnostics'] = error.diagnostics;
    if (error instanceof WorkflowStepError) {
      body['code'] = error.code;
      if (error.retryAfterSeconds !== null) void reply.header('retry-after', String(error.retryAfterSeconds));
    }
    void reply.status(status).type('application/problem+json').send(body);
  });

  const auth = async (req: FastifyRequest): Promise<Identity> => {
    const identity = await ctx.auth.authenticate(req.headers.authorization);
    req.identity = identity;
    return identity;
  };
  const corsHeaders = (req: FastifyRequest): Record<string, string> => {
    const origin = req.headers.origin;
    return origin !== undefined && (ctx.config.corsOrigins.includes(origin) || ctx.config.corsOrigins.includes('*'))
      ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' }
      : {};
  };

  const openSse = (req: FastifyRequest, reply: FastifyReply): ((event: RunEvent) => void) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...corsHeaders(req),
    });
    reply.raw.write(': connected\n\n');
    let n = 0;
    return (event: RunEvent) => {
      n += 1;
      if (!reply.raw.writableEnded) reply.raw.write(encodeSse(event, n));
    };
  };

  const streamRun = async (
    req: FastifyRequest,
    reply: FastifyReply,
    runId: string,
    replay: boolean,
    start: (() => Promise<void>) | null,
  ) => {
    const write = openSse(req, reply);
    let finished = false;
    const end = () => {
      if (finished) return;
      finished = true;
      clearInterval(ping);
      unsubscribe();
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    const unsubscribe = await ctx.events.subscribe(runId, (event) => {
      write(event);
      if (event.type === 'done' || (event.type === 'status' && event.status === 'awaiting_approval'))
        setTimeout(end, 50);
    });
    const ping = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n');
    }, 15_000);
    req.raw.on('close', end);
    if (replay) {
      const detail = await services.runs.detail(req.identity as Identity, runId);
      for (const step of detail.steps) write({ type: step.kind === 'tool_call' ? 'tool_result' : 'step', runId, step });
      for (const p of detail.proposals) write({ type: 'proposal', runId, proposal: p });
      write({ type: 'usage', runId, usage: detail.usage });
      write({ type: 'status', runId, status: detail.status, stopReason: detail.stopReason });
      if (['completed', 'failed', 'cancelled'].includes(detail.status)) {
        write({ type: 'done', runId, status: detail.status, stopReason: detail.stopReason, summary: detail.summary });
        end();
        return;
      }
      if (detail.status === 'awaiting_approval') {
        end();
        return;
      }
    }
    if (start !== null) await start();
  };

  const waitForRun = (runId: string, timeoutMs: number): Promise<void> =>
    new Promise((resolve) => {
      let unsub: (() => void) | null = null;
      const timer = setTimeout(() => {
        unsub?.();
        resolve();
      }, timeoutMs);
      void ctx.events
        .subscribe(runId, (event) => {
          if (event.type === 'done' || (event.type === 'status' && event.status === 'awaiting_approval')) {
            clearTimeout(timer);
            unsub?.();
            resolve();
          }
        })
        .then((u) => {
          unsub = u;
        });
    });

  app.get('/health', async () => {
    const db = await ctx.pool
      .query('SELECT 1')
      .then(() => 'ok')
      .catch(() => 'down');
    const redis = await ctx.redis
      .ping()
      .then(() => 'ok')
      .catch(() => 'down');
    return {
      status: db === 'ok' && redis === 'ok' ? 'ok' : 'degraded',
      db,
      redis,
      role: ctx.config.role,
      worker: ctx.config.workerId,
      provider: ctx.llm.name,
    };
  });
  app.get('/metrics', async (_req, reply) => {
    void reply.header('content-type', ctx.metrics.registry.contentType);
    return ctx.metrics.registry.metrics();
  });
  app.get('/openapi.json', async () => openApiDocument(ctx.config.publicUrl));

  app.post('/auth/login', async (req) => {
    const input = loginSchema.parse(req.body);
    return ctx.auth.login(input.email, input.password);
  });
  app.get('/me', async (req) => toMeDto(await auth(req)));

  app.get('/settings', async (req) => {
    const identity = await auth(req);
    const t = await loadTenant(ctx.db, identity.tenantId);
    return {
      tenantId: t.id,
      name: t.name,
      domain: t.domain,
      timezone: t.timezone,
      instructions: t.instructions,
      hasServiceToken: t.serviceTokenEnc !== null,
    };
  });
  app.put('/settings', async (req) => {
    const identity = await auth(req);
    if (!['owner', 'admin', 'manager'].includes(identity.role))
      throw new RunError(403, 'Only managers can change agent settings');
    const input = settingsSchema.parse(req.body);
    await ctx.db
      .update(tenantSettings)
      .set({
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.domain !== undefined ? { domain: input.domain } : {}),
        ...(input.serviceToken !== undefined
          ? { serviceTokenEnc: input.serviceToken === '' ? null : ctx.auth.sealSecret(input.serviceToken) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(tenantSettings.tenantId, identity.tenantId));
    const t = await loadTenant(ctx.db, identity.tenantId);
    return {
      tenantId: t.id,
      name: t.name,
      domain: t.domain,
      timezone: t.timezone,
      instructions: t.instructions,
      hasServiceToken: t.serviceTokenEnc !== null,
    };
  });

  const policyGatewayForUser = async (
    identity: Identity,
    yaml?: string,
  ): Promise<{ gateway: AgentPolicyGateway; version: number }> => {
    const cred = await ctx.auth.credential(identity.tenantId, identity.userId);
    const token = cred?.token ?? '';
    const current = await ctx.policy.current(identity.tenantId, identity.userId);
    let compiled = current.policy;
    if (yaml !== undefined) {
      const c = compilePolicy(yaml, current.version + 1);
      if (c.policy === null) throw new PolicyValidationError(c.diagnostics);
      compiled = c.policy;
    }
    const tenant = await loadTenant(ctx.db, identity.tenantId);
    return {
      gateway: new AgentPolicyGateway(
        compiled,
        {
          user: { id: identity.userId, role: identity.role, scopes: identity.scopes },
          tenant: { id: tenant.id, name: tenant.name, domain: tenant.domain, timezone: tenant.timezone },
          token,
        },
        ctx.bop,
        ctx.counters,
        () => ctx.clock.now(),
      ),
      version: compiled.version,
    };
  };

  const toolsFor = async (identity: Identity): Promise<ToolDescriptor[]> => {
    const cred = await ctx.auth.credential(identity.tenantId, identity.userId);
    if (cred === null)
      return Object.entries(STATIC_RISKS).map(([name, risk]) => ({
        name,
        title: name,
        description: '',
        risk,
        inputSchema: {},
      }));
    const mcp = new McpToolGateway(ctx.config.bopMcpUrl, cred.token);
    try {
      return await mcp.listTools();
    } finally {
      await mcp.close();
    }
  };

  app.get('/tools', async (req) => {
    const identity = await auth(req);
    const { gateway } = await policyGatewayForUser(identity);
    const tools = await toolsFor(identity);
    const { visible, hidden } = gateway.visibility(tools);
    return {
      visible: visible.map((t) => ({ name: t.name, title: t.title, description: t.description, risk: t.risk })),
      hidden,
    };
  });

  app.post('/runs', async (req, reply) => {
    const identity = await auth(req);
    const input = startRunSchema.parse(req.body);
    const run = await services.runs.create(identity, input, { source: input.context?.source ?? 'api' });
    const wantsStream =
      (req.headers.accept ?? '').includes('text/event-stream') || (req.query as { stream?: string }).stream === '1';
    if (wantsStream) {
      await streamRun(req, reply, run.id, false, async () => {
        await services.runs.start(run.id);
      });
      return reply;
    }
    if (input.wait === true) {
      const waiting = waitForRun(run.id, 120_000);
      await services.runs.start(run.id);
      await waiting;
      return services.runs.detail(identity, run.id);
    }
    await services.runs.start(run.id);
    void reply.status(201);
    return run;
  });
  app.get('/runs', async (req) => {
    const identity = await auth(req);
    const q = runsQuerySchema.parse(req.query);
    return { items: await services.runs.list(identity, q) };
  });
  app.get('/runs/:id', async (req) => {
    const identity = await auth(req);
    return services.runs.detail(identity, (req.params as { id: string }).id);
  });
  app.get('/runs/:id/stream', async (req, reply) => {
    await auth(req);
    const id = (req.params as { id: string }).id;
    await services.runs.get(req.identity as Identity, id);
    await streamRun(req, reply, id, true, null);
    return reply;
  });
  app.post('/runs/:id/messages', async (req) => {
    const identity = await auth(req);
    const input = interveneSchema.parse(req.body);
    return services.runs.intervene(identity, (req.params as { id: string }).id, input.message);
  });
  app.post('/runs/:id/cancel', async (req) => {
    const identity = await auth(req);
    return services.runs.cancel(identity, (req.params as { id: string }).id);
  });

  app.get('/proposals', async (req) => {
    const identity = await auth(req);
    const status = (req.query as { status?: string }).status;
    return services.approvals.list(identity.tenantId, status === undefined || status === '' ? undefined : status);
  });
  app.post('/proposals/decide', async (req) => {
    const identity = await auth(req);
    const body = req.body as { decisions?: Array<Record<string, unknown>> };
    const input = decideSchema.parse(body);
    const withHashes = {
      decisions: input.decisions.map((d, i) => {
        const expected = body.decisions?.[i]?.['expectedHash'];
        return typeof expected === 'string' ? { ...d, expectedHash: expected } : d;
      }),
    };
    return { items: await services.approvals.decide(identity, withHashes) };
  });
  app.post('/approvals/callback', async (req) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    const sig = req.headers['x-bop-signature'];
    return services.approvals.callback(raw, Array.isArray(sig) ? sig[0] : sig, 3600 * 24);
  });

  app.post('/integrations/bop/ai-step', async (req, reply) => {
    services.workflowSteps.authorize(req.headers.authorization);
    const key = req.headers['idempotency-key'];
    const out = await services.workflowSteps.handle(Array.isArray(key) ? key[0] : key, req.body);
    if (out.replayed) void reply.header('idempotent-replayed', 'true');
    return out.response;
  });

  app.get('/policy', async (req) => {
    const identity = await auth(req);
    const current = await ctx.policy.current(identity.tenantId, identity.userId);
    const versions = await ctx.policy.versions(identity.tenantId);
    return {
      version: current.version,
      yaml: current.source,
      document: current.policy.document,
      summary: current.policy.summary(),
      versions: versions.map((v) => ({ version: v.version, createdAt: v.createdAt, createdBy: v.createdBy })),
    };
  });
  app.get('/policy/versions/:version', async (req) => {
    const identity = await auth(req);
    const v = Number((req.params as { version: string }).version);
    const versions = await ctx.policy.versions(identity.tenantId);
    const found = versions.find((x) => x.version === v);
    if (found === undefined) throw new RunError(404, 'Policy version not found');
    return { version: found.version, yaml: found.source, createdAt: found.createdAt };
  });
  app.post('/policy/validate', async (req) => {
    await auth(req);
    const input = putPolicySchema.parse(req.body);
    const r = ctx.policy.validate(input.yaml);
    return { ok: r.ok, diagnostics: r.diagnostics, summary: r.policy?.summary() ?? [] };
  });
  app.put('/policy', async (req) => {
    const identity = await auth(req);
    if (!['owner', 'admin', 'manager'].includes(identity.role))
      throw new RunError(403, 'Only managers can change the agent policy');
    const input = putPolicySchema.parse(req.body);
    const saved = await ctx.policy.save(identity.tenantId, input.yaml, identity.userId, input.baseVersion);
    return { version: saved.version, diagnostics: saved.diagnostics };
  });
  app.post('/policy/simulate', async (req) => {
    const identity = await auth(req);
    const input = simulateSchema.parse(req.body);
    if ('tool' in input) {
      const { gateway, version } = await policyGatewayForUser(identity, input.yaml);
      const tools = await toolsFor(identity).catch(() => [] as ToolDescriptor[]);
      const descriptor = tools.find((t) => t.name === input.tool) ?? {
        name: input.tool,
        title: input.tool,
        description: '',
        risk: STATIC_RISKS[input.tool] ?? 'external',
        inputSchema: {},
      };
      const usage = {
        steps: 0,
        llmCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        wallClockMs: 0,
        externalActions: input.run?.externalCount ?? 0,
        writeCount: input.run?.writeCount ?? 0,
        emailsSent: input.run?.emailsSent ?? 0,
        firstTokenMs: null,
      };
      const decision = await gateway.evaluate({ tool: descriptor, args: input.args, usage });
      const { visible } = gateway.visibility([descriptor]);
      return { version, risk: descriptor.risk, visible: visible.length === 1, decision };
    }
    const current = await ctx.policy.current(identity.tenantId, identity.userId);
    let candidate = current.policy;
    if (input.yaml !== undefined) {
      const c = compilePolicy(input.yaml, current.version + 1);
      if (c.policy === null) throw new PolicyValidationError(c.diagnostics);
      candidate = c.policy;
    } else if (input.version !== undefined) candidate = await ctx.policy.version(identity.tenantId, input.version);
    const { gateway } = await policyGatewayForUser(identity);
    return ctx.policy.replay(identity.tenantId, candidate, input.lastRuns, gateway.host());
  });

  app.get('/playbooks', async (req) => ({ items: await services.playbooks.list(await auth(req)) }));
  app.post('/playbooks', async (req, reply) => {
    const identity = await auth(req);
    const out = await services.playbooks.create(identity, playbookCreateSchema.parse(req.body));
    void reply.status(201);
    return out;
  });
  app.get('/playbooks/:id', async (req) =>
    services.playbooks.detail(await auth(req), (req.params as { id: string }).id),
  );
  app.patch('/playbooks/:id', async (req) =>
    services.playbooks.update(await auth(req), (req.params as { id: string }).id, playbookUpdateSchema.parse(req.body)),
  );
  app.delete('/playbooks/:id', async (req, reply) => {
    await services.playbooks.remove(await auth(req), (req.params as { id: string }).id);
    void reply.status(204);
    return null;
  });
  app.post('/playbooks/:id/run', async (req) =>
    services.playbooks.runNow(await auth(req), (req.params as { id: string }).id),
  );

  app.get('/usage', async (req) => {
    const identity = await auth(req);
    const q = usageQuerySchema.parse(req.query);
    const to = q.to !== undefined ? new Date(q.to) : ctx.clock.now();
    const from = q.from !== undefined ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
    return services.runs.usage(identity, from, to);
  });

  app.get('/eval/runs', async (req) => {
    await auth(req);
    const rows = await ctx.db.select().from(evalRuns).orderBy(desc(evalRuns.createdAt)).limit(50);
    return { items: rows.map(evalRunDto) };
  });
  app.get('/eval/runs/:id', async (req) => {
    await auth(req);
    const id = z.uuid().parse((req.params as { id: string }).id);
    const [row] = await ctx.db.select().from(evalRuns).where(eq(evalRuns.id, id));
    if (row === undefined) throw new RunError(404, 'Eval run not found');
    const results = await ctx.db.select().from(evalResults).where(eq(evalResults.evalRunId, id));
    return {
      ...evalRunDto(row),
      report: row.reportMd,
      results: results
        .map(evalResultDto)
        .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.model.localeCompare(b.model)),
    };
  });

  return app;
}
