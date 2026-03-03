import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createPasswordHash, safeEqual, verifyPassword } from "./security.js";
import { validateConfig, loadConfigFromEnv, detectSelfProxyTarget } from "./server.js";
import { createBlastdoorApi } from "./blastdoor-api.js";
import { writeBlastDoorsState } from "./blastdoors-state.js";
import { appendFailureRecord, clearFailureStore, readFailureStore, summarizeFailureStore } from "./failure-store.js";
import { createEmailService, loadEmailConfigFromEnv } from "./email-service.js";
import {
  defaultInstallationConfig,
  detectPlatformType,
  normalizeInstallationConfig,
  readInstallationConfig,
  syncRuntimeEnvFromInstallation,
  writeInstallationConfig,
} from "./installation-config.js";
import { createPluginManager } from "./plugins/index.js";
import {
  createThemeId,
  mapThemeForClient,
  normalizeThemeAssetPath,
  normalizeThemeLayoutSettings,
} from "./login-theme.js";
import {
  normalizeManagerConsoleSettings,
  readManagerConsoleSettings,
  sanitizeManagerConsoleSettingsForClient,
  writeManagerConsoleSettings,
} from "./manager-console-settings.js";
import { readIntelligenceAgentStore } from "./intelligence-agent-store.js";
import { registerRemoteSupportRoutes } from "./manager/remote-support-routes.js";
import { registerDiagnosticsRoutes } from "./manager/diagnostics-routes.js";
import { registerManagerAuthRoutes } from "./manager/auth-routes.js";
import { registerManagerServiceRoutes } from "./manager/service-routes.js";
import { registerManagerOperationsRoutes } from "./manager/operations-routes.js";
import { registerManagerUserRoutes } from "./manager/users-routes.js";
import { registerManagerThemeRoutes } from "./manager/themes-routes.js";
import { registerManagerConfigRoutes } from "./manager/config-routes.js";
import { createConfigBackupService } from "./manager/config-backup-service.js";
import { createRemoteSupportService } from "./manager/remote-support-service.js";
import { createManagerAuthService } from "./manager/auth-session-service.js";
import { createControlPlaneStatusService } from "./manager/control-plane-service.js";
import { createManagerDiagnosticsService } from "./manager/diagnostics-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_MANAGER_HOST = process.env.MANAGER_HOST || "127.0.0.1";
const DEFAULT_MANAGER_PORT = Number.parseInt(process.env.MANAGER_PORT || "8090", 10);
const DEFAULT_THEME_ID = "blastdoor-default";
const pluginManager = createPluginManager({ env: process.env });

const BASE_CONFIG_FIELDS = [
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
  "TLS_ENABLED",
  "TLS_DOMAIN",
  "TLS_EMAIL",
  "TLS_CHALLENGE_METHOD",
  "TLS_WEBROOT_PATH",
  "TLS_CERT_FILE",
  "TLS_KEY_FILE",
  "TLS_CA_FILE",
  "TLS_PASSPHRASE",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "EMAIL_ADMIN_TO",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_IGNORE_TLS",
  "PUBLIC_BASE_URL",
  "DEBUG_MODE",
  "DEBUG_LOG_FILE",
];

const BASE_CONFIG_DEFAULTS = {
  HOST: "127.0.0.1",
  PORT: "8080",
  FOUNDRY_TARGET: "http://127.0.0.1:30000",
  PASSWORD_STORE_MODE: "env",
  PASSWORD_STORE_FILE: "mock/password-store.json",
  CONFIG_STORE_MODE: "env",
  DATABASE_FILE: "data/blastdoor.sqlite",
  POSTGRES_URL: "",
  POSTGRES_SSL: "false",
  AUTH_USERNAME: "gm",
  AUTH_PASSWORD_HASH: "",
  SESSION_SECRET: "",
  COOKIE_SECURE: "false",
  TRUST_PROXY: "false",
  SESSION_MAX_AGE_HOURS: "12",
  LOGIN_RATE_LIMIT_WINDOW_MS: "900000",
  LOGIN_RATE_LIMIT_MAX: "8",
  REQUIRE_TOTP: "false",
  TOTP_SECRET: "",
  PROXY_TLS_VERIFY: "true",
  ALLOWED_ORIGINS: "",
  ALLOW_NULL_ORIGIN: "true",
  GRAPHICS_CACHE_ENABLED: "true",
  BLASTDOOR_API_URL: "",
  BLASTDOOR_API_TOKEN: "",
  BLASTDOOR_API_TIMEOUT_MS: "2500",
  BLASTDOOR_API_RETRY_MAX_ATTEMPTS: "3",
  BLASTDOOR_API_RETRY_BASE_DELAY_MS: "120",
  BLASTDOOR_API_RETRY_MAX_DELAY_MS: "1200",
  BLASTDOOR_API_CIRCUIT_FAILURE_THRESHOLD: "5",
  BLASTDOOR_API_CIRCUIT_RESET_MS: "10000",
  BLAST_DOORS_CLOSED: "false",
  TLS_ENABLED: "false",
  TLS_DOMAIN: "",
  TLS_EMAIL: "",
  TLS_CHALLENGE_METHOD: "webroot",
  TLS_WEBROOT_PATH: "/var/www/html",
  TLS_CERT_FILE: "",
  TLS_KEY_FILE: "",
  TLS_CA_FILE: "",
  TLS_PASSPHRASE: "",
  EMAIL_PROVIDER: "disabled",
  EMAIL_FROM: "",
  EMAIL_ADMIN_TO: "",
  SMTP_HOST: "",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: "",
  SMTP_PASS: "",
  SMTP_IGNORE_TLS: "false",
  PUBLIC_BASE_URL: "",
  DEBUG_MODE: "true",
  DEBUG_LOG_FILE: "logs/blastdoor-debug.log",
};

const BASE_SENSITIVE_CONFIG_KEYS = [
  "AUTH_PASSWORD_HASH",
  "SESSION_SECRET",
  "TOTP_SECRET",
  "TLS_PASSPHRASE",
  "BLASTDOOR_API_TOKEN",
  "SMTP_PASS",
];
const managerPluginConfig = pluginManager.getManagerConfigExtensions();
const CONFIG_FIELDS = [...BASE_CONFIG_FIELDS, ...managerPluginConfig.fields];
const CONFIG_DEFAULTS = {
  ...BASE_CONFIG_DEFAULTS,
  ...managerPluginConfig.defaults,
};
const SENSITIVE_CONFIG_KEYS = new Set([...BASE_SENSITIVE_CONFIG_KEYS, ...managerPluginConfig.sensitiveKeys]);
const REDACTED_MARKER = "[REDACTED]";
const MANAGED_USER_STATUSES = new Set(["active", "deactivated", "banned"]);
const USER_FILTER_OPTIONS = new Set(["active", "inactive", "authenticated", "all"]);
const MANAGER_AUTH_COOKIE_NAME = "blastdoor.manager.sid";
const CONFIG_BACKUP_NAME_PATTERN = /[^a-zA-Z0-9_-]+/g;
const CONFIG_BACKUP_ID_PATTERN = /^[a-zA-Z0-9_-]{6,120}$/;
const CONFIG_BACKUP_VIEW_MAX_BYTES = 512 * 1024;
const REMOTE_SUPPORT_TOKEN_MIN_TTL_MINUTES = 30;
const REMOTE_SUPPORT_TOKEN_MAX_TTL_MINUTES = 24 * 60;
const REMOTE_SUPPORT_DEFAULT_TOKEN_LABEL = "Remote Support Token";
const CALL_HOME_EVENTS_MAX = 200;
const CALL_HOME_REPORT_PAYLOAD_MAX_CHARS = 32_000;
const REMOTE_SUPPORT_SAFE_ACTION_ALLOWLIST = new Set([
  "snapshot.network",
  "check.gateway-local",
  "detect.wsl-portproxy",
]);
const RUNTIME_IS_CONTAINER =
  Boolean(process.env.CONTAINER || process.env.DOCKER_CONTAINER || process.env.KUBERNETES_SERVICE_HOST) ||
  existsSync("/.dockerenv");

function formatEnvValue(value) {
  if (value === "") {
    return "";
  }

  if (/^[A-Za-z0-9_./,:@+-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function createSessionSecret() {
  return randomBytes(48).toString("base64url");
}

function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value).trim();
}

function normalizeUsername(value) {
  return normalizeString(value, "").toLowerCase();
}

function normalizeUserStatus(value, fallback = "active") {
  const normalized = normalizeString(value, "").toLowerCase();
  if (MANAGED_USER_STATUSES.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeUserFilter(value, fallback = "active") {
  const normalized = normalizeString(value, "").toLowerCase();
  if (USER_FILTER_OPTIONS.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeConfigBackupName(value, fallback = "config") {
  const sanitized = normalizeString(value, "")
    .replace(CONFIG_BACKUP_NAME_PATTERN, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  if (!sanitized) {
    return fallback;
  }
  return sanitized.slice(0, 48);
}

function createConfigBackupId(name) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "");
  return `${timestamp}_${normalizeConfigBackupName(name)}`.slice(0, 120);
}

function validateConfigBackupId(backupId) {
  const normalized = normalizeString(backupId, "");
  if (!CONFIG_BACKUP_ID_PATTERN.test(normalized)) {
    throw new Error("Invalid backup identifier.");
  }
  return normalized;
}

function validateManagedUsername(value) {
  const username = normalizeUsername(value);
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new Error("Username must be 3-64 chars using a-z, 0-9, '.', '_', or '-'.");
  }
  return username;
}

function validateManagedUsernameForActions(value) {
  const username = normalizeUsername(value);
  if (!/^[a-z0-9._-]{1,64}$/.test(username)) {
    throw new Error("Username must be 1-64 chars using a-z, 0-9, '.', '_', or '-'.");
  }
  return username;
}

function isAsciiVisible(value) {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 33 || code > 126) {
      return false;
    }
  }
  return true;
}

function isAlphaNumeric(value) {
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    if (!isDigit && !isUpper && !isLower) {
      return false;
    }
  }
  return true;
}

function isDomainLabel(label) {
  if (!label || label.length > 63) {
    return false;
  }
  if (label.startsWith("-") || label.endsWith("-")) {
    return false;
  }
  for (const char of label) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    if (!isDigit && !isUpper && !isLower && char !== "-") {
      return false;
    }
  }
  return true;
}

function isValidEmailAddress(candidate) {
  if (!candidate || candidate.length > 254) {
    return false;
  }
  if (!isAsciiVisible(candidate)) {
    return false;
  }

  const atIndex = candidate.indexOf("@");
  if (atIndex < 1) {
    return false;
  }
  if (candidate.indexOf("@", atIndex + 1) !== -1) {
    return false;
  }

  const localPart = candidate.slice(0, atIndex);
  const domainPart = candidate.slice(atIndex + 1);

  if (!localPart || !domainPart || localPart.length > 64 || domainPart.length > 253) {
    return false;
  }
  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) {
    return false;
  }
  if (domainPart.startsWith(".") || domainPart.endsWith(".") || domainPart.includes("..")) {
    return false;
  }

  const labels = domainPart.split(".");
  if (labels.length < 2) {
    return false;
  }
  if (!labels.every(isDomainLabel)) {
    return false;
  }

  const tld = labels[labels.length - 1];
  if (tld.length < 2 || !isAlphaNumeric(tld)) {
    return false;
  }

  return true;
}

function sanitizeEmail(value) {
  const email = normalizeString(value, "").toLowerCase();
  if (!email) {
    return "";
  }
  if (!isValidEmailAddress(email)) {
    throw new Error("Email must be valid.");
  }
  return email;
}

function sanitizeLongText(value, maxLength = 4096) {
  return normalizeString(value, "").slice(0, maxLength);
}

function createSessionKey({ username, lastLoginAt, sessionVersion }) {
  const payload = `${normalizeUsername(username)}|${normalizeString(lastLoginAt, "")}|${Number.parseInt(String(sessionVersion || 1), 10) || 1}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

function resolveGatewayBaseUrl(config) {
  const explicit = normalizeString(config.PUBLIC_BASE_URL, "").replace(/\/+$/, "");
  if (explicit) {
    return explicit;
  }

  const protocol = parseBooleanLike(config.TLS_ENABLED, false) ? "https" : "http";
  let host = normalizeString(config.HOST, "127.0.0.1");
  if (!host || host === "0.0.0.0" || host === "::") {
    host = "localhost";
  }
  const port = Number.parseInt(config.PORT || CONFIG_DEFAULTS.PORT, 10);
  return `${protocol}://${host}:${port}`;
}

function normalizeTlsChallengeMethod(value, fallback = "webroot") {
  const normalized = normalizeString(value, fallback).toLowerCase();
  if (normalized === "standalone") {
    return "standalone";
  }
  return "webroot";
}

function sanitizeDomain(value) {
  const domain = normalizeString(value, "").toLowerCase();
  if (!domain) {
    return "";
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new Error("TLS domain must be a valid hostname.");
  }
  return domain;
}

function resolveDefaultLetsEncryptPaths(domain) {
  if (!domain) {
    return {
      certFile: "",
      keyFile: "",
    };
  }
  return {
    certFile: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
    keyFile: `/etc/letsencrypt/live/${domain}/privkey.pem`,
  };
}

function buildLetsEncryptPlan({
  domain,
  email,
  challengeMethod,
  webrootPath,
  certFile,
  keyFile,
  certbotAvailable,
  dockerAvailable,
}) {
  const steps = [
    "1) Point your DNS A/AAAA record to this Blastdoor host.",
    "2) Open inbound ports 80 and 443 on your network/firewall.",
    "3) Install Certbot or use Docker Certbot.",
  ];

  const certbotInstallHints = [];
  if (!certbotAvailable) {
    certbotInstallHints.push("sudo apt-get update && sudo apt-get install -y certbot");
  }
  if (!certbotAvailable && dockerAvailable) {
    certbotInstallHints.push("docker pull certbot/certbot");
  }

  const commands = [];
  if (challengeMethod === "standalone") {
    commands.push(
      `sudo certbot certonly --standalone -d ${domain} --email ${email} --agree-tos --non-interactive`,
    );
  } else {
    commands.push(
      `sudo certbot certonly --webroot -w ${webrootPath} -d ${domain} --email ${email} --agree-tos --non-interactive`,
    );
  }

  if (!certbotAvailable && dockerAvailable) {
    if (challengeMethod === "standalone") {
      commands.push(
        `docker run --rm -p 80:80 -v /etc/letsencrypt:/etc/letsencrypt certbot/certbot certonly --standalone -d ${domain} --email ${email} --agree-tos --non-interactive`,
      );
    } else {
      commands.push(
        `docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v ${webrootPath}:${webrootPath} certbot/certbot certonly --webroot -w ${webrootPath} -d ${domain} --email ${email} --agree-tos --non-interactive`,
      );
    }
  }

  const envPreview = [
    "TLS_ENABLED=true",
    `TLS_DOMAIN=${domain}`,
    `TLS_EMAIL=${email}`,
    `TLS_CHALLENGE_METHOD=${challengeMethod}`,
    `TLS_WEBROOT_PATH=${challengeMethod === "webroot" ? webrootPath : ""}`,
    `TLS_CERT_FILE=${certFile}`,
    `TLS_KEY_FILE=${keyFile}`,
    "COOKIE_SECURE=true",
  ];

  const renew = [
    "sudo certbot renew --dry-run",
    "sudo certbot renew",
  ];

  return {
    steps,
    certbotInstallHints,
    commands,
    envPreview,
    renew,
    notes: [
      "After certificate issuance, save TLS config and restart Blastdoor.",
      "If Blastdoor is not directly internet-facing, use a reverse proxy and terminate TLS there.",
    ],
  };
}

function parseBodyConfig(body, existingConfig = {}) {
  const output = {};
  for (const key of CONFIG_FIELDS) {
    if (key === "AUTH_PASSWORD_HASH") {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(body, key)) {
      output[key] = normalizeString(body[key], CONFIG_DEFAULTS[key] ?? "");
      continue;
    }

    output[key] = normalizeString(existingConfig[key], CONFIG_DEFAULTS[key] ?? "");
  }

  return output;
}

function normalizeThemeName(value) {
  return String(value || "").trim();
}

function parseBooleanLikeBody(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function validateThemeAssetSelection(
  {
    themeName,
    logoPath,
    closedBackgroundPath,
    openBackgroundPath,
    loginBoxWidthPercent,
    loginBoxHeightPercent,
    loginBoxPosXPercent,
    loginBoxPosYPercent,
    loginBoxOpacityPercent,
    loginBoxHoverOpacityPercent,
    logoSizePercent,
    logoOffsetXPercent,
    logoOffsetYPercent,
    backgroundZoomPercent,
    loginBoxMode,
  },
  assets,
  options = {},
) {
  const requireClosedBackground = options.requireClosedBackground !== false;
  const logoSelection = normalizeThemeAssetPath(logoPath, "logo");
  const closedSelection = normalizeThemeAssetPath(closedBackgroundPath, "background");
  const openSelection = normalizeThemeAssetPath(openBackgroundPath, "background");

  const logoPaths = new Set((assets.logos || []).map((entry) => entry.path));
  const backgroundPaths = new Set((assets.backgrounds || []).map((entry) => entry.path));

  if (logoSelection && !logoPaths.has(logoSelection)) {
    throw new Error("Selected logo is not available under graphics/logo.");
  }

  if (closedSelection && !backgroundPaths.has(closedSelection)) {
    throw new Error("Selected closed background is not available under graphics/background.");
  }

  if (openSelection && !backgroundPaths.has(openSelection)) {
    throw new Error("Selected open background is not available under graphics/background.");
  }

  const name = normalizeThemeName(themeName);
  if (!name) {
    throw new Error("Theme name is required.");
  }

  if (requireClosedBackground && !closedSelection) {
    throw new Error("Closed background image selection is required.");
  }

  const layout = normalizeThemeLayoutSettings({
    loginBoxWidthPercent,
    loginBoxHeightPercent,
    loginBoxPosXPercent,
    loginBoxPosYPercent,
    loginBoxOpacityPercent,
    loginBoxHoverOpacityPercent,
    logoSizePercent,
    logoOffsetXPercent,
    logoOffsetYPercent,
    backgroundZoomPercent,
    loginBoxMode,
  });

  return {
    name,
    logoPath: logoSelection,
    closedBackgroundPath: closedSelection,
    openBackgroundPath: openSelection,
    loginBoxWidthPercent: layout.loginBoxWidthPercent,
    loginBoxHeightPercent: layout.loginBoxHeightPercent,
    loginBoxPosXPercent: layout.loginBoxPosXPercent,
    loginBoxPosYPercent: layout.loginBoxPosYPercent,
    loginBoxOpacityPercent: layout.loginBoxOpacityPercent,
    loginBoxHoverOpacityPercent: layout.loginBoxHoverOpacityPercent,
    logoSizePercent: layout.logoSizePercent,
    logoOffsetXPercent: layout.logoOffsetXPercent,
    logoOffsetYPercent: layout.logoOffsetYPercent,
    backgroundZoomPercent: layout.backgroundZoomPercent,
    loginBoxMode: layout.loginBoxMode,
  };
}

function scrubConfigForClient(config) {
  const output = { ...config };
  output.AUTH_PASSWORD_HASH = "";
  for (const key of SENSITIVE_CONFIG_KEYS) {
    output[key] = config[key] ? "********" : "";
  }
  output.hasAuthPasswordHash = Boolean(config.AUTH_PASSWORD_HASH);
  return output;
}

function sanitizePostgresUrl(urlValue) {
  const value = normalizeString(urlValue, "");
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "postgresql:" || parsed.protocol === "postgres:") {
      if (parsed.username) {
        parsed.username = "REDACTED";
      }
      if (parsed.password) {
        parsed.password = "REDACTED";
      }
      return parsed.toString();
    }
  } catch {
    // Fall through to best-effort masking for non-standard connection strings.
  }

  return value.replace(/\/\/([^:/@]+)(?::[^@]*)?@/, "//REDACTED:REDACTED@");
}

function sanitizeConfigForDiagnostics(config) {
  const sanitized = {};

  for (const key of CONFIG_FIELDS) {
    if (key === "AUTH_PASSWORD_HASH") {
      sanitized.AUTH_PASSWORD_HASH = config.AUTH_PASSWORD_HASH ? REDACTED_MARKER : "";
      continue;
    }

    if (key === "POSTGRES_URL") {
      sanitized.POSTGRES_URL = sanitizePostgresUrl(config.POSTGRES_URL);
      continue;
    }

    if (SENSITIVE_CONFIG_KEYS.has(key)) {
      sanitized[key] = config[key] ? REDACTED_MARKER : "";
      continue;
    }

    sanitized[key] = normalizeString(config[key], "");
  }

  sanitized.AUTH_PASSWORD_HASH_PRESENT = Boolean(config.AUTH_PASSWORD_HASH);
  return sanitized;
}

function detectEnvironmentInfo({ workspaceDir, envPath }) {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
    managerHost: process.env.MANAGER_HOST || DEFAULT_MANAGER_HOST,
    managerPort: Number.parseInt(process.env.MANAGER_PORT || String(DEFAULT_MANAGER_PORT), 10),
    workspaceDir,
    envPath,
    isWsl: Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP),
    wslDistro: normalizeString(process.env.WSL_DISTRO_NAME, ""),
    isContainer: RUNTIME_IS_CONTAINER,
  };
}

async function readEnvConfig(envPath) {
  let parsed = {};
  try {
    const raw = await fs.readFile(envPath, "utf8");
    parsed = dotenv.parse(raw);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw new Error(`Failed to read config from ${envPath}: ${error.message}`, { cause: error });
    }
  }

  return { ...CONFIG_DEFAULTS, ...parsed };
}

async function writeEnvConfig(envPath, config) {
  const merged = { ...CONFIG_DEFAULTS, ...config };
  const lines = [];
  for (const key of CONFIG_FIELDS) {
    lines.push(`${key}=${formatEnvValue(merged[key] ?? "")}`);
  }
  lines.push("");
  await fs.writeFile(envPath, lines.join("\n"), "utf8");
}

async function tailFile(filePath, lineLimit = 200) {
  try {
    const chunks = [];
    const stream = createReadStream(filePath, { encoding: "utf8" });
    for await (const chunk of stream) {
      chunks.push(chunk);
      if (chunks.length > 200) {
        chunks.shift();
      }
    }

    const lines = chunks.join("").split(/\r?\n/).filter(Boolean);
    return lines.slice(-lineLimit);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }

    throw new Error(`Failed to read log file ${filePath}: ${error.message}`, { cause: error });
  }
}

function createProcessState({ workspaceDir, processFactory }) {
  const state = {
    child: null,
    startedAt: null,
    lastExit: null,
    runtimeLogLines: [],
  };

  function appendRuntimeLine(source, message) {
    const lines = String(message)
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .map((line) => `[${source}] ${line}`);

    if (lines.length === 0) {
      return;
    }

    state.runtimeLogLines.push(...lines);
    if (state.runtimeLogLines.length > 600) {
      state.runtimeLogLines.splice(0, state.runtimeLogLines.length - 600);
    }
  }

  function getStatus() {
    return {
      running: Boolean(state.child),
      pid: state.child?.pid || null,
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      uptimeSeconds: state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0,
      lastExit: state.lastExit,
    };
  }

  function renderEarlyExitHint() {
    const recent = state.runtimeLogLines.slice(-80).join("\n");
    if (recent.includes("EADDRNOTAVAIL")) {
      return "Bind address is unavailable. Verify HOST in .env and prefer HOST=0.0.0.0 unless you must bind a specific local interface.";
    }
    if (recent.includes("EADDRINUSE")) {
      return "Port is already in use. Stop the conflicting service or change PORT in .env.";
    }
    return "";
  }

  async function start() {
    if (state.child) {
      return getStatus();
    }

    const child = processFactory(process.execPath, ["src/server.js"], {
      cwd: workspaceDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    state.child = child;
    state.startedAt = Date.now();
    state.lastExit = null;
    appendRuntimeLine("manager", `Started Blastdoor process pid=${child.pid || "unknown"}`);

    child.stdout?.on("data", (chunk) => appendRuntimeLine("stdout", chunk));
    child.stderr?.on("data", (chunk) => appendRuntimeLine("stderr", chunk));
    child.on("exit", (code, signal) => {
      state.lastExit = {
        at: new Date().toISOString(),
        code: typeof code === "number" ? code : null,
        signal: signal || null,
      };
      appendRuntimeLine("manager", `Blastdoor exited code=${state.lastExit.code} signal=${state.lastExit.signal}`);
      state.child = null;
      state.startedAt = null;
    });

    const earlyExitWindowMs = 900;
    const earlyExit = await new Promise((resolve) => {
      let settled = false;
      const settle = (payload) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(payload);
      };

      const timer = setTimeout(() => {
        child.off("exit", onExit);
        settle(null);
      }, earlyExitWindowMs);

      const onExit = (code, signal) => {
        clearTimeout(timer);
        settle({
          code: typeof code === "number" ? code : null,
          signal: signal || null,
        });
      };

      child.once("exit", onExit);
    });

    if (earlyExit) {
      const hint = renderEarlyExitHint();
      throw new Error(
        `Blastdoor failed to start (exit code: ${earlyExit.code ?? "n/a"}, signal: ${earlyExit.signal || "n/a"}).${hint ? ` ${hint}` : ""}`,
      );
    }

    return getStatus();
  }

  async function stop() {
    if (!state.child) {
      return getStatus();
    }

    const activeChild = state.child;
    await new Promise((resolve) => {
      let settled = false;

      const complete = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      const timeout = setTimeout(() => {
        if (activeChild && !activeChild.killed) {
          activeChild.kill("SIGKILL");
        }
      }, 5000);

      activeChild.once("exit", () => {
        clearTimeout(timeout);
        complete();
      });

      try {
        activeChild.kill("SIGTERM");
      } catch {
        clearTimeout(timeout);
        complete();
      }
    });

    return getStatus();
  }

  function recentRuntimeLogs(lineLimit = 200) {
    return state.runtimeLogLines.slice(-lineLimit);
  }

  return { start, stop, getStatus, recentRuntimeLogs };
}

async function checkBlastdoorHealth(config) {
  const port = Number.parseInt(config.PORT || CONFIG_DEFAULTS.PORT, 10);
  const host = config.HOST && config.HOST !== "0.0.0.0" ? config.HOST : "127.0.0.1";
  const url = `http://${host}:${port}/healthz`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return {
      ok: response.ok,
      statusCode: response.status,
      url,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function defaultPortForProtocol(protocol) {
  if (protocol === "https:") {
    return 443;
  }
  if (protocol === "http:") {
    return 80;
  }
  return null;
}

function isLoopbackHost(hostname) {
  const normalized = normalizeString(hostname, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

async function probeTcpConnectivity(host, port, timeoutMs = 1500) {
  return await new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        ...result,
        durationMs: Date.now() - startedAt,
      });
    };

    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      socket.destroy();
      finish({ ok: true, error: null });
    });
    socket.on("timeout", () => {
      socket.destroy();
      finish({ ok: false, error: `timeout after ${timeoutMs}ms` });
    });
    socket.on("error", (error) => {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function resolveDnsAddresses(hostname) {
  const host = normalizeString(hostname, "");
  if (!host) {
    return {
      ok: false,
      addresses: [],
      error: "missing host",
    };
  }

  if (net.isIP(host)) {
    return {
      ok: true,
      addresses: [host],
      error: null,
    };
  }

  if (host === "localhost") {
    return {
      ok: true,
      addresses: ["127.0.0.1", "::1"],
      error: null,
    };
  }

  try {
    const results = await dns.lookup(host, { all: true });
    const addresses = results.map((entry) => normalizeString(entry?.address, "")).filter(Boolean);
    return {
      ok: addresses.length > 0,
      addresses,
      error: addresses.length > 0 ? null : "No DNS addresses returned.",
    };
  } catch (error) {
    return {
      ok: false,
      addresses: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkFoundryTargetHealth(config) {
  const rawTarget = normalizeString(config.FOUNDRY_TARGET, "");
  if (!rawTarget) {
    return {
      ok: false,
      statusCode: null,
      url: "",
      error: "FOUNDRY_TARGET is not configured.",
      targetHost: "",
      targetPort: null,
      targetProtocol: "",
      targetIsLoopback: false,
      dns: { ok: false, addresses: [], error: "FOUNDRY_TARGET is not configured." },
      tcp: { ok: false, error: "FOUNDRY_TARGET is not configured.", durationMs: 0 },
      runtimeHint: "",
    };
  }

  let targetUrl;
  try {
    targetUrl = new URL(rawTarget);
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      url: rawTarget,
      error: `Invalid FOUNDRY_TARGET URL: ${error instanceof Error ? error.message : String(error)}`,
      targetHost: "",
      targetPort: null,
      targetProtocol: "",
      targetIsLoopback: false,
      dns: { ok: false, addresses: [], error: "Invalid target URL." },
      tcp: { ok: false, error: "Invalid target URL.", durationMs: 0 },
      runtimeHint: "",
    };
  }

  const targetHost = normalizeString(targetUrl.hostname, "");
  const targetPort = Number.parseInt(targetUrl.port || String(defaultPortForProtocol(targetUrl.protocol) || ""), 10);
  const targetProtocol = normalizeString(targetUrl.protocol, "");
  const targetIsLoopback = isLoopbackHost(targetHost);
  const dnsDetails = await resolveDnsAddresses(targetHost);
  const tcpDetails =
    Number.isInteger(targetPort) && targetPort > 0
      ? await probeTcpConnectivity(targetHost, targetPort, 1500)
      : { ok: false, error: "Unable to determine target port.", durationMs: 0 };

  const runtimeHint =
    targetIsLoopback && (Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) || RUNTIME_IS_CONTAINER)
      ? "FOUNDRY_TARGET is loopback/localhost while Blastdoor runs in WSL or container. localhost resolves inside that runtime, not the host OS."
      : "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    return {
      ok: true,
      statusCode: response.status,
      url: targetUrl.toString(),
      targetHost,
      targetPort: Number.isInteger(targetPort) ? targetPort : null,
      targetProtocol,
      targetIsLoopback,
      dns: dnsDetails,
      tcp: tcpDetails,
      runtimeHint,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      url: targetUrl.toString(),
      error: error instanceof Error ? error.message : String(error),
      targetHost,
      targetPort: Number.isInteger(targetPort) ? targetPort : null,
      targetProtocol,
      targetIsLoopback,
      dns: dnsDetails,
      tcp: tcpDetails,
      runtimeHint,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeFoundryApiResponseBody(bodyText) {
  const raw = normalizeString(bodyText, "");
  if (!raw) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const status =
        normalizeString(parsed.status, "") ||
        normalizeString(parsed.serverStatus, "") ||
        normalizeString(parsed.message, "");
      if (status) {
        return status.slice(0, 120);
      }
    }
    return String(typeof parsed === "string" ? parsed : JSON.stringify(parsed)).replace(/\s+/g, " ").slice(0, 120);
  } catch {
    return raw.replace(/\s+/g, " ").slice(0, 120);
  }
}

async function probeFoundryApiStatus(config, timeoutMs = 1500) {
  const rawTarget = normalizeString(config.FOUNDRY_TARGET, "");
  if (!rawTarget) {
    return {
      ok: false,
      reachable: false,
      statusCode: null,
      url: "",
      endpointPath: "/api/status",
      responseSummary: "",
      error: "FOUNDRY_TARGET is not configured.",
    };
  }

  let targetUrl;
  try {
    targetUrl = new URL(rawTarget);
  } catch (error) {
    return {
      ok: false,
      reachable: false,
      statusCode: null,
      url: rawTarget,
      endpointPath: "/api/status",
      responseSummary: "",
      error: `Invalid FOUNDRY_TARGET URL: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const candidatePaths = ["/api/status", "/API/Status"];
  let fallbackResult = null;

  for (const endpointPath of candidatePaths) {
    const endpointUrl = new URL(targetUrl.toString());
    endpointUrl.pathname = endpointPath;
    endpointUrl.search = "";
    endpointUrl.hash = "";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpointUrl, {
        method: "GET",
        headers: {
          accept: "application/json,text/plain,*/*",
        },
        signal: controller.signal,
      });
      const rawBody = await response.text();
      const responseSummary = summarizeFoundryApiResponseBody(rawBody);
      const result = {
        ok: response.ok,
        reachable: true,
        statusCode: response.status,
        url: endpointUrl.toString(),
        endpointPath,
        responseSummary,
        error: response.ok ? null : responseSummary || `HTTP ${response.status}`,
      };

      if (response.status !== 404) {
        return result;
      }
      fallbackResult = result;
    } catch (error) {
      return {
        ok: false,
        reachable: false,
        statusCode: null,
        url: endpointUrl.toString(),
        endpointPath,
        responseSummary: "",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return (
    fallbackResult || {
      ok: false,
      reachable: false,
      statusCode: null,
      url: rawTarget,
      endpointPath: "/api/status",
      responseSummary: "",
      error: "No Foundry API status endpoint response.",
    }
  );
}

function elapsedSeconds(startedAt) {
  const startedMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startedMs)) {
    return 0;
  }
  return Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
}

function formatPluginName(pluginId) {
  const normalized = normalizeString(pluginId, "");
  if (!normalized) {
    return "Plugin";
  }
  return `${normalized
    .split(/[-_]+/)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")} Module`;
}

function parseComposePsOutput(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry) => entry && typeof entry === "object");
    }
    if (parsed && typeof parsed === "object") {
      return [parsed];
    }
  } catch {
    // Fall through to line-delimited parsing.
  }

  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        entries.push(parsed);
      }
    } catch {
      // Ignore unparseable line.
    }
  }
  return entries;
}

function collectLocalIpAddresses() {
  const addresses = new Set(["127.0.0.1", "::1"]);
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      const address = normalizeString(entry?.address, "");
      if (!address) {
        continue;
      }
      addresses.add(address);
    }
  }
  return addresses;
}

function evaluateGatewayBindHost({ host, environment }) {
  const normalizedHost = normalizeString(host, CONFIG_DEFAULTS.HOST);
  if (!normalizedHost || ["0.0.0.0", "::", "127.0.0.1", "::1", "localhost"].includes(normalizedHost.toLowerCase())) {
    return {
      ok: true,
      host: normalizedHost || CONFIG_DEFAULTS.HOST,
      reason: null,
      recommendation: null,
    };
  }

  const ipVersion = net.isIP(normalizedHost);
  if (ipVersion > 0) {
    const localIps = collectLocalIpAddresses();
    if (localIps.has(normalizedHost)) {
      return {
        ok: true,
        host: normalizedHost,
        reason: null,
        recommendation: null,
      };
    }

    const recommendation = environment?.isWsl
      ? "In WSL, set HOST=0.0.0.0 and use Windows portproxy/firewall rules for LAN access."
      : "Set HOST=0.0.0.0 for LAN access, or HOST=127.0.0.1 for local-only access.";

    return {
      ok: false,
      host: normalizedHost,
      reason: "ip-not-bound-on-host",
      recommendation,
    };
  }

  return {
    ok: true,
    host: normalizedHost,
    reason: null,
    recommendation: null,
  };
}

function toServiceHealthFromDocker({ running = false, healthStatus = "", state = "" } = {}) {
  const normalizedHealth = String(healthStatus || "").trim().toLowerCase();
  const normalizedState = String(state || "").trim().toLowerCase();
  if (!running) {
    return {
      ok: false,
      statusCode: null,
      error: normalizedState || "stopped",
    };
  }

  if (normalizedHealth === "healthy") {
    return { ok: true, statusCode: 200 };
  }
  if (normalizedHealth === "starting") {
    return { ok: false, statusCode: null, error: "starting" };
  }
  if (normalizedHealth && normalizedHealth !== "none") {
    return { ok: false, statusCode: null, error: normalizedHealth };
  }

  return { ok: true, statusCode: 200 };
}

async function inspectDockerContainerState({ commandRunner, workspaceDir, containerId }) {
  const result = await commandRunner({
    command: "docker",
    args: ["inspect", "--format", "{{json .State}}", containerId],
    cwd: workspaceDir,
    timeoutMs: 4500,
  });

  if (!result.ok) {
    return {
      running: false,
      pid: null,
      uptimeSeconds: 0,
      health: {
        ok: false,
        statusCode: null,
        error: normalizeString(result.error || result.stderr || result.stdout, "inspect-failed"),
      },
    };
  }

  const parsedState = (() => {
    try {
      return JSON.parse(String(result.stdout || "").trim());
    } catch {
      return null;
    }
  })();

  const running = Boolean(parsedState?.Running);
  const healthStatus = normalizeString(parsedState?.Health?.Status, "");
  const startedAt = normalizeString(parsedState?.StartedAt, "");
  const pidValue = Number.parseInt(String(parsedState?.Pid || ""), 10);

  return {
    running,
    pid: Number.isInteger(pidValue) && pidValue > 0 ? pidValue : null,
    startedAt: startedAt || null,
    uptimeSeconds: running ? elapsedSeconds(startedAt) : 0,
    health: toServiceHealthFromDocker({
      running,
      healthStatus,
      state: parsedState?.Status || "",
    }),
  };
}

async function loadComposeServiceStates({ commandRunner, workspaceDir }) {
  const composeResult = await commandRunner({
    command: "docker",
    args: ["compose", "-f", "docker-compose.yml", "--env-file", "docker/blastdoor.env", "ps", "--format", "json"],
    cwd: workspaceDir,
    timeoutMs: 4500,
  });

  if (!composeResult.ok) {
    return {
      ok: false,
      services: {},
      error: normalizeString(composeResult.error || composeResult.stderr || composeResult.stdout, "compose-unavailable"),
    };
  }

  const composeRows = parseComposePsOutput(composeResult.stdout);
  const services = {};
  for (const row of composeRows) {
    const serviceName = normalizeString(row.Service || row.service || "", "").toLowerCase();
    const containerId = normalizeString(row.ID || row.Id || row.id || "", "");
    if (!serviceName || !containerId) {
      continue;
    }
    services[serviceName] = await inspectDockerContainerState({
      commandRunner,
      workspaceDir,
      containerId,
    });
  }

  return { ok: true, services };
}

async function probeHttpHealth(url, timeoutMs = 1500) {
  let targetUrl;
  try {
    targetUrl = new URL(String(url || ""));
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      url: String(url || ""),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(targetUrl, { signal: controller.signal });
    return {
      ok: response.ok,
      statusCode: response.status,
      url: targetUrl.toString(),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      url: targetUrl.toString(),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeTcpPort({ host, port, timeoutMs = 1500 }) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({
      host,
      port,
    });
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      finish({ ok: true });
    });
    socket.once("timeout", () => {
      finish({ ok: false, error: `timeout (${timeoutMs}ms)` });
    });
    socket.once("error", (error) => {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  });
}

function parsePostgresUrlEndpoint(postgresUrl) {
  const raw = normalizeString(postgresUrl, "");
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    const host = normalizeString(parsed.hostname, "");
    const port = Number.parseInt(parsed.port || "5432", 10);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }

    return { host, port };
  } catch {
    return null;
  }
}

async function detectHostProcessState({ commandRunner, workspaceDir, matchers = [] }) {
  const result = await commandRunner({
    command: "ps",
    args: ["-axo", "pid=,etimes=,command="],
    cwd: workspaceDir,
    timeoutMs: 3000,
  });

  if (!result.ok) {
    return null;
  }

  const normalizedMatchers = matchers.map((value) => normalizeString(value, "").toLowerCase()).filter(Boolean);
  if (normalizedMatchers.length === 0) {
    return null;
  }

  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parts = trimmed.split(/\s+/, 3);
    if (parts.length < 3) {
      continue;
    }

    const pid = Number.parseInt(parts[0], 10);
    const etimes = Number.parseInt(parts[1], 10);
    const command = parts[2] || "";
    const commandLower = command.toLowerCase();
    if (!normalizedMatchers.some((matcher) => commandLower.includes(matcher))) {
      continue;
    }

    return {
      running: true,
      pid: Number.isInteger(pid) ? pid : null,
      uptimeSeconds: Number.isInteger(etimes) && etimes >= 0 ? etimes : 0,
    };
  }

  return null;
}

function parseBooleanLike(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function buildWslPortproxyScript({ environment, config }) {
  const distro = environment.wslDistro || "Ubuntu";
  const port = Number.parseInt(config.PORT || CONFIG_DEFAULTS.PORT, 10);

  return [
    "# Run in Windows PowerShell as Administrator",
    "# WARNING: this modifies Windows portproxy and firewall configuration.",
    "# Review before running. Execute at your own risk.",
    "Set-Service iphlpsvc -StartupType Automatic",
    "Start-Service iphlpsvc",
    `$wslIp = (wsl -d ${distro} sh -lc "ip -4 -o addr show eth0 | awk '{print \\$4}' | cut -d/ -f1").Trim()`,
    `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${port}`,
    `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${port} connectaddress=$wslIp connectport=${port}`,
    `New-NetFirewallRule -DisplayName "Blastdoor ${port}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port}`,
    "netsh interface portproxy show all",
  ].join("\n");
}

function buildWslManagerPortproxyEnableScript({ environment, managerPort, wslIp }) {
  const distro = environment.wslDistro || "Ubuntu";
  const displayName = `Blastdoor Manager ${managerPort}`;
  return [
    "# Run in Windows PowerShell as Administrator",
    "# WARNING: this modifies Windows portproxy and firewall configuration.",
    "# Review before running. Execute at your own risk.",
    "Set-Service iphlpsvc -StartupType Automatic",
    "Start-Service iphlpsvc",
    `# WSL distro hint: ${distro}`,
    `# WSL interface IP detected: ${wslIp}`,
    `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${managerPort}`,
    `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${managerPort} connectaddress=${wslIp} connectport=${managerPort}`,
    `if (-not (Get-NetFirewallRule -DisplayName '${displayName}' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName '${displayName}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${managerPort} }`,
    "netsh interface portproxy show all",
  ].join("\n");
}

function buildWslManagerPortproxyDisableScript({ managerPort }) {
  const displayName = `Blastdoor Manager ${managerPort}`;
  return [
    "# Run in Windows PowerShell as Administrator",
    "# WARNING: this modifies Windows portproxy and firewall configuration.",
    "# Review before running. Execute at your own risk.",
    `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${managerPort}`,
    `Get-NetFirewallRule -DisplayName '${displayName}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue`,
    "netsh interface portproxy show all",
  ].join("\n");
}

async function runDiagnosticCommand({
  command,
  args = [],
  cwd = process.cwd(),
  timeoutMs = 6000,
  maxOutputChars = 24000,
}) {
  return await new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        ...result,
        durationMs: Date.now() - startedAt,
      });
    };

    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish({
        ok: false,
        command,
        args,
        exitCode: null,
        error: `Command timed out after ${timeoutMs}ms`,
        stdout,
        stderr,
      });
    }, timeoutMs);

    const appendChunk = (target, chunk) => {
      const text = String(chunk);
      const next = `${target}${text}`;
      if (next.length <= maxOutputChars) {
        return next;
      }

      return `${next.slice(0, maxOutputChars)}\n[output truncated]`;
    };

    child.stdout?.on("data", (chunk) => {
      stdout = appendChunk(stdout, chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderr = appendChunk(stderr, chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      finish({
        ok: false,
        command,
        args,
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
        stdout,
        stderr,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      finish({
        ok: code === 0,
        command,
        args,
        exitCode: code,
        signal: signal || null,
        stdout,
        stderr,
      });
    });
  });
}

async function runCommandBatch(commandRunner, commands, workspaceDir) {
  const outputs = [];
  for (const cmd of commands) {
    const result = await commandRunner({
      command: cmd.command,
      args: cmd.args || [],
      cwd: workspaceDir,
      timeoutMs: cmd.timeoutMs || 6000,
    });

    outputs.push({
      label: cmd.label,
      command: [cmd.command, ...(cmd.args || [])].join(" "),
      ...result,
    });
  }
  return outputs;
}

async function runGatewayLocalChecks(config) {
  const port = Number.parseInt(config.PORT || CONFIG_DEFAULTS.PORT, 10);
  const candidates = [`http://127.0.0.1:${port}/healthz`];
  if (config.HOST && !["0.0.0.0", "127.0.0.1", "localhost"].includes(config.HOST)) {
    candidates.push(`http://${config.HOST}:${port}/healthz`);
  }

  const uniqueUrls = [...new Set(candidates)];
  const checks = [];

  for (const url of uniqueUrls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      checks.push({
        label: `GET ${url}`,
        ok: response.ok,
        statusCode: response.status,
        error: null,
      });
    } catch (error) {
      checks.push({
        label: `GET ${url}`,
        ok: false,
        statusCode: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return checks;
}

function parseDefaultGatewayIpFromRouteOutput(raw) {
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = trimmed.match(/\bdefault\s+via\s+((?:\d{1,3}\.){3}\d{1,3})\b/i);
    if (!match) {
      continue;
    }
    const ip = normalizeString(match[1], "");
    if (net.isIP(ip) === 4) {
      return ip;
    }
  }
  return "";
}

function buildWslFoundryTarget(config, gatewayIp) {
  const rawTarget = normalizeString(config.FOUNDRY_TARGET, CONFIG_DEFAULTS.FOUNDRY_TARGET);
  let protocol = "http:";
  let port = "30000";
  let pathname = "";

  try {
    const parsed = new URL(rawTarget);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      protocol = parsed.protocol;
    }
    port = normalizeString(parsed.port, "") || port;
    pathname = normalizeString(parsed.pathname, "");
  } catch {
    // Keep defaults.
  }

  const safePathname = pathname && pathname !== "/" ? pathname : "";
  return `${protocol}//${gatewayIp}:${port}${safePathname}`;
}

function buildWslOllamaUrl(config, gatewayIp) {
  const rawUrl = normalizeString(config.ASSISTANT_OLLAMA_URL, "http://127.0.0.1:11434");
  let protocol = "http:";
  let port = "11434";
  let pathname = "";

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      protocol = parsed.protocol;
    }
    port = normalizeString(parsed.port, "") || port;
    pathname = normalizeString(parsed.pathname, "");
  } catch {
    // Keep defaults.
  }

  const safePathname = pathname && pathname !== "/" ? pathname : "";
  return `${protocol}//${gatewayIp}:${port}${safePathname}`;
}

async function detectWslDefaultGatewayIp({ workspaceDir, commandRunner }) {
  const routeResult = await commandRunner({
    command: "ip",
    args: ["route", "show", "default"],
    cwd: workspaceDir,
    timeoutMs: 4000,
  });
  if (!routeResult.ok) {
    throw new Error(
      `Unable to detect WSL default gateway via 'ip route show default' (${routeResult.error || "command failed"}).`,
    );
  }

  const gatewayIp = parseDefaultGatewayIpFromRouteOutput(routeResult.stdout);
  if (!gatewayIp) {
    throw new Error("Unable to parse a default gateway IPv4 address from 'ip route show default' output.");
  }

  return {
    gatewayIp,
    commandResult: routeResult,
  };
}

async function detectWslInterfaceIp({ workspaceDir, commandRunner }) {
  const ifaceResult = await commandRunner({
    command: "ip",
    args: ["-4", "-o", "addr", "show", "eth0"],
    cwd: workspaceDir,
    timeoutMs: 4000,
  });
  if (!ifaceResult.ok) {
    throw new Error(
      `Unable to detect WSL interface IP via 'ip -4 -o addr show eth0' (${ifaceResult.error || "command failed"}).`,
    );
  }

  const match = String(ifaceResult.stdout || "").match(/\binet\s+((?:\d{1,3}\.){3}\d{1,3})\//);
  const ip = normalizeString(match?.[1], "");
  if (net.isIP(ip) !== 4) {
    throw new Error("Unable to parse WSL IPv4 address from 'ip -4 -o addr show eth0' output.");
  }

  return {
    wslIp: ip,
    commandResult: ifaceResult,
  };
}

async function syncRemoteSupportWslExposure({
  enabled,
  environment,
  workspaceDir,
  commandRunner,
}) {
  const managerPort = Number.parseInt(environment.managerPort || String(DEFAULT_MANAGER_PORT), 10) || DEFAULT_MANAGER_PORT;
  const managerHost = normalizeString(environment.managerHost, DEFAULT_MANAGER_HOST);
  const base = {
    attempted: false,
    applied: false,
    enabledRequested: enabled === true,
    managerHost,
    managerPort,
    status: "skipped",
    message: "WSL exposure sync not required.",
    remediation: [],
    commands: [],
  };

  if (!environment.isWsl) {
    return {
      ...base,
      status: "skipped-not-wsl",
      message: "Runtime is not WSL; automatic Windows portproxy sync skipped.",
    };
  }

  if (isLoopbackHost(managerHost)) {
    const actionHint = enabled
      ? "Enable"
      : "Disable";
    return {
      ...base,
      status: "blocked-manager-loopback",
      message:
        "Manager is bound to loopback (127.0.0.1). Restart manager with MANAGER_HOST=0.0.0.0 before automatic WSL exposure sync can apply.",
      remediation: [
        `Restart manager with: MANAGER_HOST=0.0.0.0 MANAGER_PORT=${managerPort} make manager-launch`,
        `${actionHint} remote support API again after manager restart to trigger automatic exposure sync.`,
      ],
      script: enabled
        ? buildWslManagerPortproxyEnableScript({
            environment,
            managerPort,
            wslIp: "<WSL_IP>",
          })
        : buildWslManagerPortproxyDisableScript({ managerPort }),
    };
  }

  let wslIp;
  try {
    const detected = await detectWslInterfaceIp({ workspaceDir, commandRunner });
    wslIp = detected.wslIp;
  } catch (error) {
    return {
      ...base,
      status: "failed-detect-wsl-ip",
      message: error instanceof Error ? error.message : String(error),
      remediation: [
        "Verify WSL network interface is available and 'ip' command returns eth0 IPv4.",
        "Run diagnostics: Troubleshooting -> Gather Snapshot.",
      ],
    };
  }

  const powershellCommand = enabled
    ? [
        "$ErrorActionPreference='Stop'",
        "Set-Service iphlpsvc -StartupType Automatic",
        "Start-Service iphlpsvc",
        `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${managerPort} | Out-Null`,
        `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${managerPort} connectaddress=${wslIp} connectport=${managerPort}`,
        `if (-not (Get-NetFirewallRule -DisplayName 'Blastdoor Manager ${managerPort}' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'Blastdoor Manager ${managerPort}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${managerPort} | Out-Null }`,
        "netsh interface portproxy show all",
      ].join("; ")
    : [
        "$ErrorActionPreference='Continue'",
        `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${managerPort} | Out-Null`,
        `Get-NetFirewallRule -DisplayName 'Blastdoor Manager ${managerPort}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue`,
        "netsh interface portproxy show all",
      ].join("; ");

  const result = await commandRunner({
    command: "powershell.exe",
    args: ["-NoProfile", "-Command", powershellCommand],
    cwd: workspaceDir,
    timeoutMs: 12000,
  });

  const script = enabled
    ? buildWslManagerPortproxyEnableScript({ environment, managerPort, wslIp })
    : buildWslManagerPortproxyDisableScript({ managerPort });

  if (!result.ok) {
    return {
      ...base,
      attempted: true,
      status: "failed-apply",
      message: `Automatic WSL exposure sync failed (${result.error || "command failed"}).`,
      remediation: [
        "Run Blastdoor manager with elevated permissions or execute the generated PowerShell script as Administrator.",
        "Verify Windows service 'iphlpsvc' is available and running.",
      ],
      wslIp,
      script,
      commands: [
        {
          command: `powershell.exe -NoProfile -Command "<automation script>"`,
          ok: false,
          exitCode: result.exitCode,
          error: result.error || "",
          stdout: result.stdout || "",
          stderr: result.stderr || "",
        },
      ],
    };
  }

  return {
    ...base,
    attempted: true,
    applied: true,
    status: enabled ? "enabled" : "disabled",
    message: enabled
      ? `Automatic WSL exposure sync applied for manager port ${managerPort}.`
      : `Automatic WSL exposure sync removed for manager port ${managerPort}.`,
    wslIp,
    script,
    commands: [
      {
        command: `powershell.exe -NoProfile -Command "<automation script>"`,
        ok: true,
        exitCode: result.exitCode,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
      },
    ],
  };
}

export function createManagerApp(options = {}) {
  const workspaceDir = path.resolve(options.workspaceDir || path.join(__dirname, ".."));
  const envPath = options.envPath || path.join(workspaceDir, ".env");
  const runtimeStatePath = options.runtimeStatePath || path.join(workspaceDir, "data", "runtime-state.json");
  const installationConfigPath =
    options.installationConfigPath || path.join(workspaceDir, "data", "installation_config.json");
  const dockerEnvPath = options.dockerEnvPath || path.join(workspaceDir, "docker", "blastdoor.env");
  const configBackupDir = options.configBackupDir || path.join(workspaceDir, "data", "config-backups");
  const managerDir = options.managerDir || path.join(workspaceDir, "public", "manager");
  const graphicsDir = options.graphicsDir || path.join(workspaceDir, "graphics");
  const themeStorePath = options.themeStorePath || path.join(graphicsDir, "themes", "themes.json");
  const userProfileStorePath = options.userProfileStorePath || path.join(workspaceDir, "data", "user-profiles.json");
  const intelligenceAgentStorePath =
    options.intelligenceAgentStorePath || path.join(workspaceDir, "data", "intelligence-agents.json");
  const failureStorePath = options.failureStorePath || path.join(workspaceDir, "data", "launch-failures.json");
  const managerConsoleSettingsPath =
    options.managerConsoleSettingsPath || path.join(workspaceDir, "data", "manager-console-settings.json");
  const processFactory = options.processFactory || spawn;
  const commandRunner = options.commandRunner || runDiagnosticCommand;
  const postgresPoolFactory = options.postgresPoolFactory;
  const processState = createProcessState({ workspaceDir, processFactory });
  const managerStartedAtMs = Date.now();
  let managerConsoleSettingsCache = null;
  const managerWriteRateLimitWindowMs = Number.isInteger(options.managerWriteRateLimitWindowMs)
    ? options.managerWriteRateLimitWindowMs
    : 15 * 60 * 1000;
  const managerWriteRateLimitMax = Number.isInteger(options.managerWriteRateLimitMax)
    ? options.managerWriteRateLimitMax
    : 120;
  const managerOperationTimeoutMs = Number.isInteger(options.managerOperationTimeoutMs)
    ? options.managerOperationTimeoutMs
    : 20_000;
  const managedConfigFiles = [
    { id: "gateway_env", relativePath: ".env", absolutePath: envPath },
    { id: "docker_env", relativePath: "docker/blastdoor.env", absolutePath: dockerEnvPath },
    {
      id: "installation_profile",
      relativePath: path.relative(workspaceDir, installationConfigPath).replaceAll(path.sep, "/"),
      absolutePath: installationConfigPath,
    },
  ];

  async function withBlastdoorApi(handler) {
    const configFromEnv = await readEnvConfig(envPath);
    const runtimeConfig = loadConfigFromEnv(configFromEnv);
    const blastdoorApi = createBlastdoorApi({
      config: runtimeConfig,
      graphicsDir,
      themeStorePath,
      userProfileStorePath,
      postgresPoolFactory,
    });

    try {
      return await handler({
        configFromEnv,
        runtimeConfig,
        config: runtimeConfig,
        blastdoorApi,
      });
    } finally {
      if (typeof blastdoorApi?.close === "function") {
        await blastdoorApi.close();
      }
    }
  }

  async function recordFailureEntry(entry = {}) {
    try {
      await appendFailureRecord(failureStorePath, {
        source: "manager",
        ...entry,
      });
    } catch {
      // Failure recording should never crash manager operations.
    }
  }

  async function readConsoleSettings() {
    if (managerConsoleSettingsCache) {
      return managerConsoleSettingsCache;
    }
    managerConsoleSettingsCache = await readManagerConsoleSettings(managerConsoleSettingsPath);
    return managerConsoleSettingsCache;
  }

  async function writeConsoleSettings(nextSettings) {
    const normalized = normalizeManagerConsoleSettings(nextSettings);
    const saved = await writeManagerConsoleSettings(managerConsoleSettingsPath, normalized);
    managerConsoleSettingsCache = saved;
    return saved;
  }

  const managerAuthService = createManagerAuthService({
    readConsoleSettings,
    normalizeString,
    randomBytes,
    managerAuthCookieName: MANAGER_AUTH_COOKIE_NAME,
  });
  const {
    getManagerAuthSession,
    normalizeManagerNextPath,
    createManagerAuthSession,
    createCookieHeader,
    clearManagerAuthSession,
    enforceManagerAccess,
    renderManagerLoginPage,
  } = managerAuthService;

  const controlPlaneStatusService = createControlPlaneStatusService({
    readEnvConfig,
    envPath,
    readInstallationConfig,
    installationConfigPath,
    detectEnvironmentInfo,
    workspaceDir,
    normalizeString,
    parseBooleanLike,
    processState,
    checkBlastdoorHealth,
    checkFoundryTargetHealth,
    probeFoundryApiStatus,
    buildObjectStoreStatus,
    readFailureStore,
    summarizeFailureStore,
    failureStorePath,
    pluginManager,
    loadComposeServiceStates,
    commandRunner,
    probeHttpHealth,
    detectHostProcessState,
    parsePostgresUrlEndpoint,
    probeTcpPort,
    formatPluginName,
    managerStartedAtMs,
  });
  const { getControlPlaneStatusCached } = controlPlaneStatusService;

  const remoteSupportService = createRemoteSupportService({
    normalizeString,
    verifyPassword,
    readConsoleSettings,
    writeConsoleSettings,
    randomUUID,
    configDefaults: CONFIG_DEFAULTS,
    remoteSupportTokenMinTtlMinutes: REMOTE_SUPPORT_TOKEN_MIN_TTL_MINUTES,
    remoteSupportTokenMaxTtlMinutes: REMOTE_SUPPORT_TOKEN_MAX_TTL_MINUTES,
    callHomeEventsMax: CALL_HOME_EVENTS_MAX,
    callHomeReportPayloadMaxChars: CALL_HOME_REPORT_PAYLOAD_MAX_CHARS,
  });
  const {
    clampRemoteSupportTokenTtlMinutes,
    summarizeRemoteSupportToken,
    trimCallHomeEvents,
    buildRemoteSupportApiBasePath,
    buildRemoteSupportCurlExamples,
    buildRemoteSupportCommandHints,
    buildCallHomePodBundle,
    appendCallHomeEvent,
    authenticateRemoteSupportToken,
  } = remoteSupportService;
  const diagnosticsService = createManagerDiagnosticsService({
    readEnvConfig,
    envPath,
    processState,
    checkBlastdoorHealth,
    checkFoundryTargetHealth,
    detectEnvironmentInfo,
    workspaceDir,
    sanitizeConfigForDiagnostics,
    withBlastdoorApi,
    mapThemeForClient,
    normalizeString,
    defaultThemeId: DEFAULT_THEME_ID,
    accessFile: fs.access,
    parseBooleanLike,
    detectSelfProxyTarget,
    configDefaults: CONFIG_DEFAULTS,
    evaluateGatewayBindHost,
    isLoopbackHost,
    buildWslPortproxyScript,
    runCommandBatch,
    runGatewayLocalChecks,
    commandRunner,
    detectWslDefaultGatewayIp,
    buildWslFoundryTarget,
    validateConfig,
    loadConfigFromEnv,
    writeEnvConfig,
    pluginManager,
    sensitiveConfigKeys: SENSITIVE_CONFIG_KEYS,
    managerHost: DEFAULT_MANAGER_HOST,
    managerPort: DEFAULT_MANAGER_PORT,
  });
  const { createTroubleshootReport, buildDiagnosticsPayload, buildTroubleshootPayload, runTroubleshootAction } =
    diagnosticsService;

  async function applyThreatLockdown(existingConfig) {
    const mergedConfig = {
      ...existingConfig,
      BLAST_DOORS_CLOSED: "true",
      SESSION_SECRET: createSessionSecret(),
    };

    validateConfig(loadConfigFromEnv({ ...mergedConfig }));
    await writeEnvConfig(envPath, mergedConfig);
    await writeBlastDoorsState(runtimeStatePath, true);

    let serviceRestarted = false;
    if (processState.getStatus().running) {
      await processState.stop();
      await processState.start();
      serviceRestarted = true;
    }

    return {
      serviceRestarted,
      sessionSecretRotated: true,
      blastDoorsLocked: true,
      config: scrubConfigForClient(mergedConfig),
    };
  }

  async function buildManagedUserList({ filter = "active" } = {}) {
    return withBlastdoorApi(async ({ configFromEnv, blastdoorApi }) => {
      const credentials = await blastdoorApi.listCredentialUsers();
      const profiles = await blastdoorApi.listUserProfiles({
        sessionMaxAgeHours: Number.parseInt(configFromEnv.SESSION_MAX_AGE_HOURS || "12", 10),
      });
      const profileByUsername = new Map(profiles.map((entry) => [entry.username, entry]));

      const users = credentials.map((credential) => {
        const profile = profileByUsername.get(credential.username) || null;
        const status = normalizeUserStatus(profile?.status || (credential.disabled ? "deactivated" : "active"));
        const authenticatedNow = Boolean(profile?.authenticatedNow && status === "active");
        return {
          username: credential.username,
          friendlyName: profile?.friendlyName || "",
          email: profile?.email || "",
          status,
          displayInfo: profile?.displayInfo || "",
          notes: profile?.notes || "",
          lastLoginAt: profile?.lastLoginAt || "",
          lastKnownIp: profile?.lastKnownIp || "",
          authenticatedNow,
          tempCodeActive: Boolean(profile?.tempCodeActive),
          tempCodeExpiresAt: profile?.tempCodeExpiresAt || "",
          sessionVersion: Number.parseInt(String(profile?.sessionVersion || 1), 10) || 1,
          disabled: credential.disabled === true,
        };
      });

      const selectedFilter = normalizeUserFilter(filter, "active");
      const filteredUsers = users.filter((user) => {
        if (selectedFilter === "all") {
          return true;
        }
        if (selectedFilter === "active") {
          return user.status === "active";
        }
        if (selectedFilter === "inactive") {
          return user.status === "deactivated" || user.status === "banned";
        }
        if (selectedFilter === "authenticated") {
          return user.authenticatedNow;
        }
        return true;
      });

      filteredUsers.sort((a, b) => a.username.localeCompare(b.username));
      return {
        filter: selectedFilter,
        users: filteredUsers,
        counts: {
          total: users.length,
          active: users.filter((entry) => entry.status === "active").length,
          inactive: users.filter((entry) => entry.status === "deactivated" || entry.status === "banned").length,
          authenticated: users.filter((entry) => entry.authenticatedNow).length,
        },
      };
    });
  }

  const configBackupService = createConfigBackupService({
    managedConfigFiles,
    configBackupDir,
    configBackupIdPattern: CONFIG_BACKUP_ID_PATTERN,
    configBackupViewMaxBytes: CONFIG_BACKUP_VIEW_MAX_BYTES,
    validateConfigBackupId,
    normalizeString,
    normalizeConfigBackupName,
    createConfigBackupId,
    readEnvConfig,
    envPath,
    parseBooleanLike,
    writeBlastDoorsState,
    runtimeStatePath,
    processState,
    defaultInstallationConfig,
    detectPlatformType,
    normalizeInstallationConfig,
    writeInstallationConfig,
    syncRuntimeEnvFromInstallation,
    installationConfigPath,
    dockerEnvPath,
    scrubConfigForClient,
  });

  async function detectTlsEnvironment(configFromEnv) {
    const checks = await Promise.all([
      commandRunner({ command: "certbot", args: ["--version"], cwd: workspaceDir, timeoutMs: 4000 }),
      commandRunner({ command: "docker", args: ["--version"], cwd: workspaceDir, timeoutMs: 4000 }),
      commandRunner({ command: "openssl", args: ["version"], cwd: workspaceDir, timeoutMs: 4000 }),
    ]);
    const [certbotCheck, dockerCheck, opensslCheck] = checks;

    const certFile = normalizeString(configFromEnv.TLS_CERT_FILE, "");
    const keyFile = normalizeString(configFromEnv.TLS_KEY_FILE, "");
    let certExists = false;
    let keyExists = false;
    if (certFile) {
      try {
        await fs.access(path.resolve(certFile));
        certExists = true;
      } catch {
        certExists = false;
      }
    }
    if (keyFile) {
      try {
        await fs.access(path.resolve(keyFile));
        keyExists = true;
      } catch {
        keyExists = false;
      }
    }

    return {
      certbotAvailable: Boolean(certbotCheck?.ok),
      dockerAvailable: Boolean(dockerCheck?.ok),
      opensslAvailable: Boolean(opensslCheck?.ok),
      certExists,
      keyExists,
      certbotVersion: normalizeString(certbotCheck?.stdout || certbotCheck?.stderr, ""),
      dockerVersion: normalizeString(dockerCheck?.stdout || dockerCheck?.stderr, ""),
      opensslVersion: normalizeString(opensslCheck?.stdout || opensslCheck?.stderr, ""),
    };
  }

  function normalizeTlsConfigBody(input, existingConfig) {
    const tlsEnabled = parseBooleanLikeBody(input?.tlsEnabled);
    const domain = sanitizeDomain(input?.tlsDomain || existingConfig.TLS_DOMAIN);
    const email = sanitizeEmail(input?.tlsEmail || existingConfig.TLS_EMAIL);
    const challengeMethod = normalizeTlsChallengeMethod(input?.tlsChallengeMethod || existingConfig.TLS_CHALLENGE_METHOD);
    const webrootPath = normalizeString(input?.tlsWebrootPath || existingConfig.TLS_WEBROOT_PATH, "/var/www/html");
    const defaults = resolveDefaultLetsEncryptPaths(domain);
    const certFile = normalizeString(input?.tlsCertFile || existingConfig.TLS_CERT_FILE || defaults.certFile);
    const keyFile = normalizeString(input?.tlsKeyFile || existingConfig.TLS_KEY_FILE || defaults.keyFile);
    const caFile = normalizeString(input?.tlsCaFile || existingConfig.TLS_CA_FILE);
    const passphrase = normalizeString(input?.tlsPassphrase || existingConfig.TLS_PASSPHRASE);

    if (tlsEnabled && (!certFile || !keyFile)) {
      throw new Error("TLS cert/key file paths are required when TLS is enabled.");
    }

    return {
      TLS_ENABLED: tlsEnabled ? "true" : "false",
      TLS_DOMAIN: domain,
      TLS_EMAIL: email,
      TLS_CHALLENGE_METHOD: challengeMethod,
      TLS_WEBROOT_PATH: challengeMethod === "webroot" ? webrootPath : "",
      TLS_CERT_FILE: certFile,
      TLS_KEY_FILE: keyFile,
      TLS_CA_FILE: caFile,
      TLS_PASSPHRASE: passphrase,
    };
  }

  async function validateGatewayStartConfiguration() {
    const [config, environment] = await Promise.all([
      readEnvConfig(envPath),
      Promise.resolve(detectEnvironmentInfo({ workspaceDir, envPath })),
    ]);

    const bindValidation = evaluateGatewayBindHost({
      host: config.HOST,
      environment,
    });
    if (!bindValidation.ok) {
      const recommendationText = bindValidation.recommendation ? ` ${bindValidation.recommendation}` : "";
      throw new Error(
        `Configured HOST=${bindValidation.host} is not available on this runtime host and will fail with EADDRNOTAVAIL.${recommendationText}`,
      );
    }
  }

  async function buildObjectStoreStatus(config, installationConfig) {
    const fromEnv = normalizeString(config.OBJECT_STORAGE_MODE, "").toLowerCase();
    const fromInstall = normalizeString(installationConfig?.objectStorage, "").toLowerCase();
    const type = fromEnv || fromInstall || "local";
    if (type === "local") {
      try {
        await fs.access(graphicsDir);
        return { type, reachable: true };
      } catch (error) {
        return {
          type,
          reachable: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      type,
      reachable: false,
      error: "not-implemented",
    };
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(
    "/graphics",
    express.static(graphicsDir, {
      etag: true,
      maxAge: "1h",
    }),
  );
  const managerAccessReadLimiter = rateLimit({
    windowMs: managerWriteRateLimitWindowMs,
    max: Math.max(120, Math.min(1200, managerWriteRateLimitMax * 4)),
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many manager requests. Try again shortly.",
  });
  app.use(managerAccessReadLimiter);
  app.use((req, res, next) => {
    void enforceManagerAccess(req, res, next);
  });
  app.get("/manager/login", async (req, res, next) => {
    try {
      const settings = await readConsoleSettings();
      if (!settings.access.requirePassword) {
        res.redirect("/manager/");
        return;
      }
      if (getManagerAuthSession(req)) {
        const nextPath = normalizeManagerNextPath(req.query?.next, "/manager/");
        res.redirect(nextPath);
        return;
      }
      const nextPath = normalizeManagerNextPath(req.query?.next, "/manager/");
      res
        .status(200)
        .set("cache-control", "no-store")
        .send(renderManagerLoginPage({ nextPath }));
    } catch (error) {
      next(error);
    }
  });
  app.use(
    "/manager",
    express.static(managerDir, {
      etag: true,
      maxAge: 0,
      setHeaders(res) {
        res.setHeader("Cache-Control", "no-store");
      },
    }),
  );

  const managerWriteLimiter = rateLimit({
    windowMs: managerWriteRateLimitWindowMs,
    max: managerWriteRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many manager write requests. Try again shortly.",
  });

  const registerApiGet = (routePath, handler) => {
    app.get(`/api${routePath}`, handler);
    app.get(`/manager/api${routePath}`, handler);
  };

  const registerApiPost = (routePath, handler) => {
    app.post(`/api${routePath}`, managerWriteLimiter, handler);
    app.post(`/manager/api${routePath}`, managerWriteLimiter, handler);
  };

  const remoteSupportReadLimiter = rateLimit({
    windowMs: managerWriteRateLimitWindowMs,
    max: Math.max(30, Math.min(300, managerWriteRateLimitMax * 2)),
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many remote support requests. Try again shortly.",
  });

  const remoteSupportWriteLimiter = rateLimit({
    windowMs: managerWriteRateLimitWindowMs,
    max: Math.max(10, Math.min(120, Math.floor(managerWriteRateLimitMax / 2))),
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many remote support write requests. Try again shortly.",
  });

  function registerRemoteSupportGet(routePath, handler) {
    app.get(`/api/remote-support/v1${routePath}`, remoteSupportReadLimiter, async (req, res) => {
      const auth = await authenticateRemoteSupportToken(req);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
      req.remoteSupportToken = auth.token;
      req.remoteSupportSettings = auth.settings;
      await handler(req, res);
    });
  }

  function registerRemoteSupportPost(routePath, handler) {
    app.post(`/api/remote-support/v1${routePath}`, remoteSupportWriteLimiter, async (req, res) => {
      const auth = await authenticateRemoteSupportToken(req);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
      req.remoteSupportToken = auth.token;
      req.remoteSupportSettings = auth.settings;
      await handler(req, res);
    });
  }

  app.get("/", (_req, res) => {
    res.redirect("/manager/");
  });

  registerManagerAuthRoutes({
    registerApiGet,
    registerApiPost,
    readConsoleSettings,
    getManagerAuthSession,
    normalizeManagerNextPath,
    normalizeString,
    verifyPassword,
    createManagerAuthSession,
    createCookieHeader,
    managerAuthCookieName: MANAGER_AUTH_COOKIE_NAME,
    clearManagerAuthSession,
    renderManagerLoginPage,
  });

  registerManagerConfigRoutes({
    registerApiGet,
    registerApiPost,
    readConsoleSettings,
    writeConsoleSettings,
    sanitizeManagerConsoleSettingsForClient,
    normalizeManagerConsoleSettings,
    parseBooleanLikeBody,
    normalizeString,
    createPasswordHash,
    readEnvConfig,
    envPath,
    scrubConfigForClient,
    detectEnvironmentInfo,
    workspaceDir,
    detectWslDefaultGatewayIp,
    commandRunner,
    buildWslFoundryTarget,
    checkFoundryTargetHealth,
    probeFoundryApiStatus,
    buildWslOllamaUrl,
    probeHttpHealth,
    parseBodyConfig,
    sensitiveConfigKeys: SENSITIVE_CONFIG_KEYS,
    parseBooleanLike,
    createSessionSecret,
    validateConfig,
    loadConfigFromEnv,
    writeEnvConfig,
    writeBlastDoorsState,
    runtimeStatePath,
    configDefaults: CONFIG_DEFAULTS,
    processState,
    listConfigBackups: configBackupService.listBackups,
    configBackupDir,
    validateConfigBackupId,
    viewConfigBackup: configBackupService.viewBackup,
    createConfigBackup: configBackupService.createBackup,
    restoreConfigBackup: configBackupService.restoreBackup,
    deleteConfigBackup: configBackupService.deleteBackup,
    cleanInstallConfiguration: configBackupService.cleanInstall,
    detectTlsEnvironment,
    normalizeTlsChallengeMethod,
    normalizeTlsConfigBody,
    buildLetsEncryptPlan,
    accessFile: fs.access,
    resolvePath: path.resolve,
  });

  registerManagerServiceRoutes({
    registerApiGet,
    registerApiPost,
    validateGatewayStartConfiguration,
    processState,
    recordFailureEntry,
    readEnvConfig,
    envPath,
    createSessionSecret,
    writeEnvConfig,
    withBlastdoorApi,
    createSessionKey,
    validateManagedUsernameForActions,
    safeEqual,
  });

  registerManagerUserRoutes({
    registerApiGet,
    registerApiPost,
    normalizeUserFilter,
    buildManagedUserList,
    validateManagedUsername,
    validateManagedUsernameForActions,
    normalizeString,
    normalizeUserStatus,
    sanitizeLongText,
    sanitizeEmail,
    withBlastdoorApi,
    createPasswordHash,
    createEmailService,
    loadEmailConfigFromEnv,
    resolveGatewayBaseUrl,
  });

  registerManagerOperationsRoutes({
    registerApiGet,
    registerApiPost,
    getControlPlaneStatusCached,
    readFailureStore,
    summarizeFailureStore,
    clearFailureStore,
    failureStorePath,
    processState,
    readEnvConfig,
    envPath,
    checkBlastdoorHealth,
    workspaceDir,
    configDefaults: CONFIG_DEFAULTS,
    tailFile,
  });

  registerManagerThemeRoutes({
    registerApiGet,
    registerApiPost,
    withBlastdoorApi,
    mapThemeForClient,
    validateThemeAssetSelection,
    parseBooleanLikeBody,
    createThemeId,
    normalizeString,
    normalizeThemeName,
    defaultThemeId: DEFAULT_THEME_ID,
  });

  registerDiagnosticsRoutes({
    registerApiGet,
    registerApiPost,
    buildDiagnosticsPayload,
    buildTroubleshootPayload,
    normalizeString,
    readEnvConfig,
    detectEnvironmentInfo,
    envPath,
    workspaceDir,
    runTroubleshootAction,
    commandRunner,
    controlPlaneCache: controlPlaneStatusService.cache,
    operationTimeoutMs: managerOperationTimeoutMs,
  });

  registerRemoteSupportRoutes({
    registerApiGet,
    registerApiPost,
    registerRemoteSupportGet,
    registerRemoteSupportPost,
    normalizeString,
    parseBooleanLike,
    readConsoleSettings,
    writeConsoleSettings,
    clampRemoteSupportTokenTtlMinutes,
    remoteSupportTokenMinTtlMinutes: REMOTE_SUPPORT_TOKEN_MIN_TTL_MINUTES,
    remoteSupportTokenMaxTtlMinutes: REMOTE_SUPPORT_TOKEN_MAX_TTL_MINUTES,
    remoteSupportDefaultTokenLabel: REMOTE_SUPPORT_DEFAULT_TOKEN_LABEL,
    trimCallHomeEvents,
    summarizeRemoteSupportToken,
    callHomeEventsMax: CALL_HOME_EVENTS_MAX,
    syncRemoteSupportWslExposure,
    detectEnvironmentInfo,
    workspaceDir,
    envPath,
    commandRunner,
    randomBytes,
    randomUUID,
    createPasswordHash,
    buildRemoteSupportCurlExamples,
    buildCallHomePodBundle,
    buildRemoteSupportApiBasePath,
    appendCallHomeEvent,
    buildDiagnosticsPayload,
    buildRemoteSupportCommandHints,
    buildTroubleshootPayload,
    remoteSupportSafeActionAllowlist: REMOTE_SUPPORT_SAFE_ACTION_ALLOWLIST,
    readEnvConfig,
    runTroubleshootAction,
    withBlastdoorApi,
    readIntelligenceAgentStore,
    intelligenceAgentStorePath,
    operationTimeoutMs: managerOperationTimeoutMs,
  });

  registerApiGet("/plugins/ui", async (_req, res) => {
    res.json({
      ok: true,
      plugins: pluginManager.getManagerUiAssets(),
    });
  });

  pluginManager.registerManagerRoutes({
    registerApiGet,
    registerApiPost,
    readEnvConfig,
    withBlastdoorApi,
    processState,
    workspaceDir,
    envPath,
    checkBlastdoorHealth,
    checkFoundryTargetHealth,
    detectEnvironmentInfo,
    sanitizeConfigForDiagnostics,
    createTroubleshootReport,
    tailFile,
    parseBooleanLike,
    parseBooleanLikeBody,
    normalizeString,
    applyThreatLockdown,
    runTroubleshootAction,
    commandRunner,
    CONFIG_DEFAULTS,
    installationConfigPath,
  });

  return { app, envPath };
}

export function createManagerServer(options = {}) {
  const host = options.host || DEFAULT_MANAGER_HOST;
  const port = Number.isInteger(options.port) ? options.port : DEFAULT_MANAGER_PORT;
  const { app } = createManagerApp(options);
  const exitOnError = options.exitOnError !== false;
  const onListenError =
    options.onListenError ||
    ((error, context) => {
      console.error(formatManagerListenError(error, context));
      if (exitOnError) {
        process.exit(1);
      }
    });

  const server = app.listen(port, host, () => {
    if (!options.silent) {
      console.log(`Blastdoor Manager available at http://${host}:${port}/manager/`);
    }
  });

  server.on("error", (error) => {
    onListenError(error, { host, port, exitOnError });
  });

  return server;
}

export function formatManagerListenError(error, { host, port } = {}) {
  const boundHost = host || DEFAULT_MANAGER_HOST;
  const boundPort = port || DEFAULT_MANAGER_PORT;

  if (error && error.code === "EADDRINUSE") {
    return [
      `Blastdoor Manager could not start because ${boundHost}:${boundPort} is already in use.`,
      `Another manager instance is likely already running at http://${boundHost}:${boundPort}/manager/.`,
      "Stop the existing process or set MANAGER_PORT to a different port, then retry make manager-launch.",
    ].join(" ");
  }

  return `Blastdoor Manager failed to start on ${boundHost}:${boundPort}: ${error instanceof Error ? error.message : String(error)}`;
}

function isEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }

  return path.resolve(process.argv[1]) === __filename;
}

if (isEntrypoint()) {
  process.title = "blastdoor-manager";
  createManagerServer();
}
