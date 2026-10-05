import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type { AppContext } from '../context';
import { agentRuns } from '../db/schema';
import type { PlaybookScheduler } from '../services/playbooks';
import type { PlaybookJob } from './dispatch';

export class Sweeper {
  private timer: NodeJS.Timeout | null = null;
  private readonly token = randomUUID();
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  private get leaderKey(): string {
    return `${this.ctx.config.redisPrefix}:sweeper:leader`;
  }

  async isLeader(): Promise<boolean> {
    const ttl = this.ctx.config.sweepIntervalMs * 3;
    const ok = await this.ctx.redis.set(this.leaderKey, this.token, 'PX', ttl, 'NX');
    if (ok === 'OK') return true;
    const holder = await this.ctx.redis.get(this.leaderKey);
    if (holder === this.token) {
      await this.ctx.redis.pexpire(this.leaderKey, ttl);
      return true;
    }
    return false;
  }

  async tick(): Promise<{ resumed: number; expired: number; continued: number; republished: number; polled: number }> {
    const { db, dispatcher, approvals, clock, config } = this.ctx;
    const now = clock.now();
    const staleBefore = new Date(now.getTime() - config.leaseMs);
    const stale = await db
      .select({ id: agentRuns.id, attempts: agentRuns.attempts })
      .from(agentRuns)
      .where(
        and(
          inArray(agentRuns.status, ['running', 'queued']),
          eq(agentRuns.cancelRequested, false),
          or(
            and(isNotNull(agentRuns.leaseExpiresAt), lt(agentRuns.leaseExpiresAt, now)),
            and(isNull(agentRuns.leaseOwner), lt(agentRuns.updatedAt, staleBefore)),
          ),
        ),
      );
    for (const r of stale) await dispatcher.dispatch({ type: 'resume', runId: r.id, attempt: r.attempts });
    const cancelled = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          inArray(agentRuns.status, ['running', 'queued']),
          eq(agentRuns.cancelRequested, true),
          isNull(agentRuns.leaseOwner),
        ),
      );
    for (const r of cancelled) await dispatcher.dispatch({ type: 'resume', runId: r.id, attempt: -1 });
    const expired = await approvals.expireDue();
    const republished = await approvals.republishUnpublished();
    const polled = config.approvalPollMs > 0 ? await approvals.pollExternal() : 0;
    let continued = 0;
    for (const b of await approvals.decidedButNotApplied()) {
      const [run] = await db
        .select({ status: agentRuns.status, lease: agentRuns.leaseOwner })
        .from(agentRuns)
        .where(eq(agentRuns.id, b.runId));
      if (run?.status === 'awaiting_approval' && run.lease === null) {
        await dispatcher.dispatch({ type: 'continue', runId: b.runId, batchId: b.batchId });
        continued += 1;
      }
    }
    const counts = await db.execute<{ status: string; n: string }>(
      sql`SELECT status, count(*)::text AS n FROM agent_runs WHERE status IN ('queued','running','awaiting_approval') GROUP BY status`,
    );
    for (const s of ['queued', 'running', 'awaiting_approval'])
      this.ctx.metrics.runsActive.set({ status: s }, Number(counts.rows.find((r) => r.status === s)?.n ?? 0));
    return { resumed: stale.length, expired, continued, republished, polled };
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void (async () => {
        try {
          if (await this.isLeader()) await this.tick();
        } catch (error) {
          this.ctx.logger.warn({ err: (error as Error).message }, 'sweeper tick failed');
        } finally {
          this.running = false;
        }
      })();
    }, this.ctx.config.sweepIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const holder = await this.ctx.redis.get(this.leaderKey).catch(() => null);
    if (holder === this.token) await this.ctx.redis.del(this.leaderKey).catch(() => 0);
  }
}

export class BullPlaybookScheduler implements PlaybookScheduler {
  constructor(private readonly queue: Queue<PlaybookJob>) {}

  async upsert(playbookId: string, schedule: string, timezone: string): Promise<void> {
    await this.queue.upsertJobScheduler(
      `playbook-${playbookId}`,
      { pattern: schedule, tz: timezone },
      { name: 'playbook', data: { playbookId } },
    );
  }

  async remove(playbookId: string): Promise<void> {
    await this.queue.removeJobScheduler(`playbook-${playbookId}`);
  }
}
