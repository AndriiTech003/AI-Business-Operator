import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UsageRow } from '@aio/contracts';
import { api } from '../lib/api';
import { formatNumber, formatUsd } from '../lib/format';
import { BarChart } from '../components/BarChart';
import { Card, ErrorBox, Spinner, Stat } from '../components/ui';

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fillDays(rows: UsageRow[], from: string, to: string): UsageRow[] {
  const byKey = new Map(rows.map((r) => [r.key.slice(0, 10), r]));
  const out: UsageRow[] = [];
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(`${from}T00:00:00Z`); d <= end && out.length < 400; d = new Date(d.getTime() + 86_400_000)) {
    const key = isoDay(d);
    out.push(byKey.get(key) ?? { key, label: key, runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });
  }
  return out;
}

export function UsagePage() {
  const today = new Date();
  const [from, setFrom] = useState(isoDay(new Date(today.getTime() - 29 * 86_400_000)));
  const [to, setTo] = useState(isoDay(today));
  const q = useQuery({
    queryKey: ['usage', from, to],
    queryFn: () => api.usage(`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`),
  });
  const days = useMemo(() => (q.data ? fillDays(q.data.byDay, from, to) : []), [q.data, from, to]);
  const tokens = (q.data?.byModel ?? []).reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);

  return (
    <div className="stack">
      <Card
        title="Usage & cost"
        actions={
          <div className="filters">
            <label className="inline-field">
              From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="inline-field">
              To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
        }
      >
        {q.isLoading ? <Spinner label="Loading usage…" /> : null}
        {q.isError ? <ErrorBox error={q.error} /> : null}
        {q.data ? (
          <>
            <div className="stats">
              <Stat label="Total cost" value={formatUsd(q.data.totalCostUsd, 2)} testId="usage-total-cost" />
              <Stat label="Runs" value={formatNumber(q.data.totalRuns)} />
              <Stat
                label="Avg cost / run"
                value={formatUsd(q.data.totalRuns > 0 ? q.data.totalCostUsd / q.data.totalRuns : 0)}
              />
              <Stat label="Tokens" value={formatNumber(tokens)} />
            </div>
            <h3 className="section-title">Cost by day</h3>
            <BarChart
              title="Cost by day"
              testId="usage-chart"
              bars={days.map((d) => ({
                key: d.key,
                label: d.key.slice(5),
                value: d.costUsd,
                detail: `${d.runs} run${d.runs === 1 ? '' : 's'}`,
              }))}
              format={(v) => formatUsd(v, v >= 1 || v === 0 ? 2 : 3)}
            />
          </>
        ) : null}
      </Card>
      {q.data ? (
        <div className="grid-3">
          <UsageTable title="By user" rows={q.data.byUser} testId="usage-by-user" />
          <UsageTable title="By playbook" rows={q.data.byPlaybook} testId="usage-by-playbook" />
          <UsageTable title="By model" rows={q.data.byModel} testId="usage-by-model" />
        </div>
      ) : null}
    </div>
  );
}

function UsageTable({ title, rows, testId }: { title: string; rows: UsageRow[]; testId: string }) {
  const total = rows.reduce((n, r) => n + r.costUsd, 0);
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="muted">No usage in this period.</p>
      ) : (
        <table className="table table-compact" data-testid={testId}>
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Runs</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {[...rows]
              .sort((a, b) => b.costUsd - a.costUsd)
              .map((r) => (
                <tr key={r.key}>
                  <td>
                    {r.label}
                    <div className="share-bar" aria-hidden="true">
                      <span style={{ width: `${total > 0 ? (r.costUsd / total) * 100 : 0}%` }} />
                    </div>
                  </td>
                  <td className="num">{r.runs}</td>
                  <td className="num">{formatNumber(r.inputTokens + r.outputTokens)}</td>
                  <td className="num">{formatUsd(r.costUsd)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
