#!/usr/bin/env node
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  defaultInstallationConfig,
  detectPlatformType,
  normalizeInstallationConfig,
  readInstallationConfig,
  syncRuntimeEnvFromInstallation,
  writeInstallationConfig,
} from "../src/installation-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceDir = path.resolve(__dirname, "..");

const defaultConfigPath = path.join(workspaceDir, "data", "installation_config.json");
const defaultEnvPath = path.join(workspaceDir, ".env");
const defaultDockerEnvPath = path.join(workspaceDir, "docker", "blastdoor.env");

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function openBrowser(url) {
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push({ command: "open", args: [url] });
  } else if (process.platform === "win32") {
    candidates.push({ command: "cmd.exe", args: ["/c", "start", "", url] });
  } else {
    if (process.env.WSL_DISTRO_NAME) {
      candidates.push({ command: "wslview", args: [url] });
      candidates.push({ command: "powershell.exe", args: ["-NoProfile", "-Command", `Start-Process '${url}'`] });
      candidates.push({ command: "cmd.exe", args: ["/c", "start", "", url] });
    }
    candidates.push({ command: "xdg-open", args: [url] });
  }

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, {
      stdio: "ignore",
    });
    if (!result.error) {
      return true;
    }
  }
  return false;
}

function spawnDetachedCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        ...options,
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once("error", (error) => {
      reject(error);
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function defaultLaunchDispatcher(config) {
  const installType = String(config?.installType || "local").toLowerCase();
  if (installType === "container") {
    return spawnDetachedCommand("docker", ["compose", "up", "-d", "--build"], {
      cwd: workspaceDir,
      env: { ...process.env },
    });
  }

  return spawnDetachedCommand(process.execPath, ["scripts/launch-control.js"], {
    cwd: workspaceDir,
    env: { ...process.env },
  });
}

function renderHtml({ deferLaunch = false } = {}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Blastdoor Installer</title>
    <style>
      :root {
        --bg0: #0c1020;
        --bg1: #162237;
        --panel: #0d1628dd;
        --line: #2f4667;
        --text: #eaf2ff;
        --muted: #9cb2cf;
        --accent: #4aa7ff;
        --good: #7ad7a2;
        --warn: #ffb982;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", system-ui, sans-serif;
        color: var(--text);
        background: radial-gradient(circle at 10% 10%, #1d3150, transparent 38%), linear-gradient(180deg, var(--bg1), var(--bg0));
        min-height: 100vh;
      }
      main {
        width: min(920px, 94vw);
        margin: 24px auto;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--panel);
        padding: 18px;
      }
      h1 { margin: 0 0 6px; font-size: 1.45rem; }
      p { margin: 0 0 14px; color: var(--muted); }
      .step { display: none; margin-top: 14px; }
      .step.active { display: block; }
      .row { display: grid; grid-template-columns: 240px 1fr; gap: 10px; align-items: center; margin: 8px 0; }
      label { color: var(--muted); font-size: 0.95rem; }
      input, select, button, textarea {
        font: inherit;
        color: var(--text);
        background: #0b1222;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 9px 10px;
      }
      textarea { min-height: 100px; width: 100%; }
      .buttons { display: flex; gap: 8px; margin-top: 16px; }
      button { cursor: pointer; background: linear-gradient(180deg, #2f5f98, #244974); }
      button.secondary { background: #13233b; }
      button[disabled] { opacity: 0.55; cursor: default; }
      .status { margin-top: 14px; min-height: 22px; }
      .status.good { color: var(--good); }
      .status.warn { color: var(--warn); }
      .hidden { display: none; }
      .hint { color: var(--muted); font-size: 0.9rem; margin: 6px 0 0; }
      pre {
        background: #0a1220;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 10px;
        overflow: auto;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Blastdoor First-Time Installer</h1>
      <p>Complete the guided setup. This writes <code>data/installation_config.json</code>, <code>.env</code>, and <code>docker/blastdoor.env</code>. Re-run anytime with <code>make configure</code>.</p>

      <section class="step active" data-step="0">
        <h2>1. Install Type</h2>
        <div class="row">
          <label for="installType">Install model</label>
          <select id="installType">
            <option value="local">Basic-Standalone (local processes)</option>
            <option value="container">Standard-Resilient (container stack)</option>
          </select>
        </div>
      </section>

      <section class="step" data-step="1">
        <h2>2. Platform</h2>
        <div class="row">
          <label for="platform">Host platform</label>
          <select id="platform">
            <option value="wsl">WSL</option>
            <option value="mac">Mac</option>
            <option value="linux">Linux</option>
          </select>
        </div>
      </section>

      <section class="step" data-step="2">
        <h2>3. Database</h2>
        <div class="row">
          <label for="database">Database backend</label>
          <select id="database">
            <option value="sqlite">SQLite</option>
            <option value="postgres">PostgreSQL</option>
          </select>
        </div>
      </section>

      <section class="step" data-step="3">
        <h2>4. Object Storage</h2>
        <div class="row">
          <label for="objectStorage">Object storage</label>
          <select id="objectStorage">
            <option value="local">Local filesystem</option>
            <option value="gdrive">Google Drive</option>
            <option value="s3">AWS S3</option>
          </select>
        </div>
      </section>

      <section class="step" data-step="4">
        <h2>5. Foundry Endpoint</h2>
        <div class="row">
          <label for="foundryMode">Foundry location</label>
          <select id="foundryMode">
            <option value="local">Local host</option>
            <option value="external">External endpoint</option>
          </select>
        </div>
        <div id="foundryLocalGroup">
          <div class="row">
            <label for="foundryLocalHost">Foundry local host</label>
            <input id="foundryLocalHost" placeholder="127.0.0.1" />
          </div>
          <div class="row">
            <label for="foundryLocalPort">Foundry local port</label>
            <input id="foundryLocalPort" type="number" min="1" max="65535" />
          </div>
        </div>
        <div id="foundryExternalGroup" class="hidden">
          <div class="row">
            <label for="foundryExternalIp">Foundry external IP / host</label>
            <input id="foundryExternalIp" placeholder="203.0.113.25" />
          </div>
          <div class="row">
            <label for="foundryExternalPort">Foundry external port</label>
            <input id="foundryExternalPort" type="number" min="1" max="65535" />
          </div>
        </div>
      </section>

      <section class="step" data-step="5">
        <h2>6. Service Topology + API</h2>
        <div class="row">
          <label for="gatewayHost">Portal bind host</label>
          <input id="gatewayHost" placeholder="0.0.0.0" />
        </div>
        <div class="row">
          <label for="gatewayPort">Portal bind port</label>
          <input id="gatewayPort" type="number" min="1" max="65535" />
        </div>
        <div class="row">
          <label for="managerHost">Admin panel host</label>
          <input id="managerHost" placeholder="127.0.0.1" />
        </div>
        <div class="row">
          <label for="managerPort">Admin panel port</label>
          <input id="managerPort" type="number" min="1" max="65535" />
        </div>
        <div class="row">
          <label for="apiHost">Blastdoor API host</label>
          <input id="apiHost" placeholder="127.0.0.1" />
        </div>
        <div class="row">
          <label for="apiPort">Blastdoor API port</label>
          <input id="apiPort" type="number" min="1" max="65535" />
        </div>
        <div class="row">
          <label for="useExternalBlastdoorApi">Use external Blastdoor API</label>
          <input id="useExternalBlastdoorApi" type="checkbox" />
        </div>
        <div id="externalApiGroup" class="hidden">
          <div class="row">
            <label for="blastdoorApiUrl">External API URL</label>
            <input id="blastdoorApiUrl" placeholder="https://api.example.com" />
          </div>
          <div class="row">
            <label for="blastdoorApiToken">External API token</label>
            <input id="blastdoorApiToken" placeholder="optional" />
          </div>
          <p class="hint">Token is stored in generated env files. Rotate regularly.</p>
        </div>
      </section>

      <section class="step" data-step="6">
        <h2>7. Review + Save</h2>
        <p>Review global install settings (written to installation_config.json):</p>
        <pre id="review"></pre>
      </section>

      <div class="buttons">
        <button id="prevBtn" type="button" class="secondary">Back</button>
        <button id="nextBtn" type="button">Next</button>
        <button id="saveBtn" type="button" class="hidden">Save Configuration</button>
      </div>
      <div id="postSaveActions" class="buttons hidden">
        <button id="closeBtn" type="button" class="secondary">Close</button>
        <button id="launchExitBtn" type="button">Launch and Exit</button>
      </div>
      <div id="status" class="status"></div>
    </main>

    <script>
      const steps = Array.from(document.querySelectorAll(".step"));
      const review = document.getElementById("review");
      const status = document.getElementById("status");
      const prevBtn = document.getElementById("prevBtn");
      const nextBtn = document.getElementById("nextBtn");
      const saveBtn = document.getElementById("saveBtn");
      const postSaveActions = document.getElementById("postSaveActions");
      const closeBtn = document.getElementById("closeBtn");
      const launchExitBtn = document.getElementById("launchExitBtn");
      const foundryMode = document.getElementById("foundryMode");
      const foundryLocalGroup = document.getElementById("foundryLocalGroup");
      const foundryExternalGroup = document.getElementById("foundryExternalGroup");
      const useExternalBlastdoorApi = document.getElementById("useExternalBlastdoorApi");
      const externalApiGroup = document.getElementById("externalApiGroup");
      let current = 0;
      let model = null;

      function formData() {
        return {
          installType: document.getElementById("installType").value,
          platform: document.getElementById("platform").value,
          database: document.getElementById("database").value,
          objectStorage: document.getElementById("objectStorage").value,
          foundryMode: foundryMode.value,
          foundryLocalHost: document.getElementById("foundryLocalHost").value.trim(),
          foundryLocalPort: Number.parseInt(document.getElementById("foundryLocalPort").value || "30000", 10),
          foundryExternalIp: document.getElementById("foundryExternalIp").value.trim(),
          foundryExternalPort: Number.parseInt(document.getElementById("foundryExternalPort").value || "30000", 10),
          gatewayHost: document.getElementById("gatewayHost").value.trim(),
          gatewayPort: Number.parseInt(document.getElementById("gatewayPort").value || "8080", 10),
          managerHost: document.getElementById("managerHost").value.trim(),
          managerPort: Number.parseInt(document.getElementById("managerPort").value || "8090", 10),
          apiHost: document.getElementById("apiHost").value.trim(),
          apiPort: Number.parseInt(document.getElementById("apiPort").value || "8070", 10),
          useExternalBlastdoorApi: useExternalBlastdoorApi.checked,
          blastdoorApiUrl: document.getElementById("blastdoorApiUrl").value.trim(),
          blastdoorApiToken: document.getElementById("blastdoorApiToken").value.trim()
        };
      }

      function syncFoundrySections() {
        if (foundryMode.value === "external") {
          foundryExternalGroup.classList.remove("hidden");
          foundryLocalGroup.classList.add("hidden");
          return;
        }
        foundryExternalGroup.classList.add("hidden");
        foundryLocalGroup.classList.remove("hidden");
      }

      function syncApiSection() {
        if (useExternalBlastdoorApi.checked) {
          externalApiGroup.classList.remove("hidden");
          return;
        }

        externalApiGroup.classList.add("hidden");
      }

      function renderStep() {
        steps.forEach((step, index) => {
          step.classList.toggle("active", index === current);
        });
        prevBtn.disabled = current === 0;
        nextBtn.classList.toggle("hidden", current === steps.length - 1);
        saveBtn.classList.toggle("hidden", current !== steps.length - 1);
        if (current === steps.length - 1) {
          review.textContent = JSON.stringify(formData(), null, 2);
        }
      }

      async function requestInstallerExit(action) {
        const response = await fetch("/api/exit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "Failed to complete installer exit action.");
        }
        return payload;
      }

      function fillForm(config) {
        document.getElementById("installType").value = config.installType || "local";
        document.getElementById("platform").value = config.platform || "linux";
        document.getElementById("database").value = config.database || "sqlite";
        document.getElementById("objectStorage").value = config.objectStorage || "local";
        foundryMode.value = config.foundryMode || "local";
        document.getElementById("foundryLocalHost").value = config.foundryLocalHost || "127.0.0.1";
        document.getElementById("foundryLocalPort").value = String(config.foundryLocalPort || 30000);
        document.getElementById("foundryExternalIp").value = config.foundryExternalIp || "";
        document.getElementById("foundryExternalPort").value = String(config.foundryExternalPort || 30000);
        document.getElementById("gatewayHost").value = config.gatewayHost || "0.0.0.0";
        document.getElementById("gatewayPort").value = String(config.gatewayPort || 8080);
        document.getElementById("managerHost").value = config.managerHost || "127.0.0.1";
        document.getElementById("managerPort").value = String(config.managerPort || 8090);
        document.getElementById("apiHost").value = config.apiHost || "127.0.0.1";
        document.getElementById("apiPort").value = String(config.apiPort || 8070);
        useExternalBlastdoorApi.checked = Boolean(config.useExternalBlastdoorApi);
        document.getElementById("blastdoorApiUrl").value = config.blastdoorApiUrl || "";
        document.getElementById("blastdoorApiToken").value = config.blastdoorApiToken || "";
        syncFoundrySections();
        syncApiSection();
      }

      async function load() {
        const response = await fetch("/api/config");
        const payload = await response.json();
        model = payload.config;
        fillForm(model);
        status.textContent = payload.exists ? "Loaded existing installation configuration. Edit as needed." : "No existing configuration found. Complete setup.";
        status.className = "status";
      }

      prevBtn.addEventListener("click", () => {
        current = Math.max(0, current - 1);
        renderStep();
      });

      nextBtn.addEventListener("click", () => {
        current = Math.min(steps.length - 1, current + 1);
        renderStep();
      });

      foundryMode.addEventListener("change", syncFoundrySections);
      useExternalBlastdoorApi.addEventListener("change", syncApiSection);

      saveBtn.addEventListener("click", async () => {
        const payload = formData();
        if (payload.foundryMode === "external" && !payload.foundryExternalIp) {
          status.textContent = "External mode requires Foundry external IP/host.";
          status.className = "status warn";
          return;
        }
        if (payload.useExternalBlastdoorApi && !payload.blastdoorApiUrl) {
          status.textContent = "External Blastdoor API mode requires External API URL.";
          status.className = "status warn";
          return;
        }

        const response = await fetch("/api/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok) {
          status.textContent = result.error || "Failed to save configuration.";
          status.className = "status warn";
          return;
        }
        status.textContent = "Configuration saved. Generated .env and docker/blastdoor.env. Use make launch / make monitor / make debug.";
        status.className = "status good";
        model = result.config;
        review.textContent = JSON.stringify(model, null, 2);
        postSaveActions.classList.remove("hidden");
      });

      closeBtn.addEventListener("click", async () => {
        closeBtn.disabled = true;
        launchExitBtn.disabled = true;
        try {
          const payload = await requestInstallerExit("close");
          status.textContent = payload.message || "Installer is closing. You can close this tab.";
          status.className = "status good";
          setTimeout(() => {
            window.close();
          }, 350);
        } catch (error) {
          status.textContent = error.message || String(error);
          status.className = "status warn";
          closeBtn.disabled = false;
          launchExitBtn.disabled = false;
        }
      });

      launchExitBtn.addEventListener("click", async () => {
        closeBtn.disabled = true;
        launchExitBtn.disabled = true;
        try {
          const payload = await requestInstallerExit("launch");
          status.textContent = payload.message || "Launch command accepted. Installer is closing.";
          status.className = "status good";
          setTimeout(() => {
            window.close();
          }, 350);
        } catch (error) {
          status.textContent = error.message || String(error);
          status.className = "status warn";
          closeBtn.disabled = false;
          launchExitBtn.disabled = false;
        }
      });

      load().catch((error) => {
        status.textContent = error.message;
        status.className = "status warn";
      });
      syncApiSection();
      if (${deferLaunch ? "true" : "false"}) {
        launchExitBtn.textContent = "Launch and Exit (Terminal)";
      }
      renderStep();
    </script>
  </body>
</html>`;
}

export function createInstallerApp({
  configPath = defaultConfigPath,
  envPath = defaultEnvPath,
  dockerEnvPath = defaultDockerEnvPath,
  deferLaunch = false,
  requestExit = () => {},
  launchDispatcher = defaultLaunchDispatcher,
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/api/config", async (_req, res) => {
    const existing = await readInstallationConfig(configPath);
    const config = existing || defaultInstallationConfig({ platform: detectPlatformType() });
    res.json({
      ok: true,
      exists: Boolean(existing),
      config,
    });
  });

  app.post("/api/config", async (req, res) => {
    try {
      const existing = await readInstallationConfig(configPath);
      const normalized = normalizeInstallationConfig(req.body || {}, existing);
      await writeInstallationConfig(configPath, normalized);
      await syncRuntimeEnvFromInstallation({
        installationConfig: normalized,
        envPath,
        dockerEnvPath,
      });

      res.json({
        ok: true,
        config: normalized,
        output: {
          installationConfigPath: configPath,
          envPath,
          dockerEnvPath,
        },
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/exit", async (req, res) => {
    try {
      const action = String(req.body?.action || "close").trim().toLowerCase();
      if (!["close", "launch"].includes(action)) {
        return res.status(400).json({
          error: "Invalid installer exit action.",
        });
      }

      if (action === "launch") {
        const config = await readInstallationConfig(configPath);
        if (!config) {
          return res.status(400).json({
            error: "No installation profile found. Save configuration before launching.",
          });
        }

        if (!deferLaunch) {
          try {
            await launchDispatcher(config);
          } catch (error) {
            return res.status(500).json({
              error: `Launch failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      }

      const deferred = action === "launch" && deferLaunch;
      const message =
        action === "launch"
          ? deferred
            ? "Launch request accepted. Installer will close and the terminal launch flow will continue."
            : "Launch started. Installer is closing."
          : "Installer is closing.";

      res.json({
        ok: true,
        action,
        deferred,
        message,
      });

      setTimeout(() => {
        try {
          requestExit(action);
        } catch {
          // ignore
        }
      }, 120);
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/", (_req, res) => {
    res.type("html").send(renderHtml({ deferLaunch }));
  });

  return app;
}

export function startInstallerServer({
  installerHost = process.env.INSTALLER_HOST || "127.0.0.1",
  installerPort = Number.parseInt(process.env.INSTALLER_PORT || "8098", 10),
  configPath = defaultConfigPath,
  envPath = defaultEnvPath,
  dockerEnvPath = defaultDockerEnvPath,
  deferLaunch = parseBoolean(process.env.INSTALLER_DEFER_LAUNCH, false),
  exitSignalPath = process.env.INSTALLER_EXIT_SIGNAL_PATH || "",
  autoOpen = parseBoolean(process.env.INSTALLER_AUTO_OPEN, true),
  openBrowserFn = openBrowser,
} = {}) {
  const resolvedExitSignalPath = exitSignalPath ? path.resolve(workspaceDir, exitSignalPath) : "";
  let server = null;
  const app = createInstallerApp({
    configPath,
    envPath,
    dockerEnvPath,
    deferLaunch,
    requestExit(action) {
      const closeServer = () => {
        if (!server) {
          return;
        }
        server.close(() => {
          process.exit(0);
        });
      };

      if (!resolvedExitSignalPath) {
        closeServer();
        return;
      }

      fs.mkdir(path.dirname(resolvedExitSignalPath), { recursive: true })
        .then(() => fs.writeFile(resolvedExitSignalPath, `${action}\n`, "utf8"))
        .catch(() => {
          // ignore signal write errors and continue shutdown
        })
        .finally(closeServer);
    },
  });
  server = app.listen(installerPort, installerHost, () => {
    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : installerPort;
    const installerUrl = `http://${installerHost}:${boundPort}`;
    console.log(`Blastdoor installer available at ${installerUrl}`);
    if (!autoOpen) {
      return;
    }

    const opened = openBrowserFn(installerUrl);
    if (!opened) {
      console.log(`Open this URL in your browser: ${installerUrl}`);
    }
  });

  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  startInstallerServer();
}
