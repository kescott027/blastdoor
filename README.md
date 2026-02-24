# Blastdoor

Secure front-end authentication gateway for a self-hosted Foundry VTT instance.

## What this provides

- Hardened login page in front of Foundry
- Username + strong password hash verification
- Optional TOTP MFA (recommended and enabled by default)
- Session-based auth with secure cookie settings
- Login rate limiting and CSRF protection
- Reverse proxy to Foundry (including websocket traffic)
- Fantasy/sci-fi themed responsive frontend

## Architecture

1. Public internet traffic enters Blastdoor (this service).
2. Unauthenticated users are sent to `/login`.
3. After successful auth, requests are proxied to your private Foundry URL.
4. Foundry should not be directly exposed publicly.

## Quick start

Node.js 22+ is required.

1. Install dependencies:

```bash
npm install
```

2. Generate secrets and password hash:

```bash
npm run gen-secret
npm run hash-password -- 'replace-with-long-random-password'
```

3. Create and configure your env file:

```bash
make setup-env
```

`make setup-env` walks every setting with defaults, asks for a password, and hashes it automatically.
It now offers:
- Option A: SQLite (local file)
- Option B: PostgreSQL

If DB-backed modes are enabled, setup also initializes credentials and config records in the selected database.

4. If you prefer manual setup, copy `.env.example` to `.env` and fill:

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

5. Start Blastdoor:

```bash
npm start
```

## Testing

Run the full test suite:

```bash
npm test
```

## Makefile shortcuts

```bash
make launch
```

Launches Blastdoor using `.env`.
If `.env` does not exist, it launches the interactive setup wizard first.

```bash
make test-launch
```

Starts a local mock VTT backend and launches Blastdoor against it.  
Default URLs:

- Gateway: `http://127.0.0.1:8080`
- Mock VTT: `http://127.0.0.1:33100`
- Password store: `mock/password-store.json`

Debug launch with forced password authentication:

```bash
make debug-launch
```

This runs with `DEBUG_MODE=true` and forces auth to:

- Username: `gm` (or `DEBUG_FORCED_USERNAME`)
- Password: `R@ndomPa55w0rd!` (or `DEBUG_FORCED_PASSWORD`)

Enable verbose debug logging to terminal and logfile:

```bash
make test-launch DEBUG_MODE=true DEBUG_LOG_FILE=logs/test-launch-debug.log
```

Debug logs never include plaintext passwords and only include hashed user fingerprints.
Each HTTP response includes `x-request-id` so you can match browser failures to logfile entries.

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
