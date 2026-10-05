# ADR 0004 — Approve a payload hash, not an intention

Status: accepted

## Context
"The agent wants to send follow-ups, OK?" approves an intention; what gets executed later may differ (another recipient, another body, a draft changed by someone else).

## Decision
A proposal stores the exact payload and `args_hash = sha256(canonical JSON {tool, args})`. On approval the decided hash is written to `approved_hash`; the executor takes the payload from the proposal (never from the model), recomputes the hash and refuses on mismatch. A human edit produces a new payload and hash, is re-checked by the policy (an edit cannot turn a denied action into an approved one), and is recorded as `edited` with the original payload. For `send_email`, whose tool argument is only a draft id, the payload is the resolved draft (recipients, subject, body): before sending, the executor compares the live draft with the approved content and refuses if it changed; an edited e-mail is sent as a new draft created from the approved content. The console sends the hash it displayed (`expectedHash`); a stale view gets 409.

## Consequences
- Approved actions run with `idempotencyKey = proposal.id`, so a crash between approval and execution cannot double-send.
- Tests: unit (`argsHash` stability, mutated payload refused), API (tampered stored payload → 409, edited recipient to an unknown domain → 422, edited body is what Mailpit receives).
