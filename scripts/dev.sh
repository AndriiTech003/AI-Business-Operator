#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pnpm turbo run build --output-logs=errors-only
exec node apps/eval/dist/cli.js stack --profile dev --console
