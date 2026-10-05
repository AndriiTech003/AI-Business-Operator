# ADR 0002 — Tools through MCP (`ops-mcp`) instead of direct HTTP calls

Status: accepted

## Context
Project 05 already exposes 16 typed tools over MCP (Streamable HTTP), acting with the caller's API token, with risk metadata (`_meta['x-risk']`), `dryRun`, `idempotencyKey` and `untrusted` field markers.

## Decision
The agent loads its tools from `ops-mcp` with the user's (agent-flavoured) API token and calls them through the MCP SDK client. It uses the business REST API only where MCP has no tool and the agent itself (not the model) needs data: resolving an e-mail draft for policy/preview, loading a record for a policy rule, `contactExists`, the team directory, and approvals.

## Alternatives
Call the REST API directly with a hand-written tool list: one hop less, but duplicates schemas and risk metadata, and the same tools would not work in Claude Desktop / IDEs.

## Consequences
- Permissions of the business system apply automatically (403 → the model sees the error); the agent additionally hides tools the user lacks scopes for.
- Contract drift is caught by a snapshot test (`apps/agent/test/integration/mcp.test.ts`).
- Where `ops-mcp` is incomplete the agent compensates on its side and documents it: extra untrusted markers (web-form companies, search subtitles, external activity bodies, nested web-form contacts) and deterministic ordering of search hits with equal scores.
