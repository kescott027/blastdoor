SHELL := /bin/sh

GATEWAY_PORT ?= 8080
MOCK_VTT_PORT ?= 33100
MANAGER_HOST ?= 127.0.0.1
MANAGER_PORT ?= 8090
BLASTDOOR_API_PORT ?= 8070
TEST_USERNAME ?= gm
TEST_PASSWORD ?= blastdoor-test-password-123!
TEST_SESSION_SECRET ?= blastdoor-local-test-session-secret-please-change-me-123456
DEBUG_MODE ?= false
DEBUG_LOG_FILE ?= logs/blastdoor-debug.log
PASSWORD_STORE_FILE ?= mock/password-store.json
DEBUG_FORCED_USERNAME ?= gm
DEBUG_FORCED_PASSWORD ?= R@ndomPa55w0rd!
ALLOW_NULL_ORIGIN ?= false
INSTALL_CONFIG_PATH ?= data/installation_config.json
INSTALLER_AUTO_OPEN ?= true

.PHONY: help install configure deps-install ensure-install-config ensure-deps ensure-dev-deps lint test coverage integration-test call-home-gate ci-gate precommit-install setup-env launch launch-local launch-container launch-env manager-launch api-launch assistant-launch monitor monitor-local monitor-container debug debug-local debug-container troubleshoot troubleshoot-local troubleshoot-container mock-vtt test-launch debug-launch ensure-docker-env docker-build docker-up docker-down docker-logs basic-install basic-configure basic-launch basic-launch-env basic-monitor basic-troubleshoot resilient-install resilient-configure resilient-up resilient-down resilient-monitor resilient-troubleshoot

help:
	@echo "Targets:"
	@echo "  make install       First-run guided installer GUI (creates installation profile + env files)"
	@echo "  make configure     Re-open installer GUI to edit existing installation profile"
	@echo "  make deps-install  Install Node dependencies only"
	@echo "  make launch        Launch using installation profile (local or container)"
	@echo "  make monitor       Monitor using installation profile (local or container)"
	@echo "  make debug         Debug mode using installation profile (local or container)"
	@echo "  make troubleshoot  Troubleshoot using installation profile (local or container)"
	@echo "  make launch-env    Launch Blastdoor service using .env (legacy behavior)"
	@echo "  make manager-launch Launch local Blastdoor management UI"
	@echo "  make api-launch    Launch standalone blastdoor-api service"
	@echo "  make assistant-launch Launch standalone blastdoor-assistant service"
	@echo "  make lint          Run ESLint checks"
	@echo "  make test          Run unit/integration tests"
	@echo "  make coverage      Run test coverage with minimum thresholds"
	@echo "  make integration-test Run Playwright installer workflow integration tests"
	@echo "  make call-home-gate Run call-home module integration + e2e tests"
	@echo "  make ci-gate       Run blocking local CI gate (lint + coverage + Playwright integration)"
	@echo "  make precommit-install  Install local git hooks (husky)"
	@echo "  make setup-env     Interactive .env setup wizard"
	@echo ""
	@echo "Basic-Standalone model:"
	@echo "  make basic-install      Install local dependencies and hooks"
	@echo "  make basic-configure    Run interactive standalone configuration (.env)"
	@echo "  make basic-launch       Launch interactive standalone console"
	@echo "  make basic-monitor      Query health/monitor endpoints"
	@echo "  make basic-troubleshoot Fetch troubleshooting + diagnostics reports"
	@echo ""
	@echo "Standard-Resilient model:"
	@echo "  make resilient-install      Prepare Docker stack artifacts"
	@echo "  make resilient-configure    Initialize/verify docker/blastdoor.env"
	@echo "  make resilient-up           Launch resilient container stack"
	@echo "  make resilient-down         Stop resilient container stack"
	@echo "  make resilient-monitor      Show compose status + recent logs"
	@echo "  make resilient-troubleshoot Run non-destructive stack checks"
	@echo ""
	@echo "  make mock-vtt      Launch standalone mock VTT backend"
	@echo "  make test-launch   Launch Blastdoor against the mock VTT backend"
	@echo "  make debug-launch  Launch in debug mode with forced password auth"
	@echo "  make docker-build  Build the Blastdoor Docker image"
	@echo "  make docker-up     Start blastdoor + blastdoor-api + blastdoor-assistant + postgres + caddy with docker compose"
	@echo "  make docker-down   Stop docker compose services"
	@echo "  make docker-logs   Tail docker compose logs"

deps-install:
	npm install

install: ensure-deps
	INSTALLER_AUTO_OPEN=$(INSTALLER_AUTO_OPEN) node scripts/install-gui.js

configure: ensure-deps
	INSTALLER_AUTO_OPEN=$(INSTALLER_AUTO_OPEN) node scripts/install-gui.js

ensure-install-config:
	@if [ ! -f $(INSTALL_CONFIG_PATH) ]; then \
		echo "No installation profile found at $(INSTALL_CONFIG_PATH)."; \
		echo "Run 'make install' first."; \
		exit 1; \
	fi

ensure-deps:
	@if ! node scripts/check-deps.js >/dev/null 2>&1; then \
		echo "Installing Node dependencies..."; \
		npm install; \
	fi

ensure-dev-deps: ensure-deps
	@if ! node scripts/check-deps.js --dev >/dev/null 2>&1; then \
		echo "Installing development dependencies..."; \
		npm install; \
	fi

lint: ensure-dev-deps
	npm run lint

test: ensure-deps
	npm test

coverage: ensure-dev-deps
	npm run test:coverage

integration-test: ensure-dev-deps
	npx playwright install chromium
	npm run test:integration

call-home-gate: ensure-dev-deps
	npm run test:call-home
	npx playwright install chromium
	npm run test:integration:call-home

ci-gate: ensure-dev-deps
	npm run lint
	npm run test:coverage
	npx playwright install chromium
	npm run test:integration:ci

precommit-install: ensure-dev-deps
	npm run prepare

setup-env: ensure-deps
	node scripts/setup-env.js

launch-env: ensure-deps
	@if [ ! -f .env ]; then \
		echo "No .env found. Starting interactive setup..."; \
		node scripts/setup-env.js; \
	fi
	npm start

launch: ensure-deps
	node scripts/launch-with-install-check.js $(INSTALL_CONFIG_PATH)

launch-local: ensure-deps
	@if [ ! -f .env ]; then \
		echo "No .env found. Starting interactive setup..."; \
		node scripts/setup-env.js; \
	fi
	node scripts/launch-control.js

launch-container: ensure-docker-env
	docker compose up -d --build

manager-launch: ensure-deps
	npm run manager

api-launch: ensure-deps
	npm run api

assistant-launch: ensure-deps
	npm run assistant

monitor: ensure-install-config
	@profile=$$(node scripts/install-profile-dispatch.js profile $(INSTALL_CONFIG_PATH)); \
	if [ "$$profile" = "container" ]; then \
		echo "Install profile: container"; \
		$(MAKE) monitor-container; \
	else \
		gateway_port=$$(node scripts/install-profile-dispatch.js gateway-port $(INSTALL_CONFIG_PATH)); \
		manager_host=$$(node scripts/install-profile-dispatch.js manager-host $(INSTALL_CONFIG_PATH)); \
		manager_port=$$(node scripts/install-profile-dispatch.js manager-port $(INSTALL_CONFIG_PATH)); \
		echo "Install profile: local"; \
		$(MAKE) monitor-local GATEWAY_PORT=$$gateway_port MANAGER_HOST=$$manager_host MANAGER_PORT=$$manager_port; \
	fi

monitor-local:
	@echo "Gateway health:"
	@curl -fsS "http://127.0.0.1:$(GATEWAY_PORT)/healthz" || echo "Gateway health endpoint unavailable."
	@echo ""
	@echo "Manager monitor snapshot:"
	@curl -fsS "http://$(MANAGER_HOST):$(MANAGER_PORT)/api/monitor" || echo "Manager monitor endpoint unavailable."

monitor-container: ensure-docker-env
	@echo "Container status:"
	@docker compose ps
	@echo ""
	@echo "Recent logs:"
	@docker compose logs --tail=120 caddy blastdoor blastdoor-api blastdoor-assistant postgres

debug: ensure-deps ensure-install-config
	@profile=$$(node scripts/install-profile-dispatch.js profile $(INSTALL_CONFIG_PATH)); \
	if [ "$$profile" = "container" ]; then \
		echo "Install profile: container"; \
		$(MAKE) debug-container; \
	else \
		echo "Install profile: local"; \
		$(MAKE) debug-local; \
	fi

debug-local: ensure-deps
	@if [ ! -f .env ]; then \
		echo "No .env found. Starting interactive setup..."; \
		node scripts/setup-env.js; \
	fi
	DEBUG_MODE=true LAUNCH_CONTROL_AUTO_DEBUG=true node scripts/launch-control.js

debug-container: ensure-docker-env
	docker compose logs -f --tail=200 caddy blastdoor blastdoor-api blastdoor-assistant postgres

troubleshoot: ensure-install-config
	@profile=$$(node scripts/install-profile-dispatch.js profile $(INSTALL_CONFIG_PATH)); \
	if [ "$$profile" = "container" ]; then \
		echo "Install profile: container"; \
		$(MAKE) troubleshoot-container; \
	else \
		manager_host=$$(node scripts/install-profile-dispatch.js manager-host $(INSTALL_CONFIG_PATH)); \
		manager_port=$$(node scripts/install-profile-dispatch.js manager-port $(INSTALL_CONFIG_PATH)); \
		echo "Install profile: local"; \
		$(MAKE) troubleshoot-local MANAGER_HOST=$$manager_host MANAGER_PORT=$$manager_port; \
	fi

troubleshoot-local:
	@echo "Manager troubleshoot report:"
	@curl -fsS "http://$(MANAGER_HOST):$(MANAGER_PORT)/api/troubleshoot" || echo "Troubleshoot report unavailable."
	@echo ""
	@echo "Manager diagnostics report:"
	@curl -fsS "http://$(MANAGER_HOST):$(MANAGER_PORT)/api/diagnostics" || echo "Diagnostics report unavailable."

troubleshoot-container: ensure-docker-env
	@echo "Container status:"
	@docker compose ps
	@echo ""
	@echo "Blastdoor internal health:"
	@docker compose exec -T blastdoor node -e "fetch('http://127.0.0.1:8080/healthz').then(async (r)=>{console.log(r.status); console.log(await r.text()); process.exit(r.ok?0:1);}).catch((e)=>{console.error(e.message); process.exit(1);})" || echo "Blastdoor health probe failed."
	@echo ""
	@echo "Blastdoor API internal health:"
	@docker compose exec -T blastdoor-api node -e "fetch('http://127.0.0.1:8070/healthz').then(async (r)=>{console.log(r.status); console.log(await r.text()); process.exit(r.ok?0:1);}).catch((e)=>{console.error(e.message); process.exit(1);})" || echo "Blastdoor API health probe failed."
	@echo ""
	@echo "Blastdoor Assistant internal health:"
	@docker compose exec -T blastdoor-assistant node -e "fetch('http://127.0.0.1:8060/healthz').then(async (r)=>{console.log(r.status); console.log(await r.text()); process.exit(r.ok?0:1);}).catch((e)=>{console.error(e.message); process.exit(1);})" || echo "Blastdoor assistant health probe failed."
	@echo ""
	@echo "Recent service logs:"
	@docker compose logs --tail=200 caddy blastdoor blastdoor-api blastdoor-assistant postgres

mock-vtt: ensure-deps
	MOCK_VTT_HOST=127.0.0.1 MOCK_VTT_PORT=$(MOCK_VTT_PORT) node scripts/mock-vtt.js

test-launch: ensure-deps
	@echo "Starting mock VTT on http://127.0.0.1:$(MOCK_VTT_PORT)"
	@echo "Starting Blastdoor on http://127.0.0.1:$(GATEWAY_PORT)"
	@echo "Test login credentials loaded from $(PASSWORD_STORE_FILE)"
	@echo "Credentials are defined by hashes in PASSWORD_STORE_FILE."
	@echo "Debug mode: $(DEBUG_MODE) (log file: $(DEBUG_LOG_FILE))"
	@echo "Null origin allowed for local testing: true"
	@MOCK_VTT_HOST=127.0.0.1 MOCK_VTT_PORT=$(MOCK_VTT_PORT) node scripts/mock-vtt.js & \
	mock_pid=$$!; \
	trap 'kill $$mock_pid 2>/dev/null || true' EXIT INT TERM; \
	HOST=127.0.0.1 \
	PORT=$(GATEWAY_PORT) \
	FOUNDRY_TARGET=http://127.0.0.1:$(MOCK_VTT_PORT) \
	ALLOWED_ORIGINS='http://127.0.0.1:$(GATEWAY_PORT),http://localhost:$(GATEWAY_PORT)' \
	PASSWORD_STORE_MODE=file \
	PASSWORD_STORE_FILE='$(PASSWORD_STORE_FILE)' \
	SESSION_SECRET='$(TEST_SESSION_SECRET)' \
	COOKIE_SECURE=false \
	TRUST_PROXY=false \
	REQUIRE_TOTP=false \
	PROXY_TLS_VERIFY=true \
	ALLOW_NULL_ORIGIN=true \
	DEBUG_MODE=$(DEBUG_MODE) \
	DEBUG_LOG_FILE='$(DEBUG_LOG_FILE)' \
	node src/server.js

debug-launch: ensure-deps
	@echo "Starting mock VTT on http://127.0.0.1:$(MOCK_VTT_PORT)"
	@echo "Starting Blastdoor on http://127.0.0.1:$(GATEWAY_PORT) in DEBUG mode"
	@echo "Auth is forced to a fixed debug password configured by DEBUG_FORCED_PASSWORD."
	@echo "Null origin allowed for local testing: true"
	@hash=$$(node scripts/hash-password.js '$(DEBUG_FORCED_PASSWORD)'); \
	MOCK_VTT_HOST=127.0.0.1 MOCK_VTT_PORT=$(MOCK_VTT_PORT) node scripts/mock-vtt.js & \
	mock_pid=$$!; \
	trap 'kill $$mock_pid 2>/dev/null || true' EXIT INT TERM; \
	HOST=127.0.0.1 \
	PORT=$(GATEWAY_PORT) \
	FOUNDRY_TARGET=http://127.0.0.1:$(MOCK_VTT_PORT) \
	ALLOWED_ORIGINS='http://127.0.0.1:$(GATEWAY_PORT),http://localhost:$(GATEWAY_PORT)' \
	PASSWORD_STORE_MODE=env \
	AUTH_USERNAME='$(DEBUG_FORCED_USERNAME)' \
	AUTH_PASSWORD_HASH="$$hash" \
	SESSION_SECRET='$(TEST_SESSION_SECRET)' \
	COOKIE_SECURE=false \
	TRUST_PROXY=false \
	REQUIRE_TOTP=false \
	PROXY_TLS_VERIFY=true \
	ALLOW_NULL_ORIGIN=true \
	DEBUG_MODE=true \
	DEBUG_LOG_FILE='$(DEBUG_LOG_FILE)' \
	node src/server.js

ensure-docker-env:
	@if [ ! -f docker/blastdoor.env ]; then \
		cp docker/blastdoor.env.example docker/blastdoor.env; \
		echo "Created docker/blastdoor.env from template."; \
		echo "Edit docker/blastdoor.env (domain, secrets, postgres password) then rerun the command."; \
		exit 1; \
	fi

docker-build: ensure-docker-env
	docker compose build blastdoor

docker-up: ensure-docker-env
	docker compose up -d --build

docker-down: ensure-docker-env
	docker compose down

docker-logs: ensure-docker-env
	docker compose logs -f --tail=200 caddy blastdoor blastdoor-api postgres

basic-install: ensure-dev-deps precommit-install
	@echo "Basic-Standalone dependencies and local hooks are ready."

basic-configure: setup-env

basic-launch: launch-local

basic-launch-env: launch-env

basic-monitor: monitor-local

basic-troubleshoot: troubleshoot-local

resilient-install: ensure-docker-env docker-build
	@echo "Standard-Resilient stack image build complete."

resilient-configure: ensure-docker-env
	@echo "Resilient config file: docker/blastdoor.env"
	@echo "Validate BLASTDOOR_DOMAIN, LETSENCRYPT_EMAIL, POSTGRES_PASSWORD, SESSION_SECRET, and FOUNDRY_TARGET."

resilient-up: launch-container

resilient-down: docker-down

resilient-monitor: monitor-container

resilient-troubleshoot: troubleshoot-container
