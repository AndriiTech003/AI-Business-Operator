# ADR 0010 — Approval batches mirrored into the business-system inbox

Status: accepted

## Context
Managers already work in project 05's Approvals inbox; agent approvals should appear there (`source: agent`) as well as in the operator console.

## Decision
When a turn ends with proposals, the batch is sealed and published with `POST /v1/approvals` (service token with `approvals:create`, or the run owner's token), including a summary of every proposal, `expiresInSeconds` from the policy (default 72 h), an idempotency key per batch and a `callbackUrl`. Decisions taken in the console are per proposal (select, edit, reject) and close the inbox card with a summary comment. A decision taken in the inbox is batch-wide: the signed webhook (`x-bop-signature`, HMAC with project 05's secret, verified against both the virtual and the real clock) approves or rejects all pending proposals. The sweeper re-publishes batches that failed to publish and can poll the inbox (`APPROVAL_POLL_MS`) when the callback cannot reach the agent.

## Consequences
- Editing a single e-mail is only possible in the console; the inbox card links to it.
- Members without `approvals:decide` cannot approve agent actions in either place.
