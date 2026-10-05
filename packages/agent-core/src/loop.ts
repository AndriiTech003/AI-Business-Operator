import {
  emptyUsage,
  textOf,
  toolUsesOf,
  type ChatMessage,
  type PolicyDecision,
  type StepDto,
  type StopReason,
  type TaintFinding,
  type ToolDescriptor,
  type ToolResultBlock,
  type ToolUseBlock,
  type Usage,
} from '@aio/contracts';
import { LlmError, type LlmResponse, type LlmTool } from '@aio/llm';
import { TaintIndex } from '@aio/taint';
import { checkBudget, canCallTool, canTakeExternalAction } from './budget';
import { compactMessages, truncatePayload } from './context';
import { argsHash, assertApprovedPayload } from './hash';
import {
  approvalResultsMessage,
  budgetNotice,
  deniedResult,
  interventionMessage,
  queuedResult,
  wrapToolResult,
  type ApprovalOutcome,
} from './prompt';
import { DEFAULT_AGENT_OPTIONS, type AgentOptions, type AgentPorts, type RunState, type StepRecord } from './ports';

const CONTROL_ARGS = ['idempotencyKey', 'dryRun'];
const READ_RISK = 'read';

export function stripControlArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) if (!CONTROL_ARGS.includes(k)) out[k] = v;
  return out;
}

export function toLlmTool(tool: ToolDescriptor): LlmTool {
  const schema = { ...(tool.inputSchema as Record<string, unknown>) };
  const props = { ...((schema['properties'] as Record<string, unknown> | undefined) ?? {}) };
  for (const k of CONTROL_ARGS) delete props[k];
  schema['properties'] = props;
  if (Array.isArray(schema['required']))
    schema['required'] = (schema['required'] as string[]).filter((r) => !CONTROL_ARGS.includes(r));
  delete schema['$schema'];
  return { name: tool.name, description: tool.description, inputSchema: schema };
}

function supportsControl(tool: ToolDescriptor, name: string): boolean {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  return name in props;
}

export function stepToDto(step: StepRecord): StepDto {
  return {
    id: step.id,
    runId: step.runId,
    seq: step.seq,
    kind: step.kind,
    tool: step.tool,
    args: step.args,
    result: step.result,
    policyDecision: step.policyDecision,
    taint: step.taint,
    tokensIn: step.tokensIn,
    tokensOut: step.tokensOut,
    costUsd: step.costUsd,
    latencyMs: step.latencyMs,
    idempotencyKey: step.idempotencyKey,
    createdAt: step.createdAt.toISOString(),
  };
}

interface StoredToolResult {
  toolResult: { content: string; isError: boolean };
  payload?: unknown;
  untrusted?: string[];
  proposalId?: string;
}

export function isQuestion(text: string): boolean {
  const t = text.trim();
  return t.endsWith('?');
}

export class AgentRunner {
  private readonly options: AgentOptions;

  constructor(
    private readonly ports: AgentPorts,
    options: Partial<AgentOptions> = {},
  ) {
    this.options = { ...DEFAULT_AGENT_OPTIONS, ...options };
  }

  private emitStep(type: 'tool_call' | 'tool_result' | 'step', step: StepRecord): void {
    this.ports.events.emit({ type, runId: step.runId, step: stepToDto(step) });
  }

  private async finish(
    run: RunState,
    usage: Usage,
    stopReason: StopReason,
    summary: string | null,
    error: string | null = null,
  ): Promise<void> {
    const status = stopReason === 'cancelled' ? 'cancelled' : stopReason === 'error' ? 'failed' : 'completed';
    await this.ports.store.updateRun(run.id, {
      status,
      stopReason,
      usage,
      summary,
      error,
      finishedAt: this.ports.clock.now(),
    });
    this.ports.events.emit({ type: 'usage', runId: run.id, usage });
    this.ports.events.emit({ type: 'status', runId: run.id, status, stopReason });
    this.ports.events.emit({ type: 'done', runId: run.id, status, stopReason, summary });
  }

  private async rebuildTaint(run: RunState, steps: StepRecord[], messages: ChatMessage[]): Promise<TaintIndex> {
    const index = new TaintIndex();
    index.addTrusted(run.goal);
    for (const m of messages)
      if (m.role === 'user') for (const b of m.content) if (b.type === 'text') index.addTrusted(b.text);
    const tools = new Map((run.tools ?? []).map((t) => [t.name, t]));
    for (const s of steps) {
      if (s.kind !== 'tool_call' || s.status !== 'done' || s.tool === null) continue;
      const t = tools.get(s.tool);
      if (t === undefined || t.risk !== READ_RISK) continue;
      const stored = s.result as StoredToolResult | null;
      if (stored?.payload === undefined) continue;
      index.addToolResult(
        (stored.payload as { result?: unknown }).result ?? stored.payload,
        (stored.untrusted ?? []).map((p) => p),
        s.tool,
        s.seq,
      );
    }
    return index;
  }

  async run(runId: string): Promise<void> {
    const { store, clock, events } = this.ports;
    const run = await store.getRun(runId);
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return;
    if (run.status === 'awaiting_approval') return;
    const segmentStart = clock.now().getTime();
    const baseWall = run.usage.wallClockMs;
    const usage: Usage = { ...emptyUsage(), ...run.usage };
    const tick = () => {
      usage.wallClockMs = baseWall + (clock.now().getTime() - segmentStart);
    };
    if (run.status !== 'running') {
      await store.updateRun(runId, { status: 'running', startedAt: run.startedAt ?? clock.now() });
      events.emit({ type: 'status', runId, status: 'running', stopReason: null });
    }
    if (run.tools === null || run.systemPrompt === null) {
      const all = await this.ports.tools.listTools();
      const { visible, hidden } = this.ports.policy.visibility(all);
      run.tools = all;
      run.hiddenTools = hidden;
      run.promptNow = clock.now().toISOString();
      run.systemPrompt = await this.ports.prompt.build(run, visible, hidden, this.ports.policy.approvalSummary());
      await store.updateRun(runId, {
        tools: all,
        hiddenTools: hidden,
        systemPrompt: run.systemPrompt,
        promptNow: run.promptNow,
      });
      const step = await store.createStep(runId, {
        kind: 'visibility',
        status: 'done',
        args: { visible: visible.map((t) => t.name) },
        result: { hidden },
      });
      this.emitStep('step', step);
    }
    const hiddenNames = new Set((run.hiddenTools ?? []).map((h) => h.tool));
    const allTools = run.tools ?? [];
    const visibleTools = allTools.filter((t) => !hiddenNames.has(t.name));
    const messages = await store.loadMessages(runId);
    if (messages.length === 0) {
      const ctx = run.context?.record;
      const text = ctx
        ? `${run.goal}\n\n(Context: the user started this from the ${ctx.type} ${ctx.label ? `"${ctx.label}" ` : ''}with id ${ctx.id}.)`
        : run.goal;
      const first: ChatMessage = { role: 'user', content: [{ type: 'text', text }] };
      await store.appendMessage(runId, first);
      messages.push(first);
    }
    const steps = await store.listSteps(runId);
    const taint = await this.rebuildTaint(run, steps, messages);
    let budgetHit: string | null = null;
    let finalCallDone = false;

    while (true) {
      if (await store.isCancelRequested(runId)) {
        tick();
        await this.finish(run, usage, 'cancelled', 'Run cancelled by the user.');
        return;
      }
      const last = messages.at(-1) as ChatMessage;
      if (last.role === 'assistant') {
        const uses = toolUsesOf(last);
        if (uses.length > 0 && !finalCallDone) {
          const results: ToolResultBlock[] = [];
          for (const tu of uses) {
            const r = await this.handleToolUse(run, usage, tu, allTools, hiddenNames, taint);
            results.push(r.block);
            if (r.budgetExhausted) budgetHit = budgetHit ?? 'maxToolCalls';
            tick();
          }
          const msg: ChatMessage = { role: 'user', content: results };
          await store.appendMessage(runId, msg);
          messages.push(msg);
          await store.updateRun(runId, { usage });
          events.emit({ type: 'usage', runId, usage });
          continue;
        }
        tick();
        const text = textOf(last);
        const batch = await store.sealBatch(runId);
        if (batch !== null) {
          await store.updateRun(runId, { status: 'awaiting_approval', usage, summary: text });
          events.emit({ type: 'status', runId, status: 'awaiting_approval', stopReason: null });
          events.emit({ type: 'usage', runId, usage });
          await this.ports.approvals.publish(runId, batch);
          return;
        }
        const stop: StopReason = budgetHit !== null ? 'budget' : isQuestion(text) ? 'needs_input' : 'end_turn';
        await this.finish(run, usage, stop, text);
        return;
      }
      const interventions = await store.takeInterventions(runId);
      for (const text of interventions) {
        const msg: ChatMessage = { role: 'user', content: [{ type: 'text', text: interventionMessage(text) }] };
        await store.appendMessage(runId, msg);
        messages.push(msg);
        taint.addTrusted(text);
      }
      tick();
      const status = checkBudget(run.budget, usage);
      let toolsForCall = visibleTools;
      if (!status.ok || budgetHit !== null) {
        const limit = status.limit ?? budgetHit ?? 'maxToolCalls';
        budgetHit = limit;
        const notice: ChatMessage = {
          role: 'user',
          content: [{ type: 'text', text: budgetNotice(limit, status.ok ? 'tool call limit reached' : status.detail) }],
        };
        await store.appendMessage(runId, notice);
        messages.push(notice);
        const bstep = await store.createStep(runId, {
          kind: 'budget',
          status: 'done',
          args: { limit, detail: status.detail },
          result: { usage: { ...usage } },
        });
        this.emitStep('step', bstep);
        toolsForCall = [];
        finalCallDone = true;
      }
      let response: LlmResponse;
      try {
        response = await this.callModel(run, usage, messages, toolsForCall);
      } catch (error) {
        tick();
        const message = (error as Error).message;
        const estep = await store.createStep(runId, { kind: 'error', status: 'done', result: { message } });
        this.emitStep('step', estep);
        await this.finish(run, usage, 'error', null, message);
        return;
      }
      const assistant: ChatMessage = {
        role: 'assistant',
        content: finalCallDone ? response.content.filter((b) => b.type !== 'tool_use') : response.content,
      };
      if (assistant.content.length === 0) assistant.content.push({ type: 'text', text: '' });
      await store.appendMessage(runId, assistant);
      messages.push(assistant);
      tick();
      await store.updateRun(runId, { usage });
    }
  }

  private async callModel(
    run: RunState,
    usage: Usage,
    messages: ChatMessage[],
    tools: ToolDescriptor[],
  ): Promise<LlmResponse> {
    const { store, events, llm, prices } = this.ports;
    const system = run.systemPrompt ?? '';
    const compacted = compactMessages(system, messages, this.options.compaction);
    if (compacted.compactedBlocks > 0) {
      const cstep = await store.createStep(run.id, {
        kind: 'compaction',
        status: 'done',
        result: {
          compactedBlocks: compacted.compactedBlocks,
          beforeTokens: compacted.beforeTokens,
          afterTokens: compacted.afterTokens,
        },
      });
      this.emitStep('step', cstep);
    }
    const request = {
      model: run.model,
      system,
      messages: compacted.messages,
      tools: tools.map(toLlmTool),
      maxTokens: this.options.maxOutputTokens,
      metadata: { now: run.promptNow ?? undefined, runId: run.id, scenarioId: this.ports.scenarioId },
    };
    let attempt = 0;
    while (true) {
      const started = Date.now();
      try {
        const call = () =>
          llm.create(request, {
            onText: (delta) => events.emit({ type: 'text', runId: run.id, delta, seq: null }),
          });
        const response = this.ports.telemetry?.span
          ? await this.ports.telemetry.span(
              `chat ${run.model}`,
              {
                'gen_ai.operation.name': 'chat',
                'gen_ai.request.model': run.model,
                'gen_ai.provider.name': llm.name,
                'aio.run_id': run.id,
              },
              call,
            )
          : await call();
        const cost = prices.cost(run.model, response.usage);
        usage.steps += 1;
        usage.llmCalls += 1;
        usage.inputTokens +=
          response.usage.inputTokens + response.usage.cacheReadTokens + response.usage.cacheWriteTokens;
        usage.outputTokens += response.usage.outputTokens;
        usage.costUsd = Math.round((usage.costUsd + cost) * 1e8) / 1e8;
        if (usage.firstTokenMs === null && response.firstTokenMs !== null) usage.firstTokenMs = response.firstTokenMs;
        const step = await store.createStep(run.id, {
          kind: 'llm_call',
          status: 'done',
          args: { model: run.model, messages: compacted.messages.length, tools: tools.length },
          result: {
            content: response.content,
            stopReason: response.stopReason,
            provider: response.provider,
            model: response.model,
            firstTokenMs: response.firstTokenMs,
          },
          tokensIn: response.usage.inputTokens + response.usage.cacheReadTokens + response.usage.cacheWriteTokens,
          tokensOut: response.usage.outputTokens,
          costUsd: cost,
          latencyMs: response.latencyMs,
        });
        this.emitStep('step', step);
        events.emit({ type: 'usage', runId: run.id, usage: { ...usage } });
        this.ports.telemetry?.llmCall?.({
          runId: run.id,
          model: run.model,
          provider: response.provider,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          costUsd: cost,
          latencyMs: response.latencyMs,
          stopReason: response.stopReason,
        });
        return response;
      } catch (error) {
        const retryable = error instanceof LlmError && error.retryable && attempt < this.options.llmRetries;
        this.ports.telemetry?.llmCall?.({
          runId: run.id,
          model: run.model,
          provider: llm.name,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          latencyMs: Date.now() - started,
          stopReason: 'error',
          error: (error as Error).message,
        });
        if (!retryable) throw error;
        attempt += 1;
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      }
    }
  }

  private async handleToolUse(
    run: RunState,
    usage: Usage,
    tu: ToolUseBlock,
    allTools: ToolDescriptor[],
    hiddenNames: Set<string>,
    taint: TaintIndex,
  ): Promise<{ block: ToolResultBlock; budgetExhausted: boolean }> {
    const { store, events, policy, resolver, tools: gateway, clock } = this.ports;
    const existing = await store.findStepByToolUse(run.id, tu.id);
    if (existing !== null && existing.status === 'done') {
      const stored = existing.result as StoredToolResult;
      return {
        block: {
          type: 'tool_result',
          toolUseId: tu.id,
          content: stored.toolResult.content,
          isError: stored.toolResult.isError,
        },
        budgetExhausted: false,
      };
    }
    const started = Date.now();
    const step =
      existing ??
      (await store.createStep(run.id, {
        kind: 'tool_call',
        status: 'pending',
        tool: tu.name,
        toolUseId: tu.id,
        args: tu.input,
      }));
    if (existing === null) this.emitStep('tool_call', step);
    const finishStep = async (
      content: string,
      isError: boolean,
      extra: {
        payload?: unknown;
        untrusted?: string[];
        proposalId?: string;
        decision?: PolicyDecision | null;
        taint?: TaintFinding[] | null;
        idempotencyKey?: string | null;
      } = {},
    ): Promise<{ block: ToolResultBlock; budgetExhausted: boolean }> => {
      const stored: StoredToolResult = { toolResult: { content, isError } };
      if (extra.payload !== undefined) stored.payload = extra.payload;
      if (extra.untrusted !== undefined) stored.untrusted = extra.untrusted;
      if (extra.proposalId !== undefined) stored.proposalId = extra.proposalId;
      const done = await store.updateStep(step.id, {
        kind: 'tool_call',
        status: 'done',
        result: stored,
        policyDecision: extra.decision ?? null,
        taint: extra.taint ?? null,
        latencyMs: Date.now() - started,
        idempotencyKey: extra.idempotencyKey ?? null,
      });
      this.emitStep('tool_result', done);
      return { block: { type: 'tool_result', toolUseId: tu.id, content, isError }, budgetExhausted: false };
    };
    if (!canCallTool(run.budget, usage)) {
      const r = await finishStep(`budget exhausted: at most ${run.budget.maxToolCalls} tool calls per run`, true);
      return { ...r, budgetExhausted: true };
    }
    usage.toolCalls += 1;
    const tool = allTools.find((t) => t.name === tu.name);
    if (tool === undefined) return finishStep(`unknown tool '${tu.name}'`, true);
    const args = stripControlArgs(tu.input);
    let resolved;
    try {
      resolved = await resolver.resolve(tool.name, args);
    } catch (error) {
      return finishStep(wrapToolResult(tool.name, { error: (error as Error).message }, true), true);
    }
    let decision = await policy.evaluate({ tool, args: resolved.view, usage });
    let findings: TaintFinding[] = [];
    if (tool.risk !== READ_RISK && this.options.taintCheck) {
      findings = taint.check(resolved.view);
      if (findings.length > 0) {
        const warning = `argument originates from untrusted content: ${findings
          .slice(0, 3)
          .map((f) => `"${f.fragment}" (from ${f.source.tool} ${f.source.path})`)
          .join(', ')}`;
        decision =
          decision.decision === 'allow'
            ? {
                ...decision,
                decision: 'require_approval',
                ruleId: 'taint:untrusted-argument',
                reasons: ['An argument originates from untrusted content'],
                matchedRules: [
                  ...decision.matchedRules,
                  { id: 'taint:untrusted-argument', then: 'require_approval', reason: warning },
                ],
                warnings: [...decision.warnings, warning],
                taint: findings,
              }
            : { ...decision, warnings: [...decision.warnings, warning], taint: findings };
      }
    }
    if (hiddenNames.has(tool.name) && decision.decision !== 'deny') {
      const hidden = (run.hiddenTools ?? []).find((h) => h.tool === tool.name);
      decision = {
        ...decision,
        decision: 'deny',
        ruleId: hidden?.ruleId ?? 'hidden-tool',
        reasons: [hidden?.reason ?? 'Tool is not available to this user'],
      };
    }
    events.emit({ type: 'policy', runId: run.id, seq: step.seq, tool: tool.name, decision });
    const record = (ok: boolean) =>
      this.ports.telemetry?.toolCall?.({
        runId: run.id,
        tool: tool.name,
        decision: decision.decision,
        ruleId: decision.ruleId,
        latencyMs: Date.now() - started,
        ok,
        toolUseId: tu.id,
      });
    if (decision.decision === 'deny') {
      record(false);
      return finishStep(deniedResult(decision.ruleId, decision.reasons), true, { decision, taint: findings });
    }
    if (decision.decision === 'require_approval') {
      const batch = await store.openBatch(run.id, new Date(clock.now().getTime() + policy.approvalTtlMs()));
      let dry = null;
      if (supportsControl(tool, 'dryRun')) dry = await gateway.call(tool.name, args, { dryRun: true });
      const preview = await resolver.preview(tool.name, resolved.payload, dry);
      const proposal = await store.createProposal({
        runId: run.id,
        batchId: batch.id,
        tool: tool.name,
        args: resolved.payload,
        argsHash: argsHash(tool.name, resolved.payload),
        preview,
        risk: tool.risk,
        ruleId: decision.ruleId,
        reasons: decision.reasons,
        warnings: decision.warnings,
        taint: findings,
        toolUseId: tu.id,
        stepSeq: step.seq,
        expiresAt: batch.expiresAt,
      });
      events.emit({
        type: 'proposal',
        runId: run.id,
        proposal: {
          id: proposal.id,
          runId: run.id,
          batchId: batch.id,
          tool: tool.name,
          args: resolved.payload,
          argsHash: proposal.argsHash,
          originalArgs: null,
          preview,
          risk: tool.risk,
          ruleId: decision.ruleId,
          reasons: decision.reasons,
          warnings: decision.warnings,
          taint: findings,
          status: 'pending',
          decidedBy: null,
          decidedAt: null,
          edited: false,
          executedAt: null,
          executionResult: null,
          externalApprovalId: null,
          expiresAt: batch.expiresAt.toISOString(),
          createdAt: clock.now().toISOString(),
        },
      });
      record(true);
      return finishStep(
        queuedResult({
          proposalId: proposal.id,
          ruleId: decision.ruleId,
          reasons: decision.reasons,
          warnings: decision.warnings,
          preview,
        }),
        false,
        { decision, taint: findings, proposalId: proposal.id },
      );
    }
    if ((tool.risk === 'external' || tool.risk === 'irreversible') && !canTakeExternalAction(run.budget, usage)) {
      record(false);
      return finishStep(`budget exhausted: at most ${run.budget.maxExternalActions} external actions per run`, true, {
        decision,
      });
    }
    const idempotencyKey =
      tool.risk !== READ_RISK && supportsControl(tool, 'idempotencyKey') ? `${run.id}:${step.seq}` : undefined;
    const call = () => gateway.call(tool.name, args, idempotencyKey === undefined ? {} : { idempotencyKey });
    const outcome = this.ports.telemetry?.span
      ? await this.ports.telemetry.span(
          `execute_tool ${tool.name}`,
          {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': tool.name,
            'gen_ai.tool.call.id': tu.id,
            'aio.policy.decision': decision.decision,
            'aio.policy.rule_id': decision.ruleId,
          },
          call,
        )
      : await call();
    record(outcome.ok);
    if (tool.risk !== READ_RISK && this.options.delayAfterEffectMs > 0)
      await new Promise((r) => setTimeout(r, this.options.delayAfterEffectMs));
    if (!outcome.ok || outcome.payload === null) {
      return finishStep(
        wrapToolResult(tool.name, { error: outcome.errorMessage, status: outcome.status }, true),
        true,
        {
          decision,
          taint: findings,
          idempotencyKey: idempotencyKey ?? null,
        },
      );
    }
    if (tool.risk === READ_RISK) {
      const spans = taint.addToolResult(
        (outcome.payload as { result?: unknown }).result ?? outcome.payload,
        outcome.untrusted,
        tool.name,
        step.seq,
      );
      if (spans.length > 0) await store.saveSpans(run.id, step.id, spans);
    } else {
      usage.writeCount += tool.risk === 'write_reversible' ? 1 : 0;
      usage.externalActions += tool.risk === 'external' || tool.risk === 'irreversible' ? 1 : 0;
      usage.emailsSent += tool.name === 'send_email' ? 1 : 0;
    }
    const { payload } = truncatePayload(outcome.payload, { maxTokens: this.options.maxToolResultTokens });
    return finishStep(wrapToolResult(tool.name, payload, true), false, {
      decision,
      taint: findings,
      payload: outcome.payload,
      untrusted: outcome.untrusted,
      idempotencyKey: idempotencyKey ?? null,
    });
  }

  async applyApprovals(runId: string, batchId: string): Promise<void> {
    const { store, events, resolver, clock } = this.ports;
    const batch = await store.getBatch(batchId);
    if (batch.status === 'applied') return this.run(runId);
    if (batch.status !== 'decided' && batch.status !== 'expired' && batch.status !== 'cancelled') return;
    const run = await store.getRun(runId);
    const usage: Usage = { ...emptyUsage(), ...run.usage };
    const proposals = await store.listBatchProposals(batchId);
    const outcomes: ApprovalOutcome[] = [];
    for (const p of proposals) {
      if (p.status === 'executed' || p.status === 'failed') {
        outcomes.push({
          proposalId: p.id,
          tool: p.tool,
          status: p.status,
          edited: p.edited,
          args: p.args,
          result: p.executionResult,
        });
        continue;
      }
      if (p.status === 'rejected' || p.status === 'expired' || p.status === 'cancelled' || p.status === 'pending') {
        const status = p.status === 'rejected' ? 'rejected' : 'expired';
        if (p.status === 'pending') await store.markProposal(p.id, { status: 'expired' });
        outcomes.push({ proposalId: p.id, tool: p.tool, status, edited: p.edited, args: p.args, comment: p.comment });
        continue;
      }
      const started = Date.now();
      const step = await store.createStep(runId, {
        kind: 'approval',
        status: 'pending',
        tool: p.tool,
        args: p.args,
        idempotencyKey: p.id,
      });
      try {
        if (p.approvedHash === null) throw new Error(`proposal ${p.id} has no approved hash`);
        assertApprovedPayload(p.id, p.tool, p.args, p.approvedHash);
        const outcome = await resolver.executeApproved(p);
        if (!outcome.ok) throw new Error(outcome.errorMessage ?? 'execution failed');
        await store.markProposal(p.id, {
          status: 'executed',
          executionResult: outcome.payload,
          executedAt: clock.now(),
        });
        usage.externalActions += p.risk === 'external' || p.risk === 'irreversible' ? 1 : 0;
        usage.writeCount += p.risk === 'write_reversible' ? 1 : 0;
        usage.emailsSent += p.tool === 'send_email' ? 1 : 0;
        const done = await store.updateStep(step.id, {
          kind: 'approval',
          status: 'done',
          result: { status: 'executed', edited: p.edited, payload: outcome.payload },
          latencyMs: Date.now() - started,
          idempotencyKey: p.id,
        });
        this.emitStep('step', done);
        outcomes.push({
          proposalId: p.id,
          tool: p.tool,
          status: 'executed',
          edited: p.edited,
          args: p.args,
          result: outcome.payload,
        });
      } catch (error) {
        const message = (error as Error).message;
        await store.markProposal(p.id, { status: 'failed', executionResult: { error: message } });
        const done = await store.updateStep(step.id, {
          kind: 'approval',
          status: 'done',
          result: { status: 'failed', error: message },
          latencyMs: Date.now() - started,
          idempotencyKey: p.id,
        });
        this.emitStep('step', done);
        outcomes.push({
          proposalId: p.id,
          tool: p.tool,
          status: 'failed',
          edited: p.edited,
          args: p.args,
          error: message,
        });
      }
    }
    const message: ChatMessage = {
      role: 'user',
      content: [{ type: 'text', text: approvalResultsMessage(batchId, outcomes, clock.now().toISOString()) }],
    };
    const applied = await store.applyBatch(batchId, message);
    if (applied) {
      await store.updateRun(runId, { usage, status: 'running' });
      events.emit({ type: 'status', runId, status: 'running', stopReason: null });
    }
    await this.run(runId);
  }
}
