# ADR 0008 — Frozen virtual time and per-scenario fixture restore in the eval harness

Status: accepted

## Context
Scenario assertions read the final state of project 05. Answers like "invoices more than 30 days overdue" or "a task on Friday" depend on the current date, so replayed responses would drift as days pass, and scenarios must not see each other's effects.

## Decision
Fixtures are data-only SQL dumps (`scenarios/fixtures/*.sql` + `*.meta.json` with ids, tokens and expected values) built once from project 05's own seed plus API calls. The harness runs project 05's built processes against a throwaway `bop_eval_*` database and restores the fixture (truncate + insert) before every scenario. All clocks are frozen at the fixture's reference time: the agent's clock is reset per scenario, project 05's Node processes run with a preloaded `Date` offset (`NODE_OPTIONS=--import fake-clock.mjs`, a libfaketime-style harness, no source change), and the throwaway database resolves `now()` to an offset function via `search_path`. The harness databases use `timezone=UTC` (project 05 stores Prisma DateTimes as UTC wall time; on a non-UTC server this skews raw SQL). E2E, smoke and dev stacks use the same fixtures shifted to the real time instead.

## Consequences
- Cassettes recorded on one day replay on any other day.
- The harness is coupled to project 05's schema; regenerating fixtures (`pnpm eval:fixtures`) and cassettes after schema changes is part of the workflow.
