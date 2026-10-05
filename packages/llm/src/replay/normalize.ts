import { createHash } from 'node:crypto';
import { canonicalJson, type ChatMessage, type ContentBlock } from '@aio/contracts';
import type { LlmRequest, LlmTool } from '../types';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DATETIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})/g;
const DATE_RE = /(?<![\d-])\d{4}-\d{2}-\d{2}(?![\dT])/g;
const PLACEHOLDER_RE = /⟦(id|ts|d|rel|reld):(-?\d+)⟧/g;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY_MS = 86_400_000;

type Kind = 'id' | 'ts' | 'd';

export class VolatileValueMap {
  private readonly forward = new Map<string, string>();
  private readonly backward = new Map<string, string>();
  private readonly counters: Record<Kind, number> = { id: 0, ts: 0, d: 0 };

  placeholder(kind: Kind, value: string): string {
    const key = `${kind}|${value}`;
    const existing = this.forward.get(key);
    if (existing !== undefined && kind === 'id') return existing;
    const p = `⟦${kind}:${this.counters[kind]}⟧`;
    this.counters[kind] += 1;
    if (existing === undefined) this.forward.set(key, p);
    this.backward.set(p, value);
    return p;
  }

  lookup(kind: Kind, value: string): string | undefined {
    return this.forward.get(`${kind}|${value}`);
  }

  resolve(placeholder: string): string | undefined {
    return this.backward.get(placeholder);
  }

  get size(): number {
    return this.forward.size;
  }
}

export function normalizeString(text: string, map: VolatileValueMap): string {
  return text
    .replace(DATETIME_RE, (m) => map.placeholder('ts', m))
    .replace(DATE_RE, (m) => map.placeholder('d', m))
    .replace(UUID_RE, (m) => map.placeholder('id', m.toLowerCase()));
}

function walk(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, fn));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, fn);
    return out;
  }
  return value;
}

export interface NormalizedRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: LlmTool[];
}

export function normalizeRequest(request: LlmRequest): { normalized: NormalizedRequest; map: VolatileValueMap } {
  const map = new VolatileValueMap();
  const fn = (s: string) => normalizeString(s, map);
  const system = fn(request.system);
  const messages = walk(request.messages, fn) as ChatMessage[];
  const tools = walk(request.tools, fn) as LlmTool[];
  return { normalized: { model: request.model, system, messages, tools }, map };
}

export function cassetteKey(normalized: NormalizedRequest): string {
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}

function utcDay(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

export function encodeResponseString(text: string, map: VolatileValueMap, anchor: string | undefined): string {
  const anchorMs = anchor === undefined ? Number.NaN : Date.parse(anchor);
  return text
    .replace(DATETIME_RE, (m) => {
      const known = map.lookup('ts', m);
      if (known !== undefined) return known;
      if (Number.isFinite(anchorMs) && ISO_MS_RE.test(m)) return `⟦rel:${Date.parse(m) - anchorMs}⟧`;
      return m;
    })
    .replace(DATE_RE, (m) => {
      const known = map.lookup('d', m);
      if (known !== undefined) return known;
      if (anchor !== undefined && Number.isFinite(anchorMs)) return `⟦reld:${utcDay(m) - utcDay(anchor)}⟧`;
      return m;
    })
    .replace(UUID_RE, (m) => map.lookup('id', m.toLowerCase()) ?? m);
}

export class PlaceholderError extends Error {}

export function decodeResponseString(text: string, map: VolatileValueMap, anchor: string | undefined): string {
  return text.replace(PLACEHOLDER_RE, (whole, kind: string, num: string) => {
    if (kind === 'rel' || kind === 'reld') {
      if (anchor === undefined) throw new PlaceholderError(`relative time ${whole} needs an anchor time`);
      const anchorMs = Date.parse(anchor);
      if (kind === 'rel') return new Date(anchorMs + Number(num)).toISOString();
      const day = Math.floor(anchorMs / DAY_MS) + Number(num);
      return new Date(day * DAY_MS).toISOString().slice(0, 10);
    }
    const value = map.resolve(whole);
    if (value === undefined) throw new PlaceholderError(`placeholder ${whole} is not present in the current request`);
    return value;
  });
}

export function encodeContent(
  content: ContentBlock[],
  map: VolatileValueMap,
  anchor: string | undefined,
): ContentBlock[] {
  return walk(content, (s) => encodeResponseString(s, map, anchor)) as ContentBlock[];
}

export function decodeContent(
  content: ContentBlock[],
  map: VolatileValueMap,
  anchor: string | undefined,
): ContentBlock[] {
  return walk(content, (s) => decodeResponseString(s, map, anchor)) as ContentBlock[];
}
