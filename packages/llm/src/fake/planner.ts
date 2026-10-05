import type { ContentBlock } from '@aio/contracts';
import { estimateRequestTokens, estimateTextTokens } from '../tokens';
import type { LlmCallOptions, LlmProvider, LlmRequest, LlmResponse } from '../types';
import { parseConversation, parseSystem, toolUseId } from './context';
import { Helper, Need, NoTools } from './helper';
import { budgetSummary, detectIntent } from './intents';

export interface FakePlannerOptions {
  model?: string;
}

export class FakePlannerProvider implements LlmProvider {
  readonly name = 'fake';

  constructor(private readonly options: FakePlannerOptions = {}) {}

  plan(request: LlmRequest): { content: ContentBlock[]; intent: string } {
    const sys = parseSystem(request.system);
    const conv = parseConversation(request);
    const helper = new Helper(sys, conv);
    const intent = detectIntent(conv.goal);
    try {
      const text = conv.noTools ? budgetSummary(helper) : intent.run(helper);
      return { content: [{ type: 'text', text }], intent: intent.name };
    } catch (signal) {
      if (signal instanceof NoTools)
        return { content: [{ type: 'text', text: budgetSummary(helper) }], intent: intent.name };
      if (signal instanceof Need) {
        const turn = conv.turn + 1;
        const blocks: ContentBlock[] = [];
        if (signal.text !== '') blocks.push({ type: 'text', text: signal.text });
        signal.calls.forEach((c, i) =>
          blocks.push({ type: 'tool_use', id: toolUseId(turn, i, c.name, c.input), name: c.name, input: c.input }),
        );
        if (signal.calls.length === 0) blocks.push({ type: 'text', text: 'Waiting for pending results.' });
        return { content: blocks, intent: intent.name };
      }
      throw signal;
    }
  }

  async create(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    const { content } = this.plan(request);
    const inputTokens = estimateRequestTokens(request);
    const outputTokens = content.reduce(
      (s, b) =>
        s +
        (b.type === 'text'
          ? estimateTextTokens(b.text)
          : b.type === 'tool_use'
            ? estimateTextTokens(JSON.stringify(b.input)) + 12
            : 0),
      0,
    );
    for (const b of content) {
      if (b.type !== 'text' || options.onText === undefined) continue;
      for (const part of b.text.match(/\S+\s*|\s+/g) ?? []) options.onText(part);
    }
    const hasTools = content.some((b) => b.type === 'tool_use');
    return {
      model: this.options.model ?? request.model,
      content,
      stopReason: hasTools ? 'tool_use' : 'end_turn',
      usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
      latencyMs: 350 + outputTokens * 6 + (inputTokens % 50),
      firstTokenMs: 180 + (inputTokens % 97),
      provider: this.name,
    };
  }
}
