import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type PlaybookInput } from '../lib/api';
import { describeCron } from '../lib/cron';
import { formatDateTime, formatRelative, formatUsd } from '../lib/format';
import { navigate } from '../lib/route';
import { errorMessage, useToast } from '../app/toast';
import { PlaybookForm } from '../components/PlaybookForm';
import { Card, Empty, ErrorBox, Spinner } from '../components/ui';

const EMPTY: PlaybookInput = {
  name: '',
  instructions: '',
  schedule: '0 9 * * 1',
  timezone: 'Europe/Berlin',
  enabled: true,
};

export function PlaybooksPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['playbooks'], queryFn: api.playbooks });
  const create = useMutation({
    mutationFn: (input: PlaybookInput) => api.createPlaybook(input),
    onSuccess: (p) => {
      toast.success(`Playbook “${p.name}” created`);
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ['playbooks'] });
      navigate(`#/playbooks/${p.id}`);
    },
    onError: (e) => toast.error(`Could not create the playbook: ${errorMessage(e)}`),
  });
  const runNow = useMutation({
    mutationFn: (id: string) => api.runPlaybook(id),
    onSuccess: (run) => {
      toast.success('Playbook started');
      void queryClient.invalidateQueries({ queryKey: ['playbooks'] });
      navigate(`#/runs/${run.id}`);
    },
    onError: (e) => toast.error(`Could not run the playbook: ${errorMessage(e)}`),
  });

  return (
    <div className="stack">
      <Card
        title="Playbooks"
        actions={
          !creating ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid="playbook-new"
              onClick={() => setCreating(true)}
            >
              + New playbook
            </button>
          ) : undefined
        }
      >
        <p className="muted">
          Saved instructions that run on a schedule with the owner’s permissions. Risky actions still wait for approval.
        </p>
        {creating ? (
          <PlaybookForm
            initial={EMPTY}
            submitLabel="Create playbook"
            busy={create.isPending}
            onSubmit={(input) => create.mutate(input)}
            onCancel={() => setCreating(false)}
          />
        ) : null}
      </Card>
      {list.isLoading ? <Spinner label="Loading playbooks…" /> : null}
      {list.isError ? <ErrorBox error={list.error} /> : null}
      {list.data && list.data.items.length === 0 && !creating ? (
        <Empty title="No playbooks yet">Create one to let the operator do recurring work on a schedule.</Empty>
      ) : null}
      {list.data && list.data.items.length > 0 ? (
        <Card>
          <div className="table-wrap">
            <table className="table table-click" data-testid="playbooks-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Schedule</th>
                  <th>Enabled</th>
                  <th>Next run</th>
                  <th>Last run</th>
                  <th className="num">Runs</th>
                  <th className="num">Cost this month</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((p) => (
                  <tr key={p.id} data-testid="playbook-row" onClick={() => navigate(`#/playbooks/${p.id}`)}>
                    <td>
                      <a href={`#/playbooks/${p.id}`} onClick={(e) => e.stopPropagation()}>
                        {p.name}
                      </a>
                    </td>
                    <td>
                      <code>{p.schedule ?? '—'}</code>
                      <div className="muted small">
                        {describeCron(p.schedule)} · {p.timezone}
                      </div>
                    </td>
                    <td>
                      {p.enabled ? <span className="tag tag-ok">on</span> : <span className="tag tag-muted">off</span>}
                    </td>
                    <td title={formatDateTime(p.nextRunAt)}>
                      {p.enabled && p.nextRunAt ? formatRelative(p.nextRunAt) : '—'}
                    </td>
                    <td title={formatDateTime(p.lastRunAt)}>{formatRelative(p.lastRunAt)}</td>
                    <td className="num">{p.runCount}</td>
                    <td className="num">{formatUsd(p.monthCostUsd)}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        data-testid="playbook-run-now"
                        disabled={runNow.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          runNow.mutate(p.id);
                        }}
                      >
                        Run now
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
