import { LineCounter, parseDocument, isScalar, type Node as YamlNode } from 'yaml';
import { T, check, collectPaths, isAssignable, parse, type Node, type Type, type TypeContext } from '@ashamrai/expr';
import { policyDocumentSchema, type PolicyDocument, type PolicyRule } from '@aio/contracts';
import { INTRINSICS, lowerIntrinsics, type LoweredExpression } from './intrinsics';
import { TOOL_SCOPES } from './scopes';

export interface PolicyDiagnostic {
  severity: 'error' | 'warning';
  path: string;
  message: string;
  line: number | null;
  col: number | null;
}

export const POLICY_CONTEXT: TypeContext = {
  vars: {
    tool: T.object({ name: T.string, risk: T.string }, 'Tool'),
    args: T.any,
    record: T.any,
    run: T.object(
      {
        writeCount: T.number,
        externalCount: T.number,
        emailsSent: T.number,
        toolCalls: T.number,
        steps: T.number,
      },
      'Run',
    ),
    user: T.object({ id: T.string, role: T.string, scopes: T.list(T.string) }, 'User'),
    tenant: T.object(
      { id: T.string, name: T.string, domain: T.string, emailsToday: T.number, externalToday: T.number },
      'Tenant',
    ),
  },
};

export interface CompiledRule {
  id: string;
  tools: string[] | null;
  then: PolicyRule['then'];
  reason: string | null;
  when: string | null;
  lowered: LoweredExpression | null;
  usesRecord: boolean;
  usesArgsTo: boolean;
}

function lineCol(counter: LineCounter, offset: number): { line: number; col: number } {
  const pos = counter.linePos(offset);
  return { line: pos.line, col: pos.col };
}

export function checkExpression(source: string): {
  lowered: LoweredExpression | null;
  messages: Array<{ message: string; offset: number; severity: 'error' | 'warning' }>;
} {
  const messages: Array<{ message: string; offset: number; severity: 'error' | 'warning' }> = [];
  const parsed = parse(source);
  for (const d of parsed.diagnostics) messages.push({ message: d.message, offset: d.span.start, severity: d.severity });
  if (parsed.ast === null) return { lowered: null, messages };
  const lowered = lowerIntrinsics(parsed.ast);
  const vars: Record<string, Type> = { ...POLICY_CONTEXT.vars };
  for (const call of lowered.calls) {
    const spec = INTRINSICS[call.name];
    if (spec === undefined) continue;
    if (call.args.length !== spec.arity)
      messages.push({
        message: `${call.name}() expects ${spec.arity} argument(s), got ${call.args.length}`,
        offset: call.args[0]?.span.start ?? 0,
        severity: 'error',
      });
    for (const arg of call.args) {
      const r = check(arg, { vars }, source);
      for (const d of r.diagnostics) messages.push({ message: d.message, offset: d.span.start, severity: d.severity });
    }
    vars[call.ident] = spec.returns;
  }
  const result = check(lowered.ast, { vars }, source);
  for (const d of result.diagnostics) messages.push({ message: d.message, offset: d.span.start, severity: d.severity });
  if (result.diagnostics.every((d) => d.severity !== 'error') && !isAssignable(result.type, T.nullable(T.bool)))
    messages.push({ message: 'Condition must be a boolean expression', offset: 0, severity: 'error' });
  return { lowered: messages.some((m) => m.severity === 'error') ? null : lowered, messages };
}

function usesRoot(ast: Node | null, root: string, field?: string): boolean {
  if (ast === null) return false;
  return collectPaths(ast).some((p) => p[0] === root && (field === undefined || p[1] === field));
}

export function compileRules(doc: PolicyDocument): { rules: CompiledRule[]; diagnostics: PolicyDiagnostic[] } {
  const diagnostics: PolicyDiagnostic[] = [];
  const rules: CompiledRule[] = [];
  const seen = new Set<string>();
  doc.rules.forEach((rule, i) => {
    if (seen.has(rule.id))
      diagnostics.push({
        severity: 'error',
        path: `rules.${i}.id`,
        message: `Duplicate rule id '${rule.id}'`,
        line: null,
        col: null,
      });
    seen.add(rule.id);
    const tools = rule.tool === undefined ? null : Array.isArray(rule.tool) ? rule.tool : [rule.tool];
    for (const t of tools ?? [])
      if (TOOL_SCOPES[t] === undefined)
        diagnostics.push({
          severity: 'warning',
          path: `rules.${i}.tool`,
          message: `Unknown tool '${t}'`,
          line: null,
          col: null,
        });
    let lowered: LoweredExpression | null = null;
    let ast: Node | null = null;
    if (rule.when !== undefined) {
      const checked = checkExpression(rule.when);
      for (const m of checked.messages)
        diagnostics.push({
          severity: m.severity,
          path: `rules.${i}.when`,
          message: m.message,
          line: null,
          col: m.offset,
        });
      lowered = checked.lowered;
      ast = parse(rule.when).ast;
    }
    rules.push({
      id: rule.id,
      tools,
      then: rule.then,
      reason: rule.reason ?? null,
      when: rule.when ?? null,
      lowered,
      usesRecord: usesRoot(ast, 'record'),
      usesArgsTo: usesRoot(ast, 'args', 'to'),
    });
  });
  return { rules, diagnostics };
}

export interface ParsedPolicySource {
  document: PolicyDocument | null;
  diagnostics: PolicyDiagnostic[];
}

export function parsePolicyYaml(source: string): ParsedPolicySource {
  const counter = new LineCounter();
  const yamlDoc = parseDocument(source, { lineCounter: counter, prettyErrors: false });
  const diagnostics: PolicyDiagnostic[] = [];
  for (const e of yamlDoc.errors) {
    const pos = lineCol(counter, e.pos[0]);
    diagnostics.push({ severity: 'error', path: '', message: e.message, line: pos.line, col: pos.col });
  }
  if (diagnostics.length > 0) return { document: null, diagnostics };
  const raw = yamlDoc.toJS() as unknown;
  const parsed = policyDocumentSchema.safeParse(raw);
  const nodeAt = (path: Array<string | number>): YamlNode | null => {
    const n = yamlDoc.getIn(path, true);
    return n !== undefined && n !== null && typeof n === 'object' && 'range' in n ? (n as YamlNode) : null;
  };
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p));
      const node = nodeAt(path);
      const pos = node?.range ? lineCol(counter, node.range[0]) : null;
      diagnostics.push({
        severity: 'error',
        path: path.join('.'),
        message: issue.message,
        line: pos?.line ?? null,
        col: pos?.col ?? null,
      });
    }
    return { document: null, diagnostics };
  }
  const compiled = compileRules(parsed.data);
  for (const d of compiled.diagnostics) {
    const parts = d.path.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
    const node = nodeAt(parts);
    if (node?.range) {
      let offset = node.range[0];
      if (d.col !== null && isScalar(node)) {
        const quoted = node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE';
        offset += (quoted ? 1 : 0) + d.col;
      }
      const pos = lineCol(counter, offset);
      diagnostics.push({ ...d, line: pos.line, col: pos.col });
    } else diagnostics.push({ ...d, col: null });
  }
  return { document: parsed.data, diagnostics };
}
