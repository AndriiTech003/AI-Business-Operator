import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ContentBlock } from '@aio/contracts';
import {
  LlmError,
  type LlmCallOptions,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmStopReason,
} from '../types';

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  fallbacks?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
}

type BetaParams = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function toParamBlock(block: ContentBlock): BetaContentBlockParam | null {
  switch (block.type) {
    case 'text':
      return block.text.length === 0 ? null : { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError === true ? { is_error: true } : {}),
      };
    case 'reasoning':
      return block.provider === 'anthropic' ? (block.data as BetaContentBlockParam) : null;
  }
}

export function toAnthropicMessages(messages: ChatMessage[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of messages) {
    const content = m.content.map(toParamBlock).filter((b): b is BetaContentBlockParam => b !== null);
    if (content.length === 0) continue;
    out.push({ role: m.role, content });
  }
  return out;
}

function fromResponseBlocks(blocks: Anthropic.Beta.Messages.BetaContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use')
      out.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    else out.push({ type: 'reasoning', provider: 'anthropic', data: b });
  }
  return out;
}

function mapStop(reason: string | null): LlmStopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause_turn';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicProviderOptions = {}) {
    this.client = new Anthropic({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      timeout: options.timeoutMs ?? 600_000,
      maxRetries: options.maxRetries ?? 2,
    });
  }

  buildParams(request: LlmRequest): BetaParams {
    const tools: BetaToolUnion[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema,
      eager_input_streaming: true,
    }));
    const params: BetaParams = {
      model: request.model,
      max_tokens: request.maxTokens,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: toAnthropicMessages(request.messages),
      tools,
      stream: true,
      output_config: { effort: this.options.effort ?? 'medium' },
    };
    if (this.options.fallbacks !== false) {
      Object.assign(params, { betas: [FALLBACK_BETA], fallbacks: 'default' });
    }
    return params;
  }

  async create(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    const started = Date.now();
    let firstTokenMs: number | null = null;
    const stream = this.client.beta.messages.stream(this.buildParams(request), { signal: options.signal });
    stream.on('text', (delta) => {
      if (firstTokenMs === null) firstTokenMs = Date.now() - started;
      options.onText?.(delta);
    });
    let message: Anthropic.Beta.Messages.BetaMessage;
    try {
      message = await stream.finalMessage();
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) throw new LlmError(error.message, true, 429);
      if (error instanceof Anthropic.InternalServerError) throw new LlmError(error.message, true, error.status);
      if (error instanceof Anthropic.APIConnectionError) throw new LlmError(error.message, true, null);
      if (error instanceof Anthropic.APIError) throw new LlmError(error.message, false, error.status ?? null);
      throw new LlmError(`tool input could not be parsed: ${(error as Error).message}`, true, null);
    }
    const stopReason = mapStop(message.stop_reason);
    const hasToolUse = message.content.some((b) => b.type === 'tool_use');
    if (stopReason === 'max_tokens' && hasToolUse)
      throw new LlmError('tool input truncated at max_tokens; retry with a higher max_tokens', true, null);
    const content =
      stopReason === 'refusal'
        ? fromResponseBlocks(message.content).filter((b) => b.type !== 'tool_use')
        : fromResponseBlocks(message.content);
    return {
      model: message.model,
      content,
      stopReason,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
      firstTokenMs,
      provider: this.name,
    };
  }
}
