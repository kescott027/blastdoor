import test from "node:test";
import assert from "node:assert/strict";
import { loadConfigFromEnv, validateConfig } from "../src/server.js";

test("loadConfigFromEnv supports sqlite store defaults", () => {
  const config = loadConfigFromEnv({
    FOUNDRY_TARGET: "http://127.0.0.1:30000",
    SESSION_SECRET: "x".repeat(48),
    PASSWORD_STORE_MODE: "sqlite",
    CONFIG_STORE_MODE: "sqlite",
    DATABASE_FILE: "data/blastdoor.sqlite",
    REQUIRE_TOTP: "false",
  });

  assert.equal(config.passwordStoreMode, "sqlite");
  assert.equal(config.configStoreMode, "sqlite");
  assert.equal(config.databaseFile, "data/blastdoor.sqlite");
});

test("validateConfig requires database file for sqlite-backed stores", () => {
  assert.throws(
    () =>
      validateConfig({
        host: "127.0.0.1",
        port: 8080,
        foundryTarget: "http://127.0.0.1:30000",
        authUsername: "",
        authPasswordHash: "",
        requireTotp: false,
        totpSecret: "",
        sessionSecret: "x".repeat(48),
        sessionMaxAgeHours: 12,
        cookieSecure: false,
        trustProxy: false,
        proxyTlsVerify: true,
        loginRateLimitWindowMs: 900000,
        loginRateLimitMax: 8,
        debugMode: false,
        debugLogFile: "logs/blastdoor-debug.log",
        allowedOrigins: "",
        allowNullOrigin: false,
        configStoreMode: "env",
        databaseFile: "",
        postgresUrl: "",
        postgresSsl: false,
        passwordStoreMode: "sqlite",
        passwordStoreFile: "",
      }),
    /DATABASE_FILE is required/,
  );
});

test("loadConfigFromEnv supports postgres store values", () => {
  const config = loadConfigFromEnv({
    FOUNDRY_TARGET: "http://127.0.0.1:30000",
    SESSION_SECRET: "x".repeat(48),
    PASSWORD_STORE_MODE: "postgres",
    CONFIG_STORE_MODE: "postgres",
    POSTGRES_URL: "postgres://blastdoor:test@localhost:5432/blastdoor",
    POSTGRES_SSL: "true",
    REQUIRE_TOTP: "false",
  });

  assert.equal(config.passwordStoreMode, "postgres");
  assert.equal(config.configStoreMode, "postgres");
  assert.equal(config.postgresUrl, "postgres://blastdoor:test@localhost:5432/blastdoor");
  assert.equal(config.postgresSsl, true);
});

test("loadConfigFromEnv parses BLAST_DOORS_CLOSED", () => {
  const enabled = loadConfigFromEnv({
    FOUNDRY_TARGET: "http://127.0.0.1:30000",
    SESSION_SECRET: "x".repeat(48),
    AUTH_USERNAME: "gm",
    AUTH_PASSWORD_HASH: "scrypt$a$b",
    REQUIRE_TOTP: "false",
    BLAST_DOORS_CLOSED: "true",
  });
  assert.equal(enabled.blastDoorsClosed, true);

  const disabled = loadConfigFromEnv({
    FOUNDRY_TARGET: "http://127.0.0.1:30000",
    SESSION_SECRET: "x".repeat(48),
    AUTH_USERNAME: "gm",
    AUTH_PASSWORD_HASH: "scrypt$a$b",
    REQUIRE_TOTP: "false",
  });
  assert.equal(disabled.blastDoorsClosed, false);
});

test("validateConfig requires postgres url for postgres-backed stores", () => {
  assert.throws(
    () =>
      validateConfig({
        host: "127.0.0.1",
        port: 8080,
        foundryTarget: "http://127.0.0.1:30000",
        authUsername: "",
        authPasswordHash: "",
        requireTotp: false,
        totpSecret: "",
        sessionSecret: "x".repeat(48),
        sessionMaxAgeHours: 12,
        cookieSecure: false,
        trustProxy: false,
        proxyTlsVerify: true,
        loginRateLimitWindowMs: 900000,
        loginRateLimitMax: 8,
        debugMode: false,
        debugLogFile: "logs/blastdoor-debug.log",
        allowedOrigins: "",
        allowNullOrigin: false,
        configStoreMode: "env",
        databaseFile: "",
        postgresUrl: "",
        postgresSsl: false,
        passwordStoreMode: "postgres",
        passwordStoreFile: "",
      }),
    /POSTGRES_URL is required/,
  );
});
