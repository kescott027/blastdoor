import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantClient, loadAssistantRuntimeConfig } from "./assistant-client.js";

const __filename = fileURLToPath(import.meta.url);

function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

function createAssistantAuthMiddleware(token) {
  if (!token) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const headerToken = normalizeString(req.get("x-assistant-token"), "");
    if (headerToken && headerToken === token) {
      next();
      return;
    }
    res.status(401).json({ error: "Unauthorized assistant request." });
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

export function createAssistantApp(options = {}) {
  const config = {
    ...loadAssistantRuntimeConfig(options.env || process.env),
    ...(options.config && typeof options.config === "object" ? options.config : {}),
  };
  const token = normalizeString(options.token ?? config.assistantToken, "");
  const assistant = options.assistant || createAssistantClient({ config, forceLocal: true });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  const writeLimiter = rateLimit({
    windowMs: Number.parseInt(process.env.ASSISTANT_RATE_LIMIT_WINDOW_MS || "60000", 10),
    max: Number.parseInt(process.env.ASSISTANT_RATE_LIMIT_MAX || "120", 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many assistant requests. Try again shortly.",
  });

  const auth = createAssistantAuthMiddleware(token);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.post(
    "/v1/status",
    auth,
    writeLimiter,
    asyncHandler(async (_req, res) => {
      const status = await assistant.getStatus();
      res.json({ ok: true, status });
    }),
  );

  app.post(
    "/v1/workflows/config-recommendations",
    auth,
    writeLimiter,
    asyncHandler(async (req, res) => {
      const result = await assistant.runConfigRecommendations(req.body || {});
      res.json({ ok: true, result });
    }),
  );

  app.post(
    "/v1/workflows/troubleshoot-recommendation",
    auth,
    writeLimiter,
    asyncHandler(async (req, res) => {
      const result = await assistant.runTroubleshootRecommendation(req.body || {});
      res.json({ ok: true, result });
    }),
  );

  app.post(
    "/v1/workflows/threat-monitor",
    auth,
    writeLimiter,
    asyncHandler(async (req, res) => {
      const result = await assistant.runThreatMonitor(req.body || {});
      res.json({ ok: true, result });
    }),
  );

  app.post(
    "/v1/workflows/grimoire",
    auth,
    writeLimiter,
    asyncHandler(async (req, res) => {
      const result = await assistant.runGrimoireWorkflow(req.body || {});
      res.json({ ok: true, result });
    }),
  );

  app.post(
    "/v1/workflows/chat",
    auth,
    writeLimiter,
    asyncHandler(async (req, res) => {
      const result = await assistant.runWorkflowChat(req.body || {});
      res.json({ ok: true, result });
    }),
  );

  return { app, assistant };
}

export function createAssistantServer(options = {}) {
  const host = options.host || process.env.ASSISTANT_HOST || "127.0.0.1";
  const port = Number.isInteger(options.port)
    ? options.port
    : Number.parseInt(process.env.ASSISTANT_PORT || "8060", 10);
  const { app, assistant } = createAssistantApp(options);
  const server = app.listen(port, host, () => {
    if (!options.silent) {
      console.log(`Blastdoor Assistant available at http://${host}:${port}`);
    }
  });

  server.on("close", () => {
    if (typeof assistant?.close === "function") {
      Promise.resolve(assistant.close()).catch(() => {});
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
  process.title = "blastdoor-assistant";
  createAssistantServer();
}
