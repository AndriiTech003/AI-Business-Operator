import type { ApprovalOutcomeView, CallRecord, ConversationInfo, Outcome, SystemInfo } from './context';
import { callKey } from './context';

export interface PlannedCall {
  name: string;
  input: Record<string, unknown>;
}

export class Need {
  constructor(
    readonly calls: PlannedCall[],
    readonly text: string,
  ) {}
}

export class NoTools {}

export type Json = Record<string, unknown>;

export function obj(v: unknown): Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

export function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0) || 0;
}

export function isOk(o: Outcome): o is Extract<Outcome, { kind: 'ok' }> {
  return o.kind === 'ok';
}

export function isTransient(o: Outcome): boolean {
  if (o.kind !== 'error') return false;
  if (o.status !== null && o.status >= 500) return true;
  return /\b(5\d\d|timeout|timed out|unavailable|ECONNRESET|ECONNREFUSED|fetch failed)\b/i.test(o.message);
}

export function isConflict(o: Outcome): boolean {
  return o.kind === 'error' && (o.status === 409 || /\b409\b|conflict|version/i.test(o.message));
}

export function isValidation(o: Outcome): boolean {
  return o.kind === 'error' && /validation|invalid arguments|-32602|\b400\b|\b422\b/i.test(o.message);
}

export class Helper {
  private readonly cursor = new Map<string, number>();

  constructor(
    readonly sys: SystemInfo,
    readonly conv: ConversationInfo,
  ) {}

  available(name: string): boolean {
    return this.conv.toolsAvailable.has(name);
  }

  blockedRule(name: string): { ruleId: string; reason: string } | null {
    const b = this.sys.blocked.find((x) => x.tool === name);
    return b === undefined ? null : { ruleId: b.ruleId, reason: b.reason };
  }

  private occurrence(name: string, input: Json): { record: CallRecord | null; key: string } {
    const key = callKey(name, input);
    const idx = this.cursor.get(key) ?? 0;
    this.cursor.set(key, idx + 1);
    const matches = this.conv.calls.filter((c) => c.key === key);
    return { record: matches[idx] ?? null, key };
  }

  call(name: string, input: Json, text = ''): Outcome {
    const { record } = this.occurrence(name, input);
    if (record !== null && record.outcome !== null) return record.outcome;
    if (record !== null) throw new Need([], text);
    if (this.conv.noTools) throw new NoTools();
    throw new Need([{ name, input }], text);
  }

  all(calls: PlannedCall[], text = ''): Outcome[] {
    const missing: PlannedCall[] = [];
    const out: Array<Outcome | null> = [];
    for (const c of calls) {
      const { record } = this.occurrence(c.name, c.input);
      if (record !== null && record.outcome !== null) out.push(record.outcome);
      else {
        out.push(null);
        if (record === null) missing.push(c);
      }
    }
    if (missing.length > 0 || out.some((o) => o === null)) {
      if (this.conv.noTools) throw new NoTools();
      throw new Need(missing, text);
    }
    return out as Outcome[];
  }

  retry(name: string, input: Json, text = '', maxRetries = 2): Outcome {
    let out = this.call(name, input, text);
    let attempts = 0;
    while (isTransient(out) && attempts < maxRetries) {
      attempts += 1;
      out = this.call(name, input, attempts === 1 ? 'The service returned an error; retrying.' : 'Retrying once more.');
    }
    return out;
  }

  listAll(name: string, input: Json, text = '', maxPages = 10): Outcome {
    let out = this.retry(name, input, text);
    if (!isOk(out)) return out;
    const items = [...arr(obj(out.data)['items'])];
    const untrusted = [...out.untrusted];
    let next = obj(out.data)['nextCursor'];
    let pages = 1;
    while (typeof next === 'string' && next !== '' && pages < maxPages) {
      out = this.retry(name, { ...input, cursor: next }, 'There are more results; fetching the next page.');
      if (!isOk(out)) return out;
      const offset = items.length;
      for (const p of out.untrusted)
        untrusted.push(p.replace(/^items\[(\d+)\]/, (_, i: string) => `items[${offset + Number(i)}]`));
      items.push(...arr(obj(out.data)['items']));
      next = obj(out.data)['nextCursor'];
      pages += 1;
    }
    return {
      kind: 'ok',
      data: { ...obj(out.data), items, nextCursor: typeof next === 'string' && next !== '' ? next : null },
      untrusted,
      text: out.text,
    };
  }

  data(o: Outcome): Json {
    return isOk(o) ? obj(o.data) : {};
  }

  approvals(): ApprovalOutcomeView[] {
    return this.conv.approvals;
  }

  approvalFor(proposalId: string): ApprovalOutcomeView | undefined {
    return this.conv.approvals.find((a) => a.proposalId === proposalId);
  }

  okResults(name: string): Array<{ input: Json; data: unknown; untrusted: string[] }> {
    return this.conv.calls
      .filter((c) => c.name === name && c.outcome !== null && c.outcome.kind === 'ok')
      .map((c) => ({
        input: c.input,
        data: (c.outcome as Extract<Outcome, { kind: 'ok' }>).data,
        untrusted: (c.outcome as Extract<Outcome, { kind: 'ok' }>).untrusted,
      }));
  }

  denied(): Array<{ name: string; input: Json; ruleId: string; reason: string }> {
    return this.conv.calls
      .filter((c) => c.outcome?.kind === 'denied')
      .map((c) => {
        const o = c.outcome as Extract<Outcome, { kind: 'denied' }>;
        return { name: c.name, input: c.input, ruleId: o.ruleId, reason: o.reason };
      });
  }

  pendings(): Array<{ name: string; input: Json; proposalId: string; ruleId: string; warnings: string[] }> {
    return this.conv.calls
      .filter((c) => c.outcome?.kind === 'pending')
      .map((c) => {
        const o = c.outcome as Extract<Outcome, { kind: 'pending' }>;
        return { name: c.name, input: c.input, proposalId: o.proposalId, ruleId: o.ruleId, warnings: o.warnings };
      });
  }

  userText(): string {
    return [this.conv.goal, ...this.conv.followUps, ...this.conv.interventions].join('\n');
  }

  latestFollowUp(): string | null {
    return this.conv.followUps.at(-1) ?? null;
  }

  member(name: string): { id: string; name: string; email: string } | null {
    const n = name.trim().toLowerCase();
    if (n === 'me' || n === 'myself') return this.sys.user;
    return (
      this.sys.team.find((m) => m.name.toLowerCase() === n) ??
      this.sys.team.find((m) => m.name.toLowerCase().split(' ')[0] === n.split(' ')[0]) ??
      null
    );
  }
}
