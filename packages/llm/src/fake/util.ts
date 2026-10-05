const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
    weekday: WEEKDAYS.indexOf(String(parts['weekday']).toLowerCase()),
  };
}

export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i += 1) {
    const p = localParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const target = Date.UTC(year, month - 1, day, hour, minute);
    guess += target - asUtc;
  }
  return new Date(guess);
}

export function addLocalDays(now: Date, timeZone: string, days: number, hour: number, minute = 0): Date {
  const p = localParts(now, timeZone);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hour, minute, timeZone);
}

export function nextWeekday(now: Date, timeZone: string, weekday: number, hour: number): Date {
  const p = localParts(now, timeZone);
  let delta = (weekday - p.weekday + 7) % 7;
  if (delta === 0) delta = 7;
  return addLocalDays(now, timeZone, delta, hour);
}

export function parseDuePhrase(text: string, now: Date, timeZone: string): { date: Date; phrase: string } | null {
  const t = text.toLowerCase();
  const hour = /afternoon/.test(t) ? 14 : 9;
  if (/\btomorrow\b/.test(t)) return { date: addLocalDays(now, timeZone, 1, hour), phrase: 'tomorrow' };
  if (/\btoday\b/.test(t)) return { date: addLocalDays(now, timeZone, 0, 17), phrase: 'today' };
  const inDays = /\bin (\d+) days?\b/.exec(t);
  if (inDays) return { date: addLocalDays(now, timeZone, Number(inDays[1]), hour), phrase: `in ${inDays[1]} days` };
  for (const [i, name] of WEEKDAYS.entries()) {
    if (new RegExp(`\\b(next |on |by |this )?${name}\\b`).test(t))
      return { date: nextWeekday(now, timeZone, i, hour), phrase: name };
  }
  return null;
}

export function localDate(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function money(cents: number, currency = 'USD'): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : `${currency} `;
  return `${sign}${symbol}${whole}.${frac}`;
}

export function parseMoney(text: string): number | null {
  const m = /\$\s?([\d,]+(?:\.\d{1,2})?)\s*(k|K)?/.exec(text);
  if (!m) return null;
  const value = Number((m[1] as string).replace(/,/g, '')) * (m[2] ? 1000 : 1);
  return Math.round(value * 100);
}

const NOISE = new Set(['the', 'a', 'an', 'deal', 'deals', 'account', 'with', 'for', 'of', 'at', 'from', 'one', 'our']);

export function normalizeName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[–—'"“”‘’]/g, ' ')
    .replace(/[^\p{L}\p{N}@.\s-]/gu, ' ')
    .replace(/\s+-\s+|\s+/g, ' ')
    .trim();
}

export function tokens(text: string): string[] {
  return normalizeName(text)
    .split(' ')
    .filter((t) => t.length > 0 && !NOISE.has(t));
}

export function matchesAll(title: string, reference: string): boolean {
  const hay = new Set(tokens(title));
  const ref = tokens(reference);
  return ref.length > 0 && ref.every((t) => hay.has(t) || [...hay].some((h) => h.startsWith(t) && t.length >= 4));
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function listText(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function capitalize(s: string): string {
  return s.length === 0 ? s : `${(s[0] as string).toUpperCase()}${s.slice(1)}`;
}
