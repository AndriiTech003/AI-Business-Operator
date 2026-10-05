.PHONY: install infra build dev stack lint typecheck test test-integration e2e eval eval-record fixtures smoke seed migrate up down

install:
	pnpm install

infra:
	../devinfra/start.sh

build:
	pnpm build

dev:
	pnpm dev

stack:
	node apps/eval/dist/cli.js stack --profile dev --console

lint:
	pnpm lint && pnpm format:check

typecheck:
	pnpm typecheck

test:
	pnpm test

test-integration:
	pnpm test:integration

e2e:
	pnpm test:e2e

eval:
	pnpm eval

eval-record:
	pnpm eval:record

fixtures:
	pnpm eval:fixtures

smoke:
	pnpm smoke

migrate:
	pnpm db:migrate

seed:
	pnpm seed

loadtest:
	pnpm loadtest

up:
	docker compose up --build

down:
	docker compose down -v
