import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { ROUTES, openApiDocument } from '../../src/http/openapi';
import { normalizeEdit, verifySignature } from '../../src/services/approvals';
import { SecretBox } from '../../src/services/crypto';
import { ReadOnlyGateway, riskOf } from '../../src/services/mcp';
import { WorkflowStepError, WorkflowStepService, requestHash, responseFor } from '../../src/services/workflow-step';
import type { ToolGateway } from '@aio/agent-core';
import type { AppContext } from '../../src/context';
import { applyOverrides } from '../../src/services/policy';
import { htmlToText, textToHtml } from '../../src/services/resolver';
import { DEFAULT_POLICY_YAML, compilePolicy } from '@aio/policy';

describe('approval webhook signature', () => {
  const body = JSON.stringify({ type: 'approval.decided', approvalId: 'a', status: 'approved' });
  const sign = (t: number, secret = 's3cret') =>
    `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  it('accepts a valid signature within tolerance', () => {
    expect(verifySignature(body, sign(1000), 's3cret', 300, 1100)).toBe(true);
  });
  it('rejects wrong secrets, tampered bodies and stale timestamps', () => {
    expect(verifySignature(body, sign(1000, 'other'), 's3cret', 300, 1100)).toBe(false);
    expect(verifySignature(`${body} `, sign(1000), 's3cret', 300, 1100)).toBe(false);
    expect(verifySignature(body, sign(1000), 's3cret', 300, 5000)).toBe(false);
    expect(verifySignature(body, undefined, 's3cret', 300, 1000)).toBe(false);
  });
});

describe('human edits', () => {
  it('keeps the draft id and takes edited e-mail fields', () => {
    expect(
      normalizeEdit(
        'send_email',
        { draftId: 'd', to: ['a@x'], subject: 's', body: 'b' },
        { body: 'new', draftId: 'evil', subject: 7 },
      ),
    ).toEqual({
      draftId: 'd',
      to: ['a@x'],
      subject: 's',
      body: 'new',
    });
  });
  it('keeps the record id of other tools and drops control arguments', () => {
    expect(
      normalizeEdit(
        'update_deal',
        { id: 'deal-1', patch: { amountCents: 1 } },
        { id: 'deal-2', patch: { amountCents: 2 }, idempotencyKey: 'x' },
      ),
    ).toEqual({
      id: 'deal-1',
      patch: { amountCents: 2 },
    });
  });
});

describe('MCP helpers', () => {
  it('reads the risk from _meta, annotations or hints', () => {
    expect(riskOf({ _meta: { 'x-risk': 'external' } })).toBe('external');
    expect(riskOf({ annotations: { readOnlyHint: true } })).toBe('read');
    expect(riskOf({ annotations: { destructiveHint: true } })).toBe('irreversible');
    expect(riskOf({})).toBe('write_reversible');
  });
});

describe('workflow steps', () => {
  it('exposes only read tools to classify / summarize runs and refuses other calls', async () => {
    const called: string[] = [];
    const inner: ToolGateway = {
      listTools: async () => [
        { name: 'get_deal', title: 'get_deal', description: '', risk: 'read', inputSchema: {} },
        { name: 'create_task', title: 'create_task', description: '', risk: 'write_reversible', inputSchema: {} },
        { name: 'send_email', title: 'send_email', description: '', risk: 'external', inputSchema: {} },
      ],
      call: async (name) => {
        called.push(name);
        return { ok: true, payload: {}, untrusted: [], errorMessage: null, status: null, latencyMs: 1 };
      },
    };
    const gw = new ReadOnlyGateway(inner);
    expect((await gw.listTools()).map((t) => t.name)).toEqual(['get_deal']);
    expect((await gw.call('get_deal', { id: 'x' })).ok).toBe(true);
    const refused = await gw.call('send_email', { draftId: 'd' });
    expect(refused).toMatchObject({ ok: false, status: 403 });
    expect(called).toEqual(['get_deal']);
  });
  it('authorizes only the configured operator token', () => {
    const service = (token: string | null) =>
      new WorkflowStepService(
        { config: { operatorToken: token } } as unknown as AppContext,
        null as never,
        null as never,
      );
    expect(() => service('s3cret').authorize('Bearer s3cret')).not.toThrow();
    expect(() => service('s3cret').authorize('Bearer other')).toThrow(WorkflowStepError);
    expect(() => service('s3cret').authorize(undefined)).toThrow(/Invalid operator token/);
    expect(() => service(null).authorize('Bearer s3cret')).toThrow(/disabled/);
  });
  it('maps finished runs to the ai_step answer and hashes requests canonically', () => {
    const req = {
      task: 'classify' as const,
      input: 'upgrade please',
      labels: ['refund', 'upgrade'],
      context: { tenantId: '826d5eac-af32-4b6e-ac89-270639d6820a' },
    };
    expect(responseFor(req, { id: 'r1', status: 'completed', summary: 'Label: upgrade\nReason: x' })).toEqual({
      label: 'upgrade',
      summary: null,
      confidence: 0.9,
      runId: 'r1',
      status: 'completed',
    });
    expect(
      responseFor({ ...req, task: 'run' }, { id: 'r2', status: 'awaiting_approval', summary: 'Prepared 2 e-mails.' }),
    ).toMatchObject({ label: null, summary: expect.stringContaining('Waiting for approval') as string, confidence: 1 });
    expect(requestHash({ ...req, labels: ['refund', 'upgrade'] })).toBe(requestHash(req));
    expect(requestHash({ ...req, input: 'other' })).not.toBe(requestHash(req));
  });
});

describe('misc', () => {
  it('round-trips e-mail bodies through the draft HTML', () => {
    const body = "Hi Tom,\n\nIt's <great> & fine.\n\nBest,\nMaria";
    expect(htmlToText(textToHtml(body))).toBe(body);
  });
  it('encrypts stored credentials', () => {
    const box = new SecretBox('k');
    const sealed = box.encrypt('bop_pat_secret');
    expect(sealed).not.toContain('bop_pat_secret');
    expect(box.decrypt(sealed)).toBe('bop_pat_secret');
    expect(() => new SecretBox('other').decrypt(sealed)).toThrow();
  });
  it('applies playbook default overrides', () => {
    const doc = compilePolicy(DEFAULT_POLICY_YAML, 1).policy!.document;
    expect(applyOverrides(doc, { defaults: { write_reversible: 'require_approval' } }).defaults.write_reversible).toBe(
      'require_approval',
    );
    expect(applyOverrides(doc, undefined)).toBe(doc);
  });
  it('documents every route in OpenAPI', () => {
    const doc = openApiDocument('http://x') as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(doc.paths)).toContain('/runs/{id}/stream');
    expect(ROUTES.length).toBeGreaterThanOrEqual(30);
    expect(doc.paths['/proposals/decide']?.['post']).toHaveProperty('requestBody');
  });
  it('loads defaults from the environment', () => {
    const c = loadConfig({ BUDGET_MAX_COST_USD: '0.25' });
    expect(c.port).toBe(4600);
    expect(c.redisUrl).toBe('redis://127.0.0.1:6379/6');
    expect(c.llm.provider).toBe('fake');
    expect(c.budget.maxCostUsd).toBe(0.25);
  });
});
