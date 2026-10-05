import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PolicyDecision, PolicyDocument, PolicyOverrides, Risk, ToolDescriptor } from '@aio/contracts';
import type { HiddenToolInfo, PolicyEvaluationInput, PolicyGateway } from '@aio/agent-core';
import {
  CompiledPolicy,
  DEFAULT_POLICY_YAML,
  compilePolicy,
  type PolicyDiagnostic,
  type PolicyEvaluation,
  type PolicyHost,
  type PolicyInput,
} from '@aio/policy';
import type { Db } from '../db/client';
import { agentRuns, agentSteps, policies } from '../db/schema';
import type { BopClient } from './bop';

export const STATIC_RISKS: Record<string, Risk> = {
  search_records: 'read',
  get_company: 'read',
  get_contact: 'read',
  get_deal: 'read',
  get_invoice: 'read',
  list_contacts: 'read',
  list_deals: 'read',
  list_invoices: 'read',
  get_report: 'read',
  create_task: 'write_reversible',
  add_note: 'write_reversible',
  update_deal: 'write_reversible',
  draft_email: 'write_reversible',
  send_email: 'external',
  send_invoice: 'external',
  void_invoice: 'irreversible',
};

export class PolicyValidationError extends Error {
  constructor(readonly diagnostics: PolicyDiagnostic[]) {
    super(
      diagnostics.map((d) => `${d.line !== null ? `${d.line}:${d.col ?? 0} ` : ''}${d.path} ${d.message}`).join('; '),
    );
  }
}

export interface PolicyCounters {
  emailsToday(tenantId: string, timezone: string): Promise<number>;
  externalToday(tenantId: string, timezone: string): Promise<number>;
}

export class DbPolicyCounters implements PolicyCounters {
  constructor(private readonly db: Db) {}

  private async count(tenantId: string, timezone: string, onlyEmail: boolean): Promise<number> {
    const res = await this.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM agent_steps s JOIN agent_runs r ON r.id = s.run_id
      WHERE r.tenant_id = ${tenantId}::uuid
        AND s.created_at >= (date_trunc('day', now() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone})
        AND ${onlyEmail ? sql`s.tool = 'send_email'` : sql`s.tool IN ('send_email', 'send_invoice', 'void_invoice')`}
        AND ((s.kind = 'tool_call' AND (s.policy_decision->>'decision') = 'allow' AND coalesce((s.result->'toolResult'->>'isError')::boolean, false) = false)
          OR (s.kind = 'approval' AND (s.result->>'status') = 'executed'))`);
    return Number(res.rows[0]?.n ?? 0);
  }

  emailsToday(tenantId: string, timezone: string): Promise<number> {
    return this.count(tenantId, timezone, true);
  }

  externalToday(tenantId: string, timezone: string): Promise<number> {
    return this.count(tenantId, timezone, false);
  }
}

export function applyOverrides(doc: PolicyDocument, overrides: PolicyOverrides | null | undefined): PolicyDocument {
  if (!overrides?.defaults) return doc;
  return { ...doc, defaults: { ...doc.defaults, ...overrides.defaults } };
}

export class PolicyService {
  private readonly cache = new Map<string, CompiledPolicy>();

  constructor(private readonly db: Db) {}

  async current(
    tenantId: string,
    createdBy: string | null = null,
  ): Promise<{ version: number; source: string; policy: CompiledPolicy }> {
    const [row] = await this.db
      .select()
      .from(policies)
      .where(eq(policies.tenantId, tenantId))
      .orderBy(desc(policies.version))
      .limit(1);
    if (row === undefined) {
      const saved = await this.save(tenantId, DEFAULT_POLICY_YAML, createdBy);
      return { version: saved.version, source: DEFAULT_POLICY_YAML, policy: saved.policy };
    }
    return { version: row.version, source: row.source, policy: this.compiled(tenantId, row.version, row.source) };
  }

  compiled(tenantId: string, version: number, source: string): CompiledPolicy {
    const key = `${tenantId}:${version}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const { policy, diagnostics } = compilePolicy(source, version);
    if (policy === null) throw new PolicyValidationError(diagnostics);
    this.cache.set(key, policy);
    return policy;
  }

  async version(tenantId: string, version: number): Promise<CompiledPolicy> {
    const key = `${tenantId}:${version}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const [row] = await this.db
      .select()
      .from(policies)
      .where(and(eq(policies.tenantId, tenantId), eq(policies.version, version)));
    if (row === undefined) throw new Error(`policy v${version} not found`);
    return this.compiled(tenantId, version, row.source);
  }

  async versions(
    tenantId: string,
  ): Promise<Array<{ version: number; createdAt: string; createdBy: string | null; source: string }>> {
    const rows = await this.db
      .select()
      .from(policies)
      .where(eq(policies.tenantId, tenantId))
      .orderBy(desc(policies.version));
    return rows.map((r) => ({
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
      source: r.source,
    }));
  }

  validate(source: string): { ok: boolean; diagnostics: PolicyDiagnostic[]; policy: CompiledPolicy | null } {
    const { policy, diagnostics } = compilePolicy(source, 0);
    return { ok: policy !== null, diagnostics, policy };
  }

  async save(
    tenantId: string,
    source: string,
    createdBy: string | null,
    baseVersion?: number,
  ): Promise<{ version: number; policy: CompiledPolicy; diagnostics: PolicyDiagnostic[] }> {
    const { policy, diagnostics } = compilePolicy(source, 0);
    if (policy === null) throw new PolicyValidationError(diagnostics);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`policy:${tenantId}`}))`);
      const [last] = await tx
        .select({ v: policies.version })
        .from(policies)
        .where(eq(policies.tenantId, tenantId))
        .orderBy(desc(policies.version))
        .limit(1);
      const current = last?.v ?? 0;
      if (baseVersion !== undefined && baseVersion !== current)
        throw new PolicyValidationError([
          {
            severity: 'error',
            path: '',
            message: `policy changed: current version is ${current}, you edited ${baseVersion}`,
            line: null,
            col: null,
          },
        ]);
      const version = current + 1;
      await tx
        .insert(policies)
        .values({ tenantId, version, document: { ...policy.document, version }, source, createdBy });
      const compiled = new CompiledPolicy(version, { ...policy.document, version }, policy.rules, source);
      this.cache.set(`${tenantId}:${version}`, compiled);
      return { version, policy: compiled, diagnostics };
    });
  }

  async replay(
    tenantId: string,
    candidate: CompiledPolicy,
    lastRuns: number,
    host: PolicyHost,
  ): Promise<{
    runs: number;
    actions: number;
    changed: Array<{
      runId: string;
      goal: string;
      seq: number;
      tool: string;
      before: { decision: string; ruleId: string };
      after: { decision: string; ruleId: string };
    }>;
    summary: Record<string, number>;
  }> {
    const runs = await this.db
      .select({ id: agentRuns.id, goal: agentRuns.goal })
      .from(agentRuns)
      .where(eq(agentRuns.tenantId, tenantId))
      .orderBy(desc(agentRuns.createdAt))
      .limit(lastRuns);
    if (runs.length === 0) return { runs: 0, actions: 0, changed: [], summary: {} };
    const steps = await this.db
      .select()
      .from(agentSteps)
      .where(
        and(
          inArray(
            agentSteps.runId,
            runs.map((r) => r.id),
          ),
          eq(agentSteps.kind, 'tool_call'),
        ),
      );
    const goals = new Map(runs.map((r) => [r.id, r.goal]));
    const changed: Array<{
      runId: string;
      goal: string;
      seq: number;
      tool: string;
      before: { decision: string; ruleId: string };
      after: { decision: string; ruleId: string };
    }> = [];
    const summary: Record<string, number> = {};
    let actions = 0;
    for (const s of steps) {
      const decision = s.policyDecision as (PolicyDecision & { context?: ReplayContext }) | null;
      if (decision === null || decision.context === undefined || s.tool === null) continue;
      actions += 1;
      const ctx = decision.context;
      const result = await candidate.evaluate(
        {
          tool: { name: s.tool, risk: ctx.risk },
          args: ctx.args,
          user: ctx.user,
          run: ctx.run,
          tenant: ctx.tenant,
          record: ctx.record,
        },
        host,
      );
      const before = ctx.policyOnly;
      if (before.decision !== result.decision || before.ruleId !== result.ruleId) {
        changed.push({
          runId: s.runId,
          goal: goals.get(s.runId) ?? '',
          seq: s.seq,
          tool: s.tool,
          before,
          after: { decision: result.decision, ruleId: result.ruleId },
        });
        const key = `${before.decision}→${result.decision}`;
        summary[key] = (summary[key] ?? 0) + 1;
      }
    }
    changed.sort((a, b) => a.runId.localeCompare(b.runId) || a.seq - b.seq);
    return { runs: runs.length, actions, changed, summary };
  }
}

export interface ReplayContext {
  risk: Risk;
  args: Record<string, unknown>;
  user: PolicyInput['user'];
  run: PolicyInput['run'];
  tenant: PolicyInput['tenant'];
  record: Record<string, unknown> | null;
  policyOnly: { decision: string; ruleId: string };
}

export interface RunPolicyContext {
  user: { id: string; role: string; scopes: string[] };
  tenant: { id: string; name: string; domain: string; timezone: string };
  token: string;
}

export class AgentPolicyGateway implements PolicyGateway {
  private readonly contacts = new Map<string, boolean>();

  constructor(
    private readonly policy: CompiledPolicy,
    private readonly ctx: RunPolicyContext,
    private readonly bop: BopClient,
    private readonly counters: PolicyCounters,
    private readonly now: () => Date,
  ) {}

  get version(): number {
    return this.policy.version;
  }

  host(): PolicyHost {
    return {
      contactExists: async (email: string) => {
        const key = email.toLowerCase();
        const hit = this.contacts.get(key);
        if (hit !== undefined) return hit;
        const exists = await this.bop.contactExists(this.ctx.token, key).catch(() => false);
        this.contacts.set(key, exists);
        return exists;
      },
      loadRecord: async (tool: string, args: Record<string, unknown>) => {
        if (tool === 'update_deal' && typeof args['id'] === 'string') return this.bop.deal(this.ctx.token, args['id']);
        if ((tool === 'send_invoice' || tool === 'void_invoice') && typeof args['id'] === 'string')
          return this.bop.invoice(this.ctx.token, args['id']);
        return null;
      },
    };
  }

  visibility(tools: ToolDescriptor[]): { visible: ToolDescriptor[]; hidden: HiddenToolInfo[] } {
    return this.policy.visibleTools(tools, { scopes: this.ctx.user.scopes });
  }

  approvalSummary(): string[] {
    const out: string[] = [];
    for (const [risk, d] of Object.entries(this.policy.document.defaults))
      if (d === 'require_approval') out.push(`all ${risk} actions (default)`);
    for (const r of this.policy.rules)
      if (r.then === 'require_approval')
        out.push(`${r.tools ? r.tools.join('/') : 'any tool'}: ${r.reason ?? r.id} (rule ${r.id})`);
    return out;
  }

  approvalTtlMs(): number {
    return this.policy.approvalTtlMs();
  }

  async evaluate(input: PolicyEvaluationInput): Promise<PolicyDecision & { context?: unknown }> {
    const tenant = {
      id: this.ctx.tenant.id,
      name: this.ctx.tenant.name,
      domain: this.ctx.tenant.domain,
      emailsToday: await this.counters.emailsToday(this.ctx.tenant.id, this.ctx.tenant.timezone),
      externalToday: await this.counters.externalToday(this.ctx.tenant.id, this.ctx.tenant.timezone),
    };
    const run = {
      writeCount: input.usage.writeCount,
      externalCount: input.usage.externalActions,
      emailsSent: input.usage.emailsSent,
      toolCalls: input.usage.toolCalls,
      steps: input.usage.steps,
    };
    const evaluation: PolicyEvaluation = await this.policy.evaluate(
      { tool: { name: input.tool.name, risk: input.tool.risk }, args: input.args, user: this.ctx.user, run, tenant },
      this.host(),
      this.now,
    );
    const context: ReplayContext = {
      risk: input.tool.risk,
      args: input.args,
      user: this.ctx.user,
      run,
      tenant,
      record: evaluation.context.record,
      policyOnly: { decision: evaluation.decision, ruleId: evaluation.ruleId },
    };
    return {
      decision: evaluation.decision,
      ruleId: evaluation.ruleId,
      reasons: evaluation.reasons,
      matchedRules: evaluation.matchedRules,
      warnings: evaluation.warnings,
      policyVersion: evaluation.policyVersion,
      taint: [],
      context,
    };
  }
}
