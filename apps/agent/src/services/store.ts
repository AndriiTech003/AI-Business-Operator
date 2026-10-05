import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  ChatMessage,
  PolicyDecision,
  ProposalPreview,
  StepKind,
  TaintFinding,
  ToolDescriptor,
  Usage,
  Budget,
  RunContext,
  StopReason,
  RunStatus,
} from '@aio/contracts';
import { emptyUsage } from '@aio/contracts';
import type {
  BatchRecord,
  HiddenToolInfo,
  NewProposal,
  NewStep,
  ProposalRecord,
  RunPatch,
  RunState,
  RunStore,
  StepRecord,
} from '@aio/agent-core';
import type { UntrustedSpan } from '@aio/taint';
import type { Db } from '../db/client';
import {
  agentMessages,
  agentRuns,
  agentSteps,
  interventions,
  proposalBatches,
  proposals,
  untrustedSpans,
} from '../db/schema';

type RunRow = typeof agentRuns.$inferSelect;
type StepRow = typeof agentSteps.$inferSelect;
type ProposalRow = typeof proposals.$inferSelect;
type BatchRow = typeof proposalBatches.$inferSelect;

export function toRunState(r: RunRow): RunState {
  return {
    id: r.id,
    tenantId: r.tenantId,
    userId: r.userId,
    goal: r.goal,
    status: r.status as RunStatus,
    stopReason: (r.stopReason as StopReason | null) ?? null,
    model: r.model,
    budget: r.budget as Budget,
    usage: { ...emptyUsage(), ...(r.usage as Partial<Usage>) },
    policyVersion: r.policyVersion,
    context: (r.context as RunContext | null) ?? null,
    startedAt: r.startedAt,
    createdAt: r.createdAt,
    systemPrompt: r.systemPrompt,
    tools: (r.tools as ToolDescriptor[] | null) ?? null,
    hiddenTools: (r.hiddenTools as HiddenToolInfo[] | null) ?? null,
    promptNow: r.promptNow,
  };
}

export function toStepRecord(s: StepRow): StepRecord {
  return {
    id: s.id,
    runId: s.runId,
    seq: s.seq,
    kind: s.kind as StepKind,
    status: s.status as 'pending' | 'done',
    tool: s.tool,
    toolUseId: s.toolUseId,
    args: s.args,
    result: s.result,
    policyDecision: (s.policyDecision as PolicyDecision | null) ?? null,
    taint: (s.taint as TaintFinding[] | null) ?? null,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    costUsd: s.costUsd,
    latencyMs: s.latencyMs,
    idempotencyKey: s.idempotencyKey,
    createdAt: s.createdAt,
  };
}

export function toProposalRecord(p: ProposalRow): ProposalRecord {
  return {
    id: p.id,
    runId: p.runId,
    batchId: p.batchId,
    tool: p.tool,
    args: p.args as Record<string, unknown>,
    argsHash: p.argsHash,
    approvedHash: p.approvedHash,
    originalArgs: (p.originalArgs as Record<string, unknown> | null) ?? null,
    status: p.status as ProposalRecord['status'],
    edited: p.edited,
    risk: p.risk as ProposalRecord['risk'],
    ruleId: p.ruleId,
    toolUseId: p.toolUseId,
    decidedBy: p.decidedBy,
    comment: p.comment,
    executionResult: p.executionResult,
  };
}

function toBatch(b: BatchRow): BatchRecord {
  return {
    id: b.id,
    runId: b.runId,
    status: b.status as BatchRecord['status'],
    expiresAt: b.expiresAt,
    externalApprovalId: b.externalApprovalId,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

export class PgRunStore implements RunStore {
  constructor(private readonly db: Db) {}

  async getRun(runId: string): Promise<RunState> {
    const [row] = await this.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    if (row === undefined) throw new Error(`run ${runId} not found`);
    return toRunState(row);
  }

  async updateRun(runId: string, patch: RunPatch): Promise<void> {
    const set: Partial<typeof agentRuns.$inferInsert> = { updatedAt: new Date() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.stopReason !== undefined) set.stopReason = patch.stopReason;
    if (patch.usage !== undefined) set.usage = patch.usage;
    if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
    if (patch.systemPrompt !== undefined) set.systemPrompt = patch.systemPrompt;
    if (patch.tools !== undefined) set.tools = patch.tools;
    if (patch.hiddenTools !== undefined) set.hiddenTools = patch.hiddenTools;
    if (patch.promptNow !== undefined) set.promptNow = patch.promptNow;
    if (patch.summary !== undefined) set.summary = patch.summary;
    if (patch.error !== undefined) set.error = patch.error;
    if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
    await this.db.update(agentRuns).set(set).where(eq(agentRuns.id, runId));
  }

  async loadMessages(runId: string): Promise<ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.runId, runId))
      .orderBy(asc(agentMessages.seq));
    return rows.map((r) => ({ role: r.role as ChatMessage['role'], content: r.content as ChatMessage['content'] }));
  }

  async appendMessage(runId: string, message: ChatMessage): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.db.execute(
          sql`INSERT INTO agent_messages (run_id, seq, role, content) SELECT ${runId}::uuid, coalesce(max(seq), 0) + 1, ${message.role}::text, ${JSON.stringify(message.content)}::jsonb FROM agent_messages WHERE run_id = ${runId}::uuid`,
        );
        return;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error('could not append message');
  }

  async createStep(runId: string, step: NewStep): Promise<StepRecord> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const res = await this.db.execute<{ id: string }>(
          sql`INSERT INTO agent_steps (run_id, seq, kind, status, tool, tool_use_id, args, result, policy_decision, taint, tokens_in, tokens_out, cost_usd, latency_ms, idempotency_key)
              SELECT ${runId}::uuid, coalesce(max(seq), 0) + 1, ${step.kind}::text, ${step.status ?? 'done'}::text, ${step.tool ?? null}::text, ${step.toolUseId ?? null}::text,
                     ${JSON.stringify(step.args ?? null)}::jsonb, ${JSON.stringify(step.result ?? null)}::jsonb,
                     ${JSON.stringify(step.policyDecision ?? null)}::jsonb, ${JSON.stringify(step.taint ?? null)}::jsonb,
                     ${step.tokensIn ?? 0}::int, ${step.tokensOut ?? 0}::int, ${step.costUsd ?? 0}::float8, ${step.latencyMs ?? 0}::int, ${step.idempotencyKey ?? null}::text
              FROM agent_steps WHERE run_id = ${runId}::uuid
              RETURNING id`,
        );
        const id = res.rows[0]?.id as string;
        const [row] = await this.db.select().from(agentSteps).where(eq(agentSteps.id, id));
        return toStepRecord(row as StepRow);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error('could not create step');
  }

  async updateStep(stepId: string, patch: NewStep): Promise<StepRecord> {
    const set: Partial<typeof agentSteps.$inferInsert> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.result !== undefined) set.result = patch.result;
    if (patch.policyDecision !== undefined) set.policyDecision = patch.policyDecision;
    if (patch.taint !== undefined) set.taint = patch.taint;
    if (patch.latencyMs !== undefined) set.latencyMs = patch.latencyMs;
    if (patch.idempotencyKey !== undefined) set.idempotencyKey = patch.idempotencyKey;
    if (patch.args !== undefined) set.args = patch.args;
    const [row] = await this.db.update(agentSteps).set(set).where(eq(agentSteps.id, stepId)).returning();
    return toStepRecord(row as StepRow);
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    const rows = await this.db
      .select()
      .from(agentSteps)
      .where(eq(agentSteps.runId, runId))
      .orderBy(asc(agentSteps.seq));
    return rows.map(toStepRecord);
  }

  async findStepByToolUse(runId: string, toolUseId: string): Promise<StepRecord | null> {
    const [row] = await this.db
      .select()
      .from(agentSteps)
      .where(and(eq(agentSteps.runId, runId), eq(agentSteps.toolUseId, toolUseId), eq(agentSteps.kind, 'tool_call')));
    return row === undefined ? null : toStepRecord(row);
  }

  async takeInterventions(runId: string): Promise<string[]> {
    const rows = await this.db
      .update(interventions)
      .set({ appliedAt: new Date() })
      .where(and(eq(interventions.runId, runId), isNull(interventions.appliedAt)))
      .returning();
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const r of rows)
      await this.createStep(runId, {
        kind: 'intervention',
        status: 'done',
        args: { text: r.text },
        result: { appliedAt: new Date().toISOString() },
      });
    return rows.map((r) => r.text);
  }

  async saveSpans(runId: string, stepId: string, spans: UntrustedSpan[]): Promise<void> {
    if (spans.length === 0) return;
    await this.db
      .insert(untrustedSpans)
      .values(
        spans.map((s) => ({
          runId,
          stepId,
          stepSeq: s.stepSeq,
          tool: s.tool,
          path: s.path,
          text: s.text,
          textHash: createHash('sha256').update(s.text).digest('hex'),
        })),
      )
      .onConflictDoNothing();
  }

  async loadSpans(runId: string): Promise<UntrustedSpan[]> {
    const rows = await this.db.select().from(untrustedSpans).where(eq(untrustedSpans.runId, runId));
    return rows.map((r) => ({ text: r.text, tool: r.tool, path: r.path, stepSeq: r.stepSeq }));
  }

  async openBatch(runId: string, expiresAt: Date): Promise<BatchRecord> {
    const [existing] = await this.db
      .select()
      .from(proposalBatches)
      .where(and(eq(proposalBatches.runId, runId), eq(proposalBatches.status, 'collecting')));
    if (existing !== undefined) return toBatch(existing);
    const run = await this.getRun(runId);
    const [row] = await this.db
      .insert(proposalBatches)
      .values({ runId, tenantId: run.tenantId, expiresAt, status: 'collecting' })
      .returning();
    return toBatch(row as BatchRow);
  }

  async sealBatch(runId: string): Promise<BatchRecord | null> {
    const [row] = await this.db
      .update(proposalBatches)
      .set({ status: 'pending' })
      .where(and(eq(proposalBatches.runId, runId), eq(proposalBatches.status, 'collecting')))
      .returning();
    if (row !== undefined) return toBatch(row);
    const [pending] = await this.db
      .select()
      .from(proposalBatches)
      .where(and(eq(proposalBatches.runId, runId), eq(proposalBatches.status, 'pending')));
    return pending === undefined ? null : toBatch(pending);
  }

  async getBatch(batchId: string): Promise<BatchRecord> {
    const [row] = await this.db.select().from(proposalBatches).where(eq(proposalBatches.id, batchId));
    if (row === undefined) throw new Error(`batch ${batchId} not found`);
    return toBatch(row);
  }

  async createProposal(p: NewProposal): Promise<ProposalRecord> {
    const run = await this.getRun(p.runId);
    const inserted = await this.db
      .insert(proposals)
      .values({
        runId: p.runId,
        batchId: p.batchId,
        tenantId: run.tenantId,
        tool: p.tool,
        args: p.args,
        argsHash: p.argsHash,
        preview: p.preview as ProposalPreview | null,
        risk: p.risk,
        ruleId: p.ruleId,
        reasons: p.reasons,
        warnings: p.warnings,
        taint: p.taint,
        toolUseId: p.toolUseId,
        stepSeq: p.stepSeq,
        expiresAt: p.expiresAt,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0] !== undefined) return toProposalRecord(inserted[0]);
    const [existing] = await this.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.runId, p.runId), eq(proposals.toolUseId, p.toolUseId)));
    return toProposalRecord(existing as ProposalRow);
  }

  async listBatchProposals(batchId: string): Promise<ProposalRecord[]> {
    const rows = await this.db
      .select()
      .from(proposals)
      .where(eq(proposals.batchId, batchId))
      .orderBy(asc(proposals.stepSeq));
    return rows.map(toProposalRecord);
  }

  async markProposal(
    proposalId: string,
    patch: { status: ProposalRecord['status']; executionResult?: unknown; executedAt?: Date | null },
  ): Promise<void> {
    await this.db
      .update(proposals)
      .set({
        status: patch.status,
        ...(patch.executionResult !== undefined ? { executionResult: patch.executionResult } : {}),
        ...(patch.executedAt !== undefined ? { executedAt: patch.executedAt } : {}),
      })
      .where(eq(proposals.id, proposalId));
  }

  async applyBatch(batchId: string, message: ChatMessage): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [batch] = await tx
        .update(proposalBatches)
        .set({ status: 'applied', appliedAt: new Date() })
        .where(
          and(eq(proposalBatches.id, batchId), inArray(proposalBatches.status, ['decided', 'expired', 'cancelled'])),
        )
        .returning();
      if (batch === undefined) return false;
      await tx.execute(
        sql`INSERT INTO agent_messages (run_id, seq, role, content) SELECT ${batch.runId}::uuid, coalesce(max(seq), 0) + 1, ${message.role}::text, ${JSON.stringify(message.content)}::jsonb FROM agent_messages WHERE run_id = ${batch.runId}::uuid`,
      );
      await tx.update(agentRuns).set({ status: 'running', updatedAt: new Date() }).where(eq(agentRuns.id, batch.runId));
      return true;
    });
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    const [row] = await this.db.select({ c: agentRuns.cancelRequested }).from(agentRuns).where(eq(agentRuns.id, runId));
    return row?.c === true;
  }
}
