import type { AppContext } from '../context';
import { RunExecutor } from '../runtime/executor';
import { ApprovalService } from './approvals';
import { PlaybookService, type PlaybookScheduler } from './playbooks';
import { RunService } from './runs';
import { WorkflowStepService } from './workflow-step';

export interface Services {
  runs: RunService;
  executor: RunExecutor;
  approvals: ApprovalService;
  playbooks: PlaybookService;
  workflowSteps: WorkflowStepService;
}

export function createServices(ctx: AppContext, scheduler: PlaybookScheduler | null): Services {
  const executor = new RunExecutor(ctx);
  const approvals = new ApprovalService({
    db: ctx.db,
    bop: ctx.bop,
    auth: ctx.auth,
    publicUrl: ctx.config.publicUrl,
    consoleUrl: ctx.config.consoleUrl,
    webhookSecret: ctx.config.bopWebhookSecret,
    enqueueContinue: (runId, batchId) => ctx.dispatcher.dispatch({ type: 'continue', runId, batchId }),
    checkEdit: (runId, tool, args) => executor.checkEdit(runId, tool, args),
    onDecision: (info) => {
      ctx.metrics.approvalDecisions.inc({ decision: info.decision, source: info.source });
      if (info.waitMs > 0) ctx.metrics.approvalWait.observe({ source: info.source }, info.waitMs / 1000);
    },
    now: () => ctx.clock.now(),
    logger: ctx.logger,
  });
  ctx.approvals = approvals;
  const runs = new RunService(ctx);
  const playbooks = new PlaybookService(ctx, runs, scheduler);
  return { runs, executor, approvals, playbooks, workflowSteps: new WorkflowStepService(ctx, runs, playbooks) };
}
