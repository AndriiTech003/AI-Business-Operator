import type { ChatMessage, ContentBlock } from '@aio/contracts';
import type { LlmRequest, LlmTool } from './types';

export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

export function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'tool_use':
      return `${block.name} ${JSON.stringify(block.input)}`;
    case 'tool_result':
      return block.content;
    case 'reasoning':
      return JSON.stringify(block.data ?? '');
  }
}

export function estimateMessageTokens(message: ChatMessage): number {
  return 4 + message.content.reduce((sum, b) => sum + estimateTextTokens(blockText(b)) + 3, 0);
}

export function estimateToolsTokens(tools: LlmTool[]): number {
  return tools.reduce(
    (sum, t) => sum + estimateTextTokens(`${t.name}${t.description}${JSON.stringify(t.inputSchema)}`),
    0,
  );
}

export function estimateRequestTokens(request: Pick<LlmRequest, 'system' | 'messages' | 'tools'>): number {
  return (
    estimateTextTokens(request.system) +
    request.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0) +
    estimateToolsTokens(request.tools)
  );
}
