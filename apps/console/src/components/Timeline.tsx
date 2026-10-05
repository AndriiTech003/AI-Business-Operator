import type { PolicyDecision, StepDto } from '@aio/contracts';
import { formatDuration, formatNumber, formatUsd, prettyJson } from '../lib/format';
import {
  compactArgs,
  llmStepText,
  stepDecision,
  toolStepResult,
  unwrapToolResult,
  type TimelineState,
} from '../lib/timeline';
import { JsonBlock, PolicyBadge, Spinner } from './ui';
import { TaintPanel } from './TaintPanel';

const KIND_ICON: Record<string, string> = {
  llm_call: '✦',
  tool_call: '⚒',
  proposal: '✉',
  approval: '✓',
  intervention: '✋',
  budget: '⏱',
  compaction: '⇲',
  visibility: '◐',
  error: '!',
};

export function Timeline({ state, live }: { state: TimelineState; live: boolean }) {
  const steps = state.steps;
  return (
    <ol className="timeline" data-testid="timeline">
      {steps.map((step) => (
        <StepItem key={step.id} step={step} decision={stepDecision(state, step)} />
      ))}
      {live && state.streamingText !== '' ? (
        <li className="step step-llm_call step-streaming" data-testid="streaming-text">
          <span className="step-marker" aria-hidden="true">
            {KIND_ICON['llm_call']}
          </span>
          <div className="step-body">
            <div className="step-head">
              <span className="step-title">Model</span>
              <Spinner label="streaming" />
            </div>
            <div className="assistant-text">{state.streamingText}</div>
          </div>
        </li>
      ) : null}
      {live && state.streamingText === '' && steps.length === 0 ? (
        <li className="step step-waiting">
          <span className="step-marker" aria-hidden="true">
            …
          </span>
          <div className="step-body">
            <Spinner label="Starting the run…" />
          </div>
        </li>
      ) : null}
    </ol>
  );
}

function StepItem({ step, decision }: { step: StepDto; decision: PolicyDecision | null }) {
  return (
    <li
      className={`step step-${step.kind}${decision ? ` step-decision-${decision.decision}` : ''}`}
      data-testid="step"
      data-kind={step.kind}
      data-tool={step.tool ?? ''}
      data-seq={step.seq}
    >
      <span className="step-marker" aria-hidden="true">
        {KIND_ICON[step.kind] ?? '•'}
      </span>
      <div className="step-body">
        <StepContent step={step} decision={decision} />
      </div>
    </li>
  );
}

function StepMeta({ step }: { step: StepDto }) {
  const parts: string[] = [];
  if (step.tokensIn > 0 || step.tokensOut > 0)
    parts.push(`${formatNumber(step.tokensIn)} in / ${formatNumber(step.tokensOut)} out`);
  if (step.latencyMs > 0) parts.push(formatDuration(step.latencyMs));
  return (
    <span className="step-meta">
      {parts.length > 0 ? <span>{parts.join(' · ')}</span> : null}
      <span className="step-cost" data-testid="step-cost">
        {formatUsd(step.costUsd)}
      </span>
      <span className="step-seq">#{step.seq}</span>
    </span>
  );
}

function StepContent({ step, decision }: { step: StepDto; decision: PolicyDecision | null }) {
  switch (step.kind) {
    case 'llm_call':
      return <LlmStep step={step} />;
    case 'tool_call':
      return <ToolStep step={step} decision={decision} />;
    case 'approval':
      return <ApprovalStep step={step} />;
    case 'visibility':
      return <VisibilityStep step={step} />;
    case 'budget': {
      const args = step.args as { limit?: string; detail?: string } | null;
      return (
        <>
          <div className="step-head">
            <span className="step-title">Budget limit reached</span>
            <StepMeta step={step} />
          </div>
          <p className="step-note">
            {args?.limit ?? 'budget'}
            {args?.detail ? ` — ${args.detail}` : ''}. The model was asked to wrap up.
          </p>
        </>
      );
    }
    case 'compaction': {
      const r = step.result as { compactedBlocks?: number; beforeTokens?: number; afterTokens?: number } | null;
      return (
        <>
          <div className="step-head">
            <span className="step-title">Context compacted</span>
            <StepMeta step={step} />
          </div>
          <p className="step-note">
            {r?.compactedBlocks ?? 0} old tool results summarised ({formatNumber(r?.beforeTokens)} →{' '}
            {formatNumber(r?.afterTokens)} tokens).
          </p>
        </>
      );
    }
    case 'error': {
      const r = step.result as { message?: string } | null;
      return (
        <>
          <div className="step-head">
            <span className="step-title text-danger">Error</span>
            <StepMeta step={step} />
          </div>
          <p className="step-note text-danger">{r?.message ?? 'Unknown error'}</p>
        </>
      );
    }
    default:
      return (
        <details className="step-details">
          <summary className="step-head">
            <span className="step-title">{step.kind}</span>
            {step.tool ? <code className="tool-name">{step.tool}</code> : null}
            <StepMeta step={step} />
          </summary>
          <JsonBlock value={step.args} label="Args" />
          <JsonBlock value={step.result} label="Result" />
        </details>
      );
  }
}

function LlmStep({ step }: { step: StepDto }) {
  const { text, toolUses } = llmStepText(step);
  return (
    <>
      <div className="step-head">
        <span className="step-title">Model</span>
        <StepMeta step={step} />
      </div>
      {text !== '' ? <div className="assistant-text">{text}</div> : null}
      {toolUses.length > 0 ? (
        <div className="chips">
          {toolUses.map((t, i) => (
            <span key={`${t}-${i}`} className="chip">
              → {t}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

function ToolStep({ step, decision }: { step: StepDto; decision: PolicyDecision | null }) {
  const result = toolStepResult(step);
  const unwrapped = unwrapToolResult(result.content);
  const taint = step.taint ?? decision?.taint ?? [];
  return (
    <details className="step-details" open={decision?.decision === 'deny' ? true : undefined}>
      <summary className="step-head">
        <code className="tool-name">{step.tool}</code>
        <span className="step-args muted">{compactArgs(step.args)}</span>
        {decision !== null ? (
          <PolicyBadge decision={decision.decision} ruleId={decision.ruleId} title={decision.reasons.join('; ')} />
        ) : null}
        {result.pending ? <Spinner /> : null}
        {result.proposalId !== null ? <span className="tag tag-warn">queued for approval</span> : null}
        {!result.pending && result.isError && decision?.decision !== 'deny' ? (
          <span className="tag tag-danger">error</span>
        ) : null}
        <StepMeta step={step} />
      </summary>
      <div className="step-expanded">
        {decision !== null && (decision.reasons.length > 0 || decision.warnings.length > 0) ? (
          <div className="decision-box">
            {decision.reasons.length > 0 ? (
              <div>
                <span className="muted">Policy: </span>
                {decision.reasons.join('; ')}
                {decision.policyVersion ? <span className="muted"> (policy v{decision.policyVersion})</span> : null}
              </div>
            ) : null}
            {decision.warnings.map((w) => (
              <div key={w} className="text-warn">
                ⚠ {w}
              </div>
            ))}
          </div>
        ) : null}
        {taint.length > 0 ? <TaintPanel findings={taint} /> : null}
        <JsonBlock value={step.args} label="Arguments" />
        {!result.pending ? (
          <div className="json-block">
            <div className="json-label">
              Result{unwrapped.untrusted === true ? <span className="tag tag-muted">untrusted data</span> : null}
              {result.isError ? <span className="tag tag-danger">isError</span> : null}
            </div>
            <pre className={result.isError ? 'text-danger' : undefined}>{prettyJson(unwrapped.body)}</pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function ApprovalStep({ step }: { step: StepDto }) {
  const r = step.result as { status?: string; edited?: boolean; error?: string; payload?: unknown } | null;
  const status = r?.status ?? 'pending';
  return (
    <details className="step-details">
      <summary className="step-head">
        <span className="step-title">Approved action</span>
        <code className="tool-name">{step.tool}</code>
        <span className={`tag ${status === 'executed' ? 'tag-ok' : status === 'failed' ? 'tag-danger' : 'tag-muted'}`}>
          {status}
        </span>
        {r?.edited === true ? (
          <span className="tag tag-info" data-testid="edited-marker">
            edited by human
          </span>
        ) : null}
        <StepMeta step={step} />
      </summary>
      <div className="step-expanded">
        {r?.error ? <p className="text-danger">{r.error}</p> : null}
        <JsonBlock value={step.args} label="Approved payload" />
        <JsonBlock value={r?.payload} label="Result" />
      </div>
    </details>
  );
}

function VisibilityStep({ step }: { step: StepDto }) {
  const r = step.result as { hidden?: Array<{ tool: string; ruleId: string; reason: string }> } | null;
  const hidden = r?.hidden ?? [];
  return (
    <details className="step-details">
      <summary className="step-head">
        <span className="step-title">Tool visibility</span>
        <span className="muted">
          {hidden.length === 0
            ? 'all tools visible'
            : `${hidden.length} tool${hidden.length === 1 ? '' : 's'} hidden from the model`}
        </span>
        <StepMeta step={step} />
      </summary>
      {hidden.length > 0 ? (
        <ul className="plain-list">
          {hidden.map((h) => (
            <li key={h.tool}>
              <code>{h.tool}</code> <span className="badge badge-deny">hidden · {h.ruleId}</span>{' '}
              <span className="muted">{h.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
