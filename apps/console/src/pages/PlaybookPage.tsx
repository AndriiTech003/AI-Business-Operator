import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type PlaybookInput } from '../lib/api';
import { describeCron } from '../lib/cron';
import { formatDateTime, formatDuration, formatRelative, formatUsd, runDurationMs, truncate } from '../lib/format';
import { navigate } from '../lib/route';
import { errorMessage, useToast } from '../app/toast';
import { PlaybookForm } from '../components/PlaybookForm';
import { Card, Empty, ErrorBox, Spinner, Stat, StatusPill } from '../components/ui';

export function PlaybookPage({ id }: { id: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['playbook', id], queryFn: () => api.playbook(id) });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['playbook', id] });
    void queryClient.invalidateQueries({ queryKey: ['playbooks'] });
  };
  const update = useMutation({
    mutationFn: (input: PlaybookInput) => api.updatePlaybook(id, input),
    onSuccess: () => {
      toast.success('Playbook saved');
      invalidate();
    },
    onError: (e) => toast.error(`Could not save: ${errorMessage(e)}`),
  });
  const runNow = useMutation({
    mutationFn: () => api.runPlaybook(id),
    onSuccess: (run) => {
      toast.success('Playbook started');
      invalidate();
      navigate(`#/runs/${run.id}`);
    },
    onError: (e) => toast.error(`Could not run the playbook: ${errorMessage(e)}`),
  });
  const remove = useMutation({
    mutationFn: () => api.deletePlaybook(id),
    onSuccess: () => {
      toast.success('Playbook deleted');
      void queryClient.invalidateQueries({ queryKey: ['playbooks'] });
      navigate('#/playbooks');
    },
    onError: (e) => toast.error(`Could not delete: ${errorMessage(e)}`),
  });

  if (q.isLoading) return <Spinner label="Loading playbook…" />;
  if (q.isError || q.data === undefined) return <ErrorBox error={q.error} title="Could not load the playbook" />;
  const p = q.data;

  return (
    <div className="stack">
      <p>
        <a href="#/playbooks">← All playbooks</a>
      </p>
      <Card
        title={p.name}
        actions={
          <>
            <button
              type="button"
              className="btn btn-danger-ghost btn-sm"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete playbook “${p.name}”?`)) remove.mutate();
              }}
            >
              Delete
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid="playbook-run-now"
              disabled={runNow.isPending}
              onClick={() => runNow.mutate()}
            >
              {runNow.isPending ? 'Starting…' : 'Run now'}
            </button>
          </>
        }
      >
        <div className="stats">
          <Stat
            label="Schedule"
            value={<code>{p.schedule ?? '—'}</code>}
            hint={`${describeCron(p.schedule)} · ${p.timezone}`}
          />
          <Stat label="Status" value={p.enabled ? 'Enabled' : 'Disabled'} />
          <Stat
            label="Next run"
            value={p.enabled && p.nextRunAt ? formatRelative(p.nextRunAt) : '—'}
            hint={formatDateTime(p.nextRunAt)}
          />
          <Stat label="Runs" value={p.runCount} hint={`last ${formatRelative(p.lastRunAt)}`} />
          <Stat label="Cost this month" value={formatUsd(p.monthCostUsd)} />
        </div>
      </Card>
      <Card title="Edit">
        <PlaybookForm
          key={p.updatedAt}
          initial={{
            name: p.name,
            instructions: p.instructions,
            schedule: p.schedule,
            timezone: p.timezone,
            enabled: p.enabled,
          }}
          submitLabel="Save changes"
          busy={update.isPending}
          onSubmit={(input) => update.mutate(input)}
        />
      </Card>
      <Card title="History">
        {p.runs.length === 0 ? (
          <Empty title="This playbook has not run yet" />
        ) : (
          <div className="table-wrap">
            <table className="table table-click" data-testid="playbook-runs">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Summary</th>
                  <th className="num">Cost</th>
                  <th className="num">Duration</th>
                  <th className="num">Pending</th>
                </tr>
              </thead>
              <tbody>
                {p.runs.map((r) => (
                  <tr key={r.id} onClick={() => navigate(`#/runs/${r.id}`)}>
                    <td className="nowrap">
                      <a href={`#/runs/${r.id}`} onClick={(e) => e.stopPropagation()}>
                        {formatDateTime(r.createdAt)}
                      </a>
                    </td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    <td className="muted">{truncate(r.summary ?? r.error ?? '', 100)}</td>
                    <td className="num">{formatUsd(r.usage.costUsd)}</td>
                    <td className="num">{formatDuration(runDurationMs(r))}</td>
                    <td className="num">{r.pendingProposals}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
