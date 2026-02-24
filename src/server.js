import "dotenv/config";
import express from "express";
import helmet from "helmet";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { createProxyMiddleware } from "http-proxy-middleware";
import { authenticator } from "otplib";
import { createHash, randomUUID } from "node:crypto";
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
import { createPasswordStore } from "./password-store.js";

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
    passwordStoreMode,
    passwordStoreFile: env.PASSWORD_STORE_FILE || "mock/password-store.json",
  };
}

export function validateConfig(config) {
  const passwordStoreMode = String(config.passwordStoreMode || "env").toLowerCase();
  if (!["env", "file"].includes(passwordStoreMode)) {
    throw new Error("PASSWORD_STORE_MODE must be either 'env' or 'file'.");
  }

  if (passwordStoreMode === "env") {
    if (!config.authUsername || !config.authPasswordHash) {
      throw new Error("AUTH_USERNAME and AUTH_PASSWORD_HASH are required when PASSWORD_STORE_MODE=env.");
    }
  } else if (!config.passwordStoreFile) {
    throw new Error("PASSWORD_STORE_FILE is required when PASSWORD_STORE_MODE=file.");
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

  if (config.requireTotp && !config.totpSecret && passwordStoreMode !== "file") {
    throw new Error("TOTP_SECRET is required when REQUIRE_TOTP=true.");
  }

  try {
    new URL(config.foundryTarget);
  } catch {
    throw new Error("FOUNDRY_TARGET must be a full URL like http://127.0.0.1:30000");
  }
}

function renderLoginPage({ error, csrfToken, nextPath, requireTotp }) {
  const errorBlock = error
    ? `<p class="alert" role="alert">${escapeHtml(error)}</p>`
    : "";

  const totpField = requireTotp
    ? `<label for="totp">Authenticator Code</label>
       <input id="totp" name="totp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="123456" required />`
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
  const passwordStore = options.passwordStore || createPasswordStore(config, { logger });

  if (config.requireTotp) {
    authenticator.options = { window: 1, step: 30 };
  }

  const publicDir = options.publicDir || path.join(__dirname, "..", "public");

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

  app.get("/login", (req, res) => {
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
    res.set("cache-control", "no-store");
    return res.status(200).send(
      renderLoginPage({
        error: "",
        csrfToken: req.session.loginCsrf,
        nextPath,
        requireTotp: config.requireTotp,
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

      req.session.loginCsrf = createCsrfToken();
      res.set("cache-control", "no-store");
      return res.status(401).send(
        renderLoginPage({
          error: "Access denied. Check your credentials and code.",
          csrfToken: req.session.loginCsrf,
          nextPath,
          requireTotp: config.requireTotp,
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

        return res.redirect(nextPath);
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
    onError(err, req, res) {
      logger.error("proxy.http_error", {
        requestId: req.requestId || null,
        path: req.url || null,
        target: config.foundryTarget,
        error: {
          name: err.name,
          message: err.message,
        },
      });

      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
      }

      res.end(`Gateway error: ${err.message}`);
    },
  });

  app.use(authGuard);
  app.use("/", proxy);

  return { app, proxy, sessionMiddleware, passwordStore };
}

export function attachWebsocketAuth(server, sessionMiddleware, proxy, logger = createNoopLogger()) {
  server.on("upgrade", (req, socket, head) => {
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
  });
}

export function createServer(config, options = {}) {
  const logger = options.logger || createLogger({
    debugEnabled: Boolean(config.debugMode),
    logFile: config.debugLogFile || "logs/blastdoor-debug.log",
  });

  const { app, proxy, sessionMiddleware } = createApp(config, { ...options, logger });
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
      allowNullOrigin: Boolean(config.allowNullOrigin),
      debugMode: Boolean(config.debugMode),
      debugLogFile: config.debugLogFile || null,
    });
  });

  attachWebsocketAuth(server, sessionMiddleware, proxy, logger);
  server.on("close", () => logger.close());
  return server;
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
