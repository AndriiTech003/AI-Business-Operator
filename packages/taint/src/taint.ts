import type { TaintFinding, TaintKind } from '@aio/contracts';
import { getPath, isUnder, parsePath, stringLeaves } from './paths';

export interface UntrustedSpan {
  text: string;
  tool: string;
  path: string;
  stepSeq: number | null;
}

export interface TaintOptions {
  minLength: number;
  minPhraseLength: number;
  minContentWords: number;
  isNameField: (path: string) => boolean;
}

const NAME_FIELD = /(^|\.)(firstName|lastName|name|fullName)$|hits\[\d+\]\.title$/;

export const DEFAULT_TAINT_OPTIONS: TaintOptions = {
  minLength: 8,
  minPhraseLength: 16,
  minContentWords: 2,
  isNameField: (path) => NAME_FIELD.test(path),
};

const TRUSTED_KEY =
  /^(email|emails|to|name|firstName|lastName|title|domain|number|subject|phone|status|industry|currency|dueDate|issueDate|[a-zA-Z]*Cents|[a-zA-Z]*At)$/;

const STOPWORDS = new Set(
  (
    'a an the and or but if then else of to in on at by for with from as is are was were be been being this that these those ' +
    'it its i me my we our us you your he she they them their his her him not no yes do does did done have has had will would ' +
    'can could should shall may might must so than too very just also all any some each every please thanks thank hi hello ' +
    'dear regards best kind about into over under up down out off more most other such only own same there here when where why how ' +
    'what which who whom whose am re'
  ).split(' '),
);

const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/giu;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
const DIGITS_RE = /\d[\d ,.'-]{3,}\d/g;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}@._:/'-]*/gu;

export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function compact(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.]/gu, '');
}

export function extractUntrustedSpans(
  result: unknown,
  untrustedPaths: string[],
  tool: string,
  stepSeq: number | null,
): UntrustedSpan[] {
  const spans: UntrustedSpan[] = [];
  const seen = new Set<string>();
  for (const p of untrustedPaths) {
    const value = getPath(result, parsePath(p));
    for (const leaf of stringLeaves(value)) {
      if (leaf.value.trim().length === 0) continue;
      const path = leaf.path === '' ? p : `${p}${leaf.path.startsWith('[') ? '' : '.'}${leaf.path}`;
      const key = `${path}|${leaf.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      spans.push({ text: leaf.value, tool, path, stepSeq });
    }
  }
  return spans;
}

export function trustedText(result: unknown, untrustedPaths: string[]): string {
  return stringLeaves(result)
    .filter((l) => !isUnder(l.path, untrustedPaths))
    .filter((l) => !/(^|\.)activities\[/.test(l.path))
    .filter((l) =>
      TRUSTED_KEY.test(
        l.path
          .split('.')
          .at(-1)
          ?.replace(/\[\d+\]$/, '') ?? '',
      ),
    )
    .map((l) => l.value)
    .join('\n');
}

interface Candidate {
  fragment: string;
  kind: TaintKind;
}

function words(text: string): string[] {
  return (text.normalize('NFKC').toLowerCase().match(WORD_RE) ?? []).map((w) => w.replace(/[.:'-]+$/, ''));
}

function isContentWord(w: string): boolean {
  return w.length >= 3 && !STOPWORDS.has(w);
}

function commonRuns(argWords: string[], spanWords: string[], options: TaintOptions): string[] {
  const out: string[] = [];
  if (argWords.length === 0 || spanWords.length === 0) return out;
  const index = new Map<string, number[]>();
  spanWords.forEach((w, i) => index.set(w, [...(index.get(w) ?? []), i]));
  let i = 0;
  while (i < argWords.length) {
    let best = 0;
    for (const j of index.get(argWords[i] as string) ?? []) {
      let k = 0;
      while (i + k < argWords.length && j + k < spanWords.length && argWords[i + k] === spanWords[j + k]) k += 1;
      if (k > best) best = k;
    }
    if (best >= 2) {
      const run = argWords.slice(i, i + best);
      const text = run.join(' ');
      if (text.length >= options.minPhraseLength && run.filter(isContentWord).length >= options.minContentWords)
        out.push(text);
      i += best;
    } else i += 1;
  }
  return out;
}

function candidatesFor(argValue: string, span: UntrustedSpan, options: TaintOptions): Candidate[] {
  const out: Candidate[] = [];
  const spanNorm = normalizeText(span.text);
  const spanCompact = compact(span.text);
  for (const m of argValue.normalize('NFKC').match(EMAIL_RE) ?? []) {
    const e = m.toLowerCase();
    if (spanNorm.includes(e)) out.push({ fragment: e, kind: 'email' });
  }
  for (const m of argValue.normalize('NFKC').match(URL_RE) ?? []) {
    const u = m.toLowerCase().replace(/[.,;]+$/, '');
    if (spanNorm.includes(u)) out.push({ fragment: u, kind: 'url' });
  }
  const numeric = [...(argValue.match(IBAN_RE) ?? []), ...(argValue.match(DIGITS_RE) ?? [])];
  for (const m of numeric) {
    const c = compact(m);
    if (c.replace(/\D/g, '').length >= 5 && spanCompact.includes(c)) out.push({ fragment: m.trim(), kind: 'number' });
  }
  if (options.isNameField(span.path)) return out.filter((c) => c.kind !== 'substring');
  const spanWords = words(span.text);
  const argWords = words(argValue);
  for (const w of argWords)
    if (
      w.length >= options.minLength &&
      /[0-9@./:_]/.test(w) &&
      spanWords.includes(w) &&
      !out.some((c) => c.fragment.includes(w))
    )
      out.push({ fragment: w, kind: 'substring' });
  for (const run of commonRuns(argWords, spanWords, options))
    if (!out.some((c) => run.includes(c.fragment) || c.fragment.includes(run)))
      out.push({ fragment: run, kind: 'substring' });
  return out;
}

function locate(sourceText: string, fragment: string): { start: number; end: number } {
  const lower = sourceText.normalize('NFKC').toLowerCase();
  const idx = lower.indexOf(fragment);
  if (idx >= 0) return { start: idx, end: idx + fragment.length };
  const tokens = fragment.split(' ');
  const first = lower.indexOf(tokens[0] ?? fragment);
  if (first < 0) return { start: -1, end: -1 };
  const lastToken = tokens[tokens.length - 1] ?? '';
  const last = lower.indexOf(lastToken, first);
  return { start: first, end: last < 0 ? first + (tokens[0]?.length ?? 0) : last + lastToken.length };
}

export interface TaintCheckInput {
  args: Record<string, unknown>;
  spans: UntrustedSpan[];
  trusted: string;
  options?: Partial<TaintOptions>;
}

export function checkTaint(input: TaintCheckInput): TaintFinding[] {
  const options = { ...DEFAULT_TAINT_OPTIONS, ...(input.options ?? {}) };
  const trustedNorm = normalizeText(input.trusted);
  const trustedCompact = compact(input.trusted);
  const findings: TaintFinding[] = [];
  const seen = new Set<string>();
  for (const leaf of stringLeaves(input.args)) {
    if (leaf.path === 'idempotencyKey' || leaf.path === 'dryRun') continue;
    for (const span of input.spans) {
      for (const c of candidatesFor(leaf.value, span, options)) {
        const inTrusted =
          c.kind === 'number' ? trustedCompact.includes(compact(c.fragment)) : trustedNorm.includes(c.fragment);
        if (inTrusted) continue;
        const key = `${leaf.path}|${c.fragment}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pos = locate(span.text, c.kind === 'number' ? c.fragment.toLowerCase() : c.fragment);
        findings.push({
          argPath: leaf.path,
          fragment: c.fragment,
          kind: c.kind,
          source: { tool: span.tool, path: span.path, stepSeq: span.stepSeq },
          sourceText: span.text.length > 2000 ? `${span.text.slice(0, 2000)}…` : span.text,
          start: pos.start,
          end: pos.end,
        });
      }
    }
  }
  return findings;
}

export class TaintIndex {
  private readonly spans: UntrustedSpan[] = [];
  private trusted: string[] = [];

  addTrusted(text: string): void {
    if (text.trim() !== '') this.trusted.push(text);
  }

  addToolResult(result: unknown, untrustedPaths: string[], tool: string, stepSeq: number | null): UntrustedSpan[] {
    const spans = extractUntrustedSpans(result, untrustedPaths, tool, stepSeq);
    this.spans.push(...spans);
    this.addTrusted(trustedText(result, untrustedPaths));
    return spans;
  }

  addSpans(spans: UntrustedSpan[]): void {
    this.spans.push(...spans);
  }

  get untrusted(): readonly UntrustedSpan[] {
    return this.spans;
  }

  check(args: Record<string, unknown>, options?: Partial<TaintOptions>): TaintFinding[] {
    if (this.spans.length === 0) return [];
    return checkTaint({ args, spans: this.spans, trusted: this.trusted.join('\n'), ...(options ? { options } : {}) });
  }
}
