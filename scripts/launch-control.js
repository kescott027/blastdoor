#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const WORKSPACE_DIR = process.cwd();
const ENV_PATH = path.join(WORKSPACE_DIR, ".env");
const MANAGER_HOST = process.env.MANAGER_HOST || "127.0.0.1";
const MANAGER_PORT = Number.parseInt(process.env.MANAGER_PORT || "8090", 10);
const MANAGER_URL = `http://${MANAGER_HOST}:${MANAGER_PORT}`;
const DEBUG_CONTROLS_REFRESH_MS = 15000;
const API_BASE_CANDIDATES = ["/api", "/manager/api"];
const WATCH_IGNORE_PREFIXES = [".git/", "node_modules/", "logs/", "data/"];
process.title = "blastdoor-launch-console";

const state = {
  shuttingDown: false,
  managerChild: null,
  ownsManager: false,
  managerRestartInProgress: false,
  managerStopInProgress: false,
  actionInFlight: false,
  debugStreaming: false,
  debugInterval: null,
  footerInterval: null,
  watcher: null,
  prevRuntimeLines: [],
  prevDebugLines: [],
  lastChangeNoticeAt: 0,
  lastControlsSnapshot: "",
  keypressHandler: null,
};

function line(message = "") {
  process.stdout.write(`${message}\n`);
}

function info(message) {
  line(`[launch] ${message}`);
}

function warn(message) {
  line(`[launch] WARN: ${message}`);
}

function error(message) {
  line(`[launch] ERROR: ${message}`);
}

function printBanner() {
  line("");
  line("Blastdoor Interactive Launch Console");
  line(`Manager URL: ${MANAGER_URL}/manager/`);
  line("");
}

function printControls() {
  line("Controls:");
  line("  X - Exit cleanly");
  line("  R - Restart Blastdoor service");
  line("  S - Start Admin panel service only");
  line("  T - Stop Admin panel service only");
  line("  M - Restart Admin panel service only");
  line(`  D - Debug console stream (${state.debugStreaming ? "ON" : "OFF"})`);
  line("  L - LOCK BLAST DOORS");
  line("  U - UNLOCK BLAST DOORS");
  line("  A - Open Admin panel");
  line("  ? - Show controls");
  line("");
}

function controlsSnapshot() {
  return JSON.stringify({
    debugStreaming: state.debugStreaming,
    managerRunning: Boolean(state.managerChild),
    ownsManager: Boolean(state.ownsManager),
  });
}

function renderControlsIfChanged(force = false) {
  const snapshot = controlsSnapshot();
  if (!force && snapshot === state.lastControlsSnapshot) {
    return;
  }
  state.lastControlsSnapshot = snapshot;
  printControls();
}

function toBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function shouldIgnoreWatchPath(filePath) {
  if (!filePath) {
    return true;
  }

  const normalized = String(filePath).replaceAll("\\", "/");
  return WATCH_IGNORE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function diffTail(previousLines, currentLines) {
  const prev = Array.isArray(previousLines) ? previousLines : [];
  const curr = Array.isArray(currentLines) ? currentLines : [];
  const maxOverlap = Math.min(prev.length, curr.length);

  for (let overlap = maxOverlap; overlap >= 0; overlap -= 1) {
    let same = true;
    for (let index = 0; index < overlap; index += 1) {
      if (prev[prev.length - overlap + index] !== curr[index]) {
        same = false;
        break;
      }
    }

    if (same) {
      return curr.slice(overlap);
    }
  }

  return curr;
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(timeoutMessage);
    }),
  ]);
}

function streamPrefixed(label, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .map((entry) => entry.trimEnd())
    .filter((entry) => entry.length > 0);

  for (const entry of lines) {
    line(`[${label}] ${entry}`);
  }
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
      });
    } catch (spawnError) {
      reject(spawnError);
      return;
    }

    child.once("error", (errorEvent) => {
      reject(errorEvent);
    });

    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function buildAdminLaunchCommands(url) {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return [
      {
        label: "powershell.exe",
        command: "powershell.exe",
        args: ["-NoProfile", "-Command", `Start-Process '${url}'`],
      },
      {
        label: "Windows PowerShell absolute path",
        command: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        args: ["-NoProfile", "-Command", `Start-Process '${url}'`],
      },
      {
        label: "cmd.exe",
        command: "cmd.exe",
        args: ["/c", "start", "", url],
      },
      {
        label: "cmd.exe absolute path",
        command: "/mnt/c/Windows/System32/cmd.exe",
        args: ["/c", "start", "", url],
      },
    ];
  }

  if (process.platform === "darwin") {
    return [{ label: "open", command: "open", args: [url] }];
  }

  if (process.platform === "win32") {
    return [{ label: "cmd", command: "cmd", args: ["/c", "start", "", url] }];
  }

  return [{ label: "xdg-open", command: "xdg-open", args: [url] }];
}

function renderAdminLaunchHint(url, lastError) {
  const prefix = `Could not auto-open browser. Open manually: ${url}`;
  if (!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)) {
    return `${prefix}.`;
  }

  const reason = lastError?.code || lastError?.message || "unknown error";
  return `${prefix}. WSL detected and Windows launcher was unavailable (${reason}). Verify Windows interop and PATH for powershell.exe/cmd.exe.`;
}

async function apiRequest(method, routePath, body = null) {
  let lastError = null;
  for (let index = 0; index < API_BASE_CANDIDATES.length; index += 1) {
    const base = API_BASE_CANDIDATES[index];
    const hasFallback = index < API_BASE_CANDIDATES.length - 1;
    const url = `${MANAGER_URL}${base}${routePath}`;

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const rawBody = await response.text();
      let payload = {};
      if (rawBody) {
        try {
          payload = JSON.parse(rawBody);
        } catch {
          if (hasFallback && response.status === 404) {
            continue;
          }

          throw new Error(`Unexpected response from ${url} (${response.status})`);
        }
      }

      if (!response.ok) {
        if (hasFallback && response.status === 404) {
          continue;
        }

        throw new Error(payload.error || `Request failed (${response.status})`);
      }

      return payload;
    } catch (requestError) {
      lastError = requestError;
      if (hasFallback && requestError instanceof TypeError) {
        continue;
      }
    }
  }

  throw lastError || new Error(`API request failed for ${routePath}`);
}

async function managerReachable() {
  try {
    await withTimeout(apiRequest("GET", "/monitor"), 1000, "manager probe timeout");
    return true;
  } catch {
    return false;
  }
}

async function waitForManagerReady(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await managerReachable()) {
      return;
    }

    if (state.managerChild && state.managerChild.exitCode !== null) {
      throw new Error(`Manager process exited with code ${state.managerChild.exitCode}.`);
    }

    await delay(300);
  }

  throw new Error(`Manager did not become ready within ${timeoutMs}ms.`);
}

function startManagerProcess() {
  const child = spawn(process.execPath, ["src/manager.js"], {
    cwd: WORKSPACE_DIR,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  state.managerChild = child;
  state.ownsManager = true;
  renderControlsIfChanged();
  child.stdout?.on("data", (chunk) => streamPrefixed("manager", chunk));
  child.stderr?.on("data", (chunk) => streamPrefixed("manager", chunk));
  child.on("exit", (code, signal) => {
    line(`[manager] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    state.managerChild = null;
    renderControlsIfChanged();
    if (!state.shuttingDown && !state.managerRestartInProgress && !state.managerStopInProgress) {
      error("Manager exited unexpectedly.");
      void shutdown(1);
    }
  });
}

async function stopManagerProcess() {
  const child = state.managerChild;
  if (!child) {
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish();
    }, 5000);

    child.once("exit", () => {
      clearTimeout(timeout);
      finish();
    });

    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timeout);
      finish();
    }
  });
}

async function restartManagerOnly() {
  if (!state.ownsManager) {
    warn("Cannot restart manager from this console because it is an external instance. Restart it directly with make manager-launch.");
    return;
  }

  state.managerRestartInProgress = true;
  try {
    await stopManagerProcess();
    startManagerProcess();
    await waitForManagerReady();
    info("Admin panel service restarted.");
  } finally {
    state.managerRestartInProgress = false;
    renderControlsIfChanged();
  }
}

async function startManagerOnly() {
  if (state.managerChild) {
    info("Admin panel service is already running under this launch console.");
    return;
  }

  if (await managerReachable()) {
    info("Admin panel service is already running (external process).");
    state.ownsManager = false;
    renderControlsIfChanged();
    return;
  }

  info("Starting Admin panel service...");
  startManagerProcess();
  await waitForManagerReady();
  info("Admin panel service started.");
  renderControlsIfChanged();
}

async function stopManagerOnly() {
  if (!state.managerChild) {
    if (await managerReachable()) {
      warn("Cannot stop admin panel from this console because it is an external instance.");
      return;
    }

    info("Admin panel service is already stopped.");
    return;
  }

  if (!state.ownsManager) {
    warn("Cannot stop admin panel from this console because it is an external instance.");
    return;
  }

  state.managerStopInProgress = true;
  try {
    await stopManagerProcess();
    info("Admin panel service stopped.");
  } finally {
    state.managerStopInProgress = false;
    renderControlsIfChanged();
  }
}

async function getConfig() {
  const result = await apiRequest("GET", "/config");
  return result.config || {};
}

async function saveConfigPatch(patch) {
  const config = { ...(await getConfig()) };
  delete config.hasAuthPasswordHash;
  config.AUTH_PASSWORD = "";
  for (const [key, value] of Object.entries(patch)) {
    config[key] = String(value);
  }
  return await apiRequest("POST", "/config", config);
}

async function setBlastDoors(closed) {
  const result = await saveConfigPatch({ BLAST_DOORS_CLOSED: closed ? "true" : "false" });
  const restarted = Boolean(result?.runtime?.serviceRestarted);
  const sessionSecretRotated = Boolean(result?.runtime?.sessionSecretRotated);
  if (closed) {
    info(
      restarted
        ? sessionSecretRotated
          ? "Blast doors are now LOCKED. Gateway restarted, lockout is active, and all sessions were invalidated."
          : "Blast doors are now LOCKED. Gateway restarted and lockout is active."
        : sessionSecretRotated
          ? "Blast doors are now LOCKED and all sessions were invalidated. Restart gateway service to enforce lockout."
          : "Blast doors are now LOCKED. Restart gateway service to enforce lockout.",
    );
  } else {
    info(
      restarted
        ? "Blast doors are now UNLOCKED. Gateway restarted and routing is restored."
        : "Blast doors are now UNLOCKED. Restart gateway service to restore routing if needed.",
    );
  }
}

async function startGatewayService() {
  const result = await apiRequest("POST", "/start");
  const running = Boolean(result?.status?.running);
  info(running ? "Blastdoor service is running." : "Start signal sent.");
}

async function restartGatewayService() {
  const result = await apiRequest("POST", "/restart");
  const running = Boolean(result?.status?.running);
  info(running ? "Blastdoor service restarted." : "Restart signal sent.");
}

async function stopGatewayService() {
  await apiRequest("POST", "/stop");
  info("Blastdoor service stopped.");
}

async function pollDebugStreams() {
  const monitor = await apiRequest("GET", "/monitor");
  const runtimeLines = monitor.runtimeLogLines || [];
  const debugLines = monitor.debugLogLines || [];

  const runtimeDelta = diffTail(state.prevRuntimeLines, runtimeLines);
  const debugDelta = diffTail(state.prevDebugLines, debugLines);

  for (const entry of runtimeDelta) {
    line(`[runtime] ${entry}`);
  }

  for (const entry of debugDelta) {
    line(`[debug] ${entry}`);
  }

  state.prevRuntimeLines = runtimeLines;
  state.prevDebugLines = debugLines;
}

function stopDebugStream() {
  if (state.debugInterval) {
    clearInterval(state.debugInterval);
    state.debugInterval = null;
  }
  state.debugStreaming = false;
  state.prevRuntimeLines = [];
  state.prevDebugLines = [];
  if (state.footerInterval) {
    clearInterval(state.footerInterval);
    state.footerInterval = null;
  }
}

function startDebugStream() {
  if (state.debugStreaming) {
    return;
  }

  state.debugStreaming = true;
  state.debugInterval = setInterval(() => {
    void pollDebugStreams().catch((debugError) => {
      warn(`Debug stream error: ${debugError.message}`);
    });
  }, 1500);
  state.footerInterval = setInterval(() => {
    if (!state.shuttingDown && state.debugStreaming) {
      printControls();
    }
  }, DEBUG_CONTROLS_REFRESH_MS);
  info("Debug stream enabled.");
}

function toggleDebugStream() {
  if (state.debugStreaming) {
    stopDebugStream();
    info("Debug stream disabled.");
    return;
  }

  startDebugStream();
}

async function openAdminPanel() {
  const url = `${MANAGER_URL}/manager/`;
  const launchers = buildAdminLaunchCommands(url);
  let lastError = null;

  for (const launcher of launchers) {
    try {
      await spawnDetached(launcher.command, launcher.args);
      info(`Opened admin panel via ${launcher.label}: ${url}`);
      return;
    } catch (launchError) {
      lastError = launchError;
      if (launchError && launchError.code === "ENOENT") {
        continue;
      }

      warn(`Browser launcher ${launcher.label} failed: ${launchError.message}`);
      break;
    }
  }

  warn(renderAdminLaunchHint(url, lastError));
}

async function validatePersistenceIfNeeded() {
  try {
    const config = await getConfig();
    const usesSqlite = config.PASSWORD_STORE_MODE === "sqlite" || config.CONFIG_STORE_MODE === "sqlite";
    const usesPostgres = config.PASSWORD_STORE_MODE === "postgres" || config.CONFIG_STORE_MODE === "postgres";

    if (!usesSqlite && !usesPostgres) {
      info("Persistence validation: not required for env/file-only mode.");
      return;
    }

    if (usesSqlite) {
      const dbPath = path.resolve(WORKSPACE_DIR, config.DATABASE_FILE || "data/blastdoor.sqlite");
      try {
        const stats = await fsp.stat(dbPath);
        info(`SQLite persistence check OK (${dbPath}, ${stats.size} bytes).`);
      } catch (sqliteError) {
        warn(`SQLite persistence check failed (${dbPath}): ${sqliteError.message}`);
      }
    }

    if (usesPostgres) {
      if (!config.POSTGRES_URL) {
        warn("PostgreSQL persistence check skipped: POSTGRES_URL is not set.");
        return;
      }

      try {
        const pg = await import("pg");
        const client = new pg.Client({
          connectionString: config.POSTGRES_URL,
          ssl: toBoolean(config.POSTGRES_SSL) ? { rejectUnauthorized: false } : false,
        });
        await client.connect();
        await client.query("SELECT 1;");
        await client.end();
        info("PostgreSQL persistence check OK (SELECT 1 succeeded).");
      } catch (pgError) {
        warn(`PostgreSQL persistence check failed: ${pgError.message}`);
      }
    }
  } catch (validationError) {
    warn(`Persistence validation failed to run: ${validationError.message}`);
  }
}

function startFileWatcher() {
  try {
    state.watcher = fs.watch(WORKSPACE_DIR, { recursive: true }, (_eventType, fileName) => {
      if (shouldIgnoreWatchPath(fileName)) {
        return;
      }

      const now = Date.now();
      if (now - state.lastChangeNoticeAt < 1200) {
        return;
      }
      state.lastChangeNoticeAt = now;
      info(`Code change detected (${fileName}). Press R to restart.`);
    });

    state.watcher.on("error", (watchError) => {
      warn(`File watcher error: ${watchError.message}`);
    });
  } catch (watchError) {
    warn(`File watcher unavailable: ${watchError.message}`);
  }
}

function stopFileWatcher() {
  if (!state.watcher) {
    return;
  }

  try {
    state.watcher.close();
  } catch {
    // ignore
  }
  state.watcher = null;
}

async function runAction(actionName, fn) {
  if (state.actionInFlight) {
    warn(`Action ignored (${actionName}): another action is in progress.`);
    return;
  }

  state.actionInFlight = true;
  try {
    await fn();
  } catch (actionError) {
    const message = actionError?.message || String(actionError);
    const isWsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
    if (/EADDRNOTAVAIL|not available on this runtime host/i.test(message)) {
      const hint = isWsl
        ? "Fix: set HOST=0.0.0.0 in .env, then use Windows portproxy/firewall for LAN access."
        : "Fix: set HOST=0.0.0.0 (LAN) or HOST=127.0.0.1 (local only), then restart.";
      error(`${actionName} failed: ${message} ${hint}`);
    } else {
      error(`${actionName} failed: ${message}`);
    }
  } finally {
    state.actionInFlight = false;
    renderControlsIfChanged();
  }
}

function cleanupInput() {
  stopDebugStream();
  stopFileWatcher();
  if (state.footerInterval) {
    clearInterval(state.footerInterval);
    state.footerInterval = null;
  }

  if (state.keypressHandler) {
    process.stdin.off("keypress", state.keypressHandler);
    state.keypressHandler = null;
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
}

async function shutdown(exitCode = 0) {
  if (state.shuttingDown) {
    return;
  }

  state.shuttingDown = true;
  info("Shutting down launch console...");
  stopDebugStream();
  stopFileWatcher();

  try {
    await stopGatewayService();
  } catch (stopError) {
    warn(`Gateway stop request failed: ${stopError.message}`);
  }

  await validatePersistenceIfNeeded();

  if (state.ownsManager && state.managerChild) {
    try {
      await stopManagerProcess();
    } catch (managerStopError) {
      warn(`Manager stop request failed: ${managerStopError.message}`);
    }
  } else if (!state.ownsManager) {
    info("Leaving existing manager process running.");
  }

  cleanupInput();
  process.exit(exitCode);
}

async function initializeManager() {
  if (await managerReachable()) {
    info("Using existing Blastdoor manager instance.");
    state.ownsManager = false;
    return;
  }

  info("Starting Blastdoor manager...");
  startManagerProcess();
  await waitForManagerReady();
  info("Blastdoor manager is ready.");
}

function bindKeyControls() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  const keypressHandler = (_str, key) => {
    if (!key) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      void shutdown(0);
      return;
    }

    const pressed = String(key.sequence || key.name || "").toUpperCase();

    if (pressed === "X") {
      void shutdown(0);
      return;
    }

    if (pressed === "R") {
      void runAction("restart", restartGatewayService);
      return;
    }

    if (pressed === "S") {
      void runAction("start admin panel", startManagerOnly);
      return;
    }

    if (pressed === "T") {
      void runAction("stop admin panel", stopManagerOnly);
      return;
    }

    if (pressed === "M") {
      void runAction("restart admin panel", restartManagerOnly);
      return;
    }

    if (pressed === "D") {
      toggleDebugStream();
      renderControlsIfChanged(true);
      return;
    }

    if (pressed === "L") {
      void runAction("lock blast doors", async () => {
        await setBlastDoors(true);
      });
      return;
    }

    if (pressed === "U") {
      void runAction("unlock blast doors", async () => {
        await setBlastDoors(false);
      });
      return;
    }

    if (pressed === "A") {
      void runAction("open admin panel", openAdminPanel);
      return;
    }

    if (pressed === "?" || pressed === "H") {
      renderControlsIfChanged(true);
    }
  };
  state.keypressHandler = keypressHandler;
  process.stdin.on("keypress", keypressHandler);
}

async function main() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error("No .env file found. Run 'make setup-env' first.");
  }

  printBanner();
  await initializeManager();
  await startGatewayService();
  startFileWatcher();
  bindKeyControls();
  if (toBoolean(process.env.LAUNCH_CONTROL_AUTO_DEBUG)) {
    startDebugStream();
  }
  renderControlsIfChanged(true);

  void openAdminPanel();
}

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("SIGINT", () => {
  void shutdown(0);
});

main().catch((startupError) => {
  error(startupError.message);
  cleanupInput();
  process.exit(1);
});
