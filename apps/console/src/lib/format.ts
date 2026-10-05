import type { Decision, RunStatus } from '@aio/contracts';

export function formatUsd(value: number | null | undefined, digits?: number): string {
  const v = value ?? 0;
  const d = digits ?? (Math.abs(v) >= 1 ? 2 : Math.abs(v) >= 0.01 ? 3 : 4);
  return `$${v.toFixed(d)}`;
}

export function formatNumber(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString('en-US');
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}m ${rest}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function runDurationMs(run: {
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}): number | null {
  const start = run.startedAt ?? run.createdAt;
  const end = run.finishedAt;
  if (end === null) return null;
  return new Date(end).getTime() - new Date(start).getTime();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = t - now;
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'min'],
  ];
  for (const [size, unit] of units)
    if (abs >= size) {
      const n = Math.round(abs / size);
      return diff < 0 ? `${n} ${unit} ago` : `in ${n} ${unit}`;
    }
  return diff < 0 ? 'just now' : 'in a moment';
}

export const DECISION_LABEL: Record<Decision, string> = {
  allow: 'auto',
  require_approval: 'approval',
  deny: 'blocked',
};

export function badgeText(decision: Decision, ruleId: string | null | undefined): string {
  const label = DECISION_LABEL[decision];
  return ruleId !== null && ruleId !== undefined && ruleId !== '' ? `${label} · ${ruleId}` : label;
}

export const ACTIVE_STATUSES: readonly RunStatus[] = ['queued', 'running', 'awaiting_approval'];

export function isActive(status: RunStatus | null | undefined): boolean {
  return status !== null && status !== undefined && ACTIVE_STATUSES.includes(status);
}

export function isStreaming(status: RunStatus | null | undefined): boolean {
  return status === 'queued' || status === 'running';
}

export function statusLabel(status: RunStatus): string {
  return status.replace(/_/g, ' ');
}

export function prettyJson(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
