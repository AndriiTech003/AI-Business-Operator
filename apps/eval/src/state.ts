import pg from 'pg';

export interface FinalState {
  emails: Array<Record<string, unknown>>;
  emails_sent: Array<Record<string, unknown>>;
  emails_drafted: Array<Record<string, unknown>>;
  tasks_created: Array<Record<string, unknown>>;
  notes_added: Array<Record<string, unknown>>;
  deals: Array<Record<string, unknown>>;
  deals_changed: Array<Record<string, unknown>>;
  invoices: Array<Record<string, unknown>>;
  invoices_changed: Array<Record<string, unknown>>;
  approvals_inbox: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

export async function readFinalState(databaseUrl: string, tenantId: string, since: string): Promise<FinalState> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const q = async (sql: string, params: unknown[] = []) =>
      (await client.query(sql, params)).rows as Array<Record<string, unknown>>;
    const emailsRaw = await q(
      `SELECT id, status, to_addresses, subject, html, text, related_type, related_id, actor_type, created_at, sent_at
       FROM email_messages WHERE tenant_id = $1 AND created_at > $2 ORDER BY created_at, id`,
      [tenantId, since],
    );
    const emails = emailsRaw.map((e) => {
      const recipients = (e['to_addresses'] as string[]) ?? [];
      return {
        id: e['id'],
        status: e['status'],
        to: recipients[0] ?? null,
        recipients,
        subject: e['subject'],
        body: typeof e['text'] === 'string' && e['text'] !== '' ? e['text'] : htmlToText(String(e['html'] ?? '')),
        related_type: e['related_type'],
        related_id: e['related_id'],
        actor_type: e['actor_type'],
        created_at: (e['created_at'] as Date).toISOString(),
      };
    });
    const tasks = await q(
      `SELECT t.id, t.title, t.description, t.due_at, t.status, t.priority, t.related_type, t.related_id, t.created_by_type, t.assignee_id, u.email AS assignee_email, u.name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.tenant_id = $1 AND t.created_at > $2 ORDER BY t.created_at, t.id`,
      [tenantId, since],
    );
    const notes = await q(
      `SELECT id, kind, subject_type, subject_id, actor_type, data->>'body' AS body FROM activities
       WHERE tenant_id = $1 AND created_at > $2 AND kind IN ('note', 'call', 'meeting') ORDER BY created_at, id`,
      [tenantId, since],
    );
    const deals = await q(
      `SELECT d.id, d.title, d.amount_cents, s.name AS stage, s.kind AS stage_kind, d.owner_id, u.name AS owner_name, d.lost_reason, d.closed_at IS NOT NULL AS closed,
              d.updated_at > $2 AS changed, d.company_id
       FROM deals d JOIN stages s ON s.id = d.stage_id LEFT JOIN users u ON u.id = d.owner_id WHERE d.tenant_id = $1 AND d.deleted_at IS NULL ORDER BY d.title, d.id`,
      [tenantId, since],
    );
    const invoices = await q(
      `SELECT id, number, status, sent_at, updated_at > $2 AS changed, (total_cents - paid_cents) AS balance_cents FROM invoices WHERE tenant_id = $1 ORDER BY number`,
      [tenantId, since],
    );
    const approvals = await q(
      `SELECT id, status, title, source FROM approvals WHERE tenant_id = $1 AND created_at > $2 ORDER BY created_at`,
      [tenantId, since],
    );
    const audit = await q(
      `SELECT action, entity, entity_id, actor_type FROM audit_logs WHERE tenant_id = $1 AND created_at > $2 ORDER BY created_at`,
      [tenantId, since],
    );
    const normDeals: Array<Record<string, unknown>> = deals.map((d) => ({
      ...d,
      amount_cents: Number(d['amount_cents']),
    }));
    const normInvoices: Array<Record<string, unknown>> = invoices.map((i) => ({
      ...i,
      balance_cents: Number(i['balance_cents']),
    }));
    return {
      emails,
      emails_sent: emails.filter((e) => ['queued', 'sending', 'sent'].includes(String(e.status))),
      emails_drafted: emails.filter((e) => e.status === 'draft'),
      tasks_created: tasks.map((t) => ({
        ...t,
        due_at: t['due_at'] instanceof Date ? (t['due_at'] as Date).toISOString() : t['due_at'],
      })),
      notes_added: notes,
      deals: normDeals,
      deals_changed: normDeals.filter((d) => d['changed'] === true),
      invoices: normInvoices,
      invoices_changed: normInvoices.filter((i) => i['changed'] === true),
      approvals_inbox: approvals,
      audit,
    };
  } finally {
    await client.end();
  }
}
