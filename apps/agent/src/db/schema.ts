import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    userName: text('user_name'),
    playbookId: uuid('playbook_id'),
    goal: text('goal').notNull(),
    status: text('status').notNull().default('queued'),
    stopReason: text('stop_reason'),
    policyVersion: integer('policy_version').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    model: text('model').notNull(),
    budget: jsonb('budget').notNull(),
    usage: jsonb('usage').notNull(),
    context: jsonb('context'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: ts('lease_expires_at'),
    attempts: integer('attempts').notNull().default(0),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    systemPrompt: text('system_prompt'),
    tools: jsonb('tools'),
    hiddenTools: jsonb('hidden_tools'),
    promptNow: text('prompt_now'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    summary: text('summary'),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('agent_runs_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('agent_runs_status_lease_idx').on(t.status, t.leaseExpiresAt),
    index('agent_runs_playbook_idx').on(t.playbookId),
  ],
);

export const agentMessages = pgTable(
  'agent_messages',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').notNull(),
    content: jsonb('content').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_messages_run_seq_uq').on(t.runId, t.seq)],
);

export const agentSteps = pgTable(
  'agent_steps',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('done'),
    tool: text('tool'),
    toolUseId: text('tool_use_id'),
    args: jsonb('args'),
    result: jsonb('result'),
    policyDecision: jsonb('policy_decision'),
    taint: jsonb('taint'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    idempotencyKey: text('idempotency_key'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_steps_run_seq_uq').on(t.runId, t.seq),
    index('agent_steps_tool_use_idx').on(t.runId, t.toolUseId),
  ],
);

export const proposalBatches = pgTable(
  'proposal_batches',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull(),
    status: text('status').notNull().default('collecting'),
    expiresAt: ts('expires_at').notNull(),
    externalApprovalId: uuid('external_approval_id'),
    publishedAt: ts('published_at'),
    decidedAt: ts('decided_at'),
    appliedAt: ts('applied_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('proposal_batches_status_idx').on(t.status, t.expiresAt),
    index('proposal_batches_run_idx').on(t.runId),
  ],
);

export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => proposalBatches.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull(),
    tool: text('tool').notNull(),
    args: jsonb('args').notNull(),
    argsHash: text('args_hash').notNull(),
    approvedHash: text('approved_hash'),
    originalArgs: jsonb('original_args'),
    preview: jsonb('preview'),
    risk: text('risk').notNull(),
    ruleId: text('rule_id').notNull(),
    reasons: jsonb('reasons')
      .notNull()
      .default(sql`'[]'::jsonb`),
    warnings: text('warnings')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    taint: jsonb('taint')
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('pending'),
    decidedBy: uuid('decided_by'),
    decidedAt: ts('decided_at'),
    comment: text('comment'),
    edited: boolean('edited').notNull().default(false),
    executedAt: ts('executed_at'),
    executionResult: jsonb('execution_result'),
    externalApprovalId: uuid('external_approval_id'),
    toolUseId: text('tool_use_id').notNull(),
    stepSeq: integer('step_seq').notNull(),
    expiresAt: ts('expires_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('proposals_run_tool_use_uq').on(t.runId, t.toolUseId),
    index('proposals_tenant_status_idx').on(t.tenantId, t.status),
    index('proposals_batch_idx').on(t.batchId),
  ],
);

export const policies = pgTable(
  'policies',
  {
    tenantId: uuid('tenant_id').notNull(),
    version: integer('version').notNull(),
    document: jsonb('document').notNull(),
    source: text('source').notNull(),
    createdBy: uuid('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.version] })],
);

export const playbooks = pgTable(
  'playbooks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    name: text('name').notNull(),
    instructions: text('instructions').notNull(),
    schedule: text('schedule'),
    timezone: text('timezone').notNull().default('UTC'),
    enabled: boolean('enabled').notNull().default(true),
    policyOverrides: jsonb('policy_overrides')
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastRunAt: ts('last_run_at'),
    nextRunAt: ts('next_run_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('playbooks_tenant_idx').on(t.tenantId)],
);

export const untrustedSpans = pgTable(
  'untrusted_spans',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id').notNull(),
    stepSeq: integer('step_seq'),
    tool: text('tool').notNull(),
    path: text('path').notNull(),
    textHash: text('text_hash').notNull(),
    text: text('text').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('untrusted_spans_uq').on(t.runId, t.textHash, t.path)],
);

export const interventions = pgTable(
  'interventions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    createdBy: uuid('created_by'),
    appliedAt: ts('applied_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('interventions_run_idx').on(t.runId)],
);

export const userCredentials = pgTable(
  'user_credentials',
  {
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    scopes: jsonb('scopes').notNull(),
    tokenEnc: text('token_enc').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const tenantSettings = pgTable('tenant_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  name: text('name').notNull(),
  instructions: text('instructions').notNull().default(''),
  domain: text('domain').notNull().default(''),
  timezone: text('timezone').notNull().default('UTC'),
  serviceTokenEnc: text('service_token_enc'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const workflowCalls = pgTable(
  'workflow_calls',
  {
    tenantId: uuid('tenant_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    task: text('task').notNull(),
    runId: uuid('run_id'),
    status: text('status').notNull().default('pending'),
    response: jsonb('response'),
    workflowId: text('workflow_id'),
    workflowRunId: text('workflow_run_id'),
    nodeId: text('node_id'),
    attempts: integer('attempts').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.idempotencyKey] }), index('workflow_calls_run_idx').on(t.runId)],
);

export const evalRuns = pgTable('eval_runs', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  mode: text('mode').notNull(),
  models: jsonb('models').notNull(),
  scenarioCount: integer('scenario_count').notNull(),
  passed: integer('passed').notNull(),
  failed: integer('failed').notNull(),
  violations: integer('violations').notNull(),
  injectionSuccess: integer('injection_success').notNull(),
  gatesPassed: boolean('gates_passed').notNull(),
  avgSteps: doublePrecision('avg_steps').notNull(),
  avgCostUsd: doublePrecision('avg_cost_usd').notNull(),
  reportPath: text('report_path'),
  reportMd: text('report_md'),
  summary: jsonb('summary'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const evalResults = pgTable(
  'eval_results',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    evalRunId: uuid('eval_run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    scenarioId: text('scenario_id').notNull(),
    category: text('category').notNull(),
    model: text('model').notNull(),
    passed: boolean('passed').notNull(),
    violations: integer('violations').notNull(),
    injectionSuccess: boolean('injection_success').notNull(),
    steps: integer('steps').notNull(),
    toolCalls: integer('tool_calls').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costUsd: doublePrecision('cost_usd').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    firstTokenMs: integer('first_token_ms'),
    judgeScore: doublePrecision('judge_score'),
    failures: jsonb('failures').notNull(),
    trajectory: jsonb('trajectory').notNull(),
    agentRunId: uuid('agent_run_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('eval_results_run_idx').on(t.evalRunId)],
);
