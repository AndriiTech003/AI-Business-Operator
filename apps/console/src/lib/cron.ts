export interface CronField {
  name: string;
  min: number;
  max: number;
}

const FIELDS: CronField[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTH_ALIASES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_ALIASES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export type CronCheck = { ok: true; fields: string[] } | { ok: false; error: string };

function aliasValue(token: string, index: number): string {
  const lower = token.toLowerCase();
  if (index === 3) {
    const m = MONTH_ALIASES.indexOf(lower);
    if (m >= 0) return String(m + 1);
  }
  if (index === 4) {
    const d = DAY_ALIASES.indexOf(lower);
    if (d >= 0) return String(d);
  }
  return token;
}

function checkPart(part: string, field: CronField, index: number): string | null {
  const [rangePart, stepPart, extra] = part.split('/');
  if (extra !== undefined || rangePart === undefined || rangePart === '') return `invalid ${field.name} '${part}'`;
  if (stepPart !== undefined && !/^\d+$/.test(stepPart)) return `invalid step in ${field.name} '${part}'`;
  if (stepPart !== undefined && Number(stepPart) === 0) return `step must be positive in ${field.name}`;
  if (rangePart === '*') return null;
  const bounds = rangePart.split('-').map((t) => aliasValue(t, index));
  if (bounds.length > 2 || bounds.some((b) => !/^\d+$/.test(b))) return `invalid ${field.name} '${part}'`;
  const nums = bounds.map(Number);
  for (const n of nums)
    if (n < field.min || n > field.max) return `${field.name} ${n} is out of range ${field.min}-${field.max}`;
  if (nums.length === 2 && (nums[0] as number) > (nums[1] as number)) return `invalid range in ${field.name} '${part}'`;
  return null;
}

export function checkCron(expr: string): CronCheck {
  const fields = expr
    .trim()
    .split(/\s+/)
    .filter((f) => f !== '');
  if (fields.length !== 5)
    return { ok: false, error: `expected 5 fields (minute hour day month weekday), got ${fields.length}` };
  for (let i = 0; i < 5; i += 1) {
    const field = FIELDS[i] as CronField;
    for (const part of (fields[i] as string).split(',')) {
      const error = checkPart(part, field, i);
      if (error !== null) return { ok: false, error };
    }
  }
  return { ok: true, fields };
}

function pad(n: string): string {
  return n.padStart(2, '0');
}

function dayList(field: string): string | null {
  if (field === '1-5') return 'weekdays';
  if (field === '0,6' || field === '6,0') return 'weekends';
  const parts = field.split(',').map((p) => aliasValue(p, 4));
  if (parts.every((p) => /^\d+$/.test(p) && Number(p) <= 7)) return parts.map((p) => DAY_NAMES[Number(p)]).join(', ');
  return null;
}

export function describeCron(expr: string | null | undefined): string {
  if (expr === null || expr === undefined || expr.trim() === '') return 'manual only';
  const check = checkCron(expr);
  if (!check.ok) return `invalid: ${check.error}`;
  const [minute, hour, dom, month, dow] = check.fields as [string, string, string, string, string];
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === '*' && dom === '*' && month === '*' && dow === '*')
    return `every ${everyMinutes[1]} minutes`;
  if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') return 'every minute';
  if (/^\d+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*')
    return `every hour at :${pad(minute)}`;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && month === '*') {
    const time = `${pad(hour)}:${pad(minute)}`;
    if (dom === '*' && dow === '*') return `every day at ${time}`;
    if (dom === '*') {
      const days = dayList(dow);
      if (days !== null)
        return days === 'weekdays' || days === 'weekends' ? `${days} at ${time}` : `every ${days} at ${time}`;
    }
    if (dow === '*' && /^\d+$/.test(dom)) return `monthly on day ${dom} at ${time}`;
  }
  return expr.trim();
}
