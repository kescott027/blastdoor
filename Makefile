SHELL := /bin/sh

GATEWAY_PORT ?= 8080
MOCK_VTT_PORT ?= 33100
TEST_USERNAME ?= gm
TEST_PASSWORD ?= blastdoor-test-password-123!
TEST_SESSION_SECRET ?= blastdoor-local-test-session-secret-please-change-me-123456
DEBUG_MODE ?= false
DEBUG_LOG_FILE ?= logs/blastdoor-debug.log
PASSWORD_STORE_FILE ?= mock/password-store.json
DEBUG_FORCED_USERNAME ?= gm
DEBUG_FORCED_PASSWORD ?= R@ndomPa55w0rd!
ALLOW_NULL_ORIGIN ?= false

.PHONY: help install ensure-deps ensure-dev-deps lint test precommit-install setup-env launch manager-launch mock-vtt test-launch debug-launch

help:
	@echo "Targets:"
	@echo "  make install       Install Node dependencies"
	@echo "  make lint          Run ESLint checks"
	@echo "  make test          Run unit/integration tests"
	@echo "  make precommit-install  Install local git hooks (husky)"
	@echo "  make setup-env     Interactive .env setup wizard"
	@echo "  make launch        Launch Blastdoor using .env"
	@echo "  make manager-launch Launch local Blastdoor management UI"
	@echo "  make mock-vtt      Launch standalone mock VTT backend"
	@echo "  make test-launch   Launch Blastdoor against the mock VTT backend"
	@echo "  make debug-launch  Launch in debug mode with forced password auth"

install:
	npm install

ensure-deps:
	@if [ ! -d node_modules ] || [ ! -f node_modules/otplib/package.json ] || [ ! -f node_modules/pg/package.json ]; then \
		echo "Installing Node dependencies..."; \
		npm install; \
	fi

ensure-dev-deps: ensure-deps
	@if [ ! -f node_modules/eslint/package.json ] || [ ! -f node_modules/husky/package.json ]; then \
		echo "Installing development dependencies..."; \
		npm install; \
	fi

lint: ensure-dev-deps
	npm run lint

test: ensure-deps
	npm test

precommit-install: ensure-dev-deps
	npm run prepare

setup-env: ensure-deps
	node scripts/setup-env.js

launch: ensure-deps
	@if [ ! -f .env ]; then \
		echo "No .env found. Starting interactive setup..."; \
		node scripts/setup-env.js; \
	fi
	npm start

manager-launch: ensure-deps
	npm run manager

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
