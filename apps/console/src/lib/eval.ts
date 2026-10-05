import { DECISIONS, type Decision, type EvalResultDto } from '@aio/contracts';

export interface TrajectoryStep {
  seq: number;
  kind: string;
  tool: string | null;
  args: unknown;
  decision: { decision: Decision; ruleId: string } | null;
  rawDecision: string | null;
  taint: string[];
  text: string | null;
  result: string | null;
}

export interface Trajectory {
  steps: TrajectoryStep[];
  answer: string | null;
  status: string | null;
  stopReason: string | null;
  wallMs: number | null;
}

export function parseDecision(raw: unknown): { decision: Decision; ruleId: string } | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const idx = raw.indexOf('/');
  const head = idx >= 0 ? raw.slice(0, idx) : raw;
  const ruleId = idx >= 0 ? raw.slice(idx + 1) : '';
  return (DECISIONS as readonly string[]).includes(head) ? { decision: head as Decision, ruleId } : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : v === null || v === undefined ? null : String(v);
}

export function parseTrajectory(raw: unknown): Trajectory {
  const obj = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(raw) ? raw : Array.isArray(obj['steps']) ? (obj['steps'] as unknown[]) : [];
  const steps: TrajectoryStep[] = list.map((s, i) => {
    const step = typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : {};
    return {
      seq: typeof step['seq'] === 'number' ? step['seq'] : i + 1,
      kind: str(step['kind']) ?? 'step',
      tool: str(step['tool']),
      args: step['args'],
      decision: parseDecision(step['decision']),
      rawDecision: str(step['decision']),
      taint: Array.isArray(step['taint']) ? step['taint'].map(String) : [],
      text: str(step['text']),
      result: str(step['result']),
    };
  });
  return {
    steps,
    answer: str(obj['answer']),
    status: str(obj['status']),
    stopReason: str(obj['stopReason']),
    wallMs: typeof obj['wallMs'] === 'number' ? obj['wallMs'] : null,
  };
}

export interface CategorySummary {
  category: string;
  model: string;
  passed: number;
  total: number;
}

export function summarizeCategories(results: EvalResultDto[]): CategorySummary[] {
  const map = new Map<string, CategorySummary>();
  for (const r of results) {
    const key = `${r.category}\u0000${r.model}`;
    const cur = map.get(key) ?? { category: r.category, model: r.model, passed: 0, total: 0 };
    cur.total += 1;
    if (r.passed) cur.passed += 1;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => a.category.localeCompare(b.category) || a.model.localeCompare(b.model));
}

export function successRate(passed: number, total: number): number {
  return total === 0 ? 0 : passed / total;
}

export function highlightFragments(text: string, fragments: string[]): Array<{ text: string; marked: boolean }> {
  const frags = fragments.filter((f) => f !== '');
  if (frags.length === 0 || text === '') return text === '' ? [] : [{ text, marked: false }];
  const out: Array<{ text: string; marked: boolean }> = [];
  let pos = 0;
  while (pos < text.length) {
    let best = -1;
    let bestLen = 0;
    for (const f of frags) {
      const idx = text.indexOf(f, pos);
      if (idx >= 0 && (best < 0 || idx < best || (idx === best && f.length > bestLen))) {
        best = idx;
        bestLen = f.length;
      }
    }
    if (best < 0) {
      out.push({ text: text.slice(pos), marked: false });
      break;
    }
    if (best > pos) out.push({ text: text.slice(pos, best), marked: false });
    out.push({ text: text.slice(best, best + bestLen), marked: true });
    pos = best + bestLen;
  }
  return out;
}
