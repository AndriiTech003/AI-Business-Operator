import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RUN_STATUSES, type RunDto } from '@aio/contracts';
import { api } from '../lib/api';
import {
  formatDateTime,
  formatDuration,
  formatUsd,
  isActive,
  runDurationMs,
  statusLabel,
  truncate,
} from '../lib/format';
import { navigate, splitHash } from '../lib/route';
import { useHashQuery } from '../app/hooks';
import { Card, Empty, ErrorBox, Spinner, StatusPill } from '../components/ui';

function setFilter(key: string, value: string): void {
  const { query } = splitHash(window.location.hash);
  const next = new URLSearchParams({ ...query, [key]: value });
  for (const [k, v] of [...next.entries()]) if (v === '') next.delete(k);
  const qs = next.toString();
  navigate(`#/runs${qs === '' ? '' : `?${qs}`}`);
}

export function RunsPage() {
  const query = useHashQuery();
  const status = query['status'] ?? '';
  const userId = query['userId'] ?? '';
  const playbookId = query['playbookId'] ?? '';
  const runs = useQuery({
    queryKey: ['runs', { status, userId, playbookId }],
    queryFn: () => api.runs({ status, userId, playbookId }),
    refetchInterval: (q) => (q.state.data?.items.some((r) => isActive(r.status)) ? 3000 : 15_000),
  });
  const all = useQuery({ queryKey: ['runs', 'recent'], queryFn: () => api.runs({}) });
  const playbooks = useQuery({ queryKey: ['playbooks'], queryFn: api.playbooks });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 300_000 });

  const users = useMemo(() => {
    const map = new Map<string, string>();
    if (me.data) map.set(me.data.userId, me.data.name);
    for (const r of all.data?.items ?? []) map.set(r.userId, r.userName ?? r.userId.slice(0, 8));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all.data, me.data]);
  const playbookNames = useMemo(
    () => new Map((playbooks.data?.items ?? []).map((p) => [p.id, p.name])),
    [playbooks.data],
  );

  return (
    <Card
      title="Runs"
      actions={
        <div className="filters">
          <select
            aria-label="Status"
            data-testid="filter-status"
            value={status}
            onChange={(e) => setFilter('status', e.target.value)}
          >
            <option value="">All statuses</option>
            {RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
          <select
            aria-label="User"
            data-testid="filter-user"
            value={userId}
            onChange={(e) => setFilter('userId', e.target.value)}
          >
            <option value="">All users</option>
            {users.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label="Playbook"
            data-testid="filter-playbook"
            value={playbookId}
            onChange={(e) => setFilter('playbookId', e.target.value)}
          >
            <option value="">All playbooks</option>
            {(playbooks.data?.items ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {runs.isError ? <ErrorBox error={runs.error} /> : null}
      {runs.isLoading ? <Spinner label="Loading runs…" /> : null}
      {runs.data && runs.data.items.length === 0 ? <Empty title="No runs match these filters" /> : null}
      {runs.data && runs.data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="table table-click" data-testid="runs-table">
            <thead>
              <tr>
                <th>Goal</th>
                <th>Status</th>
                <th>User</th>
                <th>Playbook</th>
                <th className="num">Cost</th>
                <th className="num">Duration</th>
                <th className="num">Actions</th>
                <th className="num">Pending</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.items.map((r) => (
                <RunRow
                  key={r.id}
                  run={r}
                  playbookName={r.playbookId ? (playbookNames.get(r.playbookId) ?? 'playbook') : null}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function RunRow({ run, playbookName }: { run: RunDto; playbookName: string | null }) {
  const href = `#/runs/${run.id}`;
  return (
    <tr data-testid="run-row" data-run-id={run.id} onClick={() => navigate(href)}>
      <td className="goal-cell">
        <a href={href} onClick={(e) => e.stopPropagation()}>
          {truncate(run.goal, 90)}
        </a>
      </td>
      <td>
        <StatusPill status={run.status} />
      </td>
      <td className="nowrap">{run.userName ?? '—'}</td>
      <td>{playbookName ?? <span className="muted">—</span>}</td>
      <td className="num">{formatUsd(run.usage.costUsd)}</td>
      <td className="num">{formatDuration(runDurationMs(run))}</td>
      <td className="num">{run.usage.toolCalls}</td>
      <td className="num">
        {run.pendingProposals > 0 ? (
          <span className="tag tag-warn">{run.pendingProposals}</span>
        ) : (
          <span className="muted">0</span>
        )}
      </td>
      <td className="nowrap">{formatDateTime(run.createdAt)}</td>
    </tr>
  );
}
