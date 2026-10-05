import { emptyUsage, encodeSse, type PolicyDecision, type RunEvent, type StepDto } from '@aio/contracts';

export const RUN_ID = '11111111-1111-4111-8111-111111111111';

export function step(seq: number, patch: Partial<StepDto> = {}): StepDto {
  return {
    id: `step-${seq}`,
    runId: RUN_ID,
    seq,
    kind: 'tool_call',
    tool: 'list_invoices',
    args: {},
    result: null,
    policyDecision: null,
    taint: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    latencyMs: 0,
    idempotencyKey: null,
    createdAt: '2026-10-03T10:00:00.000Z',
    ...patch,
  };
}

export function decision(d: PolicyDecision['decision'], ruleId: string): PolicyDecision {
  return { decision: d, ruleId, reasons: [], matchedRules: [], warnings: [], policyVersion: 1, taint: [] };
}

export function sse(events: RunEvent[]): string {
  return events.map((e, i) => encodeSse(e, i + 1)).join('');
}

export function usage(costUsd: number) {
  return { ...emptyUsage(), costUsd };
}
