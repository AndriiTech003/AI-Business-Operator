export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix += 1;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const n = midA.length;
  const m = midB.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1)
      table[i * width + j] =
        midA[i] === midB[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
  const out: DiffLine[] = [];
  for (let k = 0; k < prefix; k += 1) out.push({ type: 'same', text: a[k] as string, oldLine: k + 1, newLine: k + 1 });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      out.push({ type: 'same', text: midA[i] as string, oldLine: prefix + i + 1, newLine: prefix + j + 1 });
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || (table[i * width + j + 1] as number) >= (table[(i + 1) * width + j] as number))) {
      out.push({ type: 'add', text: midB[j] as string, oldLine: null, newLine: prefix + j + 1 });
      j += 1;
    } else {
      out.push({ type: 'del', text: midA[i] as string, oldLine: prefix + i + 1, newLine: null });
      i += 1;
    }
  }
  for (let k = 0; k < suffix; k += 1)
    out.push({
      type: 'same',
      text: a[a.length - suffix + k] as string,
      oldLine: a.length - suffix + k + 1,
      newLine: b.length - suffix + k + 1,
    });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added += 1;
    else if (l.type === 'del') removed += 1;
  }
  return { added, removed };
}

export type DiffRow = DiffLine | { type: 'skip'; count: number; key: string };

export function collapseDiff(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k += 1) keep[k] = true;
  });
  const out: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped > 0) out.push({ type: 'skip', count: skipped, key: `skip-${i}` });
      skipped = 0;
      out.push(l);
    } else skipped += 1;
  });
  if (skipped > 0) out.push({ type: 'skip', count: skipped, key: 'skip-end' });
  return out;
}
