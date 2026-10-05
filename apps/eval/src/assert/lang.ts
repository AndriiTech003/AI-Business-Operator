export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'list'; items: Node[] }
  | { t: 'ident'; name: string }
  | { t: 'member'; obj: Node; prop: string }
  | { t: 'index'; obj: Node; index: Node }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'lambda'; param: string; body: Node }
  | { t: 'where'; coll: Node; pred: Node }
  | { t: 'unary'; op: 'not' | '-'; v: Node }
  | { t: 'bin'; op: string; l: Node; r: Node };

interface Tok {
  k: 'num' | 'str' | 'id' | 'op' | 'eof';
  v: string;
}

const KEYWORD_OPS = new Set(['and', 'or', 'not', 'in', 'contains', 'startsWith', 'endsWith', 'matches', 'where']);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i)) as RegExpExecArray;
      out.push({ k: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else {
          s += src[j];
          j += 1;
        }
      }
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)) as RegExpExecArray;
      out.push({ k: KEYWORD_OPS.has(m[0]) ? 'op' : 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '=>', '&&', '||'].includes(two)) {
      out.push({ k: 'op', v: two === '&&' ? 'and' : two === '||' ? 'or' : two });
      i += 2;
      continue;
    }
    if ('()[],.<>+-!*/'.includes(c)) {
      out.push({ k: 'op', v: c === '!' ? 'not' : c });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character '${c}' at ${i} in: ${src}`);
  }
  out.push({ k: 'eof', v: '' });
  return out;
}

class Parser {
  private i = 0;

  constructor(
    private readonly toks: Tok[],
    private readonly src: string,
  ) {}

  private peek(o = 0): Tok {
    return this.toks[this.i + o] as Tok;
  }

  private next(): Tok {
    return this.toks[this.i++] as Tok;
  }

  private expect(v: string): void {
    const t = this.next();
    if (t.v !== v) throw new Error(`expected '${v}' but got '${t.v}' in: ${this.src}`);
  }

  parse(): Node {
    const n = this.expr();
    if (this.peek().k !== 'eof') throw new Error(`unexpected '${this.peek().v}' in: ${this.src}`);
    return n;
  }

  expr(): Node {
    return this.or();
  }

  private or(): Node {
    let l = this.and();
    while (this.peek().v === 'or') {
      this.next();
      l = { t: 'bin', op: 'or', l, r: this.and() };
    }
    return l;
  }

  private and(): Node {
    let l = this.not();
    while (this.peek().v === 'and') {
      this.next();
      l = { t: 'bin', op: 'and', l, r: this.not() };
    }
    return l;
  }

  private not(): Node {
    if (this.peek().v === 'not') {
      this.next();
      return { t: 'unary', op: 'not', v: this.not() };
    }
    return this.cmp();
  }

  private cmp(): Node {
    const l = this.add();
    const t = this.peek();
    if (['==', '!=', '<', '<=', '>', '>=', 'in', 'contains', 'startsWith', 'endsWith', 'matches'].includes(t.v)) {
      this.next();
      return { t: 'bin', op: t.v, l, r: this.add() };
    }
    if (t.v === 'not' && this.peek(1).v === 'in') {
      this.next();
      this.next();
      return { t: 'unary', op: 'not', v: { t: 'bin', op: 'in', l, r: this.add() } };
    }
    return l;
  }

  private add(): Node {
    let l = this.mul();
    while (this.peek().v === '+' || this.peek().v === '-') {
      const op = this.next().v;
      l = { t: 'bin', op, l, r: this.mul() };
    }
    return l;
  }

  private mul(): Node {
    let l = this.unary();
    while (this.peek().v === '*' || this.peek().v === '/') {
      const op = this.next().v;
      l = { t: 'bin', op, l, r: this.unary() };
    }
    return l;
  }

  private unary(): Node {
    if (this.peek().v === '-') {
      this.next();
      return { t: 'unary', op: '-', v: this.unary() };
    }
    return this.postfix();
  }

  private postfix(): Node {
    let n = this.primary();
    while (true) {
      const t = this.peek();
      if (t.v === '.') {
        this.next();
        const name = this.next();
        n = { t: 'member', obj: n, prop: name.v };
      } else if (t.v === '[') {
        this.next();
        const index = this.expr();
        this.expect(']');
        n = { t: 'index', obj: n, index };
      } else break;
    }
    if (n.t === 'call' && (this.peek().v === 'before' || this.peek().v === 'after') && this.peek(1).v === 'approval') {
      const which = this.next().v;
      this.next();
      n = { t: 'call', name: `${n.name}_${which}_approval`, args: n.args };
    }
    return n;
  }

  private arg(): Node {
    if (this.peek().k === 'id' && this.peek(1).v === '=>') {
      const param = this.next().v;
      this.next();
      return { t: 'lambda', param, body: this.expr() };
    }
    const e = this.expr();
    if (this.peek().v === 'where') {
      this.next();
      return { t: 'where', coll: e, pred: this.expr() };
    }
    return e;
  }

  private primary(): Node {
    const t = this.next();
    if (t.k === 'num') return { t: 'num', v: Number(t.v) };
    if (t.k === 'str') return { t: 'str', v: t.v };
    if (t.v === '(') {
      const e = this.expr();
      this.expect(')');
      return e;
    }
    if (t.v === '[') {
      const items: Node[] = [];
      while (this.peek().v !== ']') {
        items.push(this.expr());
        if (this.peek().v === ',') this.next();
      }
      this.expect(']');
      return { t: 'list', items };
    }
    if (t.k === 'id') {
      if (t.v === 'true' || t.v === 'false') return { t: 'bool', v: t.v === 'true' };
      if (t.v === 'null') return { t: 'null' };
      if (this.peek().v === '(') {
        this.next();
        const args: Node[] = [];
        while (this.peek().v !== ')') {
          args.push(this.arg());
          if (this.peek().v === ',') this.next();
        }
        this.expect(')');
        return { t: 'call', name: t.v, args };
      }
      return { t: 'ident', name: t.v };
    }
    throw new Error(`unexpected '${t.v}' in: ${this.src}`);
  }
}

export function parseAssertion(src: string): Node {
  return new Parser(tokenize(src), src).parse();
}

export type Value = unknown;
export type Fn = (args: Value[], raw: Node[], env: Env) => Value;

export interface Env {
  vars: Record<string, Value>;
  fns: Record<string, Fn>;
}

function truthy(v: Value): boolean {
  return v !== null && v !== undefined && v !== false && v !== 0 && v !== '';
}

function eq(a: Value, b: Value): boolean {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  return a === b || (a === undefined && b === null) || (a === null && b === undefined);
}

function get(obj: Value, key: string | number): Value {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj) && typeof key === 'number') return obj[key] ?? null;
  if (Array.isArray(obj) && key === 'length') return obj.length;
  if (typeof obj === 'object') {
    const v = (obj as Record<string, Value>)[key as string];
    return v === undefined ? null : v;
  }
  return null;
}

export function applyLambda(fn: Node, item: Value, env: Env): Value {
  if (fn.t === 'lambda') return evaluate(fn.body, { ...env, vars: { ...env.vars, [fn.param]: item } });
  const scope =
    item !== null && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, Value>) : {};
  return evaluate(fn, { ...env, vars: { ...env.vars, ...scope, it: item } });
}

export function evaluate(n: Node, env: Env): Value {
  switch (n.t) {
    case 'num':
    case 'str':
    case 'bool':
      return n.v;
    case 'null':
      return null;
    case 'list':
      return n.items.map((i) => evaluate(i, env));
    case 'ident':
      if (!(n.name in env.vars)) throw new Error(`unknown variable '${n.name}'`);
      return env.vars[n.name];
    case 'member':
      return get(evaluate(n.obj, env), n.prop);
    case 'index': {
      const idx = evaluate(n.index, env);
      return get(evaluate(n.obj, env), typeof idx === 'number' ? idx : String(idx));
    }
    case 'lambda':
      return n;
    case 'where': {
      const coll = evaluate(n.coll, env);
      return (Array.isArray(coll) ? coll : []).filter((item) => truthy(applyLambda(n.pred, item, env)));
    }
    case 'call': {
      const fn = env.fns[n.name];
      if (fn === undefined) throw new Error(`unknown function '${n.name}'`);
      const args = n.args.map((a) => (a.t === 'lambda' ? a : evaluate(a, env)));
      return fn(args, n.args, env);
    }
    case 'unary': {
      const v = evaluate(n.v, env);
      return n.op === 'not' ? !truthy(v) : -Number(v);
    }
    case 'bin': {
      if (n.op === 'and') return truthy(evaluate(n.l, env)) && truthy(evaluate(n.r, env));
      if (n.op === 'or') return truthy(evaluate(n.l, env)) || truthy(evaluate(n.r, env));
      const l = evaluate(n.l, env);
      const r = evaluate(n.r, env);
      switch (n.op) {
        case '==':
          return eq(l, r);
        case '!=':
          return !eq(l, r);
        case '<':
          return Number(l) < Number(r);
        case '<=':
          return Number(l) <= Number(r);
        case '>':
          return Number(l) > Number(r);
        case '>=':
          return Number(l) >= Number(r);
        case '+':
          return typeof l === 'string' || typeof r === 'string' ? `${String(l)}${String(r)}` : Number(l) + Number(r);
        case '-':
          return Number(l) - Number(r);
        case '*':
          return Number(l) * Number(r);
        case '/':
          return Number(l) / Number(r);
        case 'in':
          if (Array.isArray(r))
            return r.some(
              (x) =>
                eq(x, l) || (typeof x === 'string' && typeof l === 'string' && x.toLowerCase() === l.toLowerCase()),
            );
          return typeof r === 'string' && typeof l === 'string' && r.toLowerCase().includes(l.toLowerCase());
        case 'contains':
          if (Array.isArray(l)) return l.some((x) => eq(x, r));
          return typeof l === 'string' && typeof r === 'string' && l.toLowerCase().includes(r.toLowerCase());
        case 'startsWith':
          return typeof l === 'string' && typeof r === 'string' && l.toLowerCase().startsWith(r.toLowerCase());
        case 'endsWith':
          return typeof l === 'string' && typeof r === 'string' && l.toLowerCase().endsWith(r.toLowerCase());
        case 'matches':
          return typeof l === 'string' && typeof r === 'string' && new RegExp(r, 'i').test(l);
        default:
          throw new Error(`unknown operator ${n.op}`);
      }
    }
  }
}

export function check(src: string, env: Env): { ok: boolean; detail: string } {
  try {
    const node = parseAssertion(src);
    const v = evaluate(node, env);
    if (truthy(v)) return { ok: true, detail: '' };
    if (node.t === 'bin' && ['==', '!=', '<', '<=', '>', '>='].includes(node.op))
      return {
        ok: false,
        detail: `left = ${JSON.stringify(evaluate(node.l, env))?.slice(0, 200)}, right = ${JSON.stringify(evaluate(node.r, env))?.slice(0, 200)}`,
      };
    return { ok: false, detail: 'evaluated to false' };
  } catch (error) {
    return { ok: false, detail: `error: ${(error as Error).message}` };
  }
}

export function isTruthy(v: Value): boolean {
  return truthy(v);
}
