#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { authenticator } from "otplib";
import { createPasswordHash } from "../src/security.js";
import { BlastdoorDatabase, BlastdoorPostgresDatabase } from "../src/database-store.js";

const ENV_PATH = path.resolve(process.cwd(), ".env");

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
    const dbBackend = (await prompt(rl, "DB_BACKEND (sqlite|postgres|none)", "sqlite")).toLowerCase();
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
      await writePostgresData(config.POSTGRES_URL, config.POSTGRES_SSL, config, envContent);
      output.write("PostgreSQL database updated.\n");
    }

    output.write(`\nCreated ${ENV_PATH}\n`);
    output.write("Setup complete. Launching Blastdoor now.\n\n");
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`Setup failed: ${error.message}`);
  process.exit(1);
});
