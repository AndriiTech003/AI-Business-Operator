import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { RunEvent, ToolDescriptor, PolicyOverrides } from '@aio/contracts';
import { AgentRunner, type AgentOptions, type AgentPorts, type RunState } from '@aio/agent-core';
import { CompiledPolicy } from '@aio/policy';
import type { AppContext } from '../context';
import { agentRuns } from '../db/schema';
import { CompositeSink } from '../services/events';
import { McpToolGateway, ReadOnlyGateway } from '../services/mcp';
import { AgentPolicyGateway, applyOverrides, STATIC_RISKS } from '../services/policy';
import { AgentPromptProvider, loadTenant } from '../services/prompt';
import { BopActionResolver } from '../services/resolver';
import { PgRunStore, toRunState } from '../services/store';
import type { RunJob } from './dispatch';

const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export interface ExecuteOptions {
  scenarioId?: string;
  agentOptions?: Partial<AgentOptions>;
}

export class RunExecutor {
  readonly store: PgRunStore;

  constructor(private readonly ctx: AppContext) {
    this.store = new PgRunStore(ctx.db);
  }

  private lockKey(runId: string): string {
    return `${this.ctx.config.redisPrefix}:lock:run:${runId}`;
  }

  async policyGatewayFor(
    run: RunState,
    token: string,
    identity: { userId: string; role: string; scopes: string[] },
  ): Promise<AgentPolicyGateway> {
    const tenant = await loadTenant(this.ctx.db, run.tenantId);
    const base = await this.ctx.policy.version(run.tenantId, run.policyVersion);
    const overrides = (run.context as { policyOverrides?: PolicyOverrides } | null)?.policyOverrides;
    const compiled = overrides?.defaults
      ? new CompiledPolicy(base.version, applyOverrides(base.document, overrides), base.rules, base.source)
      : base;
    return new AgentPolicyGateway(
      compiled,
      {
        user: { id: identity.userId, role: identity.role, scopes: identity.scopes },
        tenant: { id: tenant.id, name: tenant.name, domain: tenant.domain, timezone: tenant.timezone },
        token,
      },
      this.ctx.bop,
      this.ctx.counters,
      () => this.ctx.clock.now(),
    );
  }

  async checkEdit(
    runId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ decision: string; ruleId: string; reasons: string[] }> {
    const run = await this.store.getRun(runId);
    const cred = await this.ctx.auth.credential(run.tenantId, run.userId);
    if (cred === null)
      return { decision: 'deny', ruleId: 'missing-credential', reasons: ['run owner has no stored credential'] };
    const gateway = await this.policyGatewayFor(run, cred.token, cred.identity);
    const descriptor: ToolDescriptor = (run.tools ?? []).find((t) => t.name === tool) ?? {
      name: tool,
      title: tool,
      description: '',
      risk: STATIC_RISKS[tool] ?? 'external',
      inputSchema: {},
    };
    const resolver = new BopActionResolver(
      this.ctx.bop,
      cred.token,
      new McpToolGateway(this.ctx.config.bopMcpUrl, cred.token),
    );
    const view = tool === 'send_email' ? args : (await resolver.resolve(tool, args)).view;
    const d = await gateway.evaluate({ tool: descriptor, args: view, usage: run.usage });
    return { decision: d.decision, ruleId: d.ruleId, reasons: d.reasons };
  }

  async buildPorts(
    run: RunState,
    options: ExecuteOptions = {},
  ): Promise<{ ports: AgentPorts; close: () => Promise<void> }> {
    const cred = await this.ctx.auth.credential(run.tenantId, run.userId);
    if (cred === null) throw new Error(`no stored business-system credential for user ${run.userId}`);
    const tenant = await loadTenant(this.ctx.db, run.tenantId);
    const team = await this.ctx.team.members(run.tenantId, cred.token);
    const mcp = new McpToolGateway(this.ctx.config.bopMcpUrl, cred.token);
    const gateway = this.ctx.toolGatewayFactory?.(cred.token, run) ?? mcp;
    const workflowTask = run.context?.workflow?.task;
    const tools = workflowTask === 'classify' || workflowTask === 'summarize' ? new ReadOnlyGateway(gateway) : gateway;
    const policy = await this.policyGatewayFor(run, cred.token, cred.identity);
    const metrics = this.ctx.metrics;
    const finishSink = {
      emit: (event: RunEvent) => {
        if (event.type === 'done') {
          metrics.runsFinished.inc({ status: event.status, stop_reason: event.stopReason ?? 'none' });
        }
      },
    };
    const ports: AgentPorts = {
      store: this.store,
      tools,
      policy,
      resolver: new BopActionResolver(this.ctx.bop, cred.token, tools),
      approvals: this.ctx.approvals,
      prompt: new AgentPromptProvider(
        tenant,
        { id: cred.identity.userId, name: cred.identity.name, email: cred.identity.email, role: cred.identity.role },
        team,
      ),
      events: new CompositeSink([this.ctx.events.sink(), finishSink]),
      clock: this.ctx.clock,
      llm: this.ctx.llm,
      prices: this.ctx.prices,
      telemetry: this.ctx.telemetry,
      ...(options.scenarioId !== undefined ? { scenarioId: options.scenarioId } : {}),
    };
    return { ports, close: () => mcp.close() };
  }

  private async acquire(runId: string, token: string): Promise<boolean> {
    const ok = await this.ctx.redis.set(this.lockKey(runId), token, 'PX', this.ctx.config.leaseMs, 'NX');
    if (ok !== 'OK') return false;
    await this.ctx.db
      .update(agentRuns)
      .set({
        leaseOwner: this.ctx.config.workerId,
        leaseExpiresAt: new Date(this.ctx.clock.now().getTime() + this.ctx.config.leaseMs),
      })
      .where(eq(agentRuns.id, runId));
    return true;
  }

  private async renew(runId: string, token: string): Promise<boolean> {
    const r = await this.ctx.redis.eval(RENEW, 1, this.lockKey(runId), token, String(this.ctx.config.leaseMs));
    if (Number(r) !== 1) return false;
    await this.ctx.db
      .update(agentRuns)
      .set({ leaseExpiresAt: new Date(this.ctx.clock.now().getTime() + this.ctx.config.leaseMs) })
      .where(eq(agentRuns.id, runId));
    return true;
  }

  private async release(runId: string, token: string): Promise<void> {
    await this.ctx.redis.eval(RELEASE, 1, this.lockKey(runId), token).catch(() => 0);
    await this.ctx.db.update(agentRuns).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(agentRuns.id, runId));
  }

  async execute(job: RunJob, options: ExecuteOptions = {}): Promise<'done' | 'locked' | 'skipped'> {
    const [row] = await this.ctx.db.select().from(agentRuns).where(eq(agentRuns.id, job.runId));
    if (row === undefined) return 'skipped';
    if (['completed', 'failed', 'cancelled'].includes(row.status)) return 'skipped';
    if (row.status === 'awaiting_approval' && job.type !== 'continue') return 'skipped';
    const token = `${this.ctx.config.workerId}:${randomUUID()}`;
    if (!(await this.acquire(job.runId, token))) return 'locked';
    if (job.type === 'resume') {
      this.ctx.metrics.resumes.inc({ reason: 'lease_expired' });
      await this.ctx.db
        .update(agentRuns)
        .set({ attempts: sql`${agentRuns.attempts} + 1` })
        .where(eq(agentRuns.id, job.runId));
    }
    if (job.type === 'start')
      this.ctx.metrics.runsStarted.inc({ source: (row.context as { source?: string } | null)?.source ?? 'api' });
    const heartbeat = setInterval(() => {
      void this.renew(job.runId, token).catch(() => false);
    }, this.ctx.config.heartbeatMs);
    let close: (() => Promise<void>) | null = null;
    try {
      const run = toRunState(row);
      const built = await this.buildPorts(run, options);
      close = built.close;
      const delay = Number(process.env['AIO_TEST_DELAY_AFTER_EFFECT_MS'] ?? 0);
      const runner = new AgentRunner(built.ports, {
        ...(delay > 0 ? { delayAfterEffectMs: delay } : {}),
        ...(options.agentOptions ?? {}),
      });
      const work = async () => {
        if (job.type === 'continue' && job.batchId !== undefined) await runner.applyApprovals(job.runId, job.batchId);
        else await runner.run(job.runId);
        return null;
      };
      const span = this.ctx.telemetry.span;
      if (span !== undefined)
        await span(
          'invoke_agent operator',
          {
            'gen_ai.operation.name': 'invoke_agent',
            'gen_ai.agent.name': 'ai-business-operator',
            'aio.run_id': run.id,
            'aio.job': job.type,
          },
          work,
        );
      else await work();
      const [after] = await this.ctx.db
        .select({ usage: agentRuns.usage, status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, job.runId));
      if (after !== undefined && ['completed', 'failed', 'cancelled'].includes(after.status))
        this.ctx.metrics.costPerRun.observe(Number((after.usage as { costUsd?: number }).costUsd ?? 0));
      return 'done';
    } catch (error) {
      this.ctx.logger.error({ err: (error as Error).message, runId: job.runId }, 'run execution failed');
      const attempts = row.attempts + 1;
      if (attempts >= 5 || (error as Error).message.startsWith('no stored business-system credential')) {
        await this.store.updateRun(job.runId, {
          status: 'failed',
          stopReason: 'error',
          error: (error as Error).message,
          finishedAt: this.ctx.clock.now(),
        });
        this.ctx.events.publish({
          type: 'done',
          runId: job.runId,
          status: 'failed',
          stopReason: 'error',
          summary: null,
        });
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (close !== null) await close().catch(() => undefined);
      await this.release(job.runId, token);
    }
  }
}
