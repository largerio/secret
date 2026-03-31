DC = docker compose -f docker-compose.dev.yml

dev:
	$(DC) up

build:
	$(DC) build

lint:
	$(DC) run --rm app pnpm lint

format:
	$(DC) run --rm app pnpm format

typecheck:
	$(DC) run --rm app pnpm typecheck

test:
	$(DC) run --rm app pnpm test

check: lint typecheck test

shell:
	$(DC) run --rm app sh

down:
	$(DC) down

.PHONY: dev build lint format typecheck test check shell down
