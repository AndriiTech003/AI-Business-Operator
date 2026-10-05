import type {
  Budget,
  ChatMessage,
  PolicyDecision,
  ProposalPreview,
  ProposalStatus,
  Risk,
  RunContext,
  RunEvent,
  RunStatus,
  StepKind,
  StopReason,
  TaintFinding,
  ToolDescriptor,
  Usage,
} from '@aio/contracts';
import type { LlmProvider, PriceTable } from '@aio/llm';
import type { UntrustedSpan } from '@aio/taint';

export interface HiddenToolInfo {
  tool: string;
  ruleId: string;
  reason: string;
}

export interface RunState {
  id: string;
  tenantId: string;
  userId: string;
  goal: string;
  status: RunStatus;
  stopReason: StopReason | null;
  model: string;
  budget: Budget;
  usage: Usage;
  policyVersion: number;
  context: RunContext | null;
  startedAt: Date | null;
  createdAt: Date;
  systemPrompt: string | null;
  tools: ToolDescriptor[] | null;
  hiddenTools: HiddenToolInfo[] | null;
  promptNow: string | null;
}

export type RunPatch = Partial<
  Pick<
    RunState,
    'status' | 'stopReason' | 'usage' | 'startedAt' | 'systemPrompt' | 'tools' | 'hiddenTools' | 'promptNow'
  >
> & { summary?: string | null; error?: string | null; finishedAt?: Date | null };

export interface StepRecord {
  id: string;
  runId: string;
  seq: number;
  kind: StepKind;
  status: 'pending' | 'done';
  tool: string | null;
  toolUseId: string | null;
  args: unknown;
  result: unknown;
  policyDecision: PolicyDecision | null;
  taint: TaintFinding[] | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  idempotencyKey: string | null;
  createdAt: Date;
}

export interface NewStep {
  kind: StepKind;
  status?: 'pending' | 'done';
  tool?: string | null;
  toolUseId?: string | null;
  args?: unknown;
  result?: unknown;
  policyDecision?: PolicyDecision | null;
  taint?: TaintFinding[] | null;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  latencyMs?: number;
  idempotencyKey?: string | null;
}

export interface ProposalRecord {
  id: string;
  runId: string;
  batchId: string;
  tool: string;
  args: Record<string, unknown>;
  argsHash: string;
  approvedHash: string | null;
  originalArgs: Record<string, unknown> | null;
  status: ProposalStatus;
  edited: boolean;
  risk: Risk;
  ruleId: string;
  toolUseId: string | null;
  decidedBy: string | null;
  comment: string | null;
  executionResult: unknown;
}

export interface NewProposal {
  runId: string;
  batchId: string;
  tool: string;
  args: Record<string, unknown>;
  argsHash: string;
  preview: ProposalPreview | null;
  risk: Risk;
  ruleId: string;
  reasons: string[];
  warnings: string[];
  taint: TaintFinding[];
  toolUseId: string;
  stepSeq: number;
  expiresAt: Date;
}

export interface BatchRecord {
  id: string;
  runId: string;
  status: 'collecting' | 'pending' | 'decided' | 'expired' | 'cancelled' | 'applied';
  expiresAt: Date;
  externalApprovalId: string | null;
}

export interface RunStore {
  getRun(runId: string): Promise<RunState>;
  updateRun(runId: string, patch: RunPatch): Promise<void>;
  loadMessages(runId: string): Promise<ChatMessage[]>;
  appendMessage(runId: string, message: ChatMessage): Promise<void>;
  createStep(runId: string, step: NewStep): Promise<StepRecord>;
  updateStep(stepId: string, patch: NewStep): Promise<StepRecord>;
  listSteps(runId: string): Promise<StepRecord[]>;
  findStepByToolUse(runId: string, toolUseId: string): Promise<StepRecord | null>;
  takeInterventions(runId: string): Promise<string[]>;
  saveSpans(runId: string, stepId: string, spans: UntrustedSpan[]): Promise<void>;
  loadSpans(runId: string): Promise<UntrustedSpan[]>;
  openBatch(runId: string, expiresAt: Date): Promise<BatchRecord>;
  sealBatch(runId: string): Promise<BatchRecord | null>;
  getBatch(batchId: string): Promise<BatchRecord>;
  createProposal(proposal: NewProposal): Promise<ProposalRecord>;
  listBatchProposals(batchId: string): Promise<ProposalRecord[]>;
  markProposal(
    proposalId: string,
    patch: { status: ProposalStatus; executionResult?: unknown; executedAt?: Date | null },
  ): Promise<void>;
  applyBatch(batchId: string, message: ChatMessage): Promise<boolean>;
  isCancelRequested(runId: string): Promise<boolean>;
}

export interface ToolCallOutcome {
  ok: boolean;
  payload: Record<string, unknown> | null;
  untrusted: string[];
  errorMessage: string | null;
  status: number | null;
  latencyMs: number;
}

export interface ToolCallOptions {
  idempotencyKey?: string;
  dryRun?: boolean;
}

export interface ToolGateway {
  listTools(): Promise<ToolDescriptor[]>;
  call(name: string, args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallOutcome>;
}

export interface PolicyEvaluationInput {
  tool: ToolDescriptor;
  args: Record<string, unknown>;
  usage: Usage;
}

export interface PolicyGateway {
  readonly version: number;
  visibility(tools: ToolDescriptor[]): { visible: ToolDescriptor[]; hidden: HiddenToolInfo[] };
  approvalSummary(): string[];
  approvalTtlMs(): number;
  evaluate(input: PolicyEvaluationInput): Promise<PolicyDecision & { context?: unknown }>;
}

export interface ResolvedAction {
  view: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export interface ActionResolver {
  resolve(tool: string, args: Record<string, unknown>): Promise<ResolvedAction>;
  preview(tool: string, payload: Record<string, unknown>, dryRun: ToolCallOutcome | null): Promise<ProposalPreview>;
  executeApproved(proposal: ProposalRecord): Promise<ToolCallOutcome>;
}

export interface ApprovalPublisher {
  publish(runId: string, batch: BatchRecord): Promise<void>;
}

export interface PromptContextProvider {
  build(run: RunState, visible: ToolDescriptor[], hidden: HiddenToolInfo[], approvalSummary: string[]): Promise<string>;
}

export interface EventSink {
  emit(event: RunEvent): void;
}

export interface Clock {
  now(): Date;
}

export interface Telemetry {
  llmCall?(info: {
    runId: string;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
    stopReason: string;
    error?: string;
  }): void;
  toolCall?(info: {
    runId: string;
    tool: string;
    decision: string;
    ruleId: string;
    latencyMs: number;
    ok: boolean;
    toolUseId: string;
  }): void;
  span?<T>(name: string, attributes: Record<string, string | number | boolean>, fn: () => Promise<T>): Promise<T>;
}

export interface AgentPorts {
  store: RunStore;
  tools: ToolGateway;
  policy: PolicyGateway;
  resolver: ActionResolver;
  approvals: ApprovalPublisher;
  prompt: PromptContextProvider;
  events: EventSink;
  clock: Clock;
  llm: LlmProvider;
  prices: PriceTable;
  telemetry?: Telemetry;
  scenarioId?: string;
}

export interface AgentOptions {
  maxOutputTokens: number;
  maxToolResultTokens: number;
  compaction: { maxContextTokens: number; targetRatio: number; keepRecentMessages: number };
  llmRetries: number;
  delayAfterEffectMs: number;
  taintCheck: boolean;
}

export const DEFAULT_AGENT_OPTIONS: AgentOptions = {
  maxOutputTokens: 8000,
  maxToolResultTokens: 6000,
  compaction: { maxContextTokens: 60_000, targetRatio: 0.6, keepRecentMessages: 4 },
  llmRetries: 2,
  delayAfterEffectMs: 0,
  taintCheck: true,
};
