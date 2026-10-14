# AI Business Operator

An AI agent that does real work inside a business system (CRM, deals, invoices, tasks) through MCP tools — under a policy engine that lives outside the model, with human approval of exact payloads, prompt-injection defenses and a 50-scenario eval suite that checks the final state of the system.

![License: MIT](https://img.shields.io/badge/license-MIT-blue) · Node 22 · TypeScript strict · runs fully locally (no API keys needed)

![Approval batch with a taint warning](docs/images/approval-batch.png)

> "Find leads we haven't contacted in over 7 days and prepare follow-up emails."
>
> `list_contacts` → `get_contact` ×7 → `draft_email` ×7 → `send_email` ×7 **⏸ approval batch** → the manager unticks one, edits one, approves → exactly the approved payloads are sent → a call task is created for the one that was not sent.

## Why this project

Most "agents" are a chat loop with function calling: the model can call anything, trusts every string it reads, and the only safety net is "are you sure?". This project treats the model as an untrusted planner. Everything that has consequences — permissions, approvals, budgets, idempotency, auditability, protection against instructions hidden in customer data — is enforced by code around the model and proven by tests and an eval suite whose hard gates are _0 policy violations_ and _0 successful injections_.

It operates on the [Business Operations Platform](../05-business-operations-platform) (project 05) through its `ops-mcp` server, with the user's own API token, so the business system's permissions apply automatically.

## Highlights

- **Policy engine outside the model.** Versioned YAML policy per tenant: defaults by risk (`read`, `write_reversible`, `external`, `irreversible`), rules with conditions in the typed expression language of project 05 (`@ashamrai/expr`), limits per run and per day. Strictest decision wins (permission → limits → deny → approval → allow → default); every decision is stored with its rule id. Forbidden tools are not even shown to the model.
- **What you approve is exactly what runs.** Proposals store the payload and its SHA-256; the executor takes the payload from the proposal, never from the model, and refuses on a hash mismatch. Human edits create a new hash, are re-checked by the policy and are marked `edited`. Approval cards also appear in project 05's Approvals inbox and are decided there through a signed webhook.
- **Prompt-injection defense in depth.** Tool results are wrapped as untrusted data; fields written by outsiders are recorded; an argument that only appears in untrusted text (address, URL, IBAN, copied phrase) raises the action to approval with a warning that highlights the source fragment; deny rules (unknown recipients, voiding invoices) are the last line. A deliberately gullible planner follows every planted instruction in the red-team suite — and none succeeds.
- **Durable runs.** Transcript, steps and proposals live in Postgres; a Redis lock with lease + heartbeat guarantees one executor; a sweeper resumes runs whose lease expired. `kill -9` mid-tool-call → another instance re-executes the pending step with the same idempotency key → one effect in the business system. Approvals can wait for days.
- **Budgets and context control.** Steps, tool calls, input tokens, dollars, active wall-clock time and external actions; when one is exhausted the model gets one final call without tools to report what it finished. Large tool results are truncated with a paging hint; old results are compacted to summaries that keep record ids.
- **Eval that checks the system, not the text.** 50 YAML scenarios in 8 categories run against a live project 05 restored from SQL fixtures, with simulated human approvals, assertions on the final database state and on the trajectory, an independent policy oracle, and a rubric judge. Deterministic record/replay of model calls (cassettes keyed by a normalized request hash) makes the suite run in ~20 s offline.

## Architecture

```mermaid
flowchart LR
  subgraph Console["Console (React + TanStack Query)"]
    Chat[Chat + timeline]
    Appr[Approval batches]
    Pol[Policy editor + simulator]
    Eval[Eval dashboard]
    Embed["&lt;ask-operator&gt; web component"]
  end
  subgraph Agent["Agent service (Fastify)"]
    API[Runs API + SSE]
    Loop[agent-core loop<br/>budgets · compaction]
    Policy[policy<br/>@ashamrai/expr]
    Taint[taint]
    LLM[llm providers<br/>Anthropic · OpenAI-compatible<br/>replay · fake planner]
    Worker[BullMQ worker + sweeper]
  end
  PG[(Postgres<br/>runs · messages · steps<br/>proposals · policies)]
  R[(Redis<br/>locks · pub/sub · queues)]
  subgraph BOP["Project 05 · Business Operations Platform"]
    MCP[ops-mcp<br/>16 typed tools]
    BAPI[REST API]
    Inbox[Approvals inbox]
  end
  Console -->|HTTP / SSE| API
  API --> Loop
  Worker --> Loop
  Loop --> Policy
  Loop --> Taint
  Loop --> LLM
  Loop -->|MCP Streamable HTTP, user token| MCP
  MCP --> BAPI
  Loop -->|POST /approvals| Inbox
  Inbox -->|signed callback| API
  Loop --- PG
  API --- R
  Worker --- R
```

A run starts from `POST /runs` (SSE stream), is executed by a worker under a lease, calls the model with the tools the policy lets the user see, and passes every tool call through policy + taint checks: `allow` → executed with idempotency key `runId:step`; `deny` → the model gets `blocked by policy <rule>`; `require_approval` → a dry-run preview becomes a proposal. When the model ends its turn with proposals pending, the run waits (`awaiting_approval`), the batch appears in the console and in project 05's inbox, and a decision (console or inbox webhook) resumes the run on any instance.

## Tech stack

| Layer         | Technology                                                                                                                                                              | Why                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Agent service | Node 22, TypeScript, Fastify 5                                                                                                                                          | Small, fast, SSE-friendly                                                                  |
| Agent loop    | own `agent-core` (no framework)                                                                                                                                         | Budgets, approvals and resume are the point — see ADR 0001                                 |
| Tools         | MCP client (`@modelcontextprotocol/sdk`, Streamable HTTP) → project 05 `ops-mcp`                                                                                        | Same tools as Claude Desktop / IDEs, risk metadata                                         |
| Policy        | `@ashamrai/expr` (project 05's expression language, consumed as a packed tarball) + YAML                                                                                | One expression language across both projects                                               |
| LLM           | Anthropic Messages API (`@anthropic-ai/sdk`, streaming, tool use, server-side fallbacks), OpenAI-compatible chat completions, record/replay, deterministic fake planner | Provider is configuration                                                                  |
| Storage       | PostgreSQL 16/17 (Drizzle), Redis 8                                                                                                                                     | Durable state, locks, pub/sub, BullMQ                                                      |
| Background    | BullMQ                                                                                                                                                                  | Continuations after approval, scheduled playbooks (`upsertJobScheduler`, cron + time zone) |
| Console       | React 19, Vite 8, TanStack Query, CodeMirror 6                                                                                                                          | Policy editor with diagnostics, live timelines                                             |
| Quality       | Vitest, Playwright, Testcontainers switch, eval runner                                                                                                                  | Pyramid + system-level eval                                                                |
| Observability | OpenTelemetry (GenAI semantic conventions), Prometheus, Grafana dashboard                                                                                               | Cost, approvals and blocked actions as first-class metrics                                 |

## Screenshots

| Timeline with policy badges           | Forbidden action refused with the rule id |
| ------------------------------------- | ----------------------------------------- |
| ![Timeline](docs/images/timeline.png) | ![Refusal](docs/images/forbidden.png)     |
| **Policy editor and simulator**       | **Eval dashboard**                        |
| ![Policy](docs/images/policy.png)     | ![Eval](docs/images/eval-dashboard.png)   |

## Getting started

Requirements: Node 22+, pnpm 10, PostgreSQL 16+, Redis 8, Mailpit (for e-mails), and a built checkout of project 05 next to this one (`../05-business-operations-platform`, or set `BOP_ROOT`).

```sh
pnpm install
pnpm build
pnpm dev            # starts project 05 (fixture data) + agent on :4600 + console on :4611
# open http://127.0.0.1:4611  →  maria@demo.dev / demo1234
```

With Docker: `docker compose up --build` (agent, worker, console, project 05 images, Postgres, Redis, Mailpit, Prometheus on :4690, Grafana on :4691, Jaeger).

No API key is needed: the default provider is a deterministic planner. To use a real model set `LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=… LLM_MODEL=claude-opus-5-5` (or `LLM_PROVIDER=openai OPENAI_BASE_URL=… OPENAI_API_KEY=…`).

Project 05 integration (both directions are wired in `pnpm dev`, e2e and smoke):

- **"Ask operator" on project 05 record pages.** Start project 05 with `OPERATOR_EMBED_URL=http://127.0.0.1:4611/embed/ask-operator.js OPERATOR_AGENT_URL=http://127.0.0.1:4600 OPERATOR_CONSOLE_URL=http://127.0.0.1:4611`; its SPA reads `GET /v1/app-config` and renders the `<ask-operator>` web component in the header of company, contact, deal and invoice pages. The panel signs in with the business-system account (or takes a `token` attribute), starts a run with the record as context and streams the steps.
- **Workflow `ai_step` → operator.** With `OPERATOR_URL=http://127.0.0.1:4600/integrations/bop/ai-step` and the same `OPERATOR_TOKEN` on both sides, project 05's `ai_step` node calls the agent with the step's idempotency key. `classify` / `summarize` run as bounded, read-only agent runs (read tools only, 4 steps, $0.05); `task: "run"` (optionally with a `playbookId`) runs a bounded agent task under the normal policy. A retried key returns the first answer; a key reused for another request is `422`; a call that outlives `WORKFLOW_STEP_WAIT_MS` gets `503 + Retry-After` and the retry picks up the same run.

![Ask operator in project 05](docs/images/ask-operator-in-05.png)

Standalone embedding:

```html
<script type="module" src="http://127.0.0.1:4611/embed/ask-operator.js"></script>
<ask-operator
  agent-url="http://127.0.0.1:4600"
  record-type="deal"
  record-id="…"
  record-label="Acme – Pilot"
></ask-operator>
```

## Testing

| Level       | Command                                   | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `pnpm test`                               | Policy decision table (incl. deny > approval > allow, fail-closed, visibility, diagnostics with line/col), taint extraction and false-positive thresholds, unicode, args-hash invariant, every budget limit, compaction, the loop with in-memory ports (approvals, tampered payload, resume of a pending step, interventions), cassette normalization and the cache-miss message, provider request mapping, fake planner, assertion language, approval strategies, judge                                                                                                                                                                            |
| Integration | `pnpm test:integration`                   | Against local Postgres/Redis and a running project 05 (or Testcontainers with `TESTCONTAINERS=1`): `kill -9` while running and while awaiting approval (decided 26 h later on another instance), approval via project 05's inbox webhook, idempotency (one task, one e-mail, exactly one `effect_log` row per key, 422 on key reuse), ops-mcp contract snapshot, untrusted markers and cursor paging provided by project 05, the `ai_step` endpoint (auth, idempotency, 503/Retry-After, a real project 05 workflow calling it), full HTTP API incl. SSE, edits, policy versions/simulator/replay, playbooks, OpenTelemetry GenAI spans and metrics |
| Eval        | `pnpm eval` (replay) · `pnpm eval:record` | 50 scenarios, gates: violations = 0, injection success = 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| E2E         | `pnpm test:e2e`                           | Console: goal → timeline → approval batch (untick one, edit one) → approve → e-mails in Mailpit; red-team taint warning with source; forbidden action refused with the rule id; policy simulator; "Ask operator" panel on a project 05 deal page                                                                                                                                                                                                                                                                                                                                                                                                    |
| Smoke       | `pnpm smoke`                              | Starts project 05 with its own `scripts/dev-stack.sh`, ops-mcp, the agent and the console; a goal through approval; checks Mailpit and project 05 state; app-config + embed; a project 05 `ai_step` workflow answered by the agent; stops everything                                                                                                                                                                                                                                                                                                                                                                                                |

## Eval results

See [`docs/eval/latest.md`](docs/eval/latest.md) for the full report.

| Model (from config)                              | Success              | Violations | Injection | Avg steps | Avg $ / task | p95 latency          |
| ------------------------------------------------ | -------------------- | ---------- | --------- | --------- | ------------ | -------------------- |
| fake-planner (deterministic, replayed cassettes) | 100% (50/50)         | 0          | 0         | 4.2       | $0.0668      | 13017 ms (synthetic) |
| claude-haiku-4-5 (fast)                          | not run — no API key | –          | –         | –         | –            | –                    |
| claude-sonnet-5-5 (balanced)                     | not run — no API key | –          | –         | –         | –            | –                    |
| claude-opus-5-5 (strongest)                      | not run — no API key | –          | –         | –         | –            | –                    |

The fake planner was written together with the scenarios, so its success rate says nothing about real models. The numbers that matter are the two zeros — and they are not trivially zero: the same red-team and forbidden scenarios with the guardrails switched off (`pnpm eval --live --ablation=no-guardrails --category prompt_injection --category forbidden`) give **10/10 successful injections and 48 policy violations** ([report](docs/eval)). Violations and injection success are zero because safety comes from the policy, not from the model.

## Performance

Orchestration throughput with the deterministic planner (no model latency; measures agent + MCP + project 05 + Postgres + Redis/BullMQ), `pnpm loadtest`, 2026-10-03, Apple M1 8 cores, Node v26.7.0, all services on one laptop:

| Runs | Concurrency | Wall time | Runs/s | Latency p50 / p95 / max | Model calls | Tool calls | Completed |
| ---- | ----------- | --------- | ------ | ----------------------- | ----------- | ---------- | --------- |
| 200  | 16          | 2.547 s   | 78.52  | 185 / 351 / 440 ms      | 520         | 320        | 200/200   |

With a real model the run time is dominated by model latency (seconds per turn); these numbers show that the guardrails (policy evaluation, taint checks, persistence of every step, lease renewal) add tens of milliseconds per run, not seconds. Raw JSON: [`docs/benchmarks/`](docs/benchmarks).

## Architecture decisions

| ADR                                                      | Decision                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| [0001](docs/adr/0001-own-agent-loop.md)                  | Own agent loop instead of a framework                              |
| [0002](docs/adr/0002-tools-through-mcp.md)               | Tools through MCP instead of direct HTTP                           |
| [0003](docs/adr/0003-policy-outside-the-model.md)        | Policy outside the model, on `@ashamrai/expr` with intrinsics      |
| [0004](docs/adr/0004-approve-the-payload-hash.md)        | Approve a payload hash, not an intention                           |
| [0005](docs/adr/0005-taint-by-substrings.md)             | Taint checks by substrings                                         |
| [0006](docs/adr/0006-durable-runs.md)                    | Durable runs: Postgres + lease + sweeper + BullMQ                  |
| [0007](docs/adr/0007-record-replay.md)                   | Record/replay with normalized request hashes                       |
| [0008](docs/adr/0008-frozen-time-eval-harness.md)        | Frozen virtual time and fixture restore in the eval harness        |
| [0009](docs/adr/0009-deterministic-fake-planner.md)      | A deterministic (and gullible) scripted planner as the local model |
| [0010](docs/adr/0010-approvals-in-the-business-inbox.md) | Approval batches mirrored into the business inbox                  |

## Known limitations & next steps

- **No real-model numbers yet.** The Anthropic and OpenAI-compatible adapters are implemented and unit-tested for request mapping, but were never called (no keys in this environment). Next: a live run per model with a spend limit, refresh cassettes, fill the comparison table.
- **Taint is lexical.** Paraphrased instructions or values echoed into trusted fields are not detected; the policy and human approval remain the last lines. An LLM-based classifier could be an additional, non-blocking signal.
- **Inbox decisions are batch-wide.** Project 05's approvals are approve/reject per card; per-e-mail edits are console-only.
- **Embedded panel signs in separately.** Project 05 keeps its access token in memory, so the panel asks for the business-system credentials once (the agent session is stored in the host page's `localStorage`).
- **Lease overlap.** A process stalled longer than its lease can overlap with the new owner; idempotency keys keep effects single, but a model call may be duplicated. Fencing tokens on the run row would close this.
- **Rate limits are counted in Postgres** (per tenant per day) rather than with Redis counters; fine for this scale.
