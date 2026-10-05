import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cpus, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import { launch } from '../apps/eval/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : Number(hit.split('=')[1]);
};
const RUNS = arg('runs', 40);
const CONCURRENCY = arg('concurrency', 8);
const GOALS = [
  'How many overdue invoices does Acme Logistics have, and what is the total outstanding amount?',
  'What is our total accounts receivable that is more than 30 days past due?',
  'How many open deals are in the Negotiation stage and what are they worth in total?',
  'Who owns the Fabrikam Inc account and how many open deals do they have?',
  'What is the status and remaining balance of invoice INV-2026-0006?',
];

function pct(values, p) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
}

const stack = await launch({
  profile: 'smoke',
  agentEnv: { WORKER_CONCURRENCY: String(CONCURRENCY), LOG_LEVEL: 'error' },
});
let code = 0;
try {
  const login = await (
    await fetch(`${stack.agentUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'maria@demo.dev', password: 'demo1234' }),
    })
  ).json();
  const headers = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
  const latencies = [];
  const statuses = {};
  let next = 0;
  const started = Date.now();
  const worker = async () => {
    while (next < RUNS) {
      const i = next;
      next += 1;
      const t0 = Date.now();
      const res = await fetch(`${stack.agentUrl}/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ goal: GOALS[i % GOALS.length], wait: true }),
      });
      const run = await res.json();
      latencies.push(Date.now() - t0);
      statuses[run.status] = (statuses[run.status] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = (Date.now() - started) / 1000;
  const metrics = await (await fetch(`${stack.agentUrl}/metrics`)).text();
  const result = {
    date: new Date().toISOString(),
    environment: {
      cpus: cpus().length,
      model: cpus()[0]?.model,
      loadavg: loadavg(),
      node: process.version,
      llm: 'fake planner (no network, synthetic latency not slept)',
    },
    runs: RUNS,
    concurrency: CONCURRENCY,
    seconds,
    runsPerSecond: Math.round((RUNS / seconds) * 100) / 100,
    latencyMs: { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95), max: Math.max(...latencies) },
    statuses,
    toolCalls: [...metrics.matchAll(/^aio_tool_calls_total\{[^}]*\} (\d+)/gm)].reduce((s, m) => s + Number(m[1]), 0),
    llmCalls: [...metrics.matchAll(/^aio_llm_calls_total\{[^}]*\} (\d+)/gm)].reduce((s, m) => s + Number(m[1]), 0),
  };
  console.log(JSON.stringify(result, null, 2));
  mkdirSync(join(ROOT, 'docs/benchmarks'), { recursive: true });
  writeFileSync(
    join(ROOT, 'docs/benchmarks', `loadtest-${result.date.slice(0, 10)}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  if ((statuses.completed ?? 0) !== RUNS) code = 1;
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  await stack.stop();
}
process.exit(code);
