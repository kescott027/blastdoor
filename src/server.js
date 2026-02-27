import "dotenv/config";
import express from "express";
import helmet from "helmet";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { createProxyMiddleware } from "http-proxy-middleware";
import { authenticator } from "otplib";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCsrfToken,
  evaluateSameOrigin,
  escapeHtml,
  safeEqual,
  safeNextPath,
  verifyPassword,
} from "./security.js";
import { createLogger } from "./logger.js";
import { createConfigStore } from "./config-store.js";
import { createPasswordStore } from "./password-store.js";
import { mapThemeForClient, readThemeStore, resolveActiveTheme } from "./login-theme.js";
import { createBlastDoorsStateController } from "./blastdoors-state.js";

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

  return {
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
    configStoreMode: String(env.CONFIG_STORE_MODE || "env").toLowerCase(),
    databaseFile: env.DATABASE_FILE || "data/blastdoor.sqlite",
    postgresUrl: env.POSTGRES_URL || "",
    postgresSsl: parseBoolean(env.POSTGRES_SSL, false),
    passwordStoreMode,
    passwordStoreFile: env.PASSWORD_STORE_FILE || "mock/password-store.json",
    blastDoorsClosed: parseBoolean(env.BLAST_DOORS_CLOSED, false),
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

function renderLoginPage({ error, csrfToken, nextPath, requireTotp, theme }) {
  const errorBlock = error
    ? `<p class="alert" role="alert">${escapeHtml(error)}</p>`
    : "";

  const totpField = requireTotp
    ? `<label for="totp">Authenticator Code</label>
       <input id="totp" name="totp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="123456" required />`
    : "";

  const logoMarkup = theme.logoUrl
    ? `<img class="brand-logo" src="${escapeHtml(theme.logoUrl)}" alt="${escapeHtml(theme.name || "Blastdoor logo")}" />`
    : `<span class="brand-logo-fallback">BLASTDOOR</span>`;

  const closedBgStyle = theme.closedBackgroundUrl
    ? ` style="background-image: url('${escapeHtml(theme.closedBackgroundUrl)}');"`
    : "";
  const openBgStyle = theme.openBackgroundUrl
    ? ` style="background-image: url('${escapeHtml(theme.openBackgroundUrl)}');"`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Blastdoor Access</title>
    <link rel="stylesheet" href="/assets/theme.css" />
  </head>
  <body>
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
        <form method="post" action="/login" autocomplete="off" novalidate>
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

function renderLoginSuccessPage({ nextPath, theme }) {
  const logoMarkup = theme.logoUrl
    ? `<img class="brand-logo" src="${escapeHtml(theme.logoUrl)}" alt="${escapeHtml(theme.name || "Blastdoor logo")}" />`
    : `<span class="brand-logo-fallback">BLASTDOOR</span>`;

  const closedBgStyle = theme.closedBackgroundUrl
    ? ` style="background-image: url('${escapeHtml(theme.closedBackgroundUrl)}');"`
    : "";
  const openBgStyle = theme.openBackgroundUrl
    ? ` style="background-image: url('${escapeHtml(theme.openBackgroundUrl)}');"`
    : "";
  const encodedNextPath = JSON.stringify(nextPath);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Blastdoor Access Granted</title>
    <link rel="stylesheet" href="/assets/theme.css" />
  </head>
  <body class="auth-success">
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
        <p class="intro">Transitioning to your selected world...</p>
        <p class="success-note">If redirection does not start automatically, continue below.</p>
        <p><a class="continue-link" href="${escapeHtml(nextPath)}" id="continueLink">Continue to Foundry</a></p>
      </section>
    </main>
    <script>
      const nextPath = ${encodedNextPath};
      requestAnimationFrame(() => {
        document.body.classList.add("auth-success-active");
      });
      setTimeout(() => {
        window.location.assign(nextPath);
      }, 1500);
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

export function createApp(config, options = {}) {
  validateConfig(config);
  const logger = options.logger || createNoopLogger();
  const passwordStore = options.passwordStore || createPasswordStore(config, { ...options, logger });

  if (config.requireTotp) {
    authenticator.options = { window: 1, step: 30 };
  }

  const publicDir = options.publicDir || path.join(__dirname, "..", "public");
  const graphicsDir = options.graphicsDir || path.join(__dirname, "..", "graphics");
  const themeStorePath = options.themeStorePath || path.join(graphicsDir, "themes", "themes.json");
  const runtimeStatePath = options.runtimeStatePath || path.join(process.cwd(), "data", "runtime-state.json");
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

  async function resolveLoginTheme() {
    try {
      const themeStore = await readThemeStore(themeStorePath);
      const activeTheme = resolveActiveTheme(themeStore);
      if (!activeTheme) {
        return mapThemeForClient({
          id: "",
          name: "Default",
          logoPath: "",
          closedBackgroundPath: "",
          openBackgroundPath: "",
          createdAt: "",
          updatedAt: "",
        });
      }
      return mapThemeForClient(activeTheme);
    } catch (error) {
      logger.warn("theme.load_failed", {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return mapThemeForClient({
        id: "",
        name: "Default",
        logoPath: "",
        closedBackgroundPath: "",
        openBackgroundPath: "",
        createdAt: "",
        updatedAt: "",
      });
    }
  }

  const app = express();
  if (config.trustProxy !== false) {
    app.set("trust proxy", config.trustProxy);
  }

  app.disable("x-powered-by");

  const gatewayHelmet = helmet({
    contentSecurityPolicy: false,
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
      immutable: true,
      maxAge: "1h",
    }),
  );

  const loginLimiter = rateLimit({
    windowMs: config.loginRateLimitWindowMs,
    max: config.loginRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many login attempts. Try again in 15 minutes.",
  });

  function authGuard(req, res, next) {
    if (req.session?.authenticated) {
      return next();
    }

    const nextPath = safeNextPath(req.originalUrl, "/");
    const accept = req.get("accept") || "";
    const wantsHtml = accept.includes("text/html");
    if (wantsHtml) {
      if (logger.debugEnabled) {
        logger.debug("auth.guard.redirect", collectRequestContext(req));
      }

      return res.redirect(`/login?next=${encodeURIComponent(nextPath)}`);
    }

    if (logger.debugEnabled) {
      logger.debug("auth.guard.unauthorized", collectRequestContext(req));
    }

    return res.status(401).json({ error: "Authentication required" });
  }

  app.get("/healthz", (req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/login", async (req, res) => {
    const forceReauth = parseBoolean(req.query.reauth, false);
    if (forceReauth && req.session) {
      const nextPath = safeNextPath(req.query.next, "/");
      return req.session.destroy(() => {
        res.clearCookie("blastdoor.sid");
        res.redirect(`/login?next=${encodeURIComponent(nextPath)}`);
      });
    }

    if (req.session?.authenticated) {
      const nextPath = safeNextPath(req.query.next, "/");
      if (logger.debugEnabled) {
        logger.debug("auth.login.already_authenticated", {
          ...collectRequestContext(req),
          nextPath,
        });
      }

      return res.redirect(nextPath);
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
      }),
    );
  });

  app.post("/login", loginLimiter, async (req, res) => {
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
      userRecord = await passwordStore.getUserByUsername(username);
    } catch (error) {
      logger.error("auth.login.password_store_error", {
        ...collectRequestContext(req),
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return res.status(500).send("Authentication service unavailable.");
    }

    const usernameValid = Boolean(userRecord);
    const passwordValid = userRecord ? verifyPassword(password, userRecord.passwordHash) : false;
    const effectiveTotpSecret = userRecord?.totpSecret || config.totpSecret;
    const totpValid = config.requireTotp
      ? Boolean(effectiveTotpSecret) && authenticator.check(totp, effectiveTotpSecret)
      : true;

    if (!usernameValid || !passwordValid || !totpValid) {
      if (logger.debugEnabled) {
        logger.warn("auth.login.credentials_rejected", {
          ...collectRequestContext(req),
          usernameFingerprint: fingerprintIdentifier(username),
          usernameValid,
          passwordValid,
          totpValid,
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
        }),
      );
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
          return res.redirect(nextPath);
        }

        return resolveLoginTheme()
          .then((theme) => {
            res.set("cache-control", "no-store");
            res.status(200).send(
              renderLoginSuccessPage({
                nextPath,
                theme,
              }),
            );
          })
          .catch(() => {
            res.redirect(nextPath);
          });
      });
    });
  });

  function clearSession(req, res) {
    req.session.destroy(() => {
      if (logger.debugEnabled) {
        logger.info("auth.logout", collectRequestContext(req));
      }

      res.clearCookie("blastdoor.sid");
      res.redirect("/login");
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

  return { app, proxy, sessionMiddleware, passwordStore, blastDoorsStateController, runtimeStatePath };
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

  const { app, proxy, sessionMiddleware, passwordStore, blastDoorsStateController, runtimeStatePath } = createApp(
    config,
    { ...options, logger },
  );
  const configStore = options.configStore || createConfigStore(config, options);

  void persistConfigSnapshot(config, configStore, logger);
  const server = app.listen(config.port, config.host, () => {
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
      allowNullOrigin: Boolean(config.allowNullOrigin),
      blastDoorsClosed: Boolean(config.blastDoorsClosed),
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
    if (typeof passwordStore?.close === "function") {
      Promise.resolve(passwordStore.close()).catch((error) => {
        logger.warn("password_store.close_failed", {
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
    BLAST_DOORS_CLOSED: String(Boolean(config.blastDoorsClosed)),
    DEBUG_MODE: String(Boolean(config.debugMode)),
    DEBUG_LOG_FILE: String(config.debugLogFile || ""),
  };

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
  const config = loadConfigFromEnv();
  createServer(config);
}
