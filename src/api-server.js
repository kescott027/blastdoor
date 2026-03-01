import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBlastdoorApi, createLocalBlastdoorApi, loadBlastdoorApiRuntimeConfig } from "./blastdoor-api.js";
import { createPluginManager } from "./plugins/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_API_HOST = process.env.BLASTDOOR_API_HOST || "127.0.0.1";
const DEFAULT_API_PORT = Number.parseInt(process.env.BLASTDOOR_API_PORT || "8070", 10);
const DEFAULT_API_TOKEN = String(process.env.BLASTDOOR_API_TOKEN || "").trim();

function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

function createApiAuthMiddleware(token) {
  if (!token) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const headerToken = normalizeString(req.get("x-blastdoor-api-token"), "");
    if (headerToken && headerToken === token) {
      next();
      return;
    }
    res.status(401).json({ error: "Unauthorized blastdoor-api request." });
  };
}

function asyncHandler(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
}

export function createBlastdoorApiApp(options = {}) {
  const workspaceDir = path.resolve(options.workspaceDir || path.join(__dirname, ".."));
  const graphicsDir = options.graphicsDir || path.join(workspaceDir, "graphics");
  const themeStorePath = options.themeStorePath || path.join(graphicsDir, "themes", "themes.json");
  const userProfileStorePath = options.userProfileStorePath || path.join(workspaceDir, "data", "user-profiles.json");
  const config = options.config || loadBlastdoorApiRuntimeConfig(options.env || process.env);
  const token = normalizeString(options.token ?? config.blastdoorApiToken ?? DEFAULT_API_TOKEN, "");
  const postgresPoolFactory = options.postgresPoolFactory;
  const pluginManager = options.pluginManager || createPluginManager({ env: options.env || process.env });

  const api =
    options.api ||
    createLocalBlastdoorApi({
      config,
      graphicsDir,
      themeStorePath,
      userProfileStorePath,
      postgresPoolFactory,
    });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));

  const apiWriteLimiter = rateLimit({
    windowMs: Number.parseInt(process.env.BLASTDOOR_API_RATE_LIMIT_WINDOW_MS || "60000", 10),
    max: Number.parseInt(process.env.BLASTDOOR_API_RATE_LIMIT_MAX || "180", 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many blastdoor-api requests. Try again shortly.",
  });

  const authMiddleware = createApiAuthMiddleware(token);
  const registerRead = (routePath, handler) => {
    app.get(routePath, authMiddleware, asyncHandler(handler));
  };
  const registerWrite = (routePath, handler) => {
    app.post(routePath, authMiddleware, apiWriteLimiter, asyncHandler(handler));
  };

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  registerWrite("/internal/users/credential/get", async (req, res) => {
    const username = normalizeString(req.body?.username, "");
    const user = await api.getUserCredential(username);
    res.json({ ok: true, user });
  });

  registerRead("/internal/users/credentials", async (_req, res) => {
    const users = await api.listCredentialUsers();
    res.json({ ok: true, users });
  });

  registerWrite("/internal/users/credential/upsert", async (req, res) => {
    const record = req.body?.record;
    if (!record || typeof record !== "object") {
      throw new Error("record is required.");
    }
    const user = await api.upsertCredentialUser(record);
    res.json({ ok: true, user });
  });

  registerWrite("/internal/users/profiles/list", async (req, res) => {
    const optionsArg = req.body?.options && typeof req.body.options === "object" ? req.body.options : {};
    const profiles = await api.listUserProfiles(optionsArg);
    res.json({ ok: true, profiles });
  });

  registerWrite("/internal/users/profile/get", async (req, res) => {
    const username = normalizeString(req.body?.username, "");
    const optionsArg = req.body?.options && typeof req.body.options === "object" ? req.body.options : {};
    const profile = await api.getUserProfile(username, optionsArg);
    res.json({ ok: true, profile });
  });

  registerWrite("/internal/users/profile/get-raw", async (req, res) => {
    const username = normalizeString(req.body?.username, "");
    const profile = await api.getRawUserProfile(username);
    res.json({ ok: true, profile });
  });

  registerWrite("/internal/users/profile/upsert", async (req, res) => {
    const profileArg = req.body?.profile;
    if (!profileArg || typeof profileArg !== "object") {
      throw new Error("profile is required.");
    }
    const profile = await api.upsertUserProfile(profileArg);
    res.json({ ok: true, profile });
  });

  registerWrite("/internal/users/profile/record-login", async (req, res) => {
    const username = normalizeString(req.body?.username, "");
    const ipAddress = normalizeString(req.body?.ipAddress, "");
    const profile = await api.recordSuccessfulLogin(username, ipAddress);
    res.json({ ok: true, profile });
  });

  registerWrite("/internal/users/profile/issue-temp-code", async (req, res) => {
    const username = normalizeString(req.body?.username, "");
    const optionsArg = req.body?.options && typeof req.body.options === "object" ? req.body.options : {};
    const issued = await api.issueTemporaryLoginCode(username, optionsArg);
    res.json({ ok: true, issued });
  });

  registerWrite("/internal/users/profile/verify-temp-code", async (req, res) => {
    const username = normalizeString(req.body?.username, "");
    const code = normalizeString(req.body?.code, "");
    const optionsArg = req.body?.options && typeof req.body.options === "object" ? req.body.options : {};
    const valid = await api.verifyTemporaryLoginCode(username, code, optionsArg);
    res.json({ ok: true, valid });
  });

  registerWrite("/internal/users/profile/invalidate-sessions", async (req, res) => {
    const username = normalizeString(req.body?.username, "");
    const profile = await api.invalidateUserSessions(username);
    res.json({ ok: true, profile });
  });

  registerRead("/internal/themes/active", async (_req, res) => {
    const theme = await api.getActiveTheme();
    res.json({ ok: true, theme });
  });

  registerRead("/internal/themes/store", async (_req, res) => {
    const store = await api.readThemeStore();
    res.json({ ok: true, store });
  });

  registerWrite("/internal/themes/store/write", async (req, res) => {
    const store = req.body?.store;
    if (!store || typeof store !== "object") {
      throw new Error("store payload is required.");
    }
    const updated = await api.writeThemeStore(store);
    res.json({ ok: true, store: updated });
  });

  registerRead("/internal/themes/assets", async (_req, res) => {
    const assets = await api.listThemeAssets();
    res.json({ ok: true, assets });
  });

  pluginManager.registerApiServerRoutes({
    registerRead,
    registerWrite,
    api,
  });

  return { app, api };
}

export function createBlastdoorApiServer(options = {}) {
  const host = options.host || DEFAULT_API_HOST;
  const port = Number.isInteger(options.port) ? options.port : DEFAULT_API_PORT;
  const { app, api } = createBlastdoorApiApp(options);
  const server = app.listen(port, host, () => {
    if (!options.silent) {
      console.log(`Blastdoor API available at http://${host}:${port}`);
    }
  });

  server.on("close", () => {
    if (typeof api?.close === "function") {
      Promise.resolve(api.close()).catch(() => {});
    }
  });

  return server;
}

function isEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }

  return path.resolve(process.argv[1]) === __filename;
}

if (isEntrypoint()) {
  process.title = "blastdoor-api";
  createBlastdoorApiServer();
}

export { createBlastdoorApi };
