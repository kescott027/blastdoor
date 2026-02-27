import test from "node:test";
import assert from "node:assert/strict";
import { detectSelfProxyTarget, loadConfigFromEnv, validateConfig } from "../src/server.js";

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

test("loadConfigFromEnv parses GRAPHICS_CACHE_ENABLED", () => {
  const enabled = loadConfigFromEnv({
    FOUNDRY_TARGET: "http://127.0.0.1:30000",
    SESSION_SECRET: "x".repeat(48),
    AUTH_USERNAME: "gm",
    AUTH_PASSWORD_HASH: "scrypt$a$b",
    REQUIRE_TOTP: "false",
    GRAPHICS_CACHE_ENABLED: "true",
  });
  assert.equal(enabled.graphicsCacheEnabled, true);

  const disabled = loadConfigFromEnv({
    FOUNDRY_TARGET: "http://127.0.0.1:30000",
    SESSION_SECRET: "x".repeat(48),
    AUTH_USERNAME: "gm",
    AUTH_PASSWORD_HASH: "scrypt$a$b",
    REQUIRE_TOTP: "false",
    GRAPHICS_CACHE_ENABLED: "false",
  });
  assert.equal(disabled.graphicsCacheEnabled, false);
});

test("loadConfigFromEnv parses blastdoor-api retry settings", () => {
  const config = loadConfigFromEnv({
    FOUNDRY_TARGET: "http://127.0.0.1:30000",
    SESSION_SECRET: "x".repeat(48),
    AUTH_USERNAME: "gm",
    AUTH_PASSWORD_HASH: "scrypt$a$b",
    REQUIRE_TOTP: "false",
    BLASTDOOR_API_TIMEOUT_MS: "1500",
    BLASTDOOR_API_RETRY_MAX_ATTEMPTS: "4",
    BLASTDOOR_API_RETRY_BASE_DELAY_MS: "50",
    BLASTDOOR_API_RETRY_MAX_DELAY_MS: "500",
    BLASTDOOR_API_CIRCUIT_FAILURE_THRESHOLD: "3",
    BLASTDOOR_API_CIRCUIT_RESET_MS: "9000",
  });

  assert.equal(config.blastdoorApiTimeoutMs, 1500);
  assert.equal(config.blastdoorApiRetryMaxAttempts, 4);
  assert.equal(config.blastdoorApiRetryBaseDelayMs, 50);
  assert.equal(config.blastdoorApiRetryMaxDelayMs, 500);
  assert.equal(config.blastdoorApiCircuitFailureThreshold, 3);
  assert.equal(config.blastdoorApiCircuitResetMs, 9000);
  validateConfig(config);
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

test("validateConfig rejects self-targeting Foundry URL", () => {
  assert.throws(
    () =>
      validateConfig({
        host: "127.0.0.1",
        port: 8080,
        foundryTarget: "http://localhost:8080",
        authUsername: "gm",
        authPasswordHash: "scrypt$a$b",
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
        passwordStoreMode: "env",
        passwordStoreFile: "",
      }),
    /FOUNDRY_TARGET points to this Blastdoor gateway/,
  );
});

test("detectSelfProxyTarget allows remote target on same port", () => {
  const check = detectSelfProxyTarget({
    host: "127.0.0.1",
    port: 8080,
    foundryTarget: "http://203.0.113.10:8080",
  });

  assert.equal(check.isSelfTarget, false);
});

test("loadConfigFromEnv parses TLS fields and validateConfig enforces cert/key when enabled", () => {
  const config = loadConfigFromEnv({
    FOUNDRY_TARGET: "http://127.0.0.1:30000",
    SESSION_SECRET: "x".repeat(48),
    AUTH_USERNAME: "gm",
    AUTH_PASSWORD_HASH: "scrypt$a$b",
    REQUIRE_TOTP: "false",
    TLS_ENABLED: "true",
    TLS_DOMAIN: "vtt.example.test",
    TLS_EMAIL: "admin@example.test",
    TLS_CHALLENGE_METHOD: "webroot",
    TLS_WEBROOT_PATH: "/var/www/html",
    TLS_CERT_FILE: "/etc/letsencrypt/live/vtt.example.test/fullchain.pem",
    TLS_KEY_FILE: "/etc/letsencrypt/live/vtt.example.test/privkey.pem",
  });

  assert.equal(config.tlsEnabled, true);
  assert.equal(config.tlsDomain, "vtt.example.test");
  assert.equal(config.tlsChallengeMethod, "webroot");
  validateConfig(config);

  assert.throws(
    () =>
      validateConfig({
        ...config,
        tlsEnabled: true,
        tlsCertFile: "",
        tlsKeyFile: "",
      }),
    /TLS_CERT_FILE and TLS_KEY_FILE are required/,
  );
});
