import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContentBlock } from '@aio/contracts';
import type { LlmStopReason, LlmUsage } from '../types';

export interface CassetteEntry {
  turn: number;
  lastMessage: string;
  response: {
    model: string;
    content: ContentBlock[];
    stopReason: LlmStopReason;
    usage: LlmUsage;
    latencyMs: number;
    firstTokenMs: number | null;
    provider: string;
  };
}

export interface CassetteFile {
  version: 1;
  model: string;
  scenarioId: string;
  recordedWith: string;
  entries: Record<string, CassetteEntry>;
}

function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export class CassetteStore {
  private readonly cache = new Map<string, CassetteFile>();
  private readonly used = new Map<string, Set<string>>();

  constructor(readonly dir: string) {}

  path(model: string, scenarioId: string): string {
    return join(this.dir, safe(model), `${safe(scenarioId)}.json`);
  }

  load(model: string, scenarioId: string): CassetteFile {
    const p = this.path(model, scenarioId);
    const cached = this.cache.get(p);
    if (cached !== undefined) return cached;
    const file: CassetteFile = existsSync(p)
      ? (JSON.parse(readFileSync(p, 'utf8')) as CassetteFile)
      : { version: 1, model, scenarioId, recordedWith: '', entries: {} };
    this.cache.set(p, file);
    return file;
  }

  get(model: string, scenarioId: string, key: string): CassetteEntry | undefined {
    const entry = this.load(model, scenarioId).entries[key];
    if (entry !== undefined) this.markUsed(model, scenarioId, key);
    return entry;
  }

  put(model: string, scenarioId: string, key: string, entry: CassetteEntry, recordedWith: string): void {
    const file = this.load(model, scenarioId);
    file.entries[key] = entry;
    file.recordedWith = recordedWith;
    this.markUsed(model, scenarioId, key);
  }

  reset(model: string, scenarioId: string): void {
    const p = this.path(model, scenarioId);
    this.cache.set(p, { version: 1, model, scenarioId, recordedWith: '', entries: {} });
    this.used.set(p, new Set());
  }

  private markUsed(model: string, scenarioId: string, key: string): void {
    const p = this.path(model, scenarioId);
    const set = this.used.get(p) ?? new Set<string>();
    set.add(key);
    this.used.set(p, set);
  }

  flush(model: string, scenarioId: string, pruneUnused = true): string {
    const p = this.path(model, scenarioId);
    const file = this.load(model, scenarioId);
    const used = this.used.get(p) ?? new Set<string>();
    const entries: Record<string, CassetteEntry> = {};
    const keys = Object.keys(file.entries).filter((k) => !pruneUnused || used.has(k));
    keys.sort((a, b) => (file.entries[a]?.turn ?? 0) - (file.entries[b]?.turn ?? 0) || a.localeCompare(b));
    for (const k of keys) entries[k] = file.entries[k] as CassetteEntry;
    const out: CassetteFile = { ...file, entries };
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(out, null, 2)}\n`);
    return p;
  }
}
