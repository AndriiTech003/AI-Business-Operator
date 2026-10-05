import type { ChatMessage, ContentBlock } from '@aio/contracts';
import { estimateMessageTokens, estimateTextTokens } from '@aio/llm';

export interface TruncateOptions {
  maxTokens: number;
}

export function truncatePayload(
  payload: Record<string, unknown>,
  options: TruncateOptions,
): { payload: Record<string, unknown>; truncated: boolean } {
  const text = JSON.stringify(payload);
  if (estimateTextTokens(text) <= options.maxTokens) return { payload, truncated: false };
  const result = payload['result'];
  if (result !== null && typeof result === 'object' && Array.isArray((result as { items?: unknown[] }).items)) {
    const items = (result as { items: unknown[] }).items;
    let keep = items.length;
    while (keep > 0) {
      keep = Math.floor(keep * 0.75);
      const candidate = {
        ...payload,
        result: { ...(result as object), items: items.slice(0, keep) },
        truncated: true,
        omittedItems: items.length - keep,
        hint: 'Result truncated to fit the context: narrow the filters, or lower `limit` and page through the rest with `cursor`.',
      };
      if (estimateTextTokens(JSON.stringify(candidate)) <= options.maxTokens)
        return { payload: candidate, truncated: true };
    }
  }
  const maxChars = Math.max(200, options.maxTokens * 4 - 300);
  return {
    payload: {
      tool: payload['tool'],
      truncated: true,
      preview: text.slice(0, maxChars),
      hint: 'Result truncated to fit the context: request fewer fields or a narrower filter.',
      untrusted: payload['untrusted'] ?? [],
    },
    truncated: true,
  };
}

export interface CompactionOptions {
  maxContextTokens: number;
  targetRatio: number;
  keepRecentMessages: number;
}

export const DEFAULT_COMPACTION: CompactionOptions = {
  maxContextTokens: 60_000,
  targetRatio: 0.6,
  keepRecentMessages: 4,
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LABEL_RE = /"(?:name|title|number|email)":"([^"]{1,80})"/g;

export function summarizeToolResult(content: string): string {
  const tool = /<tool_result tool="([^"]+)"/.exec(content)?.[1] ?? 'tool';
  const ids = [...new Set((content.match(UUID_RE) ?? []).map((s) => s.toLowerCase()))].slice(0, 60);
  const labels = [...new Set([...content.matchAll(LABEL_RE)].map((m) => m[1] as string))].slice(0, 30);
  return `<tool_result tool="${tool}" untrusted="true" compacted="true">[compacted to save context: ${content.length} chars] record ids: ${ids.join(', ') || '(none)'}; labels: ${labels.join(' | ') || '(none)'}. Call the tool again if you need details.</tool_result>`;
}

export function contextTokens(system: string, messages: ChatMessage[]): number {
  return estimateTextTokens(system) + messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
}

export interface CompactionResult {
  messages: ChatMessage[];
  compactedBlocks: number;
  beforeTokens: number;
  afterTokens: number;
}

export function compactMessages(
  system: string,
  messages: ChatMessage[],
  options: CompactionOptions = DEFAULT_COMPACTION,
): CompactionResult {
  const beforeTokens = contextTokens(system, messages);
  if (beforeTokens <= options.maxContextTokens)
    return { messages, compactedBlocks: 0, beforeTokens, afterTokens: beforeTokens };
  const target = options.maxContextTokens * options.targetRatio;
  const out: ChatMessage[] = messages.map((m) => ({ role: m.role, content: [...m.content] }));
  let tokens = beforeTokens;
  let compacted = 0;
  const limit = Math.max(0, out.length - options.keepRecentMessages);
  for (let i = 0; i < limit && tokens > target; i += 1) {
    const msg = out[i] as ChatMessage;
    msg.content = msg.content.map((b): ContentBlock => {
      if (tokens <= target || b.type !== 'tool_result' || b.content.includes('compacted="true"')) return b;
      const summary = summarizeToolResult(b.content);
      if (summary.length >= b.content.length) return b;
      tokens -= estimateTextTokens(b.content) - estimateTextTokens(summary);
      compacted += 1;
      return { ...b, content: summary };
    });
  }
  return { messages: out, compactedBlocks: compacted, beforeTokens, afterTokens: contextTokens(system, out) };
}
