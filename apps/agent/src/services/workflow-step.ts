import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  buildWorkflowStepGoal,
  canonicalJson,
  parseWorkflowStepAnswer,
  workflowStepRequestSchema,
  type PolicyOverrides,
  type RunDto,
  type WorkflowStepRequest,
  type WorkflowStepResponse,
} from '@aio/contracts';
import type { AppContext } from '../context';
import { agentRuns, playbooks, workflowCalls } from '../db/schema';
import type { Identity } from './auth';
import type { PlaybookService } from './playbooks';
import { loadTenant } from './prompt';
import type { RunService } from './runs';

type CallRow = typeof workflowCalls.$inferSelect;

export class WorkflowStepError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

export const READ_ONLY_OVERRIDES: PolicyOverrides = {
  defaults: { write_reversible: 'deny', external: 'deny', irreversible: 'deny' },
  budget: { maxSteps: 4, maxToolCalls: 6, maxCostUsd: 0.05, maxWallClockMs: 60_000 },
};

export const TASK_OVERRIDES: PolicyOverrides = {
  budget: { maxSteps: 20, maxToolCalls: 50, maxCostUsd: 0.25, maxWallClockMs: 5 * 60_000 },
};

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function requestHash(req: WorkflowStepRequest): string {
  return createHash('sha256').update(canonicalJson(req)).digest('hex');
}

export function responseFor(
  req: WorkflowStepRequest,
  run: { id: string; status: string; summary: string | null },
): WorkflowStepResponse {
  if (req.task === 'run') {
    const waiting = run.status === 'awaiting_approval';
    const summary = (run.summary ?? '').trim();
    return {
      label: null,
      summary:
        `${summary}${waiting ? `${summary === '' ? '' : '\n'}Waiting for approval in the inbox (agent run ${run.id}).` : ''}`.slice(
          0,
          5000,
        ),
      confidence: 1,
      runId: run.id,
      status: run.status,
    };
  }
  return { ...parseWorkflowStepAnswer(req.task, req.labels, run.summary), runId: run.id, status: run.status };
}

export class WorkflowStepService {
  constructor(
    private readonly ctx: AppContext,
    private readonly runs: RunService,
    private readonly playbookService: PlaybookService,
  ) {}

  authorize(header: string | undefined): void {
    const expected = this.ctx.config.operatorToken;
    if (expected === null)
      throw new WorkflowStepError(404, 'Workflow steps are disabled: OPERATOR_TOKEN is not configured', 'disabled');
    const bearer = header !== undefined && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
    if (bearer === '' || !timingSafeEqual(digest(bearer), digest(expected)))
      throw new WorkflowStepError(401, 'Invalid operator token', 'unauthorized');
  }

  async handle(
    idempotencyKey: string | undefined,
    body: unknown,
  ): Promise<{ response: WorkflowStepResponse; replayed: boolean }> {
    const key = idempotencyKey?.trim() ?? '';
    if (key === '' || key.length > 300)
      throw new WorkflowStepError(
        400,
        'An Idempotency-Key header (at most 300 characters) is required',
        'idempotency_key',
      );
    const req = workflowStepRequestSchema.parse(body);
    if (req.context === null) throw new WorkflowStepError(422, 'context.tenantId is required', 'context');
    if (req.task === 'classify' && req.labels.length === 0)
      throw new WorkflowStepError(422, 'classify needs at least one label', 'labels');
    if (req.task !== 'run' && req.input.trim() === '') throw new WorkflowStepError(422, 'input is empty', 'input');
    if (req.task === 'run' && req.input.trim() === '' && req.playbookId === undefined)
      throw new WorkflowStepError(422, 'run needs an input goal or a playbookId', 'input');
    const tenantId = req.context.tenantId;
    const hash = requestHash(req);
    const deadline = Date.now() + this.ctx.config.workflowStepWaitMs;
    const [claimed] = await this.ctx.db
      .insert(workflowCalls)
      .values({
        tenantId,
        idempotencyKey: key,
        requestHash: hash,
        task: req.task,
        workflowId: req.context.workflowId ?? null,
        workflowRunId: req.context.runId ?? null,
        nodeId: req.context.nodeId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (claimed === undefined) {
      const [row] = await this.ctx.db
        .update(workflowCalls)
        .set({ attempts: sql`${workflowCalls.attempts} + 1`, updatedAt: new Date() })
        .where(and(eq(workflowCalls.tenantId, tenantId), eq(workflowCalls.idempotencyKey, key)))
        .returning();
      if (row === undefined) throw new WorkflowStepError(503, 'Retry the call', 'in_progress', 1);
      if (row.requestHash !== hash)
        throw new WorkflowStepError(
          422,
          'This Idempotency-Key was already used for a different request',
          'idempotency_mismatch',
        );
      if (row.status === 'done' && row.response !== null)
        return { response: row.response as WorkflowStepResponse, replayed: true };
      return { response: await this.settle(req, row, deadline), replayed: true };
    }
    let run: RunDto;
    try {
      run = await this.start(req, tenantId);
    } catch (error) {
      await this.release(tenantId, key);
      throw error;
    }
    const [row] = await this.ctx.db
      .update(workflowCalls)
      .set({ runId: run.id, status: 'running', updatedAt: new Date() })
      .where(and(eq(workflowCalls.tenantId, tenantId), eq(workflowCalls.idempotencyKey, key)))
      .returning();
    return { response: await this.settle(req, row as CallRow, deadline), replayed: false };
  }

  private async release(tenantId: string, key: string): Promise<void> {
    await this.ctx.db
      .delete(workflowCalls)
      .where(and(eq(workflowCalls.tenantId, tenantId), eq(workflowCalls.idempotencyKey, key)));
  }

  private async serviceIdentity(tenantId: string): Promise<Identity> {
    const tenant = await loadTenant(this.ctx.db, tenantId);
    if (tenant.serviceTokenEnc === null)
      throw new WorkflowStepError(
        409,
        'No service token is configured for this workspace in the AI operator settings',
        'no_service_token',
      );
    const identity = await this.ctx.auth.authenticate(`Bearer ${this.ctx.auth.openSecret(tenant.serviceTokenEnc)}`);
    if (identity.tenantId !== tenantId)
      throw new WorkflowStepError(403, 'The service token belongs to another workspace', 'tenant_mismatch');
    return identity;
  }

  private async start(req: WorkflowStepRequest, tenantId: string): Promise<RunDto> {
    const workflow = {
      task: req.task,
      ...(req.context?.workflowId !== undefined ? { workflowId: req.context.workflowId } : {}),
      ...(req.context?.runId !== undefined ? { runId: req.context.runId } : {}),
      ...(req.context?.nodeId !== undefined ? { nodeId: req.context.nodeId } : {}),
    };
    if (req.task === 'run' && req.playbookId !== undefined) {
      const [pb] = await this.ctx.db
        .select({ id: playbooks.id })
        .from(playbooks)
        .where(and(eq(playbooks.id, req.playbookId), eq(playbooks.tenantId, tenantId)));
      if (pb === undefined) throw new WorkflowStepError(404, 'Playbook not found', 'playbook');
      const run = await this.playbookService.trigger(pb.id, 'manual', workflow);
      if (run === null) throw new WorkflowStepError(409, 'Playbook could not be started', 'playbook');
      return run;
    }
    const identity = await this.serviceIdentity(tenantId);
    const goal = req.task === 'run' ? req.input.trim() : buildWorkflowStepGoal(req.task, req.input, req.labels);
    const run = await this.runs.create(
      identity,
      { goal },
      {
        source: 'workflow',
        policyOverrides: req.task === 'run' ? TASK_OVERRIDES : READ_ONLY_OVERRIDES,
        workflow,
      },
    );
    await this.runs.start(run.id);
    return run;
  }

  private async settle(req: WorkflowStepRequest, call: CallRow, deadline: number): Promise<WorkflowStepResponse> {
    let runId = call.runId;
    while (Date.now() < deadline) {
      if (runId === null) {
        const [fresh] = await this.ctx.db
          .select({ runId: workflowCalls.runId })
          .from(workflowCalls)
          .where(and(eq(workflowCalls.tenantId, call.tenantId), eq(workflowCalls.idempotencyKey, call.idempotencyKey)));
        if (fresh === undefined) throw new WorkflowStepError(503, 'The first attempt failed; retry', 'retry', 1);
        runId = fresh.runId;
      }
      if (runId !== null) {
        const [run] = await this.ctx.db
          .select({ id: agentRuns.id, status: agentRuns.status, summary: agentRuns.summary, error: agentRuns.error })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId));
        if (run === undefined) {
          await this.release(call.tenantId, call.idempotencyKey);
          throw new WorkflowStepError(503, 'The agent run disappeared; retry', 'retry', 1);
        }
        if (run.status === 'failed' || run.status === 'cancelled') {
          await this.release(call.tenantId, call.idempotencyKey);
          if (run.status === 'cancelled')
            throw new WorkflowStepError(409, `Agent run ${run.id} was cancelled`, 'run_cancelled');
          throw new WorkflowStepError(502, `Agent run ${run.id} failed: ${run.error ?? 'unknown error'}`, 'run_failed');
        }
        if (run.status === 'completed' || (req.task === 'run' && run.status === 'awaiting_approval')) {
          const response = responseFor(req, run);
          await this.ctx.db
            .update(workflowCalls)
            .set({ status: 'done', response, updatedAt: new Date() })
            .where(
              and(eq(workflowCalls.tenantId, call.tenantId), eq(workflowCalls.idempotencyKey, call.idempotencyKey)),
            );
          return response;
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new WorkflowStepError(
      503,
      `${runId === null ? 'The agent run' : `Agent run ${runId}`} is still in progress; retry with the same Idempotency-Key`,
      'in_progress',
      2,
    );
  }
}
