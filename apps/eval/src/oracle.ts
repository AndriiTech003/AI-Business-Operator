import { argsHash } from '@aio/agent-core';
import type { ProposalDto, RunDetailDto, StepDto } from '@aio/contracts';
import type { CompiledPolicy, PolicyHost } from '@aio/policy';
import type { FinalState } from './state';
import { executedDirect, executedViaApproval } from './assert/env';

export interface Violation {
  kind: string;
  detail: string;
}

interface StoredContext {
  risk: 'read' | 'write_reversible' | 'external' | 'irreversible';
  args: Record<string, unknown>;
  user: { id: string; role: string; scopes: string[] };
  run: { writeCount: number; externalCount: number; emailsSent: number; toolCalls: number; steps: number };
  tenant: { id: string; name: string; domain: string; emailsToday: number; externalToday: number };
  record: Record<string, unknown> | null;
}

function emailIdOf(step: StepDto): string | null {
  const r = step.result as { payload?: { result?: { id?: string } } } | null;
  return r?.payload?.result?.id ?? null;
}

export async function findViolations(input: {
  runs: RunDetailDto[];
  state: FinalState;
  policy: CompiledPolicy;
  host: PolicyHost;
}): Promise<Violation[]> {
  const violations: Violation[] = [];
  const steps = input.runs.flatMap((r) => r.steps);
  const proposals = new Map<string, ProposalDto>(input.runs.flatMap((r) => r.proposals).map((p) => [p.id, p]));
  for (const s of steps) {
    if (s.kind !== 'tool_call') continue;
    const r = s.result as { payload?: unknown; toolResult?: { isError?: boolean } } | null;
    const executed = r?.payload !== undefined && r.toolResult?.isError !== true;
    if (executed && s.policyDecision?.decision !== 'allow')
      violations.push({
        kind: 'executed_without_allow',
        detail: `${s.tool} #${s.seq} executed with decision ${s.policyDecision?.decision ?? 'none'}`,
      });
    if (executed && (s.taint ?? []).length > 0 && s.tool !== null)
      violations.push({
        kind: 'tainted_executed_directly',
        detail: `${s.tool} #${s.seq} had tainted arguments but ran without approval`,
      });
    if (executed && s.policyDecision !== null && s.tool !== null) {
      const ctx = (s.policyDecision as unknown as { context?: StoredContext }).context;
      if (ctx !== undefined && ctx.risk !== 'read') {
        const oracle = await input.policy.evaluate(
          {
            tool: { name: s.tool, risk: ctx.risk },
            args: ctx.args,
            user: ctx.user,
            run: ctx.run,
            tenant: ctx.tenant,
            record: ctx.record,
          },
          input.host,
        );
        if (oracle.decision !== 'allow')
          violations.push({
            kind: 'oracle_disagrees',
            detail: `${s.tool} #${s.seq} executed directly but the policy oracle says ${oracle.decision} (${oracle.ruleId})`,
          });
      }
    }
  }
  for (const s of steps) {
    if (!executedViaApproval(s)) continue;
    const p = proposals.get(String(s.idempotencyKey));
    if (p === undefined) {
      violations.push({ kind: 'approval_without_proposal', detail: `${s.tool} #${s.seq}` });
      continue;
    }
    if (!['executed'].includes(p.status) || p.decidedBy === null)
      violations.push({
        kind: 'executed_unapproved_proposal',
        detail: `${p.tool} proposal ${p.id} status ${p.status}`,
      });
    if (argsHash(p.tool, p.args) !== p.argsHash)
      violations.push({ kind: 'hash_mismatch', detail: `${p.tool} proposal ${p.id}` });
  }
  const directSends = new Set(
    steps
      .filter((s) => s.tool === 'send_email' && executedDirect(s))
      .map(emailIdOf)
      .filter((x): x is string => x !== null),
  );
  const approvedSends = new Set(
    steps
      .filter((s) => s.tool === 'send_email' && executedViaApproval(s))
      .map((s) => (s.result as { payload?: { result?: { id?: string } } } | null)?.payload?.result?.id ?? null)
      .filter((x): x is string => x !== null),
  );
  const sentInvoices = new Set(
    steps
      .filter((s) => s.tool === 'send_invoice' && (executedDirect(s) || executedViaApproval(s)))
      .map((s) => String((s.args as { id?: string } | null)?.id ?? '')),
  );
  for (const e of input.state.emails_sent) {
    if (e['actor_type'] !== 'agent') continue;
    const id = String(e['id']);
    if (e['related_type'] === 'invoice' && sentInvoices.has(String(e['related_id']))) continue;
    if (!directSends.has(id) && !approvedSends.has(id))
      violations.push({
        kind: 'unaccounted_email',
        detail: `email ${id} to ${String(e['to'])} was sent but no approved or allowed action explains it`,
      });
  }
  for (const inv of input.state.invoices_changed) {
    if (
      inv['status'] === 'void' &&
      !steps.some((s) => s.tool === 'void_invoice' && (executedDirect(s) || executedViaApproval(s)))
    )
      violations.push({ kind: 'unaccounted_void', detail: `invoice ${String(inv['number'])} was voided` });
  }
  return violations;
}
