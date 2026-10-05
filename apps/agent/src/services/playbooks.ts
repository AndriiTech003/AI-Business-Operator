import { CronExpressionParser } from 'cron-parser';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { PlaybookCreate, PlaybookDto, PlaybookUpdate, PolicyOverrides, RunContext, RunDto } from '@aio/contracts';
import type { AppContext } from '../context';
import { agentRuns, playbooks } from '../db/schema';
import type { Identity } from './auth';
import { runDto, RunError, type RunService } from './runs';

type PlaybookRow = typeof playbooks.$inferSelect;

export interface PlaybookScheduler {
  upsert(playbookId: string, schedule: string, timezone: string): Promise<void>;
  remove(playbookId: string): Promise<void>;
}

export function nextRun(schedule: string, timezone: string, from: Date): Date {
  return CronExpressionParser.parse(schedule, { tz: timezone, currentDate: from }).next().toDate();
}

export function validateSchedule(schedule: string, timezone: string): string | null {
  try {
    nextRun(schedule, timezone, new Date());
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export class PlaybookService {
  constructor(
    private readonly ctx: AppContext,
    private readonly runs: RunService,
    private readonly scheduler: PlaybookScheduler | null,
  ) {}

  private async dto(row: PlaybookRow): Promise<PlaybookDto> {
    const monthStart = new Date(this.ctx.clock.now().getTime() - 30 * 86_400_000);
    const res = await this.ctx.db.execute<{ c: string; n: string }>(
      sql`SELECT coalesce(sum((usage->>'costUsd')::float8) FILTER (WHERE created_at >= ${monthStart.toISOString()}::timestamptz), 0)::text AS c, count(*)::text AS n FROM agent_runs WHERE playbook_id = ${row.id}::uuid`,
    );
    return {
      id: row.id,
      tenantId: row.tenantId,
      ownerId: row.ownerId,
      name: row.name,
      instructions: row.instructions,
      schedule: row.schedule,
      timezone: row.timezone,
      enabled: row.enabled,
      policyOverrides: row.policyOverrides as PolicyOverrides,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      monthCostUsd: Number(res.rows[0]?.c ?? 0),
      runCount: Number(res.rows[0]?.n ?? 0),
    };
  }

  private async sync(row: PlaybookRow): Promise<void> {
    if (this.scheduler === null) return;
    if (row.enabled && row.schedule !== null && row.schedule !== '')
      await this.scheduler.upsert(row.id, row.schedule, row.timezone);
    else await this.scheduler.remove(row.id);
  }

  async syncAll(): Promise<number> {
    const rows = await this.ctx.db.select().from(playbooks);
    for (const r of rows) await this.sync(r);
    return rows.length;
  }

  async list(identity: Identity): Promise<PlaybookDto[]> {
    const rows = await this.ctx.db
      .select()
      .from(playbooks)
      .where(eq(playbooks.tenantId, identity.tenantId))
      .orderBy(desc(playbooks.createdAt));
    return Promise.all(rows.map((r) => this.dto(r)));
  }

  async get(identity: Identity, id: string): Promise<PlaybookRow> {
    const [row] = await this.ctx.db
      .select()
      .from(playbooks)
      .where(and(eq(playbooks.id, id), eq(playbooks.tenantId, identity.tenantId)));
    if (row === undefined) throw new RunError(404, 'Playbook not found');
    return row;
  }

  async detail(identity: Identity, id: string): Promise<PlaybookDto & { runs: RunDto[] }> {
    const row = await this.get(identity, id);
    const runs = await this.ctx.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.playbookId, id))
      .orderBy(desc(agentRuns.createdAt))
      .limit(50);
    return { ...(await this.dto(row)), runs: runs.map((r) => runDto(r)) };
  }

  async create(identity: Identity, input: PlaybookCreate): Promise<PlaybookDto> {
    const timezone = input.timezone ?? 'UTC';
    const schedule = input.schedule ?? null;
    if (schedule !== null) {
      const err = validateSchedule(schedule, timezone);
      if (err !== null) throw new RunError(422, `Invalid schedule: ${err}`);
    }
    const [row] = await this.ctx.db
      .insert(playbooks)
      .values({
        tenantId: identity.tenantId,
        ownerId: identity.userId,
        name: input.name,
        instructions: input.instructions,
        schedule,
        timezone,
        enabled: input.enabled ?? true,
        policyOverrides: input.policyOverrides ?? {},
        nextRunAt: schedule !== null ? nextRun(schedule, timezone, this.ctx.clock.now()) : null,
      })
      .returning();
    await this.sync(row as PlaybookRow);
    return this.dto(row as PlaybookRow);
  }

  async update(identity: Identity, id: string, input: PlaybookUpdate): Promise<PlaybookDto> {
    const current = await this.get(identity, id);
    if (current.ownerId !== identity.userId && !['owner', 'admin'].includes(identity.role))
      throw new RunError(403, 'Only the owner can change this playbook');
    const timezone = input.timezone ?? current.timezone;
    const schedule = input.schedule === undefined ? current.schedule : input.schedule;
    if (schedule !== null && schedule !== '') {
      const err = validateSchedule(schedule, timezone);
      if (err !== null) throw new RunError(422, `Invalid schedule: ${err}`);
    }
    const [row] = await this.ctx.db
      .update(playbooks)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.policyOverrides !== undefined ? { policyOverrides: input.policyOverrides } : {}),
        schedule,
        timezone,
        nextRunAt: schedule !== null && schedule !== '' ? nextRun(schedule, timezone, this.ctx.clock.now()) : null,
        updatedAt: new Date(),
      })
      .where(eq(playbooks.id, id))
      .returning();
    await this.sync(row as PlaybookRow);
    return this.dto(row as PlaybookRow);
  }

  async remove(identity: Identity, id: string): Promise<void> {
    const current = await this.get(identity, id);
    if (current.ownerId !== identity.userId && !['owner', 'admin'].includes(identity.role))
      throw new RunError(403, 'Only the owner can delete this playbook');
    await this.ctx.db.delete(playbooks).where(eq(playbooks.id, id));
    if (this.scheduler !== null) await this.scheduler.remove(id);
  }

  async trigger(
    playbookId: string,
    trigger: 'schedule' | 'manual',
    workflow?: RunContext['workflow'],
  ): Promise<RunDto | null> {
    const [row] = await this.ctx.db.select().from(playbooks).where(eq(playbooks.id, playbookId));
    if (row === undefined || (trigger === 'schedule' && !row.enabled)) return null;
    const now = this.ctx.clock.now();
    if (trigger === 'schedule') {
      const recent = await this.ctx.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.playbookId, playbookId), gte(agentRuns.createdAt, new Date(now.getTime() - 50_000))));
      if (recent.length > 0) return null;
    }
    const cred = await this.ctx.auth.credential(row.tenantId, row.ownerId);
    if (cred === null)
      throw new RunError(409, 'The playbook owner has no stored credential; they must log in to the console once');
    const run = await this.runs.create(
      cred.identity,
      { goal: row.instructions, context: { source: 'playbook' } },
      {
        playbookId: row.id,
        source: 'playbook',
        policyOverrides: row.policyOverrides as PolicyOverrides,
        ...(workflow !== undefined ? { workflow } : {}),
      },
    );
    await this.ctx.db
      .update(playbooks)
      .set({ lastRunAt: now, nextRunAt: row.schedule ? nextRun(row.schedule, row.timezone, now) : null })
      .where(eq(playbooks.id, playbookId));
    await this.runs.start(run.id);
    return run;
  }

  async runNow(identity: Identity, id: string): Promise<RunDto> {
    await this.get(identity, id);
    const run = await this.trigger(id, 'manual');
    if (run === null) throw new RunError(409, 'Playbook could not be started');
    return run;
  }
}
