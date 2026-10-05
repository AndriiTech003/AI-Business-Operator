import type { ChatMessage, ContentBlock } from '@aio/contracts';
import {
  LlmError,
  type LlmCallOptions,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmStopReason,
} from '../types';

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

interface OaToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type OaMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OaToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toOpenAiMessages(system: string, messages: ChatMessage[]): OaMessage[] {
  const out: OaMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content
        .filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('');
      const calls: OaToolCall[] = m.content.flatMap((b) =>
        b.type === 'tool_use'
          ? [{ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }]
          : [],
      );
      out.push({
        role: 'assistant',
        content: text === '' ? null : text,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }
    const texts: string[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result')
        out.push({
          role: 'tool',
          tool_call_id: b.toolUseId,
          content: b.isError === true ? `ERROR: ${b.content}` : b.content,
        });
      else if (b.type === 'text') texts.push(b.text);
    }
    if (texts.length > 0) out.push({ role: 'user', content: texts.join('\n') });
  }
  return out;
}

function mapFinish(reason: string | null | undefined, hasTools: boolean): LlmStopReason {
  if (reason === 'tool_calls' || (hasTools && reason === 'stop')) return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'refusal';
  return 'end_turn';
}

interface StreamChunk {
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible';

  constructor(private readonly options: OpenAiCompatibleOptions) {}

  buildBody(request: LlmRequest): Record<string, unknown> {
    return {
      model: request.model,
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAiMessages(request.system, request.messages),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
            tool_choice: 'auto',
          }
        : {}),
    };
  }

  async create(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    const started = Date.now();
    const signals = [AbortSignal.timeout(this.options.timeoutMs ?? 600_000)];
    if (options.signal !== undefined) signals.push(options.signal);
    const res = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
        ...(this.options.extraHeaders ?? {}),
      },
      body: JSON.stringify(this.buildBody(request)),
      signal: AbortSignal.any(signals),
    }).catch((error: unknown) => {
      throw new LlmError(`connection failed: ${(error as Error).message}`, true, null);
    });
    if (!res.ok || res.body === null) {
      const text = await res.text().catch(() => '');
      throw new LlmError(
        `HTTP ${res.status}: ${text.slice(0, 500)}`,
        res.status === 429 || res.status >= 500,
        res.status,
      );
    }
    let firstTokenMs: number | null = null;
    let text = '';
    let model = request.model;
    let finish: string | null | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const parsed = JSON.parse(data) as StreamChunk;
        if (parsed.model !== undefined) model = parsed.model;
        if (parsed.usage !== undefined) {
          inputTokens = parsed.usage.prompt_tokens ?? inputTokens;
          outputTokens = parsed.usage.completion_tokens ?? outputTokens;
          cachedTokens = parsed.usage.prompt_tokens_details?.cached_tokens ?? cachedTokens;
        }
        for (const choice of parsed.choices ?? []) {
          const delta = choice.delta;
          if (delta?.content) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started;
            text += delta.content;
            options.onText?.(delta.content);
          }
          for (const tc of delta?.tool_calls ?? []) {
            const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
            if (tc.id !== undefined) cur.id = tc.id;
            if (tc.function?.name !== undefined) cur.name += tc.function.name;
            if (tc.function?.arguments !== undefined) cur.args += tc.function.arguments;
            calls.set(tc.index, cur);
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) finish = choice.finish_reason;
        }
      }
    }
    const content: ContentBlock[] = [];
    if (text !== '') content.push({ type: 'text', text });
    for (const [, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: Record<string, unknown>;
      try {
        input = call.args.trim() === '' ? {} : (JSON.parse(call.args) as Record<string, unknown>);
      } catch {
        throw new LlmError(`tool call ${call.name} returned invalid JSON arguments`, true, null);
      }
      content.push({ type: 'tool_use', id: call.id, name: call.name, input });
    }
    return {
      model,
      content,
      stopReason: mapFinish(finish, calls.size > 0),
      usage: {
        inputTokens: inputTokens - cachedTokens,
        outputTokens,
        cacheReadTokens: cachedTokens,
        cacheWriteTokens: 0,
      },
      latencyMs: Date.now() - started,
      firstTokenMs,
      provider: this.name,
    };
  }
}
