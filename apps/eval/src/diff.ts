import { readFileSync } from 'node:fs';
import type { ScenarioResult } from './report';

interface Report {
  results: ScenarioResult[];
}

function toolSequence(r: ScenarioResult): string[] {
  const steps = (Array.isArray(r.trajectory) ? r.trajectory : []) as Array<{
    kind?: string;
    tool?: string | null;
    decision?: string;
  }>;
  return steps
    .filter((s) => s.kind === 'tool_call' || s.kind === 'approval')
    .map(
      (s) =>
        `${s.kind === 'approval' ? 'approved:' : ''}${s.tool ?? '?'}${s.decision ? `[${s.decision.split('/')[0]}]` : ''}`,
    );
}

export function diffReports(beforePath: string, afterPath: string): string {
  const before = JSON.parse(readFileSync(beforePath, 'utf8')) as Report;
  const after = JSON.parse(readFileSync(afterPath, 'utf8')) as Report;
  const key = (r: ScenarioResult) => `${r.scenarioId}::${r.model}`;
  const old = new Map(before.results.map((r) => [key(r), r]));
  const lines = ['| Scenario | Model | Result | Steps | Cost | Trajectory change |', '|---|---|---|---|---|---|'];
  let changed = 0;
  for (const r of after.results) {
    const o = old.get(key(r));
    const seqA = o === undefined ? [] : toolSequence(o);
    const seqB = toolSequence(r);
    const same =
      o !== undefined && o.passed === r.passed && o.steps === r.steps && JSON.stringify(seqA) === JSON.stringify(seqB);
    if (same) continue;
    changed += 1;
    const trajectory =
      JSON.stringify(seqA) === JSON.stringify(seqB)
        ? 'same tools'
        : `${seqA.join(' → ') || '(new)'}<br>⇒ ${seqB.join(' → ')}`;
    lines.push(
      `| ${r.scenarioId} | ${r.model} | ${o === undefined ? 'new' : `${o.passed ? '✅' : '❌'} → `}${r.passed ? '✅' : '❌'} | ${o?.steps ?? '–'} → ${r.steps} | ${o ? o.costUsd.toFixed(4) : '–'} → ${r.costUsd.toFixed(4)} | ${trajectory} |`,
    );
  }
  for (const [k, o] of old)
    if (!after.results.some((r) => key(r) === k)) lines.push(`| ${o.scenarioId} | ${o.model} | removed | | | |`);
  return changed === 0 && lines.length === 2 ? 'No trajectory changes.\n' : `${lines.join('\n')}\n`;
}
