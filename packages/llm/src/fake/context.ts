import { createHash } from 'node:crypto';
import { canonicalJson, type ChatMessage, type ToolUseBlock } from '@aio/contracts';
import type { LlmRequest } from '../types';

export interface TeamMember {
  name: string;
  email: string;
  role: string;
  id: string;
}

export interface SystemInfo {
  user: TeamMember;
  now: Date;
  timezone: string;
  company: string;
  domain: string;
  team: TeamMember[];
  instructions: string;
  blocked: Array<{ tool: string; ruleId: string; reason: string }>;
  approvalRules: string[];
  record: { type: string; id: string; label: string | null } | null;
}

export type Outcome =
  | { kind: 'ok'; data: unknown; untrusted: string[]; text: string }
  | { kind: 'error'; message: string; status: number | null }
  | { kind: 'denied'; ruleId: string; reason: string }
  | { kind: 'pending'; proposalId: string; ruleId: string; reason: string; warnings: string[] }
  | { kind: 'budget'; message: string }
  | { kind: 'compacted' };

export interface CallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  key: string;
  outcome: Outcome | null;
  turn: number;
}

export interface ApprovalOutcomeView {
  proposalId: string;
  tool: string;
  status: 'executed' | 'rejected' | 'expired' | 'failed';
  edited: boolean;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface ConversationInfo {
  goal: string;
  followUps: string[];
  interventions: string[];
  calls: CallRecord[];
  approvals: ApprovalOutcomeView[];
  approvalBatches: number;
  budgetNotice: string | null;
  turn: number;
  toolsAvailable: Set<string>;
  noTools: boolean;
}

function section(system: string, name: string): string[] {
  const lines = system.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i] as string;
    if (l.startsWith('## ')) break;
    out.push(l);
  }
  return out;
}

function field(lines: string[], key: string): string {
  const l = lines.find((x) => x.startsWith(`${key}:`));
  return l === undefined ? '' : l.slice(key.length + 1).trim();
}

export function parseSystem(system: string): SystemInfo {
  const user = section(system, 'Current user');
  const time = section(system, 'Time');
  const company = section(system, 'Company');
  const team = section(system, 'Team')
    .filter((l) => l.startsWith('- '))
    .map((l) => {
      const [name, email, role, id] = l
        .slice(2)
        .split('|')
        .map((s) => s.trim());
      return { name: name ?? '', email: email ?? '', role: role ?? '', id: id ?? '' };
    });
  const policy = section(system, 'Policy');
  const blocked: SystemInfo['blocked'] = [];
  const approvalRules: string[] = [];
  let mode: 'none' | 'approval' | 'blocked' = 'none';
  for (const l of policy) {
    if (l.startsWith('Actions that need human approval')) mode = 'approval';
    else if (l.startsWith('Blocked tools')) mode = 'blocked';
    else if (l.startsWith('- ') && mode === 'approval') approvalRules.push(l.slice(2));
    else if (l.startsWith('- ') && mode === 'blocked') {
      const m = /^- ([a-z_]+): rule (\S+) — (.*)$/.exec(l);
      if (m) blocked.push({ tool: m[1] as string, ruleId: m[2] as string, reason: m[3] as string });
    }
  }
  const record = section(system, 'Record context');
  const instructions = section(system, 'Tenant instructions').join('\n').trim();
  return {
    user: { name: field(user, 'name'), email: field(user, 'email'), role: field(user, 'role'), id: field(user, 'id') },
    now: new Date(field(time, 'now') || Date.now()),
    timezone: field(time, 'timezone') || 'UTC',
    company: field(company, 'name'),
    domain: field(company, 'domain'),
    team,
    instructions: instructions === '(none)' ? '' : instructions,
    blocked,
    approvalRules,
    record:
      record.length > 0
        ? { type: field(record, 'type'), id: field(record, 'id'), label: field(record, 'label') || null }
        : null,
  };
}

export function parseToolResult(content: string, isError: boolean): Outcome {
  const trimmed = content.trim();
  if (trimmed.startsWith('blocked by policy ')) {
    const m = /^blocked by policy (\S+): (.*)$/s.exec(trimmed);
    return { kind: 'denied', ruleId: m?.[1] ?? 'unknown', reason: m?.[2] ?? trimmed };
  }
  if (trimmed.startsWith('budget exhausted')) return { kind: 'budget', message: trimmed };
  if (trimmed.startsWith('<tool_result')) {
    if (/compacted="true"/.test(trimmed.slice(0, 200))) return { kind: 'compacted' };
    const body = trimmed.slice(trimmed.indexOf('\n') + 1, trimmed.lastIndexOf('</tool_result>')).trim();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return isError
        ? { kind: 'error', message: body, status: null }
        : { kind: 'ok', data: body, untrusted: [], text: body };
    }
    if (json['status'] === 'pending_approval')
      return {
        kind: 'pending',
        proposalId: String(json['proposalId']),
        ruleId: String(json['ruleId']),
        reason: String(json['reason'] ?? ''),
        warnings: (json['warnings'] as string[] | undefined) ?? [],
      };
    if (isError || json['error'] !== undefined) {
      const message = String(json['error'] ?? body);
      const status =
        typeof json['status'] === 'number'
          ? (json['status'] as number)
          : /^(\d{3}) /.exec(message)
            ? Number(/^(\d{3}) /.exec(message)?.[1])
            : null;
      return { kind: 'error', message, status };
    }
    return {
      kind: 'ok',
      data: json['result'] ?? json,
      untrusted: (json['untrusted'] as string[] | undefined) ?? [],
      text: body,
    };
  }
  return isError
    ? { kind: 'error', message: trimmed, status: null }
    : { kind: 'ok', data: trimmed, untrusted: [], text: trimmed };
}

export function callKey(name: string, input: Record<string, unknown>): string {
  return `${name}:${canonicalJson(input)}`;
}

export function toolUseId(turn: number, index: number, name: string, input: Record<string, unknown>): string {
  return `toolu_${createHash('sha256')
    .update(`${turn}|${index}|${callKey(name, input)}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function textBlocks(m: ChatMessage): string[] {
  return m.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
}

export function parseConversation(request: LlmRequest): ConversationInfo {
  const calls: CallRecord[] = [];
  const byId = new Map<string, CallRecord>();
  const followUps: string[] = [];
  const interventions: string[] = [];
  const approvals: ApprovalOutcomeView[] = [];
  let approvalBatches = 0;
  let budgetNotice: string | null = null;
  let goal = '';
  let turn = 0;
  request.messages.forEach((m, idx) => {
    if (m.role === 'assistant') {
      turn += 1;
      for (const b of m.content)
        if (b.type === 'tool_use') {
          const tu = b as ToolUseBlock;
          const rec: CallRecord = {
            id: tu.id,
            name: tu.name,
            input: tu.input,
            key: callKey(tu.name, tu.input),
            outcome: null,
            turn,
          };
          calls.push(rec);
          byId.set(tu.id, rec);
        }
      return;
    }
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const rec = byId.get(b.toolUseId);
        if (rec) rec.outcome = parseToolResult(b.content, b.isError === true);
      }
    }
    for (const t of textBlocks(m)) {
      if (idx === 0 && goal === '') {
        goal = t;
        continue;
      }
      if (t.startsWith('<approval_results')) {
        approvalBatches += 1;
        const json = t.slice(t.indexOf('\n') + 1, t.indexOf('\n</approval_results>'));
        try {
          const parsed = JSON.parse(json) as { outcomes: ApprovalOutcomeView[] };
          approvals.push(...parsed.outcomes);
        } catch {
          continue;
        }
      } else if (t.startsWith('<system_notice type="budget_exhausted"')) budgetNotice = t.replace(/<[^>]+>/g, '');
      else if (t.startsWith('<user_intervention>')) interventions.push(t.replace(/<\/?user_intervention>/g, ''));
      else followUps.push(t);
    }
  });
  return {
    goal,
    followUps,
    interventions,
    calls,
    approvals,
    approvalBatches,
    budgetNotice,
    turn,
    toolsAvailable: new Set(request.tools.map((t) => t.name)),
    noTools: request.tools.length === 0,
  };
}
