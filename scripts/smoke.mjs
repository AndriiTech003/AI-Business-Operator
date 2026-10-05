import { spawn, spawnSync } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from '../apps/eval/node_modules/pg/lib/index.js';
import { BopApi, Mailpit, deleteRedisPrefix, serveStatic } from '../packages/bop-stack/dist/index.js';
import { parseSseChunk } from '../packages/contracts/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOP_ROOT = process.env.BOP_ROOT ?? resolve(ROOT, '../05-business-operations-platform');
const ID = `${Date.now()}`;
const LOG_DIR = join(ROOT, '.smoke', ID);
mkdirSync(LOG_DIR, { recursive: true });
const SECRET = `aio-smoke-${ID}`;
const BOP_DB = `bop_test_aio_smoke_${ID}`;
const AIO_DB = `aio_test_smoke_${ID}`;
const PORTS = { api: 4586, mcp: 4587, realtime: 4588, agent: 4650, console: 4651 };
const API = `http://127.0.0.1:${PORTS.api}`;
const AGENT = `http://127.0.0.1:${PORTS.agent}`;
const CONSOLE = `http://127.0.0.1:${PORTS.console}`;
const OPERATOR_TOKEN = `aio-operator-smoke-${ID}`;
const BOP_ENV = {
  ...process.env,
  DATABASE_URL: `postgres://127.0.0.1:5432/${BOP_DB}`,
  REDIS_URL: 'redis://127.0.0.1:6379/5',
  REDIS_PREFIX: `bop_test_aio_smoke_${ID}`,
  API_PORT: String(PORTS.api),
  REALTIME_PORT: String(PORTS.realtime),
  PUBLIC_API_URL: API,
  JWT_SECRET: SECRET,
  LOG_LEVEL: 'warn',
  S3_PREFIX: `aio-smoke/${ID}/`,
  SWEEP_INTERVAL_MS: '1000',
  OPERATOR_URL: `${AGENT}/integrations/bop/ai-step`,
  OPERATOR_TOKEN,
  OPERATOR_EMBED_URL: `${CONSOLE}/embed/ask-operator.js`,
  OPERATOR_AGENT_URL: AGENT,
  OPERATOR_CONSOLE_URL: CONSOLE,
};
const children = [];
const servers = [];
let checks = 0;
let bopStarted = false;

function ok(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
  checks += 1;
  console.log(`  ✔ ${message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (error) {
      last = error;
    }
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

function start(name, cmd, args, opts = {}) {
  const log = createWriteStream(join(LOG_DIR, `${name}.log`), { flags: 'a' });
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push({ name, child });
  return child;
}

function devStack(command) {
  const r = spawnSync('bash', [join(BOP_ROOT, 'scripts/dev-stack.sh'), command], { env: BOP_ENV, encoding: 'utf8' });
  writeFileSync(join(LOG_DIR, `dev-stack-${command}.log`), `${r.stdout}\n${r.stderr}`);
  return r;
}

async function http(base, method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (res.status >= 400)
    throw new Error(`${method} ${path} → ${res.status} ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  return json;
}

async function dropDb(name) {
  const c = new pg.Client({ connectionString: 'postgres://127.0.0.1:5432/postgres' });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await c.end();
}

async function stopAll() {
  for (const srv of servers) await srv.close().catch(() => undefined);
  for (const { child } of children.reverse())
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await sleep(1500);
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (bopStarted) devStack('stop');
  await dropDb(BOP_DB).catch(() => undefined);
  await dropDb(AIO_DB).catch(() => undefined);
  await deleteRedisPrefix('redis://127.0.0.1:6379/5', BOP_ENV.REDIS_PREFIX).catch(() => 0);
  await deleteRedisPrefix('redis://127.0.0.1:6379/6', `aio_test_smoke_${ID}`).catch(() => 0);
}

async function main() {
  const pidDir = join(BOP_ROOT, '.dev');
  for (const n of ['api', 'worker', 'scheduler', 'realtime']) {
    const f = join(pidDir, `${n}.pid`);
    if (existsSync(f)) {
      const pid = Number(readFileSync(f, 'utf8'));
      let alive;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive)
        throw new Error(
          `project 05 dev stack (${n}, pid ${pid}) is already running from ${pidDir}; stop it first (scripts/dev-stack.sh stop)`,
        );
    }
  }
  for (const [name, port] of Object.entries(PORTS)) {
    const busy = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']).stdout.length > 0;
    if (busy) throw new Error(`port ${port} (${name}) is already in use`);
  }
  if (!existsSync(join(ROOT, 'apps/agent/dist/main.js')) || !existsSync(join(ROOT, 'apps/console/dist/index.html')))
    throw new Error('build first: pnpm build');

  console.log(
    'smoke: starting project 05 with its own scripts/dev-stack.sh (migrate + demo seed + api, worker, scheduler, realtime)',
  );
  bopStarted = true;
  const started = devStack('start');
  ok(started.status === 0, `project 05 dev-stack.sh start on ${API} (throwaway database ${BOP_DB})`);
  start('ops-mcp', process.execPath, [join(BOP_ROOT, 'apps/ops-mcp/dist/main.js'), '--http'], {
    env: { ...BOP_ENV, BOP_API_URL: API, MCP_PORT: String(PORTS.mcp) },
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORTS.mcp}/health`)).ok, 'ops-mcp');
  ok(true, `project 05 ops-mcp (Streamable HTTP) on :${PORTS.mcp}`);

  console.log('smoke: starting the AI operator');
  start('agent', process.execPath, ['--enable-source-maps', join(ROOT, 'apps/agent/dist/main.js')], {
    env: {
      ...process.env,
      AGENT_PORT: String(PORTS.agent),
      AGENT_PUBLIC_URL: AGENT,
      CONSOLE_URL: CONSOLE,
      CORS_ORIGINS: CONSOLE,
      DATABASE_URL: `postgres://127.0.0.1:5432/${AIO_DB}`,
      REDIS_URL: 'redis://127.0.0.1:6379/6',
      REDIS_PREFIX: `aio_test_smoke_${ID}`,
      BOP_API_URL: API,
      BOP_MCP_URL: `http://127.0.0.1:${PORTS.mcp}/mcp`,
      BOP_WEBHOOK_SECRET: SECRET,
      OPERATOR_TOKEN,
      LLM_PROVIDER: 'fake',
      LOG_LEVEL: 'warn',
      SWEEP_INTERVAL_MS: '1000',
    },
  });
  const consoleDir = join(LOG_DIR, 'console');
  cpSync(join(ROOT, 'apps/console/dist'), consoleDir, { recursive: true });
  writeFileSync(join(consoleDir, 'config.json'), JSON.stringify({ agentUrl: AGENT }));
  servers.push(await serveStatic(consoleDir, PORTS.console, { corsPrefixes: ['/embed/'], noStore: ['/config.json'] }));
  const health = await waitFor(async () => http(AGENT, 'GET', '/health'), 'agent health');
  ok(
    health.status === 'ok' && health.db === 'ok' && health.redis === 'ok',
    'agent health: postgres + redis ok, fake LLM provider',
  );
  await waitFor(async () => (await fetch(`${CONSOLE}/config.json`)).ok, 'console');
  const html = await (await fetch(`${CONSOLE}/`)).text();
  ok(html.includes('id="root"'), 'console SPA (production build) is served');
  const appConfig = await http(API, 'GET', '/v1/app-config');
  ok(
    appConfig.operator?.scriptUrl === `${CONSOLE}/embed/ask-operator.js` && appConfig.operator?.agentUrl === AGENT,
    'project 05 /v1/app-config points its SPA at the operator web component (OPERATOR_EMBED_URL)',
  );
  const embed = await fetch(appConfig.operator.scriptUrl, { headers: { origin: 'http://127.0.0.1:4511' } });
  const embedJs = await embed.text();
  ok(
    embed.ok && embed.headers.get('access-control-allow-origin') === '*' && embedJs.includes('ask-operator'),
    'the "Ask operator" module is served cross-origin for the project 05 SPA',
  );

  console.log('smoke: login and policy');
  const login = await http(AGENT, 'POST', '/auth/login', { body: { email: 'manager@demo.dev', password: 'demo1234' } });
  const token = login.token;
  ok(login.me.role === 'manager', 'login to the operator with project 05 credentials (manager@demo.dev)');
  const tools = await http(AGENT, 'GET', '/tools', { token });
  ok(
    tools.visible.length === 15 && tools.hidden.some((h) => h.tool === 'void_invoice' && h.ruleId === 'no-void'),
    'ops-mcp tools loaded; void_invoice hidden by rule no-void',
  );

  console.log('smoke: goal → approval batch');
  const goal = 'Send payment reminders for all invoices that are more than 30 days overdue.';
  const res = await fetch(`${AGENT}/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ goal }),
  });
  const events = parseSseChunk(await res.text()).events.map((e) => JSON.parse(e.data));
  const runId = events[0].runId;
  const proposals = events.filter((e) => e.type === 'proposal').map((e) => e.proposal);
  ok(
    events.some((e) => e.type === 'tool_call') && events.some((e) => e.type === 'text'),
    `run ${runId.slice(0, 8)} streamed text and tool calls over SSE`,
  );
  ok(
    events.some((e) => e.type === 'status' && e.status === 'awaiting_approval'),
    'run paused in awaiting_approval',
  );
  ok(
    proposals.length >= 3 && proposals.every((p) => p.tool === 'send_email' && p.preview?.kind === 'email'),
    `${proposals.length} send_email proposals with e-mail previews`,
  );
  const manager = (await new BopApi(API).login('manager@demo.dev', 'demo1234')).accessToken;
  const inbox = await waitFor(async () => {
    const list = await http(API, 'GET', '/v1/approvals?status=pending', { token: manager });
    return list.find((a) => a.source === 'agent' && a.sourceRef?.runId === runId);
  }, 'approval in the project 05 inbox');
  ok(
    inbox.title.includes('need approval'),
    'approval card mirrored into the project 05 Approvals inbox (source: agent)',
  );

  const subjectEdit = `Payment reminder (edited ${ID})`;
  const [edited, rejected, ...rest] = proposals;
  await http(AGENT, 'POST', '/proposals/decide', {
    token,
    body: {
      decisions: [
        { id: edited.id, decision: 'approve', expectedHash: edited.argsHash, editedArgs: { subject: subjectEdit } },
        { id: rejected.id, decision: 'reject' },
        ...rest.map((p) => ({ id: p.id, decision: 'approve', expectedHash: p.argsHash })),
      ],
    },
  });
  const done = await waitFor(async () => {
    const r = await http(AGENT, 'GET', `/runs/${runId}`, { token });
    return r.status === 'completed' ? r : null;
  }, 'run completed after approval');
  ok(
    done.proposals.filter((p) => p.status === 'executed').length === proposals.length - 1,
    `${proposals.length - 1} approved actions executed, 1 rejected`,
  );
  ok(
    done.proposals.find((p) => p.id === edited.id).edited === true,
    'the edited proposal is marked edited_by_human with a new hash',
  );

  const expected = [
    { to: edited.args.to[0], subject: subjectEdit },
    ...rest.map((p) => ({ to: p.args.to[0], subject: p.args.subject })),
  ];
  const mail = new Mailpit();
  const recent = (list) => list.filter((x) => Date.parse(x.Created) >= Number(ID) - 2000);
  const delivered = await waitFor(async () => {
    const found = [];
    for (const e of expected) found.push(...recent(await mail.search(`to:"${e.to}" subject:"${e.subject}"`)));
    return found.length >= expected.length ? found : null;
  }, 'reminders in Mailpit');
  ok(
    delivered.length === expected.length,
    `${delivered.length} approved reminders delivered to Mailpit with the approved subjects`,
  );
  ok(
    delivered.some((m) => m.Subject === subjectEdit),
    'the human-edited subject is what was sent',
  );
  const rejectedMail = recent(await mail.search(`to:"${rejected.args.to[0]}" subject:"${rejected.args.subject}"`));
  ok(rejectedMail.length === 0, 'nothing was sent for the rejected proposal');
  const external = await http(API, 'GET', `/v1/approvals/${inbox.id}`, { token: manager });
  ok(external.status === 'approved', 'the project 05 inbox card was closed by the console decision');
  const invoiceId = done.steps.find((s) => s.tool === 'list_invoices').result.payload.result.items[0].id;
  const emails = await http(API, 'GET', `/v1/records/invoice/${invoiceId}/emails`, { token: manager });
  ok(
    emails.some((e) => e.actorType === 'agent' && ['queued', 'sending', 'sent'].includes(e.status)),
    'project 05 records the e-mail on the invoice with actor agent',
  );

  console.log('smoke: forbidden action');
  const voidRun = await http(AGENT, 'POST', '/runs', {
    token,
    body: { goal: 'Void invoice INV-2026-0003.', wait: true },
  });
  ok(voidRun.status === 'completed' && voidRun.summary.includes('no-void'), 'void refused with the rule id no-void');
  const inv = await http(API, 'GET', '/v1/invoices?limit=100', { token: manager });
  ok(inv.items.find((i) => i.number === 'INV-2026-0003')?.status !== 'void', 'INV-2026-0003 is not void in project 05');

  console.log('smoke: project 05 workflow ai_step → operator');
  const ownerAccess = await new BopApi(API).login('demo@demo.dev', 'demo1234');
  const managerAccess = await new BopApi(API).login('manager@demo.dev', 'demo1234');
  const service = await new BopApi(API).createApiToken(managerAccess.accessToken, {
    name: `AI operator workflow steps (smoke ${ID})`,
    scopes: managerAccess.me.scopes,
    actorType: 'agent',
  });
  await http(AGENT, 'PUT', '/settings', { token, body: { serviceToken: service.token } });
  const definition = {
    name: `Classify inbound (smoke ${ID})`,
    trigger: { type: 'manual' },
    nodes: [
      {
        id: 'ai',
        type: 'ai_step',
        config: {
          task: 'classify',
          input: 'Hello, we would like to upgrade to the annual plan.',
          labels: ['refund', 'upgrade'],
        },
      },
      { id: 'fallback', type: 'create_task', config: { title: `Operator failed (smoke ${ID})` } },
    ],
    edges: [
      { from: '$trigger', to: 'ai' },
      { from: 'ai', to: 'fallback', label: 'error' },
    ],
  };
  const owner = ownerAccess.accessToken;
  const wf = await http(API, 'POST', '/v1/workflows', { token: owner, body: { name: definition.name, definition } });
  await http(API, 'PUT', `/v1/workflows/${wf.id}/draft`, { token: owner, body: { definition } });
  await http(API, 'POST', `/v1/workflows/${wf.id}/publish`, { token: owner, body: {} });
  const wfRun = await http(API, 'POST', `/v1/workflows/${wf.id}/runs`, { token: owner, body: {} });
  const wfDone = await waitFor(async () => {
    const d = await http(API, 'GET', `/v1/workflow-runs/${wfRun.id}`, { token: owner });
    return ['succeeded', 'failed'].includes(d.status) ? d : null;
  }, 'project 05 workflow run with ai_step');
  const aiStep = wfDone.steps.find((st) => st.nodeId === 'ai');
  ok(
    wfDone.status === 'succeeded' && aiStep?.output?.label === 'upgrade' && aiStep?.output?.provider === 'operator',
    'project 05 ai_step called the operator (OPERATOR_URL + OPERATOR_TOKEN) and got label "upgrade"',
  );
  const stepRuns = await http(AGENT, 'GET', '/runs?limit=20', { token });
  const stepRun = stepRuns.items.find((r) => r.context?.workflow?.runId === wfRun.id);
  ok(
    stepRun?.status === 'completed' && stepRun.context.source === 'workflow' && stepRun.budget.maxSteps === 4,
    'the step ran as a bounded, read-only agent run linked to the workflow run',
  );

  const metrics = await (await fetch(`${AGENT}/metrics`)).text();
  ok(
    /aio_runs_finished_total\{status="completed"/.test(metrics) && metrics.includes('aio_proposals_total'),
    'Prometheus metrics exported',
  );
}

let code = 0;
try {
  await main();
  console.log(`smoke: PASSED (${checks} checks, logs in ${LOG_DIR})`);
} catch (error) {
  code = 1;
  console.error(`smoke: FAILED after ${checks} checks: ${error.message}`);
  console.error(`logs in ${LOG_DIR}`);
} finally {
  await stopAll();
}
process.exit(code);
