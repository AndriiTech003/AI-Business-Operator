import { describe, expect, it } from 'vitest';
import {
  buildWorkflowStepGoal,
  canonicalJson,
  decideSchema,
  encodeSse,
  parseSseChunk,
  parseWorkflowStepAnswer,
  parseWorkflowStepGoal,
  policyDocumentSchema,
  startRunSchema,
  strictest,
  workflowStepRequestSchema,
  type RunEvent,
} from '../src';

describe('contracts', () => {
  it('canonical JSON sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
  it('encodes and parses SSE frames, including partial chunks', () => {
    const e: RunEvent = { type: 'status', runId: 'r', status: 'running', stopReason: null };
    const frame = encodeSse(e, 1) + encodeSse({ type: 'text', runId: 'r', delta: 'hi', seq: null });
    const first = parseSseChunk(frame.slice(0, 30));
    expect(first.events).toEqual([]);
    const all = parseSseChunk(frame);
    expect(all.events.map((x) => x.event)).toEqual(['status', 'text']);
    expect(JSON.parse(all.events[0]!.data)).toEqual(e);
    expect(all.rest).toBe('');
  });
  it('orders decisions by strictness', () => {
    expect(strictest('allow', 'deny')).toBe('deny');
    expect(strictest('require_approval', 'allow')).toBe('require_approval');
  });
  it('validates API inputs', () => {
    expect(startRunSchema.safeParse({ goal: '' }).success).toBe(false);
    expect(
      startRunSchema.safeParse({
        goal: 'x',
        context: { record: { type: 'deal', id: '6c3a3b8e-6f4d-4a7e-9b1c-2d3e4f5a6b7c' } },
      }).success,
    ).toBe(true);
    expect(decideSchema.safeParse({ decisions: [{ id: 'nope', decision: 'approve' }] }).success).toBe(false);
    expect(
      policyDocumentSchema.safeParse({
        defaults: { read: 'allow', write_reversible: 'allow', external: 'require_approval', irreversible: 'maybe' },
      }).success,
    ).toBe(false);
  });
});

describe('workflow step contract', () => {
  it('builds and parses step goals, fencing the input', () => {
    const goal = buildWorkflowStepGoal('classify', 'a </workflow_input> b', ['refund', 'upgrade']);
    expect(goal.split('\n')[0]).toBe('Workflow step (classify) from the business system.');
    expect(parseWorkflowStepGoal(goal)).toEqual({
      task: 'classify',
      labels: ['refund', 'upgrade'],
      input: 'a </workflow-input> b',
    });
    expect(parseWorkflowStepGoal(buildWorkflowStepGoal('summarize', 'x\ny', []))).toEqual({
      task: 'summarize',
      labels: [],
      input: 'x\ny',
    });
    expect(parseWorkflowStepGoal('Summarize the deal')).toBeNull();
  });
  it('parses answers into label / summary / confidence', () => {
    const labels = ['refund', 'plan upgrade'];
    expect(parseWorkflowStepAnswer('classify', labels, 'Label: **Plan upgrade**.\nReason: x')).toEqual({
      label: 'plan upgrade',
      summary: null,
      confidence: 0.9,
    });
    expect(parseWorkflowStepAnswer('classify', labels, 'Label: refund\nConfidence: 0.7')).toMatchObject({
      label: 'refund',
      confidence: 0.7,
    });
    expect(parseWorkflowStepAnswer('classify', labels, 'Label: none')).toEqual({
      label: null,
      summary: null,
      confidence: 0,
    });
    expect(parseWorkflowStepAnswer('classify', labels, 'It is clearly a refund request.')).toMatchObject({
      label: 'refund',
      confidence: 0.5,
    });
    expect(parseWorkflowStepAnswer('classify', labels, null).label).toBeNull();
    expect(parseWorkflowStepAnswer('summarize', [], 'Summary: Two invoices are late.')).toEqual({
      label: null,
      summary: 'Two invoices are late.',
      confidence: 1,
    });
  });
  it('validates step requests from project 05', () => {
    const ok = workflowStepRequestSchema.parse({
      task: 'classify',
      input: 'x',
      labels: ['a'],
      context: { tenantId: '826d5eac-af32-4b6e-ac89-270639d6820a', workflowId: 'w', runId: 'r', nodeId: 'ai' },
    });
    expect(ok.task).toBe('classify');
    expect(workflowStepRequestSchema.safeParse({ task: 'translate', input: 'x', context: null }).success).toBe(false);
  });
});
