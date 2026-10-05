export const RISKS = ['read', 'write_reversible', 'external', 'irreversible'] as const;
export type Risk = (typeof RISKS)[number];

export const DECISIONS = ['allow', 'require_approval', 'deny'] as const;
export type Decision = (typeof DECISIONS)[number];

export const DECISION_RANK: Record<Decision, number> = { allow: 0, require_approval: 1, deny: 2 };

export function strictest(a: Decision, b: Decision): Decision {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

export interface MatchedRule {
  id: string;
  then: Decision;
  reason: string | null;
}

export type TaintKind = 'email' | 'url' | 'number' | 'substring';

export interface TaintSource {
  tool: string;
  path: string;
  stepSeq: number | null;
}

export interface TaintFinding {
  argPath: string;
  fragment: string;
  kind: TaintKind;
  source: TaintSource;
  sourceText: string;
  start: number;
  end: number;
}

export interface PolicyDecision {
  decision: Decision;
  ruleId: string;
  reasons: string[];
  matchedRules: MatchedRule[];
  warnings: string[];
  policyVersion: number;
  taint: TaintFinding[];
}

export interface Budget {
  maxSteps: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxCostUsd: number;
  maxWallClockMs: number;
  maxExternalActions: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxSteps: 40,
  maxToolCalls: 100,
  maxInputTokens: 2_000_000,
  maxCostUsd: 0.5,
  maxWallClockMs: 10 * 60 * 1000,
  maxExternalActions: 50,
};

export interface Usage {
  steps: number;
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallClockMs: number;
  externalActions: number;
  writeCount: number;
  emailsSent: number;
  firstTokenMs: number | null;
}

export function emptyUsage(): Usage {
  return {
    steps: 0,
    llmCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    wallClockMs: 0,
    externalActions: 0,
    writeCount: 0,
    emailsSent: 0,
    firstTokenMs: null,
  };
}

export const RUN_STATUSES = ['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

export const STOP_REASONS = ['end_turn', 'budget', 'cancelled', 'error', 'needs_input'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const STEP_KINDS = [
  'llm_call',
  'tool_call',
  'proposal',
  'approval',
  'intervention',
  'budget',
  'compaction',
  'visibility',
  'error',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const PROPOSAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'executed',
  'failed',
  'cancelled',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  risk: Risk;
  inputSchema: Record<string, unknown>;
}

export interface StepDto {
  id: string;
  runId: string;
  seq: number;
  kind: StepKind;
  tool: string | null;
  args: unknown;
  result: unknown;
  policyDecision: PolicyDecision | null;
  taint: TaintFinding[] | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface ProposalPreview {
  kind: 'email' | 'diff' | 'invoice' | 'generic';
  title: string;
  email?: { to: string[]; subject: string; html: string; text: string };
  diff?: Array<{ field: string; from: unknown; to: unknown }>;
  record?: { type: string; id: string; label: string };
  raw?: unknown;
}

export interface ProposalDto {
  id: string;
  runId: string;
  batchId: string;
  tool: string;
  args: Record<string, unknown>;
  argsHash: string;
  originalArgs: Record<string, unknown> | null;
  preview: ProposalPreview | null;
  risk: Risk;
  ruleId: string;
  reasons: string[];
  warnings: string[];
  taint: TaintFinding[];
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  edited: boolean;
  executedAt: string | null;
  executionResult: unknown;
  externalApprovalId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface BatchDto {
  id: string;
  runId: string;
  status: 'pending' | 'decided' | 'expired' | 'cancelled';
  externalApprovalId: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  goal: string;
  proposals: ProposalDto[];
}

export interface RunDto {
  id: string;
  tenantId: string;
  userId: string;
  userName: string | null;
  playbookId: string | null;
  goal: string;
  status: RunStatus;
  stopReason: StopReason | null;
  policyVersion: number;
  promptVersion: number;
  model: string;
  budget: Budget;
  usage: Usage;
  context: RunContext | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  summary: string | null;
  error: string | null;
  pendingProposals: number;
}

export interface RunContext {
  record?: { type: 'company' | 'contact' | 'deal' | 'invoice'; id: string; label?: string };
  source?: 'console' | 'embed' | 'playbook' | 'eval' | 'api' | 'workflow';
  workflow?: { workflowId?: string; runId?: string; nodeId?: string; task: 'classify' | 'summarize' | 'run' };
}

export interface MessageDto {
  seq: number;
  role: 'user' | 'assistant';
  content: unknown;
  createdAt: string;
}

export interface RunDetailDto extends RunDto {
  steps: StepDto[];
  proposals: ProposalDto[];
  messages: MessageDto[];
}

export interface PlaybookDto {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  instructions: string;
  schedule: string | null;
  timezone: string;
  enabled: boolean;
  policyOverrides: PolicyOverrides;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  monthCostUsd: number;
  runCount: number;
}

export interface PolicyOverrides {
  budget?: Partial<Budget>;
  defaults?: Partial<Record<Risk, Decision>>;
}

export interface UsageRow {
  key: string;
  label: string;
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageReport {
  from: string;
  to: string;
  totalCostUsd: number;
  totalRuns: number;
  byDay: UsageRow[];
  byUser: UsageRow[];
  byPlaybook: UsageRow[];
  byModel: UsageRow[];
}

export interface EvalRunDto {
  id: string;
  createdAt: string;
  mode: 'replay' | 'record' | 'live';
  models: string[];
  scenarioCount: number;
  passed: number;
  failed: number;
  violations: number;
  injectionSuccess: number;
  gatesPassed: boolean;
  avgSteps: number;
  avgCostUsd: number;
  reportPath: string | null;
}

export interface EvalResultDto {
  id: string;
  evalRunId: string;
  scenarioId: string;
  category: string;
  model: string;
  passed: boolean;
  violations: number;
  injectionSuccess: boolean;
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  firstTokenMs: number | null;
  judgeScore: number | null;
  failures: string[];
  trajectory: unknown;
  agentRunId: string | null;
}

export interface EvalRunDetailDto extends EvalRunDto {
  results: EvalResultDto[];
  report: string | null;
}

export interface MeDto {
  userId: string;
  tenantId: string;
  name: string;
  email: string;
  role: string;
  scopes: string[];
  tenantName: string;
}
