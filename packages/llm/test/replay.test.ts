import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CassetteMissError,
  CassetteStore,
  cassetteKey,
  decodeContent,
  encodeContent,
  normalizeRequest,
  PriceTable,
  RecordingProvider,
  ReplayProvider,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '../src';

const dir = mkdtempSync(join(tmpdir(), 'aio-cassettes-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function request(id: string, created: string, now: string): LlmRequest {
  return {
    model: 'm1',
    system: `You are an operator.\nnow: ${now}`,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Create a task for the Acme deal' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'search_records', input: { query: 'Acme' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_1',
            content: JSON.stringify({
              hits: [
                { id, createdAt: created, updatedAt: created },
                { id, createdAt: '2026-01-01T00:00:00.000Z' },
              ],
            }),
          },
        ],
      },
    ],
    tools: [{ name: 'create_task', description: 'Create a task', inputSchema: { type: 'object' } }],
    maxTokens: 1000,
    metadata: { now, scenarioId: 'unit' },
  };
}

class Echo implements LlmProvider {
  readonly name = 'echo';

  async create(req: LlmRequest): Promise<LlmResponse> {
    const result = JSON.parse((req.messages[2]?.content[0] as { content: string }).content) as {
      hits: Array<{ id: string }>;
    };
    const due = new Date(Date.parse(String(req.metadata?.now)) + 6 * 86_400_000).toISOString();
    return {
      model: 'm1',
      content: [
        { type: 'text', text: `Creating it for ${result.hits[0]?.id} due ${due.slice(0, 10)}` },
        { type: 'tool_use', id: 'toolu_2', name: 'create_task', input: { relatedId: result.hits[0]?.id, dueAt: due } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      latencyMs: 42,
      firstTokenMs: 7,
      provider: 'echo',
    };
  }
}

describe('normalization', () => {
  it('maps volatile ids and timestamps to placeholders so equivalent requests share a key', () => {
    const a = normalizeRequest(
      request('11111111-1111-4111-8111-111111111111', '2026-10-01T10:00:00.000Z', '2026-10-02T09:00:00.000Z'),
    );
    const b = normalizeRequest(
      request('22222222-2222-4222-8222-222222222222', '2026-10-05T11:30:00.000Z', '2026-10-06T08:00:00.000Z'),
    );
    expect(cassetteKey(a.normalized)).toBe(cassetteKey(b.normalized));
    expect(JSON.stringify(a.normalized)).toContain('⟦id:0⟧');
  });
  it('gives every timestamp occurrence its own placeholder (independent of equal values)', () => {
    const { normalized } = normalizeRequest(
      request('11111111-1111-4111-8111-111111111111', '2026-10-01T10:00:00.000Z', '2026-10-02T09:00:00.000Z'),
    );
    const text = JSON.stringify(normalized);
    expect(text).toContain('⟦ts:1⟧');
    expect(text).toContain('⟦ts:2⟧');
  });
  it('differs when the substance of the request differs', () => {
    const a = request('11111111-1111-4111-8111-111111111111', '2026-10-01T10:00:00.000Z', '2026-10-02T09:00:00.000Z');
    const b = structuredClone(a);
    (b.messages[0]?.content[0] as { text: string }).text = 'Create two tasks';
    expect(cassetteKey(normalizeRequest(a).normalized)).not.toBe(cassetteKey(normalizeRequest(b).normalized));
  });
  it('encodes response values relative to the request and decodes them against a new request', () => {
    const r1 = request('11111111-1111-4111-8111-111111111111', '2026-10-01T10:00:00.000Z', '2026-10-02T09:00:00.000Z');
    const n1 = normalizeRequest(r1);
    const encoded = encodeContent(
      [
        {
          type: 'tool_use',
          id: 'x',
          name: 'create_task',
          input: {
            relatedId: '11111111-1111-4111-8111-111111111111',
            dueAt: '2026-10-08T09:00:00.000Z',
            on: '2026-10-08',
          },
        },
      ],
      n1.map,
      r1.metadata?.now,
    );
    expect(JSON.stringify(encoded)).toContain('⟦id:0⟧');
    expect(JSON.stringify(encoded)).toContain('⟦rel:518400000⟧');
    expect(JSON.stringify(encoded)).toContain('⟦reld:6⟧');
    const r2 = request('22222222-2222-4222-8222-222222222222', '2026-10-05T11:30:00.000Z', '2026-10-06T08:00:00.000Z');
    const decoded = decodeContent(encoded, normalizeRequest(r2).map, r2.metadata?.now);
    expect(decoded[0]).toMatchObject({
      input: { relatedId: '22222222-2222-4222-8222-222222222222', dueAt: '2026-10-12T08:00:00.000Z', on: '2026-10-12' },
    });
  });
});

describe('record and replay', () => {
  const store = new CassetteStore(dir);
  it('replays a recorded response for an equivalent request and re-binds volatile values', async () => {
    const recorder = new RecordingProvider(new Echo(), store);
    const live = await recorder.create(
      request('11111111-1111-4111-8111-111111111111', '2026-10-01T10:00:00.000Z', '2026-10-02T09:00:00.000Z'),
    );
    store.flush('m1', 'unit');
    const file = JSON.parse(readFileSync(store.path('m1', 'unit'), 'utf8')) as { entries: Record<string, unknown> };
    expect(Object.keys(file.entries)).toHaveLength(1);
    const replay = new ReplayProvider(new CassetteStore(dir));
    const deltas: string[] = [];
    const out = await replay.create(
      request('33333333-3333-4333-8333-333333333333', '2026-11-01T10:00:00.000Z', '2026-11-02T09:00:00.000Z'),
      { onText: (d) => deltas.push(d) },
    );
    expect(out.usage).toEqual(live.usage);
    expect(out.latencyMs).toBe(42);
    expect(out.provider).toBe('replay:echo');
    expect(out.content[1]).toMatchObject({
      input: { relatedId: '33333333-3333-4333-8333-333333333333', dueAt: '2026-11-08T09:00:00.000Z' },
    });
    expect(deltas.join('')).toBe('Creating it for 33333333-3333-4333-8333-333333333333 due 2026-11-08');
  });
  it('fails a cache miss with a message that says how to re-record', async () => {
    const replay = new ReplayProvider(new CassetteStore(dir));
    const req = request('11111111-1111-4111-8111-111111111111', '2026-10-01T10:00:00.000Z', '2026-10-02T09:00:00.000Z');
    req.system = 'A changed prompt';
    const err = await replay.create(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CassetteMissError);
    expect((err as Error).message).toContain("Cassette miss for scenario 'unit'");
    expect((err as Error).message).toContain('pnpm eval --record --scenario unit');
    expect((err as CassetteMissError).retryable).toBe(false);
  });
});

describe('pricing', () => {
  it('computes cost from the price table', () => {
    const t = new PriceTable();
    expect(t.cost('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(4 + 2, 6);
    expect(
      t.cost('claude-sonnet-5-5', { inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 1_000_000 }),
    ).toBeCloseTo(1 + 0.2, 6);
    expect(t.cost('unknown-model', { inputTokens: 10, outputTokens: 10 })).toBe(0);
  });
  it('accepts overrides from JSON config', () => {
    const t = PriceTable.fromEnv(
      '{"my-model":{"inputPerMTok":1,"outputPerMTok":2,"provider":"openai-compatible","tier":"fast","contextTokens":8000}}',
    );
    expect(t.cost('my-model', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(3);
    expect(t.models()).toContain('claude-haiku-4-5');
  });
});
