import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import {
  emptyUsage,
  type Budget,
  type ChatMessage,
  type PolicyOverrides,
  type RunContext,
  type RunDetailDto,
  type RunDto,
  type StartRunInput,
  type StopReason,
  type UsageReport,
  type UsageRow,
  type Usage,
  type RunStatus,
} from '@aio/contracts';
import { mergeBudget, PROMPT_VERSION, stepToDto } from '@aio/agent-core';
import type { AppContext } from '../context';
import { agentMessages, agentRuns, interventions, playbooks, proposalBatches, proposals } from '../db/schema';
import { proposalDto } from './approvals';
import type { Identity } from './auth';
import { PgRunStore, toStepRecord } from './store';
import { agentSteps } from '../db/schema';

type RunRow = typeof agentRuns.$inferSelect;

export class RunError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function runDto(r: RunRow, pending = 0): RunDto {
  return {
    id: r.id,
    tenantId: r.tenantId,
    userId: r.userId,
    userName: r.userName,
    playbookId: r.playbookId,
    goal: r.goal,
    status: r.status as RunStatus,
    stopReason: (r.stopReason as StopReason | null) ?? null,
    policyVersion: r.policyVersion,
    promptVersion: r.promptVersion,
    model: r.model,
    budget: r.budget as Budget,
    usage: { ...emptyUsage(), ...(r.usage as Partial<Usage>) },
    context: (r.context as RunContext | null) ?? null,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    summary: r.summary,
    error: r.error,
    pendingProposals: pending,
  };
}

export interface CreateRunOptions {
  playbookId?: string | null;
  source?: RunContext['source'];
  policyOverrides?: PolicyOverrides;
  model?: string;
  workflow?: RunContext['workflow'];
}

export class RunService {
  readonly store: PgRunStore;

  constructor(private readonly ctx: AppContext) {
    this.store = new PgRunStore(ctx.db);
  }

  async costToday(tenantId: string): Promise<number> {
    const res = await this.ctx.db.execute<{ c: string }>(
      sql`SELECT coalesce(sum((usage->>'costUsd')::float8), 0)::text AS c FROM agent_runs WHERE tenant_id = ${tenantId}::uuid AND created_at >= date_trunc('day', now())`,
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  async create(identity: Identity, input: StartRunInput, options: CreateRunOptions = {}): Promise<RunDto> {
    if (!identity.scopes.includes('records:read'))
      throw new RunError(403, 'You need at least read access to the business system');
    if ((await this.costToday(identity.tenantId)) >= this.ctx.config.demoDailyCostLimitUsd)
      throw new RunError(
        429,
        `Daily spend limit of $${this.ctx.config.demoDailyCostLimitUsd} reached for this workspace`,
      );
    const policy = await this.ctx.policy.current(identity.tenantId, identity.userId);
    const budget = mergeBudget(
      this.ctx.config.budget,
      policy.policy.document.budget,
      options.policyOverrides?.budget,
      input.budget,
    );
    const context: RunContext & { policyOverrides?: PolicyOverrides } = {
      ...(input.context?.record !== undefined ? { record: input.context.record } : {}),
      source: options.source ?? input.context?.source ?? 'api',
      ...(options.workflow !== undefined ? { workflow: options.workflow } : {}),
      ...(options.policyOverrides !== undefined ? { policyOverrides: options.policyOverrides } : {}),
    };
    const [row] = await this.ctx.db
      .insert(agentRuns)
      .values({
        tenantId: identity.tenantId,
        userId: identity.userId,
        userName: identity.name,
        playbookId: options.playbookId ?? null,
        goal: input.goal,
        status: 'queued',
        policyVersion: policy.version,
        promptVersion: PROMPT_VERSION,
        model: options.model ?? this.ctx.config.llm.model,
        budget,
        usage: emptyUsage(),
        context,
      })
      .returning();
    return runDto(row as RunRow);
  }

  async start(runId: string): Promise<void> {
    await this.ctx.dispatcher.dispatch({ type: 'start', runId });
  }

  async get(identity: Identity, runId: string): Promise<RunRow> {
    const [row] = await this.ctx.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, identity.tenantId)));
    if (row === undefined) throw new RunError(404, 'Run not found');
    return row;
  }

  async list(
    identity: Identity,
    q: { status?: string; userId?: string; playbookId?: string; limit: number },
  ): Promise<RunDto[]> {
    const conds: SQL[] = [eq(agentRuns.tenantId, identity.tenantId)];
    if (q.status !== undefined) conds.push(inArray(agentRuns.status, q.status.split(',')));
    if (q.userId !== undefined) conds.push(eq(agentRuns.userId, q.userId));
    if (q.playbookId !== undefined) conds.push(eq(agentRuns.playbookId, q.playbookId));
    const rows = await this.ctx.db
      .select()
      .from(agentRuns)
      .where(and(...conds))
      .orderBy(desc(agentRuns.createdAt))
      .limit(q.limit);
    const counts =
      rows.length === 0
        ? []
        : await this.ctx.db
            .select({ runId: proposals.runId, n: sql<number>`count(*)::int` })
            .from(proposals)
            .where(
              and(
                inArray(
                  proposals.runId,
                  rows.map((r) => r.id),
                ),
                eq(proposals.status, 'pending'),
              ),
            )
            .groupBy(proposals.runId);
    const byRun = new Map(counts.map((c) => [c.runId, Number(c.n)]));
    return rows.map((r) => runDto(r, byRun.get(r.id) ?? 0));
  }

  async detail(identity: Identity, runId: string): Promise<RunDetailDto> {
    const row = await this.get(identity, runId);
    const steps = await this.ctx.db
      .select()
      .from(agentSteps)
      .where(eq(agentSteps.runId, runId))
      .orderBy(asc(agentSteps.seq));
    const props = await this.ctx.db
      .select()
      .from(proposals)
      .where(eq(proposals.runId, runId))
      .orderBy(asc(proposals.stepSeq));
    const msgs = await this.ctx.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.runId, runId))
      .orderBy(asc(agentMessages.seq));
    return {
      ...runDto(row, props.filter((p) => p.status === 'pending').length),
      steps: steps.map((s) => stepToDto(toStepRecord(s))),
      proposals: props.map(proposalDto),
      messages: msgs.map((m) => ({
        seq: m.seq,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  async intervene(identity: Identity, runId: string, text: string): Promise<{ mode: 'intervention' | 'reply' }> {
    const row = await this.get(identity, runId);
    if (row.userId !== identity.userId && !['owner', 'admin', 'manager'].includes(identity.role))
      throw new RunError(403, 'Only the run owner can talk to this run');
    if (row.status === 'failed' || row.status === 'cancelled') throw new RunError(409, `Run is ${row.status}`);
    if (row.status === 'completed') {
      const message: ChatMessage = { role: 'user', content: [{ type: 'text', text }] };
      await this.store.appendMessage(runId, message);
      await this.ctx.db
        .update(agentRuns)
        .set({ status: 'queued', stopReason: null, finishedAt: null, updatedAt: new Date() })
        .where(eq(agentRuns.id, runId));
      await this.ctx.dispatcher.dispatch({ type: 'resume', runId, attempt: Date.now() });
      return { mode: 'reply' };
    }
    await this.ctx.db.insert(interventions).values({ runId, text, createdBy: identity.userId });
    return { mode: 'intervention' };
  }

  async cancel(identity: Identity, runId: string): Promise<RunDto> {
    const row = await this.get(identity, runId);
    if (['completed', 'failed', 'cancelled'].includes(row.status)) return runDto(row);
    await this.ctx.db
      .update(agentRuns)
      .set({ cancelRequested: true, updatedAt: new Date() })
      .where(eq(agentRuns.id, runId));
    if (row.status === 'queued' || row.status === 'awaiting_approval') {
      const now = this.ctx.clock.now();
      const batches = await this.ctx.db
        .update(proposalBatches)
        .set({ status: 'cancelled', decidedAt: now, appliedAt: now })
        .where(and(eq(proposalBatches.runId, runId), inArray(proposalBatches.status, ['collecting', 'pending'])))
        .returning();
      await this.ctx.db
        .update(proposals)
        .set({ status: 'cancelled', decidedAt: now })
        .where(and(eq(proposals.runId, runId), eq(proposals.status, 'pending')));
      const cred = await this.ctx.auth.credential(identity.tenantId, identity.userId);
      for (const b of batches)
        if (b.externalApprovalId !== null && cred !== null)
          await this.ctx.bop
            .decideApproval(cred.token, b.externalApprovalId, 'reject', 'Run cancelled in the AI operator console')
            .catch(() => undefined);
      await this.store.updateRun(runId, {
        status: 'cancelled',
        stopReason: 'cancelled',
        finishedAt: now,
        summary: 'Run cancelled by the user.',
      });
      this.ctx.events.publish({ type: 'status', runId, status: 'cancelled', stopReason: 'cancelled' });
      this.ctx.events.publish({
        type: 'done',
        runId,
        status: 'cancelled',
        stopReason: 'cancelled',
        summary: 'Run cancelled by the user.',
      });
    }
    return runDto(await this.get(identity, runId));
  }

  async usage(identity: Identity, from: Date, to: Date): Promise<UsageReport> {
    const rows = await this.ctx.db
      .select()
      .from(agentRuns)
      .where(
        and(eq(agentRuns.tenantId, identity.tenantId), gte(agentRuns.createdAt, from), lte(agentRuns.createdAt, to)),
      );
    const pbs = await this.ctx.db
      .select({ id: playbooks.id, name: playbooks.name })
      .from(playbooks)
      .where(eq(playbooks.tenantId, identity.tenantId));
    const pbName = new Map(pbs.map((p) => [p.id, p.name]));
    const group = (keyOf: (r: RunRow) => [string, string]): UsageRow[] => {
      const map = new Map<string, UsageRow>();
      for (const r of rows) {
        const [key, label] = keyOf(r);
        const u = { ...emptyUsage(), ...(r.usage as Partial<Usage>) };
        const cur = map.get(key) ?? { key, label, runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
        cur.runs += 1;
        cur.costUsd = Math.round((cur.costUsd + u.costUsd) * 1e6) / 1e6;
        cur.inputTokens += u.inputTokens;
        cur.outputTokens += u.outputTokens;
        map.set(key, cur);
      }
      return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
    };
    const byDay = group((r) => {
      const d = r.createdAt.toISOString().slice(0, 10);
      return [d, d];
    });
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalCostUsd: Math.round(byDay.reduce((s, r) => s + r.costUsd, 0) * 1e6) / 1e6,
      totalRuns: rows.length,
      byDay,
      byUser: group((r) => [r.userId, r.userName ?? r.userId]),
      byPlaybook: group((r) =>
        r.playbookId === null ? ['adhoc', 'Ad-hoc runs'] : [r.playbookId, pbName.get(r.playbookId) ?? r.playbookId],
      ),
      byModel: group((r) => [r.model, r.model]),
    };
  }
}
