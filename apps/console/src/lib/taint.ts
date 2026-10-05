import type { TaintFinding } from '@aio/contracts';

export interface TaintSegment {
  text: string;
  marked: boolean;
}

export function taintRange(sourceText: string, start: number, end: number, fragment: string): [number, number] | null {
  if (start >= 0 && end > start && end <= sourceText.length) return [start, end];
  if (fragment === '') return null;
  const idx = sourceText.indexOf(fragment);
  if (idx >= 0) return [idx, idx + fragment.length];
  const lower = sourceText.toLowerCase().indexOf(fragment.toLowerCase());
  return lower >= 0 ? [lower, lower + fragment.length] : null;
}

export function taintSegments(
  sourceText: string,
  start: number,
  end: number,
  fragment = '',
  context = Number.POSITIVE_INFINITY,
): TaintSegment[] {
  const range = taintRange(sourceText, start, end, fragment);
  if (range === null) return sourceText === '' ? [] : [{ text: sourceText, marked: false }];
  const [from, to] = range;
  const segments: TaintSegment[] = [];
  const beforeStart = Number.isFinite(context) ? Math.max(0, from - context) : 0;
  const afterEnd = Number.isFinite(context) ? Math.min(sourceText.length, to + context) : sourceText.length;
  const before = sourceText.slice(beforeStart, from);
  const after = sourceText.slice(to, afterEnd);
  if (before !== '') segments.push({ text: `${beforeStart > 0 ? '…' : ''}${before}`, marked: false });
  segments.push({ text: sourceText.slice(from, to), marked: true });
  if (after !== '') segments.push({ text: `${after}${afterEnd < sourceText.length ? '…' : ''}`, marked: false });
  return segments;
}

export function findingSegments(finding: TaintFinding, context = 160): TaintSegment[] {
  return taintSegments(finding.sourceText, finding.start, finding.end, finding.fragment, context);
}

export function describeSource(finding: TaintFinding): string {
  const seq = finding.source.stepSeq !== null ? ` · step #${finding.source.stepSeq}` : '';
  return `from ${finding.source.tool} · ${finding.source.path}${seq}`;
}
