import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { liveRuns } from '../lib/live';
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatUsd,
  isActive,
  isStreaming,
  runDurationMs,
} from '../lib/format';
import { mergeTimelines, timelineFromDetail, totalStepCost } from '../lib/timeline';
import { useLiveRun } from '../app/hooks';
import { errorMessage, useToast } from '../app/toast';
import { Timeline } from '../components/Timeline';
import { ApprovalBatch } from '../components/ApprovalBatch';
import { ErrorBox, Spinner, StatusPill } from '../components/ui';

const REATTACH_COOLDOWN_MS = 4000;

export function RunPage({ id }: { id: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const live = useLiveRun(id);
  const liveActive = live?.active === true;

  const detail = useQuery({
    queryKey: ['run', id],
    queryFn: () => api.run(id),
    refetchInterval: (q) => (isActive(q.state.data?.status) ? 2000 : false),
    staleTime: 0,
  });
  const status = detail.data?.status;
  const proposals = useQuery({
    queryKey: ['proposals', 'pending'],
    queryFn: () => api.proposals('pending'),
    refetchInterval: status === 'awaiting_approval' ? 3000 : 10_000,
  });

  useEffect(() => {
    if (!isStreaming(status) || liveActive) return;
    if (Date.now() - liveRuns.lastAttempt(id) < REATTACH_COOLDOWN_MS) return;
    liveRuns.attach(id);
  }, [id, status, liveActive, detail.dataUpdatedAt]);

  const merged = useMemo(
    () => mergeTimelines(detail.data ? timelineFromDetail(detail.data) : null, live?.state ?? null, liveActive),
    [detail.data, live?.state, liveActive],
  );

  const cancel = useMutation({
    mutationFn: () => api.cancel(id),
    onSuccess: () => {
      toast.info('Stop requested — the run will halt after the current step.');
      void queryClient.invalidateQueries({ queryKey: ['run', id] });
      void queryClient.invalidateQueries({ queryKey: ['proposals'] });
    },
    onError: (e) => toast.error(`Could not stop the run: ${errorMessage(e)}`),
  });

  if (detail.isError && live === undefined) return <ErrorBox error={detail.error} title="Could not load the run" />;
  if (detail.data === undefined && live === undefined) return <Spinner label="Loading run…" />;

  const run = detail.data;
  const currentStatus = merged.status ?? run?.status ?? 'queued';
  const stopReason = merged.stopReason ?? run?.stopReason ?? null;
  const totalCost = Math.max(merged.usage?.costUsd ?? 0, totalStepCost(merged.steps));
  const batches = (proposals.data?.batches ?? []).filter((b) => b.runId === id && b.status === 'pending');
  const active = isActive(currentStatus);
  const needsInput = currentStatus === 'completed' && stopReason === 'needs_input';
  const summary = currentStatus === 'running' || currentStatus === 'queued' ? null : merged.summary;
  const usage = merged.usage ?? run?.usage ?? null;

  return (
    <div className="run-page" data-testid="run-view" data-run-id={id}>
      <section className="card run-header">
        <div className="run-header-main">
          <div className="run-goal-label muted small">Goal</div>
          <h1 className="run-goal" data-testid="run-goal">
            {run?.goal ?? '…'}
          </h1>
          <div className="run-meta muted small">
            {run ? (
              <>
                <span>{run.userName ?? 'unknown user'}</span>
                <span>{run.model}</span>
                <span>policy v{run.policyVersion}</span>
                <span>{formatDateTime(run.createdAt)}</span>
                {run.context?.record ? (
                  <span>
                    on {run.context.record.type} {run.context.record.label ?? run.context.record.id}
                  </span>
                ) : null}
                {run.context?.source ? <span>via {run.context.source}</span> : null}
                {run.playbookId ? <a href={`#/playbooks/${run.playbookId}`}>playbook</a> : null}
              </>
            ) : null}
          </div>
        </div>
        <div className="run-header-side">
          <StatusPill status={currentStatus} testId="run-status" raw />
          {stopReason !== null && stopReason !== 'end_turn' ? (
            <span className="tag tag-muted" data-testid="run-stop-reason">
              {stopReason.replace('_', ' ')}
            </span>
          ) : null}
          {active ? (
            <button
              type="button"
              className="btn btn-danger-ghost btn-sm"
              data-testid="stop-run"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              ■ Stop
            </button>
          ) : null}
        </div>
        <div className="run-stats">
          <div>
            <span className="muted small">Cost</span>
            <strong data-testid="run-cost">{formatUsd(totalCost)}</strong>
          </div>
          <div>
            <span className="muted small">Steps</span>
            <strong>{merged.steps.length}</strong>
          </div>
          <div>
            <span className="muted small">Tool calls</span>
            <strong>{usage?.toolCalls ?? merged.steps.filter((s) => s.kind === 'tool_call').length}</strong>
          </div>
          <div>
            <span className="muted small">Tokens</span>
            <strong>
              {formatNumber(usage?.inputTokens)} / {formatNumber(usage?.outputTokens)}
            </strong>
          </div>
          <div>
            <span className="muted small">Duration</span>
            <strong>{run ? formatDuration(runDurationMs(run) ?? usage?.wallClockMs ?? null) : '—'}</strong>
          </div>
        </div>
      </section>

      {live?.error ? <ErrorBox error={live.error} title="Stream interrupted" /> : null}

      <section className="card">
        <header className="card-head">
          <h2>Timeline</h2>
          {liveActive ? <Spinner label="live" /> : null}
        </header>
        <Timeline state={merged} live={liveActive} />
      </section>

      {batches.map((b) => (
        <ApprovalBatch key={b.id} batch={b} />
      ))}

      {summary !== null && summary !== '' ? (
        <section className={`card summary-card${needsInput ? ' summary-question' : ''}`}>
          <header className="card-head">
            <h2>
              {needsInput
                ? 'The operator needs your input'
                : currentStatus === 'awaiting_approval'
                  ? 'Progress so far'
                  : 'Result'}
            </h2>
          </header>
          <div className="run-summary" data-testid="run-summary">
            {summary}
          </div>
        </section>
      ) : null}

      {run?.error ? <ErrorBox error={run.error} title="Run failed" /> : null}

      {currentStatus !== 'failed' && currentStatus !== 'cancelled' ? (
        <InterveneBox runId={id} mode={needsInput ? 'reply' : active ? 'intervene' : 'followup'} />
      ) : null}
    </div>
  );
}

function InterveneBox({ runId, mode }: { runId: string; mode: 'reply' | 'intervene' | 'followup' }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: (message: string) => api.intervene(runId, message),
    onSuccess: (res) => {
      setText('');
      toast.success(
        res.mode === 'reply'
          ? 'Reply sent — the run continues.'
          : 'Message delivered — the operator reads it before its next step.',
      );
      void queryClient.invalidateQueries({ queryKey: ['run', runId] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: (e) => toast.error(`Could not send: ${errorMessage(e)}`),
  });
  const submit = () => {
    const t = text.trim();
    if (t !== '' && !send.isPending) send.mutate(t);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
  const label =
    mode === 'reply'
      ? 'Answer the question'
      : mode === 'intervene'
        ? 'Intervene — e.g. “skip Acme”'
        : 'Follow up on this run';
  return (
    <section className="card intervene">
      <label className="field">
        <span>{label}</span>
        <textarea
          data-testid="intervene-input"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={mode === 'reply' ? 'Type your answer…' : 'Type a message for the operator…'}
        />
      </label>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="intervene-send"
          disabled={send.isPending || text.trim() === ''}
          onClick={submit}
        >
          {mode === 'reply' ? 'Send answer' : 'Send'}
        </button>
      </div>
    </section>
  );
}
