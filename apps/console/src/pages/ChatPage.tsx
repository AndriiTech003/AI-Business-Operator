import { useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { liveRuns } from '../lib/live';
import { navigate } from '../lib/route';
import { formatRelative, formatUsd, truncate } from '../lib/format';
import { errorMessage, useToast } from '../app/toast';
import { StatusPill } from '../components/ui';

const EXAMPLES = [
  'Send payment reminders for all invoices that are more than 30 days overdue.',
  'Find leads we have not contacted in 7 days and prepare follow-up e-mails.',
  'Send a follow-up email to Hannah Weber.',
  'Void invoice INV-2026-0003.',
];

export function ChatPage() {
  const toast = useToast();
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const recent = useQuery({ queryKey: ['runs', 'recent'], queryFn: () => api.runs({}) });

  const start = async () => {
    const text = goal.trim();
    if (text === '' || busy) return;
    setBusy(true);
    try {
      const runId = await liveRuns.start(text, { source: 'console' });
      setGoal('');
      navigate(`#/runs/${runId}`);
    } catch (error) {
      toast.error(`Could not start the run: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void start();
    }
  };

  return (
    <div className="chat-page">
      <section className="composer card">
        <h1 className="composer-title">What should the operator do?</h1>
        <p className="muted">
          The agent works in your business system through policy-checked tools. Risky actions wait for your approval.
        </p>
        <textarea
          className="goal-input"
          data-testid="goal-input"
          rows={4}
          placeholder="e.g. Send payment reminders for all invoices that are more than 30 days overdue."
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={onKey}
          disabled={busy}
        />
        <div className="composer-actions">
          <div className="chips">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="chip chip-button" onClick={() => setGoal(ex)}>
                {truncate(ex, 60)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="run-goal"
            disabled={busy || goal.trim() === ''}
            onClick={() => void start()}
          >
            {busy ? 'Starting…' : 'Run'}
          </button>
        </div>
      </section>
      <section className="card">
        <header className="card-head">
          <h2>Recent runs</h2>
          <a href="#/runs" className="btn btn-link btn-sm">
            All runs →
          </a>
        </header>
        {recent.data && recent.data.items.length > 0 ? (
          <ul className="recent-runs">
            {recent.data.items.slice(0, 8).map((r) => (
              <li key={r.id}>
                <a href={`#/runs/${r.id}`}>
                  <span className="recent-goal">{truncate(r.goal, 110)}</span>
                  <span className="recent-meta">
                    <StatusPill status={r.status} />
                    <span className="muted">{formatUsd(r.usage.costUsd)}</span>
                    <span className="muted">{formatRelative(r.createdAt)}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{recent.isLoading ? 'Loading…' : 'No runs yet — give the operator its first task.'}</p>
        )}
      </section>
    </div>
  );
}
