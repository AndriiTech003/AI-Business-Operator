import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, emptyUsage, type ChatMessage } from '@aio/contracts';
import {
  argsHash,
  assertApprovedPayload,
  budgetNotice,
  buildSystemPrompt,
  checkBudget,
  compactMessages,
  HashMismatchError,
  mergeBudget,
  summarizeToolResult,
  truncatePayload,
  wrapToolResult,
} from '../src';

describe('args hash invariant', () => {
  it('is stable regardless of key order and ignores undefined', () => {
    expect(argsHash('send_email', { b: 1, a: { y: 2, x: [1, 2] } })).toBe(
      argsHash('send_email', { a: { x: [1, 2], y: 2 }, b: 1, c: undefined }),
    );
  });
  it('changes with the tool and with any payload change', () => {
    const h = argsHash('send_email', { draftId: 'd1', body: 'Hi' });
    expect(argsHash('draft_email', { draftId: 'd1', body: 'Hi' })).not.toBe(h);
    expect(argsHash('send_email', { draftId: 'd1', body: 'Hi!' })).not.toBe(h);
  });
  it('rejects execution of a modified payload', () => {
    const approved = argsHash('send_email', { draftId: 'd1', to: ['a@b.test'] });
    expect(() =>
      assertApprovedPayload('p1', 'send_email', { draftId: 'd1', to: ['a@b.test'] }, approved),
    ).not.toThrow();
    expect(() => assertApprovedPayload('p1', 'send_email', { draftId: 'd1', to: ['x@evil.test'] }, approved)).toThrow(
      HashMismatchError,
    );
  });
});

describe('budgets', () => {
  const b = { ...DEFAULT_BUDGET };
  const cases: Array<[keyof typeof b, Partial<ReturnType<typeof emptyUsage>>]> = [
    ['maxSteps', { steps: 40 }],
    ['maxToolCalls', { toolCalls: 100 }],
    ['maxInputTokens', { inputTokens: 2_000_000 }],
    ['maxCostUsd', { costUsd: 0.5 }],
    ['maxWallClockMs', { wallClockMs: 600_000 }],
    ['maxExternalActions', { externalActions: 50 }],
  ];
  for (const [limit, usage] of cases)
    it(`stops at ${limit}`, () => {
      expect(checkBudget(b, { ...emptyUsage(), ...usage }).limit).toBe(limit);
      const below = Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, Number(v) * 0.99]));
      expect(checkBudget(b, { ...emptyUsage(), ...below }).ok).toBe(true);
    });
  it('defaults match the spec', () => {
    expect(DEFAULT_BUDGET).toMatchObject({
      maxSteps: 40,
      maxToolCalls: 100,
      maxCostUsd: 0.5,
      maxWallClockMs: 600_000,
      maxExternalActions: 50,
    });
  });
  it('merges overrides left to right', () => {
    expect(mergeBudget(b, { maxSteps: 10 }, undefined, { maxCostUsd: 0.1 })).toMatchObject({
      maxSteps: 10,
      maxCostUsd: 0.1,
      maxToolCalls: 100,
    });
  });
  it('tells the model the budget is exhausted', () => {
    expect(budgetNotice('maxSteps', 'steps 40/40')).toContain('budget_exhausted');
  });
});

describe('context management', () => {
  it('truncates long list results and says how many items were omitted', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: `id-${i}`,
      name: `Contact ${i}`,
      notes: 'x'.repeat(200),
    }));
    const { payload, truncated } = truncatePayload(
      { tool: 'list_contacts', result: { items, nextCursor: 'c' } },
      { maxTokens: 2000 },
    );
    expect(truncated).toBe(true);
    expect(payload['truncated']).toBe(true);
    expect(Number(payload['omittedItems'])).toBeGreaterThan(100);
    expect(JSON.stringify(payload).length / 4).toBeLessThanOrEqual(2000);
  });
  it('previews non-list results that are too big', () => {
    const { payload } = truncatePayload(
      { tool: 'get_report', result: { blob: 'y'.repeat(50_000) } },
      { maxTokens: 500 },
    );
    expect(payload['truncated']).toBe(true);
    expect(String(payload['preview']).length).toBeLessThanOrEqual(2000);
  });
  it('leaves small results alone', () => {
    expect(truncatePayload({ tool: 't', result: { a: 1 } }, { maxTokens: 100 }).truncated).toBe(false);
  });
  it('compacts old tool results but keeps record ids and the recent messages', () => {
    const big = (i: number) =>
      wrapToolResult(
        'list_contacts',
        {
          result: {
            items: Array.from({ length: 30 }, (_, j) => ({
              id: `0000000${i}-0000-4000-8000-0000000000${String(j).padStart(2, '0')}`,
              name: `N${j}`,
              notes: 'z'.repeat(300),
            })),
          },
        },
        true,
      );
    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'goal' }] }];
    for (let i = 0; i < 6; i += 1) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'list_contacts', input: {} }],
      });
      messages.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: `t${i}`, content: big(i) }] });
    }
    const out = compactMessages('sys', messages, { maxContextTokens: 10_000, targetRatio: 0.6, keepRecentMessages: 4 });
    expect(out.compactedBlocks).toBeGreaterThan(0);
    expect(out.afterTokens).toBeLessThan(out.beforeTokens);
    const first = out.messages[2]?.content[0] as { content: string };
    expect(first.content).toContain('compacted="true"');
    expect(first.content).toContain('00000000-0000-4000-8000-000000000000');
    expect(out.messages.at(-1)).toEqual(messages.at(-1));
    expect(
      compactMessages('sys', messages.slice(0, 3), {
        maxContextTokens: 1_000_000,
        targetRatio: 0.6,
        keepRecentMessages: 4,
      }).compactedBlocks,
    ).toBe(0);
  });
  it('summaries keep labels', () => {
    expect(
      summarizeToolResult('<tool_result tool="get_deal" untrusted="true">\n{"title":"Acme – Pilot"}\n</tool_result>'),
    ).toContain('Acme – Pilot');
  });
});

describe('system prompt', () => {
  it('declares untrusted data, the user, time, team and blocked tools', () => {
    const p = buildSystemPrompt({
      tenantName: 'Acme Corp',
      tenantDomain: 'demo.dev',
      timezone: 'Europe/Berlin',
      now: '2026-10-01T10:00:00.000Z',
      user: { id: 'u1', name: 'Maria Lopez', email: 'maria@demo.dev', role: 'manager' },
      team: [{ id: 'u2', name: 'Anna Sales', email: 'anna@demo.dev', role: 'member' }],
      instructions: 'Be brief.',
      approvalRequired: ['send_email'],
      blocked: [{ tool: 'void_invoice', ruleId: 'no-void', reason: 'finance only' }],
    });
    expect(p).toContain('<tool_result untrusted="true">');
    expect(p).toContain('now: 2026-10-01T10:00:00.000Z');
    expect(p).toContain('- Anna Sales | anna@demo.dev | member | u2');
    expect(p).toContain('- void_invoice: rule no-void — finance only');
  });
});
