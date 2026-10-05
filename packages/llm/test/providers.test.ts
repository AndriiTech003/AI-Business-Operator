import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@aio/contracts';
import {
  AnthropicProvider,
  createProvider,
  OpenAiCompatibleProvider,
  toAnthropicMessages,
  toOpenAiMessages,
  type LlmRequest,
} from '../src';

const messages: ChatMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Find stale leads' }] },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', provider: 'anthropic', data: { type: 'thinking', thinking: '', signature: 'sig' } },
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'list_contacts', input: { status: 'lead' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_1', content: 'boom', isError: true }] },
];

const request: LlmRequest = {
  model: 'claude-opus-5-5',
  system: 'You are an operator.',
  messages,
  tools: [
    {
      name: 'list_contacts',
      description: 'List',
      inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
    },
  ],
  maxTokens: 8000,
};

describe('Anthropic adapter (never called over the network)', () => {
  it('maps messages, keeps thinking blocks and marks tool errors', () => {
    const out = toAnthropicMessages(messages);
    expect(out[1]?.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'list_contacts', input: { status: 'lead' } },
    ]);
    expect(out[2]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true }]);
  });
  it('builds a streaming request with cached system prompt, eager tool streaming, effort and fallbacks', () => {
    const params = new AnthropicProvider({ apiKey: 'unused', effort: 'high' }).buildParams(
      request,
    ) as unknown as Record<string, unknown>;
    expect(params['stream']).toBe(true);
    expect(params['model']).toBe('claude-opus-5-5');
    expect(params['system']).toEqual([
      { type: 'text', text: 'You are an operator.', cache_control: { type: 'ephemeral' } },
    ]);
    expect((params['tools'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: 'list_contacts',
      eager_input_streaming: true,
    });
    expect(params['output_config']).toEqual({ effort: 'high' });
    expect(params['betas']).toEqual(['server-side-fallback-2026-07-01']);
    expect(params['fallbacks']).toBe('default');
    expect(params['thinking']).toBeUndefined();
  });
  it('requires an API key to be selected', () => {
    expect(() => createProvider({ kind: 'anthropic', model: 'claude-opus-5-5' })).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('OpenAI-compatible adapter (never called over the network)', () => {
  it('maps messages to chat-completions format', () => {
    const out = toOpenAiMessages('sys', messages);
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Find stale leads' },
      {
        role: 'assistant',
        content: 'Looking.',
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'list_contacts', arguments: '{"status":"lead"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'ERROR: boom' },
    ]);
  });
  it('builds a streaming body with tools', () => {
    const body = new OpenAiCompatibleProvider({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x' }).buildBody(request);
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true }, tool_choice: 'auto' });
    expect((body['tools'] as Array<{ function: { name: string } }>)[0]?.function.name).toBe('list_contacts');
  });
  it('requires base URL and key', () => {
    expect(() => createProvider({ kind: 'openai', model: 'x' })).toThrow(/OPENAI_BASE_URL/);
  });
});
