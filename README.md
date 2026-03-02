# Blastdoor

Secure front-end authentication gateway for a self-hosted Foundry VTT instance.

## What this provides

- Hardened login page in front of Foundry
- Username + strong password hash verification
- Optional TOTP MFA (recommended and enabled by default)
- Session-based auth with secure cookie settings
- Login rate limiting and CSRF protection
- Temporary login code issuance with optional email delivery
- User self-service account page (password change, profile updates, admin messaging)
- Reverse proxy to Foundry (including websocket traffic)
- Fantasy/sci-fi themed responsive frontend
- Local GUI management console for setup/config, launch control, and monitoring

## Architecture

1. Public internet traffic enters Blastdoor (this service).
2. Unauthenticated users are sent to `/login`.
3. After successful auth, requests are proxied to your private Foundry URL.
4. Foundry should not be directly exposed publicly.

### Modular Data Boundary (Phase 1)

Blastdoor now uses a shared data API boundary in `src/blastdoor-api.js`:

- Portal (`src/server.js`) calls this API for auth/profile/theme data.
- Admin manager (`src/manager.js`) calls this API for user/theme data.
- Backing store selection (env/file/sqlite/postgres) is isolated behind the API module.

### Integrated Assistant (Phase 2)

Blastdoor includes an integrated assistant interface with four workflows:

1. Environment inferred configuration recommendations.
2. Error troubleshooting recommendations (optional RAG/web lookup).
3. Threat monitoring from logs with optional blast-door lockdown.
4. Grimoire API-intent block generation for scriptable workflows.

Manager/API interface:

- `GET /api/assistant/status`
- `POST /api/assistant/workflow/config-recommendations`
- `POST /api/assistant/workflow/troubleshoot-recommendation`
- `POST /api/assistant/workflow/threat-monitor`
- `POST /api/assistant/workflow/grimoire`

### Standalone blastdoor-api Service

Blastdoor can run a separate API process (`src/api-server.js`) for data access.

- Default bind: `127.0.0.1:8070`
- Health endpoint: `/healthz`
- Internal endpoints: `/internal/*`
- Optional auth token: `BLASTDOOR_API_TOKEN` (`x-blastdoor-api-token` header)

Portal/Admin can use this remote API when `BLASTDOOR_API_URL` is set.
When `BLASTDOOR_API_URL` is empty, they use in-process local API access.

## Deployment Models

Blastdoor supports two operational models with automated workflows.

Recommended command flow:

```bash
make install
make launch
make monitor
make debug
make troubleshoot
```

`make install` launches a guided GUI wizard and writes:

- `data/installation_config.json` (global install profile)
- `.env` (standalone runtime)
- `docker/blastdoor.env` (container runtime)

Re-run `make configure` any time to edit the installation profile. Generic commands (`launch`, `monitor`, `debug`, `troubleshoot`) read `installation_config.json` and execute the correct recipe automatically.

If you run `make launch` before setup is complete, Blastdoor now prompts with `Y/N/M`:

- `Y`: open installer immediately
- `N`: exit without changes
- `M`: run quick environment diagnostics + recommendations, then open installer

After saving installer configuration, use the in-UI buttons:

- `Close`: close installer cleanly
- `Launch and Exit`: request launch and close installer cleanly

### Basic-Standalone

Use this model for local installs and simpler topologies.
Data backends can be `env`, `file`, `sqlite`, or `postgres` depending on your `.env`.

Automated workflow:

```bash
make basic-install
make basic-configure
make basic-launch
```

Monitoring:

```bash
make basic-monitor
```

Troubleshooting:

```bash
make basic-troubleshoot
```

### Standard-Resilient

Use this model for orchestrated container deployment with layered services:
`caddy` (TLS edge) -> `blastdoor` (portal/proxy) -> `blastdoor-api` (data API) -> `blastdoor-assistant` (AI workflows) -> `postgres`.

Automated workflow:

```bash
make resilient-install
make resilient-configure
make resilient-up
```

Monitoring:

```bash
make resilient-monitor
```

Troubleshooting:

```bash
make resilient-troubleshoot
```

## Quick start

Node.js 22+ is required.

1. Run guided first-time install:

```bash
make install
```

`make install` now launches the installer GUI and auto-opens your browser to the installer URL.
To disable browser auto-open for headless shells:

```bash
make install INSTALLER_AUTO_OPEN=false
```

The installer GUI asks for:

- install model (`local` or `container`)
- platform (`WSL`, `Mac`, `Linux`)
- database (`sqlite` or `postgres`)
- object storage (`local`, `gdrive`, `s3`)
- Foundry location (`local` or `external`, with external host + port)
- global service topology (portal/admin/api host + port)
- container TLS identity (`publicDomain`, `letsEncryptEmail`) when `installType=container`

2. Launch with profile-aware command:

```bash
make launch
```

For `installType=container`, `make launch` now preflights `docker/blastdoor.env` and blocks startup when required TLS/runtime values are placeholder or missing (`BLASTDOOR_DOMAIN`, `LETSENCRYPT_EMAIL`, `POSTGRES_PASSWORD`, `SESSION_SECRET`, `FOUNDRY_TARGET`).

3. Re-open installer for edits:

```bash
make configure
```

Legacy `.env`-only wizard is still available with `make setup-env`. It auto-checks dependencies and runs `npm install` when required packages are missing.

4. Generate secrets and password hash manually (optional helper path):

```bash
npm run gen-secret
npm run hash-password -- 'replace-with-long-random-password'
```

5. During setup, Blastdoor offers:
- Option A: SQLite (local file)
- Option B: PostgreSQL

If PostgreSQL is selected, setup will:
- Probe connectivity to `POSTGRES_URL`
- If not reachable, offer:
- `1` specify a different `POSTGRES_URL`
- `2` install PostgreSQL
- On install path, detect Docker and offer:
- `1` Docker container install (`postgres:16`) with persistence (`blastdoor-postgres-data` volume + restart policy)
- `2` local Linux/WSL install (apt + service start + bootstrap user/db)
- After install, wait and retry until PostgreSQL is actually ready before continuing.

If DB-backed modes are enabled, setup also initializes credentials and config records in the selected database.

6. If you prefer bypassing the wizard, copy `.env.example` to `.env` and fill:

- `FOUNDRY_TARGET` (example: `http://127.0.0.1:30000`)
- `SESSION_SECRET`
- `TOTP_SECRET` when `REQUIRE_TOTP=true`

Password store options:

- `PASSWORD_STORE_MODE=env` uses `AUTH_USERNAME` + `AUTH_PASSWORD_HASH`
- `PASSWORD_STORE_MODE=file` uses `PASSWORD_STORE_FILE`
- `PASSWORD_STORE_MODE=sqlite` uses the `users` table in `DATABASE_FILE`
- `PASSWORD_STORE_MODE=postgres` uses the `users` table in PostgreSQL (`POSTGRES_URL`)

Config store options:

- `CONFIG_STORE_MODE=env` keeps config only in environment/.env
- `CONFIG_STORE_MODE=sqlite` stores config values and config files in `DATABASE_FILE`
- `CONFIG_STORE_MODE=postgres` stores config values and config files in PostgreSQL

When either mode uses sqlite, set:

- `DATABASE_FILE` (example: `data/blastdoor.sqlite`)

When either mode uses postgres, set:

- `POSTGRES_URL` (example: `postgres://blastdoor:blastdoor@127.0.0.1:5432/blastdoor`)
- `POSTGRES_SSL` (`true`/`false`)

When `CONFIG_STORE_MODE=sqlite` or `CONFIG_STORE_MODE=postgres`, Blastdoor snapshots `.env` and `.env.example` into the database at startup.
This provides persistence across application restarts when using PostgreSQL.

Optional tuning values:

- `LOGIN_RATE_LIMIT_WINDOW_MS` (default `900000`)
- `LOGIN_RATE_LIMIT_MAX` (default `8`)
- `ALLOWED_ORIGINS` (comma-separated origins to trust for login POST origin checks)
- `ALLOW_NULL_ORIGIN` (allow `Origin: null` requests; default `false`)
- `GRAPHICS_CACHE_ENABLED` (`true`/`false`; controls cache headers for `/graphics`)
- `BLASTDOOR_API_URL` (optional external API base URL, example `http://127.0.0.1:8070`)
- `BLASTDOOR_API_TOKEN` (optional shared token for API calls)
- `BLASTDOOR_API_TIMEOUT_MS` (default `2500`)
- `BLASTDOOR_API_RETRY_MAX_ATTEMPTS` (default `3`, total attempts including first call)
- `BLASTDOOR_API_RETRY_BASE_DELAY_MS` (default `120`)
- `BLASTDOOR_API_RETRY_MAX_DELAY_MS` (default `1200`)
- `BLASTDOOR_API_CIRCUIT_FAILURE_THRESHOLD` (default `5`)
- `BLASTDOOR_API_CIRCUIT_RESET_MS` (default `10000`)
- `ASSISTANT_ENABLED` (`true`/`false`)
- `ASSISTANT_URL` (optional; if empty, embedded workflows are used)
- `ASSISTANT_TOKEN` (optional shared token when using standalone assistant service)
- `ASSISTANT_PROVIDER` (`ollama`)
- `ASSISTANT_OLLAMA_URL`, `ASSISTANT_OLLAMA_MODEL`
- `ASSISTANT_TIMEOUT_MS`, `ASSISTANT_RETRY_MAX_ATTEMPTS`
- `ASSISTANT_RAG_ENABLED`, `ASSISTANT_ALLOW_WEB_SEARCH`
- `ASSISTANT_AUTO_LOCK_ON_THREAT`, `ASSISTANT_THREAT_SCORE_THRESHOLD`
- `EMAIL_PROVIDER` (`disabled`, `console`, `smtp`)
- `EMAIL_FROM` (required when `EMAIL_PROVIDER=smtp`)
- `EMAIL_ADMIN_TO` (used by user `Message Admin` action)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_IGNORE_TLS`
- `PUBLIC_BASE_URL` (recommended for correct login links in outbound email)

### User Self-Service Flow

- Temporary login codes now force a password-change flow before proxy routing is allowed.
- After successful authentication, Blastdoor shows a 7-second transition page with:
- `Continue` to destination
- `My Account` quick access
- `/account` supports:
- password update
- profile updates (`friendlyName`, `email`, `contactInfo`, `avatarUrl`, `displayInfo`)
- `Message Admin` action (uses configured email provider)

### Email Handling Strategies (Spike Summary)

Simple path (implemented now):
- Use `EMAIL_PROVIDER=smtp` for direct SMTP delivery.
- Use `EMAIL_PROVIDER=console` for local verification without external email.
- Manager `Reset Login / Temp Code` attempts email delivery when `delivery=email` and user profile has an email.

Durable path (recommended next phase):
- Add an outbox table/queue (sqlite/postgres) and background worker for retries + dead-letter handling.
- Add provider adapters (e.g., SES/SendGrid/Resend) with idempotency keys and delivery status callbacks.
- Expose queue health/retry metrics in admin diagnostics.

### File password store format

Example `mock/password-store.json`:

```json
{
  "users": [
    {
      "username": "gm",
      "passwordHash": "scrypt$<salt>$<digest>"
    }
  ]
}
```

Password-store interface is implemented in `src/password-store.js` with:

- `PasswordStore` base interface (`getUserByUsername`)
- `EnvPasswordStore`
- `FilePasswordStore` (mock backend for local testing)
- `SqlitePasswordStore`
- `PostgresPasswordStore`

Database schema/helpers are implemented in `src/database-store.js` for both SQLite and PostgreSQL:

- `users` table for auth users and password hashes
- `app_config` table for key/value configuration settings
- `config_files` table for file snapshots like `.env`

7. Start Blastdoor directly from `.env` (legacy mode):

```bash
make launch-env
```

Launch the local management console:

```bash
make manager-launch
```

Default manager URL: `http://127.0.0.1:8090/manager/`

Service Control now includes an **Open Portal** button that opens the configured Blastdoor gateway URL in a new browser tab.

Launch standalone blastdoor-api locally:

```bash
make api-launch
```

Launch standalone blastdoor-assistant locally:

```bash
make assistant-launch
```

Manager host/port can be overridden with:

- `MANAGER_HOST` (default `127.0.0.1`)
- `MANAGER_PORT` (default `8090`)

## Docker Compose Deployment (Caddy TLS + PostgreSQL)

This repo now includes:

- `Dockerfile` for Blastdoor
- `docker-compose.yml` with `blastdoor`, `blastdoor-api`, `blastdoor-assistant`, `postgres`, and `caddy`
- `docker/Caddyfile` for TLS termination and reverse proxy
- `docker/blastdoor.env.example` for stack configuration

Quick start:

1. Create Docker env file:

```bash
cp docker/blastdoor.env.example docker/blastdoor.env
```

2. Edit `docker/blastdoor.env`:

- Set `BLASTDOOR_DOMAIN` to your public DNS name.
- Set `LETSENCRYPT_EMAIL`.
- Set strong `POSTGRES_PASSWORD`.
- Set strong `SESSION_SECRET`.
- Set `FOUNDRY_TARGET` to the Foundry endpoint reachable from the container.

If you configured via `make install` / `make configure`, these values are synced automatically from `data/installation_config.json` into `docker/blastdoor.env`.

3. Start the stack:

```bash
make docker-up
```

4. Tail logs:

```bash
make docker-logs
```

5. Stop the stack:

```bash
make docker-down
```

Notes:

- Caddy obtains and renews Let's Encrypt certificates automatically when DNS and ports are correct.
- Required inbound ports for public TLS issuance: `80/tcp` and `443/tcp`.
- Blastdoor portal is also published directly on `8080/tcp` (`http://<host>:8080`) for resilient-mode access/testing.
- Blastdoor API is published on localhost `127.0.0.1:8070` for local diagnostics (`/healthz`, internal checks).
- Blastdoor runs behind Caddy with `TRUST_PROXY=1` and `COOKIE_SECURE=true`.
- Blastdoor gateway talks to the internal `blastdoor-api` container (`BLASTDOOR_API_URL=http://blastdoor-api:8070`).
- PostgreSQL data persists in Docker volume `postgres-data`.
- Caddy cert/key state persists in Docker volumes `caddy-data` and `caddy-config`.
- This compose stack runs Blastdoor directly (`src/server.js`) and does not run the manager UI service.

## Testing

Run the full test suite:

```bash
npm test
```

Run test coverage with enforced minimum thresholds:

```bash
npm run test:coverage
```

or:

```bash
make coverage
```

Run Playwright installer integration tests:

```bash
npm run test:integration
```

or:

```bash
make integration-test
```

Run lint checks:

```bash
npm run lint
```

## Local Pre-Commit Hooks

Blastdoor includes a local pre-commit toolchain (Husky) that runs:

- `npm run lint`
- `npm test`

Install hooks locally:

```bash
make precommit-install
```

or:

```bash
npm run prepare
```

## GitHub CI and Security

This repo now includes a comprehensive GitHub Actions pipeline:

- `CI` (`.github/workflows/ci.yml`)
- Runs on push + PR
- Node matrix: `22.x`, `24.x`
- Performs lint + syntax checks + full test suite
- Enforces unit/integration coverage thresholds on Node `24.x`

- `Integration Tests` (`.github/workflows/integration.yml`)
- Runs on push + PR
- Uses a containerized runner (`node:24-bookworm`)
- Executes Playwright installer-wizard E2E tests
- Publishes Playwright report + test artifacts

- `Dependency Review` (`.github/workflows/dependency-review.yml`)
- Runs on PRs
- Fails PR if dependency changes introduce `high`/`critical` risk
- Requires GitHub Dependency Graph to be enabled in repository settings:
- `https://github.com/<owner>/<repo>/settings/security_analysis`

- `Security Scans` (`.github/workflows/security.yml`)
- Runs on PRs, pushes to `main`, weekly schedule, and manual dispatch
- `npm audit` for production deps (`high`+)
- Trivy filesystem vulnerability scan with SARIF upload to Security tab
- Trivy container image vulnerability scan with SARIF upload to Security tab (advisory; does not block CI)
- CodeQL static analysis (enabled by default in workflow)

- `Secret Scan` (`.github/workflows/secret-scan.yml`)
- Runs on PRs, pushes to `main`, weekly schedule, and manual dispatch
- Uses Gitleaks filesystem scan (`--no-git`) with project allowlist config (`.gitleaks.toml`) and SARIF upload

- Dependabot (`.github/dependabot.yml`)
- Weekly dependency update PRs for npm and GitHub Actions

## Makefile shortcuts

Generic profile-driven commands:

```bash
make install
make configure
make launch
make monitor
make debug
make troubleshoot
```

`make launch`/`monitor`/`debug`/`troubleshoot` dispatch automatically based on `data/installation_config.json` (`installType=local|container`).

```bash
make integration-test
```

Runs Playwright installer workflow tests locally.

Model workflows:

```bash
make basic-install
make basic-configure
make basic-launch
make basic-monitor
make basic-troubleshoot
```

```bash
make resilient-install
make resilient-configure
make resilient-up
make resilient-monitor
make resilient-troubleshoot
make resilient-down
```

```bash
make launch
```

Launches by profile:

- `local`: interactive launch console (manager + service controls)
- `container`: docker compose stack (`caddy`, `blastdoor`, `blastdoor-api`, `postgres`)

```bash
make launch-env
```

Launches Blastdoor directly from `.env` (legacy non-console mode).

```bash
make manager-launch
```

Launches the GUI management console used to configure `.env`, start/stop/restart Blastdoor, and monitor runtime/debug logs.
The admin console also includes config backup operations:

- Backup Configs (named snapshots)
- View / Restore / Delete backups
- Clean Install Config (reset install profile + env files to defaults)

```bash
make lint
```

Runs local ESLint checks (auto-installs dev dependencies if needed).

```bash
make precommit-install
```

Installs/refreshes local Husky git hooks.

```bash
make test-launch
```

Starts a local mock VTT backend and launches Blastdoor against it.  
Also auto-installs dependencies if needed.
Default URLs:

- Gateway: `http://127.0.0.1:8080`
- Mock VTT: `http://127.0.0.1:33100`
- Password store: `mock/password-store.json`

Debug launch with forced password authentication:

```bash
make debug-launch
```

Also auto-installs dependencies if needed.
This runs with `DEBUG_MODE=true` and forces auth to:

- Username: `gm` (or `DEBUG_FORCED_USERNAME`)
- Password: `R@ndomPa55w0rd!` (or `DEBUG_FORCED_PASSWORD`)

Docker stack helpers:

```bash
make docker-up
make docker-logs
make docker-down
```

Enable verbose debug logging to terminal and logfile:

```bash
make test-launch DEBUG_MODE=true DEBUG_LOG_FILE=logs/test-launch-debug.log
```

Debug logs never include plaintext passwords and only include hashed user fingerprints.
Each HTTP response includes `x-request-id` so you can match browser failures to logfile entries.

## Troubleshooting install issues

If you see `ERR_MODULE_NOT_FOUND` for packages like `otplib` on WSL/Linux:

```bash
rm -rf node_modules
npm install
make setup-env
```

If container launch warns about random unset variables during `docker compose` startup, update to latest `main` and relaunch.
Compose commands now read `docker-compose.yml` service `env_file` directly (no global `--env-file` interpolation of hashed secrets).

If setup fails with `ECONNREFUSED 127.0.0.1:5432`, PostgreSQL is not reachable at the configured URL.
Start PostgreSQL, verify `POSTGRES_URL`, then rerun:

```bash
make setup-env
```

## Production hardening checklist

- Put Blastdoor behind HTTPS only (Caddy/Nginx/Traefik or cloud tunnel).
- Keep `COOKIE_SECURE=true` in production.
- Keep Foundry bound to localhost/private network only.
- Forward your public port to Blastdoor, not directly to Foundry.
- Keep `REQUIRE_TOTP=true` for MFA.
- Use a long random password and rotate it periodically.
- Restrict inbound firewall to known IPs when possible.

## Common local dev settings

For local HTTP-only testing (not internet-facing), set:

```dotenv
COOKIE_SECURE=false
REQUIRE_TOTP=false
```

Do not use these relaxed settings on the public internet.

## Routes

- `GET /login` login screen
- `POST /login` authenticate
- `GET /logout` or `POST /logout` end session
- `GET /healthz` health check
- Any other path: proxied to Foundry when authenticated
