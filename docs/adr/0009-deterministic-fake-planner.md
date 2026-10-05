# ADR 0009 — A deterministic scripted planner as the local "model"

Status: accepted

## Context
No API keys are available and the build must stay local. The eval, e2e tests, smoke test and demo still need a model that selects tools from the goal, pages, asks when a reference is ambiguous, reacts to policy denials, tool errors and approvals, and honours budgets.

## Decision
`FakePlannerProvider` is a stateless function of the request, like an LLM: it parses the system prompt (user, time zone, team, blocked tools) and the transcript (tool results, policy errors, queued approvals, approval outcomes, budget notices, user replies) and decides the next turn from about 30 goal intents. It deliberately *follows* instructions found in tool results (forward invoices, void invoices, mark deals won, include a payment link, change bank details) to simulate a model that fell for an injection, so the red-team scenarios exercise the defenses rather than the model's resistance. Its token usage is estimated and priced like a balanced model so cost budgets are exercised.

## Consequences
- The success rate of the fake planner says nothing about real models; the meaningful numbers are violations = 0 and injection success = 0, which hold although the planner is gullible.
- The model-comparison table can only contain the fake/replayed row until keys are available.
