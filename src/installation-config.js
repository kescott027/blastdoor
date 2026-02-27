import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

export const INSTALLATION_CONFIG_VERSION = 1;

const INSTALL_TYPES = new Set(["local", "container"]);
const PLATFORM_TYPES = new Set(["wsl", "mac", "linux"]);
const DATABASE_TYPES = new Set(["sqlite", "postgres"]);
const OBJECT_STORAGE_TYPES = new Set(["local", "gdrive", "s3"]);
const FOUNDRY_MODES = new Set(["local", "external"]);

const LOCAL_ENV_ORDER = [
  "HOST",
  "PORT",
  "FOUNDRY_TARGET",
  "PASSWORD_STORE_MODE",
  "PASSWORD_STORE_FILE",
  "CONFIG_STORE_MODE",
  "DATABASE_FILE",
  "POSTGRES_URL",
  "POSTGRES_SSL",
  "AUTH_USERNAME",
  "AUTH_PASSWORD_HASH",
  "SESSION_SECRET",
  "COOKIE_SECURE",
  "TRUST_PROXY",
  "SESSION_MAX_AGE_HOURS",
  "LOGIN_RATE_LIMIT_WINDOW_MS",
  "LOGIN_RATE_LIMIT_MAX",
  "REQUIRE_TOTP",
  "TOTP_SECRET",
  "PROXY_TLS_VERIFY",
  "ALLOWED_ORIGINS",
  "ALLOW_NULL_ORIGIN",
  "GRAPHICS_CACHE_ENABLED",
  "BLASTDOOR_API_URL",
  "BLASTDOOR_API_TOKEN",
  "BLASTDOOR_API_TIMEOUT_MS",
  "BLASTDOOR_API_RETRY_MAX_ATTEMPTS",
  "BLASTDOOR_API_RETRY_BASE_DELAY_MS",
  "BLASTDOOR_API_RETRY_MAX_DELAY_MS",
  "BLASTDOOR_API_CIRCUIT_FAILURE_THRESHOLD",
  "BLASTDOOR_API_CIRCUIT_RESET_MS",
  "BLAST_DOORS_CLOSED",
  "OBJECT_STORAGE_MODE",
  "INSTALL_PROFILE",
  "MANAGER_HOST",
  "MANAGER_PORT",
  "BLASTDOOR_API_HOST",
  "BLASTDOOR_API_PORT",
  "DEBUG_MODE",
  "DEBUG_LOG_FILE",
];

const DOCKER_ENV_ORDER = [
  "BLASTDOOR_DOMAIN",
  "LETSENCRYPT_EMAIL",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "HOST",
  "PORT",
  "FOUNDRY_TARGET",
  "PASSWORD_STORE_MODE",
  "PASSWORD_STORE_FILE",
  "CONFIG_STORE_MODE",
  "DATABASE_FILE",
  "POSTGRES_URL",
  "POSTGRES_SSL",
  "AUTH_USERNAME",
  "AUTH_PASSWORD_HASH",
  "SESSION_SECRET",
  "COOKIE_SECURE",
  "TRUST_PROXY",
  "SESSION_MAX_AGE_HOURS",
  "LOGIN_RATE_LIMIT_WINDOW_MS",
  "LOGIN_RATE_LIMIT_MAX",
  "REQUIRE_TOTP",
  "TOTP_SECRET",
  "PROXY_TLS_VERIFY",
  "ALLOWED_ORIGINS",
  "ALLOW_NULL_ORIGIN",
  "GRAPHICS_CACHE_ENABLED",
  "BLASTDOOR_API_URL",
  "BLASTDOOR_API_TOKEN",
  "BLASTDOOR_API_TIMEOUT_MS",
  "BLASTDOOR_API_RETRY_MAX_ATTEMPTS",
  "BLASTDOOR_API_RETRY_BASE_DELAY_MS",
  "BLASTDOOR_API_RETRY_MAX_DELAY_MS",
  "BLASTDOOR_API_CIRCUIT_FAILURE_THRESHOLD",
  "BLASTDOOR_API_CIRCUIT_RESET_MS",
  "BLAST_DOORS_CLOSED",
  "OBJECT_STORAGE_MODE",
  "INSTALL_PROFILE",
  "BLASTDOOR_API_HOST",
  "BLASTDOOR_API_PORT",
  "DEBUG_MODE",
  "DEBUG_LOG_FILE",
];

function asInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return parsed;
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  if (allowed.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeHost(value, fallback = "127.0.0.1") {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return fallback;
  }
  return normalized;
}

function normalizePort(value, fallback) {
  const parsed = asInt(value, fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function formatEnvValue(value) {
  if (value === undefined || value === null) {
    return "";
  }
  const stringValue = String(value);
  if (stringValue === "") {
    return "";
  }
  if (/^[A-Za-z0-9_./,:@+-]+$/.test(stringValue)) {
    return stringValue;
  }
  return JSON.stringify(stringValue);
}

export function detectPlatformType(env = process.env) {
  if (env.WSL_DISTRO_NAME) {
    return "wsl";
  }
  if (process.platform === "darwin") {
    return "mac";
  }
  return "linux";
}

export function defaultInstallationConfig(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: INSTALLATION_CONFIG_VERSION,
    installType: "local",
    platform: detectPlatformType(),
    database: "sqlite",
    objectStorage: "local",
    foundryMode: "local",
    foundryLocalHost: "127.0.0.1",
    foundryLocalPort: 30000,
    foundryExternalIp: "",
    foundryExternalPort: 30000,
    gatewayHost: "0.0.0.0",
    gatewayPort: 8080,
    managerHost: "127.0.0.1",
    managerPort: 8090,
    apiHost: "127.0.0.1",
    apiPort: 8070,
    useExternalBlastdoorApi: false,
    blastdoorApiUrl: "",
    blastdoorApiToken: "",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function normalizeInstallationConfig(input = {}, existing = null) {
  const base = existing && typeof existing === "object" ? { ...existing } : defaultInstallationConfig();
  const source = input && typeof input === "object" ? input : {};
  const merged = {
    ...base,
    ...source,
  };

  const normalized = {
    schemaVersion: INSTALLATION_CONFIG_VERSION,
    installType: normalizeEnum(merged.installType, INSTALL_TYPES, "local"),
    platform: normalizeEnum(merged.platform, PLATFORM_TYPES, detectPlatformType()),
    database: normalizeEnum(merged.database, DATABASE_TYPES, "sqlite"),
    objectStorage: normalizeEnum(merged.objectStorage, OBJECT_STORAGE_TYPES, "local"),
    foundryMode: normalizeEnum(merged.foundryMode, FOUNDRY_MODES, "local"),
    foundryLocalHost: normalizeHost(merged.foundryLocalHost, "127.0.0.1"),
    foundryLocalPort: normalizePort(merged.foundryLocalPort, 30000),
    foundryExternalIp: normalizeHost(merged.foundryExternalIp, ""),
    foundryExternalPort: normalizePort(merged.foundryExternalPort, 30000),
    gatewayHost: normalizeHost(merged.gatewayHost, "0.0.0.0"),
    gatewayPort: normalizePort(merged.gatewayPort, 8080),
    managerHost: normalizeHost(merged.managerHost, "127.0.0.1"),
    managerPort: normalizePort(merged.managerPort, 8090),
    apiHost: normalizeHost(merged.apiHost, "127.0.0.1"),
    apiPort: normalizePort(merged.apiPort, 8070),
    useExternalBlastdoorApi: String(merged.useExternalBlastdoorApi).toLowerCase() === "true" || merged.useExternalBlastdoorApi === true,
    blastdoorApiUrl: String(merged.blastdoorApiUrl || "").trim(),
    blastdoorApiToken: String(merged.blastdoorApiToken || "").trim(),
    createdAt: String(base.createdAt || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };

  if (normalized.foundryMode === "external" && !normalized.foundryExternalIp) {
    throw new Error("External Foundry mode requires foundryExternalIp.");
  }

  if (normalized.useExternalBlastdoorApi && !normalized.blastdoorApiUrl) {
    throw new Error("External Blastdoor API mode requires blastdoorApiUrl.");
  }

  return normalized;
}

export function buildFoundryTarget(config) {
  const mode = normalizeEnum(config?.foundryMode, FOUNDRY_MODES, "local");
  if (mode === "external") {
    const host = normalizeHost(config?.foundryExternalIp, "");
    const port = normalizePort(config?.foundryExternalPort, 30000);
    if (!host) {
      throw new Error("Foundry external host is required.");
    }
    return `http://${host}:${port}`;
  }

  const host = normalizeHost(config?.foundryLocalHost, "127.0.0.1");
  const port = normalizePort(config?.foundryLocalPort, 30000);
  return `http://${host}:${port}`;
}

async function readEnvFileObject(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return dotenv.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function normalizeFoundryHostForDocker(config) {
  if (normalizeEnum(config?.foundryMode, FOUNDRY_MODES, "local") === "external") {
    return normalizeHost(config?.foundryExternalIp, "");
  }

  const host = normalizeHost(config?.foundryLocalHost, "127.0.0.1").toLowerCase();
  if (["127.0.0.1", "localhost", "0.0.0.0"].includes(host)) {
    return "host.docker.internal";
  }
  return host;
}

function randomSecret(length = 48) {
  return crypto.randomBytes(length).toString("base64url");
}

function buildCommonEnvValues(config, existing = {}, { forDocker = false } = {}) {
  const database = normalizeEnum(config.database, DATABASE_TYPES, "sqlite");
  const objectStorage = normalizeEnum(config.objectStorage, OBJECT_STORAGE_TYPES, "local");
  const blastdoorApiUrl = config.useExternalBlastdoorApi ? String(config.blastdoorApiUrl || "").trim() : "";
  const foundryTarget = forDocker
    ? `http://${normalizeFoundryHostForDocker(config)}:${
        normalizeEnum(config?.foundryMode, FOUNDRY_MODES, "local") === "external"
          ? normalizePort(config?.foundryExternalPort, 30000)
          : normalizePort(config?.foundryLocalPort, 30000)
      }`
    : buildFoundryTarget(config);

  const sessionSecret = String(existing.SESSION_SECRET || "").trim() || randomSecret(48);
  const postgresPassword = String(existing.POSTGRES_PASSWORD || "").trim() || "change-this-postgres-password";
  const postgresMode = database === "postgres";
  const postgresUrl =
    forDocker
      ? `postgres://blastdoor:${postgresPassword}@postgres:5432/blastdoor`
      : String(existing.POSTGRES_URL || "postgres://blastdoor:blastdoor@127.0.0.1:5432/blastdoor");

  const base = {
    HOST: config.gatewayHost,
    PORT: String(config.gatewayPort),
    FOUNDRY_TARGET: foundryTarget,
    PASSWORD_STORE_MODE: postgresMode ? "postgres" : "sqlite",
    PASSWORD_STORE_FILE: "mock/password-store.json",
    CONFIG_STORE_MODE: postgresMode ? "postgres" : "sqlite",
    DATABASE_FILE: "data/blastdoor.sqlite",
    POSTGRES_URL: postgresMode ? postgresUrl : "",
    POSTGRES_SSL: "false",
    AUTH_USERNAME: String(existing.AUTH_USERNAME || "gm"),
    AUTH_PASSWORD_HASH: String(existing.AUTH_PASSWORD_HASH || ""),
    SESSION_SECRET: sessionSecret,
    COOKIE_SECURE: forDocker ? "true" : "false",
    TRUST_PROXY: forDocker ? "1" : "false",
    SESSION_MAX_AGE_HOURS: String(existing.SESSION_MAX_AGE_HOURS || "12"),
    LOGIN_RATE_LIMIT_WINDOW_MS: String(existing.LOGIN_RATE_LIMIT_WINDOW_MS || "900000"),
    LOGIN_RATE_LIMIT_MAX: String(existing.LOGIN_RATE_LIMIT_MAX || "8"),
    REQUIRE_TOTP: String(existing.REQUIRE_TOTP || "false"),
    TOTP_SECRET: String(existing.TOTP_SECRET || ""),
    PROXY_TLS_VERIFY: "true",
    ALLOWED_ORIGINS: String(existing.ALLOWED_ORIGINS || ""),
    ALLOW_NULL_ORIGIN: String(existing.ALLOW_NULL_ORIGIN || "false"),
    GRAPHICS_CACHE_ENABLED: String(existing.GRAPHICS_CACHE_ENABLED || "true"),
    BLASTDOOR_API_URL: blastdoorApiUrl,
    BLASTDOOR_API_TOKEN: config.useExternalBlastdoorApi ? String(config.blastdoorApiToken || existing.BLASTDOOR_API_TOKEN || "") : "",
    BLASTDOOR_API_TIMEOUT_MS: String(existing.BLASTDOOR_API_TIMEOUT_MS || "2500"),
    BLASTDOOR_API_RETRY_MAX_ATTEMPTS: String(existing.BLASTDOOR_API_RETRY_MAX_ATTEMPTS || "3"),
    BLASTDOOR_API_RETRY_BASE_DELAY_MS: String(existing.BLASTDOOR_API_RETRY_BASE_DELAY_MS || "120"),
    BLASTDOOR_API_RETRY_MAX_DELAY_MS: String(existing.BLASTDOOR_API_RETRY_MAX_DELAY_MS || "1200"),
    BLASTDOOR_API_CIRCUIT_FAILURE_THRESHOLD: String(existing.BLASTDOOR_API_CIRCUIT_FAILURE_THRESHOLD || "5"),
    BLASTDOOR_API_CIRCUIT_RESET_MS: String(existing.BLASTDOOR_API_CIRCUIT_RESET_MS || "10000"),
    BLAST_DOORS_CLOSED: String(existing.BLAST_DOORS_CLOSED || "false"),
    OBJECT_STORAGE_MODE: objectStorage,
    INSTALL_PROFILE: config.installType,
    MANAGER_HOST: config.managerHost,
    MANAGER_PORT: String(config.managerPort),
    BLASTDOOR_API_HOST: config.apiHost,
    BLASTDOOR_API_PORT: String(config.apiPort),
    DEBUG_MODE: String(existing.DEBUG_MODE || "false"),
    DEBUG_LOG_FILE: String(existing.DEBUG_LOG_FILE || "logs/blastdoor-debug.log"),
  };

  return {
    ...existing,
    ...base,
  };
}

async function writeEnvObject(filePath, values, order) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const preferred = [];
  const seen = new Set();
  for (const key of order) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      preferred.push(key);
      seen.add(key);
    }
  }

  const extraKeys = Object.keys(values).filter((key) => !seen.has(key)).sort((a, b) => a.localeCompare(b));
  const lines = [...preferred, ...extraKeys].map((key) => `${key}=${formatEnvValue(values[key])}`);
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

export async function readInstallationConfig(configPath) {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeInstallationConfig(parsed, parsed);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.name === "SyntaxError")) {
      return null;
    }
    throw error;
  }
}

export async function writeInstallationConfig(configPath, config) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function syncRuntimeEnvFromInstallation({
  installationConfig,
  envPath,
  dockerEnvPath,
}) {
  const currentLocal = await readEnvFileObject(envPath);
  const currentDocker = await readEnvFileObject(dockerEnvPath);

  const localValues = buildCommonEnvValues(installationConfig, currentLocal, { forDocker: false });
  const dockerValues = buildCommonEnvValues(installationConfig, currentDocker, { forDocker: true });

  dockerValues.BLASTDOOR_DOMAIN = String(dockerValues.BLASTDOOR_DOMAIN || "blastdoor.example.com");
  dockerValues.LETSENCRYPT_EMAIL = String(dockerValues.LETSENCRYPT_EMAIL || "admin@example.com");
  dockerValues.POSTGRES_DB = String(dockerValues.POSTGRES_DB || "blastdoor");
  dockerValues.POSTGRES_USER = String(dockerValues.POSTGRES_USER || "blastdoor");
  dockerValues.POSTGRES_PASSWORD = String(dockerValues.POSTGRES_PASSWORD || "change-this-postgres-password");

  await writeEnvObject(envPath, localValues, LOCAL_ENV_ORDER);
  await writeEnvObject(dockerEnvPath, dockerValues, DOCKER_ENV_ORDER);

  return {
    localValues,
    dockerValues,
  };
}

