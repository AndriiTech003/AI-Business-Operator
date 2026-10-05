#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 || ! redis-cli -p 6379 ping >/dev/null 2>&1; then
  echo "smoke: devinfra is not running (Postgres/Redis); start ../devinfra/start.sh" >&2
  exit 1
fi

echo "smoke: building (turbo cache makes this fast when nothing changed)"
pnpm turbo run build --output-logs=errors-only >/dev/null

node scripts/smoke.mjs
