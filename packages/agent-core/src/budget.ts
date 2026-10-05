import type { Budget, Usage } from '@aio/contracts';

export type BudgetLimit =
  'maxSteps' | 'maxToolCalls' | 'maxInputTokens' | 'maxCostUsd' | 'maxWallClockMs' | 'maxExternalActions';

export interface BudgetStatus {
  ok: boolean;
  limit: BudgetLimit | null;
  detail: string;
}

export function checkBudget(budget: Budget, usage: Usage): BudgetStatus {
  if (usage.steps >= budget.maxSteps)
    return { ok: false, limit: 'maxSteps', detail: `steps ${usage.steps}/${budget.maxSteps}` };
  if (usage.toolCalls >= budget.maxToolCalls)
    return { ok: false, limit: 'maxToolCalls', detail: `tool calls ${usage.toolCalls}/${budget.maxToolCalls}` };
  if (usage.inputTokens >= budget.maxInputTokens)
    return { ok: false, limit: 'maxInputTokens', detail: `input tokens ${usage.inputTokens}/${budget.maxInputTokens}` };
  if (usage.costUsd >= budget.maxCostUsd)
    return { ok: false, limit: 'maxCostUsd', detail: `cost $${usage.costUsd.toFixed(4)}/$${budget.maxCostUsd}` };
  if (usage.wallClockMs >= budget.maxWallClockMs)
    return {
      ok: false,
      limit: 'maxWallClockMs',
      detail: `wall clock ${Math.round(usage.wallClockMs / 1000)}s/${Math.round(budget.maxWallClockMs / 1000)}s`,
    };
  if (usage.externalActions >= budget.maxExternalActions)
    return {
      ok: false,
      limit: 'maxExternalActions',
      detail: `external actions ${usage.externalActions}/${budget.maxExternalActions}`,
    };
  return { ok: true, limit: null, detail: '' };
}

export function canCallTool(budget: Budget, usage: Usage): boolean {
  return usage.toolCalls < budget.maxToolCalls;
}

export function canTakeExternalAction(budget: Budget, usage: Usage): boolean {
  return usage.externalActions < budget.maxExternalActions;
}

export function mergeBudget(base: Budget, ...overrides: Array<Partial<Budget> | undefined>): Budget {
  const out = { ...base };
  for (const o of overrides)
    if (o) for (const [k, v] of Object.entries(o)) if (typeof v === 'number') (out as Record<string, number>)[k] = v;
  return out;
}
