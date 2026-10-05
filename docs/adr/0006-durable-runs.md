# ADR 0006 — Durable runs in Postgres with a lease, a sweeper and BullMQ

Status: accepted

## Context
Approvals can take days; deployments and crashes happen in between and in the middle of turns.

## Decision
Run state lives in Postgres: `agent_runs`, the full transcript (`agent_messages`), steps (`agent_steps`, a tool step is written `pending` before the effect), proposals and batches. One executor per run is guaranteed by a Redis lock (`SET NX PX`, renewed by a heartbeat with a compare-and-pexpire script) mirrored as `lease_owner/lease_expires_at` in the row. A leader-elected sweeper re-queues runs whose lease expired, expires approval batches, re-publishes batches that were not mirrored to the inbox and continues decided-but-unapplied batches. BullMQ carries `start`, `resume`, `continue` and scheduled playbook jobs. Wall-clock budget counts active segments only.

## Consequences
- `kill -9` during a tool call: the step is re-executed with the same idempotency key on another instance — one effect in project 05 (integration test).
- `kill -9` while awaiting approval: another instance with a clock 26 hours ahead takes the decision and finishes the run (integration test).
- A process stalled longer than the lease could overlap with the new owner; idempotency keys make the overlap harmless for effects, at the price of a duplicated model call.
