import { loadConfig } from './config';
import { createAppContext } from './context';
import { runMigrations } from './db/client';
import { buildApp } from './http/app';
import { BullDispatcher, redisConnection } from './runtime/dispatch';
import { BullPlaybookScheduler, Sweeper } from './runtime/sweeper';
import { createServices } from './services';

const config = loadConfig();
const dispatcher = new BullDispatcher(redisConnection(config.redisUrl), config.redisPrefix);
const ctx = createAppContext(config, { dispatcher });
if (process.env['AUTO_MIGRATE'] !== '0') await runMigrations(config.databaseUrl);
const services = createServices(ctx, new BullPlaybookScheduler(dispatcher.playbooks));
const sweeper = new Sweeper(ctx);

let app: Awaited<ReturnType<typeof buildApp>> | null = null;
if (config.role === 'api' || config.role === 'all') {
  app = await buildApp(ctx, services);
  await app.listen({ host: config.host, port: config.port });
  ctx.logger.info(
    { url: `http://${config.host}:${config.port}`, provider: ctx.llm.name, model: config.llm.model },
    'agent api listening',
  );
}
if (config.role === 'worker' || config.role === 'all') {
  dispatcher.startWorkers(
    async (job) => {
      await services.executor.execute(job);
    },
    async (job) => {
      await services.playbooks.trigger(job.playbookId, 'schedule');
    },
    config.workerConcurrency,
  );
  sweeper.start();
  await services.playbooks
    .syncAll()
    .catch((error: unknown) => ctx.logger.warn({ err: (error as Error).message }, 'playbook sync failed'));
  ctx.logger.info({ worker: config.workerId, concurrency: config.workerConcurrency }, 'agent worker started');
}

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  if (app !== null) await app.close().catch(() => undefined);
  await sweeper.stop().catch(() => undefined);
  await dispatcher.close().catch(() => undefined);
  await ctx.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
