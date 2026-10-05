import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { textOf } from '@aio/contracts';
import type { LlmCallOptions, LlmProvider, LlmRequest, LlmResponse } from '../types';
import { LlmError } from '../types';
import { CassetteStore } from './cassette';
import { cassetteKey, decodeContent, encodeContent, normalizeRequest, PlaceholderError } from './normalize';

export class CassetteMissError extends LlmError {
  constructor(
    readonly scenarioId: string,
    readonly model: string,
    readonly key: string,
    readonly turn: number,
  ) {
    super(
      `Cassette miss for scenario '${scenarioId}' (model ${model}, turn ${turn}, key ${key.slice(0, 12)}): ` +
        `the request to the model changed (system prompt, tools or tool results). ` +
        `Re-record the cassettes: pnpm eval --record --scenario ${scenarioId}`,
      false,
      null,
    );
    this.name = 'CassetteMissError';
  }
}

function debugDump(kind: string, scenarioId: string, key: string, normalized: unknown): void {
  const dir = process.env['AIO_CASSETTE_DEBUG'];
  if (dir === undefined || dir === '') return;
  mkdirSync(join(dir, scenarioId), { recursive: true });
  writeFileSync(join(dir, scenarioId, `${kind}-${key.slice(0, 12)}.json`), JSON.stringify(normalized, null, 1));
}

function summarize(request: LlmRequest): string {
  const last = request.messages.at(-1);
  if (last === undefined) return '';
  const text = textOf(last);
  if (text !== '') return text.slice(0, 160);
  return last.content
    .map((b) => (b.type === 'tool_result' ? `tool_result(${b.toolUseId})` : b.type))
    .join(', ')
    .slice(0, 160);
}

async function streamText(content: LlmResponse['content'], onText: ((d: string) => void) | undefined): Promise<void> {
  if (onText === undefined) return;
  for (const block of content) {
    if (block.type !== 'text') continue;
    const parts = block.text.match(/\S+\s*|\s+/g) ?? [];
    for (const part of parts) onText(part);
  }
}

export class ReplayProvider implements LlmProvider {
  readonly name = 'replay';

  constructor(
    private readonly store: CassetteStore,
    private readonly defaultScenario = '_default',
  ) {}

  async create(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    const scenarioId = request.metadata?.scenarioId ?? this.defaultScenario;
    const { normalized, map } = normalizeRequest(request);
    const key = cassetteKey(normalized);
    const entry = this.store.get(request.model, scenarioId, key);
    const turn = request.messages.filter((m) => m.role === 'assistant').length + 1;
    if (entry === undefined) {
      debugDump(`miss-turn${turn}`, scenarioId, key, normalized);
      throw new CassetteMissError(scenarioId, request.model, key, turn);
    }
    let content;
    try {
      content = decodeContent(entry.response.content, map, request.metadata?.now);
    } catch (error) {
      if (error instanceof PlaceholderError) throw new CassetteMissError(scenarioId, request.model, key, turn);
      throw error;
    }
    await streamText(content, options.onText);
    return {
      ...entry.response,
      content,
      provider: `replay:${entry.response.provider}`,
      cached: true,
    };
  }
}

export class RecordingProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private readonly inner: LlmProvider,
    private readonly store: CassetteStore,
    private readonly defaultScenario = '_default',
  ) {
    this.name = `record:${inner.name}`;
  }

  async create(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    const response = await this.inner.create(request, options);
    const scenarioId = request.metadata?.scenarioId ?? this.defaultScenario;
    const { normalized, map } = normalizeRequest(request);
    const key = cassetteKey(normalized);
    const turn = request.messages.filter((m) => m.role === 'assistant').length + 1;
    debugDump(`rec-turn${turn}`, scenarioId, key, normalized);
    this.store.put(
      request.model,
      scenarioId,
      key,
      {
        turn,
        lastMessage: summarize(request),
        response: {
          model: response.model,
          content: encodeContent(response.content, map, request.metadata?.now),
          stopReason: response.stopReason,
          usage: response.usage,
          latencyMs: response.latencyMs,
          firstTokenMs: response.firstTokenMs,
          provider: response.provider,
        },
      },
      this.inner.name,
    );
    return response;
  }
}
