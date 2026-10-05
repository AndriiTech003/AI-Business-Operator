import type { ChatMessage, ContentBlock } from '@aio/contracts';

export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: LlmTool[];
  maxTokens: number;
  metadata?: LlmRequestMetadata;
}

export interface LlmRequestMetadata {
  now?: string;
  runId?: string;
  scenarioId?: string;
}

export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'stop_sequence';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResponse {
  model: string;
  content: ContentBlock[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
  latencyMs: number;
  firstTokenMs: number | null;
  provider: string;
  cached?: boolean;
}

export interface LlmCallOptions {
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly name: string;
  create(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
