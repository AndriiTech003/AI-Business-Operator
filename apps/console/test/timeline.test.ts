import { describe, expect, it } from 'vitest';
import type { RunDetailDto, RunEvent } from '@aio/contracts';
import {
  applyRunEvent,
  compactArgs,
  emptyTimeline,
  isStreamEnd,
  llmStepText,
  mergeTimelines,
  SseAccumulator,
  stepDecision,
  timelineFromDetail,
  toolStepResult,
  unwrapToolResult,
} from '../src/lib/timeline';
import { decision, RUN_ID, sse, step, usage } from './fixtures';

const events: RunEvent[] = [
  { type: 'status', runId: RUN_ID, status: 'running', stopReason: null },
  { type: 'text', runId: RUN_ID, delta: 'Looking ', seq: null },
  { type: 'text', runId: RUN_ID, delta: 'up invoices', seq: null },
  {
    type: 'step',
    runId: RUN_ID,
    step: step(1, {
      kind: 'llm_call',
      tool: null,
      costUsd: 0.002,
      result: {
        content: [
          { type: 'text', text: 'Looking up invoices' },
          { type: 'tool_use', id: 't1', name: 'list_invoices', input: {} },
        ],
      },
    }),
  },
  { type: 'tool_call', runId: RUN_ID, step: step(2) },
  { type: 'policy', runId: RUN_ID, seq: 2, tool: 'list_invoices', decision: decision('allow', 'default:read') },
  {
    type: 'tool_result',
    runId: RUN_ID,
    step: step(2, {
      result: {
        toolResult: {
          content: '<tool_result tool="list_invoices" untrusted="false">\n[]\n</tool_result>',
          isError: false,
        },
      },
    }),
  },
  { type: 'usage', runId: RUN_ID, usage: usage(0.002) },
  { type: 'done', runId: RUN_ID, status: 'completed', stopReason: 'end_turn', summary: 'No overdue invoices.' },
];

describe('SSE accumulation into a timeline', () => {
  it('parses chunks split at arbitrary boundaries', () => {
    const wire = `: connected\n\n${sse(events)}`;
    const acc = new SseAccumulator();
    const parsed: RunEvent[] = [];
    for (let i = 0; i < wire.length; i += 7) parsed.push(...acc.push(wire.slice(i, i + 7)));
    expect(parsed.map((e) => e.type)).toEqual(events.map((e) => e.type));
  });

  it('ignores unknown event names and broken JSON', () => {
    const acc = new SseAccumulator();
    expect(acc.push('event: nope\ndata: {}\n\nevent: text\ndata: {oops\n\n')).toEqual([]);
  });

  it('builds steps, decisions, cost and summary', () => {
    let state = emptyTimeline();
    const seen: string[] = [];
    for (const e of events) {
      state = applyRunEvent(state, e);
      if (e.type === 'text') seen.push(state.streamingText);
    }
    expect(seen).toEqual(['Looking ', 'Looking up invoices']);
    expect(state.runId).toBe(RUN_ID);
    expect(state.steps.map((s) => s.seq)).toEqual([1, 2]);
    expect(state.streamingText).toBe('');
    expect(state.status).toBe('completed');
    expect(state.summary).toBe('No overdue invoices.');
    expect(state.usage?.costUsd).toBe(0.002);
    expect(stepDecision(state, state.steps[1]!)?.ruleId).toBe('default:read');
    expect(toolStepResult(state.steps[1]!).pending).toBe(false);
    expect(state.done).toBe(true);
  });

  it('does not downgrade a finished step when an older pending copy arrives', () => {
    const done = step(3, { result: { toolResult: { content: 'ok', isError: false } } });
    let state = applyRunEvent(emptyTimeline(RUN_ID), { type: 'tool_result', runId: RUN_ID, step: done });
    state = applyRunEvent(state, { type: 'tool_call', runId: RUN_ID, step: step(3) });
    expect(toolStepResult(state.steps[0]!).content).toBe('ok');
  });

  it('detects the end of a stream', () => {
    expect(isStreamEnd({ type: 'status', runId: RUN_ID, status: 'awaiting_approval', stopReason: null })).toBe(true);
    expect(isStreamEnd({ type: 'status', runId: RUN_ID, status: 'running', stopReason: null })).toBe(false);
    expect(isStreamEnd(events[events.length - 1]!)).toBe(true);
  });

  it('merges a server snapshot with live events', () => {
    const detail = {
      id: RUN_ID,
      status: 'running',
      stopReason: null,
      steps: [step(1, { kind: 'llm_call', tool: null })],
      proposals: [],
      usage: usage(0.001),
      summary: null,
    } as unknown as RunDetailDto;
    let live = emptyTimeline(RUN_ID);
    live = applyRunEvent(live, { type: 'tool_call', runId: RUN_ID, step: step(2) });
    live = applyRunEvent(live, { type: 'text', runId: RUN_ID, delta: 'hi', seq: null });
    live = applyRunEvent(live, { type: 'status', runId: RUN_ID, status: 'awaiting_approval', stopReason: null });
    const merged = mergeTimelines(timelineFromDetail(detail), live, true);
    expect(merged.steps.map((s) => s.seq)).toEqual([1, 2]);
    expect(merged.status).toBe('awaiting_approval');
    expect(merged.streamingText).toBe('hi');
    const settled = mergeTimelines(timelineFromDetail(detail), live, false);
    expect(settled.status).toBe('running');
    expect(settled.streamingText).toBe('');
  });
});

describe('step helpers', () => {
  it('extracts model text and tool uses', () => {
    const s = step(1, {
      kind: 'llm_call',
      result: {
        content: [
          { type: 'text', text: ' Hi ' },
          { type: 'tool_use', name: 'get_contact' },
        ],
      },
    });
    expect(llmStepText(s)).toEqual({ text: 'Hi', toolUses: ['get_contact'] });
  });

  it('unwraps tool results and compacts args', () => {
    expect(unwrapToolResult('<tool_result tool="x" untrusted="true">\n{"a":1}\n</tool_result>')).toEqual({
      body: '{"a":1}',
      untrusted: true,
    });
    expect(unwrapToolResult('blocked by policy no-void: x')).toEqual({
      body: 'blocked by policy no-void: x',
      untrusted: null,
    });
    expect(compactArgs({ number: 'INV-1', limit: 5 })).toBe('number: "INV-1", limit: 5');
  });
});
