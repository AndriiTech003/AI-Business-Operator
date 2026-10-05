import type { PolicyDecision, ProposalDto, RunStatus, StepDto, StopReason, Usage } from './domain';

export type RunEvent =
  | { type: 'text'; runId: string; delta: string; seq: number | null }
  | { type: 'tool_call'; runId: string; step: StepDto }
  | { type: 'tool_result'; runId: string; step: StepDto }
  | { type: 'policy'; runId: string; seq: number; tool: string; decision: PolicyDecision }
  | { type: 'proposal'; runId: string; proposal: ProposalDto }
  | { type: 'status'; runId: string; status: RunStatus; stopReason: StopReason | null }
  | { type: 'usage'; runId: string; usage: Usage }
  | { type: 'step'; runId: string; step: StepDto }
  | { type: 'done'; runId: string; status: RunStatus; stopReason: StopReason | null; summary: string | null };

export const RUN_EVENT_TYPES = [
  'text',
  'tool_call',
  'tool_result',
  'policy',
  'proposal',
  'status',
  'usage',
  'step',
  'done',
] as const;

export function encodeSse(event: RunEvent, id?: string | number): string {
  const lines = [`event: ${event.type}`];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`data: ${JSON.stringify(event)}`);
  return `${lines.join('\n')}\n\n`;
}

export function parseSseChunk(buffer: string): { events: Array<{ event: string; data: string }>; rest: string } {
  const events: Array<{ event: string; data: string }> = [];
  let rest = buffer;
  let idx = rest.indexOf('\n\n');
  while (idx >= 0) {
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = 'message';
    const data: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
    idx = rest.indexOf('\n\n');
  }
  return { events, rest };
}
