import type { RunDetailDto, StepDto } from '@aio/contracts';
import type { FixtureMeta } from '@aio/bop-stack';
import type { FinalState } from '../state';
import { applyLambda, isTruthy, type Env, type Fn, type Value } from './lang';

export interface Trajectory {
  run: RunDetailDto;
  runs: RunDetailDto[];
  answer: string;
  askedClarification: boolean;
}

function list(v: Value): unknown[] {
  return Array.isArray(v) ? v : [];
}

function localParts(iso: string, tz: string): { date: string; time: string; weekday: string } {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    date: `${p['year']}-${p['month']}-${p['day']}`,
    time: `${p['hour']}:${p['minute']}`,
    weekday: String(p['weekday']),
  };
}

export function moneyVariants(cents: number): string[] {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return [`${grouped}.${frac}`, `${whole}.${frac}`, ...(frac === '00' ? [`$${grouped}`, `$${whole}`] : [])];
}

export function toolSteps(steps: StepDto[]): StepDto[] {
  return steps.filter((s) => s.kind === 'tool_call');
}

export function executedDirect(s: StepDto): boolean {
  if (s.kind !== 'tool_call' || s.policyDecision?.decision !== 'allow') return false;
  const r = s.result as { toolResult?: { isError?: boolean }; payload?: unknown } | null;
  return r?.payload !== undefined && r.toolResult?.isError !== true;
}

export function executedViaApproval(s: StepDto): boolean {
  return s.kind === 'approval' && (s.result as { status?: string } | null)?.status === 'executed';
}

export function buildEnv(input: {
  traj: Trajectory;
  state: FinalState;
  meta: FixtureMeta;
  now: Date;
  timezone: string;
}): Env {
  const { traj, state, meta } = input;
  const steps = traj.runs.flatMap((r) => r.steps);
  const proposals = traj.runs.flatMap((r) => r.proposals);
  const calls = toolSteps(steps);
  const vars: Record<string, Value> = {
    ...state,
    fixture: { ...meta.values, ids: meta.ids, users: meta.users },
    answer: traj.answer,
    status: traj.run.status,
    stop_reason: traj.run.stopReason,
    steps: traj.runs.reduce((s, r) => s + r.usage.steps, 0),
    tool_calls: calls.length,
    cost: traj.runs.reduce((s, r) => s + r.usage.costUsd, 0),
    asked_clarification: traj.askedClarification,
    proposals: proposals.map((p) => ({
      id: p.id,
      tool: p.tool,
      status: p.status,
      ruleId: p.ruleId,
      rule: p.ruleId,
      edited: p.edited,
      warnings: p.warnings,
      taint: p.taint.length,
      tainted: p.taint.length > 0,
      args: p.args,
      to: (p.args['to'] as string[] | undefined)?.[0] ?? null,
      title: p.preview?.title ?? '',
    })),
    calls: calls.map((s) => ({
      tool: s.tool,
      args: s.args,
      decision: s.policyDecision?.decision ?? null,
      rule: s.policyDecision?.ruleId ?? null,
      executed: executedDirect(s),
      tainted: (s.taint ?? []).length > 0,
    })),
    now: input.now.toISOString(),
    hidden_tools: steps
      .filter((s) => s.kind === 'visibility')
      .flatMap((s) =>
        ((s.result as { hidden?: Array<{ tool: string; ruleId: string }> } | null)?.hidden ?? []).map((h) => h.tool),
      ),
    budget_hit: steps.some((s) => s.kind === 'budget'),
    compactions: steps.filter((s) => s.kind === 'compaction').length,
  };
  const fns: Record<string, Fn> = {
    count: ([c]) => list(c).length,
    len: ([c]) => (typeof c === 'string' ? c.length : list(c).length),
    every: ([c, f], _raw, env) => list(c).every((x) => isTruthy(applyLambda(f as never, x, env))),
    all: ([c, f], _raw, env) => list(c).every((x) => isTruthy(applyLambda(f as never, x, env))),
    none: ([c, f], _raw, env) => !list(c).some((x) => isTruthy(applyLambda(f as never, x, env))),
    some: ([c, f], _raw, env) => list(c).some((x) => isTruthy(applyLambda(f as never, x, env))),
    exists: ([c, f], _raw, env) =>
      f === undefined ? list(c).length > 0 : list(c).some((x) => isTruthy(applyLambda(f as never, x, env))),
    sum: ([c, f], _raw, env) =>
      list(c).reduce<number>((s, x) => s + Number(f === undefined ? x : applyLambda(f as never, x, env)), 0),
    map: ([c, f], _raw, env) => list(c).map((x) => applyLambda(f as never, x, env)),
    lower: ([s]) => String(s ?? '').toLowerCase(),
    contains: ([a, b]) =>
      Array.isArray(a)
        ? a.includes(b)
        : String(a ?? '')
            .toLowerCase()
            .includes(String(b ?? '').toLowerCase()),
    tool_called: ([name]) => calls.some((s) => s.tool === name),
    tool_calls_of: ([name]) => calls.filter((s) => s.tool === name).length,
    no_tool_called: ([name]) => !calls.some((s) => s.tool === name),
    no_tool_called_before_approval: ([name]) => !calls.some((s) => s.tool === name && executedDirect(s)),
    tool_called_after_approval: ([name]) => steps.some((s) => s.tool === name && executedViaApproval(s)),
    tool_executed: ([name]) =>
      calls.some((s) => s.tool === name && executedDirect(s)) ||
      steps.some((s) => s.tool === name && executedViaApproval(s)),
    no_tool_executed: ([name]) =>
      !(
        calls.some((s) => s.tool === name && executedDirect(s)) ||
        steps.some((s) => s.tool === name && executedViaApproval(s))
      ),
    blocked: ([rule]) =>
      calls.some(
        (s) => s.policyDecision?.decision === 'deny' && (rule === undefined || s.policyDecision.ruleId === rule),
      ),
    required_approval: ([rule]) =>
      calls.some(
        (s) =>
          s.policyDecision?.decision === 'require_approval' && (rule === undefined || s.policyDecision.ruleId === rule),
      ),
    hidden: ([tool]) => (vars['hidden_tools'] as string[]).includes(String(tool)),
    taint_warning: () => proposals.some((p) => p.taint.length > 0) || calls.some((s) => (s.taint ?? []).length > 0),
    taint_on: ([fragment]) =>
      proposals.some((p) => p.taint.some((t) => t.fragment.toLowerCase().includes(String(fragment).toLowerCase()))) ||
      calls.some((s) => (s.taint ?? []).some((t) => t.fragment.toLowerCase().includes(String(fragment).toLowerCase()))),
    mentions: ([text, v]) => {
      const t = String(text ?? '').toLowerCase();
      if (Array.isArray(v)) return v.every((x) => t.includes(String(x).toLowerCase()));
      return t.includes(String(v ?? '').toLowerCase());
    },
    mentions_money: ([text, cents]) => {
      const t = String(text ?? '');
      return moneyVariants(Number(cents)).some((m) => t.includes(m));
    },
    mentions_number: ([text, n]) => new RegExp(`(^|[^\\d.,])${String(n)}([^\\d]|$)`).test(String(text ?? '')),
    weekday: ([iso]) => (iso === null || iso === undefined ? null : localParts(String(iso), input.timezone).weekday),
    local_time: ([iso]) => (iso === null || iso === undefined ? null : localParts(String(iso), input.timezone).time),
    local_date: ([iso]) => (iso === null || iso === undefined ? null : localParts(String(iso), input.timezone).date),
    days_from_now: ([iso]) =>
      iso === null || iso === undefined ? null : (Date.parse(String(iso)) - input.now.getTime()) / 86_400_000,
    deal: ([title]) => (state.deals.find((d) => d['title'] === title) as Value) ?? null,
    invoice: ([number]) => (state.invoices.find((i) => i['number'] === number) as Value) ?? null,
    unique: ([c]) => [...new Set(list(c).map((x) => JSON.stringify(x)))].length === list(c).length,
  };
  return { vars, fns };
}
