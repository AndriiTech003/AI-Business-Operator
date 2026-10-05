import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DECISIONS, type Decision } from '@aio/contracts';
import {
  api,
  ApiError,
  type PolicyDiagnostic,
  type ReplayResponse,
  type SimulateResponse,
  type ValidateResponse,
} from '../lib/api';
import { collapseDiff, diffLines, diffStats } from '../lib/diff';
import { formatDateTime, truncate } from '../lib/format';
import { errorMessage, useToast } from '../app/toast';
import { PolicyEditor } from '../policy/PolicyEditor';
import { Card, ErrorBox, PolicyBadge, Spinner } from '../components/ui';

function asDecision(value: string): Decision | null {
  return (DECISIONS as readonly string[]).includes(value) ? (value as Decision) : null;
}

export function PolicyPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const policy = useQuery({ queryKey: ['policy'], queryFn: api.policy, staleTime: 30_000 });
  const [draft, setDraft] = useState<string | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [validation, setValidation] = useState<ValidateResponse | null>(null);
  const [saveDiagnostics, setSaveDiagnostics] = useState<PolicyDiagnostic[]>([]);

  useEffect(() => {
    if (policy.data && draft === null) {
      setDraft(policy.data.yaml);
      setBaseVersion(policy.data.version);
    }
  }, [policy.data, draft]);

  const validate = useCallback(async (yaml: string) => {
    const res = await api.validatePolicy(yaml);
    setValidation(res);
    return res.diagnostics;
  }, []);

  const save = useMutation({
    mutationFn: () => api.savePolicy(draft ?? '', baseVersion ?? 0),
    onSuccess: (res) => {
      toast.success(`Saved policy v${res.version}. New runs use it; running ones keep their version.`);
      setBaseVersion(res.version);
      setSaveDiagnostics([]);
      void queryClient.invalidateQueries({ queryKey: ['policy'] });
      void queryClient.invalidateQueries({ queryKey: ['tools'] });
    },
    onError: (e) => {
      if (e instanceof ApiError) setSaveDiagnostics(e.diagnostics);
      toast.error(`Policy not saved: ${errorMessage(e)}`);
    },
  });

  if (policy.isLoading || draft === null)
    return policy.isError ? <ErrorBox error={policy.error} /> : <Spinner label="Loading policy…" />;
  const data = policy.data;
  if (data === undefined) return <ErrorBox error={policy.error} />;
  const dirty = draft !== data.yaml;
  const diagnostics = saveDiagnostics.length > 0 ? saveDiagnostics : (validation?.diagnostics ?? []);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const stale = baseVersion !== null && baseVersion !== data.version;

  return (
    <div className="policy-page">
      <div className="policy-grid">
        <Card
          title={
            <>
              Policy <span className="muted">v{data.version}</span>
              {dirty ? <span className="tag tag-warn">unsaved changes</span> : null}
            </>
          }
          actions={
            <>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!dirty}
                onClick={() => {
                  setDraft(data.yaml);
                  setBaseVersion(data.version);
                  setSaveDiagnostics([]);
                }}
              >
                Revert
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                data-testid="policy-save"
                disabled={!dirty || save.isPending || errors > 0}
                onClick={() => save.mutate()}
              >
                {save.isPending ? 'Saving…' : 'Save as new version'}
              </button>
            </>
          }
        >
          {stale ? (
            <div className="warning">
              You are editing v{baseVersion}, but v{data.version} is now current. Saving will be rejected — revert to
              pick up the latest version.
            </div>
          ) : null}
          <PolicyEditor value={draft} onChange={setDraft} validate={validate} />
          <div className="diagnostics" data-testid="policy-diagnostics">
            {diagnostics.length === 0 ? (
              <span className="text-ok small">{validation === null ? 'Validating…' : '✓ Policy is valid'}</span>
            ) : (
              diagnostics.map((d, i) => (
                <div key={`${d.path}-${i}`} className={`diag diag-${d.severity}`}>
                  <span className="diag-pos">{d.line !== null ? `${d.line}:${d.col ?? 1}` : '—'}</span>
                  <span className="diag-sev">{d.severity}</span>
                  {d.path !== '' ? <code>{d.path}</code> : null}
                  <span>{d.message}</span>
                </div>
              ))
            )}
          </div>
          {validation !== null && validation.summary.length > 0 ? (
            <details className="policy-summary">
              <summary>What this policy does ({validation.summary.length} lines)</summary>
              <ul className="plain-list small">
                {validation.summary.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </Card>
        <VersionsCard versions={data.versions} currentVersion={data.version} draft={draft} />
      </div>
      <Simulator draft={draft} dirty={dirty} />
      <ReplayCard draft={draft} dirty={dirty} />
    </div>
  );
}

function VersionsCard({
  versions,
  currentVersion,
  draft,
}: {
  versions: Array<{ version: number; createdAt: string; createdBy: string | null }>;
  currentVersion: number;
  draft: string;
}) {
  const [compare, setCompare] = useState<number>(currentVersion);
  const [showAll, setShowAll] = useState(false);
  const version = useQuery({
    queryKey: ['policy-version', compare],
    queryFn: () => api.policyVersion(compare),
    staleTime: Infinity,
  });
  const lines = useMemo(() => (version.data ? diffLines(version.data.yaml, draft) : []), [version.data, draft]);
  const stats = diffStats(lines);
  const rows = showAll ? lines : collapseDiff(lines, 3);
  return (
    <Card title="Versions & diff" className="versions-card">
      <ul className="versions" data-testid="policy-versions">
        {versions.map((v) => (
          <li key={v.version}>
            <label className={compare === v.version ? 'version active' : 'version'}>
              <input
                type="radio"
                name="compare"
                checked={compare === v.version}
                onChange={() => setCompare(v.version)}
              />
              <strong>v{v.version}</strong>
              {v.version === currentVersion ? <span className="tag tag-ok">current</span> : null}
              <span className="muted small">{formatDateTime(v.createdAt)}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="diff-head">
        <span>
          v{compare} → editor <span className="text-ok">+{stats.added}</span>{' '}
          <span className="text-danger">−{stats.removed}</span>
        </span>
        <label className="check small">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> full file
        </label>
      </div>
      {version.isLoading ? <Spinner /> : null}
      {version.data && stats.added + stats.removed === 0 ? (
        <p className="muted small">The editor content is identical to v{compare}.</p>
      ) : (
        <div className="diff-view" data-testid="policy-diff">
          {rows.map((r, i) =>
            r.type === 'skip' ? (
              <div key={r.key} className="diff-line diff-skip">
                ⋯ {r.count} unchanged line{r.count === 1 ? '' : 's'}
              </div>
            ) : (
              <div key={`${i}-${r.oldLine}-${r.newLine}`} className={`diff-line diff-${r.type}`}>
                <span className="diff-num">{r.oldLine ?? ''}</span>
                <span className="diff-num">{r.newLine ?? ''}</span>
                <span className="diff-sign">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}</span>
                <span className="diff-text">{r.text}</span>
              </div>
            ),
          )}
        </div>
      )}
    </Card>
  );
}

const SAMPLE_ARGS: Record<string, unknown> = {
  send_email: { to: ['someone@outside.example'], subject: 'Hello', body: 'Hi there' },
  void_invoice: { invoiceId: '00000000-0000-0000-0000-000000000000' },
  update_deal: { dealId: '00000000-0000-0000-0000-000000000000', patch: { amountCents: 1000000 } },
  create_task: { title: 'Call the customer' },
  list_contacts: { status: 'lead' },
};

function Simulator({ draft, dirty }: { draft: string; dirty: boolean }) {
  const tools = useQuery({ queryKey: ['tools'], queryFn: api.tools, staleTime: 60_000 });
  const names = useMemo(() => {
    const set = new Set<string>();
    for (const t of tools.data?.visible ?? []) set.add(t.name);
    for (const t of tools.data?.hidden ?? []) set.add(t.tool);
    return [...set].sort();
  }, [tools.data]);
  const [tool, setTool] = useState('send_email');
  const [args, setArgs] = useState(JSON.stringify(SAMPLE_ARGS['send_email'], null, 2));
  const [writeCount, setWriteCount] = useState('0');
  const [externalCount, setExternalCount] = useState('0');
  const [emailsSent, setEmailsSent] = useState('0');
  const [useDraft, setUseDraft] = useState(true);
  const [argsError, setArgsError] = useState<string | null>(null);
  const sim = useMutation({
    mutationFn: (input: Parameters<typeof api.simulate>[0]) => api.simulate(input),
  });

  const run = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args === '' ? '{}' : args);
    } catch (e) {
      setArgsError(`Arguments are not valid JSON: ${(e as Error).message}`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setArgsError('Arguments must be a JSON object');
      return;
    }
    setArgsError(null);
    sim.mutate({
      tool,
      args: parsed as Record<string, unknown>,
      ...(useDraft && dirty ? { yaml: draft } : {}),
      run: {
        writeCount: Number(writeCount) || 0,
        externalCount: Number(externalCount) || 0,
        emailsSent: Number(emailsSent) || 0,
      },
    });
  };

  return (
    <Card title="Policy simulator" className="simulator">
      <div className="sim-grid">
        <div className="sim-form">
          <label className="field">
            <span>Tool</span>
            <select
              data-testid="simulate-tool"
              value={tool}
              onChange={(e) => {
                setTool(e.target.value);
                const sample = SAMPLE_ARGS[e.target.value];
                if (sample !== undefined) setArgs(JSON.stringify(sample, null, 2));
              }}
            >
              {(names.includes(tool) ? names : [tool, ...names]).map((n) => (
                <option key={n} value={n}>
                  {n}
                  {tools.data?.hidden.some((h) => h.tool === n) ? ' (hidden)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Arguments (JSON)</span>
            <textarea
              className="mono"
              data-testid="simulate-args"
              rows={7}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
          </label>
          {argsError !== null ? <div className="error-box">{argsError}</div> : null}
          <div className="counters">
            <label className="field">
              <span>Writes so far</span>
              <input type="number" min={0} value={writeCount} onChange={(e) => setWriteCount(e.target.value)} />
            </label>
            <label className="field">
              <span>External actions</span>
              <input type="number" min={0} value={externalCount} onChange={(e) => setExternalCount(e.target.value)} />
            </label>
            <label className="field">
              <span>E-mails sent</span>
              <input type="number" min={0} value={emailsSent} onChange={(e) => setEmailsSent(e.target.value)} />
            </label>
          </div>
          <div className="btn-row">
            <label className="check small">
              <input type="checkbox" checked={useDraft} onChange={(e) => setUseDraft(e.target.checked)} />
              Use the editor draft{dirty ? '' : ' (no changes)'}
            </label>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="simulate-run"
              disabled={sim.isPending}
              onClick={run}
            >
              {sim.isPending ? 'Simulating…' : 'Simulate'}
            </button>
          </div>
        </div>
        <div data-testid="simulate-result" className="sim-result">
          {sim.isError ? <ErrorBox error={sim.error} title="Simulation failed" /> : null}
          {sim.data ? <SimulationResult result={sim.data} /> : null}
          {!sim.data && !sim.isError ? (
            <p className="muted">
              Pick a tool and arguments to see which rules match and what the agent would be allowed to do.
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function SimulationResult({ result }: { result: SimulateResponse }) {
  const d = result.decision;
  return (
    <div className="sim-output">
      <div className="sim-decision">
        <PolicyBadge decision={d.decision} ruleId={d.ruleId} />
        <span data-testid="simulate-decision">
          decision <strong>{d.decision}</strong> · rule <code>{d.ruleId}</code>
        </span>
        <span className="muted small">
          policy v{result.version} · risk {result.risk} ·{' '}
          {result.visible ? 'visible to the model' : 'hidden from the model'}
        </span>
      </div>
      {d.reasons.length > 0 ? (
        <ul className="plain-list">
          {d.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      {d.warnings.map((w) => (
        <div key={w} className="warning">
          ⚠ {w}
        </div>
      ))}
      <h4>Matched rules</h4>
      {d.matchedRules.length === 0 ? (
        <p className="muted small">No rule matched — the default for this risk class applies.</p>
      ) : (
        <ul className="plain-list">
          {d.matchedRules.map((m) => (
            <li key={m.id}>
              <code>{m.id}</code> → <PolicyBadge decision={m.then} />{' '}
              {m.reason ? <span className="muted">{m.reason}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {d.trace !== undefined && d.trace.length > 0 ? (
        <details>
          <summary className="small">Rule trace ({d.trace.length})</summary>
          <table className="table table-compact">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Then</th>
                <th>Applies to tool</th>
                <th>Matched</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {d.trace.map((t) => (
                <tr key={t.id} className={t.matched ? 'row-hit' : undefined}>
                  <td>
                    <code>{t.id}</code>
                  </td>
                  <td>{t.then}</td>
                  <td>{t.applicable ? 'yes' : 'no'}</td>
                  <td>{t.matched ? 'yes' : 'no'}</td>
                  <td className="text-danger">{t.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}

function ReplayCard({ draft, dirty }: { draft: string; dirty: boolean }) {
  const replay = useMutation({ mutationFn: () => api.replay({ yaml: draft, lastRuns: 100 }) });
  return (
    <Card
      title="What would change on the last 100 runs"
      actions={
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid="replay-run"
          disabled={replay.isPending}
          onClick={() => replay.mutate()}
        >
          {replay.isPending ? 'Replaying…' : dirty ? 'Replay the editor draft' : 'Replay current policy'}
        </button>
      }
    >
      <div data-testid="replay-result">
        {replay.isError ? <ErrorBox error={replay.error} title="Replay failed" /> : null}
        {replay.data ? <ReplayResult result={replay.data} /> : null}
        {!replay.data && !replay.isError ? (
          <p className="muted">
            Re-evaluates every recorded tool call of the last 100 runs against the editor content and lists the
            decisions that would be different.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function ReplayResult({ result }: { result: ReplayResponse }) {
  const entries = Object.entries(result.summary);
  return (
    <div>
      <p data-testid="replay-summary">
        Replayed <strong>{result.actions}</strong> actions from <strong>{result.runs}</strong> runs —{' '}
        <strong>{result.changed.length}</strong> decision{result.changed.length === 1 ? '' : 's'} would change.
      </p>
      {entries.length > 0 ? (
        <div className="chips">
          {entries.map(([k, v]) => (
            <span key={k} className="chip">
              {k.replace(/_/g, ' ')}: {v}
            </span>
          ))}
        </div>
      ) : null}
      {result.changed.length > 0 ? (
        <div className="table-wrap">
          <table className="table" data-testid="replay-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Step</th>
                <th>Tool</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              {result.changed.map((c) => {
                const before = asDecision(c.before.decision);
                const after = asDecision(c.after.decision);
                return (
                  <tr key={`${c.runId}-${c.seq}`}>
                    <td>
                      <a href={`#/runs/${c.runId}`}>{truncate(c.goal, 60)}</a>
                    </td>
                    <td>#{c.seq}</td>
                    <td>
                      <code>{c.tool}</code>
                    </td>
                    <td>{before ? <PolicyBadge decision={before} ruleId={c.before.ruleId} /> : c.before.decision}</td>
                    <td>{after ? <PolicyBadge decision={after} ruleId={c.after.ruleId} /> : c.after.decision}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
