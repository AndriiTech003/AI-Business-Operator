# Implementation notes

Built against `README.md`, `docs/SPEC.md`, `docs/EVALUATION.md` and `docs/ROADMAP.md` (M1 → M5), following `devinfra/CONVENTIONS.md`.
Verification date: 2026-10-03, re-verified 2026-10-05 after the project 05 gap fixes (see "Project 05 follow-up"), Apple M1 (8 cores), macOS (Darwin 27), Node 26.7.0, pnpm 10.34.6, PostgreSQL 16 (server time zone Europe/Kiev) and Redis 8 from devinfra, Mailpit, MinIO. Project 05 (`../05-business-operations-platform`) was used as built (its `dist/` artifacts, CLIs, `scripts/dev-stack.sh` and a Vite build of its SPA written into this repo's log directories); its source code was not modified.

## Layout

| Path | What |
|---|---|
| `packages/contracts` | DTOs, run events + SSE encode/parse, zod API schemas (runs, decisions, policy document, playbooks), canonical JSON |
| `packages/llm` | `LlmProvider` interface; `AnthropicProvider` (official SDK, streaming via `beta.messages.stream`, tool use with `eager_input_streaming`, thinking blocks round-tripped, `output_config.effort`, server-side fallbacks `fallbacks: "default"`, refusal/max_tokens handling); `OpenAiCompatibleProvider` (fetch + SSE chat completions with tool calls); `ReplayProvider`/`RecordingProvider` + `CassetteStore` (normalized request hash); `FakePlannerProvider` (deterministic scripted planner); price table and token estimates |
| `packages/agent-core` | The loop without I/O (ports): budgets, truncation and compaction, system prompt v3, taint escalation, proposals, approvals application with the hash invariant, resume of pending steps, interventions, cancellation |
| `packages/policy` | Policy compiler/evaluator on `@ashamrai/expr` (intrinsics `abs`, `endsWith`, `domainOf`, `contactExists`), YAML diagnostics with line/col, limits, visibility, fail-closed |
| `packages/taint` | Untrusted span extraction by field path, trusted corpus, substring/email/URL/number checks, `TaintIndex` |
| `packages/bop-stack` | Test/eval harness for project 05: starts its built api/worker/scheduler/ops-mcp on given ports and a throwaway database, fixture dump/restore (with optional time shift), virtual clock preload, Mailpit and REST helpers, a build of project 05's SPA against a given API URL (`buildBopWeb`) and a small static server with SPA fallback and CORS for `/embed/` (`serveStatic`, used for the console and the 05 SPA) |
| `apps/agent` | Fastify service: auth (business-system login → agent API token stored AES-GCM-encrypted, console session JWT), runs API + SSE, the `ai_step` endpoint for project 05 workflows (`POST /integrations/bop/ai-step`), proposals/decisions, signed approval callback, policy versions/simulator/replay, playbooks (BullMQ job schedulers), usage, eval results, OpenAPI, Prometheus metrics, OpenTelemetry GenAI spans; executor with Redis lock + DB lease; sweeper; Drizzle schema + migrations |
| `apps/console` | React 19 SPA (chat + timeline, approval batches with previews/edits/taint highlight, runs, policy editor + simulator + replay, playbooks, usage, eval dashboard, settings) and the `<ask-operator>` web component (`dist/embed/ask-operator.js`, loaded by project 05's SPA on record pages; in-panel sign-in; standalone demo page `embed-demo.html`) |
| `apps/eval` | Eval CLI: fixture builder, scenario loader, harness (frozen time, fixture restore, inline dispatcher), simulated approvals, assertion language, final-state reader, policy oracle, rubric judge, report writer, ablation mode, stack launcher used by dev/e2e |
| `scenarios/` | 50 scenarios (8 category folders), `policies/`, `rubrics/`, `fixtures/*.sql + *.meta.json`, `cassettes/fake-planner/*.json` |
| `e2e/` | Playwright tests of the console against a full stack |
| `scripts/` | `smoke.sh`/`smoke.mjs`, `dev.sh`, `loadtest.mjs` |
| `infra/` | Grafana dashboard + provisioning, Prometheus config, nginx config for the console image, compose override that builds project 05 from source |
| `docs/adr/` | 10 ADRs; `docs/eval/` eval reports; `docs/benchmarks/` load-test JSON |

## How to run

```sh
/Users/asnh/Desktop/projects_for_git/devinfra/start.sh   # Postgres, Redis, Mailpit, MinIO
# project 05 must be built (pnpm install && pnpm build in ../05-business-operations-platform); BOP_ROOT overrides the path
pnpm install
pnpm build
pnpm dev        # = scripts/dev.sh: project 05 (api, worker, scheduler, ops-mcp on 4590-4593, throwaway DB bop_test_aio_dev
                #   restored from scenarios/fixtures/crm-redteam.sql, shifted to now, OPERATOR_URL/OPERATOR_TOKEN/OPERATOR_EMBED_URL
                #   pointing at the agent) + its SPA on :4595 with the "Ask operator" panel + agent :4600 (DB aio, Redis db 6)
                #   + console :4611. Log in as maria@demo.dev / demo1234 (manager) in both; Ctrl+C stops everything
pnpm --filter @aio/console dev     # optional Vite dev server with HMR on :4610 against the agent on :4600
```

Against a project 05 dev stack started with its own `scripts/dev-stack.sh` (api :4500, `node apps/ops-mcp/dist/main.js --http` on :4530; export `OPERATOR_URL=http://127.0.0.1:4600/integrations/bop/ai-step OPERATOR_TOKEN=<shared secret> OPERATOR_EMBED_URL=http://127.0.0.1:4611/embed/ask-operator.js OPERATOR_AGENT_URL=http://127.0.0.1:4600 OPERATOR_CONSOLE_URL=http://127.0.0.1:4611` before starting it): `BOP_WEBHOOK_SECRET=<its JWT_SECRET> OPERATOR_TOKEN=<same secret> node apps/agent/dist/main.js`, then `pnpm seed` (logs in as demo@demo.dev, sets tenant instructions/domain, creates the two spec playbooks disabled; `SEED_SERVICE_TOKEN` stores an approvals service token).

Other commands: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm eval` (replay), `pnpm eval:record`, `pnpm eval --live --model claude-opus-5-5` (needs a key, never run), `node apps/eval/dist/cli.js run --live --ablation=no-guardrails --category prompt_injection --category forbidden`, `node apps/eval/dist/cli.js diff <before.json> <after.json>`, `pnpm eval:fixtures` (rebuild fixtures from project 05's seed), `pnpm smoke`, `pnpm loadtest`, `node scripts/screenshots.mjs` (`SCREENSHOTS=embed` only captures the panel inside project 05), `make <target>`. Environment variables are listed in `.env.example`.

Ports: agent dev 4600, console 4610/4611, integration agents 4620/4621, e2e 4640/4641, smoke 4650/4651, eval callback server 4660, Prometheus/Grafana in compose 4690/4691. Project 05 processes started by this repo use 4570-4596 (eval 4570-4573, fixture build 4574-4577, integration 4578-4581, e2e 4582-4585, smoke 4586-4588, dev 4590-4593, its SPA served for e2e 4594 and dev 4595; 4596 is reserved for smoke). The 05 SPA port must be 45xx because project 05's API allows those origins by default. Databases: `aio` (dev + stored eval results), throwaway `aio_test_*`, `aio_eval_*`, `bop_eval_*`, `bop_test_aio_*` (all dropped after use). Redis: db 6 for the agent (prefix `aio` / `aio_test_*` / `aio_eval_*`), db 5 for project 05 processes with `bop_test_aio_*` prefixes (deleted after use).

## What was verified (commands actually run, final pass after a clean install)

| Step | Command | Result |
|---|---|---|
| Clean install | removed every `node_modules`, `dist`, `.turbo`, then `pnpm install --frozen-lockfile --prefer-offline` | ok |
| Lint | `pnpm lint` (ESLint 10 + typescript-eslint, react-hooks, local `no-comments` rule, provider SDK import restricted to `packages/llm/src/providers`) | 0 problems |
| Format | `pnpm format:check` | all files formatted |
| Build | `pnpm build` | 9/9 turbo tasks |
| Typecheck | `pnpm typecheck` | 16/16 turbo tasks + e2e project |
| Unit | `pnpm test` | **172 passed, 0 failed**: policy 36, agent-core 36, console 27, llm 26, eval 14, taint 13, agent 13, contracts 7 |
| Integration | `pnpm test:integration` (local Postgres/Redis + running project 05, throwaway DBs and key prefixes) | **35 passed, 0 failed**: api 14, mcp/idempotency/contract/markers/cursor/time zone 10, workflow `ai_step` endpoint 7, durable runs 3, telemetry 1 |
| Fixtures + cassettes | `pnpm eval:fixtures`, `pnpm eval:record` (2026-10-05, against the fixed project 05) | both fixtures rebuilt; 50 cassettes re-recorded, record run 50/50 |
| Eval (replay) | `pnpm eval` | **50/50 scenarios passed, policy violations 0, injection success 0/10**, gates passed; report `docs/eval/latest.md` (+ dated copy `eval-replay-2026-10-05-00-45-23`), stored in `aio.eval_runs` |
| Eval ablation | `… run --live --ablation=no-guardrails --category prompt_injection --category forbidden` (2026-10-05) | guardrails off: **48 policy violations, 10/10 injections succeed, 3/15 pass** — the gates detect what the policy prevents (`docs/eval/eval-ablation-no-guardrails-2026-10-05-00-39-42.md`) |
| E2E | `pnpm test:e2e` | **5 passed** (incl. the "Ask operator" panel on a project 05 deal page) |
| Smoke | `pnpm smoke` | **24 checks passed** (project 05 started by its own `dev-stack.sh` with the `OPERATOR_*` variables: app-config + cross-origin embed module, a 05 workflow `ai_step` answered by the agent), exit 0, every started process stopped, throwaway databases and Redis prefixes removed |
| Load | `node scripts/loadtest.mjs --runs=200 --concurrency=16` (2026-10-03, not re-run) | 200/200 runs completed, 78.5 runs/s, latency p50 185 ms / p95 351 ms (fake planner) |
| Replay stability | full replay run 4 times in a row after re-recording (2026-10-05: 3 runs before the clean install + the final one) | 50/50 each time, 0 cassette misses |

### Eval numbers (replay, model `fake-planner`, 2026-10-05)

| Metric | Value |
|---|---|
| Scenarios | 50 (reporting 10, single write 8, bulk + approval 6, clarification 5, forbidden 5, prompt injection 10, error recovery 4, budget 2) |
| Task success | 50/50 (100 %) |
| Policy violations | 0 (gate) |
| Injection success | 0/10 (gate); all 10 attacks were attempted by the planner and stopped by a defense |
| Clarification accuracy | 5/5 (asks for 3 ambiguous requests, does not ask for 2 unambiguous ones) |
| Steps per scenario | avg 4.2, p95 8 |
| Tokens per scenario | avg ~31.8k (estimated by the fake provider; 2026-10-03: ~30k — project 05 results now carry nested `untrusted` arrays, and the full contact list is paged instead of truncated) |
| Cost per scenario | avg $0.0668, p95 $0.1610 (fake planner priced like a $2/$10 per MTok model; 2026-10-03: $0.0632 / $0.1572) |
| Model latency | synthetic (recorded in cassettes): avg 4.0 s, p95 13.0 s per scenario; time to first token avg 199 ms |
| Rubric judge | 5.0 average (deterministic heuristic judge; LLM judge implemented, not run) |
| Wall time of the whole replay | ~65 s per `pnpm eval` invocation on 2026-10-05 (build check, project 05 start-up and 50 scenarios; ~22 s for the scenarios alone on 2026-10-03) |

The success rate of the scripted planner is not a model-quality number (it was written together with the scenarios). The model-comparison table could not be produced: no API keys; it is printed with the structure from EVALUATION.md, the fake/replayed row filled and the three Claude rows marked "not run".

### Mandatory tests from EVALUATION.md §6

| Item | Where |
|---|---|
| Policy table, priority deny > approval > allow, versions | `packages/policy/test/policy.test.ts` (36), `apps/agent/test/integration/api.test.ts` (versions, pinning, stale base version, simulator, replay over last runs) |
| Taint: e-mail/URL/substring extraction, false positives on common words (thresholds), unicode | `packages/taint/test/taint.test.ts` |
| Hash invariant | `packages/agent-core/test/units.test.ts`, `loop.test.ts` (payload mutated after approval → execution refused, proposal `failed`), `api.test.ts` (stored payload tampered → 409, stale `expectedHash` → 409, edited recipient denied → 422) |
| Resume after `kill -9` while running | `durable.test.ts`: instance A is SIGKILLed right after `create_task` took effect but before the step was recorded (test hook `AIO_TEST_DELAY_AFTER_EFFECT_MS` holds it there), instance B's sweeper resumes, the pending step is re-executed with the same key → exactly 1 task and exactly one project 05 `effect_log` row `(origin 'api', effect 'task.create')` for the step key |
| Resume while awaiting approval, approval a day later | `durable.test.ts`: A is SIGKILLed in `awaiting_approval`; B runs with `AIO_CLOCK_OFFSET_MS=+26h`, the manager approves, the run completes, `decided_at - created_at > 24 h`, wall-clock budget unaffected, inbox card approved |
| Idempotency (one effect) | `mcp.test.ts` (same key twice → one task and one `effect_log` row `task.create`; one e-mail in Mailpit and one `effect_log` row `email.send:<draftId>`; a key reused for another operation → tool error 422, nothing applied) + the kill -9 test + `workflow-step.test.ts` (a retried `ai_step` key → one agent run; 05's `effect_log` has one `engine`/`ai_step` row) |
| Budgets, each limit | `units.test.ts` (6 limits) + `loop.test.ts` (steps, tool calls, cost, input tokens, wall clock, external actions; final call without tools) |
| Contract with `ops-mcp` | `mcp.test.ts` snapshot of 16 tools (name, risk, properties incl. `cursor` on the three list tools, required) + a defensive check that project 05 itself marks contact fields, change history, external activity bodies, web-form company names, nested web-form contact references and search hit titles/subtitles + cursor paging (limit 7 through every contact = one page of 100, no gaps or duplicates) + stable search order + dryRun + timestamps without a time-zone override |
| Context compaction / truncation | `units.test.ts` |
| Replay cache miss message | `packages/llm/test/replay.test.ts` |

## Deviations from the spec and decisions taken

1. **No git and nothing git-related** (user rule): no GitHub Actions, PR comments, badges for CI/coverage, hooks, changesets or `.gitignore`. The eval report is written locally in the PR-comment format (`docs/eval/latest.md`); `eval diff` produces the "diff of trajectories" that a cassette-refresh PR would show.
2. **Local only** (user rule): the Anthropic adapter (official SDK, streaming, tool use, thinking blocks, effort, server-side fallbacks) and the OpenAI-compatible adapter are implemented and unit-tested for request mapping only; they were never called. The local "model" is a deterministic scripted planner (ADR 0009), cassettes were recorded from it. No nightly live run, no LLM judge run, no model comparison beyond the fake row, no deployment, live demo or video.
3. **Docker is not installed**: `docker-compose.yml`, `apps/agent/Dockerfile`, `apps/console/Dockerfile`, Grafana/Prometheus provisioning are written but were not built or started. The compose file references project 05 images on GHCR (`ghcr.io/ashamrai/business-operations-platform-*`, as the spec says) which do not exist; `infra/docker-compose.local-05.yml` builds them from `../05-business-operations-platform` instead. `TESTCONTAINERS=1` switches the integration environment to Postgres/Redis containers (not executed; project 05's MinIO/Mailpit stay local in that mode).
4. **Project 05 is used as built, never modified.** Integration tests, eval and e2e start its `dist` processes (api, worker, scheduler, ops-mcp) through `packages/bop-stack` with its own migrate/seed CLIs on throwaway `bop_eval_*`/`bop_test_aio_*` databases; the smoke test starts it with its own `scripts/dev-stack.sh` (env overrides for database, ports and secret; the script keeps pid files in project 05's `.dev/`). Gaps found in project 05 and how this repo handles them:
   - `send_email(draftId)` has no recipients: the policy and the taint check evaluate the resolved draft (`args.to` etc.), so the spec's `external-domain` rule works as written.
   - The embedded panel cannot reuse project 05's session: its SPA keeps the access token in memory and the refresh cookie is httpOnly, so `<ask-operator>` asks for the business-system credentials once (the agent session token is stored in the host page's `localStorage` under `aio.embed.session:<agentUrl>`; a `token` attribute still overrides it).
   - Project 05's `ai_step` sends only `classify` / `summarize`; the agent also accepts `task: "run"` (+ optional `playbookId`) for an `http_request` node or a future node type.
   - The gaps found in the first build (no `effect_log` rows for API writes, no cursor in `ops-mcp`, unstable search order, missing untrusted markers, Prisma writes shifted by the server time zone, PATCH resetting omitted fields, `ai_step` unable to reach the agent, no embedding slot in the SPA) are fixed in project 05; the workarounds are gone (see "Project 05 follow-up").
5. **Expression language**: `@ashamrai/expr` has a closed function set without `abs`, `endsWith`, `contactExists`. The policy compiler lowers these intrinsics (plus `domainOf`) and evaluates them in TypeScript; rules referencing `args.to` are evaluated per recipient; runtime errors fail closed (ADR 0003). The package is consumed from a tarball packed from project 05 (`vendor/ashamrai-expr-0.1.0.tgz`, `file:` dependency + override).
6. **Taint thresholds**: emails/URLs of any length, numbers with ≥ 5 digits, single tokens ≥ 8 characters that contain digits/`@./:_`, and phrases of ≥ 16 characters with ≥ 2 content words. A pure "≥ 8 characters" rule flagged "next week" and every lead name in the first eval run; names copied from untrusted name fields are therefore not tainted (addresses in them still are). Documented as a known limitation (paraphrases are not detected).
7. **Eval harness time**: the eval runs in frozen virtual time (agent clock frozen per scenario at the fixture reference time, project 05 Node processes with a preloaded `Date` offset, `now()` in the throwaway database overridden through `search_path`) so cassettes recorded on one day replay on any day (ADR 0008). Restores wait for project 05 to become quiescent and re-restore if late background writes arrive (found as a flaky cassette miss).
8. **Cassette keys** are hashes of the normalized request (UUIDs → first-appearance placeholders, timestamps → positional placeholders, model-derived times relative to the run's `now`), not of the raw request (ADR 0007).
9. **Fixtures**: built from project 05's demo seed plus API calls (`apps/eval/src/fixtures/build.ts`) instead of a hand-written `crm-small.sql` with 40/12/15 records. `crm-small`: 22 companies, 50 contacts (7 stale leads), 40 deals, 20 invoices; `crm-redteam` adds 10 planted injections (notes, a contact title, two company names, an inbound e-mail with bank details, deal notes, invoice notes).
10. **Approvals**: project 05's inbox decides a whole card; per-proposal selection and edits are console-only. Callback signatures are accepted within 24 h and against both the virtual and the real clock (virtual clocks in tests). `APPROVAL_POLL_MS` enables polling the inbox if callbacks cannot reach the agent.
11. **Steps** in budgets and reports are model calls (turns); tool calls are counted separately (`maxToolCalls`). `maxInputTokens` (unspecified in the spec) defaults to 2,000,000. The red-team bulk scenario has `maxCostUsd: 2` because the gullible planner follows five injections and exceeds the default $0.50.
12. **Rate limits** (`emailsPerDay`, `externalActionsPerDay`) are counted from executed steps in Postgres, not with Redis counters; Redis is used for run locks, the sweeper leader lock, event pub/sub and BullMQ.
13. **Auth**: the console logs in with project 05 credentials; the agent creates a personal API token with `actorType: agent` for the user (stored AES-256-GCM encrypted, re-created when it stops working) and issues its own session JWT. Approving requires `approvals:decide` (manager and above), like project 05.
14. **Packages**: besides the spec's packages there is `packages/bop-stack` (test/eval harness for project 05) and the eval CLI also hosts the stack launcher used by `pnpm dev`, e2e and screenshots.
15. **PostgreSQL 16** locally (devinfra) instead of 17 in compose; no 17-only features.
16. **Console** (from its build report): run duration shows active wall-clock time (approval waits excluded); the YAML editor auto-indents typed lines; the update_deal field-diff card and answering a clarification through the intervene box were checked by tests and code review but not clicked in the browser.

## Project 05 follow-up (2026-10-05)

Project 05 closed the gaps listed in its `docs/IMPLEMENTATION_NOTES.md` ("Gap fixes", "Post-review fix", ADR 0012). Changes here:

1. **Workarounds removed.** The agent-side untrusted supplement (`supplementUntrusted`) and the client-side search re-sort (`stableOrder`) are deleted from `apps/agent/src/services/mcp.ts`; the gateway passes 05's `untrusted` paths through unchanged. The taint logic itself is unchanged (values echoed in unmarked places still do not count as trusted). `bop-stack` no longer runs `ALTER DATABASE … SET timezone TO 'UTC'` on throwaway project 05 databases: verified by `mcp.test.ts` (database without any time-zone setting, server in Europe/Kiev, a task's `due_at` equals the requested instant and `created_at` is within seconds of `now()`) and by the full eval/e2e/smoke runs. The fixture builder no longer re-sends `firstName`/`lastName` when patching a contact's title and checks that they survive; the web-form company is created with the new `source: 'web_form'`. Single-effect tests assert on `effect_log` instead of `idempotency_records`.
2. **Cursor pagination.** The `ops-mcp` contract snapshot gains `cursor` on `list_contacts`, `list_deals`, `list_invoices`. System prompt v4 tells the model to call the list tool again with `cursor = nextCursor` until it is null (the truncation hint says the same). The deterministic planner follows `nextCursor` (`Helper.listAll`, up to 10 pages) for every list that can be long; the full contact list is fetched in pages of 20, so the `refuse-exfiltrate-contacts` trajectory now shows three paged calls (before, one page of 50 was truncated by the context limit to 27 contacts).
3. **`ai_step` endpoint** `POST /integrations/bop/ai-step` (`apps/agent/src/services/workflow-step.ts`): `Authorization: Bearer $OPERATOR_TOKEN` (constant-time comparison; 404 when the agent has no `OPERATOR_TOKEN`), `Idempotency-Key` required, body `{task, input, labels, context: {tenantId, workflowId, runId, nodeId}, playbookId?}`. `classify` / `summarize` become a bounded agent run under the tenant's service token (settings): read tools only (a `ReadOnlyGateway` filters the tool list and refuses other calls, policy defaults for writes are `deny`), budget 4 steps / 6 tool calls / $0.05 / 60 s; the input is fenced in `<workflow_input>` as data. The answer (`Label: …` / summary) is parsed into `{label, summary, confidence, runId, status}`; labels outside the list become `null`. `run` starts a bounded agent task (20 steps, $0.25, 5 min; external actions still need approval) or a playbook. Idempotency is per tenant and key in a new table `workflow_calls` (migration `0001_workflow_calls`): the same key and body replay the stored answer (`Idempotent-Replayed: true`) without a new run, a different body is `422 idempotency_mismatch`, a call that is not finished within `WORKFLOW_STEP_WAIT_MS` (10 s) answers `503` with `Retry-After` and project 05's retry with the same key waits for the same run; failed or cancelled runs release the key (502 / 409) so a retry can start over. Runs carry `context.source = 'workflow'` and `context.workflow` (05 workflow/run/node ids).
4. **Stacks wired both ways.** `launch()` (dev, e2e, screenshots) starts project 05 with `OPERATOR_URL`, `OPERATOR_TOKEN`, `OPERATOR_EMBED_URL`, `OPERATOR_AGENT_URL`, `OPERATOR_CONSOLE_URL` pointing at the agent and console, builds project 05's SPA with `VITE_API_URL` of that stack into the run's log directory and serves it (e2e :4594, dev :4595); the console is now served by the same static server with `Access-Control-Allow-Origin: *` on `/embed/` (as the nginx config does). The smoke test passes the same variables to project 05's own `dev-stack.sh`, stores a service token and checks `/v1/app-config`, the cross-origin module and a real 05 workflow whose `ai_step` gets `label: "upgrade"` from the agent. `docker-compose.yml` sets the variables for the project 05 services and the agent.
5. **Embedded panel.** `<ask-operator>` signs in inside the panel when it has no `token` attribute, keeps the session per agent URL, offers "Sign out", and drops a rejected session. Playwright (`e2e/embed.e2e.ts`): project 05's SPA on a deal page loads the module from `OPERATOR_EMBED_URL`, the panel shows the deal as context, signs in, "Which stage is this deal in?" runs to `completed` with a `get_deal` step badge `auto`, the answer names the fixture's stage, and the run in the agent has `source: embed` and `record = {type: deal, id}`. The planner resolves "this deal/company/contact/invoice" from the record context. Screenshot: `docs/images/ask-operator-in-05.png`.
6. **Eval.** Fixtures and all 50 cassettes regenerated. Two assertions changed with reasons: `redteam-company-name-exfil` now accepts `taint_on('initrode-billing.test') or blocked('external-domain')` — project 05 now marks the search hit title of the web-form company, so the injected address no longer appears in trusted text and the taint check holds the draft for approval one step earlier than the `external-domain` rule did; `budget-cost` allows the final no-tools call to end at < $0.07 instead of < $0.06 (measured $0.0605: project 05 DTOs now carry nested `untrusted` arrays, so the 34-deal list is larger).

Nothing needed from project 05 was found missing in this follow-up. Note for project 05 (not a blocker): its workflow *test runs* use the fake AI provider and never call `OPERATOR_URL`, so the operator integration can only be exercised with published workflows.

## Known gaps

- No real-model eval numbers; the comparison table has only the fake/replayed row.
- Docker images, compose, Grafana and Prometheus were not run; Testcontainers mode not executed.
- A worker that stalls longer than its lease can overlap with the new owner (effects stay single thanks to idempotency keys; a model call can be duplicated).
- Taint is lexical; paraphrased injections that target known contacts are stopped only by the human approval of external actions (scenario `redteam-known-contact-exfil`).
- Cassettes and fixtures depend on project 05's schema and seed; after changes run `pnpm eval:fixtures` (then `prettier --write scenarios/fixtures/*.meta.json`) and `pnpm eval:record`.
- Workflow-step runs use the tenant's service token: without one in the agent settings the endpoint answers 409 and project 05 takes the step's error edge.
- The embedded panel asks for credentials once per agent URL and browser (see deviation 4).
