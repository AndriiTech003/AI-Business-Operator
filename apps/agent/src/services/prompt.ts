import { eq } from 'drizzle-orm';
import type { ToolDescriptor } from '@aio/contracts';
import {
  buildSystemPrompt,
  type HiddenToolInfo,
  type PromptContextProvider,
  type PromptUser,
  type RunState,
} from '@aio/agent-core';
import type { Db } from '../db/client';
import { tenantSettings } from '../db/schema';
import type { BopClient } from './bop';

export interface TenantInfo {
  id: string;
  name: string;
  domain: string;
  timezone: string;
  instructions: string;
  serviceTokenEnc: string | null;
}

export async function loadTenant(db: Db, tenantId: string): Promise<TenantInfo> {
  const [row] = await db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
  return {
    id: tenantId,
    name: row?.name ?? 'the company',
    domain: row?.domain ?? '',
    timezone: row?.timezone ?? 'UTC',
    instructions: row?.instructions ?? '',
    serviceTokenEnc: row?.serviceTokenEnc ?? null,
  };
}

export class TeamDirectory {
  private readonly cache = new Map<string, { members: PromptUser[]; expires: number }>();

  constructor(private readonly bop: BopClient) {}

  async members(tenantId: string, token: string): Promise<PromptUser[]> {
    const hit = this.cache.get(tenantId);
    if (hit !== undefined && hit.expires > Date.now()) return hit.members;
    const list = await this.bop.members(token).catch(() => []);
    const members = list
      .map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.cache.set(tenantId, { members, expires: Date.now() + 60_000 });
    return members;
  }
}

export class AgentPromptProvider implements PromptContextProvider {
  constructor(
    private readonly tenant: TenantInfo,
    private readonly user: PromptUser,
    private readonly team: PromptUser[],
  ) {}

  async build(
    run: RunState,
    _visible: ToolDescriptor[],
    hidden: HiddenToolInfo[],
    approvalSummary: string[],
  ): Promise<string> {
    return buildSystemPrompt({
      tenantName: this.tenant.name,
      tenantDomain: this.tenant.domain,
      timezone: this.tenant.timezone,
      now: run.promptNow ?? new Date().toISOString(),
      user: this.user,
      team: this.team,
      instructions: this.tenant.instructions,
      approvalRequired: approvalSummary,
      blocked: hidden,
      record: run.context?.record ?? null,
    });
  }
}
