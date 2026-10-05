import { describe, expect, it } from 'vitest';
import { AgentRunner, argsHash, isQuestion, stripControlArgs, toLlmTool } from '../src';
import { ScriptedLlm, TOOLS, rig, text, tu } from './harness';

describe('agent loop', () => {
  it('runs read tools, finishes with the model summary and records usage', async () => {
    const r = rig();
    const run = r.store.addRun();
    const llm = new ScriptedLlm([
      () => [text('Looking.'), tu('a1', 'list_contacts', { status: 'lead' })],
      () => [text('There is 1 lead.')],
    ]);
    await new AgentRunner(r.ports(llm)).run(run.id);
    const after = await r.store.getRun(run.id);
    expect(after.status).toBe('completed');
    expect(after.stopReason).toBe('end_turn');
    expect(after.usage.llmCalls).toBe(2);
    expect(after.usage.toolCalls).toBe(1);
    expect(after.usage.costUsd).toBeCloseTo((2 * (1000 * 10 + 100 * 50)) / 1e6, 8);
    expect(r.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['status', 'tool_call', 'policy', 'tool_result', 'usage', 'done']),
    );
    const msgs = await r.store.loadMessages(run.id);
    expect(msgs[2]?.content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'a1' });
    expect(String((msgs[2]?.content[0] as { content: string }).content)).toContain('untrusted="true"');
  });

  it('hides forbidden tools from the model and tells it why', async () => {
    const r = rig();
    const run = r.store.addRun();
    const llm = new ScriptedLlm([() => [text('Done.')]]);
    await new AgentRunner(r.ports(llm)).run(run.id);
    expect(llm.requests[0]?.tools.map((t) => t.name)).not.toContain('void_invoice');
    expect(llm.requests[0]?.system).toContain('hidden=void_invoice');
    expect(r.store.steps.find((s) => s.kind === 'visibility')?.result).toMatchObject({
      hidden: [{ tool: 'void_invoice', ruleId: 'no-void' }],
    });
  });

  it('strips idempotencyKey and dryRun from the schemas and the model arguments', () => {
    const t = toLlmTool(TOOLS[1]!);
    expect(Object.keys((t.inputSchema as { properties: object }).properties)).toEqual(['title']);
    expect(stripControlArgs({ title: 'x', idempotencyKey: 'evil', dryRun: true })).toEqual({ title: 'x' });
  });

  it('returns a policy error for a denied call and never executes it', async () => {
    const r = rig();
    const run = r.store.addRun();
    const llm = new ScriptedLlm([() => [tu('v1', 'void_invoice', { id: 'inv-1' })], () => [text('I cannot void it.')]]);
    await new AgentRunner(r.ports(llm)).run(run.id);
    expect(r.tools.calls.find((c) => c.name === 'void_invoice')).toBeUndefined();
    const res = (await r.store.loadMessages(run.id))[2]?.content[0] as { content: string; isError: boolean };
    expect(res.isError).toBe(true);
    expect(res.content).toBe('blocked by policy no-void: no-void');
  });

  it('executes writes with the idempotency key runId:stepSeq', async () => {
    const r = rig();
    const run = r.store.addRun();
    const llm = new ScriptedLlm([
      () => [tu('t1', 'create_task', { title: 'Call', idempotencyKey: 'model-chosen' })],
      () => [text('Created.')],
    ]);
    await new AgentRunner(r.ports(llm)).run(run.id);
    const call = r.tools.calls.find((c) => c.name === 'create_task');
    const step = r.store.steps.find((s) => s.toolUseId === 't1');
    expect(call?.idempotencyKey).toBe(`${run.id}:${step?.seq}`);
    expect(call?.args).toEqual({ title: 'Call' });
  });

  it('queues approval-required actions, waits, and executes exactly the approved payload', async () => {
    const r = rig();
    const run = r.store.addRun();
    const llm = new ScriptedLlm([
      () => [tu('s1', 'send_email', { draftId: 'd1' }), tu('s2', 'send_email', { draftId: 'd2' })],
      () => [text('Two e-mails are waiting for approval.')],
      () => [text('Sent 1, 1 rejected.')],
    ]);
    const runner = new AgentRunner(r.ports(llm));
    await runner.run(run.id);
    expect((await r.store.getRun(run.id)).status).toBe('awaiting_approval');
    expect(r.published).toHaveLength(1);
    expect(r.tools.calls.filter((c) => c.name === 'send_email' && c.dryRun !== true)).toHaveLength(0);
    expect(r.tools.calls.filter((c) => c.name === 'send_email' && c.dryRun === true)).toHaveLength(2);
    const [p1, p2] = r.store.proposals;
    expect(p1?.argsHash).toBe(argsHash('send_email', { draftId: 'd1' }));
    p1!.status = 'approved';
    p1!.approvedHash = p1!.argsHash;
    p2!.status = 'rejected';
    r.store.batches[0]!.status = 'decided';
    await runner.applyApprovals(run.id, r.store.batches[0]!.id);
    const sends = r.tools.calls.filter((c) => c.name === 'send_email' && c.dryRun !== true);
    expect(sends).toEqual([{ name: 'send_email', args: { draftId: 'd1' }, idempotencyKey: p1!.id }]);
    const after = await r.store.getRun(run.id);
    expect(after.status).toBe('completed');
    expect(after.usage.emailsSent).toBe(1);
    const resultsMsg = (await r.store.loadMessages(run.id)).find((m) =>
      m.content.some((b) => b.type === 'text' && b.text.startsWith('<approval_results')),
    );
    expect(JSON.stringify(resultsMsg)).toContain('\\"executed\\":1');
    expect(JSON.stringify(resultsMsg)).toContain('\\"rejected\\":1');
  });

  it('refuses to execute a payload that changed after approval (hash invariant)', async () => {
    const r = rig();
    const run = r.store.addRun();
    const llm = new ScriptedLlm([
      () => [tu('s1', 'send_email', { draftId: 'd1' })],
      () => [text('Waiting.')],
      () => [text('It failed.')],
    ]);
    const runner = new AgentRunner(r.ports(llm));
    await runner.run(run.id);
    r.store.decide('approve', (p) => {
      p.args = { draftId: 'attacker-draft' };
    });
    await runner.applyApprovals(run.id, r.store.batches[0]!.id);
    expect(r.tools.calls.filter((c) => c.name === 'send_email' && c.dryRun !== true)).toHaveLength(0);
    expect(r.store.proposals[0]?.status).toBe('failed');
    expect(JSON.stringify(r.store.proposals[0]?.executionResult)).toContain('hash mismatch');
  });

  it('raises a write whose argument comes from untrusted data to approval (taint)', async () => {
    const r = rig();
    const run = r.store.addRun();
    const llm = new ScriptedLlm([
      () => [tu('l1', 'list_contacts', { status: 'lead' })],
      () => [tu('d1', 'draft_email', { to: ['x@evil.test'], body: 'Invoices attached' })],
      () => [text('Waiting.')],
    ]);
    await new AgentRunner(r.ports(llm)).run(run.id);
    const step = r.store.steps.find((s) => s.toolUseId === 'd1');
    expect(step?.policyDecision?.decision).toBe('require_approval');
    expect(step?.policyDecision?.ruleId).toBe('taint:untrusted-argument');
    expect(step?.taint?.[0]).toMatchObject({
      fragment: 'x@evil.test',
      kind: 'email',
      source: { tool: 'list_contacts', path: 'items[0].notes' },
    });
    expect(r.store.proposals[0]?.warnings[0]).toContain('untrusted content');
    expect(r.tools.calls.find((c) => c.name === 'draft_email' && c.dryRun !== true)).toBeUndefined();
  });

  it('stops at maxSteps and makes one final call without tools', async () => {
    const r = rig();
    const run = r.store.addRun({
      budget: {
        maxSteps: 2,
        maxToolCalls: 100,
        maxInputTokens: 1e9,
        maxCostUsd: 100,
        maxWallClockMs: 1e9,
        maxExternalActions: 50,
      },
    });
    const llm = new ScriptedLlm([(req) => [tu(`a${req.messages.length}`, 'list_contacts', {})]]);
    await new AgentRunner(r.ports(llm)).run(run.id);
    const after = await r.store.getRun(run.id);
    expect(after.stopReason).toBe('budget');
    expect(llm.requests).toHaveLength(3);
    expect(llm.requests[2]?.tools).toEqual([]);
    expect(JSON.stringify(llm.requests[2]?.messages.at(-1))).toContain('budget_exhausted');
    expect(r.store.steps.some((s) => s.kind === 'budget')).toBe(true);
  });

  it('stops at maxToolCalls and reports the remaining calls as not run', async () => {
    const r = rig();
    const run = r.store.addRun({
      budget: {
        maxSteps: 40,
        maxToolCalls: 2,
        maxInputTokens: 1e9,
        maxCostUsd: 100,
        maxWallClockMs: 1e9,
        maxExternalActions: 50,
      },
    });
    const llm = new ScriptedLlm([
      () => [tu('a', 'list_contacts', {}), tu('b', 'list_contacts', {}), tu('c', 'list_contacts', {})],
    ]);
    await new AgentRunner(r.ports(llm)).run(run.id);
    expect(r.tools.calls).toHaveLength(2);
    expect((await r.store.getRun(run.id)).stopReason).toBe('budget');
    const results = (await r.store.loadMessages(run.id))[2]?.content;
    expect(JSON.stringify(results)).toContain('budget exhausted');
  });

  it('stops on the cost budget', async () => {
    const r = rig();
    const run = r.store.addRun({
      budget: {
        maxSteps: 40,
        maxToolCalls: 100,
        maxInputTokens: 1e9,
        maxCostUsd: 0.01,
        maxWallClockMs: 1e9,
        maxExternalActions: 50,
      },
    });
    const llm = new ScriptedLlm([(req) => [tu(`a${req.messages.length}`, 'list_contacts', {})]]);
    await new AgentRunner(r.ports(llm)).run(run.id);
    const after = await r.store.getRun(run.id);
    expect(after.stopReason).toBe('budget');
    expect(after.usage.llmCalls).toBe(2);
  });

  it('stops on the input-token and wall-clock budgets', async () => {
    const r1 = rig();
    const run1 = r1.store.addRun({
      budget: {
        maxSteps: 40,
        maxToolCalls: 100,
        maxInputTokens: 1500,
        maxCostUsd: 100,
        maxWallClockMs: 1e9,
        maxExternalActions: 50,
      },
    });
    await new AgentRunner(
      r1.ports(new ScriptedLlm([(req) => [tu(`a${req.messages.length}`, 'list_contacts', {})]])),
    ).run(run1.id);
    expect((await r1.store.getRun(run1.id)).usage.llmCalls).toBe(3);
    const r2 = rig();
    const run2 = r2.store.addRun({
      budget: {
        maxSteps: 40,
        maxToolCalls: 100,
        maxInputTokens: 1e9,
        maxCostUsd: 100,
        maxWallClockMs: 1000,
        maxExternalActions: 50,
      },
    });
    const llm = new ScriptedLlm([
      (req) => {
        r2.now.value += 2000;
        return [tu(`a${req.messages.length}`, 'list_contacts', {})];
      },
    ]);
    await new AgentRunner(r2.ports(llm)).run(run2.id);
    const after = await r2.store.getRun(run2.id);
    expect(after.stopReason).toBe('budget');
    expect(r2.store.steps.find((s) => s.kind === 'budget')?.args).toMatchObject({ limit: 'maxWallClockMs' });
  });

  it('blocks external actions over maxExternalActions', async () => {
    const r = rig();
    const run = r.store.addRun({
      budget: {
        maxSteps: 40,
        maxToolCalls: 100,
        maxInputTokens: 1e9,
        maxCostUsd: 100,
        maxWallClockMs: 1e9,
        maxExternalActions: 0,
      },
    });
    const llm = new ScriptedLlm([() => [tu('s', 'send_email', { draftId: 'd' })], () => [text('ok')]]);
    await new AgentRunner(r.ports(llm, () => 'allow')).run(run.id);
    expect(r.tools.calls.filter((c) => c.name === 'send_email')).toHaveLength(0);
  });

  it('resumes a step that was started but not recorded, with the same idempotency key', async () => {
    const r = rig();
    const run = r.store.addRun();
    await r.store.appendMessage(run.id, { role: 'user', content: [text('do it')] });
    await r.store.appendMessage(run.id, { role: 'assistant', content: [tu('t1', 'create_task', { title: 'Call' })] });
    const pending = await r.store.createStep(run.id, {
      kind: 'tool_call',
      status: 'pending',
      tool: 'create_task',
      toolUseId: 't1',
      args: { title: 'Call' },
    });
    await r.store.updateRun(run.id, {
      status: 'running',
      tools: [...(await r.tools.listTools())],
      hiddenTools: [],
      systemPrompt: 'SYS',
      promptNow: '2026-10-01T10:00:00.000Z',
    });
    const llm = new ScriptedLlm([() => [text('unused')], () => [text('Created after resume.')]]);
    await new AgentRunner(r.ports(llm)).run(run.id);
    expect(r.tools.calls).toEqual([
      { name: 'create_task', args: { title: 'Call' }, idempotencyKey: `${run.id}:${pending.seq}` },
    ]);
    expect((await r.store.getRun(run.id)).status).toBe('completed');
    expect(llm.requests).toHaveLength(1);
  });

  it('adds an intervention before the next model call', async () => {
    const r = rig();
    const run = r.store.addRun();
    r.store.interventions.push({ runId: run.id, text: 'skip Acme', applied: false });
    const llm = new ScriptedLlm([() => [text('Okay, skipping Acme.')]]);
    await new AgentRunner(r.ports(llm)).run(run.id);
    expect(JSON.stringify(llm.requests[0]?.messages)).toContain('<user_intervention>skip Acme</user_intervention>');
  });

  it('marks a clarifying question as needs_input', async () => {
    const r = rig();
    const run = r.store.addRun();
    await new AgentRunner(r.ports(new ScriptedLlm([() => [text('I found 3 deals. Which one do you mean?')]]))).run(
      run.id,
    );
    expect((await r.store.getRun(run.id)).stopReason).toBe('needs_input');
    expect(isQuestion('Done.')).toBe(false);
  });

  it('honours cancellation', async () => {
    const r = rig();
    const run = r.store.addRun();
    r.store.runs.get(run.id)!.cancel = true;
    await new AgentRunner(r.ports(new ScriptedLlm([() => [text('x')]]))).run(run.id);
    expect((await r.store.getRun(run.id)).status).toBe('cancelled');
  });

  it('fails the run with a clear error when the model provider fails', async () => {
    const r = rig();
    const run = r.store.addRun();
    const llm = { name: 'broken', create: async () => Promise.reject(new Error('Cassette miss for scenario x')) };
    await new AgentRunner(r.ports(llm)).run(run.id);
    const after = r.store.runs.get(run.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toContain('Cassette miss');
  });
});
