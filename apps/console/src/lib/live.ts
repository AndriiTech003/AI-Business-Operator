import type { RunContext, RunEvent } from '@aio/contracts';
import { streamEvents } from './api';
import { applyRunEvent, emptyTimeline, isStreamEnd, type TimelineState } from './timeline';

export interface LiveEntry {
  state: TimelineState;
  active: boolean;
  error: string | null;
  startedAt: number;
  controller: AbortController;
}

type Listener = () => void;

export class LiveRuns {
  private readonly entries = new Map<string, LiveEntry>();
  private readonly listeners = new Set<Listener>();
  private readonly endListeners = new Set<(runId: string) => void>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onStreamEnd(listener: (runId: string) => void): () => void {
    this.endListeners.add(listener);
    return () => {
      this.endListeners.delete(listener);
    };
  }

  get(runId: string): LiveEntry | undefined {
    return this.entries.get(runId);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private update(runId: string, fn: (entry: LiveEntry) => LiveEntry): void {
    const entry = this.entries.get(runId);
    if (entry === undefined) return;
    this.entries.set(runId, fn(entry));
    this.emit();
  }

  private finish(runId: string, error: string | null): void {
    this.update(runId, (e) => ({ ...e, active: false, error: error ?? e.error }));
    for (const l of this.endListeners) l(runId);
  }

  private apply(runId: string, event: RunEvent): void {
    this.update(runId, (e) => ({ ...e, state: applyRunEvent(e.state, event) }));
  }

  start(goal: string, context: RunContext): Promise<string> {
    const controller = new AbortController();
    let runId: string | null = null;
    return new Promise<string>((resolve, reject) => {
      const onEvent = (event: RunEvent) => {
        if (runId === null) {
          runId = event.runId;
          this.entries.set(runId, {
            state: emptyTimeline(runId),
            active: true,
            error: null,
            startedAt: Date.now(),
            controller,
          });
          this.emit();
          resolve(runId);
        }
        this.apply(runId, event);
        if (isStreamEnd(event)) controller.abort();
      };
      streamEvents('/runs', { method: 'POST', body: { goal, context }, signal: controller.signal }, onEvent)
        .then(() => {
          if (runId === null) reject(new Error('The agent closed the stream before the run started'));
          else this.finish(runId, null);
        })
        .catch((error: unknown) => {
          if (runId === null) reject(error instanceof Error ? error : new Error(String(error)));
          else this.finish(runId, (error as Error).message);
        });
    });
  }

  attach(runId: string): void {
    const existing = this.entries.get(runId);
    if (existing?.active === true) return;
    const controller = new AbortController();
    this.entries.set(runId, {
      state: emptyTimeline(runId),
      active: true,
      error: null,
      startedAt: Date.now(),
      controller,
    });
    this.emit();
    streamEvents(`/runs/${encodeURIComponent(runId)}/stream`, { method: 'GET', signal: controller.signal }, (event) => {
      this.apply(runId, event);
      if (isStreamEnd(event)) controller.abort();
    })
      .then(() => this.finish(runId, null))
      .catch((error: unknown) => this.finish(runId, (error as Error).message));
  }

  lastAttempt(runId: string): number {
    return this.entries.get(runId)?.startedAt ?? 0;
  }

  stop(runId: string): void {
    this.entries.get(runId)?.controller.abort();
  }
}

export const liveRuns = new LiveRuns();
