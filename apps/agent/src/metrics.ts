import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export class Metrics {
  readonly registry = new Registry();
  readonly runsStarted: Counter<'source'>;
  readonly runsFinished: Counter<'status' | 'stop_reason'>;
  readonly runsActive: Gauge<'status'>;
  readonly llmCalls: Counter<'model' | 'provider' | 'outcome'>;
  readonly llmTokens: Counter<'model' | 'direction'>;
  readonly llmCost: Counter<'model'>;
  readonly llmLatency: Histogram<'model'>;
  readonly toolCalls: Counter<'tool' | 'decision' | 'outcome'>;
  readonly blocked: Counter<'rule' | 'tool'>;
  readonly proposals: Counter<'tool'>;
  readonly approvalDecisions: Counter<'decision' | 'source'>;
  readonly approvalWait: Histogram<'source'>;
  readonly resumes: Counter<'reason'>;
  readonly costPerRun: Histogram;

  constructor(withDefaults = true) {
    if (withDefaults) collectDefaultMetrics({ register: this.registry, prefix: 'aio_' });
    const r = [this.registry];
    this.runsStarted = new Counter({
      name: 'aio_runs_started_total',
      help: 'Agent runs started',
      labelNames: ['source'],
      registers: r,
    });
    this.runsFinished = new Counter({
      name: 'aio_runs_finished_total',
      help: 'Agent runs finished',
      labelNames: ['status', 'stop_reason'],
      registers: r,
    });
    this.runsActive = new Gauge({
      name: 'aio_runs_active',
      help: 'Runs by non-terminal status',
      labelNames: ['status'],
      registers: r,
    });
    this.llmCalls = new Counter({
      name: 'aio_llm_calls_total',
      help: 'LLM calls',
      labelNames: ['model', 'provider', 'outcome'],
      registers: r,
    });
    this.llmTokens = new Counter({
      name: 'aio_llm_tokens_total',
      help: 'LLM tokens',
      labelNames: ['model', 'direction'],
      registers: r,
    });
    this.llmCost = new Counter({
      name: 'aio_llm_cost_usd_total',
      help: 'LLM cost in USD',
      labelNames: ['model'],
      registers: r,
    });
    this.llmLatency = new Histogram({
      name: 'aio_llm_latency_seconds',
      help: 'LLM call latency',
      labelNames: ['model'],
      buckets: [0.25, 0.5, 1, 2, 5, 10, 30, 60],
      registers: r,
    });
    this.toolCalls = new Counter({
      name: 'aio_tool_calls_total',
      help: 'Tool calls by policy decision',
      labelNames: ['tool', 'decision', 'outcome'],
      registers: r,
    });
    this.blocked = new Counter({
      name: 'aio_policy_blocked_total',
      help: 'Actions blocked by policy',
      labelNames: ['rule', 'tool'],
      registers: r,
    });
    this.proposals = new Counter({
      name: 'aio_proposals_total',
      help: 'Proposals created for approval',
      labelNames: ['tool'],
      registers: r,
    });
    this.approvalDecisions = new Counter({
      name: 'aio_approval_decisions_total',
      help: 'Approval decisions',
      labelNames: ['decision', 'source'],
      registers: r,
    });
    this.approvalWait = new Histogram({
      name: 'aio_approval_wait_seconds',
      help: 'Time from approval request to decision',
      labelNames: ['source'],
      buckets: [10, 60, 300, 900, 3600, 4 * 3600, 24 * 3600, 72 * 3600],
      registers: r,
    });
    this.resumes = new Counter({
      name: 'aio_run_resumes_total',
      help: 'Runs resumed',
      labelNames: ['reason'],
      registers: r,
    });
    this.costPerRun = new Histogram({
      name: 'aio_run_cost_usd',
      help: 'Cost per finished run',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1],
      registers: r,
    });
  }
}
