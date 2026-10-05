import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AIO_PORTS, BopApi } from '@aio/bop-stack';
import {
  Client,
  agentEnv,
  agentSql,
  bopLogin,
  dropAgentEnv,
  runStatus,
  startAgent,
  startBop,
  waitFor,
  type AgentEnv,
  type Bop,
} from './env';

let bop: Bop;
let env: AgentEnv;

beforeAll(async () => {
  bop = await startBop('durable');
  env = agentEnv('durable');
}, 240_000);

afterAll(async () => {
  await bop?.close();
  if (env !== undefined) await dropAgentEnv(env);
});

describe('durable runs', () => {
  it('kill -9 while running: another instance resumes from the last step and the effect happens once', async () => {
    const a = await startAgent(bop, env, AIO_PORTS.integration.agentA, {
      AIO_TEST_DELAY_AFTER_EFFECT_MS: '15000',
      WORKER_ID: 'instance-a',
    });
    const ca = await new Client(a.url).login('maria@demo.dev');
    const run = await ca.json<{ id: string }>('POST', '/runs', { goal: 'Create a task to call Globex on Friday.' });
    const task = await waitFor(
      async () => (await bop.sql<{ id: string }>(`SELECT id FROM tasks WHERE title = 'Call Globex Corporation'`))[0],
      'the task effect in project 05',
    );
    expect(task.id).toBeDefined();
    const before = await agentSql<{ status: string; lease_owner: string | null }>(
      env,
      'SELECT status, lease_owner FROM agent_runs WHERE id = $1',
      [run.id],
    );
    expect(before[0]).toMatchObject({ status: 'running', lease_owner: 'instance-a' });
    const pending = await agentSql<{ status: string; idempotency_key: string | null }>(
      env,
      `SELECT status, idempotency_key FROM agent_steps WHERE run_id = $1 AND tool = 'create_task'`,
      [run.id],
    );
    expect(pending[0]?.status).toBe('pending');
    await a.kill('SIGKILL');
    const b = await startAgent(bop, env, AIO_PORTS.integration.agentB, { WORKER_ID: 'instance-b' });
    try {
      const cb = await new Client(b.url).login('maria@demo.dev');
      const done = await waitFor(async () => {
        const r = await runStatus(cb, run.id);
        return r.status === 'completed' ? r : null;
      }, 'resumed run to complete');
      expect(done.status).toBe('completed');
      const tasks = await bop.sql(`SELECT id FROM tasks WHERE title = 'Call Globex Corporation'`);
      expect(tasks).toHaveLength(1);
      const steps = await agentSql<{ status: string; idempotency_key: string; seq: number }>(
        env,
        `SELECT status, idempotency_key, seq FROM agent_steps WHERE run_id = $1 AND tool = 'create_task'`,
        [run.id],
      );
      expect(steps).toHaveLength(1);
      expect(steps[0]?.status).toBe('done');
      expect(steps[0]?.idempotency_key).toBe(`${run.id}:${steps[0]?.seq}`);
      const effects = await bop.sql<{ origin: string; effect: string }>(
        'SELECT origin, effect FROM effect_log WHERE tenant_id = $1 AND idempotency_key = $2',
        [bop.meta.tenantId, steps[0]?.idempotency_key],
      );
      expect(effects).toEqual([{ origin: 'api', effect: 'task.create' }]);
      const attempts = await agentSql<{ attempts: number }>(env, 'SELECT attempts FROM agent_runs WHERE id = $1', [
        run.id,
      ]);
      expect(attempts[0]?.attempts).toBeGreaterThanOrEqual(1);
      const resultMsg = await agentSql<{ n: string }>(
        env,
        `SELECT count(*)::text AS n FROM agent_messages WHERE run_id = $1 AND content::text LIKE '%tool_result%'`,
        [run.id],
      );
      expect(Number(resultMsg[0]?.n)).toBe(2);
    } finally {
      await b.kill();
    }
  }, 180_000);

  it('kill -9 while awaiting approval: approved a day later on another instance, the run continues', async () => {
    const a = await startAgent(bop, env, AIO_PORTS.integration.agentA, { WORKER_ID: 'instance-a2' });
    const ca = await new Client(a.url).login('maria@demo.dev');
    const run = await ca.json<{ id: string }>('POST', '/runs', {
      goal: 'Change the amount of the Acme Logistics – Pilot deal to $20,000.',
    });
    await waitFor(async () => (await runStatus(ca, run.id)).status === 'awaiting_approval', 'awaiting approval');
    const batch = await waitFor(
      async () =>
        (
          await agentSql<{ external_approval_id: string | null }>(
            env,
            'SELECT external_approval_id FROM proposal_batches WHERE run_id = $1',
            [run.id],
          )
        )[0]?.external_approval_id,
      'approval mirrored to the project 05 inbox',
    );
    const inbox = await bop.sql<{ source: string; status: string; title: string }>(
      'SELECT source, status, title FROM approvals WHERE id = $1',
      [batch],
    );
    expect(inbox[0]).toMatchObject({ source: 'agent', status: 'pending' });
    await a.kill('SIGKILL');
    const b = await startAgent(bop, env, AIO_PORTS.integration.agentB, {
      WORKER_ID: 'instance-b2',
      AIO_CLOCK_OFFSET_MS: String(26 * 3600 * 1000),
    });
    try {
      const cb = await new Client(b.url).login('maria@demo.dev');
      const pending = await cb.json<{ items: Array<{ id: string; argsHash: string; ruleId: string }> }>(
        'GET',
        '/proposals?status=pending',
      );
      const mine = pending.items.filter((p) => p.ruleId === 'deal-amount-change');
      expect(mine).toHaveLength(1);
      await cb.json('POST', '/proposals/decide', {
        decisions: [{ id: mine[0]!.id, decision: 'approve', expectedHash: mine[0]!.argsHash }],
      });
      const done = await waitFor(async () => {
        const r = await runStatus(cb, run.id);
        return r.status === 'completed' ? r : null;
      }, 'run completed after approval');
      const usage = done['usage'] as { wallClockMs: number };
      expect(usage.wallClockMs).toBeLessThan(10 * 60 * 1000);
      const amount = await bop.sql<{ amount: string }>(
        `SELECT amount_cents::text AS amount FROM deals WHERE title = 'Acme Logistics – Pilot'`,
      );
      expect(amount[0]?.amount).toBe('2000000');
      const p = await agentSql<{ waited_hours: number; status: string }>(
        env,
        `SELECT extract(epoch FROM decided_at - created_at) / 3600 AS waited_hours, status FROM proposals WHERE id = $1`,
        [mine[0]!.id],
      );
      expect(Number(p[0]?.waited_hours)).toBeGreaterThan(24);
      expect(p[0]?.status).toBe('executed');
      const external = await bop.sql<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [batch]);
      expect(external[0]?.status).toBe('approved');
    } finally {
      await b.kill();
    }
  }, 180_000);

  it('approval decided in the project 05 inbox reaches the agent through the signed callback', async () => {
    const b = await startAgent(bop, env, AIO_PORTS.integration.agentB, { WORKER_ID: 'instance-b3' });
    try {
      const cb = await new Client(b.url).login('maria@demo.dev');
      const run = await cb.json<{ id: string }>('POST', '/runs', {
        goal: 'Mark the VanArsdel – Renewal deal as lost because the budget was cut.',
      });
      await waitFor(async () => (await runStatus(cb, run.id)).status === 'awaiting_approval', 'awaiting approval');
      const approvalId = await waitFor(
        async () =>
          (
            await agentSql<{ external_approval_id: string | null }>(
              env,
              'SELECT external_approval_id FROM proposal_batches WHERE run_id = $1',
              [run.id],
            )
          )[0]?.external_approval_id,
        'external approval',
      );
      const manager = await bopLogin(bop, 'manager@demo.dev');
      await new BopApi(bop.stack.apiUrl).request('POST', `/v1/approvals/${approvalId}/decide`, {
        token: manager,
        body: { decision: 'approve', comment: 'ok from inbox' },
      });
      const done = await waitFor(
        async () => {
          const r = await runStatus(cb, run.id);
          return r.status === 'completed' ? r : null;
        },
        'run completed via callback',
        90_000,
      );
      expect(done.status).toBe('completed');
      const deal = await bop.sql<{ stage: string; lost_reason: string }>(
        `SELECT s.name AS stage, d.lost_reason FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.title = 'VanArsdel – Renewal'`,
      );
      expect(deal[0]?.stage).toBe('Lost');
      expect(deal[0]?.lost_reason).toContain('budget');
      const p = await agentSql<{ comment: string; status: string }>(
        env,
        'SELECT comment, status FROM proposals WHERE run_id = $1',
        [run.id],
      );
      expect(p[0]).toMatchObject({ status: 'executed', comment: 'ok from inbox' });
    } finally {
      await b.kill();
    }
  }, 180_000);
});
