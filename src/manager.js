import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createPasswordHash } from "./security.js";
import { validateConfig, loadConfigFromEnv } from "./server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_MANAGER_HOST = process.env.MANAGER_HOST || "127.0.0.1";
const DEFAULT_MANAGER_PORT = Number.parseInt(process.env.MANAGER_PORT || "8090", 10);

const CONFIG_FIELDS = [
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
  "DEBUG_MODE",
  "DEBUG_LOG_FILE",
];

const CONFIG_DEFAULTS = {
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
  DEBUG_MODE: "true",
  DEBUG_LOG_FILE: "logs/blastdoor-debug.log",
};

const SENSITIVE_CONFIG_KEYS = new Set(["AUTH_PASSWORD_HASH", "SESSION_SECRET", "TOTP_SECRET"]);
const REDACTED_MARKER = "[REDACTED]";

function formatEnvValue(value) {
  if (value === "") {
    return "";
  }

  if (/^[A-Za-z0-9_./,:@+-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value).trim();
}

function parseBodyConfig(body) {
  const output = {};
  for (const key of CONFIG_FIELDS) {
    if (key === "AUTH_PASSWORD_HASH") {
      continue;
    }

    output[key] = normalizeString(body[key], CONFIG_DEFAULTS[key] ?? "");
  }

  return output;
}

function scrubConfigForClient(config) {
  return {
    ...config,
    AUTH_PASSWORD_HASH: "",
    SESSION_SECRET: config.SESSION_SECRET ? "********" : "",
    TOTP_SECRET: config.TOTP_SECRET ? "********" : "",
    hasAuthPasswordHash: Boolean(config.AUTH_PASSWORD_HASH),
  };
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
  const usesPostgres = config.PASSWORD_STORE_MODE === "postgres" || config.CONFIG_STORE_MODE === "postgres";
  const usesSqlite = config.PASSWORD_STORE_MODE === "sqlite" || config.CONFIG_STORE_MODE === "sqlite";
  const backend = usesPostgres ? "postgres" : usesSqlite ? "sqlite" : "env/file";

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
    `Debug Mode: ${config.DEBUG_MODE || "false"} (log: ${config.DEBUG_LOG_FILE || "unset"})`,
    `Manager UI: http://${env.managerHost || DEFAULT_MANAGER_HOST}:${env.managerPort || DEFAULT_MANAGER_PORT}/manager/`,
    `Runtime: ${env.platform || "unknown"} ${env.arch || "unknown"}, Node ${env.nodeVersion || "unknown"}${env.isWsl ? `, WSL (${env.wslDistro || "unknown"})` : ""}`,
    "Redactions: AUTH_PASSWORD_HASH, SESSION_SECRET, TOTP_SECRET, POSTGRES_URL credentials",
  ];

  return lines.join("\n");
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

export function createManagerApp(options = {}) {
  const workspaceDir = path.resolve(options.workspaceDir || path.join(__dirname, ".."));
  const envPath = options.envPath || path.join(workspaceDir, ".env");
  const managerDir = options.managerDir || path.join(workspaceDir, "public", "manager");
  const processFactory = options.processFactory || spawn;
  const processState = createProcessState({ workspaceDir, processFactory });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use("/manager", express.static(managerDir, { etag: true, maxAge: "1h" }));

  app.get("/", (_req, res) => {
    res.redirect("/manager/");
  });

  app.get("/api/config", async (_req, res) => {
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

  app.post("/api/config", async (req, res) => {
    try {
      const existing = await readEnvConfig(envPath);
      const incoming = parseBodyConfig(req.body || {});

      const passwordInput = normalizeString(req.body?.AUTH_PASSWORD || "");
      if (passwordInput.length > 0) {
        incoming.AUTH_PASSWORD_HASH = createPasswordHash(passwordInput);
      } else {
        incoming.AUTH_PASSWORD_HASH = existing.AUTH_PASSWORD_HASH || "";
      }

      if (incoming.SESSION_SECRET === "********") {
        incoming.SESSION_SECRET = existing.SESSION_SECRET || "";
      }
      if (incoming.TOTP_SECRET === "********") {
        incoming.TOTP_SECRET = existing.TOTP_SECRET || "";
      }

      validateConfig(loadConfigFromEnv({ ...incoming }));
      await writeEnvConfig(envPath, incoming);
      res.json({
        ok: true,
        config: scrubConfigForClient({ ...existing, ...incoming }),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/start", async (_req, res) => {
    try {
      const status = await processState.start();
      res.json({ ok: true, status });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/stop", async (_req, res) => {
    try {
      const status = await processState.stop();
      res.json({ ok: true, status });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/restart", async (_req, res) => {
    try {
      await processState.stop();
      const status = await processState.start();
      res.json({ ok: true, status });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/monitor", async (_req, res) => {
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

  app.get("/api/diagnostics", async (_req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const serviceStatus = processState.getStatus();
      const health = await checkBlastdoorHealth(config);
      const environment = detectEnvironmentInfo({ workspaceDir, envPath });
      const diagnosticsConfig = sanitizeConfigForDiagnostics(config);

      const report = {
        generatedAt: new Date().toISOString(),
        serviceStatus,
        health,
        environment,
        config: diagnosticsConfig,
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

  return { app, envPath };
}

export function createManagerServer(options = {}) {
  const host = options.host || DEFAULT_MANAGER_HOST;
  const port = Number.isInteger(options.port) ? options.port : DEFAULT_MANAGER_PORT;
  const { app } = createManagerApp(options);

  return app.listen(port, host, () => {
    if (!options.silent) {
      console.log(`Blastdoor Manager available at http://${host}:${port}/manager/`);
    }
  });
}

function isEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }

  return path.resolve(process.argv[1]) === __filename;
}

if (isEntrypoint()) {
  createManagerServer();
}
