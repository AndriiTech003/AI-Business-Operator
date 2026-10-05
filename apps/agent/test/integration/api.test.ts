import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSseChunk, type RunEvent } from '@aio/contracts';
import { Mailpit } from '@aio/bop-stack';
import {
  Client,
  agentEnv,
  agentSql,
  dropAgentEnv,
  runStatus,
  startAgent,
  startBop,
  waitFor,
  type AgentEnv,
  type AgentProc,
  type Bop,
} from './env';

let bop: Bop;
let env: AgentEnv;
let agent: AgentProc;
let maria: Client;

beforeAll(async () => {
  bop = await startBop('api');
  env = agentEnv('api');
  agent = await startAgent(bop, env);
  maria = await new Client(agent.url).login('maria@demo.dev');
  await maria.json('PUT', '/settings', { serviceToken: bop.meta.serviceToken, domain: 'demo.dev' });
}, 240_000);

afterAll(async () => {
  await agent?.kill();
  await bop?.close();
  if (env !== undefined) await dropAgentEnv(env);
});

async function sse(c: Client, path: string, body?: unknown): Promise<RunEvent[]> {
  const res = await c.raw(body === undefined ? 'GET' : 'POST', path, body, true, { accept: 'text/event-stream' });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const text = await res.text();
  return parseSseChunk(text).events.map((e) => JSON.parse(e.data) as RunEvent);
}

async function untilStatus(runId: string, status: string): Promise<Record<string, unknown>> {
  return waitFor(async () => {
    const r = await runStatus(maria, runId);
    return r.status === status ? r : null;
  }, `run ${status}`);
}

describe('service basics', () => {
  it('health, OpenAPI and Prometheus metrics', async () => {
    expect(await maria.json('GET', '/health')).toMatchObject({ status: 'ok', db: 'ok', redis: 'ok', provider: 'fake' });
    const doc = await maria.json<{ openapi: string; paths: Record<string, unknown> }>('GET', '/openapi.json');
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/proposals/decide');
    const metrics = await (await maria.raw('GET', '/metrics')).text();
    expect(metrics).toContain('aio_runs_started_total');
    expect(metrics).toContain('aio_policy_blocked_total');
  });
  it('authenticates with business-system credentials or tokens', async () => {
    expect((await maria.raw('POST', '/auth/login', { email: 'maria@demo.dev', password: 'wrong' }, false)).status).toBe(
      401,
    );
    expect((await maria.raw('GET', '/runs', undefined, false)).status).toBe(401);
    expect(await maria.json('GET', '/me')).toMatchObject({ email: 'maria@demo.dev', role: 'manager' });
    const viaToken = new Client(agent.url);
    viaToken.token = bop.meta.users['anna']!.token;
    expect(await viaToken.json('GET', '/me')).toMatchObject({ email: 'anna@demo.dev', role: 'member' });
  });
  it('lists visible tools and hides the ones the user may not use, with the rule id', async () => {
    const viewer = await new Client(agent.url).login('viewer@demo.dev');
    const tools = await viewer.json<{
      visible: Array<{ name: string }>;
      hidden: Array<{ tool: string; ruleId: string }>;
    }>('GET', '/tools');
    expect(tools.visible.map((t) => t.name)).toContain('list_contacts');
    expect(tools.hidden).toEqual(
      expect.arrayContaining([{ tool: 'create_task', ruleId: 'user-permission', reason: expect.any(String) }]),
    );
    const mine = await maria.json<{ hidden: Array<{ tool: string; ruleId: string }> }>('GET', '/tools');
    expect(mine.hidden).toEqual([{ tool: 'void_invoice', ruleId: 'no-void', reason: expect.any(String) }]);
  });
});

describe('runs and streaming', () => {
  let runId = '';
  it('streams a read-only run over SSE and stores the timeline', async () => {
    const events = await sse(maria, '/runs', {
      goal: 'How many overdue invoices does Acme Logistics have, and what is the total outstanding amount?',
    });
    const types = new Set(events.map((e) => e.type));
    for (const t of ['status', 'text', 'tool_call', 'policy', 'tool_result', 'usage', 'done'])
      expect(types.has(t as RunEvent['type'])).toBe(true);
    const done = events.find((e) => e.type === 'done') as Extract<RunEvent, { type: 'done' }>;
    expect(done.status).toBe('completed');
    expect(done.summary).toContain('$6,300.00');
    runId = done.runId;
    const detail = await maria.json<{
      steps: Array<{ kind: string; tool: string | null }>;
      messages: unknown[];
      usage: { costUsd: number };
    }>('GET', `/runs/${runId}`);
    expect(detail.steps.map((s) => s.tool).filter((t) => t !== null)).toEqual(['search_records', 'list_invoices']);
    expect(detail.messages.length).toBeGreaterThanOrEqual(5);
    expect(detail.usage.costUsd).toBeGreaterThan(0);
  });
  it('re-attaches to a finished run stream and replays it', async () => {
    const events = await sse(maria, `/runs/${runId}/stream`);
    expect(events.at(-1)?.type).toBe('done');
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
  });
  it('filters the run history', async () => {
    const list = await maria.json<{ items: Array<{ id: string; status: string }> }>('GET', '/runs?status=completed');
    expect(list.items.map((r) => r.id)).toContain(runId);
  });
  it('answers a clarifying question with a reply that continues the same run', async () => {
    const run = await maria.json<{ id: string }>('POST', '/runs', {
      goal: 'Close the Contoso deal as won.',
      wait: true,
    });
    const asked = await runStatus(maria, run.id);
    expect(asked).toMatchObject({ status: 'completed', stopReason: 'needs_input' });
    expect(await maria.json('POST', `/runs/${run.id}/messages`, { message: 'The 42000 one.' })).toEqual({
      mode: 'reply',
    });
    await untilStatus(run.id, 'awaiting_approval');
    const detail = await maria.json<{ proposals: Array<{ ruleId: string; args: { patch: { stage: string } } }> }>(
      'GET',
      `/runs/${run.id}`,
    );
    expect(detail.proposals[0]).toMatchObject({ ruleId: 'deal-close', args: { patch: { stage: 'Won' } } });
    const cancelled = await maria.json<{ status: string }>('POST', `/runs/${run.id}/cancel`);
    expect(cancelled.status).toBe('cancelled');
    const after = await maria.json<{ proposals: Array<{ status: string; externalApprovalId: string | null }> }>(
      'GET',
      `/runs/${run.id}`,
    );
    expect(after.proposals[0]?.status).toBe('cancelled');
    const ext = after.proposals[0]?.externalApprovalId;
    if (ext)
      await waitFor(
        async () =>
          (await bop.sql<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [ext]))[0]?.status ===
          'rejected',
        'inbox approval closed',
      );
  });
});

describe('approvals', () => {
  it('a member cannot approve, edits are re-checked by policy, stale hashes are refused, and the edited payload is what gets sent', async () => {
    const run = await maria.json<{ id: string }>('POST', '/runs', {
      goal: 'Send a follow-up email to Emma Novak.',
      wait: true,
    });
    expect((await runStatus(maria, run.id)).status).toBe('awaiting_approval');
    const pending = await maria.json<{
      items: Array<{ id: string; runId: string; argsHash: string; tool: string; args: { body: string; to: string[] } }>;
      batches: Array<{ runId: string; externalApprovalId: string | null }>;
    }>('GET', '/proposals?status=pending');
    const p = pending.items.find((x) => x.runId === run.id && x.tool === 'send_email');
    expect(p).toBeDefined();
    await waitFor(
      async () =>
        (
          await maria.json<{ batches: Array<{ runId: string; externalApprovalId: string | null }> }>(
            'GET',
            '/proposals?status=pending',
          )
        ).batches.find((b) => b.runId === run.id)?.externalApprovalId,
      'batch mirrored to the inbox',
    );
    const anna = await new Client(agent.url).login('anna@demo.dev');
    expect(
      (await anna.raw('POST', '/proposals/decide', { decisions: [{ id: p!.id, decision: 'approve' }] })).status,
    ).toBe(403);
    expect(
      (
        await maria.raw('POST', '/proposals/decide', {
          decisions: [{ id: p!.id, decision: 'approve', expectedHash: 'stale' }],
        })
      ).status,
    ).toBe(409);
    const blocked = await maria.raw('POST', '/proposals/decide', {
      decisions: [{ id: p!.id, decision: 'approve', editedArgs: { to: ['someone@evil.test'] } }],
    });
    expect(blocked.status).toBe(422);
    expect(((await blocked.json()) as { title: string }).title).toContain('external-domain');
    const subject = `Edited follow-up ${Date.now()}`;
    const body = `${p!.args.body}\n\nP.S. Edited by a human.`;
    const decided = await maria.json<{ items: Array<{ edited: boolean; originalArgs: unknown; argsHash: string }> }>(
      'POST',
      '/proposals/decide',
      {
        decisions: [{ id: p!.id, decision: 'approve', editedArgs: { subject, body }, expectedHash: p!.argsHash }],
      },
    );
    expect(decided.items[0]?.edited).toBe(true);
    expect(decided.items[0]?.originalArgs).toMatchObject({ body: p!.args.body });
    expect(decided.items[0]?.argsHash).not.toBe(p!.argsHash);
    await untilStatus(run.id, 'completed');
    const sent = await bop.sql<{ subject: string; text: string; status: string; actor_type: string }>(
      `SELECT subject, text, status, actor_type FROM email_messages WHERE subject = $1`,
      [subject],
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('P.S. Edited by a human.');
    expect(sent[0]?.actor_type).toBe('agent');
    const mail = new Mailpit();
    const inbox = await waitFor(async () => {
      const found = await mail.search(`subject:"${subject}"`);
      return found.length > 0 ? found : null;
    }, 'e-mail in Mailpit');
    expect(inbox[0]?.To[0]?.Address).toBe(p!.args.to[0]);
    const prop = await agentSql<{ status: string; edited: boolean; approved_hash: string; args_hash: string }>(
      env,
      'SELECT status, edited, approved_hash, args_hash FROM proposals WHERE id = $1',
      [p!.id],
    );
    expect(prop[0]).toMatchObject({ status: 'executed', edited: true });
    expect(prop[0]?.approved_hash).toBe(prop[0]?.args_hash);
  }, 120_000);

  it('expires an approval batch after its TTL and lets the run finish with that information', async () => {
    const run = await maria.json<{ id: string }>('POST', '/runs', {
      goal: 'Change the amount of the Acme Logistics – Expansion deal to $90,000.',
      wait: true,
    });
    expect((await runStatus(maria, run.id)).status).toBe('awaiting_approval');
    await agentSql(env, `UPDATE proposal_batches SET expires_at = now() - interval '1 second' WHERE run_id = $1`, [
      run.id,
    ]);
    const done = await untilStatus(run.id, 'completed');
    expect(done['summary']).toContain('expired');
    const detail = await maria.json<{ proposals: Array<{ status: string }> }>('GET', `/runs/${run.id}`);
    expect(detail.proposals.map((p) => p.status)).toEqual(['expired']);
    const amount = await bop.sql<{ amount: string }>(
      `SELECT amount_cents::text AS amount FROM deals WHERE title = 'Acme Logistics – Expansion'`,
    );
    expect(amount[0]?.amount).toBe('3000000');
  });

  it('refuses to approve a proposal whose stored payload no longer matches its hash', async () => {
    const run = await maria.json<{ id: string }>('POST', '/runs', {
      goal: 'Send a follow-up email to Daniel Kim.',
      wait: true,
    });
    const detail = await maria.json<{ proposals: Array<{ id: string; tool: string; status: string }> }>(
      'GET',
      `/runs/${run.id}`,
    );
    const p = detail.proposals.find((x) => x.tool === 'send_email' && x.status === 'pending');
    expect(p).toBeDefined();
    await agentSql(
      env,
      `UPDATE proposals SET args = jsonb_set(args, '{to}', '["olivia.smith0@northwind.example"]') WHERE id = $1`,
      [p!.id],
    );
    const res = await maria.raw('POST', '/proposals/decide', { decisions: [{ id: p!.id, decision: 'approve' }] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { title: string }).title).toContain('does not match its hash');
    await maria.json('POST', `/runs/${run.id}/cancel`);
  });
});

describe('policy', () => {
  it('validates, versions and pins policies', async () => {
    const current = await maria.json<{ version: number; yaml: string; versions: unknown[] }>('GET', '/policy');
    const invalid = await maria.raw('PUT', '/policy', {
      yaml: current.yaml.replace(
        "tool.risk == 'write_reversible'",
        "tool.risk == 'write_reversible' and run.wrtieCount > 1",
      ),
      baseVersion: current.version,
    });
    expect(invalid.status).toBe(422);
    const problem = (await invalid.json()) as { diagnostics: Array<{ path: string; line: number; message: string }> };
    expect(problem.diagnostics[0]).toMatchObject({ path: 'rules.0.when', line: 8 });
    const validation = await maria.json<{ ok: boolean }>('POST', '/policy/validate', { yaml: current.yaml });
    expect(validation.ok).toBe(true);
    const stale = await maria.raw('PUT', '/policy', { yaml: current.yaml, baseVersion: current.version - 1 });
    expect(stale.status).toBe(422);
    const saved = await maria.json<{ version: number }>('PUT', '/policy', {
      yaml: current.yaml.replace('emailsPerRun: 50', 'emailsPerRun: 40'),
      baseVersion: current.version,
    });
    expect(saved.version).toBe(current.version + 1);
    const old = await maria.json<{ yaml: string }>('GET', `/policy/versions/${current.version}`);
    expect(old.yaml).toContain('emailsPerRun: 50');
    const run = await maria.json<{ policyVersion: number }>('POST', '/runs', {
      goal: 'What is our largest open deal and who owns it?',
      wait: true,
    });
    expect(run.policyVersion).toBe(saved.version);
  });

  it('simulates single actions and replays the last runs against a draft policy', async () => {
    const voidSim = await maria.json<{ visible: boolean; decision: { decision: string; ruleId: string } }>(
      'POST',
      '/policy/simulate',
      { tool: 'void_invoice', args: { id: bop.meta.ids['invoice_void'] } },
    );
    expect(voidSim).toMatchObject({ visible: false, decision: { decision: 'deny', ruleId: 'no-void' } });
    const external = await maria.json<{ decision: { decision: string; ruleId: string } }>('POST', '/policy/simulate', {
      tool: 'send_email',
      args: { to: ['x@evil.test'] },
    });
    expect(external.decision).toMatchObject({ decision: 'deny', ruleId: 'external-domain' });
    const current = await maria.json<{ yaml: string }>('GET', '/policy');
    const relaxed = current.yaml.replace('external: require_approval', 'external: allow');
    const replay = await maria.json<{
      runs: number;
      actions: number;
      changed: Array<{ tool: string; before: { decision: string }; after: { decision: string } }>;
      summary: Record<string, number>;
    }>('POST', '/policy/simulate', { yaml: relaxed, lastRuns: 100 });
    expect(replay.runs).toBeGreaterThan(0);
    expect(
      replay.changed.some(
        (c) => c.tool === 'send_email' && c.before.decision === 'require_approval' && c.after.decision === 'allow',
      ),
    ).toBe(true);
    expect(replay.summary['require_approval→allow']).toBeGreaterThan(0);
  });
});

describe('playbooks and usage', () => {
  it('creates, runs and reports playbooks', async () => {
    expect(
      (await maria.raw('POST', '/playbooks', { name: 'bad', instructions: 'x', schedule: 'every monday' })).status,
    ).toBe(422);
    const pb = await maria.json<{ id: string; nextRunAt: string; enabled: boolean }>('POST', '/playbooks', {
      name: 'Weekly AR check',
      instructions: 'What is our total accounts receivable that is more than 30 days past due?',
      schedule: '0 9 * * 1',
      timezone: 'Europe/Berlin',
    });
    expect(pb.nextRunAt).toBeTruthy();
    const run = await maria.json<{ id: string; playbookId: string }>('POST', `/playbooks/${pb.id}/run`);
    expect(run.playbookId).toBe(pb.id);
    await untilStatus(run.id, 'completed');
    const detail = await maria.json<{ runs: Array<{ id: string }>; runCount: number; monthCostUsd: number }>(
      'GET',
      `/playbooks/${pb.id}`,
    );
    expect(detail.runs.map((r) => r.id)).toContain(run.id);
    expect(detail.monthCostUsd).toBeGreaterThan(0);
    const usage = await maria.json<{
      totalRuns: number;
      byPlaybook: Array<{ label: string }>;
      byDay: unknown[];
      byModel: Array<{ key: string }>;
    }>('GET', '/usage');
    expect(usage.byPlaybook.map((r) => r.label)).toContain('Weekly AR check');
    expect(usage.byModel[0]?.key).toBe('fake-planner');
    await maria.json('PATCH', `/playbooks/${pb.id}`, { enabled: false });
    expect((await maria.raw('DELETE', `/playbooks/${pb.id}`)).status).toBe(204);
  });
  it('serves eval results', async () => {
    const list = await maria.json<{ items: unknown[] }>('GET', '/eval/runs');
    expect(Array.isArray(list.items)).toBe(true);
  });
});
