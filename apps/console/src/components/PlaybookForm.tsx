import { useState, type FormEvent } from 'react';
import type { PlaybookInput } from '../lib/api';
import { checkCron, describeCron } from '../lib/cron';

const TIMEZONES = [
  'UTC',
  'Europe/Berlin',
  'Europe/London',
  'Europe/Kyiv',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Tokyo',
];

export function PlaybookForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: PlaybookInput;
  submitLabel: string;
  busy: boolean;
  onSubmit: (input: PlaybookInput) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [schedule, setSchedule] = useState(initial.schedule ?? '');
  const [timezone, setTimezone] = useState(initial.timezone);
  const [enabled, setEnabled] = useState(initial.enabled);
  const cron = schedule.trim() === '' ? null : checkCron(schedule);
  const zones = TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cron !== null && !cron.ok) return;
    onSubmit({
      name: name.trim(),
      instructions: instructions.trim(),
      schedule: schedule.trim() === '' ? null : schedule.trim(),
      timezone,
      enabled,
    });
  };

  return (
    <form className="playbook-form" onSubmit={submit} data-testid="playbook-form">
      <label className="field">
        <span>Name</span>
        <input
          data-testid="playbook-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
        />
      </label>
      <label className="field">
        <span>Instructions</span>
        <textarea
          data-testid="playbook-instructions"
          rows={5}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          required
          placeholder="Every day: find invoices more than 30 days overdue and prepare reminder e-mails for approval."
        />
      </label>
      <div className="form-row">
        <label className="field">
          <span>Schedule (cron)</span>
          <input
            className="mono"
            data-testid="playbook-schedule"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            placeholder="0 9 * * 1"
          />
          <small className={cron !== null && !cron.ok ? 'text-danger' : 'muted'}>
            {cron === null ? 'Leave empty to run manually only' : cron.ok ? describeCron(schedule) : cron.error}
          </small>
        </label>
        <label className="field">
          <span>Timezone</span>
          <select data-testid="playbook-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <label className="check field-check">
          <input
            type="checkbox"
            data-testid="playbook-enabled"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enabled
        </label>
      </div>
      <div className="btn-row">
        {onCancel !== undefined ? (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button
          type="submit"
          className="btn btn-primary"
          data-testid="playbook-save"
          disabled={busy || (cron !== null && !cron.ok)}
        >
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
