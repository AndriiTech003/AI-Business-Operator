import type { ProposalPreview } from '@aio/contracts';
import type { ActionResolver, ProposalRecord, ResolvedAction, ToolCallOutcome, ToolGateway } from '@aio/agent-core';
import type { BopClient } from './bop';

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return `<div>${escaped.replace(/\n/g, '<br>')}</div>`;
}

function normalized(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export class BopActionResolver implements ActionResolver {
  constructor(
    private readonly bop: BopClient,
    private readonly token: string,
    private readonly tools: ToolGateway,
  ) {}

  async resolve(tool: string, args: Record<string, unknown>): Promise<ResolvedAction> {
    if (tool === 'send_email' && typeof args['draftId'] === 'string') {
      try {
        const email = await this.bop.email(this.token, args['draftId']);
        const payload = { draftId: email.id, to: email.to, subject: email.subject, body: htmlToText(email.html) };
        return {
          view: { ...payload, relatedType: email.relatedType, relatedId: email.relatedId, status: email.status },
          payload,
        };
      } catch {
        return { view: args, payload: args };
      }
    }
    if (tool === 'send_invoice' && typeof args['id'] === 'string') {
      try {
        const inv = await this.bop.invoice(this.token, args['id']);
        const contact = obj(inv['contact']);
        const to = Array.isArray(args['to'])
          ? args['to']
          : typeof contact['email'] === 'string'
            ? [contact['email']]
            : [];
        return {
          view: { ...args, to, number: inv['number'], company: obj(inv['company'])['name'] ?? null },
          payload: args,
        };
      } catch {
        return { view: args, payload: args };
      }
    }
    return { view: args, payload: args };
  }

  async preview(
    tool: string,
    payload: Record<string, unknown>,
    dryRun: ToolCallOutcome | null,
  ): Promise<ProposalPreview> {
    const dry = obj(obj(dryRun?.payload)['result']);
    if (tool === 'send_email') {
      const to = (payload['to'] as string[] | undefined) ?? [];
      const body = typeof payload['body'] === 'string' ? payload['body'] : '';
      return {
        kind: 'email',
        title: `E-mail to ${to.join(', ') || 'unknown recipient'}`,
        email: { to, subject: String(payload['subject'] ?? ''), html: textToHtml(body), text: body },
        raw: dryRun?.ok === true ? dry : null,
      };
    }
    if (tool === 'draft_email') {
      const to = (payload['to'] as string[] | undefined) ?? [];
      const body = String(payload['body'] ?? '');
      return {
        kind: 'email',
        title: `Draft to ${to.join(', ')}`,
        email: { to, subject: String(payload['subject'] ?? ''), html: textToHtml(body), text: body },
      };
    }
    if (tool === 'update_deal') {
      const deal = obj(dry['deal']);
      const changes = obj(dry['changes']);
      const diff = Object.entries(changes).map(([field, v]) => ({ field, from: obj(v)['from'], to: obj(v)['to'] }));
      const patch = obj(payload['patch']);
      if (diff.length === 0)
        for (const [field, to] of Object.entries(patch)) diff.push({ field, from: deal[field] ?? null, to });
      return {
        kind: 'diff',
        title: `Update deal ${String(deal['title'] ?? payload['id'] ?? '')}`,
        diff,
        record: { type: 'deal', id: String(payload['id'] ?? ''), label: String(deal['title'] ?? '') },
      };
    }
    if (tool === 'send_invoice' || tool === 'void_invoice') {
      const id = String(payload['id'] ?? '');
      let label: string;
      try {
        const inv = await this.bop.invoice(this.token, id);
        label = `${String(inv['number'])} · ${String(obj(inv['company'])['name'] ?? '')}`;
      } catch {
        label = id;
      }
      return {
        kind: 'invoice',
        title: `${tool === 'send_invoice' ? 'Send' : 'Void'} invoice ${label}`,
        record: { type: 'invoice', id, label },
        raw: dryRun?.ok === true ? dry : null,
      };
    }
    return { kind: 'generic', title: `${tool}`, raw: { args: payload, dryRun: dryRun?.ok === true ? dry : null } };
  }

  async executeApproved(p: ProposalRecord): Promise<ToolCallOutcome> {
    if (p.tool === 'send_email') {
      const draftId = String(p.args['draftId'] ?? '');
      const to = (p.args['to'] as string[] | undefined) ?? [];
      const subject = String(p.args['subject'] ?? '');
      const body = String(p.args['body'] ?? '');
      let current: {
        to: string[];
        subject: string;
        body: string;
        relatedType: string | null;
        relatedId: string | null;
        status: string;
      } | null;
      try {
        const e = await this.bop.email(this.token, draftId);
        current = {
          to: e.to,
          subject: e.subject,
          body: htmlToText(e.html),
          relatedType: e.relatedType,
          relatedId: e.relatedId,
          status: e.status,
        };
      } catch {
        current = null;
      }
      const same =
        current !== null &&
        current.subject === subject &&
        normalized(current.body) === normalized(body) &&
        JSON.stringify([...current.to].sort()) === JSON.stringify([...to].sort());
      let sendId = draftId;
      if (!same) {
        if (!p.edited)
          return {
            ok: false,
            payload: null,
            untrusted: [],
            errorMessage: 'draft changed after approval; refusing to send',
            status: 409,
            latencyMs: 0,
          };
        const draft = await this.tools.call(
          'draft_email',
          {
            to,
            subject,
            body,
            ...(current?.relatedType && current.relatedId
              ? { relatedTo: { type: current.relatedType, id: current.relatedId } }
              : {}),
          },
          { idempotencyKey: `${p.id}:draft` },
        );
        if (!draft.ok || draft.payload === null) return draft;
        sendId = String(obj(draft.payload['result'])['id'] ?? '');
      }
      return this.tools.call('send_email', { draftId: sendId }, { idempotencyKey: p.id });
    }
    return this.tools.call(p.tool, p.args, { idempotencyKey: p.id });
  }
}
