import "dotenv/config";
import express from "express";
import helmet from "helmet";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { createProxyMiddleware } from "http-proxy-middleware";
import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPasswordHash,
  createCsrfToken,
  evaluateSameOrigin,
  escapeHtml,
  safeEqual,
  safeNextPath,
  verifyPassword,
} from "./security.js";
import { createLogger } from "./logger.js";
import { authenticator } from "./otp.js";
import { createConfigStore } from "./config-store.js";
import { createBlastdoorApi } from "./blastdoor-api.js";
import { createBlastDoorsStateController } from "./blastdoors-state.js";
import { createEmailService, loadEmailConfigFromEnv } from "./email-service.js";
import { buildThemeAssetUrl, normalizeThemeAssetPath as normalizeThemeAssetPathByType } from "./login-theme.js";
import { createPluginManager } from "./plugins/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function parseBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function parseTrustProxy(value) {
  if (value === undefined) {
    return 1;
  }

  const raw = String(value).trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(raw)) {
    return false;
  }

  if (/^\d+$/.test(raw)) {
    return Number.parseInt(raw, 10);
  }

  return raw;
}

function requiredEnv(env, name, validator) {
  const value = env[name];
  if (!value || (validator && !validator(value))) {
    throw new Error(`Missing or invalid ${name}.`);
  }

  return value;
}

function normalizeHostname(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw.slice(1, -1);
  }
  return raw;
}

function isWildcardHost(hostname) {
  return hostname === "0.0.0.0" || hostname === "::";
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
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

function resolveUrlPort(url) {
  if (url.port) {
    const parsed = Number.parseInt(url.port, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return defaultPortForProtocol(url.protocol);
}

function collectLocalHostnames() {
  const local = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"]);
  const machineHostname = normalizeHostname(os.hostname());
  if (machineHostname) {
    local.add(machineHostname);
  }

  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      const normalized = normalizeHostname(entry.address);
      if (normalized) {
        local.add(normalized);
      }
    }
  }

  return local;
}

export function detectSelfProxyTarget(config) {
  const gatewayPort = Number.parseInt(String(config?.port ?? ""), 10);
  if (!Number.isInteger(gatewayPort)) {
    return {
      isSelfTarget: false,
      reason: null,
    };
  }

  let targetUrl;
  try {
    targetUrl = new URL(String(config?.foundryTarget || ""));
  } catch {
    return {
      isSelfTarget: false,
      reason: null,
    };
  }

  const targetPort = resolveUrlPort(targetUrl);
  if (!Number.isInteger(targetPort) || targetPort !== gatewayPort) {
    return {
      isSelfTarget: false,
      reason: null,
      targetHost: normalizeHostname(targetUrl.hostname),
      targetPort,
      gatewayHost: normalizeHostname(config?.host || ""),
      gatewayPort,
    };
  }

  const gatewayHost = normalizeHostname(config?.host || "");
  const targetHost = normalizeHostname(targetUrl.hostname);
  const localHosts = collectLocalHostnames();
  const targetLooksLocal = localHosts.has(targetHost) || isLoopbackHost(targetHost) || isWildcardHost(targetHost);
  const gatewayLooksLocal = localHosts.has(gatewayHost) || isLoopbackHost(gatewayHost) || isWildcardHost(gatewayHost);
  const exactHostMatch = gatewayHost.length > 0 && gatewayHost === targetHost;
  const wildcardGatewayToLocalTarget = isWildcardHost(gatewayHost) && targetLooksLocal;
  const localAliasMatch = gatewayLooksLocal && targetLooksLocal;

  if (!exactHostMatch && !wildcardGatewayToLocalTarget && !localAliasMatch) {
    return {
      isSelfTarget: false,
      reason: null,
      targetHost,
      targetPort,
      gatewayHost,
      gatewayPort,
    };
  }

  let reason = "target-resolves-to-gateway";
  if (exactHostMatch) {
    reason = "exact-host-and-port-match";
  } else if (wildcardGatewayToLocalTarget) {
    reason = "wildcard-bind-with-local-target";
  } else if (localAliasMatch) {
    reason = "local-alias-host-and-port-match";
  }

  return {
    isSelfTarget: true,
    reason,
    targetHost,
    targetPort,
    gatewayHost,
    gatewayPort,
  };
}

export function loadConfigFromEnv(env = process.env) {
  const passwordStoreMode = String(env.PASSWORD_STORE_MODE || "env").toLowerCase();
  const pluginManager = createPluginManager({ env });

  const baseConfig = {
    host: env.HOST || "0.0.0.0",
    port: Number.parseInt(env.PORT || "8080", 10),
    foundryTarget: requiredEnv(env, "FOUNDRY_TARGET"),
    authUsername: passwordStoreMode === "env" ? requiredEnv(env, "AUTH_USERNAME") : env.AUTH_USERNAME || "",
    authPasswordHash:
      passwordStoreMode === "env" ? requiredEnv(env, "AUTH_PASSWORD_HASH") : env.AUTH_PASSWORD_HASH || "",
    requireTotp: parseBoolean(env.REQUIRE_TOTP, true),
    totpSecret: env.TOTP_SECRET || "",
    sessionSecret: requiredEnv(env, "SESSION_SECRET", (v) => v.length >= 32),
    sessionMaxAgeHours: Number.parseInt(env.SESSION_MAX_AGE_HOURS || "12", 10),
    cookieSecure: parseBoolean(env.COOKIE_SECURE, true),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    proxyTlsVerify: parseBoolean(env.PROXY_TLS_VERIFY, true),
    loginRateLimitWindowMs: Number.parseInt(env.LOGIN_RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10),
    loginRateLimitMax: Number.parseInt(env.LOGIN_RATE_LIMIT_MAX || "8", 10),
    debugMode: parseBoolean(env.DEBUG_MODE, false),
    debugLogFile: env.DEBUG_LOG_FILE || "logs/blastdoor-debug.log",
    allowedOrigins: env.ALLOWED_ORIGINS || "",
    allowNullOrigin: parseBoolean(env.ALLOW_NULL_ORIGIN, false),
    graphicsCacheEnabled: parseBoolean(env.GRAPHICS_CACHE_ENABLED, true),
    blastdoorApiUrl: env.BLASTDOOR_API_URL || "",
    blastdoorApiToken: env.BLASTDOOR_API_TOKEN || "",
    blastdoorApiTimeoutMs: Number.parseInt(env.BLASTDOOR_API_TIMEOUT_MS || "2500", 10),
    blastdoorApiRetryMaxAttempts: Number.parseInt(env.BLASTDOOR_API_RETRY_MAX_ATTEMPTS || "3", 10),
    blastdoorApiRetryBaseDelayMs: Number.parseInt(env.BLASTDOOR_API_RETRY_BASE_DELAY_MS || "120", 10),
    blastdoorApiRetryMaxDelayMs: Number.parseInt(env.BLASTDOOR_API_RETRY_MAX_DELAY_MS || "1200", 10),
    blastdoorApiCircuitFailureThreshold: Number.parseInt(env.BLASTDOOR_API_CIRCUIT_FAILURE_THRESHOLD || "5", 10),
    blastdoorApiCircuitResetMs: Number.parseInt(env.BLASTDOOR_API_CIRCUIT_RESET_MS || "10000", 10),
    configStoreMode: String(env.CONFIG_STORE_MODE || "env").toLowerCase(),
    databaseFile: env.DATABASE_FILE || "data/blastdoor.sqlite",
    postgresUrl: env.POSTGRES_URL || "",
    postgresSsl: parseBoolean(env.POSTGRES_SSL, false),
    tlsEnabled: parseBoolean(env.TLS_ENABLED, false),
    tlsDomain: env.TLS_DOMAIN || "",
    tlsEmail: env.TLS_EMAIL || "",
    tlsChallengeMethod: env.TLS_CHALLENGE_METHOD || "webroot",
    tlsWebrootPath: env.TLS_WEBROOT_PATH || "",
    tlsCertFile: env.TLS_CERT_FILE || "",
    tlsKeyFile: env.TLS_KEY_FILE || "",
    tlsCaFile: env.TLS_CA_FILE || "",
    tlsPassphrase: env.TLS_PASSPHRASE || "",
    emailProvider: env.EMAIL_PROVIDER || "disabled",
    emailFrom: env.EMAIL_FROM || "",
    emailAdminTo: env.EMAIL_ADMIN_TO || "",
    smtpHost: env.SMTP_HOST || "",
    smtpPort: Number.parseInt(env.SMTP_PORT || "587", 10),
    smtpSecure: parseBoolean(env.SMTP_SECURE, false),
    smtpUser: env.SMTP_USER || "",
    smtpPass: env.SMTP_PASS || "",
    smtpIgnoreTls: parseBoolean(env.SMTP_IGNORE_TLS, false),
    publicBaseUrl: env.PUBLIC_BASE_URL || "",
    passwordStoreMode,
    passwordStoreFile: env.PASSWORD_STORE_FILE || "mock/password-store.json",
    blastDoorsClosed: parseBoolean(env.BLAST_DOORS_CLOSED, false),
  };

  return {
    ...baseConfig,
    ...pluginManager.loadServerConfigFromEnv(env),
  };
}

export function validateConfig(config) {
  const passwordStoreMode = String(config.passwordStoreMode || "env").toLowerCase();
  if (!["env", "file", "sqlite", "postgres"].includes(passwordStoreMode)) {
    throw new Error("PASSWORD_STORE_MODE must be one of: env, file, sqlite, postgres.");
  }

  const configStoreMode = String(config.configStoreMode || "env").toLowerCase();
  if (!["env", "sqlite", "postgres"].includes(configStoreMode)) {
    throw new Error("CONFIG_STORE_MODE must be one of: env, sqlite, postgres.");
  }

  if (passwordStoreMode === "env") {
    if (!config.authUsername || !config.authPasswordHash) {
      throw new Error("AUTH_USERNAME and AUTH_PASSWORD_HASH are required when PASSWORD_STORE_MODE=env.");
    }
  } else if (passwordStoreMode === "file" && !config.passwordStoreFile) {
    throw new Error("PASSWORD_STORE_FILE is required when PASSWORD_STORE_MODE=file.");
  }

  if ((passwordStoreMode === "sqlite" || configStoreMode === "sqlite") && !config.databaseFile) {
    throw new Error("DATABASE_FILE is required when SQLite-backed stores are enabled.");
  }

  if ((passwordStoreMode === "postgres" || configStoreMode === "postgres") && !config.postgresUrl) {
    throw new Error("POSTGRES_URL is required when PostgreSQL-backed stores are enabled.");
  }

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }

  if (!Number.isInteger(config.sessionMaxAgeHours) || config.sessionMaxAgeHours < 1) {
    throw new Error("SESSION_MAX_AGE_HOURS must be at least 1.");
  }

  if (!Number.isInteger(config.loginRateLimitWindowMs) || config.loginRateLimitWindowMs < 1) {
    throw new Error("LOGIN_RATE_LIMIT_WINDOW_MS must be a positive integer.");
  }

  if (!Number.isInteger(config.loginRateLimitMax) || config.loginRateLimitMax < 1) {
    throw new Error("LOGIN_RATE_LIMIT_MAX must be a positive integer.");
  }

  const blastdoorApiTimeoutMs = Number.parseInt(String(config.blastdoorApiTimeoutMs ?? "2500"), 10);
  if (!Number.isInteger(blastdoorApiTimeoutMs) || blastdoorApiTimeoutMs < 100) {
    throw new Error("BLASTDOOR_API_TIMEOUT_MS must be at least 100.");
  }

  const blastdoorApiRetryMaxAttempts = Number.parseInt(String(config.blastdoorApiRetryMaxAttempts ?? "3"), 10);
  if (!Number.isInteger(blastdoorApiRetryMaxAttempts) || blastdoorApiRetryMaxAttempts < 1) {
    throw new Error("BLASTDOOR_API_RETRY_MAX_ATTEMPTS must be a positive integer.");
  }

  const blastdoorApiRetryBaseDelayMs = Number.parseInt(String(config.blastdoorApiRetryBaseDelayMs ?? "120"), 10);
  if (!Number.isInteger(blastdoorApiRetryBaseDelayMs) || blastdoorApiRetryBaseDelayMs < 1) {
    throw new Error("BLASTDOOR_API_RETRY_BASE_DELAY_MS must be a positive integer.");
  }

  const blastdoorApiRetryMaxDelayMs = Number.parseInt(String(config.blastdoorApiRetryMaxDelayMs ?? "1200"), 10);
  if (!Number.isInteger(blastdoorApiRetryMaxDelayMs) || blastdoorApiRetryMaxDelayMs < blastdoorApiRetryBaseDelayMs) {
    throw new Error("BLASTDOOR_API_RETRY_MAX_DELAY_MS must be >= BLASTDOOR_API_RETRY_BASE_DELAY_MS.");
  }

  const blastdoorApiCircuitFailureThreshold = Number.parseInt(
    String(config.blastdoorApiCircuitFailureThreshold ?? "5"),
    10,
  );
  if (!Number.isInteger(blastdoorApiCircuitFailureThreshold) || blastdoorApiCircuitFailureThreshold < 1) {
    throw new Error("BLASTDOOR_API_CIRCUIT_FAILURE_THRESHOLD must be a positive integer.");
  }

  const blastdoorApiCircuitResetMs = Number.parseInt(String(config.blastdoorApiCircuitResetMs ?? "10000"), 10);
  if (!Number.isInteger(blastdoorApiCircuitResetMs) || blastdoorApiCircuitResetMs < 100) {
    throw new Error("BLASTDOOR_API_CIRCUIT_RESET_MS must be at least 100.");
  }

  const pluginManager = createPluginManager({ env: process.env });
  pluginManager.validateServerConfig(config);

  const tlsChallengeMethod = String(config.tlsChallengeMethod || "webroot").toLowerCase();
  if (!["webroot", "standalone"].includes(tlsChallengeMethod)) {
    throw new Error("TLS_CHALLENGE_METHOD must be one of: webroot, standalone.");
  }

  if (config.tlsEnabled) {
    if (!config.tlsCertFile || !config.tlsKeyFile) {
      throw new Error("TLS_CERT_FILE and TLS_KEY_FILE are required when TLS_ENABLED=true.");
    }
  }

  const normalizedEmailProvider = String(config.emailProvider || "disabled").toLowerCase();
  if (!["disabled", "console", "smtp"].includes(normalizedEmailProvider)) {
    throw new Error("EMAIL_PROVIDER must be one of: disabled, console, smtp.");
  }
  if (normalizedEmailProvider === "smtp") {
    const smtpPort = Number.parseInt(String(config.smtpPort || ""), 10);
    if (!config.smtpHost || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535 || !config.emailFrom) {
      throw new Error("SMTP_HOST, SMTP_PORT, and EMAIL_FROM are required when EMAIL_PROVIDER=smtp.");
    }
  }

  if (config.requireTotp && !config.totpSecret && passwordStoreMode === "env") {
    throw new Error("TOTP_SECRET is required when REQUIRE_TOTP=true and PASSWORD_STORE_MODE=env.");
  }

  try {
    new URL(config.foundryTarget);
  } catch {
    throw new Error("FOUNDRY_TARGET must be a full URL like http://127.0.0.1:30000");
  }

  const selfTarget = detectSelfProxyTarget(config);
  if (selfTarget.isSelfTarget) {
    throw new Error(
      `FOUNDRY_TARGET points to this Blastdoor gateway (${selfTarget.targetHost}:${selfTarget.targetPort}). ` +
        `Use your Foundry server address/port instead (for example http://127.0.0.1:30000).`,
    );
  }
}

function clampThemePercent(value, fallback, min, max) {
  const raw = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(raw)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, raw));
}

function normalizeLoginBoxMode(value) {
  return String(value || "").trim().toLowerCase() === "light" ? "light" : "dark";
}

function renderThemeStyleVars(theme) {
  const loginBoxWidthPercent = clampThemePercent(theme?.loginBoxWidthPercent, 100, 20, 100);
  const loginBoxHeightPercent = clampThemePercent(theme?.loginBoxHeightPercent, 100, 20, 100);
  const loginBoxOpacityPercent = clampThemePercent(theme?.loginBoxOpacityPercent, 100, 10, 100);
  const loginBoxHoverOpacityPercent = clampThemePercent(theme?.loginBoxHoverOpacityPercent, 100, 10, 100);
  const loginBoxPosXPercent = clampThemePercent(theme?.loginBoxPosXPercent, 50, 0, 100);
  const loginBoxPosYPercent = clampThemePercent(theme?.loginBoxPosYPercent, 50, 0, 100);
  const logoSizePercent = clampThemePercent(theme?.logoSizePercent, 30, 30, 100);
  const logoOffsetXPercent = clampThemePercent(theme?.logoOffsetXPercent, 2, 0, 100);
  const logoOffsetYPercent = clampThemePercent(theme?.logoOffsetYPercent, 2, 0, 100);
  const backgroundZoomPercent = clampThemePercent(theme?.backgroundZoomPercent, 100, 50, 200);

  const vars = [
    `--login-box-width-scale:${(loginBoxWidthPercent / 100).toFixed(4)}`,
    `--login-box-height-scale:${(loginBoxHeightPercent / 100).toFixed(4)}`,
    `--login-box-opacity-scale:${(loginBoxOpacityPercent / 100).toFixed(4)}`,
    `--login-box-hover-opacity-scale:${(loginBoxHoverOpacityPercent / 100).toFixed(4)}`,
    `--login-box-shift-x:${(loginBoxPosXPercent - 50).toFixed(2)}vw`,
    `--login-box-shift-y:${(loginBoxPosYPercent - 50).toFixed(2)}vh`,
    `--logo-size-scale:${(logoSizePercent / 30).toFixed(4)}`,
    `--logo-offset-x:${logoOffsetXPercent.toFixed(2)}vw`,
    `--logo-offset-y:${logoOffsetYPercent.toFixed(2)}vh`,
    `--background-zoom-scale:${(backgroundZoomPercent / 100).toFixed(4)}`,
  ];

  return vars.join(";");
}

function renderLoginPage({ error, csrfToken, nextPath, requireTotp, theme, pathPrefix = "" }) {
  const errorBlock = error
    ? `<p class="alert" role="alert">${escapeHtml(error)}</p>`
    : "";

  const totpField = requireTotp
    ? `<label for="totp">Authenticator Code</label>
       <input id="totp" name="totp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="123456" required />`
    : "";

  const styleHref = withPathPrefix("/assets/theme.css", pathPrefix);
  const loginAction = withPathPrefix("/login", pathPrefix);
  const logoUrl = withPathPrefix(theme.logoUrl || "", pathPrefix);
  const closedBackgroundUrl = withPathPrefix(theme.closedBackgroundUrl || "", pathPrefix);
  const openBackgroundUrl = withPathPrefix(theme.openBackgroundUrl || "", pathPrefix);

  const logoMarkup = logoUrl
    ? `<img class="brand-logo" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(theme.name || "Blastdoor logo")}" />`
    : `<span class="brand-logo-fallback">BLASTDOOR</span>`;

  const closedBgStyle = closedBackgroundUrl
    ? ` style="background-image: url('${escapeHtml(closedBackgroundUrl)}');"`
    : "";
  const openBgStyle = openBackgroundUrl
    ? ` style="background-image: url('${escapeHtml(openBackgroundUrl)}');"`
    : "";
  const themeStyleVars = renderThemeStyleVars(theme);
  const loginBoxMode = normalizeLoginBoxMode(theme?.loginBoxMode);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Blastdoor Access</title>
    <link rel="stylesheet" href="${escapeHtml(styleHref)}" />
  </head>
  <body data-login-box-mode="${loginBoxMode}" style="${themeStyleVars}">
    <div class="theme-stage" aria-hidden="true">
      <div class="theme-bg theme-bg-closed"${closedBgStyle}></div>
      <div class="theme-bg theme-bg-open"${openBgStyle}></div>
      <div class="theme-overlay"></div>
    </div>
    <div class="brand-anchor">${logoMarkup}</div>
    <div class="sky"></div>
    <main class="shell" aria-live="polite">
      <section class="panel">
        <p class="eyebrow">Foundry VTT Gateway</p>
        <h1>Blastdoor</h1>
        <p class="intro">Secure jump authorization for your campaign universe.</p>
        ${errorBlock}
        <form method="post" action="${escapeHtml(loginAction)}" autocomplete="off" novalidate>
          <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}" />
          <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />

          <label for="username">Username</label>
          <input id="username" name="username" type="text" autocomplete="username" required />

          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />

          ${totpField}

          <button type="submit">Enter Foundry</button>
        </form>
      </section>
    </main>
  </body>
</html>`;
}

function renderLoginSuccessPage({ nextPath, accountPath, theme, pathPrefix = "", forcePasswordChange = false }) {
  const styleHref = withPathPrefix("/assets/theme.css", pathPrefix);
  const logoUrl = withPathPrefix(theme.logoUrl || "", pathPrefix);
  const closedBackgroundUrl = withPathPrefix(theme.closedBackgroundUrl || "", pathPrefix);
  const openBackgroundUrl = withPathPrefix(theme.openBackgroundUrl || "", pathPrefix);
  const continueHref = withPathPrefix(nextPath, pathPrefix);
  const accountHref = withPathPrefix(accountPath, pathPrefix);

  const logoMarkup = logoUrl
    ? `<img class="brand-logo" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(theme.name || "Blastdoor logo")}" />`
    : `<span class="brand-logo-fallback">BLASTDOOR</span>`;

  const closedBgStyle = closedBackgroundUrl
    ? ` style="background-image: url('${escapeHtml(closedBackgroundUrl)}');"`
    : "";
  const openBgStyle = openBackgroundUrl
    ? ` style="background-image: url('${escapeHtml(openBackgroundUrl)}');"`
    : "";
  const themeStyleVars = renderThemeStyleVars(theme);
  const loginBoxMode = normalizeLoginBoxMode(theme?.loginBoxMode);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Blastdoor Access Granted</title>
    <link rel="stylesheet" href="${escapeHtml(styleHref)}" />
  </head>
  <body class="auth-success" data-login-box-mode="${loginBoxMode}" style="${themeStyleVars}">
    <div class="theme-stage" aria-hidden="true">
      <div class="theme-bg theme-bg-closed"${closedBgStyle}></div>
      <div class="theme-bg theme-bg-open"${openBgStyle}></div>
      <div class="theme-overlay"></div>
    </div>
    <div class="brand-anchor">${logoMarkup}</div>
    <main class="shell">
      <section class="panel success-panel">
        <p class="eyebrow">Foundry VTT Gateway</p>
        <h1>Access Granted</h1>
        <p class="intro">${
          forcePasswordChange
            ? "Password update required before Foundry access."
            : "Transitioning to your selected world..."
        }</p>
        <p class="success-note">If redirection does not start automatically, continue below.</p>
        <p class="success-links">
          <a class="continue-link" href="${escapeHtml(continueHref)}" id="continueLink">${
            forcePasswordChange ? "Continue to My Account" : "Continue to Foundry"
          }</a>
          <a class="continue-link" href="${escapeHtml(accountHref)}" id="accountLink">My Account</a>
        </p>
        <p class="success-note" id="redirectHint">Auto-redirect in 7 seconds...</p>
      </section>
    </main>
    <script>
      requestAnimationFrame(() => {
        document.body.classList.add("auth-success-active");
      });
      const redirectDelayMs = 7000;
      const hint = document.getElementById("redirectHint");
      let remaining = Math.ceil(redirectDelayMs / 1000);
      if (hint) {
        hint.textContent = "Auto-redirect in " + remaining + " seconds...";
      }
      const interval = setInterval(() => {
        remaining = Math.max(0, remaining - 1);
        if (hint) {
          hint.textContent = "Auto-redirect in " + remaining + " seconds...";
        }
        if (remaining <= 0) {
          clearInterval(interval);
        }
      }, 1000);
      setTimeout(() => {
        clearInterval(interval);
        const continueLink = document.getElementById("continueLink");
        if (!continueLink) {
          return;
        }

        const href = continueLink.getAttribute("href");
        if (href) {
          window.location.assign(href);
        }
      }, redirectDelayMs);
    </script>
  </body>
</html>`;
}

function renderBlastDoorsClosedPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Blast Doors Locked</title>
    <style>
      :root {
        --bg0: #07090f;
        --bg1: #101521;
        --line: #2b364f;
        --text: #ebf1ff;
        --muted: #a5b4d8;
        --alert: #ff8d8d;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at 12% 14%, rgba(255, 141, 141, 0.14), transparent 34%),
          radial-gradient(circle at 86% 18%, rgba(166, 190, 255, 0.09), transparent 30%),
          linear-gradient(180deg, var(--bg1), var(--bg0));
      }

      main {
        width: min(760px, 92vw);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 1.8rem;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent);
      }

      h1 {
        margin: 0 0 0.7rem;
        font-size: clamp(1.55rem, 3vw, 2.2rem);
      }

      p {
        margin: 0.45rem 0;
        color: var(--muted);
      }

      .alert {
        color: var(--alert);
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Blast Doors Are Locked</h1>
      <p class="alert">Gateway lockout is active. External routing is disabled.</p>
      <p>All requests are intentionally blocked while this security state is enabled.</p>
      <p>If you manage this service, open the Blastdoor admin panel and unlock blast doors.</p>
    </main>
  </body>
</html>`;
}

function normalizeOptionalText(value, maxLength = 2048) {
  return String(value || "").trim().slice(0, maxLength);
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

function normalizeEmail(value) {
  const normalized = normalizeOptionalText(value, 320).toLowerCase();
  if (!normalized) {
    return "";
  }
  if (!isValidEmailAddress(normalized)) {
    throw new Error("Email must be valid.");
  }
  return normalized;
}

function makeAccountPath(nextPath = "/") {
  return `/account?next=${encodeURIComponent(safeNextPath(nextPath, "/"))}`;
}

function normalizePathPrefix(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  let candidate = raw;
  if (candidate.includes("://")) {
    try {
      candidate = new URL(candidate).pathname || "";
    } catch {
      return "";
    }
  }

  candidate = candidate.replaceAll("\\", "/").trim();
  if (!candidate || candidate === "/") {
    return "";
  }
  if (!candidate.startsWith("/")) {
    candidate = `/${candidate}`;
  }
  candidate = candidate.replace(/\/+$/, "");
  if (!candidate || candidate === "/" || candidate.includes("..")) {
    return "";
  }

  return candidate;
}

function withPathPrefix(urlPath, pathPrefix = "") {
  const prefix = normalizePathPrefix(pathPrefix);
  const value = String(urlPath || "");
  if (!prefix || !value.startsWith("/") || value.startsWith("//")) {
    return value;
  }
  if (value === prefix || value.startsWith(`${prefix}/`)) {
    return value;
  }
  return `${prefix}${value}`;
}

function renderAccountPage({
  nextPath,
  csrfToken,
  profile,
  username,
  pathPrefix = "",
  forcePasswordChange = false,
  flashMessage = "",
  flashError = "",
}) {
  const statusClass = flashError ? "alert" : "success-note";
  const statusText = flashError || flashMessage;
  const continuePath = forcePasswordChange ? makeAccountPath(nextPath) : nextPath;
  const styleHref = withPathPrefix("/assets/theme.css", pathPrefix);
  const passwordAction = withPathPrefix("/account/password", pathPrefix);
  const profileAction = withPathPrefix("/account/profile", pathPrefix);
  const messageAction = withPathPrefix("/account/message-admin", pathPrefix);
  const logoutPath = withPathPrefix("/logout", pathPrefix);
  const continueHref = withPathPrefix(continuePath, pathPrefix);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Blastdoor My Account</title>
    <link rel="stylesheet" href="${escapeHtml(styleHref)}" />
  </head>
  <body>
    <div class="sky"></div>
    <main class="shell account-shell">
      <section class="panel account-panel">
        <p class="eyebrow">My Account</p>
        <h1>Welcome ${escapeHtml(username)}</h1>
        <p class="intro">${
          forcePasswordChange
            ? "Password change is required before accessing Foundry."
            : "Manage your password and personal profile."
        }</p>
        ${statusText ? `<p class="${statusClass}" role="status">${escapeHtml(statusText)}</p>` : ""}

        <div class="account-grid">
          <section>
            <h2>Password</h2>
            <form method="post" action="${escapeHtml(passwordAction)}">
              <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}" />
              <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
              <label for="currentPassword">Current Password${forcePasswordChange ? " (optional)" : ""}</label>
              <input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" />
              <label for="newPassword">New Password</label>
              <input id="newPassword" name="newPassword" type="password" autocomplete="new-password" required />
              <label for="confirmPassword">Confirm New Password</label>
              <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required />
              <button type="submit">Update Password</button>
            </form>
          </section>

          <section>
            <h2>Profile</h2>
            <form method="post" action="${escapeHtml(profileAction)}">
              <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}" />
              <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
              <label for="friendlyName">Friendly Name</label>
              <input id="friendlyName" name="friendlyName" value="${escapeHtml(profile?.friendlyName || "")}" />
              <label for="email">Email</label>
              <input id="email" name="email" type="email" value="${escapeHtml(profile?.email || "")}" />
              <label for="contactInfo">Contact Info</label>
              <textarea id="contactInfo" name="contactInfo" rows="2">${escapeHtml(profile?.contactInfo || "")}</textarea>
              <label for="avatarUrl">Picture URL</label>
              <input id="avatarUrl" name="avatarUrl" value="${escapeHtml(profile?.avatarUrl || "")}" />
              <label for="displayInfo">Display Info</label>
              <textarea id="displayInfo" name="displayInfo" rows="2">${escapeHtml(profile?.displayInfo || "")}</textarea>
              <button type="submit">Save Profile</button>
            </form>
          </section>
        </div>

        <section class="account-message-panel">
          <h2>Message Admin</h2>
          <form method="post" action="${escapeHtml(messageAction)}">
            <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}" />
            <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
            <label for="adminSubject">Subject</label>
            <input id="adminSubject" name="subject" maxlength="160" />
            <label for="adminMessage">Message</label>
            <textarea id="adminMessage" name="message" rows="4" required></textarea>
            <button type="submit">Send Message</button>
          </form>
        </section>

        <p class="success-links">
          <a class="continue-link" href="${escapeHtml(continueHref)}">Continue to Foundry</a>
          <a class="continue-link" href="${escapeHtml(logoutPath)}">Log Out</a>
        </p>
      </section>
    </main>
  </body>
</html>`;
}

function createNoopLogger() {
  return {
    debugEnabled: false,
    debug() {},
    info() {},
    warn() {},
    error() {},
    close() {},
  };
}

function fingerprintIdentifier(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function collectRequestContext(req) {
  return {
    requestId: req.requestId || null,
    method: req.method,
    path: req.originalUrl || req.url || "/",
    ip: req.ip,
    protocol: req.protocol,
    host: req.get("host") || null,
    origin: req.get("origin") || null,
    forwardedProto: req.get("x-forwarded-proto") || null,
    forwardedHost: req.get("x-forwarded-host") || null,
    userAgent: req.get("user-agent") || null,
  };
}

function normalizeManagedUserStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "active" || normalized === "deactivated" || normalized === "banned") {
    return normalized;
  }

  return "active";
}

export function createApp(config, options = {}) {
  validateConfig(config);
  const logger = options.logger || createNoopLogger();

  if (config.requireTotp) {
    authenticator.options = { window: 1, step: 30 };
  }

  const publicDir = options.publicDir || path.join(__dirname, "..", "public");
  const graphicsDir = options.graphicsDir || path.join(__dirname, "..", "graphics");
  const themeStorePath = options.themeStorePath || path.join(graphicsDir, "themes", "themes.json");
  const runtimeStatePath = options.runtimeStatePath || path.join(process.cwd(), "data", "runtime-state.json");
  const userProfileStorePath = options.userProfileStorePath || path.join(process.cwd(), "data", "user-profiles.json");
  const blastdoorApi =
    options.blastdoorApi ||
    createBlastdoorApi({
      config,
      graphicsDir,
      themeStorePath,
      userProfileStorePath,
      logger,
      postgresPoolFactory: options.postgresPoolFactory,
    });
  const emailService =
    options.emailService ||
    createEmailService(
      {
        ...loadEmailConfigFromEnv({
          EMAIL_PROVIDER: config.emailProvider,
          EMAIL_FROM: config.emailFrom,
          EMAIL_ADMIN_TO: config.emailAdminTo,
          SMTP_HOST: config.smtpHost,
          SMTP_PORT: config.smtpPort,
          SMTP_SECURE: config.smtpSecure,
          SMTP_USER: config.smtpUser,
          SMTP_PASS: config.smtpPass,
          SMTP_IGNORE_TLS: config.smtpIgnoreTls,
          PUBLIC_BASE_URL: config.publicBaseUrl,
        }),
      },
      { logger },
    );
  const blastDoorsStateController =
    options.blastDoorsStateController ||
    createBlastDoorsStateController({
      filePath: runtimeStatePath,
      fallback: Boolean(config.blastDoorsClosed),
      onReadError: (error) => {
        logger.warn("blastdoors.state_read_failed", {
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
          runtimeStatePath,
        });
      },
    });

  void blastDoorsStateController.setClosed(Boolean(config.blastDoorsClosed)).catch((error) => {
    logger.warn("blastdoors.state_write_failed", {
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
      runtimeStatePath,
    });
  });

  function normalizeThemeAssetPath(value, type) {
    return normalizeThemeAssetPathByType(value, type);
  }

  function resolveThemeAssetAbsolutePath(relativePath, type) {
    const normalizedPath = normalizeThemeAssetPath(relativePath, type);
    if (!normalizedPath) {
      return "";
    }

    const baseDir = path.resolve(graphicsDir);
    const absolutePath = path.resolve(baseDir, normalizedPath);
    if (absolutePath === baseDir || !absolutePath.startsWith(`${baseDir}${path.sep}`)) {
      return "";
    }

    return absolutePath;
  }

  async function themeAssetExists(relativePath, type) {
    const absolutePath = resolveThemeAssetAbsolutePath(relativePath, type);
    if (!absolutePath) {
      return false;
    }

    try {
      await fs.access(absolutePath);
      return true;
    } catch {
      return false;
    }
  }

  async function sanitizeResolvedLoginTheme(theme) {
    const normalized = {
      id: "",
      name: "Default",
      logoPath: "",
      logoUrl: "",
      closedBackgroundPath: "",
      closedBackgroundUrl: "",
      openBackgroundPath: "",
      openBackgroundUrl: "",
      createdAt: "",
      updatedAt: "",
      ...(theme && typeof theme === "object" ? theme : {}),
    };

    const assetDefs = [
      { key: "logo", pathKey: "logoPath", urlKey: "logoUrl", type: "logo" },
      { key: "closedBackground", pathKey: "closedBackgroundPath", urlKey: "closedBackgroundUrl", type: "background" },
      { key: "openBackground", pathKey: "openBackgroundPath", urlKey: "openBackgroundUrl", type: "background" },
    ];

    for (const asset of assetDefs) {
      const normalizedPath = normalizeThemeAssetPath(normalized[asset.pathKey], asset.type);
      if (!normalizedPath) {
        normalized[asset.pathKey] = "";
        normalized[asset.urlKey] = "";
        continue;
      }

      const exists = await themeAssetExists(normalizedPath, asset.type);
      if (exists) {
        normalized[asset.pathKey] = normalizedPath;
        normalized[asset.urlKey] = buildThemeAssetUrl(normalizedPath);
        continue;
      }

      if (logger.debugEnabled) {
        logger.warn("theme.asset_missing", {
          assetType: asset.key,
          assetPath: normalizedPath,
          themeId: normalized.id || "",
        });
      }
      normalized[asset.pathKey] = "";
      normalized[asset.urlKey] = "";
    }

    return normalized;
  }

  async function resolveLoginTheme() {
    try {
      const theme = await blastdoorApi.getActiveTheme();
      return await sanitizeResolvedLoginTheme(theme);
    } catch (error) {
      logger.warn("theme.load_failed", {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return await blastdoorApi
        .getActiveTheme()
        .then((theme) => sanitizeResolvedLoginTheme(theme))
        .catch(() => ({
        id: "",
        name: "Default",
        logoPath: "",
        logoUrl: "",
        closedBackgroundPath: "",
        closedBackgroundUrl: "",
        openBackgroundPath: "",
        openBackgroundUrl: "",
        createdAt: "",
        updatedAt: "",
        }));
    }
  }

  const configuredPathPrefix = normalizePathPrefix(config.publicBaseUrl);
  function resolveRequestPathPrefix(req) {
    const forwardedPrefix = normalizePathPrefix(
      req.get("x-forwarded-prefix") || req.get("x-forwarded-pathbase") || "",
    );
    return forwardedPrefix || configuredPathPrefix;
  }

  const app = express();
  if (config.trustProxy !== false) {
    app.set("trust proxy", config.trustProxy);
  }

  app.disable("x-powered-by");

  const gatewayHelmet = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: false,
    },
  });

  app.use(express.urlencoded({ extended: false, limit: "8kb" }));
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set("x-request-id", req.requestId);

    if (!logger.debugEnabled) {
      next();
      return;
    }

    const startedAt = Date.now();
    logger.debug("http.request.start", collectRequestContext(req));
    res.on("finish", () => {
      logger.debug("http.request.finish", {
        requestId: req.requestId,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    next();
  });

  app.use(async (req, res, next) => {
    const doorsClosed = await blastDoorsStateController.getClosed();
    if (!doorsClosed) {
      return next();
    }

    if (logger.debugEnabled) {
      logger.info("blastdoors.closed_block", collectRequestContext(req));
    }

    res.status(503);
    res.set("cache-control", "no-store");
    res.set("retry-after", "60");
    res.set("x-blastdoors-state", "locked");
    res.type("html");
    res.send(renderBlastDoorsClosedPage());
  });

  const sessionMiddleware = session({
    name: "blastdoor.sid",
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "strict",
      maxAge: config.sessionMaxAgeHours * 60 * 60 * 1000,
    },
  });

  app.use(sessionMiddleware);
  app.use("/login", gatewayHelmet);
  app.use("/healthz", gatewayHelmet);

  app.use(
    "/assets",
    express.static(publicDir, {
      etag: true,
      immutable: true,
      maxAge: "1h",
    }),
  );
  app.use(
    "/graphics",
    express.static(graphicsDir, {
      etag: true,
      immutable: Boolean(config.graphicsCacheEnabled),
      maxAge: config.graphicsCacheEnabled ? "1h" : 0,
      setHeaders(res) {
        if (!config.graphicsCacheEnabled) {
          res.setHeader("Cache-Control", "no-store");
        }
      },
    }),
  );

  async function authGuard(req, res, next) {
    const nextPath = safeNextPath(req.originalUrl, "/");
    const accept = req.get("accept") || "";
    const wantsHtml = accept.includes("text/html");

    if (req.session?.authenticated) {
      const sessionUser = typeof req.session.user === "string" ? req.session.user : "";
      if (!sessionUser) {
        req.session.destroy(() => {
          res.clearCookie("blastdoor.sid");
          if (wantsHtml) {
            const loginPath = withPathPrefix("/login", resolveRequestPathPrefix(req));
            res.redirect(`${loginPath}?next=${encodeURIComponent(nextPath)}`);
            return;
          }
          res.status(401).json({ error: "Authentication required" });
        });
        return;
      }

      try {
        const profile = await blastdoorApi.getUserProfile(sessionUser);
        const profileStatus = normalizeManagedUserStatus(profile?.status);
        const profileSessionVersion = Number.parseInt(String(profile?.sessionVersion || 1), 10) || 1;
        const sessionVersion = Number.parseInt(String(req.session.userSessionVersion || 1), 10) || 1;
        if (profileStatus !== "active" || profileSessionVersion !== sessionVersion) {
          if (logger.debugEnabled) {
            logger.info("auth.guard.session_invalidated", {
              ...collectRequestContext(req),
              usernameFingerprint: fingerprintIdentifier(sessionUser),
              profileStatus,
              profileSessionVersion,
              sessionVersion,
            });
          }

          req.session.destroy(() => {
            res.clearCookie("blastdoor.sid");
            if (wantsHtml) {
              const loginPath = withPathPrefix("/login", resolveRequestPathPrefix(req));
              res.redirect(`${loginPath}?next=${encodeURIComponent(nextPath)}`);
              return;
            }
            res.status(401).json({ error: "Authentication required" });
          });
          return;
        }

        const requiresPasswordChange = Boolean(profile?.requirePasswordChange || !profile?.firstLoginCompletedAt);
        req.session.forcePasswordChange = requiresPasswordChange;
        const primaryNextPath = safeNextPath(req.session.postAuthNextPath || "/", "/");
        const accountPath = makeAccountPath(primaryNextPath);
        const requestPath = safeNextPath(req.originalUrl, "/");
        const accountAllowed =
          requestPath.startsWith("/account") || requestPath.startsWith("/logout") || requestPath.startsWith("/login");

        if (requiresPasswordChange && !accountAllowed) {
          const outwardAccountPath = withPathPrefix(accountPath, resolveRequestPathPrefix(req));
          if (wantsHtml) {
            return res.redirect(outwardAccountPath);
          }
          return res.status(428).json({
            error: "Password change required.",
            accountPath: outwardAccountPath,
          });
        }
      } catch (error) {
        logger.error("auth.guard.profile_store_error", {
          ...collectRequestContext(req),
          usernameFingerprint: fingerprintIdentifier(sessionUser),
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return res.status(500).json({ error: "Authentication service unavailable." });
      }

      return next();
    }

    if (wantsHtml) {
      if (logger.debugEnabled) {
        logger.debug("auth.guard.redirect", collectRequestContext(req));
      }

      const loginPath = withPathPrefix("/login", resolveRequestPathPrefix(req));
      return res.redirect(`${loginPath}?next=${encodeURIComponent(nextPath)}`);
    }

    if (logger.debugEnabled) {
      logger.debug("auth.guard.unauthorized", collectRequestContext(req));
    }

    return res.status(401).json({ error: "Authentication required" });
  }

  function resolvePostAuthNext(req) {
    return safeNextPath(req.query?.next || req.body?.next || req.session?.postAuthNextPath || "/", "/");
  }

  function nextAccountCsrf(req) {
    req.session.accountCsrf = createCsrfToken();
    return req.session.accountCsrf;
  }

  function consumeAccountCsrf(req) {
    const provided = typeof req.body?.csrf === "string" ? req.body.csrf : "";
    const expected = req.session.accountCsrf;
    req.session.accountCsrf = null;
    return Boolean(expected) && safeEqual(provided, expected);
  }

  async function loadActiveSessionProfile(req) {
    const username = typeof req.session?.user === "string" ? req.session.user : "";
    if (!username) {
      return null;
    }

    let profile = await blastdoorApi.getRawUserProfile(username);
    if (!profile) {
      profile = await blastdoorApi.upsertUserProfile({
        username,
        status: "active",
      });
    }
    return profile;
  }

  async function renderAccount(req, res, message = "", error = "") {
    const nextPath = resolvePostAuthNext(req);
    req.session.postAuthNextPath = nextPath;
    const profile = await loadActiveSessionProfile(req);
    const forcePasswordChange = Boolean(profile?.requirePasswordChange);
    req.session.forcePasswordChange = forcePasswordChange;
    const csrfToken = nextAccountCsrf(req);

    res.set("cache-control", "no-store");
    res.status(error ? 400 : 200).send(
      renderAccountPage({
        nextPath,
        csrfToken,
        profile,
        username: req.session.user,
        pathPrefix: resolveRequestPathPrefix(req),
        forcePasswordChange,
        flashMessage: message,
        flashError: error,
      }),
    );
  }

  app.get("/healthz", (req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get(
    "/login",
    rateLimit({
      windowMs: config.loginRateLimitWindowMs,
      max: Math.max(config.loginRateLimitMax * 20, 120),
      standardHeaders: true,
      legacyHeaders: false,
      message: "Too many login page requests. Try again shortly.",
    }),
    async (req, res) => {
    const forceReauth = parseBoolean(req.query.reauth, false);
    if (forceReauth && req.session) {
      const nextPath = safeNextPath(req.query.next, "/");
      return req.session.destroy(() => {
        res.clearCookie("blastdoor.sid");
        const prefixedLoginPath = withPathPrefix("/login", resolveRequestPathPrefix(req));
        res.redirect(`${prefixedLoginPath}?next=${encodeURIComponent(nextPath)}`);
      });
    }

    if (req.session?.authenticated) {
      const requestedNextPath = safeNextPath(req.query.next, "/");
      req.session.postAuthNextPath = requestedNextPath;
      let profile = null;
      try {
        profile = await loadActiveSessionProfile(req);
      } catch (error) {
        logger.warn("auth.login.profile_reload_failed", {
          ...collectRequestContext(req),
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      const forcePasswordChange = Boolean(
        req.session.forcePasswordChange || profile?.requirePasswordChange || !profile?.firstLoginCompletedAt,
      );
      req.session.forcePasswordChange = forcePasswordChange;
      const nextPath = forcePasswordChange ? makeAccountPath(requestedNextPath) : requestedNextPath;
      const accountPath = makeAccountPath(requestedNextPath);
      if (logger.debugEnabled) {
        logger.debug("auth.login.already_authenticated", {
          ...collectRequestContext(req),
          nextPath,
          forcePasswordChange,
        });
      }

      const theme = await resolveLoginTheme();
      res.set("cache-control", "no-store");
      return res.status(200).send(
        renderLoginSuccessPage({
          nextPath,
          accountPath,
          theme,
          pathPrefix: resolveRequestPathPrefix(req),
          forcePasswordChange,
        }),
      );
    }

    req.session.loginCsrf = createCsrfToken();

    const nextPath = safeNextPath(req.query.next, "/");
    const theme = await resolveLoginTheme();
    res.set("cache-control", "no-store");
    return res.status(200).send(
      renderLoginPage({
        error: "",
        csrfToken: req.session.loginCsrf,
        nextPath,
        requireTotp: config.requireTotp,
        theme,
        pathPrefix: resolveRequestPathPrefix(req),
      }),
    );
    },
  );

  app.post(
    "/login",
    rateLimit({
      windowMs: config.loginRateLimitWindowMs,
      max: config.loginRateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      message: "Too many login attempts. Try again in 15 minutes.",
    }),
    async (req, res) => {
    const originResult = evaluateSameOrigin(req, {
      allowedOrigins: config.allowedOrigins,
      allowNullOrigin: config.allowNullOrigin,
    });
    if (!originResult.ok) {
      if (logger.debugEnabled) {
        logger.warn("auth.login.origin_rejected", {
          ...collectRequestContext(req),
          reason: originResult.reason,
          details: originResult.details || null,
        });
      }

      return res.status(403).send(`Forbidden (request id: ${req.requestId || "n/a"})`);
    }

    const nextPath = safeNextPath(req.body.next, "/");
    const csrf = typeof req.body.csrf === "string" ? req.body.csrf : "";
    const expectedCsrf = req.session.loginCsrf;
    req.session.loginCsrf = null;

    if (!expectedCsrf || !safeEqual(csrf, expectedCsrf)) {
      if (logger.debugEnabled) {
        logger.warn("auth.login.csrf_rejected", {
          ...collectRequestContext(req),
          hasExpectedCsrf: Boolean(expectedCsrf),
          hasProvidedCsrf: csrf.length > 0,
          nextPath,
        });
      }

      return res.status(403).send("Invalid CSRF token.");
    }

    const username = typeof req.body.username === "string" ? req.body.username : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const totp = typeof req.body.totp === "string" ? req.body.totp.trim() : "";

    let userRecord = null;
    try {
      userRecord = await blastdoorApi.getUserCredential(username);
    } catch (error) {
      logger.error("auth.login.password_store_error", {
        ...collectRequestContext(req),
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return res.status(500).send("Authentication service unavailable.");
    }

    let managedProfile;
    try {
      managedProfile = await blastdoorApi.getRawUserProfile(username);
      if (!managedProfile && userRecord?.username) {
        managedProfile = await blastdoorApi.upsertUserProfile({
          username: userRecord.username,
          status: userRecord.disabled ? "deactivated" : "active",
          firstLoginCompletedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.error("auth.login.profile_store_error", {
        ...collectRequestContext(req),
        usernameFingerprint: fingerprintIdentifier(username),
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return res.status(500).send("Authentication profile service unavailable.");
    }

    const usernameValid = Boolean(userRecord);
    const profileStatus = normalizeManagedUserStatus(managedProfile?.status || (userRecord?.disabled ? "deactivated" : "active"));
    let passwordValid = userRecord ? verifyPassword(password, userRecord.passwordHash) : false;
    let tempCodeValid = false;
    if (userRecord && !passwordValid && password.trim()) {
      try {
        tempCodeValid = await blastdoorApi.verifyTemporaryLoginCode(username, password, { consume: true });
      } catch (error) {
        logger.warn("auth.login.temp_code_verify_failed", {
          ...collectRequestContext(req),
          usernameFingerprint: fingerprintIdentifier(username),
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    passwordValid = passwordValid || tempCodeValid;
    const effectiveTotpSecret = userRecord?.totpSecret || config.totpSecret;
    const totpValid = config.requireTotp
      ? Boolean(effectiveTotpSecret) && authenticator.check(totp, effectiveTotpSecret)
      : true;

    if (!usernameValid || !passwordValid || !totpValid || profileStatus !== "active") {
      if (logger.debugEnabled) {
        logger.warn("auth.login.credentials_rejected", {
          ...collectRequestContext(req),
          usernameFingerprint: fingerprintIdentifier(username),
          usernameValid,
          passwordValid,
          tempCodeValid,
          totpValid,
          profileStatus,
          requireTotp: config.requireTotp,
          nextPath,
        });
      }

      const theme = await resolveLoginTheme();
      req.session.loginCsrf = createCsrfToken();
      res.set("cache-control", "no-store");
      return res.status(401).send(
        renderLoginPage({
          error: "Access denied. Check your credentials and code.",
          csrfToken: req.session.loginCsrf,
          nextPath,
          requireTotp: config.requireTotp,
          theme,
          pathPrefix: resolveRequestPathPrefix(req),
        }),
      );
    }

    let loginProfile = managedProfile;
    let requirePasswordChange = Boolean(
      tempCodeValid || managedProfile?.requirePasswordChange || !managedProfile?.firstLoginCompletedAt,
    );
    if (tempCodeValid && !managedProfile?.requirePasswordChange) {
      try {
        loginProfile = await blastdoorApi.upsertUserProfile({
          username: userRecord?.username || username,
          requirePasswordChange: true,
        });
        requirePasswordChange = true;
      } catch (error) {
        logger.warn("auth.login.require_password_change_mark_failed", {
          ...collectRequestContext(req),
          usernameFingerprint: fingerprintIdentifier(username),
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    try {
      loginProfile = await blastdoorApi.recordSuccessfulLogin(userRecord?.username || username, req.ip);
    } catch (error) {
      logger.warn("auth.login.profile_update_failed", {
        ...collectRequestContext(req),
        usernameFingerprint: fingerprintIdentifier(username),
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }

    return req.session.regenerate((err) => {
      if (err) {
        logger.error("auth.login.session_regenerate_failed", {
          ...collectRequestContext(req),
          error: {
            message: err.message,
          },
        });

        return res.status(500).send("Session error");
      }

      req.session.authenticated = true;
      req.session.user = userRecord?.username || username;
      req.session.userSessionVersion = Number.parseInt(String(loginProfile?.sessionVersion || 1), 10) || 1;
      req.session.forcePasswordChange = requirePasswordChange;
      req.session.postAuthNextPath = nextPath;

      const transitionNextPath = requirePasswordChange ? makeAccountPath(nextPath) : nextPath;
      const accountPath = makeAccountPath(nextPath);

      return req.session.save((saveErr) => {
        if (saveErr) {
          logger.error("auth.login.session_save_failed", {
            ...collectRequestContext(req),
            error: {
              message: saveErr.message,
            },
          });

          return res.status(500).send("Session save error");
        }

        if (logger.debugEnabled) {
          logger.info("auth.login.success", {
            ...collectRequestContext(req),
            usernameFingerprint: fingerprintIdentifier(username),
            nextPath,
          });
        }

        const accept = req.get("accept") || "";
        const wantsHtml = accept.includes("text/html");
        if (!wantsHtml) {
          return res.status(200).json({ ok: true, nextPath: transitionNextPath, accountPath, requirePasswordChange });
        }

        return resolveLoginTheme()
          .then((theme) => {
            res.set("cache-control", "no-store");
            res.status(200).send(
              renderLoginSuccessPage({
                nextPath: transitionNextPath,
                accountPath,
                theme,
                pathPrefix: resolveRequestPathPrefix(req),
                forcePasswordChange: requirePasswordChange,
              }),
            );
          })
          .catch(() => {
            res.set("cache-control", "no-store");
            res.status(200).send(
              renderLoginSuccessPage({
                nextPath: transitionNextPath,
                theme: {
                  id: "",
                  name: "Default",
                  logoPath: "",
                  logoUrl: "",
                  closedBackgroundPath: "",
                  closedBackgroundUrl: "",
                  openBackgroundPath: "",
                  openBackgroundUrl: "",
                  createdAt: "",
                  updatedAt: "",
                },
                accountPath,
                pathPrefix: resolveRequestPathPrefix(req),
                forcePasswordChange: requirePasswordChange,
              }),
            );
          });
      });
    });
    },
  );

  const accountReadLimiter = rateLimit({
    windowMs: config.loginRateLimitWindowMs,
    max: Math.max(config.loginRateLimitMax * 20, 120),
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many account page requests. Try again shortly.",
  });

  const accountWriteLimiter = rateLimit({
    windowMs: config.loginRateLimitWindowMs,
    max: Math.max(config.loginRateLimitMax * 4, 24),
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many account update requests. Try again shortly.",
  });

  app.get("/account", accountReadLimiter, authGuard, async (req, res) => {
    try {
      await renderAccount(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await renderAccount(req, res, "", message);
    }
  });

  app.post("/account/password", accountWriteLimiter, authGuard, async (req, res) => {
    try {
      if (!consumeAccountCsrf(req)) {
        throw new Error("Invalid account form token. Refresh and try again.");
      }

      const username = normalizeOptionalText(req.session?.user, 128);
      if (!username) {
        throw new Error("Not authenticated.");
      }

      const currentPassword = normalizeOptionalText(req.body?.currentPassword, 1024);
      const newPassword = normalizeOptionalText(req.body?.newPassword, 1024);
      const confirmPassword = normalizeOptionalText(req.body?.confirmPassword, 1024);
      if (!newPassword || newPassword.length < 12) {
        throw new Error("New password must be at least 12 characters.");
      }
      if (newPassword !== confirmPassword) {
        throw new Error("New password confirmation does not match.");
      }

      const userRecord = await blastdoorApi.getUserCredential(username);
      if (!userRecord) {
        throw new Error("User credential record not found.");
      }

      const forcePasswordChange = Boolean(req.session.forcePasswordChange);
      if (!forcePasswordChange && !verifyPassword(currentPassword, userRecord.passwordHash)) {
        throw new Error("Current password is incorrect.");
      }

      await blastdoorApi.upsertCredentialUser({
        username: userRecord.username,
        passwordHash: createPasswordHash(newPassword),
        totpSecret: userRecord.totpSecret || null,
        disabled: Boolean(userRecord.disabled),
      });

      const profile = await blastdoorApi.upsertUserProfile({
        username: userRecord.username,
        requirePasswordChange: false,
        firstLoginCompletedAt: new Date().toISOString(),
      });

      req.session.forcePasswordChange = false;
      req.session.userSessionVersion = Number.parseInt(String(profile?.sessionVersion || req.session.userSessionVersion || 1), 10);
      await renderAccount(req, res, "Password updated. You can now continue to Foundry.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await renderAccount(req, res, "", message);
    }
  });

  app.post("/account/profile", accountWriteLimiter, authGuard, async (req, res) => {
    try {
      if (!consumeAccountCsrf(req)) {
        throw new Error("Invalid account form token. Refresh and try again.");
      }

      const username = normalizeOptionalText(req.session?.user, 128);
      if (!username) {
        throw new Error("Not authenticated.");
      }

      const friendlyName = normalizeOptionalText(req.body?.friendlyName, 160);
      const email = normalizeEmail(req.body?.email);
      const contactInfo = normalizeOptionalText(req.body?.contactInfo, 1024);
      const avatarUrl = normalizeOptionalText(req.body?.avatarUrl, 1024);
      const displayInfo = normalizeOptionalText(req.body?.displayInfo, 2048);

      await blastdoorApi.upsertUserProfile({
        username,
        friendlyName,
        email,
        contactInfo,
        avatarUrl,
        displayInfo,
      });

      await renderAccount(req, res, "Profile updated.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await renderAccount(req, res, "", message);
    }
  });

  app.post("/account/message-admin", accountWriteLimiter, authGuard, async (req, res) => {
    try {
      if (!consumeAccountCsrf(req)) {
        throw new Error("Invalid account form token. Refresh and try again.");
      }

      const username = normalizeOptionalText(req.session?.user, 128);
      if (!username) {
        throw new Error("Not authenticated.");
      }

      const subject = normalizeOptionalText(req.body?.subject, 160);
      const message = normalizeOptionalText(req.body?.message, 2000);
      if (!message) {
        throw new Error("Message cannot be empty.");
      }

      const profile = await blastdoorApi.getUserProfile(username);
      const result = await emailService.sendAdminMessage({
        fromUsername: username,
        fromEmail: profile?.email || "",
        subject,
        message,
      });

      if (!result?.ok) {
        const reason = result?.reason || "Email is not configured.";
        await renderAccount(req, res, "", `Admin message not sent: ${reason}`);
        return;
      }

      await renderAccount(req, res, "Message sent to admin.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await renderAccount(req, res, "", message);
    }
  });

  function clearSession(req, res) {
    req.session.destroy(() => {
      if (logger.debugEnabled) {
        logger.info("auth.logout", collectRequestContext(req));
      }

      res.clearCookie("blastdoor.sid");
      res.redirect(withPathPrefix("/login", resolveRequestPathPrefix(req)));
    });
  }

  app.get("/logout", clearSession);
  app.post("/logout", clearSession);

  const proxy = createProxyMiddleware({
    target: config.foundryTarget,
    changeOrigin: true,
    xfwd: true,
    ws: false,
    secure: config.proxyTlsVerify,
    proxyTimeout: 60_000,
    timeout: 60_000,
    on: {
      error(err, req, res) {
        const details = {
          requestId: req.requestId || null,
          path: req.url || null,
          host: req.headers?.host || null,
          target: config.foundryTarget,
          error: {
            name: err.name,
            message: err.message,
            code: err.code || null,
          },
        };

        logger.error("proxy.http_error", details);

        if (!res || typeof res.writeHead !== "function" || typeof res.end !== "function") {
          return;
        }

        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        }

        const suggestion =
          err.code === "ECONNREFUSED"
            ? "Foundry target refused the connection. Verify FOUNDRY_TARGET and that Foundry is running."
            : "Verify FOUNDRY_TARGET and upstream Foundry availability.";
        res.end(`Gateway error: ${err.message}\nTarget: ${config.foundryTarget}\n${suggestion}`);
      },
    },
  });

  app.use(authGuard);
  app.use("/", proxy);

  return {
    app,
    proxy,
    sessionMiddleware,
    blastdoorApi,
    emailService,
    blastDoorsStateController,
    runtimeStatePath,
  };
}

export function attachWebsocketAuth(
  server,
  sessionMiddleware,
  proxy,
  logger = createNoopLogger(),
  options = {},
) {
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      let doorsClosed = Boolean(options.blastDoorsClosed);
      if (typeof options.isBlastDoorsClosed === "function") {
        try {
          doorsClosed = Boolean(await options.isBlastDoorsClosed());
        } catch (error) {
          logger.warn("blastdoors.websocket_state_read_failed", {
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }

      if (doorsClosed) {
        if (logger.debugEnabled) {
          logger.warn("blastdoors.closed_websocket_block", {
            path: req.url || "/",
            host: req.headers.host || null,
            origin: req.headers.origin || null,
          });
        }

        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      const url = req.url || "/";
      if (url.startsWith("/assets") || url.startsWith("/login") || url.startsWith("/healthz")) {
        socket.destroy();
        return;
      }

      const denyUpgrade = () => {
        if (logger.debugEnabled) {
          logger.warn("proxy.websocket_unauthorized", {
            path: url,
            host: req.headers.host || null,
            origin: req.headers.origin || null,
            forwardedProto: req.headers["x-forwarded-proto"] || null,
          });
        }

        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      };

      const fakeRes = {
        getHeader() {
          return undefined;
        },
        setHeader() {},
        end() {},
        writeHead() {},
      };

      try {
        sessionMiddleware(req, fakeRes, () => {
          if (!req.session?.authenticated) {
            denyUpgrade();
            return;
          }

          if (logger.debugEnabled) {
            logger.debug("proxy.websocket_authorized", {
              path: url,
              host: req.headers.host || null,
              origin: req.headers.origin || null,
            });
          }

          proxy.upgrade(req, socket, head);
        });
      } catch (error) {
        logger.error("proxy.websocket_upgrade_error", {
          path: url,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
        denyUpgrade();
      }
    })().catch((error) => {
      logger.error("proxy.websocket_state_handler_error", {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    });
  });
}

export function createServer(config, options = {}) {
  const logger = options.logger || createLogger({
    debugEnabled: Boolean(config.debugMode),
    logFile: config.debugLogFile || "logs/blastdoor-debug.log",
  });

  const { app, proxy, sessionMiddleware, blastdoorApi, emailService, blastDoorsStateController, runtimeStatePath } =
    createApp(config, {
      ...options,
      logger,
    });
  const configStore = options.configStore || createConfigStore(config, options);

  void persistConfigSnapshot(config, configStore, logger);
  let server;
  if (config.tlsEnabled) {
    try {
      const keyPath = path.resolve(config.tlsKeyFile);
      const certPath = path.resolve(config.tlsCertFile);
      const tlsOptions = {
        key: fsSync.readFileSync(keyPath),
        cert: fsSync.readFileSync(certPath),
      };
      if (config.tlsCaFile) {
        tlsOptions.ca = fsSync.readFileSync(path.resolve(config.tlsCaFile));
      }
      if (config.tlsPassphrase) {
        tlsOptions.passphrase = config.tlsPassphrase;
      }
      server = https.createServer(tlsOptions, app);
    } catch (error) {
      throw new Error(
        `Failed to initialize TLS. Check TLS_CERT_FILE/TLS_KEY_FILE paths and permissions: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  } else {
    server = http.createServer(app);
  }

  server.on("error", (error) => {
    const code = error?.code || null;
    const address = error?.address || config.host || null;
    const port = error?.port || config.port || null;
    const isWsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
    let hint = null;
    if (code === "EADDRNOTAVAIL") {
      hint = isWsl
        ? "HOST is not available in this WSL runtime. Use HOST=0.0.0.0 and expose LAN access via Windows portproxy."
        : "HOST is not available on this machine. Use HOST=0.0.0.0 or a local interface address.";
    } else if (code === "EADDRINUSE") {
      hint = "Port is already in use. Stop the conflicting process or change PORT.";
    }

    logger.error("server.listen_error", {
      code,
      message: error instanceof Error ? error.message : String(error),
      host: config.host,
      port: config.port,
      address,
      listenPort: port,
      hint,
    });

    if (typeof options.onListenError === "function") {
      options.onListenError(error, { config, hint });
    }

    if (options.exitOnListenError !== false) {
      process.nextTick(() => {
        process.exit(1);
      });
    }
  });

  server.listen(config.port, config.host, () => {
    if (options.silent) {
      return;
    }

    logger.info("server.started", {
      host: config.host,
      port: config.port,
      foundryTarget: config.foundryTarget,
      passwordStoreMode: config.passwordStoreMode,
      passwordStoreFile: config.passwordStoreMode === "file" ? config.passwordStoreFile : null,
      configStoreMode: config.configStoreMode,
      databaseFile:
        config.passwordStoreMode === "sqlite" || config.configStoreMode === "sqlite"
          ? config.databaseFile
          : null,
      postgresConfigured:
        config.passwordStoreMode === "postgres" || config.configStoreMode === "postgres"
          ? Boolean(config.postgresUrl)
          : false,
      blastdoorApiUrl: config.blastdoorApiUrl || null,
      allowNullOrigin: Boolean(config.allowNullOrigin),
      blastDoorsClosed: Boolean(config.blastDoorsClosed),
      tlsEnabled: Boolean(config.tlsEnabled),
      tlsCertFile: config.tlsEnabled ? config.tlsCertFile || null : null,
      tlsKeyFile: config.tlsEnabled ? config.tlsKeyFile || null : null,
      emailProvider: config.emailProvider || "disabled",
      emailAdminConfigured: Boolean(config.emailAdminTo),
      runtimeStatePath,
      debugMode: Boolean(config.debugMode),
      debugLogFile: config.debugLogFile || null,
    });
  });

  attachWebsocketAuth(server, sessionMiddleware, proxy, logger, {
    blastDoorsClosed: Boolean(config.blastDoorsClosed),
    isBlastDoorsClosed: () => blastDoorsStateController.getClosed(),
  });
  server.on("close", () => {
    if (typeof blastdoorApi?.close === "function") {
      Promise.resolve(blastdoorApi.close()).catch((error) => {
        logger.warn("blastdoor_api.close_failed", {
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    }
    if (typeof emailService?.close === "function") {
      Promise.resolve(emailService.close()).catch((error) => {
        logger.warn("email_service.close_failed", {
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    }
    if (typeof configStore?.close === "function") {
      Promise.resolve(configStore.close()).catch((error) => {
        logger.warn("config_store.close_failed", {
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    }
    logger.close();
  });
  return server;
}

async function persistConfigSnapshot(config, configStore, logger) {
  const mode = String(config.configStoreMode || "env").toLowerCase();
  if (!["sqlite", "postgres"].includes(mode)) {
    return;
  }

  const values = {
    HOST: String(config.host),
    PORT: String(config.port),
    FOUNDRY_TARGET: String(config.foundryTarget),
    PASSWORD_STORE_MODE: String(config.passwordStoreMode),
    PASSWORD_STORE_FILE: String(config.passwordStoreFile || ""),
    CONFIG_STORE_MODE: String(config.configStoreMode || "env"),
    DATABASE_FILE: String(config.databaseFile || ""),
    POSTGRES_URL: String(config.postgresUrl || ""),
    POSTGRES_SSL: String(Boolean(config.postgresSsl)),
    AUTH_USERNAME: String(config.authUsername || ""),
    COOKIE_SECURE: String(Boolean(config.cookieSecure)),
    TRUST_PROXY: String(config.trustProxy),
    SESSION_MAX_AGE_HOURS: String(config.sessionMaxAgeHours),
    LOGIN_RATE_LIMIT_WINDOW_MS: String(config.loginRateLimitWindowMs),
    LOGIN_RATE_LIMIT_MAX: String(config.loginRateLimitMax),
    REQUIRE_TOTP: String(Boolean(config.requireTotp)),
    PROXY_TLS_VERIFY: String(Boolean(config.proxyTlsVerify)),
    ALLOWED_ORIGINS: String(config.allowedOrigins || ""),
    ALLOW_NULL_ORIGIN: String(Boolean(config.allowNullOrigin)),
    GRAPHICS_CACHE_ENABLED: String(Boolean(config.graphicsCacheEnabled)),
    BLASTDOOR_API_URL: String(config.blastdoorApiUrl || ""),
    BLASTDOOR_API_TOKEN: String(config.blastdoorApiToken || ""),
    BLASTDOOR_API_TIMEOUT_MS: String(config.blastdoorApiTimeoutMs || 2500),
    BLASTDOOR_API_RETRY_MAX_ATTEMPTS: String(config.blastdoorApiRetryMaxAttempts || 3),
    BLASTDOOR_API_RETRY_BASE_DELAY_MS: String(config.blastdoorApiRetryBaseDelayMs || 120),
    BLASTDOOR_API_RETRY_MAX_DELAY_MS: String(config.blastdoorApiRetryMaxDelayMs || 1200),
    BLASTDOOR_API_CIRCUIT_FAILURE_THRESHOLD: String(config.blastdoorApiCircuitFailureThreshold || 5),
    BLASTDOOR_API_CIRCUIT_RESET_MS: String(config.blastdoorApiCircuitResetMs || 10000),
    BLAST_DOORS_CLOSED: String(Boolean(config.blastDoorsClosed)),
    TLS_ENABLED: String(Boolean(config.tlsEnabled)),
    TLS_DOMAIN: String(config.tlsDomain || ""),
    TLS_EMAIL: String(config.tlsEmail || ""),
    TLS_CHALLENGE_METHOD: String(config.tlsChallengeMethod || "webroot"),
    TLS_WEBROOT_PATH: String(config.tlsWebrootPath || ""),
    TLS_CERT_FILE: String(config.tlsCertFile || ""),
    TLS_KEY_FILE: String(config.tlsKeyFile || ""),
    TLS_CA_FILE: String(config.tlsCaFile || ""),
    TLS_PASSPHRASE: String(config.tlsPassphrase || ""),
    EMAIL_PROVIDER: String(config.emailProvider || "disabled"),
    EMAIL_FROM: String(config.emailFrom || ""),
    EMAIL_ADMIN_TO: String(config.emailAdminTo || ""),
    SMTP_HOST: String(config.smtpHost || ""),
    SMTP_PORT: String(config.smtpPort || 587),
    SMTP_SECURE: String(Boolean(config.smtpSecure)),
    SMTP_USER: String(config.smtpUser || ""),
    SMTP_PASS: String(config.smtpPass || ""),
    SMTP_IGNORE_TLS: String(Boolean(config.smtpIgnoreTls)),
    PUBLIC_BASE_URL: String(config.publicBaseUrl || ""),
    DEBUG_MODE: String(Boolean(config.debugMode)),
    DEBUG_LOG_FILE: String(config.debugLogFile || ""),
  };
  const pluginManager = createPluginManager({ env: process.env });
  Object.assign(values, pluginManager.getPersistedServerValues(config));

  try {
    for (const [key, value] of Object.entries(values)) {
      await configStore.setValue(key, value);
    }

    const envPath = path.resolve(process.cwd(), ".env");
    const envExamplePath = path.resolve(process.cwd(), ".env.example");
    const envContent = await fs.readFile(envPath, "utf8");
    await configStore.putFile(".env", envContent);

    try {
      const envExampleContent = await fs.readFile(envExamplePath, "utf8");
      await configStore.putFile(".env.example", envExampleContent);
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        throw error;
      }
    }
  } catch (error) {
    logger.warn("config_store.persist_failed", {
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function isEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }

  return path.resolve(process.argv[1]) === __filename;
}

if (isEntrypoint()) {
  process.title = "blastdoor-gateway";
  const config = loadConfigFromEnv();
  createServer(config);
}
