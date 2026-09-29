.PHONY: help install db-up db-reset migrate seed dev lint typecheck format test ci ci-docker

DATABASE_URL ?= postgres://familyops:familyops@localhost:54329/familyops
export DATABASE_URL

help:
	@echo "install     npm ci"
	@echo "db-up       start Postgres 17 in Docker (port 54329)"
	@echo "db-reset    drop and recreate the demo database, migrate, seed"
	@echo "dev         run api, worker and web (http://localhost:5173)"
	@echo "ci          typecheck, lint, format check, tests (TEST_PG_URL or Docker for Postgres)"
	@echo "ci-docker   same, inside node:24 with a Postgres service container"

install:
	npm ci

db-up:
	docker compose up -d db

migrate:
	npm run migrate

seed:
	npm run seed

db-reset:
	psql "$(DATABASE_URL)" -c "drop schema if exists public cascade; drop schema if exists graphile_worker cascade; drop schema if exists fakepay cascade; create schema public;"
	npm run migrate
	npm run seed

dev:
	DEV_LOGIN=1 npx --no-install concurrently -k -n api,worker,web \
		"npm run dev:api" "npm run dev:worker" "npm run dev:web"

typecheck:
	npm run typecheck

lint:
	npm run lint
	npm run format:check

test:
	npm test

ci: typecheck lint test
	npm run build:web

ci-docker:
	docker compose -f compose.ci.yaml run --rm ci
	docker compose -f compose.ci.yaml down -v
