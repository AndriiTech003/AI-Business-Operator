import { T, evaluate, type Node, type Type } from '@ashamrai/expr';

export interface IntrinsicHost {
  contactExists(email: string): Promise<boolean>;
}

export interface IntrinsicSpec {
  name: string;
  arity: number;
  returns: Type;
  description: string;
  run(args: unknown[], host: IntrinsicHost): Promise<unknown>;
}

function asList(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [String(value)];
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).toLowerCase();
}

export const INTRINSICS: Record<string, IntrinsicSpec> = {
  abs: {
    name: 'abs',
    arity: 1,
    returns: T.nullable(T.number),
    description: 'Absolute value of a number.',
    async run([n]) {
      return typeof n === 'number' ? Math.abs(n) : null;
    },
  },
  endsWith: {
    name: 'endsWith',
    arity: 2,
    returns: T.bool,
    description:
      'True when the string ends with the suffix (case-insensitive). For a list, every item must end with the suffix.',
    async run([value, suffix]) {
      const list = asList(value);
      if (list === null || list.length === 0 || typeof suffix !== 'string' || suffix === '') return false;
      const s = suffix.toLowerCase();
      return list.every((v) => v.toLowerCase().endsWith(s));
    },
  },
  domainOf: {
    name: 'domainOf',
    arity: 1,
    returns: T.nullable(T.string),
    description: 'Domain part of an e-mail address.',
    async run([value]) {
      return typeof value === 'string' ? emailDomain(value) : null;
    },
  },
  contactExists: {
    name: 'contactExists',
    arity: 1,
    returns: T.bool,
    description:
      'True when the e-mail belongs to a contact in the business system. For a list, every address must be a contact.',
    async run([value], host) {
      const list = asList(value);
      if (list === null || list.length === 0) return false;
      for (const email of list) if (!(await host.contactExists(email.toLowerCase()))) return false;
      return true;
    },
  },
};

export interface IntrinsicCall {
  ident: string;
  name: string;
  args: Node[];
}

export interface LoweredExpression {
  ast: Node;
  calls: IntrinsicCall[];
}

export function lowerIntrinsics(ast: Node): LoweredExpression {
  const calls: IntrinsicCall[] = [];
  const visit = (node: Node): Node => {
    switch (node.type) {
      case 'call': {
        const args = node.args.map(visit);
        if (INTRINSICS[node.callee] === undefined) return { ...node, args };
        const ident = `__fn${calls.length}`;
        calls.push({ ident, name: node.callee, args });
        return { type: 'ident', name: ident, span: node.span };
      }
      case 'list':
        return { ...node, items: node.items.map(visit) };
      case 'member':
        return { ...node, object: visit(node.object) };
      case 'index':
        return { ...node, object: visit(node.object), index: visit(node.index) };
      case 'unary':
        return { ...node, operand: visit(node.operand) };
      case 'binary':
        return { ...node, left: visit(node.left), right: visit(node.right) };
      case 'ternary':
        return {
          ...node,
          test: visit(node.test),
          consequent: visit(node.consequent),
          alternate: visit(node.alternate),
        };
      default:
        return node;
    }
  };
  return { ast: visit(ast), calls };
}

export async function evaluateLowered(
  lowered: LoweredExpression,
  vars: Record<string, unknown>,
  host: IntrinsicHost,
  now: () => Date,
): Promise<unknown> {
  const env: Record<string, unknown> = { ...vars };
  for (const call of lowered.calls) {
    const values: unknown[] = [];
    for (const arg of call.args) {
      try {
        values.push(evaluate(arg, { vars: env, now }));
      } catch {
        values.push(null);
      }
    }
    const spec = INTRINSICS[call.name] as IntrinsicSpec;
    env[call.ident] = await spec.run(values, host);
  }
  return evaluate(lowered.ast, { vars: env, now });
}
