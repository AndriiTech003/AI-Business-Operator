import {
  parseSseChunk,
  RUN_EVENT_TYPES,
  type PolicyDecision,
  type ProposalDto,
  type RunDetailDto,
  type RunEvent,
  type RunStatus,
  type StepDto,
  type StopReason,
  type Usage,
} from '@aio/contracts';

export interface TimelineState {
  runId: string | null;
  status: RunStatus | null;
  stopReason: StopReason | null;
  steps: StepDto[];
  decisions: Record<number, PolicyDecision>;
  proposals: ProposalDto[];
  usage: Usage | null;
  streamingText: string;
  summary: string | null;
  done: boolean;
  eventCount: number;
}

export function emptyTimeline(runId: string | null = null): TimelineState {
  return {
    runId,
    status: null,
    stopReason: null,
    steps: [],
    decisions: {},
    proposals: [],
    usage: null,
    streamingText: '',
    summary: null,
    done: false,
    eventCount: 0,
  };
}

function hasResult(step: StepDto): boolean {
  return step.result !== null && step.result !== undefined;
}

export function upsertStep(steps: StepDto[], step: StepDto): StepDto[] {
  const idx = steps.findIndex((s) => s.id === step.id || s.seq === step.seq);
  if (idx < 0) return [...steps, step].sort((a, b) => a.seq - b.seq);
  const current = steps[idx] as StepDto;
  if (hasResult(current) && !hasResult(step) && current.kind === step.kind) return steps;
  const next = steps.slice();
  next[idx] = step;
  return next;
}

export function upsertProposal(proposals: ProposalDto[], proposal: ProposalDto): ProposalDto[] {
  const idx = proposals.findIndex((p) => p.id === proposal.id);
  if (idx < 0) return [...proposals, proposal];
  const next = proposals.slice();
  next[idx] = proposal;
  return next;
}

export function applyRunEvent(state: TimelineState, event: RunEvent): TimelineState {
  const base: TimelineState = { ...state, runId: state.runId ?? event.runId, eventCount: state.eventCount + 1 };
  switch (event.type) {
    case 'text':
      return { ...base, streamingText: base.streamingText + event.delta };
    case 'tool_call':
    case 'tool_result':
    case 'step': {
      const steps = upsertStep(base.steps, event.step);
      return { ...base, steps, streamingText: event.step.kind === 'llm_call' ? '' : base.streamingText };
    }
    case 'policy':
      return { ...base, decisions: { ...base.decisions, [event.seq]: event.decision } };
    case 'proposal':
      return { ...base, proposals: upsertProposal(base.proposals, event.proposal) };
    case 'status':
      return { ...base, status: event.status, stopReason: event.stopReason };
    case 'usage':
      return { ...base, usage: event.usage };
    case 'done':
      return {
        ...base,
        status: event.status,
        stopReason: event.stopReason,
        summary: event.summary ?? base.summary,
        streamingText: '',
        done: true,
      };
  }
}

export function timelineFromDetail(detail: RunDetailDto): TimelineState {
  const decisions: Record<number, PolicyDecision> = {};
  for (const s of detail.steps) if (s.policyDecision !== null) decisions[s.seq] = s.policyDecision;
  return {
    runId: detail.id,
    status: detail.status,
    stopReason: detail.stopReason,
    steps: [...detail.steps].sort((a, b) => a.seq - b.seq),
    decisions,
    proposals: detail.proposals,
    usage: detail.usage,
    streamingText: '',
    summary: detail.summary,
    done: ['completed', 'failed', 'cancelled'].includes(detail.status),
    eventCount: 0,
  };
}

export function mergeTimelines(
  server: TimelineState | null,
  live: TimelineState | null,
  liveActive: boolean,
): TimelineState {
  if (server === null && live === null) return emptyTimeline();
  if (server === null) return live as TimelineState;
  if (live === null) return server;
  let steps = server.steps;
  for (const s of live.steps) steps = upsertStep(steps, s);
  let proposals = server.proposals;
  for (const p of live.proposals) if (!proposals.some((x) => x.id === p.id)) proposals = [...proposals, p];
  const preferLive = liveActive && live.status !== null;
  const serverCost = server.usage?.costUsd ?? 0;
  const liveCost = live.usage?.costUsd ?? 0;
  return {
    runId: server.runId ?? live.runId,
    status: preferLive ? live.status : server.status,
    stopReason: preferLive ? live.stopReason : server.stopReason,
    steps,
    decisions: { ...server.decisions, ...live.decisions },
    proposals,
    usage: liveCost > serverCost ? live.usage : server.usage,
    streamingText: liveActive ? live.streamingText : '',
    summary: server.summary ?? live.summary,
    done: preferLive ? live.done : server.done,
    eventCount: live.eventCount,
  };
}

export function stepDecision(state: TimelineState, step: StepDto): PolicyDecision | null {
  return step.policyDecision ?? state.decisions[step.seq] ?? null;
}

export function totalStepCost(steps: StepDto[]): number {
  return steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
}

const EVENT_TYPES = new Set<string>(RUN_EVENT_TYPES);

export function parseRunEvent(name: string, data: string): RunEvent | null {
  if (!EVENT_TYPES.has(name)) return null;
  try {
    const parsed = JSON.parse(data) as RunEvent;
    return typeof parsed === 'object' && parsed !== null && parsed.type === name ? parsed : null;
  } catch {
    return null;
  }
}

export class SseAccumulator {
  private buffer = '';

  push(chunk: string): RunEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const { events, rest } = parseSseChunk(this.buffer);
    this.buffer = rest;
    const out: RunEvent[] = [];
    for (const e of events) {
      const ev = parseRunEvent(e.event, e.data);
      if (ev !== null) out.push(ev);
    }
    return out;
  }
}

export function isStreamEnd(event: RunEvent): boolean {
  return event.type === 'done' || (event.type === 'status' && event.status === 'awaiting_approval');
}

export interface StepText {
  text: string;
  toolUses: string[];
}

export function llmStepText(step: StepDto): StepText {
  const result = step.result as { content?: Array<{ type?: string; text?: string; name?: string }> } | null;
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
  const toolUses = content.filter((b) => b.type === 'tool_use').map((b) => String(b.name ?? ''));
  return { text, toolUses };
}

export interface ToolStepResult {
  content: string;
  isError: boolean;
  proposalId: string | null;
  pending: boolean;
}

export function toolStepResult(step: StepDto): ToolStepResult {
  const r = step.result as { toolResult?: { content?: unknown; isError?: boolean }; proposalId?: string } | null;
  if (r === null || r === undefined) return { content: '', isError: false, proposalId: null, pending: true };
  const content = r.toolResult?.content;
  return {
    content: typeof content === 'string' ? content : content === undefined ? '' : JSON.stringify(content),
    isError: r.toolResult?.isError === true,
    proposalId: typeof r.proposalId === 'string' ? r.proposalId : null,
    pending: false,
  };
}

export function unwrapToolResult(content: string): { body: string; untrusted: boolean | null } {
  const m = /^<tool_result tool="[^"]*" untrusted="(true|false)">\n?([\s\S]*?)\n?<\/tool_result>$/.exec(content.trim());
  if (m === null) return { body: content, untrusted: null };
  return { body: m[2] ?? '', untrusted: m[1] === 'true' };
}

export function compactArgs(args: unknown, max = 90): string {
  if (args === null || args === undefined) return '';
  if (typeof args !== 'object') return String(args).slice(0, max);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === undefined) continue;
    const s = typeof v === 'string' ? `"${v}"` : JSON.stringify(v);
    parts.push(`${k}: ${s.length > 40 ? `${s.slice(0, 39)}…` : s}`);
  }
  const joined = parts.join(', ');
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined;
}
