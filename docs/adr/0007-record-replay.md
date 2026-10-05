# ADR 0007 — Record/replay of model calls for the eval suite

Status: accepted

## Context
Running 50 scenarios against a live model on every change is slow, costs money and is not deterministic.

## Decision
`ReplayProvider` looks responses up in cassettes keyed by `sha256(canonical {model, system, messages, tools})`. Requests touch a live business system, so tool results contain values that legitimately change between runs (ids of records created during the run, timestamps). Before hashing, UUIDs are replaced by placeholders numbered by first appearance, and every timestamp/date occurrence by a positional placeholder; the recorded response is stored with the same placeholders and re-bound to the new request on replay. Timestamps the model derived itself (e.g. "next Friday 09:00") are stored relative to the run's `now`. A miss fails the run with: `Cassette miss for scenario 'X' … Re-record the cassettes: pnpm eval --record --scenario X`. `RecordingProvider` writes cassettes from any provider; unused entries are pruned.

## Consequences
- The full suite replays in about 20 seconds with zero model calls; cost/tokens/latency are replayed from the recording.
- Normalization hides value changes in ids/timestamps. Real content changes (numbers, names, prompt text, tool schemas) still miss.
- Live model runs (`pnpm eval --live --model …`) and cassette refreshes need API keys and were not run here.
