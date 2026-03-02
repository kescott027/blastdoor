import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
  };
}

function createDiagnosticsSummary(report) {
  const config = report.config;
  const status = report.serviceStatus || {};
  const health = report.health || {};
  const env = report.environment || {};
  const loginAppearance = report.loginAppearance || {};
  const usesPostgres = config.PASSWORD_STORE_MODE === "postgres" || config.CONFIG_STORE_MODE === "postgres";
  const usesSqlite = config.PASSWORD_STORE_MODE === "sqlite" || config.CONFIG_STORE_MODE === "sqlite";
  const backend = usesPostgres ? "postgres" : usesSqlite ? "sqlite" : "env/file";

  const pluginLines = pluginManager.getManagerDiagnosticsSummaryLines(config);
  const redactionKeys = ["AUTH_PASSWORD_HASH", ...SENSITIVE_CONFIG_KEYS, "POSTGRES_URL credentials"];

  const lines = [
    `Generated: ${report.generatedAt}`,
    `Gateway Bind: ${config.HOST || "unset"}:${config.PORT || "unset"}`,
    `Foundry Target: ${config.FOUNDRY_TARGET || "unset"}`,
    `Service Running: ${status.running ? "yes" : "no"} (pid: ${status.pid || "n/a"})`,
    `Health Check: ${health.ok ? "healthy" : "unhealthy"}${health.statusCode ? ` (${health.statusCode})` : ""}`,
    `Auth Username: ${config.AUTH_USERNAME || "unset"}`,
    `Require TOTP: ${config.REQUIRE_TOTP || "false"}`,
    `Password Store Mode: ${config.PASSWORD_STORE_MODE || "unset"}`,
    `Config Store Mode: ${config.CONFIG_STORE_MODE || "unset"}`,
    `Database Backend: ${backend}`,
    `Postgres URL: ${config.POSTGRES_URL || "n/a"}`,
    `Login Theme: ${loginAppearance.activeThemeName || "n/a"} (${loginAppearance.activeThemeId || "n/a"})`,
    `Login Assets: logo=${loginAppearance.assets?.logo?.status || "n/a"}, closed=${loginAppearance.assets?.closedBackground?.status || "n/a"}, open=${loginAppearance.assets?.openBackground?.status || "n/a"}`,
    ...pluginLines,
    `Debug Mode: ${config.DEBUG_MODE || "false"} (log: ${config.DEBUG_LOG_FILE || "unset"})`,
    `Manager UI: http://${env.managerHost || DEFAULT_MANAGER_HOST}:${env.managerPort || DEFAULT_MANAGER_PORT}/manager/`,
    `Runtime: ${env.platform || "unknown"} ${env.arch || "unknown"}, Node ${env.nodeVersion || "unknown"}${env.isWsl ? `, WSL (${env.wslDistro || "unknown"})` : ""}`,
    `Redactions: ${redactionKeys.join(", ")}`,
  ];

  return lines.join("\n");
}

function normalizeThemeAssetRelativePath(value) {
  const normalized = normalizeString(value, "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    return "";
  }
  return normalized;
}

function resolveThemeAssetAbsolutePath(graphicsDir, relativePath) {
  const normalized = normalizeThemeAssetRelativePath(relativePath);
  if (!normalized) {
    return "";
  }

  const baseDir = path.resolve(graphicsDir);
  const absolutePath = path.resolve(baseDir, normalized);
  if (absolutePath === baseDir || !absolutePath.startsWith(`${baseDir}${path.sep}`)) {
    return "";
  }

  return absolutePath;
}

function normalizeLoginAppearanceTheme(theme) {
  const normalized = theme && typeof theme === "object" ? theme : {};
  return {
    id: normalizeString(normalized.id, ""),
    name: normalizeString(normalized.name, ""),
    logoPath: normalizeThemeAssetRelativePath(normalized.logoPath),
    logoUrl: normalizeString(normalized.logoUrl, ""),
    closedBackgroundPath: normalizeThemeAssetRelativePath(normalized.closedBackgroundPath),
    closedBackgroundUrl: normalizeString(normalized.closedBackgroundUrl, ""),
    openBackgroundPath: normalizeThemeAssetRelativePath(normalized.openBackgroundPath),
    openBackgroundUrl: normalizeString(normalized.openBackgroundUrl, ""),
    loginBoxMode: normalizeString(normalized.loginBoxMode, "dark"),
    loginBoxWidthPercent: Number.parseInt(String(normalized.loginBoxWidthPercent || 100), 10) || 100,
    loginBoxHeightPercent: Number.parseInt(String(normalized.loginBoxHeightPercent || 100), 10) || 100,
    loginBoxOpacityPercent: Number.parseInt(String(normalized.loginBoxOpacityPercent || 100), 10) || 100,
    loginBoxHoverOpacityPercent: Number.parseInt(String(normalized.loginBoxHoverOpacityPercent || 100), 10) || 100,
    loginBoxPosXPercent: Number.parseInt(String(normalized.loginBoxPosXPercent || 50), 10) || 50,
    loginBoxPosYPercent: Number.parseInt(String(normalized.loginBoxPosYPercent || 50), 10) || 50,
    logoSizePercent: Number.parseInt(String(normalized.logoSizePercent || 30), 10) || 30,
    logoOffsetXPercent: Number.parseInt(String(normalized.logoOffsetXPercent || 2), 10) || 2,
    logoOffsetYPercent: Number.parseInt(String(normalized.logoOffsetYPercent || 2), 10) || 2,
    backgroundZoomPercent: Number.parseInt(String(normalized.backgroundZoomPercent || 100), 10) || 100,
  };
}

function formatLoginAppearanceCopyPasteText(details) {
  return [
    `activeThemeId: ${details.activeThemeId || ""}`,
    `theme.id: ${details.activeTheme.id || ""}`,
    `theme.name: ${details.activeTheme.name || ""}`,
    `theme.logoPath: ${details.activeTheme.logoPath || ""}`,
    `theme.closedBackgroundPath: ${details.activeTheme.closedBackgroundPath || ""}`,
    `theme.openBackgroundPath: ${details.activeTheme.openBackgroundPath || ""}`,
    `theme.loginBoxMode: ${details.activeTheme.loginBoxMode || "dark"}`,
    `theme.loginBoxWidthPercent: ${details.activeTheme.loginBoxWidthPercent}`,
    `theme.loginBoxHeightPercent: ${details.activeTheme.loginBoxHeightPercent}`,
    `theme.loginBoxOpacityPercent: ${details.activeTheme.loginBoxOpacityPercent}`,
    `theme.loginBoxHoverOpacityPercent: ${details.activeTheme.loginBoxHoverOpacityPercent}`,
    `theme.loginBoxPosXPercent: ${details.activeTheme.loginBoxPosXPercent}`,
    `theme.loginBoxPosYPercent: ${details.activeTheme.loginBoxPosYPercent}`,
    `theme.logoSizePercent: ${details.activeTheme.logoSizePercent}`,
    `theme.logoOffsetXPercent: ${details.activeTheme.logoOffsetXPercent}`,
    `theme.logoOffsetYPercent: ${details.activeTheme.logoOffsetYPercent}`,
    `theme.backgroundZoomPercent: ${details.activeTheme.backgroundZoomPercent}`,
  ].join("\n");
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

function parseCookies(headerValue) {
  const cookies = {};
  const raw = String(headerValue || "");
  if (!raw) {
    return cookies;
  }

  for (const chunk of raw.split(";")) {
    const [namePart, ...valueParts] = chunk.split("=");
    const name = String(namePart || "").trim();
    if (!name) {
      continue;
    }
    const value = valueParts.join("=").trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  return cookies;
}

function createCookieHeader(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(String(value || ""))}`];
  parts.push(`Path=${options.path || "/"}`);
  if (Number.isInteger(options.maxAge)) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function normalizeManagerNextPath(value, fallback = "/manager/") {
  const candidate = String(value || "").trim();
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) {
    return fallback;
  }
  if (candidate.includes("..") || candidate.includes("\\")) {
    return fallback;
  }
  if (!candidate.startsWith("/manager")) {
    return "/manager/";
  }
  return candidate;
}

function renderManagerLoginPage({ error = "", nextPath = "/manager/" } = {}) {
  const safeNext = normalizeManagerNextPath(nextPath, "/manager/");
  const safeError = normalizeString(error, "");
  const errorBlock = safeError
    ? `<p class="manager-login-error">${safeError.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Blastdoor Manager Login</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at 15% 15%, rgba(155, 224, 255, 0.14), transparent 32%),
          radial-gradient(circle at 88% 18%, rgba(182, 255, 172, 0.1), transparent 30%),
          linear-gradient(180deg, #131926, #090b10);
        color: #e7edf6;
      }
      main {
        width: min(420px, 92vw);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 14px;
        padding: 1.1rem 1.1rem 1.2rem;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(10, 14, 24, 0.92));
      }
      h1 {
        margin: 0 0 0.35rem;
        font-size: 1.28rem;
      }
      p {
        margin: 0 0 0.8rem;
        color: #9ca8bd;
        font-size: 0.92rem;
      }
      label {
        display: grid;
        gap: 0.3rem;
        font-size: 0.85rem;
      }
      input {
        width: 100%;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(10, 14, 24, 0.95);
        color: #e7edf6;
        padding: 0.55rem 0.6rem;
        font-size: 0.95rem;
      }
      button {
        margin-top: 0.8rem;
        width: 100%;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: linear-gradient(180deg, #263557, #1b2741);
        color: #e7edf6;
        padding: 0.55rem 0.7rem;
        font-size: 0.95rem;
        cursor: pointer;
      }
      .manager-login-error {
        margin: 0 0 0.8rem;
        color: #ff9a9a;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Blastdoor Manager Login</h1>
      <p>Manager access is password protected.</p>
      ${errorBlock}
      <form method="post" action="/api/manager-auth/login-form">
        <input type="hidden" name="next" value="${safeNext.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}" />
        <label>
          Password
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit">Unlock Manager</button>
      </form>
    </main>
  </body>
</html>`;
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

async function checkFoundryTargetHealth(config) {
  const rawTarget = normalizeString(config.FOUNDRY_TARGET, "");
  if (!rawTarget) {
    return {
      ok: false,
      statusCode: null,
      url: "",
      error: "FOUNDRY_TARGET is not configured.",
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
    };
  }

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

function createTroubleshootChecks({ config, health, foundryHealth, environment }) {
  const checks = [];
  const blastDoorsClosed = parseBooleanLike(config.BLAST_DOORS_CLOSED, false);
  const selfTarget = detectSelfProxyTarget({
    host: normalizeString(config.HOST, CONFIG_DEFAULTS.HOST),
    port: Number.parseInt(config.PORT || CONFIG_DEFAULTS.PORT, 10),
    foundryTarget: normalizeString(config.FOUNDRY_TARGET, CONFIG_DEFAULTS.FOUNDRY_TARGET),
  });

  checks.push({
    id: "gateway.blastdoors",
    title: "Blast doors lockout state",
    status: blastDoorsClosed ? "warn" : "ok",
    detail: blastDoorsClosed
      ? "Blast doors are LOCKED. All gateway routes are intentionally blocked."
      : "Blast doors are UNLOCKED. Normal authenticated gateway routing is available.",
    recommendation: blastDoorsClosed
      ? "Unlock blast doors from the admin panel when maintenance is complete."
      : null,
  });

  const bindValidation = evaluateGatewayBindHost({
    host: config.HOST,
    environment,
  });
  checks.push({
    id: "network.bind-address",
    title: "Gateway bind address",
    status: bindValidation.ok ? (config.HOST === "0.0.0.0" ? "ok" : "warn") : "error",
    detail: bindValidation.ok
      ? config.HOST === "0.0.0.0"
        ? "Gateway is listening on all interfaces."
        : `Gateway is bound to ${config.HOST}. LAN access may fail unless HOST=0.0.0.0.`
      : `Configured HOST=${bindValidation.host} is not available on this runtime host and startup will fail with EADDRNOTAVAIL.`,
    recommendation: bindValidation.ok
      ? config.HOST === "0.0.0.0"
        ? null
        : "Set HOST=0.0.0.0 and restart Blastdoor."
      : bindValidation.recommendation || "Set HOST=0.0.0.0 and restart Blastdoor.",
  });

  checks.push({
    id: "gateway.local-health",
    title: "Local health check",
    status: health.ok ? "ok" : "error",
    detail: health.ok
      ? `Gateway responded from ${health.url} with status ${health.statusCode}.`
      : `Gateway health endpoint is unreachable at ${health.url}${health.error ? ` (${health.error})` : ""}.`,
    recommendation: health.ok ? null : "Confirm service status and check Runtime/Debug logs.",
  });

  if (selfTarget.isSelfTarget) {
    checks.push({
      id: "proxy.self-target",
      title: "Proxy self-target loop detection",
      status: "error",
      detail: `FOUNDRY_TARGET resolves to the Blastdoor gateway address (${selfTarget.targetHost}:${selfTarget.targetPort}).`,
      recommendation:
        "Set FOUNDRY_TARGET to your Foundry VTT server endpoint (different host/port than Blastdoor), then restart.",
    });
  } else {
    checks.push({
      id: "proxy.foundry-target-health",
      title: "Foundry target reachability",
      status: foundryHealth.ok ? "ok" : "error",
      detail: foundryHealth.ok
        ? `Foundry target responded from ${foundryHealth.url} with status ${foundryHealth.statusCode}.`
        : `Unable to reach Foundry target at ${foundryHealth.url || "unset"}${foundryHealth.error ? ` (${foundryHealth.error})` : ""}.`,
      recommendation: foundryHealth.ok
        ? null
        : environment.isWsl
          ? "When running in WSL, ensure FOUNDRY_TARGET points to an address reachable from Linux and that Foundry is running."
          : "Verify Foundry is running and FOUNDRY_TARGET points to the correct service address and port.",
    });
  }

  const cookieSecure = parseBooleanLike(config.COOKIE_SECURE, false);
  checks.push({
    id: "auth.cookie-secure",
    title: "Cookie security over HTTP",
    status: cookieSecure ? "warn" : "ok",
    detail: cookieSecure
      ? "COOKIE_SECURE=true. Authentication cookies are only sent over HTTPS."
      : "COOKIE_SECURE=false. Local HTTP testing is allowed.",
    recommendation: cookieSecure
      ? "Use HTTPS for external access, or set COOKIE_SECURE=false for local HTTP testing only."
      : "Enable COOKIE_SECURE=true when fronting Blastdoor with TLS.",
  });

  if (environment.isWsl) {
    checks.push({
      id: "network.wsl2-portproxy",
      title: "WSL2 LAN routing",
      status: "warn",
      detail:
        "WSL2 uses NAT. localhost works on the host machine, but LAN clients usually need Windows portproxy and firewall rules.",
      recommendation:
        "Run non-destructive detection first, then review and apply the generated Windows portproxy script if needed.",
    });
  }

  return checks;
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

function buildGuidedActions({ environment, config }) {
  if (!environment.isWsl) {
    return [];
  }

  return [
    {
      id: "guide.wsl2-portproxy-fix",
      title: "WSL2 portproxy update script",
      destructive: true,
      riskLevel: "potentially-destructive",
      description:
        "Generates a Windows PowerShell script to update portproxy and firewall rules for LAN access.",
      script: buildWslPortproxyScript({ environment, config }),
      warning:
        "This changes Windows networking configuration. Review and run manually, and research commands independently before applying.",
    },
  ];
}

function buildSafeActions(environment) {
  const actions = [
    {
      id: "snapshot.network",
      title: "Gather network snapshot",
      destructive: false,
      description: "Collect read-only networking command outputs (ss, ip, route, hostname, ufw status).",
    },
    {
      id: "check.gateway-local",
      title: "Test gateway access",
      destructive: false,
      description: "Runs local health checks against configured Blastdoor endpoints.",
    },
  ];

  if (environment.isWsl) {
    actions.push({
      id: "detect.wsl-portproxy",
      title: "Detect Windows portproxy",
      destructive: false,
      description: "Runs read-only checks for Windows portproxy and firewall rule visibility from WSL.",
    });
  }

  return actions;
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

async function runTroubleshootAction({ actionId, config, environment, workspaceDir, commandRunner }) {
  if (actionId === "snapshot.network") {
    const outputs = await runCommandBatch(
      commandRunner,
      [
        { label: "Listening TCP sockets", command: "ss", args: ["-ltn"] },
        { label: "IPv4 interfaces", command: "ip", args: ["-4", "addr", "show"] },
        { label: "Route table", command: "ip", args: ["route"] },
        { label: "Host IP addresses", command: "hostname", args: ["-I"] },
        { label: "UFW status (if installed)", command: "ufw", args: ["status"] },
      ],
      workspaceDir,
    );

    return {
      actionId,
      title: "Network snapshot",
      destructive: false,
      generatedAt: new Date().toISOString(),
      outputs,
    };
  }

  if (actionId === "check.gateway-local") {
    const outputs = await runGatewayLocalChecks(config);
    return {
      actionId,
      title: "Gateway local access checks",
      destructive: false,
      generatedAt: new Date().toISOString(),
      outputs,
    };
  }

  if (actionId === "detect.wsl-portproxy") {
    if (!environment.isWsl) {
      throw new Error("detect.wsl-portproxy is only available when running inside WSL.");
    }

    const port = Number.parseInt(config.PORT || CONFIG_DEFAULTS.PORT, 10);
    const outputs = await runCommandBatch(
      commandRunner,
      [
        {
          label: "Windows portproxy entries",
          command: "powershell.exe",
          args: ["-NoProfile", "-Command", "netsh interface portproxy show all"],
        },
        {
          label: "Windows firewall rule check",
          command: "powershell.exe",
          args: [
            "-NoProfile",
            "-Command",
            `Get-NetFirewallRule -DisplayName 'Blastdoor ${port}' | Format-Table -AutoSize DisplayName,Enabled,Direction,Action`,
          ],
        },
      ],
      workspaceDir,
    );

    return {
      actionId,
      title: "WSL2 portproxy detection",
      destructive: false,
      generatedAt: new Date().toISOString(),
      outputs,
    };
  }

  throw new Error(`Unknown or unsupported troubleshooting action '${actionId}'.`);
}

function createLoginAppearanceChecks(loginAppearance) {
  if (!loginAppearance || typeof loginAppearance !== "object") {
    return [];
  }

  if (loginAppearance.error) {
    return [
      {
        id: "login-theme.diagnostics-error",
        title: "Login appearance diagnostics",
        status: "warn",
        detail: `Unable to evaluate login appearance settings (${loginAppearance.error}).`,
        recommendation: "Verify theme store configuration and graphics directory permissions.",
      },
    ];
  }

  const checks = [];
  const themeName = loginAppearance.activeThemeName || loginAppearance.activeThemeId || "unknown";
  const logo = loginAppearance.assets?.logo;
  const closedBackground = loginAppearance.assets?.closedBackground;
  const openBackground = loginAppearance.assets?.openBackground;

  if (logo?.exists === false) {
    checks.push({
      id: "login-theme.logo-missing",
      title: "Login logo asset",
      status: "warn",
      detail: `Active theme '${themeName}' references missing logo asset '${logo.path || "unset"}'.`,
      recommendation: "Select a valid logo in Login Screen Management, or clear the logo path.",
    });
  }

  if (closedBackground?.exists === false) {
    checks.push({
      id: "login-theme.closed-background-missing",
      title: "Login closed background asset",
      status: "error",
      detail: `Active theme '${themeName}' references missing closed background '${closedBackground.path || "unset"}'.`,
      recommendation: "Set a valid closed background image in Login Screen Management.",
    });
  }

  if (openBackground?.exists === false) {
    checks.push({
      id: "login-theme.open-background-missing",
      title: "Login open background asset",
      status: "warn",
      detail: `Active theme '${themeName}' references missing open background '${openBackground.path || "unset"}'.`,
      recommendation: "Set a valid open background image, or leave it empty to keep closed background during transition.",
    });
  }

  if (checks.length === 0) {
    checks.push({
      id: "login-theme.assets",
      title: "Login theme assets",
      status: "ok",
      detail: `Active theme '${themeName}' asset paths are valid.`,
      recommendation: null,
    });
  }

  return checks;
}

function createTroubleshootReport({ config, health, foundryHealth, environment, serviceStatus, loginAppearance }) {
  const checks = [
    ...createTroubleshootChecks({ config, health, foundryHealth, environment }),
    ...createLoginAppearanceChecks(loginAppearance),
  ];

  return {
    generatedAt: new Date().toISOString(),
    serviceStatus,
    environment,
    loginAppearance,
    checks,
    safeActions: buildSafeActions(environment),
    guidedActions: buildGuidedActions({ environment, config }),
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
  const failureStorePath = options.failureStorePath || path.join(workspaceDir, "data", "launch-failures.json");
  const managerConsoleSettingsPath =
    options.managerConsoleSettingsPath || path.join(workspaceDir, "data", "manager-console-settings.json");
  const processFactory = options.processFactory || spawn;
  const commandRunner = options.commandRunner || runDiagnosticCommand;
  const postgresPoolFactory = options.postgresPoolFactory;
  const processState = createProcessState({ workspaceDir, processFactory });
  const managerStartedAtMs = Date.now();
  const managerAuthSessions = new Map();
  let managerConsoleSettingsCache = null;
  const controlPlaneCache = {
    payload: null,
    updatedAtMs: 0,
    inflight: null,
  };
  const managerWriteRateLimitWindowMs = Number.isInteger(options.managerWriteRateLimitWindowMs)
    ? options.managerWriteRateLimitWindowMs
    : 15 * 60 * 1000;
  const managerWriteRateLimitMax = Number.isInteger(options.managerWriteRateLimitMax)
    ? options.managerWriteRateLimitMax
    : 120;
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
        blastdoorApi,
      });
    } finally {
      if (typeof blastdoorApi?.close === "function") {
        await blastdoorApi.close();
      }
    }
  }

  async function resolveThemeAssetState(relativePath, url) {
    const normalizedPath = normalizeThemeAssetRelativePath(relativePath);
    const normalizedUrl = normalizeString(url, "");
    if (!normalizedPath) {
      return {
        path: "",
        url: normalizedUrl,
        exists: null,
        status: "unset",
      };
    }

    const absolutePath = resolveThemeAssetAbsolutePath(graphicsDir, normalizedPath);
    if (!absolutePath) {
      return {
        path: normalizedPath,
        url: normalizedUrl,
        exists: false,
        status: "invalid-path",
      };
    }

    try {
      await fs.access(absolutePath);
      return {
        path: normalizedPath,
        url: normalizedUrl,
        exists: true,
        status: "ok",
      };
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return {
          path: normalizedPath,
          url: normalizedUrl,
          exists: false,
          status: "missing",
        };
      }
      return {
        path: normalizedPath,
        url: normalizedUrl,
        exists: false,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function resolveLoginAppearanceDetails() {
    try {
      return await withBlastdoorApi(async ({ blastdoorApi }) => {
        const [store, assets] = await Promise.all([blastdoorApi.readThemeStore(), blastdoorApi.listThemeAssets()]);
        const themes = Array.isArray(store?.themes) ? store.themes : [];
        const activeThemeId = normalizeString(store?.activeThemeId, DEFAULT_THEME_ID);
        const activeThemeRaw = themes.find((theme) => normalizeString(theme?.id, "") === activeThemeId) || themes[0] || null;
        const activeTheme = normalizeLoginAppearanceTheme(activeThemeRaw ? mapThemeForClient(activeThemeRaw) : {});

        const [logoState, closedBackgroundState, openBackgroundState] = await Promise.all([
          resolveThemeAssetState(activeTheme.logoPath, activeTheme.logoUrl),
          resolveThemeAssetState(activeTheme.closedBackgroundPath, activeTheme.closedBackgroundUrl),
          resolveThemeAssetState(activeTheme.openBackgroundPath, activeTheme.openBackgroundUrl),
        ]);

        const details = {
          activeThemeId,
          activeThemeName: activeTheme.name || activeTheme.id || "",
          themesAvailable: themes.length,
          themeCatalog: themes.map((theme) => ({
            id: normalizeString(theme?.id, ""),
            name: normalizeString(theme?.name, ""),
          })),
          assetCounts: {
            logos: Array.isArray(assets?.logos) ? assets.logos.length : 0,
            backgrounds: Array.isArray(assets?.backgrounds) ? assets.backgrounds.length : 0,
          },
          assets: {
            logo: logoState,
            closedBackground: closedBackgroundState,
            openBackground: openBackgroundState,
          },
          activeTheme: {
            id: activeTheme.id,
            name: activeTheme.name,
            logoPath: activeTheme.logoPath,
            logoUrl: activeTheme.logoUrl,
            closedBackgroundPath: activeTheme.closedBackgroundPath,
            closedBackgroundUrl: activeTheme.closedBackgroundUrl,
            openBackgroundPath: activeTheme.openBackgroundPath,
            openBackgroundUrl: activeTheme.openBackgroundUrl,
            loginBoxMode: activeTheme.loginBoxMode,
            loginBoxWidthPercent: activeTheme.loginBoxWidthPercent,
            loginBoxHeightPercent: activeTheme.loginBoxHeightPercent,
            loginBoxOpacityPercent: activeTheme.loginBoxOpacityPercent,
            loginBoxHoverOpacityPercent: activeTheme.loginBoxHoverOpacityPercent,
            loginBoxPosXPercent: activeTheme.loginBoxPosXPercent,
            loginBoxPosYPercent: activeTheme.loginBoxPosYPercent,
            logoSizePercent: activeTheme.logoSizePercent,
            logoOffsetXPercent: activeTheme.logoOffsetXPercent,
            logoOffsetYPercent: activeTheme.logoOffsetYPercent,
            backgroundZoomPercent: activeTheme.backgroundZoomPercent,
          },
        };

        details.copyPasteText = formatLoginAppearanceCopyPasteText(details);
        return details;
      });
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        activeThemeId: "",
        activeThemeName: "",
        themesAvailable: 0,
        themeCatalog: [],
        assetCounts: { logos: 0, backgrounds: 0 },
        assets: {
          logo: { path: "", url: "", exists: null, status: "unknown" },
          closedBackground: { path: "", url: "", exists: null, status: "unknown" },
          openBackground: { path: "", url: "", exists: null, status: "unknown" },
        },
        activeTheme: {
          id: "",
          name: "",
          logoPath: "",
          logoUrl: "",
          closedBackgroundPath: "",
          closedBackgroundUrl: "",
          openBackgroundPath: "",
          openBackgroundUrl: "",
          loginBoxMode: "dark",
          loginBoxWidthPercent: 100,
          loginBoxHeightPercent: 100,
          loginBoxOpacityPercent: 100,
          loginBoxHoverOpacityPercent: 100,
          loginBoxPosXPercent: 50,
          loginBoxPosYPercent: 50,
          logoSizePercent: 30,
          logoOffsetXPercent: 2,
          logoOffsetYPercent: 2,
          backgroundZoomPercent: 100,
        },
        copyPasteText: "",
      };
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

  function purgeExpiredManagerAuthSessions(nowMs = Date.now()) {
    for (const [token, session] of managerAuthSessions.entries()) {
      const expiresAtMs = new Date(session?.expiresAt || "").getTime();
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
        managerAuthSessions.delete(token);
      }
    }
  }

  function getManagerAuthSession(req) {
    const cookies = parseCookies(req.headers?.cookie || "");
    const token = String(cookies[MANAGER_AUTH_COOKIE_NAME] || "");
    if (!token) {
      return null;
    }
    purgeExpiredManagerAuthSessions();
    const session = managerAuthSessions.get(token);
    if (!session) {
      return null;
    }
    return {
      token,
      ...session,
    };
  }

  function createManagerAuthSession({ ttlHours = 12 } = {}) {
    purgeExpiredManagerAuthSessions();
    const token = randomBytes(32).toString("base64url");
    const nowMs = Date.now();
    const expiresAtMs = nowMs + Math.max(1, Number.parseInt(String(ttlHours || "12"), 10)) * 60 * 60 * 1000;
    managerAuthSessions.set(token, {
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    return token;
  }

  function clearManagerAuthSession(req) {
    const existing = getManagerAuthSession(req);
    if (existing?.token) {
      managerAuthSessions.delete(existing.token);
    }
  }

  function isManagerAuthBypassPath(pathname = "") {
    return (
      pathname === "/manager/login" ||
      pathname === "/api/manager-auth/login" ||
      pathname === "/api/manager-auth/login-form" ||
      pathname === "/api/manager-auth/logout" ||
      pathname === "/api/manager-auth/state" ||
      pathname === "/manager/api/manager-auth/login" ||
      pathname === "/manager/api/manager-auth/login-form" ||
      pathname === "/manager/api/manager-auth/logout" ||
      pathname === "/manager/api/manager-auth/state"
    );
  }

  async function enforceManagerAccess(req, res, next) {
    try {
      const settings = await readConsoleSettings();
      if (!settings.access.requirePassword) {
        next();
        return;
      }

      if (isManagerAuthBypassPath(req.path)) {
        next();
        return;
      }

      const session = getManagerAuthSession(req);
      if (session) {
        next();
        return;
      }

      if (req.path.startsWith("/api/") || req.path.startsWith("/manager/api/")) {
        res.status(401).json({
          error: "Manager authentication required.",
          managerAuthRequired: true,
        });
        return;
      }

      if (req.path.startsWith("/manager")) {
        const nextPath = normalizeManagerNextPath(`${req.path}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`);
        res.redirect(`/manager/login?next=${encodeURIComponent(nextPath)}`);
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  }

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

  function getConfigFileSpecs() {
    return managedConfigFiles.map((entry) => {
      const relativePath = normalizeString(entry.relativePath, "").replaceAll("\\", "/");
      if (!relativePath || relativePath.startsWith("..")) {
        throw new Error(`Invalid managed config file path '${entry.relativePath}'.`);
      }
      return {
        ...entry,
        relativePath,
      };
    });
  }

  function resolveBackupPath(backupId) {
    const validatedId = validateConfigBackupId(backupId);
    const resolvedRoot = path.resolve(configBackupDir);
    const resolvedPath = path.resolve(resolvedRoot, validatedId);
    if (!(resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`))) {
      throw new Error("Invalid backup path.");
    }
    return resolvedPath;
  }

  async function readBackupManifest(backupId) {
    const backupPath = resolveBackupPath(backupId);
    const manifestPath = path.join(backupPath, "manifest.json");
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    return {
      backupPath,
      manifest,
    };
  }

  async function listConfigBackups() {
    try {
      const entries = await fs.readdir(configBackupDir, { withFileTypes: true });
      const backups = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (!CONFIG_BACKUP_ID_PATTERN.test(entry.name)) {
          continue;
        }

        const backupPath = path.join(configBackupDir, entry.name);
        const manifestPath = path.join(backupPath, "manifest.json");
        let manifest = null;
        try {
          manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        } catch {
          const stat = await fs.stat(backupPath);
          manifest = {
            backupId: entry.name,
            name: entry.name,
            createdAt: stat.mtime.toISOString(),
            files: [],
          };
        }

        backups.push({
          backupId: String(manifest.backupId || entry.name),
          name: String(manifest.name || entry.name),
          createdAt: String(manifest.createdAt || ""),
          fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
          files: Array.isArray(manifest.files) ? manifest.files : [],
        });
      }

      backups.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return backups;
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async function createConfigBackup(backupName = "") {
    const normalizedName = normalizeConfigBackupName(backupName, "config");
    const backupId = createConfigBackupId(normalizedName);
    const backupPath = resolveBackupPath(backupId);
    const files = [];
    const fileSpecs = getConfigFileSpecs();

    await fs.mkdir(backupPath, { recursive: true });
    for (const spec of fileSpecs) {
      const destination = path.join(backupPath, spec.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      try {
        const stat = await fs.stat(spec.absolutePath);
        await fs.copyFile(spec.absolutePath, destination);
        files.push({
          id: spec.id,
          relativePath: spec.relativePath,
          exists: true,
          sizeBytes: stat.size,
        });
      } catch (error) {
        if (error && error.code === "ENOENT") {
          files.push({
            id: spec.id,
            relativePath: spec.relativePath,
            exists: false,
            sizeBytes: 0,
          });
          continue;
        }
        throw error;
      }
    }

    const manifest = {
      backupId,
      name: normalizedName,
      createdAt: new Date().toISOString(),
      files,
    };
    await fs.writeFile(path.join(backupPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  async function viewConfigBackup(backupId) {
    const { backupPath, manifest } = await readBackupManifest(backupId);
    const files = [];
    const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
    for (const file of manifestFiles) {
      const relativePath = normalizeString(file.relativePath, "").replaceAll("\\", "/");
      if (!relativePath || relativePath.startsWith("..")) {
        continue;
      }
      const source = path.join(backupPath, relativePath);
      try {
        const stat = await fs.stat(source);
        if (stat.size > CONFIG_BACKUP_VIEW_MAX_BYTES) {
          files.push({
            relativePath,
            exists: true,
            sizeBytes: stat.size,
            content: "[file too large to render in browser view]",
          });
          continue;
        }
        files.push({
          relativePath,
          exists: true,
          sizeBytes: stat.size,
          content: await fs.readFile(source, "utf8"),
        });
      } catch (error) {
        if (error && error.code === "ENOENT") {
          files.push({
            relativePath,
            exists: false,
            sizeBytes: 0,
            content: "",
          });
          continue;
        }
        throw error;
      }
    }

    return {
      backup: {
        backupId: String(manifest.backupId || backupId),
        name: String(manifest.name || backupId),
        createdAt: String(manifest.createdAt || ""),
        files: manifestFiles,
      },
      files,
    };
  }

  async function restoreConfigBackup(backupId) {
    const { backupPath, manifest } = await readBackupManifest(backupId);
    const fileSpecs = getConfigFileSpecs();
    const restored = [];
    const skipped = [];
    for (const spec of fileSpecs) {
      const source = path.join(backupPath, spec.relativePath);
      try {
        await fs.access(source);
      } catch (error) {
        if (error && error.code === "ENOENT") {
          skipped.push(spec.relativePath);
          continue;
        }
        throw error;
      }

      await fs.mkdir(path.dirname(spec.absolutePath), { recursive: true });
      await fs.copyFile(source, spec.absolutePath);
      restored.push(spec.relativePath);
    }

    const restoredConfig = await readEnvConfig(envPath);
    const blastDoorsClosed = parseBooleanLike(restoredConfig.BLAST_DOORS_CLOSED, false);
    await writeBlastDoorsState(runtimeStatePath, blastDoorsClosed);

    let serviceRestarted = false;
    if (processState.getStatus().running) {
      await processState.stop();
      await processState.start();
      serviceRestarted = true;
    }

    return {
      backupId: String(manifest.backupId || backupId),
      restored,
      skipped,
      serviceRestarted,
    };
  }

  async function deleteConfigBackup(backupId) {
    const backupPath = resolveBackupPath(backupId);
    await fs.rm(backupPath, { recursive: true, force: true });
    return { backupId };
  }

  async function cleanInstallConfiguration() {
    const baseInstallation = normalizeInstallationConfig(
      defaultInstallationConfig({
        platform: detectPlatformType(),
        installType: "local",
      }),
      null,
    );

    await fs.rm(envPath, { force: true });
    await fs.rm(dockerEnvPath, { force: true });
    await writeInstallationConfig(installationConfigPath, baseInstallation);
    await syncRuntimeEnvFromInstallation({
      installationConfig: baseInstallation,
      envPath,
      dockerEnvPath,
    });

    await writeBlastDoorsState(runtimeStatePath, false);
    let serviceRestarted = false;
    if (processState.getStatus().running) {
      await processState.stop();
      await processState.start();
      serviceRestarted = true;
    }

    return {
      installationConfigPath,
      envPath,
      dockerEnvPath,
      serviceRestarted,
      config: scrubConfigForClient(await readEnvConfig(envPath)),
      installationConfig: baseInstallation,
    };
  }

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

  async function resolveControlPlaneStatus() {
    const [config, installationConfigRaw] = await Promise.all([
      readEnvConfig(envPath),
      readInstallationConfig(installationConfigPath),
    ]);

    const installationConfig = installationConfigRaw || null;
    const installType = normalizeString(installationConfig?.installType, "local").toLowerCase();
    const portal = processState.getStatus();
    const portalHealth = await checkBlastdoorHealth(config);
    const adminUptimeSeconds = Math.max(0, Math.floor((Date.now() - managerStartedAtMs) / 1000));
    const objectStore = await buildObjectStoreStatus(config, installationConfig);
    const [failureStore, enabledPlugins] = await Promise.all([
      readFailureStore(failureStorePath),
      Promise.resolve(pluginManager.getEnabledPlugins()),
    ]);
    const failureSummary = summarizeFailureStore(failureStore);

    const response = {
      ok: true,
      generatedAt: new Date().toISOString(),
      installation: {
        profile: installType === "container" ? "container" : "local",
      },
      admin: {
        running: true,
        pid: process.pid,
        uptimeSeconds: adminUptimeSeconds,
        health: { ok: true, statusCode: 200 },
      },
      portal: {
        running: portal.running,
        pid: portal.pid,
        uptimeSeconds: portal.uptimeSeconds || 0,
        health: portalHealth,
      },
      api: {
        running: false,
        pid: null,
        uptimeSeconds: 0,
        health: { ok: false, statusCode: null, error: "unknown" },
      },
      postgres: {
        running: false,
        pid: null,
        uptimeSeconds: 0,
        health: { ok: false, statusCode: null, error: "not-configured" },
      },
      failures: failureSummary,
      objectStore,
      plugins: [],
    };

    if (installType === "container") {
      const composeState = await loadComposeServiceStates({
        commandRunner,
        workspaceDir,
      });
      const services = composeState.services || {};

      const portalContainer = services.blastdoor || null;
      if (portalContainer) {
        response.portal = {
          running: Boolean(portalContainer.running),
          pid: portalContainer.pid || null,
          uptimeSeconds: portalContainer.uptimeSeconds || 0,
          health: portalContainer.health || portalHealth,
        };
      }

      const apiContainer = services["blastdoor-api"] || null;
      response.api = apiContainer
        ? {
            running: Boolean(apiContainer.running),
            pid: apiContainer.pid || null,
            uptimeSeconds: apiContainer.uptimeSeconds || 0,
            health: apiContainer.health || { ok: false, statusCode: null, error: "unknown" },
          }
        : {
            running: false,
            pid: null,
            uptimeSeconds: 0,
            health: composeState.ok
              ? { ok: false, statusCode: null, error: "not-running" }
              : { ok: false, statusCode: null, error: composeState.error || "compose-unavailable" },
          };

      const postgresContainer = services.postgres || null;
      response.postgres = postgresContainer
        ? {
            running: Boolean(postgresContainer.running),
            pid: postgresContainer.pid || null,
            uptimeSeconds: postgresContainer.uptimeSeconds || 0,
            health: postgresContainer.health || { ok: false, statusCode: null, error: "unknown" },
          }
        : {
            running: false,
            pid: null,
            uptimeSeconds: 0,
            health: composeState.ok
              ? { ok: false, statusCode: null, error: "not-running" }
              : { ok: false, statusCode: null, error: composeState.error || "compose-unavailable" },
          };

      response.plugins = enabledPlugins.map((plugin) => {
        const id = normalizeString(plugin?.id, "");
        const assistantContainer = id === "intelligence" ? services["blastdoor-assistant"] || null : null;
        if (assistantContainer) {
          return {
            id,
            name: formatPluginName(id),
            running: Boolean(assistantContainer.running),
            pid: assistantContainer.pid || null,
            uptimeSeconds: assistantContainer.uptimeSeconds || 0,
            health: assistantContainer.health || { ok: false, statusCode: null, error: "unknown" },
          };
        }
        return {
          id,
          name: formatPluginName(id),
          running: true,
          pid: null,
          uptimeSeconds: adminUptimeSeconds,
          health: { ok: true, statusCode: 200 },
        };
      });

      return response;
    }

    const apiUrl = normalizeString(config.BLASTDOOR_API_URL, "");
    if (apiUrl) {
      const healthUrl = (() => {
        try {
          const parsed = new URL(apiUrl);
          parsed.pathname = "/healthz";
          parsed.search = "";
          parsed.hash = "";
          return parsed.toString();
        } catch {
          return apiUrl;
        }
      })();

      const apiHealth = await probeHttpHealth(healthUrl, 1500);
      const apiProcess = await detectHostProcessState({
        commandRunner,
        workspaceDir,
        matchers: ["blastdoor-api", "src/api-server.js"],
      });
      response.api = {
        running: apiProcess?.running || apiHealth.ok,
        pid: apiProcess?.pid || null,
        uptimeSeconds: apiProcess?.uptimeSeconds || 0,
        health: apiHealth,
      };
    } else {
      const apiProcess = await detectHostProcessState({
        commandRunner,
        workspaceDir,
        matchers: ["blastdoor-api", "src/api-server.js"],
      });
      response.api = apiProcess
        ? {
            running: true,
            pid: apiProcess.pid || null,
            uptimeSeconds: apiProcess.uptimeSeconds || 0,
            health: { ok: true, statusCode: 200 },
          }
        : {
            running: response.portal.running,
            pid: response.portal.pid,
            uptimeSeconds: response.portal.uptimeSeconds,
            health: response.portal.health,
          };
    }

    const postgresMode =
      normalizeString(config.PASSWORD_STORE_MODE, "").toLowerCase() === "postgres" ||
      normalizeString(config.CONFIG_STORE_MODE, "").toLowerCase() === "postgres";
    if (postgresMode) {
      const endpoint = parsePostgresUrlEndpoint(config.POSTGRES_URL);
      if (!endpoint) {
        response.postgres = {
          running: false,
          pid: null,
          uptimeSeconds: 0,
          health: {
            ok: false,
            statusCode: null,
            error: "invalid-postgres-url",
          },
        };
      } else {
        const [tcpHealth, processHealth] = await Promise.all([
          probeTcpPort({
            host: endpoint.host,
            port: endpoint.port,
            timeoutMs: 1500,
          }),
          detectHostProcessState({
            commandRunner,
            workspaceDir,
            matchers: ["postgres"],
          }),
        ]);

        response.postgres = {
          running: processHealth?.running || tcpHealth.ok,
          pid: processHealth?.pid || null,
          uptimeSeconds: processHealth?.uptimeSeconds || 0,
          health: tcpHealth.ok
            ? {
                ok: true,
                statusCode: 200,
                detail: `${endpoint.host}:${endpoint.port}`,
              }
            : {
                ok: false,
                statusCode: null,
                error: tcpHealth.error || "unreachable",
                detail: `${endpoint.host}:${endpoint.port}`,
              },
        };
      }
    }

    response.plugins = await Promise.all(
      enabledPlugins.map(async (plugin) => {
        const id = normalizeString(plugin?.id, "");
        if (id === "intelligence") {
          const enabled = parseBooleanLike(config.ASSISTANT_ENABLED, true);
          if (!enabled) {
            return {
              id,
              name: formatPluginName(id),
              running: false,
              pid: null,
              uptimeSeconds: 0,
              health: { ok: false, statusCode: null, error: "disabled" },
            };
          }

          const assistantUrl = normalizeString(config.ASSISTANT_URL, "");
          if (assistantUrl) {
            const healthUrl = (() => {
              try {
                const parsed = new URL(assistantUrl);
                parsed.pathname = "/healthz";
                parsed.search = "";
                parsed.hash = "";
                return parsed.toString();
              } catch {
                return assistantUrl;
              }
            })();

            const assistantHealth = await probeHttpHealth(healthUrl, 1500);
            return {
              id,
              name: formatPluginName(id),
              running: assistantHealth.ok,
              pid: null,
              uptimeSeconds: 0,
              health: assistantHealth,
            };
          }

          return {
            id,
            name: formatPluginName(id),
            running: true,
            pid: null,
            uptimeSeconds: adminUptimeSeconds,
            health: { ok: true, statusCode: 200 },
          };
        }

        return {
          id,
          name: formatPluginName(id),
          running: true,
          pid: null,
          uptimeSeconds: adminUptimeSeconds,
          health: { ok: true, statusCode: 200 },
        };
      }),
    );

    return response;
  }

  async function getControlPlaneStatusCached() {
    const now = Date.now();
    if (controlPlaneCache.payload && now - controlPlaneCache.updatedAtMs < 2000) {
      return controlPlaneCache.payload;
    }

    if (controlPlaneCache.inflight) {
      return await controlPlaneCache.inflight;
    }

    controlPlaneCache.inflight = resolveControlPlaneStatus()
      .then((payload) => {
        controlPlaneCache.payload = payload;
        controlPlaneCache.updatedAtMs = Date.now();
        return payload;
      })
      .finally(() => {
        controlPlaneCache.inflight = null;
      });

    return await controlPlaneCache.inflight;
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

  app.get("/", (_req, res) => {
    res.redirect("/manager/");
  });

  registerApiGet("/manager-auth/state", async (req, res) => {
    try {
      const settings = await readConsoleSettings();
      const session = settings.access.requirePassword ? getManagerAuthSession(req) : { createdAt: null, expiresAt: null };
      res.json({
        ok: true,
        requirePassword: settings.access.requirePassword,
        authenticated: Boolean(session),
        passwordConfigured: Boolean(settings.access.passwordHash),
        session: session
          ? {
              createdAt: session.createdAt || null,
              expiresAt: session.expiresAt || null,
            }
          : null,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/manager-auth/login", async (req, res) => {
    try {
      const settings = await readConsoleSettings();
      const nextPath = normalizeManagerNextPath(req.body?.next, "/manager/");
      if (!settings.access.requirePassword) {
        res.json({
          ok: true,
          authenticated: true,
          requirePassword: false,
          nextPath,
        });
        return;
      }

      if (!settings.access.passwordHash) {
        throw new Error("Manager password is required but not configured.");
      }

      const password = normalizeString(req.body?.password, "");
      if (!verifyPassword(password, settings.access.passwordHash)) {
        res.status(401).json({
          error: "Invalid manager password.",
          managerAuthRequired: true,
        });
        return;
      }

      const token = createManagerAuthSession({ ttlHours: settings.access.sessionTtlHours });
      const forwardedProto = normalizeString(req.get("x-forwarded-proto"), "").split(",")[0].trim().toLowerCase();
      const secure = req.secure || forwardedProto === "https";
      res.setHeader(
        "Set-Cookie",
        createCookieHeader(MANAGER_AUTH_COOKIE_NAME, token, {
          path: "/",
          maxAge: Math.max(1, settings.access.sessionTtlHours) * 60 * 60,
          sameSite: "Lax",
          secure,
          httpOnly: true,
        }),
      );
      res.json({
        ok: true,
        authenticated: true,
        requirePassword: true,
        nextPath,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/manager-auth/login-form", async (req, res) => {
    try {
      const settings = await readConsoleSettings();
      if (!settings.access.requirePassword) {
        res.redirect("/manager/");
        return;
      }

      if (!settings.access.passwordHash) {
        res
          .status(400)
          .set("cache-control", "no-store")
          .send(renderManagerLoginPage({ error: "Manager password is required but not configured." }));
        return;
      }

      const password = normalizeString(req.body?.password, "");
      const nextPath = normalizeManagerNextPath(req.body?.next, "/manager/");
      if (!verifyPassword(password, settings.access.passwordHash)) {
        res
          .status(401)
          .set("cache-control", "no-store")
          .send(renderManagerLoginPage({ error: "Invalid password.", nextPath }));
        return;
      }

      const token = createManagerAuthSession({ ttlHours: settings.access.sessionTtlHours });
      const forwardedProto = normalizeString(req.get("x-forwarded-proto"), "").split(",")[0].trim().toLowerCase();
      const secure = req.secure || forwardedProto === "https";
      res.setHeader(
        "Set-Cookie",
        createCookieHeader(MANAGER_AUTH_COOKIE_NAME, token, {
          path: "/",
          maxAge: Math.max(1, settings.access.sessionTtlHours) * 60 * 60,
          sameSite: "Lax",
          secure,
          httpOnly: true,
        }),
      );
      res.redirect(nextPath);
    } catch (error) {
      res
        .status(400)
        .set("cache-control", "no-store")
        .send(renderManagerLoginPage({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  registerApiPost("/manager-auth/logout", async (req, res) => {
    try {
      clearManagerAuthSession(req);
      const forwardedProto = normalizeString(req.get("x-forwarded-proto"), "").split(",")[0].trim().toLowerCase();
      const secure = req.secure || forwardedProto === "https";
      res.setHeader(
        "Set-Cookie",
        createCookieHeader(MANAGER_AUTH_COOKIE_NAME, "", {
          path: "/",
          maxAge: 0,
          sameSite: "Lax",
          secure,
          httpOnly: true,
        }),
      );
      res.json({
        ok: true,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/manager-settings", async (_req, res) => {
    try {
      const settings = await readConsoleSettings();
      res.json({
        ok: true,
        settings: sanitizeManagerConsoleSettingsForClient(settings),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/manager-settings/layout", async (req, res) => {
    try {
      const current = await readConsoleSettings();
      const next = normalizeManagerConsoleSettings({
        ...current,
        layout: {
          ...(current.layout || {}),
          darkModePercent: req.body?.darkModePercent,
          lightModePercent: req.body?.lightModePercent,
        },
      });
      const saved = await writeConsoleSettings(next);
      res.json({
        ok: true,
        settings: sanitizeManagerConsoleSettingsForClient(saved),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/manager-settings/access", async (req, res) => {
    try {
      const current = await readConsoleSettings();
      const requirePassword = parseBooleanLikeBody(req.body?.requirePassword);
      const newPassword = normalizeString(req.body?.password, "");
      const clearPassword = parseBooleanLikeBody(req.body?.clearPassword);
      const next = normalizeManagerConsoleSettings({
        ...current,
        access: {
          ...(current.access || {}),
          requirePassword,
          sessionTtlHours: req.body?.sessionTtlHours,
          passwordHash: current.access?.passwordHash || "",
        },
      });

      if (newPassword) {
        next.access.passwordHash = createPasswordHash(newPassword);
      } else if (clearPassword && !requirePassword) {
        next.access.passwordHash = "";
      }

      if (requirePassword && !next.access.passwordHash) {
        throw new Error("Password is required when manager access protection is enabled.");
      }

      const saved = await writeConsoleSettings(next);
      res.json({
        ok: true,
        settings: sanitizeManagerConsoleSettingsForClient(saved),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/config", async (_req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      res.json({
        envPath,
        config: scrubConfigForClient(config),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/config", async (req, res) => {
    try {
      const existing = await readEnvConfig(envPath);
      const incoming = parseBodyConfig(req.body || {}, existing);

      const passwordInput = normalizeString(req.body?.AUTH_PASSWORD || "");
      if (passwordInput.length > 0) {
        incoming.AUTH_PASSWORD_HASH = createPasswordHash(passwordInput);
      } else {
        incoming.AUTH_PASSWORD_HASH = existing.AUTH_PASSWORD_HASH || "";
      }

      for (const key of SENSITIVE_CONFIG_KEYS) {
        if (incoming[key] === "********") {
          incoming[key] = existing[key] || "";
        }
      }

      const wasBlastDoorsClosed = parseBooleanLike(existing.BLAST_DOORS_CLOSED, false);
      const willBlastDoorsClose = parseBooleanLike(incoming.BLAST_DOORS_CLOSED, false);
      let sessionSecretRotated = false;
      if (!wasBlastDoorsClosed && willBlastDoorsClose) {
        incoming.SESSION_SECRET = createSessionSecret();
        sessionSecretRotated = true;
      }

      validateConfig(loadConfigFromEnv({ ...incoming }));
      await writeEnvConfig(envPath, incoming);
      await writeBlastDoorsState(runtimeStatePath, parseBooleanLike(incoming.BLAST_DOORS_CLOSED, false));

      const blastDoorsChanged =
        normalizeString(existing.BLAST_DOORS_CLOSED, CONFIG_DEFAULTS.BLAST_DOORS_CLOSED) !==
        normalizeString(incoming.BLAST_DOORS_CLOSED, CONFIG_DEFAULTS.BLAST_DOORS_CLOSED);

      let serviceRestarted = false;
      if (blastDoorsChanged && processState.getStatus().running) {
        await processState.stop();
        await processState.start();
        serviceRestarted = true;
      }

      res.json({
        ok: true,
        config: scrubConfigForClient({ ...existing, ...incoming }),
        runtime: {
          blastDoorsChanged,
          serviceRestarted,
          sessionSecretRotated,
        },
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/config-backups", async (_req, res) => {
    try {
      const backups = await listConfigBackups();
      res.json({
        ok: true,
        backupDir: configBackupDir,
        backups,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/config-backups/view", async (req, res) => {
    try {
      const backupId = validateConfigBackupId(req.query.backupId);
      const payload = await viewConfigBackup(backupId);
      res.json({
        ok: true,
        ...payload,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/config-backups/create", async (req, res) => {
    try {
      const manifest = await createConfigBackup(req.body?.name || "");
      const backups = await listConfigBackups();
      res.json({
        ok: true,
        backup: manifest,
        backups,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/config-backups/restore", async (req, res) => {
    try {
      const backupId = validateConfigBackupId(req.body?.backupId);
      const result = await restoreConfigBackup(backupId);
      const backups = await listConfigBackups();
      res.json({
        ok: true,
        result,
        backups,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/config-backups/delete", async (req, res) => {
    try {
      const backupId = validateConfigBackupId(req.body?.backupId);
      const result = await deleteConfigBackup(backupId);
      const backups = await listConfigBackups();
      res.json({
        ok: true,
        result,
        backups,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/config-backups/clean-install", async (_req, res) => {
    try {
      const result = await cleanInstallConfiguration();
      res.json({
        ok: true,
        result,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/tls", async (_req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const detection = await detectTlsEnvironment(config);
      const tlsConfig = {
        tlsEnabled: parseBooleanLike(config.TLS_ENABLED, false),
        tlsDomain: normalizeString(config.TLS_DOMAIN, ""),
        tlsEmail: normalizeString(config.TLS_EMAIL, ""),
        tlsChallengeMethod: normalizeTlsChallengeMethod(config.TLS_CHALLENGE_METHOD, "webroot"),
        tlsWebrootPath: normalizeString(config.TLS_WEBROOT_PATH, "/var/www/html"),
        tlsCertFile: normalizeString(config.TLS_CERT_FILE, ""),
        tlsKeyFile: normalizeString(config.TLS_KEY_FILE, ""),
        tlsCaFile: normalizeString(config.TLS_CA_FILE, ""),
        tlsPassphraseSet: Boolean(normalizeString(config.TLS_PASSPHRASE, "")),
      };
      res.json({
        ok: true,
        tls: tlsConfig,
        detection,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/tls/save", async (req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const tlsConfig = normalizeTlsConfigBody(req.body || {}, config);

      if (tlsConfig.TLS_ENABLED === "true") {
        try {
          await fs.access(path.resolve(tlsConfig.TLS_CERT_FILE));
          await fs.access(path.resolve(tlsConfig.TLS_KEY_FILE));
        } catch (error) {
          throw new Error(
            `TLS is enabled but certificate/key files are not accessible: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }

      const merged = {
        ...config,
        ...tlsConfig,
      };
      validateConfig(loadConfigFromEnv(merged));
      await writeEnvConfig(envPath, merged);

      res.json({
        ok: true,
        tls: {
          tlsEnabled: parseBooleanLike(merged.TLS_ENABLED, false),
          tlsDomain: merged.TLS_DOMAIN || "",
          tlsEmail: merged.TLS_EMAIL || "",
          tlsChallengeMethod: normalizeTlsChallengeMethod(merged.TLS_CHALLENGE_METHOD, "webroot"),
          tlsWebrootPath: merged.TLS_WEBROOT_PATH || "",
          tlsCertFile: merged.TLS_CERT_FILE || "",
          tlsKeyFile: merged.TLS_KEY_FILE || "",
          tlsCaFile: merged.TLS_CA_FILE || "",
          tlsPassphraseSet: Boolean(merged.TLS_PASSPHRASE),
        },
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/tls/letsencrypt-plan", async (req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const tlsInput = normalizeTlsConfigBody(
        {
          ...config,
          ...(req.body || {}),
          tlsEnabled: false,
        },
        config,
      );
      const detection = await detectTlsEnvironment({
        ...config,
        ...tlsInput,
      });
      const plan = buildLetsEncryptPlan({
        domain: tlsInput.TLS_DOMAIN,
        email: tlsInput.TLS_EMAIL,
        challengeMethod: tlsInput.TLS_CHALLENGE_METHOD,
        webrootPath: tlsInput.TLS_WEBROOT_PATH || "/var/www/html",
        certFile: tlsInput.TLS_CERT_FILE,
        keyFile: tlsInput.TLS_KEY_FILE,
        certbotAvailable: detection.certbotAvailable,
        dockerAvailable: detection.dockerAvailable,
      });
      res.json({
        ok: true,
        plan,
        detection,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/start", async (_req, res) => {
    try {
      await validateGatewayStartConfiguration();
      const status = await processState.start();
      res.json({ ok: true, status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordFailureEntry({
        action: "gateway-start",
        message,
        details: "Manager failed to start Blastdoor service.",
      });
      res.status(400).json({
        error: message,
      });
    }
  });

  registerApiPost("/stop", async (_req, res) => {
    try {
      const status = await processState.stop();
      res.json({ ok: true, status });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/restart", async (_req, res) => {
    try {
      await validateGatewayStartConfiguration();
      await processState.stop();
      const status = await processState.start();
      res.json({ ok: true, status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordFailureEntry({
        action: "gateway-restart",
        message,
        details: "Manager failed to restart Blastdoor service.",
      });
      res.status(400).json({
        error: message,
      });
    }
  });

  registerApiPost("/sessions/revoke-all", async (_req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const nextSecret = createSessionSecret();
      const nextConfig = {
        ...config,
        SESSION_SECRET: nextSecret,
      };

      await writeEnvConfig(envPath, nextConfig);

      let serviceRestarted = false;
      if (processState.getStatus().running) {
        await processState.stop();
        await processState.start();
        serviceRestarted = true;
      }

      res.json({
        ok: true,
        serviceRestarted,
        rotatedAt: new Date().toISOString(),
        forceReauthUrl: "/login?reauth=1",
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/sessions", async (_req, res) => {
    try {
      const payload = await withBlastdoorApi(async ({ configFromEnv, blastdoorApi }) => {
        const sessionMaxAgeHours = Number.parseInt(configFromEnv.SESSION_MAX_AGE_HOURS || "12", 10);
        const profiles = await blastdoorApi.listUserProfiles({
          sessionMaxAgeHours,
        });
        const activeSessions = (profiles || [])
          .filter((entry) => entry.authenticatedNow)
          .map((entry) => ({
            sessionKey: createSessionKey({
              username: entry.username,
              lastLoginAt: entry.lastLoginAt,
              sessionVersion: entry.sessionVersion || 1,
            }),
            username: entry.username,
            friendlyName: entry.friendlyName || "",
            status: entry.status || "active",
            lastLoginAt: entry.lastLoginAt || "",
            lastKnownIp: entry.lastKnownIp || "",
            sessionVersion: entry.sessionVersion || 1,
          }))
          .sort((a, b) => String(a.username || "").localeCompare(String(b.username || "")));

        return {
          activeSessions,
          sessionMaxAgeHours,
        };
      });

      res.json({
        ok: true,
        generatedAt: new Date().toISOString(),
        summary: {
          activeCount: payload.activeSessions.length,
          sessionMaxAgeHours: payload.sessionMaxAgeHours,
        },
        sessions: payload.activeSessions,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/sessions/revoke", async (req, res) => {
    try {
      const username = validateManagedUsernameForActions(req.body?.username);
      const expectedSessionKey = normalizeString(req.body?.sessionKey, "");

      const result = await withBlastdoorApi(async ({ configFromEnv, blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        const existingUser = users.find((entry) => entry.username === username);
        if (!existingUser) {
          throw new Error("User not found.");
        }

        const sessionMaxAgeHours = Number.parseInt(configFromEnv.SESSION_MAX_AGE_HOURS || "12", 10);
        const profiles = await blastdoorApi.listUserProfiles({
          sessionMaxAgeHours,
        });
        const target = (profiles || []).find((entry) => entry.authenticatedNow && entry.username === username);
        if (!target) {
          throw new Error("Requested session is no longer active.");
        }

        const sessionKey = createSessionKey({
          username: target.username,
          lastLoginAt: target.lastLoginAt,
          sessionVersion: target.sessionVersion || 1,
        });
        if (expectedSessionKey && !safeEqual(sessionKey, expectedSessionKey)) {
          throw new Error("Requested session no longer matches current active session.");
        }

        const profile = await blastdoorApi.invalidateUserSessions(username);
        return {
          username,
          revokedSessionKey: sessionKey,
          sessionVersion: profile?.sessionVersion || 1,
        };
      });

      res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/sessions/invalidate-user", async (req, res) => {
    try {
      const username = validateManagedUsernameForActions(req.body?.username);
      const profile = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        const existingUser = users.find((entry) => entry.username === username);
        if (!existingUser) {
          throw new Error("User not found.");
        }
        return await blastdoorApi.invalidateUserSessions(username);
      });

      res.json({
        ok: true,
        username,
        sessionVersion: profile?.sessionVersion || 1,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/users", async (req, res) => {
    try {
      const view = normalizeUserFilter(req.query?.view, "active");
      const payload = await buildManagedUserList({ filter: view });
      res.json({
        ok: true,
        ...payload,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/users/create", async (req, res) => {
    try {
      const username = validateManagedUsername(req.body?.username);
      const password = normalizeString(req.body?.password, "");
      if (password.length < 12) {
        throw new Error("Password must be at least 12 characters.");
      }
      const status = normalizeUserStatus(req.body?.status, "active");
      const friendlyName = sanitizeLongText(req.body?.friendlyName, 160);
      const email = sanitizeEmail(req.body?.email);
      const displayInfo = sanitizeLongText(req.body?.displayInfo, 2048);
      const notes = sanitizeLongText(req.body?.notes, 4096);

      await withBlastdoorApi(async ({ blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        if (users.some((entry) => entry.username === username)) {
          throw new Error("User already exists.");
        }

        await blastdoorApi.upsertCredentialUser({
          username,
          passwordHash: createPasswordHash(password),
          totpSecret: null,
          disabled: status !== "active",
        });
        await blastdoorApi.upsertUserProfile({
          username,
          friendlyName,
          email,
          status,
          displayInfo,
          notes,
        });
      });

      const listPayload = await buildManagedUserList({ filter: "all" });
      const createdUser = listPayload.users.find((entry) => entry.username === username) || null;
      res.json({
        ok: true,
        user: createdUser,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/users/update", async (req, res) => {
    try {
      const username = validateManagedUsernameForActions(req.body?.username);
      const password = normalizeString(req.body?.password, "");
      const status = normalizeUserStatus(req.body?.status, "active");
      const friendlyName = sanitizeLongText(req.body?.friendlyName, 160);
      const email = sanitizeEmail(req.body?.email);
      const displayInfo = sanitizeLongText(req.body?.displayInfo, 2048);
      const notes = sanitizeLongText(req.body?.notes, 4096);

      await withBlastdoorApi(async ({ blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        const existingUser = users.find((entry) => entry.username === username);
        if (!existingUser) {
          throw new Error("User not found.");
        }

        await blastdoorApi.upsertCredentialUser({
          username,
          passwordHash: password ? createPasswordHash(password) : existingUser.passwordHash,
          totpSecret: existingUser.totpSecret || null,
          disabled: status !== "active",
        });
        await blastdoorApi.upsertUserProfile({
          username,
          friendlyName,
          email,
          status,
          displayInfo,
          notes,
        });
      });

      const listPayload = await buildManagedUserList({ filter: "all" });
      const updatedUser = listPayload.users.find((entry) => entry.username === username) || null;
      res.json({
        ok: true,
        user: updatedUser,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/users/set-status", async (req, res) => {
    try {
      const username = validateManagedUsernameForActions(req.body?.username);
      const status = normalizeUserStatus(req.body?.status, "active");

      await withBlastdoorApi(async ({ blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        const existingUser = users.find((entry) => entry.username === username);
        if (!existingUser) {
          throw new Error("User not found.");
        }

        await blastdoorApi.upsertCredentialUser({
          username,
          passwordHash: existingUser.passwordHash,
          totpSecret: existingUser.totpSecret || null,
          disabled: status !== "active",
        });
        await blastdoorApi.upsertUserProfile({
          username,
          status,
        });
      });

      const listPayload = await buildManagedUserList({ filter: "all" });
      const updatedUser = listPayload.users.find((entry) => entry.username === username) || null;
      res.json({
        ok: true,
        user: updatedUser,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/users/reset-login-code", async (req, res) => {
    try {
      const username = validateManagedUsernameForActions(req.body?.username);
      const delivery = normalizeString(req.body?.delivery, "manual") || "manual";
      const ttlMinutes = Number.parseInt(normalizeString(req.body?.ttlMinutes, "30"), 10);

      let issuedCode = null;
      let profileEmail = "";
      let emailSent = false;
      let emailWarning = "";

      await withBlastdoorApi(async ({ configFromEnv, blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        const existingUser = users.find((entry) => entry.username === username);
        if (!existingUser) {
          throw new Error("User not found.");
        }

        issuedCode = await blastdoorApi.issueTemporaryLoginCode(username, { ttlMinutes, delivery });
        const profile = await blastdoorApi.getUserProfile(username);
        profileEmail = normalizeString(profile?.email, "");

        if (delivery !== "email") {
          return;
        }

        if (!profileEmail) {
          emailWarning = "User has no email set in profile. Copy this temporary code and deliver it securely.";
          return;
        }

        const emailService = createEmailService(loadEmailConfigFromEnv(configFromEnv));
        try {
          const baseUrl = resolveGatewayBaseUrl(configFromEnv);
          const result = await emailService.sendTemporaryLoginCode({
            to: profileEmail,
            username,
            code: issuedCode?.code || "",
            expiresAt: issuedCode?.expiresAt || "",
            loginUrlPath: `${baseUrl}/login?next=%2F`,
          });
          emailSent = Boolean(result?.ok);
          if (!result?.ok) {
            emailWarning = `Email dispatch unavailable: ${result?.reason || "provider not configured"}.`;
          }
        } finally {
          await emailService.close();
        }
      });

      res.json({
        ok: true,
        username,
        delivery,
        code: issuedCode?.code || "",
        expiresAt: issuedCode?.expiresAt || "",
        emailSent,
        emailTo: profileEmail,
        warning: delivery === "email" ? emailWarning : "",
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/users/invalidate-token", async (req, res) => {
    try {
      const username = validateManagedUsernameForActions(req.body?.username);
      let profile = null;
      await withBlastdoorApi(async ({ blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        const existingUser = users.find((entry) => entry.username === username);
        if (!existingUser) {
          throw new Error("User not found.");
        }

        profile = await blastdoorApi.invalidateUserSessions(username);
      });

      res.json({
        ok: true,
        username,
        sessionVersion: profile?.sessionVersion || 1,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/control-plane-status", async (_req, res) => {
    try {
      const status = await getControlPlaneStatusCached();
      res.json(status);
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/failures", async (_req, res) => {
    try {
      const store = await readFailureStore(failureStorePath);
      const entries = [...(store.entries || [])].sort((a, b) =>
        String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
      );
      res.json({
        ok: true,
        summary: summarizeFailureStore({ entries }),
        entries,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/failures/clear", async (_req, res) => {
    try {
      await clearFailureStore(failureStorePath);
      res.json({
        ok: true,
        summary: summarizeFailureStore({ entries: [] }),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/monitor", async (_req, res) => {
    try {
      const status = processState.getStatus();
      const config = await readEnvConfig(envPath);
      const health = await checkBlastdoorHealth(config);
      const logPath = path.resolve(workspaceDir, config.DEBUG_LOG_FILE || CONFIG_DEFAULTS.DEBUG_LOG_FILE);
      const debugLogLines = await tailFile(logPath, 200);
      const runtimeLogLines = processState.recentRuntimeLogs(200);

      res.json({
        ok: true,
        status,
        health,
        debugLogLines,
        runtimeLogLines,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/themes", async (_req, res) => {
    try {
      const payload = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const [store, assets] = await Promise.all([blastdoorApi.readThemeStore(), blastdoorApi.listThemeAssets()]);
        return { store, assets };
      });
      res.json({
        ok: true,
        activeThemeId: payload.store.activeThemeId || "",
        themes: (payload.store.themes || []).map(mapThemeForClient),
        assets: payload.assets,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/themes/create", async (req, res) => {
    try {
      const payload = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const assets = await blastdoorApi.listThemeAssets();
        const validated = validateThemeAssetSelection(
          {
            themeName: req.body?.name,
            logoPath: req.body?.logoPath,
            closedBackgroundPath: req.body?.closedBackgroundPath,
            openBackgroundPath: req.body?.openBackgroundPath,
            loginBoxWidthPercent: req.body?.loginBoxWidthPercent,
            loginBoxHeightPercent: req.body?.loginBoxHeightPercent,
            loginBoxPosXPercent: req.body?.loginBoxPosXPercent,
            loginBoxPosYPercent: req.body?.loginBoxPosYPercent,
            loginBoxOpacityPercent: req.body?.loginBoxOpacityPercent,
            loginBoxHoverOpacityPercent: req.body?.loginBoxHoverOpacityPercent,
            logoSizePercent: req.body?.logoSizePercent,
            logoOffsetXPercent: req.body?.logoOffsetXPercent,
            logoOffsetYPercent: req.body?.logoOffsetYPercent,
            backgroundZoomPercent: req.body?.backgroundZoomPercent,
            loginBoxMode: req.body?.loginBoxMode,
          },
          assets,
        );
        const makeActive = parseBooleanLikeBody(req.body?.makeActive);

        const store = await blastdoorApi.readThemeStore();
        const existingIds = new Set((store.themes || []).map((theme) => theme.id));
        const id = createThemeId(validated.name, existingIds);
        const now = new Date().toISOString();
        const createdTheme = {
          id,
          name: validated.name,
          logoPath: validated.logoPath,
          closedBackgroundPath: validated.closedBackgroundPath,
          openBackgroundPath: validated.openBackgroundPath,
          loginBoxWidthPercent: validated.loginBoxWidthPercent,
          loginBoxHeightPercent: validated.loginBoxHeightPercent,
          loginBoxPosXPercent: validated.loginBoxPosXPercent,
          loginBoxPosYPercent: validated.loginBoxPosYPercent,
          loginBoxOpacityPercent: validated.loginBoxOpacityPercent,
          loginBoxHoverOpacityPercent: validated.loginBoxHoverOpacityPercent,
          logoSizePercent: validated.logoSizePercent,
          logoOffsetXPercent: validated.logoOffsetXPercent,
          logoOffsetYPercent: validated.logoOffsetYPercent,
          backgroundZoomPercent: validated.backgroundZoomPercent,
          loginBoxMode: validated.loginBoxMode,
          createdAt: now,
          updatedAt: now,
        };

        const nextThemes = [...(store.themes || []), createdTheme];
        const nextActiveThemeId = makeActive || !store.activeThemeId ? createdTheme.id : store.activeThemeId;
        const updatedStore = await blastdoorApi.writeThemeStore({
          activeThemeId: nextActiveThemeId,
          themes: nextThemes,
        });
        return { assets, createdTheme, updatedStore };
      });

      res.json({
        ok: true,
        activeThemeId: payload.updatedStore.activeThemeId || "",
        createdTheme: mapThemeForClient(payload.createdTheme),
        themes: (payload.updatedStore.themes || []).map(mapThemeForClient),
        assets: payload.assets,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/themes/update", async (req, res) => {
    try {
      const themeId = normalizeString(req.body?.themeId, "");
      if (!themeId) {
        throw new Error("themeId is required.");
      }

      const payload = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const assets = await blastdoorApi.listThemeAssets();
        const validated = validateThemeAssetSelection(
          {
            themeName: req.body?.name,
            logoPath: req.body?.logoPath,
            closedBackgroundPath: req.body?.closedBackgroundPath,
            openBackgroundPath: req.body?.openBackgroundPath,
            loginBoxWidthPercent: req.body?.loginBoxWidthPercent,
            loginBoxHeightPercent: req.body?.loginBoxHeightPercent,
            loginBoxPosXPercent: req.body?.loginBoxPosXPercent,
            loginBoxPosYPercent: req.body?.loginBoxPosYPercent,
            loginBoxOpacityPercent: req.body?.loginBoxOpacityPercent,
            loginBoxHoverOpacityPercent: req.body?.loginBoxHoverOpacityPercent,
            logoSizePercent: req.body?.logoSizePercent,
            logoOffsetXPercent: req.body?.logoOffsetXPercent,
            logoOffsetYPercent: req.body?.logoOffsetYPercent,
            backgroundZoomPercent: req.body?.backgroundZoomPercent,
            loginBoxMode: req.body?.loginBoxMode,
          },
          assets,
          { requireClosedBackground: false },
        );
        const makeActive = parseBooleanLikeBody(req.body?.makeActive);

        const store = await blastdoorApi.readThemeStore();
        const themeIndex = (store.themes || []).findIndex((theme) => theme.id === themeId);
        if (themeIndex < 0) {
          throw new Error("Requested theme was not found.");
        }

        const existingTheme = store.themes[themeIndex];
        const now = new Date().toISOString();
        const updatedTheme = {
          ...existingTheme,
          name: validated.name,
          logoPath: validated.logoPath,
          closedBackgroundPath: validated.closedBackgroundPath,
          openBackgroundPath: validated.openBackgroundPath,
          loginBoxWidthPercent: validated.loginBoxWidthPercent,
          loginBoxHeightPercent: validated.loginBoxHeightPercent,
          loginBoxPosXPercent: validated.loginBoxPosXPercent,
          loginBoxPosYPercent: validated.loginBoxPosYPercent,
          loginBoxOpacityPercent: validated.loginBoxOpacityPercent,
          loginBoxHoverOpacityPercent: validated.loginBoxHoverOpacityPercent,
          logoSizePercent: validated.logoSizePercent,
          logoOffsetXPercent: validated.logoOffsetXPercent,
          logoOffsetYPercent: validated.logoOffsetYPercent,
          backgroundZoomPercent: validated.backgroundZoomPercent,
          loginBoxMode: validated.loginBoxMode,
          updatedAt: now,
        };

        const nextThemes = [...(store.themes || [])];
        nextThemes[themeIndex] = updatedTheme;
        const nextActiveThemeId = makeActive ? themeId : store.activeThemeId;
        const updatedStore = await blastdoorApi.writeThemeStore({
          activeThemeId: nextActiveThemeId,
          themes: nextThemes,
        });
        return { assets, updatedTheme, updatedStore };
      });

      res.json({
        ok: true,
        activeThemeId: payload.updatedStore.activeThemeId || "",
        updatedTheme: mapThemeForClient(payload.updatedTheme),
        themes: (payload.updatedStore.themes || []).map(mapThemeForClient),
        assets: payload.assets,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/themes/rename", async (req, res) => {
    try {
      const themeId = normalizeString(req.body?.themeId, "");
      if (!themeId) {
        throw new Error("themeId is required.");
      }

      const name = normalizeThemeName(req.body?.name);
      if (!name) {
        throw new Error("Theme name is required.");
      }

      const payload = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const [store, assets] = await Promise.all([blastdoorApi.readThemeStore(), blastdoorApi.listThemeAssets()]);
        const themeIndex = (store.themes || []).findIndex((theme) => theme.id === themeId);
        if (themeIndex < 0) {
          throw new Error("Requested theme was not found.");
        }

        const existingTheme = store.themes[themeIndex];
        const updatedTheme = {
          ...existingTheme,
          name,
          updatedAt: new Date().toISOString(),
        };

        const nextThemes = [...(store.themes || [])];
        nextThemes[themeIndex] = updatedTheme;
        const updatedStore = await blastdoorApi.writeThemeStore({
          activeThemeId: store.activeThemeId,
          themes: nextThemes,
        });
        return { assets, updatedTheme, updatedStore };
      });

      res.json({
        ok: true,
        activeThemeId: payload.updatedStore.activeThemeId || "",
        updatedTheme: mapThemeForClient(payload.updatedTheme),
        themes: (payload.updatedStore.themes || []).map(mapThemeForClient),
        assets: payload.assets,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/themes/delete", async (req, res) => {
    try {
      const themeId = normalizeString(req.body?.themeId, "");
      if (!themeId) {
        throw new Error("themeId is required.");
      }
      if (themeId === DEFAULT_THEME_ID) {
        throw new Error("Default theme cannot be deleted.");
      }

      const payload = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const [store, assets] = await Promise.all([blastdoorApi.readThemeStore(), blastdoorApi.listThemeAssets()]);
        const existingTheme = (store.themes || []).find((theme) => theme.id === themeId);
        if (!existingTheme) {
          throw new Error("Requested theme was not found.");
        }

        const nextThemes = (store.themes || []).filter((theme) => theme.id !== themeId);
        const nextActiveThemeId =
          store.activeThemeId === themeId
            ? nextThemes[0]?.id || DEFAULT_THEME_ID
            : store.activeThemeId;

        const updatedStore = await blastdoorApi.writeThemeStore({
          activeThemeId: nextActiveThemeId,
          themes: nextThemes,
        });
        return { assets, updatedStore };
      });

      res.json({
        ok: true,
        deletedThemeId: themeId,
        activeThemeId: payload.updatedStore.activeThemeId || "",
        themes: (payload.updatedStore.themes || []).map(mapThemeForClient),
        assets: payload.assets,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/themes/apply", async (req, res) => {
    try {
      const themeId = normalizeString(req.body?.themeId, "");
      if (!themeId) {
        throw new Error("themeId is required.");
      }

      const payload = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const [store, assets] = await Promise.all([blastdoorApi.readThemeStore(), blastdoorApi.listThemeAssets()]);
        const selectedTheme = (store.themes || []).find((theme) => theme.id === themeId);
        if (!selectedTheme) {
          throw new Error("Requested theme was not found.");
        }

        const updatedStore = await blastdoorApi.writeThemeStore({
          activeThemeId: themeId,
          themes: store.themes || [],
        });
        return { assets, selectedTheme, updatedStore };
      });

      res.json({
        ok: true,
        activeThemeId: payload.updatedStore.activeThemeId || "",
        activeTheme: mapThemeForClient(payload.selectedTheme),
        themes: (payload.updatedStore.themes || []).map(mapThemeForClient),
        assets: payload.assets,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/diagnostics", async (_req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const serviceStatus = processState.getStatus();
      const health = await checkBlastdoorHealth(config);
      const environment = detectEnvironmentInfo({ workspaceDir, envPath });
      const diagnosticsConfig = sanitizeConfigForDiagnostics(config);
      const loginAppearance = await resolveLoginAppearanceDetails();

      const report = {
        generatedAt: new Date().toISOString(),
        serviceStatus,
        health,
        environment,
        config: diagnosticsConfig,
        loginAppearance,
      };

      res.json({
        ok: true,
        report,
        summary: createDiagnosticsSummary(report),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/troubleshoot", async (_req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const serviceStatus = processState.getStatus();
      const [health, foundryHealth] = await Promise.all([checkBlastdoorHealth(config), checkFoundryTargetHealth(config)]);
      const environment = detectEnvironmentInfo({ workspaceDir, envPath });
      const loginAppearance = await resolveLoginAppearanceDetails();
      const report = createTroubleshootReport({ config, health, foundryHealth, environment, serviceStatus, loginAppearance });

      res.json({
        ok: true,
        report,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/troubleshoot/run", async (req, res) => {
    try {
      const actionId = normalizeString(req.body?.actionId, "");
      if (!actionId) {
        throw new Error("actionId is required.");
      }

      if (actionId.startsWith("guide.")) {
        throw new Error(
          "Requested action is potentially destructive and must be reviewed manually. Use diagnostics guidance instead.",
        );
      }

      const config = await readEnvConfig(envPath);
      const environment = detectEnvironmentInfo({ workspaceDir, envPath });
      const result = await runTroubleshootAction({
        actionId,
        config,
        environment,
        workspaceDir,
        commandRunner,
      });

      res.json({
        ok: true,
        result,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
