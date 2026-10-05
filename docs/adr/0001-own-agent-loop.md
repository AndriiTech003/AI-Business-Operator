# ADR 0001 — Own agent loop instead of an agent framework

Status: accepted

## Context
The agent must stop on budgets (steps, tool calls, tokens, dollars, wall clock, external actions), pause for human approval for days, survive restarts in the middle of a turn, and leave a timeline where every model call, tool call and policy decision is visible with its rule id. Frameworks (LangChain/LangGraph, vendor agent SDKs) offer loops, memory and tool abstractions, but they own the control flow and the state.

## Decision
`packages/agent-core` implements the loop (about 600 lines) with no I/O: it talks to ports (`RunStore`, `ToolGateway`, `PolicyGateway`, `ActionResolver`, `ApprovalPublisher`, `LlmProvider`, `Clock`, `EventSink`). The agent service supplies Postgres/MCP/Redis implementations; unit tests supply in-memory ones.

## Alternatives
- LangGraph with a Postgres checkpointer: durable, but approvals would be graph interrupts, the policy would sit in a node the graph author can bypass, and the transcript format is the library's.
- Vendor tool runners: convenient loop, but no hook for "execute only the approved payload", no budget accounting beyond tokens.

## Consequences
- Every guarantee in the README is a few lines in one file and has a unit test (`packages/agent-core/test/loop.test.ts`).
- Resume is explicit: a tool step is written as `pending` before execution, re-executed with the same idempotency key after a crash.
- We maintain provider adapters ourselves (`packages/llm`): Anthropic Messages (streaming, tool use, thinking blocks round-tripped), OpenAI-compatible chat completions, replay and a scripted planner.
- No ready-made memory, retrieval or multi-agent features — not needed by the spec.
