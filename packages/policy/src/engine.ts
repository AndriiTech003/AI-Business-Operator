import {
  DECISION_RANK,
  type Decision,
  type MatchedRule,
  type PolicyDecision,
  type PolicyDocument,
  type Risk,
  type TaintFinding,
  type ToolDescriptor,
} from '@aio/contracts';
import { compileRules, parsePolicyYaml, type CompiledRule, type PolicyDiagnostic } from './compile';
import { evaluateLowered, type IntrinsicHost } from './intrinsics';
import { EMAIL_TOOLS, requiredScope } from './scopes';

export interface PolicyRunState {
  writeCount: number;
  externalCount: number;
  emailsSent: number;
  toolCalls: number;
  steps: number;
}

export interface PolicyInput {
  tool: { name: string; risk: Risk };
  args: Record<string, unknown>;
  user: { id: string; role: string; scopes: string[] };
  run: PolicyRunState;
  tenant: { id: string; name: string; domain: string; emailsToday: number; externalToday: number };
  record?: Record<string, unknown> | null;
}

export interface PolicyHost extends IntrinsicHost {
  loadRecord?(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}

export interface RuleTrace {
  id: string;
  then: Decision;
  applicable: boolean;
  matched: boolean;
  error: string | null;
}

export interface PolicyEvaluation extends PolicyDecision {
  trace: RuleTrace[];
  context: {
    run: PolicyRunState;
    tenant: PolicyInput['tenant'];
    record: Record<string, unknown> | null;
    userScopes: string[];
  };
}

export interface HiddenTool {
  tool: string;
  ruleId: string;
  reason: string;
}

const RECIPIENT_TOOLS = new Set(['send_email', 'draft_email', 'send_invoice']);

function recipientsOf(args: Record<string, unknown>): string[] {
  const to = args['to'];
  if (Array.isArray(to)) return to.map(String);
  if (typeof to === 'string') return [to];
  return [];
}

export class CompiledPolicy {
  constructor(
    readonly version: number,
    readonly document: PolicyDocument,
    readonly rules: CompiledRule[],
    readonly source: string | null,
  ) {}

  private rulesFor(tool: string): CompiledRule[] {
    return this.rules.filter((r) => r.tools === null || r.tools.includes(tool));
  }

  visibleTools(
    tools: ToolDescriptor[],
    user: { scopes: string[] },
  ): { visible: ToolDescriptor[]; hidden: HiddenTool[] } {
    const visible: ToolDescriptor[] = [];
    const hidden: HiddenTool[] = [];
    for (const t of tools) {
      const scope = requiredScope(t.name, t.risk);
      if (!user.scopes.includes(scope)) {
        hidden.push({
          tool: t.name,
          ruleId: 'user-permission',
          reason: `You lack the '${scope}' permission in the business system`,
        });
        continue;
      }
      const rules = this.rulesFor(t.name);
      const unconditional = rules.find((r) => r.when === null && r.then === 'deny' && r.tools !== null);
      if (unconditional !== undefined) {
        hidden.push({ tool: t.name, ruleId: unconditional.id, reason: unconditional.reason ?? 'Denied by policy' });
        continue;
      }
      if (this.document.defaults[t.risk] === 'deny' && !rules.some((r) => r.then !== 'deny' && r.tools !== null)) {
        hidden.push({ tool: t.name, ruleId: `default:${t.risk}`, reason: `'${t.risk}' actions are denied by default` });
        continue;
      }
      visible.push(t);
    }
    return { visible, hidden };
  }

  approvalTtlMs(): number {
    return (this.document.approvalTtlHours ?? 72) * 3600 * 1000;
  }

  private limitDecision(input: PolicyInput): { ruleId: string; reason: string } | null {
    const limits = this.document.limits;
    const { tool, run, tenant } = input;
    if (EMAIL_TOOLS.has(tool.name)) {
      if (limits.emailsPerRun !== undefined && run.emailsSent + 1 > limits.emailsPerRun)
        return { ruleId: 'limit:emailsPerRun', reason: `At most ${limits.emailsPerRun} emails per run` };
      if (limits.emailsPerDay !== undefined && tenant.emailsToday + 1 > limits.emailsPerDay)
        return { ruleId: 'limit:emailsPerDay', reason: `At most ${limits.emailsPerDay} emails per day` };
    }
    if (tool.risk === 'external' || tool.risk === 'irreversible') {
      if (limits.externalActionsPerRun !== undefined && run.externalCount + 1 > limits.externalActionsPerRun)
        return {
          ruleId: 'limit:externalActionsPerRun',
          reason: `At most ${limits.externalActionsPerRun} external actions per run`,
        };
      if (limits.externalActionsPerDay !== undefined && tenant.externalToday + 1 > limits.externalActionsPerDay)
        return {
          ruleId: 'limit:externalActionsPerDay',
          reason: `At most ${limits.externalActionsPerDay} external actions per day`,
        };
    }
    if (
      tool.risk === 'write_reversible' &&
      limits.writesPerRun !== undefined &&
      run.writeCount + 1 > limits.writesPerRun
    )
      return { ruleId: 'limit:writesPerRun', reason: `At most ${limits.writesPerRun} changes per run` };
    return null;
  }

  async evaluate(input: PolicyInput, host: PolicyHost, now: () => Date = () => new Date()): Promise<PolicyEvaluation> {
    const scope = requiredScope(input.tool.name, input.tool.risk);
    const base = {
      policyVersion: this.version,
      warnings: [] as string[],
      taint: [] as TaintFinding[],
    };
    let record = input.record ?? null;
    const rules = this.rulesFor(input.tool.name);
    if (record === null && host.loadRecord !== undefined && rules.some((r) => r.usesRecord))
      record = await host.loadRecord(input.tool.name, input.args).catch(() => null);
    const context = { run: input.run, tenant: input.tenant, record, userScopes: input.user.scopes };
    const trace: RuleTrace[] = this.rules.map((r) => ({
      id: r.id,
      then: r.then,
      applicable: r.tools === null || r.tools.includes(input.tool.name),
      matched: false,
      error: null,
    }));
    if (!input.user.scopes.includes(scope)) {
      return {
        ...base,
        decision: 'deny',
        ruleId: 'user-permission',
        reasons: [`The user lacks the '${scope}' permission in the business system`],
        matchedRules: [{ id: 'user-permission', then: 'deny', reason: `missing scope ${scope}` }],
        trace,
        context,
      };
    }
    const limit = this.limitDecision(input);
    if (limit !== null) {
      return {
        ...base,
        decision: 'deny',
        ruleId: limit.ruleId,
        reasons: [limit.reason],
        matchedRules: [{ id: limit.ruleId, then: 'deny', reason: limit.reason }],
        trace,
        context,
      };
    }
    const vars = {
      tool: { name: input.tool.name, risk: input.tool.risk },
      run: input.run,
      user: input.user,
      tenant: input.tenant,
      record: record ?? null,
    };
    const matched: MatchedRule[] = [];
    for (const rule of rules) {
      const t = trace.find((x) => x.id === rule.id) as RuleTrace;
      if (rule.when === null) {
        t.matched = true;
        matched.push({ id: rule.id, then: rule.then, reason: rule.reason });
        continue;
      }
      if (rule.lowered === null) {
        t.error = 'invalid condition';
        if (rule.then !== 'allow') {
          t.matched = true;
          matched.push({
            id: rule.id,
            then: rule.then,
            reason: `${rule.reason ?? rule.id} (condition invalid, failing closed)`,
          });
        }
        continue;
      }
      const recipients = rule.usesArgsTo && RECIPIENT_TOOLS.has(input.tool.name) ? recipientsOf(input.args) : [];
      const variants = recipients.length > 1 ? recipients.map((to) => ({ ...input.args, to })) : [input.args];
      let hit = false;
      for (const args of variants) {
        try {
          const v = await evaluateLowered(rule.lowered, { ...vars, args }, host, now);
          if (v === true) {
            hit = true;
            break;
          }
        } catch (error) {
          t.error = (error as Error).message;
          if (rule.then !== 'allow') {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        t.matched = true;
        matched.push({
          id: rule.id,
          then: rule.then,
          reason:
            t.error === null ? rule.reason : `${rule.reason ?? rule.id} (condition failed: ${t.error}; failing closed)`,
        });
      }
    }
    let decision: Decision = this.document.defaults[input.tool.risk];
    let ruleId = `default:${input.tool.risk}`;
    let reasons = [`Default for '${input.tool.risk}' actions`];
    if (matched.length > 0) {
      const top = matched.reduce((a, b) => (DECISION_RANK[b.then] > DECISION_RANK[a.then] ? b : a));
      decision = top.then;
      ruleId = top.id;
      reasons = matched.filter((m) => m.then === top.then).map((m) => m.reason ?? m.id);
    }
    return { ...base, decision, ruleId, reasons, matchedRules: matched, trace, context };
  }

  summary(): string[] {
    const lines: string[] = [];
    for (const [risk, d] of Object.entries(this.document.defaults)) lines.push(`Default for ${risk} actions: ${d}`);
    for (const r of this.rules)
      lines.push(
        `Rule ${r.id}${r.tools ? ` (${r.tools.join(', ')})` : ''}: ${r.then}${r.when ? ` when ${r.when}` : ''}${r.reason ? ` — ${r.reason}` : ''}`,
      );
    for (const [k, v] of Object.entries(this.document.limits)) lines.push(`Limit ${k}: ${v}`);
    return lines;
  }
}

export interface CompileResult {
  policy: CompiledPolicy | null;
  diagnostics: PolicyDiagnostic[];
}

export function compilePolicy(source: string | PolicyDocument, version: number): CompileResult {
  if (typeof source === 'string') {
    const parsed = parsePolicyYaml(source);
    if (parsed.document === null || parsed.diagnostics.some((d) => d.severity === 'error'))
      return { policy: null, diagnostics: parsed.diagnostics };
    const { rules } = compileRules(parsed.document);
    return { policy: new CompiledPolicy(version, parsed.document, rules, source), diagnostics: parsed.diagnostics };
  }
  const { rules, diagnostics } = compileRules(source);
  if (diagnostics.some((d) => d.severity === 'error')) return { policy: null, diagnostics };
  return { policy: new CompiledPolicy(version, source, rules, null), diagnostics };
}

export function applyTaint(decision: PolicyEvaluation, findings: TaintFinding[]): PolicyEvaluation {
  if (findings.length === 0) return decision;
  const warning = `argument originates from untrusted content: ${findings
    .slice(0, 3)
    .map((f) => `"${f.fragment}" (from ${f.source.tool} ${f.source.path})`)
    .join(', ')}`;
  if (decision.decision === 'allow')
    return {
      ...decision,
      decision: 'require_approval',
      ruleId: 'taint:untrusted-argument',
      reasons: ['An argument originates from untrusted content'],
      matchedRules: [
        ...decision.matchedRules,
        { id: 'taint:untrusted-argument', then: 'require_approval', reason: warning },
      ],
      warnings: [...decision.warnings, warning],
      taint: findings,
    };
  return { ...decision, warnings: [...decision.warnings, warning], taint: findings };
}
