export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ReasoningBlock {
  type: 'reasoning';
  provider: string;
  data: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ReasoningBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export function textOf(message: ChatMessage): string {
  return message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export function toolUsesOf(message: ChatMessage): ToolUseBlock[] {
  return message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

export function toolResultsOf(message: ChatMessage): ToolResultBlock[] {
  return message.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');
}
