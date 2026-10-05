import { Queue, Worker, type ConnectionOptions } from 'bullmq';

export interface RunJob {
  type: 'start' | 'resume' | 'continue';
  runId: string;
  batchId?: string;
  attempt?: number;
}

export interface PlaybookJob {
  playbookId: string;
}

export interface Dispatcher {
  dispatch(job: RunJob): Promise<void>;
}

export function jobId(job: RunJob): string {
  if (job.type === 'continue') return `continue-${job.batchId ?? job.runId}`;
  if (job.type === 'resume') return `resume-${job.runId}-${job.attempt ?? 0}`;
  return `start-${job.runId}`;
}

export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    db: Number(u.pathname.replace('/', '') || 0),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    maxRetriesPerRequest: null,
  };
}

export class BullDispatcher implements Dispatcher {
  readonly runs: Queue<RunJob>;
  readonly playbooks: Queue<PlaybookJob>;
  private readonly workers: Worker[] = [];

  constructor(
    private readonly connection: ConnectionOptions,
    private readonly prefix: string,
  ) {
    this.runs = new Queue<RunJob>('aio-runs', { connection, prefix: `${prefix}:bull` });
    this.playbooks = new Queue<PlaybookJob>('aio-playbooks', { connection, prefix: `${prefix}:bull` });
  }

  async dispatch(job: RunJob): Promise<void> {
    await this.runs.add(job.type, job, {
      jobId: jobId(job),
      removeOnComplete: true,
      removeOnFail: 200,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });
  }

  startWorkers(
    handleRun: (job: RunJob) => Promise<void>,
    handlePlaybook: (job: PlaybookJob) => Promise<void>,
    concurrency: number,
  ): void {
    this.workers.push(
      new Worker<RunJob>('aio-runs', async (job) => handleRun(job.data), {
        connection: this.connection,
        prefix: `${this.prefix}:bull`,
        concurrency,
        lockDuration: 60_000,
      }),
      new Worker<PlaybookJob>('aio-playbooks', async (job) => handlePlaybook(job.data), {
        connection: this.connection,
        prefix: `${this.prefix}:bull`,
        concurrency: 2,
      }),
    );
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
    await this.runs.close();
    await this.playbooks.close();
  }
}

export class InlineDispatcher implements Dispatcher {
  private handler: ((job: RunJob) => Promise<void>) | null = null;
  readonly log: RunJob[] = [];

  setHandler(handler: (job: RunJob) => Promise<void>): void {
    this.handler = handler;
  }

  async dispatch(job: RunJob): Promise<void> {
    this.log.push(job);
    if (this.handler !== null) await this.handler(job);
  }
}
