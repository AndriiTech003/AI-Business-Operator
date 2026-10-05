export interface LineLookup {
  lines: number;
  line(n: number): { from: number; to: number };
}

export function diagnosticRange(
  doc: LineLookup,
  line: number | null,
  col: number | null,
): { from: number; to: number } {
  if (doc.lines === 0) return { from: 0, to: 0 };
  if (line === null) {
    const first = doc.line(1);
    return { from: first.from, to: first.to };
  }
  const l = doc.line(Math.min(Math.max(1, line), doc.lines));
  if (col === null) return { from: l.from, to: l.to };
  const from = Math.min(l.from + Math.max(0, col - 1), l.to);
  return { from, to: l.to > from ? l.to : from };
}
