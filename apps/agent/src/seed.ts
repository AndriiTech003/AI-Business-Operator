import { eq } from 'drizzle-orm';
import { loadConfig } from './config';
import { createAppContext } from './context';
import { runMigrations } from './db/client';
import { playbooks, tenantSettings } from './db/schema';
import { InlineDispatcher } from './runtime/dispatch';
import { createServices } from './services';

const config = loadConfig();
await runMigrations(config.databaseUrl);
const ctx = createAppContext(config, { dispatcher: new InlineDispatcher() });
try {
  const services = createServices(ctx, null);
  const email = process.env['SEED_EMAIL'] ?? 'demo@demo.dev';
  const password = process.env['SEED_PASSWORD'] ?? 'demo1234';
  const { me } = await ctx.auth.login(email, password);
  const identity = {
    userId: me.userId,
    tenantId: me.tenantId,
    name: me.name,
    email: me.email,
    role: me.role,
    scopes: me.scopes,
    tenantName: me.tenantName,
  };
  await ctx.db
    .update(tenantSettings)
    .set({
      instructions:
        'Write in a friendly, concise tone. Never promise discounts. Sign e-mails with your name and the company name.',
      domain: process.env['SEED_DOMAIN'] ?? 'demo.dev',
    })
    .where(eq(tenantSettings.tenantId, identity.tenantId));
  const managerToken = process.env['SEED_SERVICE_TOKEN'];
  if (managerToken !== undefined && managerToken !== '')
    await ctx.db
      .update(tenantSettings)
      .set({ serviceTokenEnc: ctx.auth.sealSecret(managerToken) })
      .where(eq(tenantSettings.tenantId, identity.tenantId));
  const policy = await ctx.policy.current(identity.tenantId, identity.userId);
  const existing = await ctx.db.select().from(playbooks).where(eq(playbooks.tenantId, identity.tenantId));
  if (existing.length === 0) {
    await services.playbooks.create(identity, {
      name: 'Monday stale-deal follow-ups',
      instructions: 'Find leads we have not contacted in more than 14 days and prepare follow-up emails.',
      schedule: '0 9 * * 1',
      timezone: 'Europe/Berlin',
      enabled: false,
    });
    await services.playbooks.create(identity, {
      name: 'Daily overdue invoice reminders',
      instructions: 'Send payment reminders for all invoices that are more than 30 days overdue.',
      schedule: '30 8 * * *',
      timezone: 'Europe/Berlin',
      enabled: false,
    });
  }
  console.log(
    JSON.stringify({
      tenant: identity.tenantName,
      tenantId: identity.tenantId,
      policyVersion: policy.version,
      playbooks: Math.max(existing.length, 2),
    }),
  );
} finally {
  await ctx.close();
}
