import type { Redis } from 'ioredis';
import type { RunEvent } from '@aio/contracts';
import type { EventSink } from '@aio/agent-core';

export type RunEventListener = (event: RunEvent) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<RunEventListener>>();
  private subscribed = false;

  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
    private readonly prefix: string,
  ) {}

  channel(runId: string): string {
    return `${this.prefix}:run:${runId}`;
  }

  publish(event: RunEvent): void {
    void this.pub.publish(this.channel(event.runId), JSON.stringify(event)).catch(() => 0);
  }

  sink(): EventSink {
    return { emit: (event) => this.publish(event) };
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;
    await this.sub.psubscribe(`${this.prefix}:run:*`);
    this.sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      const runId = channel.slice(`${this.prefix}:run:`.length);
      const set = this.listeners.get(runId);
      if (set === undefined) return;
      let event: RunEvent;
      try {
        event = JSON.parse(message) as RunEvent;
      } catch {
        return;
      }
      for (const l of set) l(event);
    });
  }

  async subscribe(runId: string, listener: RunEventListener): Promise<() => void> {
    await this.ensureSubscribed();
    const set = this.listeners.get(runId) ?? new Set<RunEventListener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }
}

export class CompositeSink implements EventSink {
  constructor(private readonly sinks: EventSink[]) {}

  emit(event: RunEvent): void {
    for (const s of this.sinks) s.emit(event);
  }
}
