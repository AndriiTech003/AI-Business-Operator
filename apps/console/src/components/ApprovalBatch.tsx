import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BatchDto, ProposalDto } from '@aio/contracts';
import { api, type DecisionInput } from '../lib/api';
import { formatDateTime, formatRelative, prettyJson } from '../lib/format';
import { errorMessage, useToast } from '../app/toast';
import { PolicyBadge } from './ui';
import { TaintPanel } from './TaintPanel';

export interface EmailEdit {
  to: string[];
  subject: string;
  body: string;
}

export function isEmailProposal(p: ProposalDto): boolean {
  return p.tool === 'send_email' || p.preview?.kind === 'email';
}

export function emailOf(p: ProposalDto): EmailEdit {
  const args = p.args as { to?: unknown; subject?: unknown; body?: unknown };
  const preview = p.preview?.email;
  const to = Array.isArray(args.to)
    ? args.to.map(String)
    : typeof args.to === 'string'
      ? [args.to]
      : (preview?.to ?? []);
  return {
    to,
    subject: typeof args.subject === 'string' ? args.subject : (preview?.subject ?? ''),
    body: typeof args.body === 'string' ? args.body : (preview?.text ?? ''),
  };
}

export function editedArgsFor(p: ProposalDto, edit: EmailEdit): Record<string, unknown> | undefined {
  const original = emailOf(p);
  const out: Record<string, unknown> = {};
  if (edit.subject !== original.subject) out['subject'] = edit.subject;
  if (edit.body !== original.body) out['body'] = edit.body;
  if (edit.to.join(',') !== original.to.join(',')) out['to'] = edit.to;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function ApprovalBatch({ batch, showGoal = false }: { batch: BatchDto; showGoal?: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const pending = batch.proposals.filter((p) => p.status === 'pending');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, EmailEdit>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const isSelected = (id: string) => selected[id] !== false;
  const selectedCount = pending.filter((p) => isSelected(p.id)).length;

  const decide = useMutation({
    mutationFn: (decisions: DecisionInput[]) => api.decide(decisions),
    onSuccess: (_res, decisions) => {
      const approved = decisions.filter((d) => d.decision === 'approve').length;
      const rejected = decisions.length - approved;
      const edited = decisions.filter((d) => d.editedArgs !== undefined).length;
      toast.success(
        `Approved ${approved}, rejected ${rejected}${edited > 0 ? `, edited ${edited}` : ''}. The run continues on the server.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['proposals'] });
      void queryClient.invalidateQueries({ queryKey: ['run', batch.runId] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: (error) => {
      toast.error(`Decision failed: ${errorMessage(error)}`);
      void queryClient.invalidateQueries({ queryKey: ['proposals'] });
    },
  });

  if (pending.length === 0) return null;

  const approveSelected = () => {
    const decisions: DecisionInput[] = pending.map((p) => {
      if (!isSelected(p.id)) return { id: p.id, decision: 'reject', expectedHash: p.argsHash };
      const edit = edits[p.id];
      const editedArgs = edit !== undefined ? editedArgsFor(p, edit) : undefined;
      return editedArgs !== undefined
        ? { id: p.id, decision: 'approve', editedArgs, expectedHash: p.argsHash }
        : { id: p.id, decision: 'approve', expectedHash: p.argsHash };
    });
    decide.mutate(decisions);
  };

  const rejectAll = () => {
    decide.mutate(pending.map((p) => ({ id: p.id, decision: 'reject', expectedHash: p.argsHash })));
  };

  const allSelected = selectedCount === pending.length;

  return (
    <section className="approval-batch" data-testid="approval-batch" data-batch-id={batch.id}>
      <header className="batch-head">
        <div>
          <h3>
            {pending.length} action{pending.length === 1 ? '' : 's'} waiting for your approval
          </h3>
          {showGoal ? (
            <p className="muted batch-goal">
              <a href={`#/runs/${batch.runId}`}>{batch.goal}</a>
            </p>
          ) : null}
          <p className="muted small">
            Requested {formatRelative(batch.createdAt)} · expires {formatDateTime(batch.expiresAt)} · only the exact
            payload you approve is executed
          </p>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => {
              const next: Record<string, boolean> = {};
              for (const p of pending) next[p.id] = !allSelected;
              setSelected(next);
            }}
          />
          Select all
        </label>
      </header>
      <div className="proposals">
        {pending.map((p) => (
          <ProposalCard
            key={p.id}
            proposal={p}
            selected={isSelected(p.id)}
            onToggle={() => setSelected((s) => ({ ...s, [p.id]: !isSelected(p.id) }))}
            edit={edits[p.id]}
            editing={editing === p.id}
            onEdit={() => setEditing(p.id)}
            onCancelEdit={() => setEditing(null)}
            onSaveEdit={(edit) => {
              setEdits((e) => ({ ...e, [p.id]: edit }));
              setEditing(null);
            }}
            onResetEdit={() =>
              setEdits((e) => {
                const next = { ...e };
                delete next[p.id];
                return next;
              })
            }
          />
        ))}
      </div>
      <footer className="batch-actions">
        <span className="muted">
          {selectedCount} of {pending.length} selected · unselected actions will be rejected
        </span>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-danger-ghost"
            data-testid="reject-all"
            disabled={decide.isPending}
            onClick={rejectAll}
          >
            Reject all
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="approve-selected"
            disabled={decide.isPending || editing !== null}
            onClick={approveSelected}
          >
            {decide.isPending ? 'Submitting…' : `Approve selected (${selectedCount})`}
          </button>
        </div>
      </footer>
    </section>
  );
}

function ProposalCard({
  proposal,
  selected,
  onToggle,
  edit,
  editing,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  onResetEdit,
}: {
  proposal: ProposalDto;
  selected: boolean;
  onToggle: () => void;
  edit: EmailEdit | undefined;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (edit: EmailEdit) => void;
  onResetEdit: () => void;
}) {
  const p = proposal;
  const email = isEmailProposal(p);
  const edited = edit !== undefined && editedArgsFor(p, edit) !== undefined;
  return (
    <article
      className={`proposal${selected ? '' : ' proposal-off'}`}
      data-testid="proposal"
      data-tool={p.tool}
      data-proposal-id={p.id}
    >
      <header className="proposal-head">
        <label className="check">
          <input type="checkbox" data-testid="proposal-select" checked={selected} onChange={onToggle} />
          <code className="tool-name">{p.tool}</code>
        </label>
        <span className="proposal-title">{p.preview?.title ?? p.tool}</span>
        <span className="tag tag-muted">{p.risk.replace('_', ' ')}</span>
        <PolicyBadge decision="require_approval" ruleId={p.ruleId} />
        {edited ? (
          <span className="tag tag-info" data-testid="edited-marker">
            edited
          </span>
        ) : null}
        {email && !editing ? (
          <button type="button" className="btn btn-ghost btn-sm" data-testid="proposal-edit" onClick={onEdit}>
            Edit
          </button>
        ) : null}
      </header>
      {p.reasons.length > 0 ? (
        <ul className="reasons">
          {p.reasons.map((r) => (
            <li key={r}>
              <span className="muted">Rule {p.ruleId}:</span> {r}
            </li>
          ))}
        </ul>
      ) : null}
      {p.warnings.map((w) => (
        <div key={w} className="warning" data-testid="proposal-warning">
          ⚠ {w}
        </div>
      ))}
      {p.taint.length > 0 ? <TaintPanel findings={p.taint} /> : null}
      {email ? (
        editing ? (
          <EmailEditor initial={edit ?? emailOf(p)} onSave={onSaveEdit} onCancel={onCancelEdit} />
        ) : (
          <EmailPreview proposal={p} edit={edit} onReset={edited ? onResetEdit : undefined} />
        )
      ) : null}
      {p.preview?.diff !== undefined && p.preview.diff.length > 0 ? <FieldDiff diff={p.preview.diff} /> : null}
      {p.preview?.record !== undefined ? (
        <div className="muted small">
          Record: {p.preview.record.type} · {p.preview.record.label}
        </div>
      ) : null}
      {!email && (p.preview?.diff === undefined || p.preview.diff.length === 0) ? (
        <details className="raw-args">
          <summary>Payload</summary>
          <pre>{prettyJson(p.args)}</pre>
        </details>
      ) : null}
    </article>
  );
}

function EmailPreview({ proposal, edit, onReset }: { proposal: ProposalDto; edit?: EmailEdit; onReset?: () => void }) {
  const base = emailOf(proposal);
  const shown = edit ?? base;
  const from = proposal.preview?.email;
  const subject = edit !== undefined ? edit.subject : (from?.subject ?? base.subject);
  const body = edit !== undefined ? edit.body : from?.text !== undefined && from.text !== '' ? from.text : base.body;
  return (
    <div className="email-preview" data-testid="email-preview">
      <div className="email-row">
        <span className="email-label">To</span>
        <span data-testid="email-to">
          {(edit === undefined && from !== undefined && from.to.length > 0 ? from.to : shown.to).join(', ')}
        </span>
      </div>
      <div className="email-row">
        <span className="email-label">Subject</span>
        <strong data-testid="email-subject">{subject}</strong>
      </div>
      <div className="email-body" data-testid="email-body">
        {body}
      </div>
      {onReset !== undefined ? (
        <button type="button" className="btn btn-link btn-sm" onClick={onReset}>
          Discard my edits
        </button>
      ) : null}
    </div>
  );
}

function EmailEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: EmailEdit;
  onSave: (edit: EmailEdit) => void;
  onCancel: () => void;
}) {
  const [to, setTo] = useState(initial.to.join(', '));
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  return (
    <div className="email-editor">
      <label className="field">
        <span>To</span>
        <input data-testid="edit-to" value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      <label className="field">
        <span>Subject</span>
        <input data-testid="edit-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="field">
        <span>Body</span>
        <textarea data-testid="edit-body" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="btn-row">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="edit-save"
          onClick={() =>
            onSave({
              to: to
                .split(/[,;\s]+/)
                .map((x) => x.trim())
                .filter((x) => x !== ''),
              subject,
              body,
            })
          }
        >
          Save edits
        </button>
      </div>
    </div>
  );
}

function display(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function FieldDiff({ diff }: { diff: Array<{ field: string; from: unknown; to: unknown }> }) {
  return (
    <table className="field-diff" data-testid="field-diff">
      <thead>
        <tr>
          <th>Field</th>
          <th>Current</th>
          <th>Proposed</th>
        </tr>
      </thead>
      <tbody>
        {diff.map((d) => (
          <tr key={d.field}>
            <td>
              <code>{d.field}</code>
            </td>
            <td className="diff-from">{display(d.from)}</td>
            <td className="diff-to">{display(d.to)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
