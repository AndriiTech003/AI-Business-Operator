import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EvalResultDto } from '@aio/contracts';
import { api } from '../lib/api';
import { formatDateTime, formatDuration, formatNumber, formatUsd, prettyJson } from '../lib/format';
import { highlightFragments, parseTrajectory, successRate, summarizeCategories } from '../lib/eval';
import { Card, ErrorBox, PolicyBadge, Spinner, Stat } from '../components/ui';

export function EvalRunPage({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['eval-run', id], queryFn: () => api.evalRun(id) });
  const [selected, setSelected] = useState<string | null>(null);
  const results = useMemo(() => q.data?.results ?? [], [q.data]);
  const models = useMemo(() => [...new Set(results.map((r) => r.model))].sort(), [results]);
  const scenarios = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of results) map.set(r.scenarioId, r.category);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  }, [results]);
  const categories = useMemo(() => summarizeCategories(results), [results]);
  const cell = useMemo(() => new Map(results.map((r) => [`${r.scenarioId}\u0000${r.model}`, r])), [results]);

  if (q.isLoading) return <Spinner label="Loading eval run…" />;
  if (q.isError || q.data === undefined) return <ErrorBox error={q.error} title="Could not load the eval run" />;
  const run = q.data;
  const failures = results.filter((r) => !r.passed);
  const current = results.find((r) => r.id === selected) ?? null;
  const categoryNames = [...new Set(categories.map((c) => c.category))];

  return (
    <div className="stack">
      <p>
        <a href="#/eval">← All eval runs</a>
      </p>
      <Card title={`Eval run · ${formatDateTime(run.createdAt)}`}>
        <div className="stats">
          <Stat
            label="Success rate"
            value={`${(successRate(run.passed, run.passed + run.failed) * 100).toFixed(0)}%`}
            hint={`${run.passed} passed / ${run.failed} failed`}
          />
          <Stat
            label="Policy violations"
            value={<span className={run.violations > 0 ? 'text-danger' : 'text-ok'}>{run.violations}</span>}
            hint="gate: must be 0"
          />
          <Stat
            label="Injection success"
            value={<span className={run.injectionSuccess > 0 ? 'text-danger' : 'text-ok'}>{run.injectionSuccess}</span>}
            hint="gate: must be 0"
          />
          <Stat
            label="Gates"
            value={
              run.gatesPassed ? <span className="text-ok">passed</span> : <span className="text-danger">failed</span>
            }
            hint={`${run.mode} mode`}
          />
          <Stat label="Avg steps" value={run.avgSteps.toFixed(1)} hint={`avg cost ${formatUsd(run.avgCostUsd)}`} />
        </div>
      </Card>

      <Card title="Scenario × model">
        <div className="table-wrap">
          <table className="matrix" data-testid="eval-matrix">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Category</th>
                {models.map((m) => (
                  <th key={m}>{m}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scenarios.map(([scenarioId, category]) => (
                <tr key={scenarioId}>
                  <td>
                    <code>{scenarioId}</code>
                  </td>
                  <td className="muted small">{category}</td>
                  {models.map((m) => {
                    const r = cell.get(`${scenarioId}\u0000${m}`);
                    if (r === undefined)
                      return (
                        <td key={m} className="cell cell-none">
                          —
                        </td>
                      );
                    return (
                      <td
                        key={m}
                        className={`cell ${r.passed ? 'cell-pass' : 'cell-fail'}${selected === r.id ? ' cell-selected' : ''}`}
                      >
                        <button
                          type="button"
                          data-testid="eval-cell"
                          data-passed={r.passed ? 'true' : 'false'}
                          onClick={() => setSelected(r.id)}
                        >
                          <strong>{r.passed ? '✓ pass' : '✗ fail'}</strong>
                          <span>
                            {r.steps} steps · {formatUsd(r.costUsd)}
                          </span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {current !== null ? <TrajectoryView result={current} onClose={() => setSelected(null)} /> : null}

      <div className="grid-2">
        <Card title="By category">
          <table className="table table-compact" data-testid="eval-categories">
            <thead>
              <tr>
                <th>Category</th>
                {models.map((m) => (
                  <th key={m} className="num">
                    {m}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categoryNames.map((c) => (
                <tr key={c}>
                  <td>{c}</td>
                  {models.map((m) => {
                    const s = categories.find((x) => x.category === c && x.model === m);
                    return (
                      <td key={m} className="num">
                        {s ? (
                          <span className={s.passed === s.total ? 'text-ok' : 'text-danger'}>
                            {s.passed}/{s.total}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title={`Failures (${failures.length})`}>
          {failures.length === 0 ? (
            <p className="text-ok">Every scenario passed.</p>
          ) : (
            <ul className="failures" data-testid="eval-failures">
              {failures.map((r) => (
                <li key={r.id}>
                  <button type="button" className="btn btn-link" onClick={() => setSelected(r.id)}>
                    {r.scenarioId} · {r.model}
                  </button>
                  <ul>
                    {r.failures.map((f, i) => (
                      <li key={i} className="small">
                        {f}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {run.report !== null && run.report !== '' ? (
        <Card title="Report">
          <details>
            <summary>Markdown report</summary>
            <pre className="report">{run.report}</pre>
          </details>
        </Card>
      ) : null}
    </div>
  );
}

function TrajectoryView({ result, onClose }: { result: EvalResultDto; onClose: () => void }) {
  const t = parseTrajectory(result.trajectory);
  const anchor = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    anchor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [result.id]);
  return (
    <div ref={anchor}>
      <Card
        title={
          <>
            Trajectory · <code>{result.scenarioId}</code> · {result.model}{' '}
            {result.passed ? <span className="tag tag-ok">pass</span> : <span className="tag tag-danger">fail</span>}
          </>
        }
        actions={
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        }
        testId="eval-trajectory"
      >
        <div className="muted small trajectory-meta">
          {t.status ?? 'unknown'}
          {t.stopReason ? ` (${t.stopReason})` : ''} · {result.steps} steps · {result.toolCalls} tool calls ·{' '}
          {formatNumber(result.inputTokens)} / {formatNumber(result.outputTokens)} tokens · {formatUsd(result.costUsd)}{' '}
          · {formatDuration(t.wallMs ?? result.latencyMs)}
          {result.judgeScore !== null ? ` · judge ${result.judgeScore.toFixed(2)}` : ''}
          {result.agentRunId ? (
            <>
              {' '}
              · <a href={`#/runs/${result.agentRunId}`}>open run</a>
            </>
          ) : null}
        </div>
        {result.failures.length > 0 ? (
          <div className="error-box">
            {result.failures.map((f, i) => (
              <div key={i}>{f}</div>
            ))}
          </div>
        ) : null}
        <ol className="trajectory">
          {t.steps.map((s, i) => (
            <li key={`${s.seq}-${i}`} className={`traj-step traj-${s.kind}`}>
              <div className="traj-head">
                <span className="step-seq">#{s.seq}</span>
                <span className="tag tag-muted">{s.kind}</span>
                {s.tool ? <code className="tool-name">{s.tool}</code> : null}
                {s.decision ? <PolicyBadge decision={s.decision.decision} ruleId={s.decision.ruleId} /> : s.rawDecision}
              </div>
              {s.text ? <div className="assistant-text small">{s.text}</div> : null}
              {s.args !== undefined && s.args !== null ? (
                <pre className="traj-args">
                  {highlightFragments(prettyJson(s.args), s.taint).map((seg, j) =>
                    seg.marked ? (
                      <mark key={j} data-testid="taint-fragment">
                        {seg.text}
                      </mark>
                    ) : (
                      <span key={j}>{seg.text}</span>
                    ),
                  )}
                </pre>
              ) : null}
              {s.taint.length > 0 ? (
                <div className="text-warn small">⚠ tainted: {s.taint.map((f) => `“${f}”`).join(', ')}</div>
              ) : null}
              {s.result ? (
                <div className={`traj-result small${s.result.startsWith('error') ? ' text-danger' : ''}`}>
                  {s.result}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
        {t.answer ? (
          <div className="summary-card">
            <h4>Final answer</h4>
            <div className="run-summary">{t.answer}</div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
