#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { authenticator } from "otplib";
import { createPasswordHash } from "../src/security.js";
import { BlastdoorDatabase, BlastdoorPostgresDatabase } from "../src/database-store.js";

const __filename = fileURLToPath(import.meta.url);
const ENV_PATH = path.resolve(process.cwd(), ".env");
const DEFAULT_POSTGRES_CONTAINER = "blastdoor-postgres";
const DEFAULT_POSTGRES_IMAGE = "postgres:16";
const DEFAULT_POSTGRES_VOLUME = "blastdoor-postgres-data";

const defaults = {
  HOST: "0.0.0.0",
  PORT: "8080",
  FOUNDRY_TARGET: "http://127.0.0.1:30000",
  PASSWORD_STORE_MODE: "sqlite",
  PASSWORD_STORE_FILE: "mock/password-store.json",
  CONFIG_STORE_MODE: "sqlite",
  DATABASE_FILE: "data/blastdoor.sqlite",
  POSTGRES_URL: "postgres://blastdoor:blastdoor@127.0.0.1:5432/blastdoor",
  POSTGRES_SSL: "false",
  AUTH_USERNAME: "gm",
  COOKIE_SECURE: "true",
  TRUST_PROXY: "1",
  SESSION_MAX_AGE_HOURS: "12",
  LOGIN_RATE_LIMIT_WINDOW_MS: "900000",
  LOGIN_RATE_LIMIT_MAX: "8",
  REQUIRE_TOTP: "true",
  PROXY_TLS_VERIFY: "true",
  ALLOWED_ORIGINS: "",
  ALLOW_NULL_ORIGIN: "false",
  DEBUG_MODE: "false",
  DEBUG_LOG_FILE: "logs/blastdoor-debug.log",
};

function formatDefault(value) {
  if (value === "") {
    return "empty";
  }

  return value;
}

function normalizeBoolean(value, fallback) {
  if (value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return "true";
  }

  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return "false";
  }

  return fallback;
}

function formatEnvValue(value) {
  if (value === "") {
    return "";
  }

  if (/^[A-Za-z0-9_./,:@+-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

export function normalizeDbBackendChoice(value, fallback = "sqlite") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (["a", "sqlite", "sqlite3", "sql-lite", "sql_lite"].includes(normalized)) {
    return "sqlite";
  }

  if (["b", "postgres", "postgresql", "pg"].includes(normalized)) {
    return "postgres";
  }

  if (["none", "env"].includes(normalized)) {
    return "none";
  }

  return fallback;
}

export function normalizePostgresRecoveryChoice(value, fallback = "1") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "url", "u", "specify", "specify-url"].includes(normalized)) {
    return "1";
  }

  if (["2", "install", "i"].includes(normalized)) {
    return "2";
  }

  return fallback;
}

export function normalizePostgresInstallChoice(value, fallback = "1") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "docker", "d"].includes(normalized)) {
    return "1";
  }

  if (["2", "local", "l", "apt"].includes(normalized)) {
    return "2";
  }

  return fallback;
}

export function formatPostgresSetupError(error, postgresUrl) {
  const code = error && typeof error === "object" ? error.code : null;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ECONNREFUSED") {
    return [
      `Unable to connect to PostgreSQL at ${postgresUrl}.`,
      "Connection was refused by the server (ECONNREFUSED).",
      "Start PostgreSQL and verify host/port/database/user in POSTGRES_URL, then run 'make setup-env' again.",
    ].join(" ");
  }

  if (message.includes("Connection terminated unexpectedly")) {
    return [
      `Unable to connect to PostgreSQL at ${postgresUrl}.`,
      "Connection was terminated unexpectedly; PostgreSQL may still be starting.",
      "Wait a few seconds and retry, or rerun setup.",
    ].join(" ");
  }

  return `PostgreSQL initialization failed for ${postgresUrl}: ${message}`;
}

function isEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }

  return path.resolve(process.argv[1]) === __filename;
}

async function prompt(rl, label, fallback) {
  const answer = await rl.question(`${label} [${formatDefault(fallback)}]: `);
  if (answer.trim() === "") {
    return fallback;
  }

  return answer.trim();
}

async function promptRequired(rl, label, fallback) {
  // Keep prompting until a non-empty value is returned.
  while (true) {
    const value = await prompt(rl, label, fallback);
    if (value !== "") {
      return value;
    }

    output.write(`${label} cannot be empty.\n`);
  }
}

async function promptPassword(rl, label) {
  if (!input.isTTY) {
    return promptRequired(rl, label, "");
  }

  while (true) {
    output.write(`${label}: `);

    const value = await new Promise((resolve) => {
      let secret = "";

      input.setRawMode(true);
      input.resume();
      input.setEncoding("utf8");

      const onData = (chunk) => {
        if (chunk === "\u0003") {
          input.removeListener("data", onData);
          input.setRawMode(false);
          output.write("\n");
          process.exit(130);
        }

        if (chunk === "\r" || chunk === "\n") {
          input.removeListener("data", onData);
          input.setRawMode(false);
          output.write("\n");
          resolve(secret);
          return;
        }

        if (chunk === "\u007f" || chunk === "\b") {
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
          }
          return;
        }

        secret += chunk;
      };

      input.on("data", onData);
    });

    if (value.length < 12) {
      output.write("Password must be at least 12 characters. Please try again.\n");
      continue;
    }

    return value;
  }
}

async function maybeGenerateSecret(rl, label) {
  const useGenerated = normalizeBoolean(
    await prompt(rl, `${label} (auto-generate? true/false)`, "true"),
    "true",
  );

  if (useGenerated === "true") {
    return crypto.randomBytes(48).toString("base64url");
  }

  return promptRequired(rl, `${label} value`, "");
}

async function writeFilePasswordStore(filePath, username, passwordHash, totpSecret) {
  const absolutePath = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  const payload = {
    users: [
      {
        username,
        passwordHash,
      },
    ],
  };

  if (totpSecret) {
    payload.users[0].totpSecret = totpSecret;
  }

  await fs.writeFile(`${absolutePath}`, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeSqliteData(databaseFile, config, envContent) {
  const database = new BlastdoorDatabase({ filePath: databaseFile });
  try {
    if (config.PASSWORD_STORE_MODE === "sqlite") {
      database.upsertUser({
        username: config.AUTH_USERNAME,
        passwordHash: config.AUTH_PASSWORD_HASH,
        totpSecret: config.REQUIRE_TOTP === "true" ? config.TOTP_SECRET : null,
        disabled: false,
      });
    }

    if (config.CONFIG_STORE_MODE === "sqlite") {
      database.upsertConfigFile(".env", envContent);
      const examplePath = path.resolve(process.cwd(), ".env.example");
      try {
        const envExample = await fs.readFile(examplePath, "utf8");
        database.upsertConfigFile(".env.example", envExample);
      } catch {
        // Ignore missing .env.example
      }

      for (const [key, value] of Object.entries(config)) {
        if (key === "AUTH_PASSWORD_HASH") {
          continue;
        }

        database.setConfigValue(key, String(value));
      }
    }
  } finally {
    database.close();
  }
}

async function writePostgresData(connectionString, ssl, config, envContent) {
  const database = new BlastdoorPostgresDatabase({
    connectionString,
    ssl: ssl === "true",
  });
  try {
    if (config.PASSWORD_STORE_MODE === "postgres") {
      await database.upsertUser({
        username: config.AUTH_USERNAME,
        passwordHash: config.AUTH_PASSWORD_HASH,
        totpSecret: config.REQUIRE_TOTP === "true" ? config.TOTP_SECRET : null,
        disabled: false,
      });
    }

    if (config.CONFIG_STORE_MODE === "postgres") {
      await database.upsertConfigFile(".env", envContent);
      const examplePath = path.resolve(process.cwd(), ".env.example");
      try {
        const envExample = await fs.readFile(examplePath, "utf8");
        await database.upsertConfigFile(".env.example", envExample);
      } catch {
        // Ignore missing .env.example
      }

      for (const [key, value] of Object.entries(config)) {
        if (key === "AUTH_PASSWORD_HASH") {
          continue;
        }

        await database.setConfigValue(key, String(value));
      }
    }
  } finally {
    await database.close();
  }
}

function runShellCommand(command, { inherit = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: inherit ? "inherit" : "pipe",
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }

    child.on("error", (error) => {
      resolve({ ok: false, code: -1, stdout, stderr, error });
    });

    child.on("close", (code) => {
      resolve({ ok: code === 0, code: typeof code === "number" ? code : -1, stdout, stderr });
    });
  });
}

async function commandExists(command) {
  const result = await runShellCommand(`command -v ${command}`);
  return result.ok;
}

async function probePostgresConnection(postgresUrl, postgresSsl) {
  const database = new BlastdoorPostgresDatabase({
    connectionString: postgresUrl,
    ssl: postgresSsl === "true",
  });

  try {
    await database.ensureReady();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  } finally {
    await database.close().catch(() => {});
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPostgresReady(postgresUrl, postgresSsl, options = {}) {
  const attempts = Number.isInteger(options.attempts) ? options.attempts : 30;
  const delayMs = Number.isInteger(options.delayMs) ? options.delayMs : 1000;

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const probe = await probePostgresConnection(postgresUrl, postgresSsl);
    if (probe.ok) {
      return { ok: true };
    }

    lastError = probe.error;
    if (attempt < attempts) {
      await delay(delayMs);
    }
  }

  return { ok: false, error: lastError };
}

export function buildDockerPostgresRunCommand() {
  return [
    "docker run -d",
    "--restart unless-stopped",
    `--name ${DEFAULT_POSTGRES_CONTAINER}`,
    `-v ${DEFAULT_POSTGRES_VOLUME}:/var/lib/postgresql/data`,
    "-e POSTGRES_USER=blastdoor",
    "-e POSTGRES_PASSWORD=blastdoor",
    "-e POSTGRES_DB=blastdoor",
    "-p 5432:5432",
    DEFAULT_POSTGRES_IMAGE,
  ].join(" ");
}

async function installPostgresWithDocker() {
  const hasDocker = await commandExists("docker");
  if (!hasDocker) {
    return { ok: false, message: "Docker is not installed or not on PATH." };
  }

  const inspect = await runShellCommand(`docker container inspect ${DEFAULT_POSTGRES_CONTAINER} >/dev/null 2>&1`);
  if (inspect.ok) {
    const startResult = await runShellCommand(`docker start ${DEFAULT_POSTGRES_CONTAINER}`, { inherit: true });
    if (!startResult.ok) {
      return { ok: false, message: `Failed to start existing container '${DEFAULT_POSTGRES_CONTAINER}'.` };
    }

    return { ok: true, message: `Started Docker container '${DEFAULT_POSTGRES_CONTAINER}'.` };
  }

  const runCommand = buildDockerPostgresRunCommand();

  const runResult = await runShellCommand(runCommand, { inherit: true });
  if (!runResult.ok) {
    return {
      ok: false,
      message: `Failed to start Docker PostgreSQL container '${DEFAULT_POSTGRES_CONTAINER}'.`,
    };
  }

  return { ok: true, message: `Docker PostgreSQL container '${DEFAULT_POSTGRES_CONTAINER}' is running.` };
}

async function installPostgresLocally() {
  if (process.platform !== "linux") {
    return {
      ok: false,
      message: "Local automated PostgreSQL install is only supported for Linux/WSL in this setup script.",
    };
  }

  const installResult = await runShellCommand("sudo apt-get update && sudo apt-get install -y postgresql", {
    inherit: true,
  });
  if (!installResult.ok) {
    return { ok: false, message: "Failed to install PostgreSQL packages via apt-get." };
  }

  const startResult = await runShellCommand("sudo service postgresql start || sudo systemctl start postgresql", {
    inherit: true,
  });
  if (!startResult.ok) {
    return { ok: false, message: "Failed to start PostgreSQL service." };
  }

  const createUser = [
    "sudo -u postgres psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='blastdoor'\" | grep -q 1",
    "|| sudo -u postgres psql -c \"CREATE USER blastdoor WITH PASSWORD 'blastdoor';\"",
  ].join(" ");
  const userResult = await runShellCommand(createUser, { inherit: true });
  if (!userResult.ok) {
    return { ok: false, message: "Failed to create/update PostgreSQL role 'blastdoor'." };
  }

  const createDatabase = [
    "sudo -u postgres psql -tc \"SELECT 1 FROM pg_database WHERE datname='blastdoor'\" | grep -q 1",
    "|| sudo -u postgres psql -c \"CREATE DATABASE blastdoor OWNER blastdoor;\"",
  ].join(" ");
  const dbResult = await runShellCommand(createDatabase, { inherit: true });
  if (!dbResult.ok) {
    return { ok: false, message: "Failed to create/update PostgreSQL database 'blastdoor'." };
  }

  return { ok: true, message: "PostgreSQL installed locally and initialized with blastdoor user/database." };
}

async function promptForPostgresRecovery(rl, config) {
  while (true) {
    const probe = await probePostgresConnection(config.POSTGRES_URL, config.POSTGRES_SSL);
    if (probe.ok) {
      output.write(`PostgreSQL detected at ${config.POSTGRES_URL}.\n`);
      return;
    }

    output.write(`\n${formatPostgresSetupError(probe.error, config.POSTGRES_URL)}\n`);
    output.write("Choose how to proceed:\n");
    output.write("  1) Specify a different POSTGRES_URL\n");
    output.write("  2) Install PostgreSQL\n");

    const recoveryChoice = normalizePostgresRecoveryChoice(
      await prompt(rl, "POSTGRES_RECOVERY (1=specify-url, 2=install)", "1"),
      "1",
    );

    if (recoveryChoice === "1") {
      config.POSTGRES_URL = await promptRequired(rl, "POSTGRES_URL", config.POSTGRES_URL);
      config.POSTGRES_SSL = normalizeBoolean(
        await prompt(rl, "POSTGRES_SSL", config.POSTGRES_SSL),
        config.POSTGRES_SSL,
      );
      continue;
    }

    const dockerAvailable = await commandExists("docker");
    let installChoice = "2";
    if (dockerAvailable) {
      output.write("Docker detected.\n");
      installChoice = normalizePostgresInstallChoice(
        await prompt(rl, "POSTGRES_INSTALL (1=docker, 2=local)", "1"),
        "1",
      );
    } else {
      output.write("Docker was not detected. Trying local install path.\n");
    }

    let installResult;
    if (installChoice === "1") {
      installResult = await installPostgresWithDocker();
      if (installResult.ok) {
        config.POSTGRES_URL = defaults.POSTGRES_URL;
        config.POSTGRES_SSL = "false";
      }
    } else {
      installResult = await installPostgresLocally();
      if (installResult.ok) {
        config.POSTGRES_URL = defaults.POSTGRES_URL;
        config.POSTGRES_SSL = "false";
      }
    }

    output.write(`${installResult.message}\n`);
    if (installResult.ok) {
      output.write("Waiting for PostgreSQL readiness...\n");
      const readiness = await waitForPostgresReady(config.POSTGRES_URL, config.POSTGRES_SSL, {
        attempts: 40,
        delayMs: 1000,
      });
      if (readiness.ok) {
        output.write(`PostgreSQL detected at ${config.POSTGRES_URL}.\n`);
        return;
      }

      output.write(`${formatPostgresSetupError(readiness.error, config.POSTGRES_URL)}\n`);
    }
  }
}

async function main() {
  const rl = readline.createInterface({ input, output });

  try {
    output.write("\nBlastdoor initial setup\n");
    output.write("No .env file was found. Answer prompts or press Enter to use defaults.\n\n");

    const config = {};
    config.HOST = await prompt(rl, "HOST", defaults.HOST);
    config.PORT = await prompt(rl, "PORT", defaults.PORT);
    config.FOUNDRY_TARGET = await prompt(rl, "FOUNDRY_TARGET", defaults.FOUNDRY_TARGET);
    output.write("\nDatabase backend options:\n");
    output.write("  A) sqlite   (local file database)\n");
    output.write("  B) postgres (PostgreSQL server)\n\n");
    const dbBackend = normalizeDbBackendChoice(
      await prompt(rl, "DB_BACKEND (A=sqlite, B=postgres, none)", "sqlite"),
      "sqlite",
    );
    let passwordModeDefault = defaults.PASSWORD_STORE_MODE;
    let configModeDefault = defaults.CONFIG_STORE_MODE;
    if (dbBackend === "postgres") {
      passwordModeDefault = "postgres";
      configModeDefault = "postgres";
    } else if (dbBackend === "none") {
      passwordModeDefault = "env";
      configModeDefault = "env";
    }

    config.PASSWORD_STORE_MODE = await prompt(
      rl,
      "PASSWORD_STORE_MODE (env|file|sqlite|postgres)",
      passwordModeDefault,
    );
    if (!["env", "file", "sqlite", "postgres"].includes(config.PASSWORD_STORE_MODE)) {
      config.PASSWORD_STORE_MODE = passwordModeDefault;
    }

    config.PASSWORD_STORE_FILE = await prompt(rl, "PASSWORD_STORE_FILE", defaults.PASSWORD_STORE_FILE);
    config.CONFIG_STORE_MODE = await prompt(rl, "CONFIG_STORE_MODE (env|sqlite|postgres)", configModeDefault);
    if (!["env", "sqlite", "postgres"].includes(config.CONFIG_STORE_MODE)) {
      config.CONFIG_STORE_MODE = configModeDefault;
    }

    if (config.PASSWORD_STORE_MODE === "sqlite" || config.CONFIG_STORE_MODE === "sqlite") {
      config.DATABASE_FILE = await prompt(rl, "DATABASE_FILE", defaults.DATABASE_FILE);
    } else {
      config.DATABASE_FILE = defaults.DATABASE_FILE;
    }

    if (config.PASSWORD_STORE_MODE === "postgres" || config.CONFIG_STORE_MODE === "postgres") {
      config.POSTGRES_URL = await promptRequired(rl, "POSTGRES_URL", defaults.POSTGRES_URL);
      config.POSTGRES_SSL = normalizeBoolean(await prompt(rl, "POSTGRES_SSL", defaults.POSTGRES_SSL), defaults.POSTGRES_SSL);
      await promptForPostgresRecovery(rl, config);
    } else {
      config.POSTGRES_URL = "";
      config.POSTGRES_SSL = defaults.POSTGRES_SSL;
    }

    const authUsername = await promptRequired(rl, "AUTH_USERNAME", defaults.AUTH_USERNAME);
    const password = await promptPassword(rl, "AUTH_PASSWORD");
    const passwordHash = createPasswordHash(password);

    config.AUTH_USERNAME = authUsername;
    config.AUTH_PASSWORD_HASH = passwordHash;

    config.SESSION_SECRET = await maybeGenerateSecret(rl, "SESSION_SECRET");
    config.COOKIE_SECURE = normalizeBoolean(await prompt(rl, "COOKIE_SECURE", defaults.COOKIE_SECURE), defaults.COOKIE_SECURE);
    config.TRUST_PROXY = await prompt(rl, "TRUST_PROXY", defaults.TRUST_PROXY);
    config.SESSION_MAX_AGE_HOURS = await prompt(rl, "SESSION_MAX_AGE_HOURS", defaults.SESSION_MAX_AGE_HOURS);
    config.LOGIN_RATE_LIMIT_WINDOW_MS = await prompt(
      rl,
      "LOGIN_RATE_LIMIT_WINDOW_MS",
      defaults.LOGIN_RATE_LIMIT_WINDOW_MS,
    );
    config.LOGIN_RATE_LIMIT_MAX = await prompt(rl, "LOGIN_RATE_LIMIT_MAX", defaults.LOGIN_RATE_LIMIT_MAX);
    config.REQUIRE_TOTP = normalizeBoolean(await prompt(rl, "REQUIRE_TOTP", defaults.REQUIRE_TOTP), defaults.REQUIRE_TOTP);

    if (config.REQUIRE_TOTP === "true") {
      const autoTotp = normalizeBoolean(await prompt(rl, "Auto-generate TOTP_SECRET", "true"), "true");
      if (autoTotp === "true") {
        config.TOTP_SECRET = authenticator.generateSecret();
      } else {
        config.TOTP_SECRET = await promptRequired(rl, "TOTP_SECRET", "");
      }
    } else {
      config.TOTP_SECRET = "";
    }

    config.PROXY_TLS_VERIFY = normalizeBoolean(
      await prompt(rl, "PROXY_TLS_VERIFY", defaults.PROXY_TLS_VERIFY),
      defaults.PROXY_TLS_VERIFY,
    );
    config.ALLOWED_ORIGINS = await prompt(rl, "ALLOWED_ORIGINS", defaults.ALLOWED_ORIGINS);
    config.ALLOW_NULL_ORIGIN = normalizeBoolean(
      await prompt(rl, "ALLOW_NULL_ORIGIN", defaults.ALLOW_NULL_ORIGIN),
      defaults.ALLOW_NULL_ORIGIN,
    );
    config.DEBUG_MODE = normalizeBoolean(await prompt(rl, "DEBUG_MODE", defaults.DEBUG_MODE), defaults.DEBUG_MODE);
    config.DEBUG_LOG_FILE = await prompt(rl, "DEBUG_LOG_FILE", defaults.DEBUG_LOG_FILE);

    const envContent = [
      `HOST=${formatEnvValue(config.HOST)}`,
      `PORT=${formatEnvValue(config.PORT)}`,
      "",
      `FOUNDRY_TARGET=${formatEnvValue(config.FOUNDRY_TARGET)}`,
      "",
      `PASSWORD_STORE_MODE=${formatEnvValue(config.PASSWORD_STORE_MODE)}`,
      `PASSWORD_STORE_FILE=${formatEnvValue(config.PASSWORD_STORE_FILE)}`,
      `CONFIG_STORE_MODE=${formatEnvValue(config.CONFIG_STORE_MODE)}`,
      `DATABASE_FILE=${formatEnvValue(config.DATABASE_FILE)}`,
      `POSTGRES_URL=${formatEnvValue(config.POSTGRES_URL)}`,
      `POSTGRES_SSL=${formatEnvValue(config.POSTGRES_SSL)}`,
      "",
      `AUTH_USERNAME=${formatEnvValue(config.AUTH_USERNAME)}`,
      `AUTH_PASSWORD_HASH=${formatEnvValue(config.AUTH_PASSWORD_HASH)}`,
      "",
      `SESSION_SECRET=${formatEnvValue(config.SESSION_SECRET)}`,
      "",
      `COOKIE_SECURE=${formatEnvValue(config.COOKIE_SECURE)}`,
      `TRUST_PROXY=${formatEnvValue(config.TRUST_PROXY)}`,
      `SESSION_MAX_AGE_HOURS=${formatEnvValue(config.SESSION_MAX_AGE_HOURS)}`,
      `LOGIN_RATE_LIMIT_WINDOW_MS=${formatEnvValue(config.LOGIN_RATE_LIMIT_WINDOW_MS)}`,
      `LOGIN_RATE_LIMIT_MAX=${formatEnvValue(config.LOGIN_RATE_LIMIT_MAX)}`,
      "",
      `REQUIRE_TOTP=${formatEnvValue(config.REQUIRE_TOTP)}`,
      `TOTP_SECRET=${formatEnvValue(config.TOTP_SECRET)}`,
      "",
      `PROXY_TLS_VERIFY=${formatEnvValue(config.PROXY_TLS_VERIFY)}`,
      `ALLOWED_ORIGINS=${formatEnvValue(config.ALLOWED_ORIGINS)}`,
      `ALLOW_NULL_ORIGIN=${formatEnvValue(config.ALLOW_NULL_ORIGIN)}`,
      "",
      `DEBUG_MODE=${formatEnvValue(config.DEBUG_MODE)}`,
      `DEBUG_LOG_FILE=${formatEnvValue(config.DEBUG_LOG_FILE)}`,
      "",
    ].join("\n");

    await fs.writeFile(ENV_PATH, envContent, "utf8");

    if (config.PASSWORD_STORE_MODE === "file") {
      await writeFilePasswordStore(
        config.PASSWORD_STORE_FILE,
        config.AUTH_USERNAME,
        config.AUTH_PASSWORD_HASH,
        config.REQUIRE_TOTP === "true" ? config.TOTP_SECRET : "",
      );
      output.write(`\nPassword store file updated: ${path.resolve(config.PASSWORD_STORE_FILE)}\n`);
    }

    if (config.PASSWORD_STORE_MODE === "sqlite" || config.CONFIG_STORE_MODE === "sqlite") {
      await writeSqliteData(config.DATABASE_FILE, config, envContent);
      output.write(`SQLite database updated: ${path.resolve(config.DATABASE_FILE)}\n`);
    }

    if (config.PASSWORD_STORE_MODE === "postgres" || config.CONFIG_STORE_MODE === "postgres") {
      try {
        await writePostgresData(config.POSTGRES_URL, config.POSTGRES_SSL, config, envContent);
        output.write("PostgreSQL database updated.\n");
      } catch (error) {
        throw new Error(formatPostgresSetupError(error, config.POSTGRES_URL));
      }
    }

    output.write(`\nCreated ${ENV_PATH}\n`);
    output.write("Setup complete. Launching Blastdoor now.\n\n");
  } finally {
    rl.close();
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error(`Setup failed: ${error.message}`);
    process.exit(1);
  });
}
