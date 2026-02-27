import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createPasswordHash } from "./security.js";
import { validateConfig, loadConfigFromEnv, detectSelfProxyTarget } from "./server.js";
import { writeBlastDoorsState } from "./blastdoors-state.js";
import {
  createThemeId,
  listThemeAssets,
  mapThemeForClient,
  normalizeThemeAssetPath,
  readThemeStore,
  writeThemeStore,
} from "./login-theme.js";

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
  "BLAST_DOORS_CLOSED",
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
  BLAST_DOORS_CLOSED: "false",
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

function createSessionSecret() {
  return randomBytes(48).toString("base64url");
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

function normalizeThemeName(value) {
  return String(value || "").trim();
}

function parseBooleanLikeBody(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function validateThemeAssetSelection(
  { themeName, logoPath, closedBackgroundPath, openBackgroundPath },
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

  return {
    name,
    logoPath: logoSelection,
    closedBackgroundPath: closedSelection,
    openBackgroundPath: openSelection,
  };
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

  checks.push({
    id: "network.bind-address",
    title: "Gateway bind address",
    status: config.HOST === "0.0.0.0" ? "ok" : "warn",
    detail:
      config.HOST === "0.0.0.0"
        ? "Gateway is listening on all interfaces."
        : `Gateway is bound to ${config.HOST}. LAN access may fail unless HOST=0.0.0.0.`,
    recommendation: config.HOST === "0.0.0.0" ? null : "Set HOST=0.0.0.0 and restart Blastdoor.",
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

function createTroubleshootReport({ config, health, foundryHealth, environment, serviceStatus }) {
  return {
    generatedAt: new Date().toISOString(),
    serviceStatus,
    environment,
    checks: createTroubleshootChecks({ config, health, foundryHealth, environment }),
    safeActions: buildSafeActions(environment),
    guidedActions: buildGuidedActions({ environment, config }),
  };
}

export function createManagerApp(options = {}) {
  const workspaceDir = path.resolve(options.workspaceDir || path.join(__dirname, ".."));
  const envPath = options.envPath || path.join(workspaceDir, ".env");
  const runtimeStatePath = options.runtimeStatePath || path.join(workspaceDir, "data", "runtime-state.json");
  const managerDir = options.managerDir || path.join(workspaceDir, "public", "manager");
  const graphicsDir = options.graphicsDir || path.join(workspaceDir, "graphics");
  const themeStorePath = options.themeStorePath || path.join(graphicsDir, "themes", "themes.json");
  const processFactory = options.processFactory || spawn;
  const commandRunner = options.commandRunner || runDiagnosticCommand;
  const processState = createProcessState({ workspaceDir, processFactory });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use("/manager", express.static(managerDir, { etag: true, maxAge: "1h" }));
  app.use(
    "/graphics",
    express.static(graphicsDir, {
      etag: true,
      maxAge: "1h",
    }),
  );

  const registerApiGet = (routePath, handler) => {
    app.get(`/api${routePath}`, handler);
    app.get(`/manager/api${routePath}`, handler);
  };

  const registerApiPost = (routePath, handler) => {
    app.post(`/api${routePath}`, handler);
    app.post(`/manager/api${routePath}`, handler);
  };

  app.get("/", (_req, res) => {
    res.redirect("/manager/");
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
        },
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/start", async (_req, res) => {
    try {
      const status = await processState.start();
      res.json({ ok: true, status });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
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
      await processState.stop();
      const status = await processState.start();
      res.json({ ok: true, status });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
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
      const [store, assets] = await Promise.all([readThemeStore(themeStorePath), listThemeAssets(graphicsDir)]);
      res.json({
        ok: true,
        activeThemeId: store.activeThemeId || "",
        themes: (store.themes || []).map(mapThemeForClient),
        assets,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/themes/create", async (req, res) => {
    try {
      const assets = await listThemeAssets(graphicsDir);
      const validated = validateThemeAssetSelection(
        {
          themeName: req.body?.name,
          logoPath: req.body?.logoPath,
          closedBackgroundPath: req.body?.closedBackgroundPath,
          openBackgroundPath: req.body?.openBackgroundPath,
        },
        assets,
      );
      const makeActive = parseBooleanLikeBody(req.body?.makeActive);

      const store = await readThemeStore(themeStorePath);
      const existingIds = new Set((store.themes || []).map((theme) => theme.id));
      const id = createThemeId(validated.name, existingIds);
      const now = new Date().toISOString();
      const createdTheme = {
        id,
        name: validated.name,
        logoPath: validated.logoPath,
        closedBackgroundPath: validated.closedBackgroundPath,
        openBackgroundPath: validated.openBackgroundPath,
        createdAt: now,
        updatedAt: now,
      };

      const nextThemes = [...(store.themes || []), createdTheme];
      const nextActiveThemeId = makeActive || !store.activeThemeId ? createdTheme.id : store.activeThemeId;
      const updatedStore = await writeThemeStore(themeStorePath, {
        activeThemeId: nextActiveThemeId,
        themes: nextThemes,
      });

      res.json({
        ok: true,
        activeThemeId: updatedStore.activeThemeId || "",
        createdTheme: mapThemeForClient(createdTheme),
        themes: (updatedStore.themes || []).map(mapThemeForClient),
        assets,
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

      const assets = await listThemeAssets(graphicsDir);
      const validated = validateThemeAssetSelection(
        {
          themeName: req.body?.name,
          logoPath: req.body?.logoPath,
          closedBackgroundPath: req.body?.closedBackgroundPath,
          openBackgroundPath: req.body?.openBackgroundPath,
        },
        assets,
        { requireClosedBackground: false },
      );
      const makeActive = parseBooleanLikeBody(req.body?.makeActive);

      const store = await readThemeStore(themeStorePath);
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
        updatedAt: now,
      };

      const nextThemes = [...(store.themes || [])];
      nextThemes[themeIndex] = updatedTheme;
      const nextActiveThemeId = makeActive ? themeId : store.activeThemeId;
      const updatedStore = await writeThemeStore(themeStorePath, {
        activeThemeId: nextActiveThemeId,
        themes: nextThemes,
      });

      res.json({
        ok: true,
        activeThemeId: updatedStore.activeThemeId || "",
        updatedTheme: mapThemeForClient(updatedTheme),
        themes: (updatedStore.themes || []).map(mapThemeForClient),
        assets,
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

      const [store, assets] = await Promise.all([readThemeStore(themeStorePath), listThemeAssets(graphicsDir)]);
      const selectedTheme = (store.themes || []).find((theme) => theme.id === themeId);
      if (!selectedTheme) {
        throw new Error("Requested theme was not found.");
      }

      const updatedStore = await writeThemeStore(themeStorePath, {
        activeThemeId: themeId,
        themes: store.themes || [],
      });

      res.json({
        ok: true,
        activeThemeId: updatedStore.activeThemeId || "",
        activeTheme: mapThemeForClient(selectedTheme),
        themes: (updatedStore.themes || []).map(mapThemeForClient),
        assets,
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

  registerApiGet("/troubleshoot", async (_req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const serviceStatus = processState.getStatus();
      const [health, foundryHealth] = await Promise.all([checkBlastdoorHealth(config), checkFoundryTargetHealth(config)]);
      const environment = detectEnvironmentInfo({ workspaceDir, envPath });
      const report = createTroubleshootReport({ config, health, foundryHealth, environment, serviceStatus });

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
  createManagerServer();
}
