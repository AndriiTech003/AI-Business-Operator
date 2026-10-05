# ADR 0003 — Policy outside the model, written in the expression language of project 05

Status: accepted

## Context
A model can be persuaded; prompt instructions such as "be careful with e-mails" are not a control.

## Decision
Every tool call passes `packages/policy` before execution. A tenant policy is a versioned YAML document: defaults per risk level, rules (`tool`, `when`, `then`, `reason`) and limits. Conditions are `@ashamrai/expr` expressions (Pratt parser, type checker, sandboxed evaluator from project 05, consumed as a packed tarball). The effective decision is the strictest of: missing business-system scope → limits → deny rules → require_approval rules → allow rules → default. Every decision is stored with its rule id, reasons, the evaluation context and the policy version the run is pinned to.

The spec's examples use `abs`, `endsWith` and `contactExists`, which the expression language does not have (its function set is closed). The policy compiler parses with `@ashamrai/expr`, lowers calls to these *intrinsics* into variables, type-checks the rest, and evaluates the intrinsics in TypeScript (the only async one, `contactExists`, asks the business API). Rules that reference `args.to` are evaluated per recipient. Conditions that fail at runtime fail closed for deny/approval rules.

## Alternatives
- Ask the model to self-police: no guarantee.
- OPA/Rego: powerful, but a second language next to the one the business system already uses for workflows.

## Consequences
- The simulator (`POST /policy/simulate`) and "what would change on the last 100 runs" re-evaluate stored contexts; the eval oracle re-evaluates every executed action with the scenario policy.
- Policy errors are reported with line/column inside the YAML for the console editor.
- The intrinsic set is fixed in code (`abs`, `endsWith`, `domainOf`, `contactExists`); adding one is a code change, on purpose.
