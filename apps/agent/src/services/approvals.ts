import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type {
  ApprovalCallback,
  BatchDto,
  DecideInput,
  ProposalDto,
  ProposalPreview,
  TaintFinding,
} from '@aio/contracts';
import { argsHash, type ApprovalPublisher, type BatchRecord } from '@aio/agent-core';
import type { Db } from '../db/client';
import { agentRuns, proposalBatches, proposals } from '../db/schema';
import type { AuthService, Identity } from './auth';
import type { BopClient } from './bop';
import { loadTenant } from './prompt';

type ProposalRow = typeof proposals.$inferSelect;
type BatchRow = typeof proposalBatches.$inferSelect;

export class ApprovalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function proposalDto(p: ProposalRow): ProposalDto {
  return {
    id: p.id,
    runId: p.runId,
    batchId: p.batchId,
    tool: p.tool,
    args: p.args as Record<string, unknown>,
    argsHash: p.argsHash,
    originalArgs: (p.originalArgs as Record<string, unknown> | null) ?? null,
    preview: (p.preview as ProposalPreview | null) ?? null,
    risk: p.risk as ProposalDto['risk'],
    ruleId: p.ruleId,
    reasons: (p.reasons as string[]) ?? [],
    warnings: p.warnings,
    taint: (p.taint as TaintFinding[]) ?? [],
    status: p.status as ProposalDto['status'],
    decidedBy: p.decidedBy,
    decidedAt: p.decidedAt?.toISOString() ?? null,
    edited: p.edited,
    executedAt: p.executedAt?.toISOString() ?? null,
    executionResult: p.executionResult,
    externalApprovalId: p.externalApprovalId,
    expiresAt: p.expiresAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}

export function verifySignature(
  body: string,
  header: string | undefined,
  secret: string,
  toleranceSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (header === undefined) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts['t']);
  const v1 = parts['v1'];
  if (!Number.isFinite(t) || v1 === undefined) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeEdit(
  tool: string,
  current: Record<string, unknown>,
  edited: Record<string, unknown>,
): Record<string, unknown> {
  if (tool === 'send_email') {
    const to = Array.isArray(edited['to']) ? (edited['to'] as unknown[]).map(String) : (current['to'] as string[]);
    return {
      draftId: current['draftId'],
      to,
      subject: typeof edited['subject'] === 'string' ? edited['subject'] : current['subject'],
      body: typeof edited['body'] === 'string' ? edited['body'] : current['body'],
    };
  }
  const out: Record<string, unknown> = { ...current, ...edited };
  if ('id' in current) out['id'] = current['id'];
  delete out['idempotencyKey'];
  delete out['dryRun'];
  return out;
}

export interface ApprovalDeps {
  db: Db;
  bop: BopClient;
  auth: AuthService;
  publicUrl: string;
  consoleUrl: string;
  webhookSecret: string;
  enqueueContinue(runId: string, batchId: string): Promise<void>;
  checkEdit(
    runId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ decision: string; ruleId: string; reasons: string[] }>;
  onDecision?(info: {
    decision: 'approve' | 'reject' | 'expire';
    source: 'console' | 'inbox' | 'expiry';
    waitMs: number;
  }): void;
  onPublish?(count: number): void;
  now(): Date;
  logger: { warn(obj: unknown, msg?: string): void; info(obj: unknown, msg?: string): void };
}

export class ApprovalService implements ApprovalPublisher {
  constructor(private readonly deps: ApprovalDeps) {}

  private async serviceToken(tenantId: string, userId: string): Promise<string | null> {
    const tenant = await loadTenant(this.deps.db, tenantId);
    if (tenant.serviceTokenEnc !== null) return this.deps.auth.openSecret(tenant.serviceTokenEnc);
    const cred = await this.deps.auth.credential(tenantId, userId);
    if (cred !== null && cred.identity.scopes.includes('approvals:create')) return cred.token;
    return null;
  }

  async publish(runId: string, batch: BatchRecord): Promise<void> {
    const { db, bop } = this.deps;
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    if (run === undefined) return;
    const rows = await db
      .select()
      .from(proposals)
      .where(eq(proposals.batchId, batch.id))
      .orderBy(asc(proposals.stepSeq));
    this.deps.onPublish?.(rows.length);
    const token = await this.serviceToken(run.tenantId, run.userId);
    if (token === null) {
      this.deps.logger.warn(
        { runId, batchId: batch.id },
        'no token with approvals:create; batch is visible in the console only',
      );
      await db.update(proposalBatches).set({ publishedAt: this.deps.now() }).where(eq(proposalBatches.id, batch.id));
      return;
    }
    const tools = [...new Set(rows.map((r) => r.tool))]
      .map((t) => `${t} ×${rows.filter((r) => r.tool === t).length}`)
      .join(', ');
    try {
      const approval = await bop.createApproval(token, {
        title: `AI operator: ${rows.length} action${rows.length === 1 ? '' : 's'} need approval (${tools})`,
        details: {
          runId,
          batchId: batch.id,
          goal: run.goal,
          requestedFor: run.userName,
          consoleUrl: `${this.deps.consoleUrl}/#/runs/${runId}`,
          proposals: rows.map((r) => ({
            id: r.id,
            tool: r.tool,
            title: ((r.preview as ProposalPreview | null)?.title ?? r.tool).slice(0, 200),
            rule: r.ruleId,
            warnings: r.warnings,
          })),
        },
        assigneeRole: 'manager',
        expiresInSeconds: Math.max(
          60,
          Math.min(30 * 86400, Math.round((batch.expiresAt.getTime() - this.deps.now().getTime()) / 1000)),
        ),
        callbackUrl: `${this.deps.publicUrl}/approvals/callback`,
        idempotencyKey: `aio-batch-${batch.id}`,
        sourceRef: { system: 'ai-business-operator', runId, batchId: batch.id },
      });
      await db
        .update(proposalBatches)
        .set({ externalApprovalId: approval.id, publishedAt: this.deps.now() })
        .where(eq(proposalBatches.id, batch.id));
      await db.update(proposals).set({ externalApprovalId: approval.id }).where(eq(proposals.batchId, batch.id));
    } catch (error) {
      this.deps.logger.warn(
        { err: (error as Error).message, batchId: batch.id },
        'could not mirror approval to the business system inbox; will retry',
      );
    }
  }

  async list(tenantId: string, status: string | undefined): Promise<{ items: ProposalDto[]; batches: BatchDto[] }> {
    const { db } = this.deps;
    const where =
      status === undefined
        ? eq(proposals.tenantId, tenantId)
        : and(eq(proposals.tenantId, tenantId), eq(proposals.status, status));
    const rows = await db
      .select()
      .from(proposals)
      .where(where)
      .orderBy(desc(proposals.createdAt), asc(proposals.stepSeq))
      .limit(500);
    const batchIds = [...new Set(rows.map((r) => r.batchId))];
    const batches =
      batchIds.length === 0 ? [] : await db.select().from(proposalBatches).where(inArray(proposalBatches.id, batchIds));
    const runIds = [...new Set(batches.map((b) => b.runId))];
    const runs =
      runIds.length === 0
        ? []
        : await db
            .select({ id: agentRuns.id, goal: agentRuns.goal })
            .from(agentRuns)
            .where(inArray(agentRuns.id, runIds));
    const goals = new Map(runs.map((r) => [r.id, r.goal]));
    const items = rows.map(proposalDto);
    const dtos: BatchDto[] = batches
      .filter((b) => b.status !== 'collecting')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((b) =>
        this.batchDto(
          b,
          goals.get(b.runId) ?? '',
          items.filter((p) => p.batchId === b.id).sort((x, y) => x.createdAt.localeCompare(y.createdAt)),
        ),
      );
    return { items, batches: dtos };
  }

  batchDto(b: BatchRow, goal: string, items: ProposalDto[]): BatchDto {
    return {
      id: b.id,
      runId: b.runId,
      status: b.status === 'applied' ? 'decided' : (b.status as BatchDto['status']),
      externalApprovalId: b.externalApprovalId,
      createdAt: b.createdAt.toISOString(),
      expiresAt: b.expiresAt.toISOString(),
      decidedAt: b.decidedAt?.toISOString() ?? null,
      goal,
      proposals: items,
    };
  }

  async decide(
    identity: Identity,
    input: DecideInput & { decisions: Array<DecideInput['decisions'][number] & { expectedHash?: string }> },
  ): Promise<ProposalDto[]> {
    const { db } = this.deps;
    if (!identity.scopes.includes('approvals:decide'))
      throw new ApprovalError(403, 'You need the approvals:decide permission to approve agent actions');
    const ids = input.decisions.map((d) => d.id);
    const rows = await db
      .select()
      .from(proposals)
      .where(and(inArray(proposals.id, ids), eq(proposals.tenantId, identity.tenantId)));
    if (rows.length !== new Set(ids).size) throw new ApprovalError(404, 'Unknown proposal');
    const batchIds = [...new Set(rows.map((r) => r.batchId))];
    const batches = await db.select().from(proposalBatches).where(inArray(proposalBatches.id, batchIds));
    for (const b of batches) if (b.status !== 'pending') throw new ApprovalError(409, `Batch ${b.id} is ${b.status}`);
    const now = this.deps.now();
    for (const d of input.decisions) {
      const p = rows.find((r) => r.id === d.id) as ProposalRow;
      if (p.status !== 'pending') throw new ApprovalError(409, `Proposal ${p.id} is already ${p.status}`);
      if (d.expectedHash !== undefined && d.expectedHash !== p.argsHash)
        throw new ApprovalError(409, `Proposal ${p.id} changed since you reviewed it`);
      if (argsHash(p.tool, p.args as Record<string, unknown>) !== p.argsHash)
        throw new ApprovalError(409, `Proposal ${p.id} payload does not match its hash`);
      if (d.decision === 'reject') {
        await db
          .update(proposals)
          .set({ status: 'rejected', decidedBy: identity.userId, decidedAt: now, comment: d.comment ?? null })
          .where(and(eq(proposals.id, p.id), eq(proposals.status, 'pending')));
        continue;
      }
      if (d.editedArgs !== undefined) {
        const next = normalizeEdit(p.tool, p.args as Record<string, unknown>, d.editedArgs);
        const check = await this.deps.checkEdit(p.runId, p.tool, next);
        if (check.decision === 'deny')
          throw new ApprovalError(
            422,
            `The edited action is blocked by policy rule ${check.ruleId}: ${check.reasons.join('; ')}`,
          );
        const hash = argsHash(p.tool, next);
        await db
          .update(proposals)
          .set({
            status: 'approved',
            args: next,
            originalArgs: p.args,
            argsHash: hash,
            approvedHash: hash,
            edited: true,
            decidedBy: identity.userId,
            decidedAt: now,
            comment: d.comment ?? null,
          })
          .where(and(eq(proposals.id, p.id), eq(proposals.status, 'pending')));
      } else {
        await db
          .update(proposals)
          .set({
            status: 'approved',
            approvedHash: p.argsHash,
            decidedBy: identity.userId,
            decidedAt: now,
            comment: d.comment ?? null,
          })
          .where(and(eq(proposals.id, p.id), eq(proposals.status, 'pending')));
      }
    }
    for (const b of batches) await this.closeIfDecided(b, 'console', identity);
    const updated = await db.select().from(proposals).where(inArray(proposals.id, ids));
    for (const d of input.decisions) this.deps.onDecision?.({ decision: d.decision, source: 'console', waitMs: 0 });
    return updated.map(proposalDto);
  }

  private async closeIfDecided(
    batch: BatchRow,
    source: 'console' | 'inbox' | 'expiry',
    identity: Identity | null,
  ): Promise<void> {
    const { db } = this.deps;
    const pending = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(and(eq(proposals.batchId, batch.id), eq(proposals.status, 'pending')));
    if (pending.length > 0) return;
    const all = await db.select().from(proposals).where(eq(proposals.batchId, batch.id));
    const status = source === 'expiry' ? 'expired' : 'decided';
    const [closed] = await db
      .update(proposalBatches)
      .set({ status, decidedAt: this.deps.now() })
      .where(and(eq(proposalBatches.id, batch.id), eq(proposalBatches.status, 'pending')))
      .returning();
    if (closed === undefined) return;
    this.deps.onDecision?.({
      decision: source === 'expiry' ? 'expire' : 'approve',
      source,
      waitMs: this.deps.now().getTime() - batch.createdAt.getTime(),
    });
    if (source === 'console' && identity !== null && batch.externalApprovalId !== null) {
      const cred = await this.deps.auth.credential(identity.tenantId, identity.userId);
      const approved = all.filter((p) => p.status === 'approved').length;
      const rejected = all.filter((p) => p.status === 'rejected').length;
      const edited = all.filter((p) => p.edited).length;
      if (cred !== null)
        await this.deps.bop
          .decideApproval(
            cred.token,
            batch.externalApprovalId,
            approved > 0 ? 'approve' : 'reject',
            `Decided in the AI operator console: approved ${approved}, rejected ${rejected}, edited ${edited}.`,
          )
          .catch((error: unknown) =>
            this.deps.logger.info({ err: (error as Error).message }, 'external approval not updated'),
          );
    }
    await this.deps.enqueueContinue(batch.runId, batch.id);
  }

  async callback(
    body: string,
    signature: string | undefined,
    toleranceSec: number,
  ): Promise<{ handled: boolean; reason?: string }> {
    if (
      !verifySignature(
        body,
        signature,
        this.deps.webhookSecret,
        toleranceSec,
        Math.floor(this.deps.now().getTime() / 1000),
      ) &&
      !verifySignature(body, signature, this.deps.webhookSecret, toleranceSec)
    )
      throw new ApprovalError(401, 'invalid signature');
    const payload = JSON.parse(body) as ApprovalCallback;
    const { db } = this.deps;
    const [batch] = await db
      .select()
      .from(proposalBatches)
      .where(eq(proposalBatches.externalApprovalId, payload.approvalId));
    if (batch === undefined) return { handled: false, reason: 'unknown approval' };
    if (batch.status !== 'pending') return { handled: false, reason: `batch already ${batch.status}` };
    const now = this.deps.now();
    const decidedBy =
      payload.decidedBy !== null && payload.decidedBy !== undefined && /^[0-9a-f-]{36}$/.test(payload.decidedBy)
        ? payload.decidedBy
        : null;
    const pending = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.batchId, batch.id), eq(proposals.status, 'pending')));
    for (const p of pending) {
      if (payload.status === 'approved')
        await db
          .update(proposals)
          .set({
            status: 'approved',
            approvedHash: p.argsHash,
            decidedBy,
            decidedAt: now,
            comment: payload.comment ?? 'Approved in the business system inbox',
          })
          .where(and(eq(proposals.id, p.id), eq(proposals.status, 'pending')));
      else
        await db
          .update(proposals)
          .set({
            status: payload.status === 'rejected' ? 'rejected' : 'expired',
            decidedBy,
            decidedAt: now,
            comment: payload.comment ?? null,
          })
          .where(and(eq(proposals.id, p.id), eq(proposals.status, 'pending')));
    }
    await this.closeIfDecided(
      batch,
      payload.status === 'expired' || payload.status === 'cancelled' ? 'expiry' : 'inbox',
      null,
    );
    return { handled: true };
  }

  async expireDue(): Promise<number> {
    const { db } = this.deps;
    const now = this.deps.now();
    const due = await db
      .select()
      .from(proposalBatches)
      .where(and(eq(proposalBatches.status, 'pending'), lt(proposalBatches.expiresAt, now)));
    for (const b of due) {
      await db
        .update(proposals)
        .set({ status: 'expired', decidedAt: now })
        .where(and(eq(proposals.batchId, b.id), eq(proposals.status, 'pending')));
      await this.closeIfDecided(b, 'expiry', null);
    }
    return due.length;
  }

  async republishUnpublished(): Promise<number> {
    const { db } = this.deps;
    const rows = await db
      .select()
      .from(proposalBatches)
      .where(and(eq(proposalBatches.status, 'pending'), isNull(proposalBatches.publishedAt)));
    for (const b of rows)
      await this.publish(b.runId, {
        id: b.id,
        runId: b.runId,
        status: 'pending',
        expiresAt: b.expiresAt,
        externalApprovalId: b.externalApprovalId,
      });
    return rows.length;
  }

  async pollExternal(): Promise<number> {
    const { db, bop } = this.deps;
    const rows = await db.select().from(proposalBatches).where(eq(proposalBatches.status, 'pending'));
    let handled = 0;
    for (const b of rows) {
      if (b.externalApprovalId === null) continue;
      const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, b.runId));
      if (run === undefined) continue;
      const token = await this.serviceToken(run.tenantId, run.userId);
      if (token === null) continue;
      const approval = await bop.approval(token, b.externalApprovalId).catch(() => null);
      if (approval === null || approval.status === 'pending') continue;
      const body = JSON.stringify({
        type: 'approval.decided',
        approvalId: approval.id,
        status: approval.status,
        decidedBy: null,
        comment: null,
        sourceRef: {},
      });
      const t = Math.floor(this.deps.now().getTime() / 1000);
      const sig = `t=${t},v1=${createHmac('sha256', this.deps.webhookSecret).update(`${t}.${body}`).digest('hex')}`;
      const r = await this.callback(body, sig, 3600);
      if (r.handled) handled += 1;
    }
    return handled;
  }

  async decidedButNotApplied(): Promise<Array<{ runId: string; batchId: string }>> {
    const rows = await this.deps.db
      .select({ runId: proposalBatches.runId, batchId: proposalBatches.id })
      .from(proposalBatches)
      .where(inArray(proposalBatches.status, ['decided', 'expired']));
    return rows;
  }
}
