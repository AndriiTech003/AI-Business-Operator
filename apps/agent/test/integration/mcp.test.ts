import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mailpit } from '@aio/bop-stack';
import { McpToolGateway } from '../../src/services/mcp';
import { startBop, waitFor, type Bop } from './env';

let bop: Bop;
let mcp: McpToolGateway;

beforeAll(async () => {
  bop = await startBop('mcp');
  mcp = new McpToolGateway(bop.stack.mcpUrl, bop.meta.users['maria']!.token);
}, 240_000);

afterAll(async () => {
  await mcp?.close();
  await bop?.close();
});

describe('ops-mcp contract', () => {
  it('exposes the expected tools, risks and input schemas', async () => {
    const tools = await mcp.listTools();
    const contract = tools.map((t) => {
      const schema = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      return {
        name: t.name,
        risk: t.risk,
        properties: Object.keys(schema.properties ?? {}).sort(),
        required: [...(schema.required ?? [])].sort(),
      };
    });
    expect(contract).toMatchSnapshot();
    expect(tools).toHaveLength(16);
    for (const t of tools.filter((x) => x.risk !== 'read'))
      expect(Object.keys((t.inputSchema as { properties: object }).properties)).toEqual(
        expect.arrayContaining(['idempotencyKey', 'dryRun']),
      );
  });

  it('project 05 marks every field written by outsiders (the agent adds no markers of its own)', async () => {
    const out = await mcp.call('get_contact', { id: bop.meta.ids['contact_lucas']! });
    expect(out.ok).toBe(true);
    expect(out.untrusted).toEqual(expect.arrayContaining(['contact.firstName', 'contact.title']));
    expect(out.payload?.['untrusted']).toEqual(out.untrusted);
    expect(out.untrusted.some((p) => /^activities\[\d+\]\.data\.changes$/.test(p))).toBe(true);
    const jonas = await mcp.call('get_contact', { id: bop.meta.ids['contact_jonas']! });
    expect(jonas.untrusted.some((p) => /^activities\[\d+\]\.data\.body$/.test(p))).toBe(true);
    const initrode = await mcp.call('get_company', { id: bop.meta.ids['company_initrode']! });
    expect(initrode.untrusted).toContain('company.name');
    const [nested] = await bop.sql<{ id: string }>(
      `SELECT d.id FROM deals d JOIN contacts c ON c.id = d.contact_id WHERE c.source = 'web_form' AND d.deleted_at IS NULL ORDER BY d.title LIMIT 1`,
    );
    expect(nested).toBeDefined();
    const deal = await mcp.call('get_deal', { id: nested!.id });
    expect(deal.untrusted).toContain('deal.contact.name');
    const search = await mcp.call('search_records', { query: 'Initrode' });
    const groups = (search.payload?.['result'] as { groups: Array<{ entity: string; hits: unknown[] }> }).groups;
    const gi = groups.findIndex((g) => g.entity === 'company' && g.hits.length > 0);
    expect(gi).toBeGreaterThanOrEqual(0);
    expect(search.untrusted).toEqual(
      expect.arrayContaining([`groups[${gi}].hits[0].title`, `groups[${gi}].hits[0].subtitle`]),
    );
  });

  it('pages list tools with cursor / nextCursor without gaps or duplicates', async () => {
    const single = await mcp.call('list_contacts', { limit: 100 });
    const all = (single.payload?.['result'] as { items: Array<{ id: string }> }).items.map((c) => c.id);
    const paged: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await mcp.call('list_contacts', { limit: 7, ...(cursor !== null ? { cursor } : {}) });
      expect(page.ok).toBe(true);
      const result = page.payload?.['result'] as { items: Array<{ id: string }>; nextCursor: string | null };
      paged.push(...result.items.map((c) => c.id));
      cursor = result.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 50);
    expect(pages).toBe(Math.ceil(all.length / 7));
    expect(new Set(paged).size).toBe(paged.length);
    expect(paged).toEqual(all);
  });

  it('returns search hits in a stable order', async () => {
    const ids = async () =>
      (
        (await mcp.call('search_records', { query: 'Olivia' })).payload?.['result'] as {
          groups: Array<{ hits: Array<{ id: string; score: number }> }>;
        }
      ).groups.flatMap((g) => g.hits.map((h) => h.id));
    const first = await ids();
    expect(first.length).toBeGreaterThan(1);
    for (let i = 0; i < 3; i += 1) expect(await ids()).toEqual(first);
  });

  it('previews writes with dryRun without changing anything', async () => {
    const before = await bop.sql<{ n: string }>('SELECT count(*)::text AS n FROM tasks');
    const out = await mcp.call('create_task', { title: 'Dry run only' }, { dryRun: true });
    expect(out.ok).toBe(true);
    expect(out.payload?.['dryRun']).toBe(true);
    const after = await bop.sql<{ n: string }>('SELECT count(*)::text AS n FROM tasks');
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});

describe('idempotency against project 05', () => {
  it('a repeated write with the same key has one effect', async () => {
    const key = `it-${Date.now()}:7`;
    const a = await mcp.call('create_task', { title: 'Idempotent task' }, { idempotencyKey: key });
    const b = await mcp.call('create_task', { title: 'Idempotent task' }, { idempotencyKey: key });
    expect((a.payload?.['result'] as { id: string }).id).toBe((b.payload?.['result'] as { id: string }).id);
    expect(await bop.sql(`SELECT id FROM tasks WHERE title = 'Idempotent task'`)).toHaveLength(1);
    expect(
      await bop.sql('SELECT origin, effect FROM effect_log WHERE tenant_id = $1 AND idempotency_key = $2', [
        bop.meta.tenantId,
        key,
      ]),
    ).toEqual([{ origin: 'api', effect: 'task.create' }]);
  });

  it('reusing a key for a different operation is refused, not applied', async () => {
    const key = `it-${Date.now()}:9`;
    const a = await mcp.call('create_task', { title: 'Key reuse task' }, { idempotencyKey: key });
    expect(a.ok).toBe(true);
    const b = await mcp.call(
      'add_note',
      { subject: { type: 'company', id: bop.meta.ids['company_initrode']! }, body: 'Key reuse note' },
      { idempotencyKey: key },
    );
    expect(b.ok).toBe(false);
    expect(b.status).toBe(422);
    expect(await bop.sql(`SELECT id FROM activities WHERE data->>'body' = 'Key reuse note'`)).toHaveLength(0);
    expect(
      await bop.sql('SELECT effect FROM effect_log WHERE tenant_id = $1 AND idempotency_key = $2', [
        bop.meta.tenantId,
        key,
      ]),
    ).toEqual([{ effect: 'task.create' }]);
  });

  it('a repeated send with the same key delivers one e-mail', async () => {
    const subject = `Idempotent send ${Date.now()}`;
    const draft = await mcp.call(
      'draft_email',
      { to: ['tom@globex.test'], subject, body: 'Hello Tom' },
      { idempotencyKey: `${subject}:draft` },
    );
    const draftId = (draft.payload?.['result'] as { id: string }).id;
    await mcp.call('send_email', { draftId }, { idempotencyKey: `${subject}:send` });
    await mcp.call('send_email', { draftId }, { idempotencyKey: `${subject}:send` });
    const mail = await waitFor(async () => {
      const m = await new Mailpit().search(`subject:"${subject}"`);
      return m.length > 0 ? m : null;
    }, 'mail delivered');
    await new Promise((r) => setTimeout(r, 1500));
    expect((await new Mailpit().search(`subject:"${subject}"`)).length).toBe(mail.length);
    expect(mail).toHaveLength(1);
    expect(await bop.sql('SELECT id FROM email_messages WHERE subject = $1', [subject])).toHaveLength(1);
    expect(
      await bop.sql('SELECT origin, effect FROM effect_log WHERE tenant_id = $1 AND idempotency_key = $2', [
        bop.meta.tenantId,
        `${subject}:send`,
      ]),
    ).toEqual([{ origin: 'api', effect: `email.send:${draftId}` }]);
  });

  it('timestamps written by project 05 are correct instants without a time-zone override on its database', async () => {
    const [db] = await bop.sql<{ tz: string; setting: string | null }>(
      `SELECT current_setting('TimeZone') AS tz, (SELECT array_to_string(setconfig, ',') FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = current_database() AND s.setrole = 0) AS setting`,
    );
    expect(db?.setting ?? '').not.toMatch(/timezone/i);
    const due = '2026-11-03T15:30:00.000Z';
    const out = await mcp.call('create_task', { title: `Clock check ${Date.now()}`, dueAt: due });
    expect(out.ok).toBe(true);
    const id = (out.payload?.['result'] as { id: string }).id;
    const [row] = await bop.sql<{ due_ok: boolean; created_skew: number }>(
      `SELECT due_at = $2::timestamptz AS due_ok, abs(extract(epoch FROM (created_at - now()))) AS created_skew FROM tasks WHERE id = $1`,
      [id, due],
    );
    expect(row?.due_ok).toBe(true);
    expect(Number(row?.created_skew)).toBeLessThan(120);
  });

  it('reports tool errors without throwing', async () => {
    const out = await mcp.call('get_deal', { id: '00000000-0000-4000-8000-000000000000' });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(404);
    const invalid = await mcp.call('create_task', { title: 'x', dueAt: 'friday' });
    expect(invalid.ok).toBe(false);
    expect(invalid.errorMessage).toContain('Invalid');
  });
});
