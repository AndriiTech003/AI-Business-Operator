import type { ReactNode } from 'react';
import type { Decision, RunStatus } from '@aio/contracts';
import { badgeText, prettyJson, statusLabel } from '../lib/format';

export function PolicyBadge({
  decision,
  ruleId,
  title,
}: {
  decision: Decision;
  ruleId?: string | null;
  title?: string;
}) {
  return (
    <span className={`badge badge-${decision}`} data-testid="policy-badge" data-decision={decision} title={title}>
      {badgeText(decision, ruleId)}
    </span>
  );
}

export function StatusPill({ status, testId, raw = false }: { status: RunStatus; testId?: string; raw?: boolean }) {
  return (
    <span className={`pill pill-${status}`} data-testid={testId} data-status={status}>
      {status === 'running' || status === 'queued' ? <span className="dot-pulse" aria-hidden="true" /> : null}
      {raw ? status : statusLabel(status)}
    </span>
  );
}

export function JsonBlock({ value, label }: { value: unknown; label?: string }) {
  const text = prettyJson(value);
  if (text === '') return null;
  return (
    <div className="json-block">
      {label !== undefined ? <div className="json-label">{label}</div> : null}
      <pre>{text}</pre>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      {label !== undefined ? <span>{label}</span> : null}
    </span>
  );
}

export function ErrorBox({ error, title }: { error: unknown; title?: string }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="error-box" role="alert">
      <strong>{title ?? 'Something went wrong'}</strong>
      <span>{message}</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty" data-testid="empty-state">
      <h3>{title}</h3>
      {children !== undefined ? <div className="muted">{children}</div> : null}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
  testId,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={`card${className !== undefined ? ` ${className}` : ''}`} data-testid={testId}>
      {title !== undefined || actions !== undefined ? (
        <header className="card-head">
          {title !== undefined ? <h2>{title}</h2> : <span />}
          {actions !== undefined ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" data-testid={testId}>
        {value}
      </div>
      {hint !== undefined ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}
