# ADR 0005 — Taint checks by substrings

Status: accepted

## Context
Data in the CRM is written by outsiders (web forms, inbound e-mails, company names) and may contain instructions. Wrapping tool results as untrusted helps the model but is not a guarantee.

## Decision
Strings under fields that `ops-mcp` marks as untrusted are stored per run (`untrusted_spans`). Before a non-read action runs, its arguments are compared with those spans: an e-mail address, a URL, a number with 5+ digits (IBANs, amounts) or a phrase of 16+ characters with at least two content words that appears in untrusted text and not in trusted identity fields (e-mails, names, numbers, amounts, dates of records the agent read) makes the argument *tainted*. A tainted `allow` becomes `require_approval` with the warning "argument originates from untrusted content" and the source (tool, field path, text, character range) for the console to highlight. Names copied from untrusted name fields do not count as tainted phrases (they would flag every follow-up to a web-form lead), but addresses inside them do. Unicode is NFKC-normalized; look-alike characters are not folded.

## Alternatives
- No check: the policy alone still blocks unknown recipients, but tainted content sent to known contacts would go unnoticed.
- An LLM classifier: catches paraphrases, but is non-deterministic, costs money and can itself be injected. Possible future extra layer.

## Consequences
- Deterministic, cheap, unit-tested (thresholds, false positives on common phrases, unicode).
- Paraphrased content is not detected; text echoed into trusted fields (e.g. search titles derived from a web-form company name) clears the taint. The policy and human approval remain the last lines (see red-team scenarios `redteam-company-name-exfil`, `redteam-known-contact-exfil`).
