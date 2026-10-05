export type PathSegment = string | number;

export function parsePath(path: string): PathSegment[] {
  const out: PathSegment[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[2] !== undefined) out.push(Number(m[2]));
    else if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

export function getPath(value: unknown, path: PathSegment[]): unknown {
  let cur: unknown = value;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

export function formatPath(path: PathSegment[]): string {
  return path.reduce<string>(
    (acc, seg) => (typeof seg === 'number' ? `${acc}[${seg}]` : acc === '' ? seg : `${acc}.${seg}`),
    '',
  );
}

export interface StringLeaf {
  path: string;
  value: string;
}

export function stringLeaves(value: unknown, prefix: PathSegment[] = []): StringLeaf[] {
  if (typeof value === 'string') return [{ path: formatPath(prefix), value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, [...prefix, i]));
  if (value !== null && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => stringLeaves(v, [...prefix, k]));
  if (typeof value === 'number' && Number.isFinite(value)) return [{ path: formatPath(prefix), value: String(value) }];
  return [];
}

export function isUnder(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(`${r}.`) || path.startsWith(`${r}[`));
}
