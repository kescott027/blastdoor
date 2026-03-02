#!/usr/bin/env node
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildFoundryTarget,
  defaultInstallationConfig,
  detectPlatformType,
  normalizeInstallationConfig,
  readInstallationConfig,
  syncRuntimeEnvFromInstallation,
  writeInstallationConfig,
} from "../src/installation-config.js";
import { createAssistantClient } from "../src/assistant-client.js";

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

function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

function isLoopbackHost(hostname) {
  const host = normalizeString(hostname, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function commandAvailable(command, args = ["--version"]) {
  try {
    const result = spawnSync(command, args, {
      stdio: "ignore",
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function detectCoreInstallerEnvironment() {
  const platform = detectPlatformType();
  const dockerAvailable = commandAvailable("docker", ["--version"]);
  const dockerComposeAvailable = dockerAvailable && commandAvailable("docker", ["compose", "version"]);
  const npmAvailable = commandAvailable("npm", ["--version"]);
  const nodeVersion = process.version;
  const isWsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
  const wslDistro = normalizeString(process.env.WSL_DISTRO_NAME, "");
  return {
    platform,
    isWsl,
    wslDistro,
    dockerAvailable,
    dockerComposeAvailable,
    npmAvailable,
    nodeVersion,
  };
}

function detectWslGatewayIp() {
  try {
    const result = spawnSync("ip", ["route", "show", "default"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
      return "";
    }
    const match = String(result.stdout || "").match(/\bdefault\s+via\s+((?:\d{1,3}\.){3}\d{1,3})\b/i);
    return normalizeString(match?.[1], "");
  } catch {
    return "";
  }
}

async function probeUrl(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return {
      ok: response.ok,
      statusCode: response.status,
      error: "",
      url,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      error: error instanceof Error ? error.message : String(error),
      url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildInstallerDiagnostics({ config, environment, foundryProbe }) {
  const foundryTarget = foundryProbe?.url || "";
  const foundryHost = normalizeString(config?.foundryMode, "local") === "local"
    ? normalizeString(config?.foundryLocalHost, "127.0.0.1")
    : normalizeString(config?.foundryExternalIp, "");

  const configEnvelope = {
    HOST: normalizeString(config?.gatewayHost, "0.0.0.0"),
    PORT: String(config?.gatewayPort || 8080),
    FOUNDRY_TARGET: foundryTarget,
    INSTALL_PROFILE: normalizeString(config?.installType, "local"),
    COOKIE_SECURE: normalizeString(config?.installType, "local") === "container" ? "true" : "false",
    TRUST_PROXY: normalizeString(config?.installType, "local") === "container" ? "1" : "false",
    BLASTDOOR_API_URL: config?.useExternalBlastdoorApi ? normalizeString(config?.blastdoorApiUrl, "") : "",
    ASSISTANT_PROVIDER: normalizeString(process.env.ASSISTANT_PROVIDER, "ollama"),
    ASSISTANT_OLLAMA_URL: normalizeString(process.env.ASSISTANT_OLLAMA_URL, "http://127.0.0.1:11434"),
    TLS_ENABLED: normalizeString(config?.installType, "local") === "container" ? "true" : "false",
    TLS_DOMAIN: normalizeString(config?.publicDomain, ""),
    SESSION_SECRET: normalizeString(process.env.SESSION_SECRET, ""),
    MANAGER_HOST: normalizeString(config?.managerHost, "127.0.0.1"),
    MANAGER_PORT: String(config?.managerPort || 8090),
    FOUNDRY_HOST: foundryHost,
  };

  return {
    generatedAt: new Date().toISOString(),
    environment: {
      platform: environment.platform,
      isWsl: environment.isWsl,
      wslDistro: environment.wslDistro,
      nodeVersion: environment.nodeVersion,
      dockerAvailable: environment.dockerAvailable,
      dockerComposeAvailable: environment.dockerComposeAvailable,
    },
    config: configEnvelope,
    foundryHealth: {
      ok: foundryProbe?.ok === true,
      statusCode: foundryProbe?.statusCode ?? null,
      url: foundryTarget,
      error: foundryProbe?.error || "",
      targetHost: foundryHost,
      targetIsLoopback: isLoopbackHost(foundryHost),
    },
  };
}

function deriveCoreInstallPatch({ config, environment, foundryProbe }) {
  const patch = {};
  const notes = [];
  const warnings = [];
  const errors = [];

  if (config.platform !== environment.platform) {
    patch.platform = environment.platform;
    notes.push(`Detected platform is '${environment.platform}'. Updated platform selection to match runtime.`);
  }

  if (config.installType === "container" && !environment.dockerComposeAvailable) {
    patch.installType = "local";
    errors.push("Container install selected but Docker Compose is unavailable. Recommended switching to local install.");
  } else if (config.installType === "local" && environment.dockerComposeAvailable) {
    notes.push("Docker Compose is available. Standard-Resilient container install is supported on this host.");
  }

  if (environment.isWsl && config.installType === "local" && config.managerHost === "127.0.0.1") {
    patch.managerHost = "0.0.0.0";
    notes.push("WSL detected. Manager host adjusted to 0.0.0.0 for easier LAN/admin reachability.");
  }

  if (environment.isWsl && config.foundryMode === "local" && isLoopbackHost(config.foundryLocalHost)) {
    const gatewayIp = detectWslGatewayIp();
    if (gatewayIp) {
      patch.foundryLocalHost = gatewayIp;
      notes.push(
        `WSL detected with local Foundry loopback target. Suggested Foundry local host updated to Windows gateway ${gatewayIp}.`,
      );
    } else {
      warnings.push("WSL detected and Foundry local host is loopback. Consider using Windows gateway IP for cross-runtime access.");
    }
  }

  if (config.installType === "container") {
    if (!normalizeString(config.publicDomain, "")) {
      warnings.push("Container install typically requires a public domain for automated TLS.");
    }
    if (!normalizeString(config.letsEncryptEmail, "")) {
      warnings.push("Container install typically requires a Let's Encrypt contact email.");
    }
  }

  if (!foundryProbe.ok) {
    warnings.push(
      `Foundry endpoint probe failed (${foundryProbe.error || foundryProbe.statusCode || "unreachable"}). Verify Foundry host/port before launch.`,
    );
  }

  return {
    patch,
    notes,
    warnings,
    errors,
  };
}

function mapAssistantDefaultsToInstallPatch(suggestedDefaults = {}) {
  const patch = {};
  if (normalizeString(suggestedDefaults.HOST, "")) {
    patch.gatewayHost = normalizeString(suggestedDefaults.HOST, "");
  }
  return patch;
}

function mergeInstallPatch(base, patch) {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    next[key] = value;
  }
  return next;
}

async function buildCoreInstallAnalysis({ rawConfig = {}, existingConfig = null, userMessage = "" } = {}) {
  const normalizedConfig = normalizeInstallationConfig(rawConfig, existingConfig);
  const environment = detectCoreInstallerEnvironment();
  const foundryTarget = buildFoundryTarget(normalizedConfig);
  const foundryProbe = await probeUrl(foundryTarget, 2200);
  const diagnosticsReport = buildInstallerDiagnostics({
    config: normalizedConfig,
    environment,
    foundryProbe: { ...foundryProbe, url: foundryTarget },
  });

  const assistant = createAssistantClient({ forceLocal: true });
  let assistantStatus;
  let assistantRecommendations;
  let assistantChatReply = "";
  try {
    assistantStatus = await assistant.getStatus();
    assistantRecommendations = await assistant.runConfigRecommendations({
      diagnosticsReport,
      installationConfig: normalizedConfig,
    });
    if (userMessage) {
      const chat = await assistant.runWorkflowChat({
        workflow: {
          id: "installer-core-guidance",
          type: "custom",
          name: "Installer Core Guidance",
          systemPrompt:
            "You are a Blastdoor installer assistant. Give direct, concise install guidance and highlight blockers.",
          seedPrompt:
            "Use the provided installer config and runtime diagnostics. Prioritize safe, practical next actions.",
        },
        message: userMessage,
        context: {
          installationConfig: normalizedConfig,
          diagnosticsReport,
        },
      });
      assistantChatReply = normalizeString(chat?.reply, "");
    }
  } finally {
    if (typeof assistant.close === "function") {
      await assistant.close();
    }
  }

  const coreDerived = deriveCoreInstallPatch({
    config: normalizedConfig,
    environment,
    foundryProbe: { ...foundryProbe, url: foundryTarget },
  });
  const assistantPatch = mapAssistantDefaultsToInstallPatch(assistantRecommendations?.suggestedDefaults || {});
  const mergedPatch = mergeInstallPatch(coreDerived.patch, assistantPatch);
  const recommendedConfig = normalizeInstallationConfig(mergeInstallPatch(normalizedConfig, mergedPatch), normalizedConfig);

  const checklist = [
    {
      id: "runtime.detected",
      title: "Runtime detection",
      status: "ok",
      detail: `Detected ${environment.platform}${environment.isWsl ? ` (${environment.wslDistro || "WSL"})` : ""}`,
    },
    {
      id: "docker.available",
      title: "Docker availability",
      status: environment.dockerComposeAvailable ? "ok" : "warn",
      detail: environment.dockerComposeAvailable
        ? "Docker Compose is available."
        : "Docker Compose is not available.",
    },
    {
      id: "foundry.probe",
      title: "Foundry endpoint probe",
      status: foundryProbe.ok ? "ok" : "warn",
      detail: foundryProbe.ok
        ? `Reachable: ${foundryTarget} (${foundryProbe.statusCode || "ok"})`
        : `Unreachable: ${foundryTarget}${foundryProbe.error ? ` (${foundryProbe.error})` : ""}`,
    },
  ];

  return {
    environment,
    diagnosticsReport,
    normalizedConfig,
    recommendedConfig,
    recommendedPatch: mergedPatch,
    coreRecommendations: coreDerived,
    assistantStatus,
    assistantRecommendations,
    assistantChatReply,
    checklist,
  };
}

function buildCoreStepPrompt({ stepIndex = 0, analysis = null }) {
  const stepPrompts = [
    "Step 1/7: Choose install model and workflow mode. Prefer container if Docker Compose is available and you want resilient deployment.",
    "Step 2/7: Confirm detected platform (Linux/Windows/WSL/Mac). This drives networking recommendations.",
    "Step 3/7: Select database backend. Use SQLite for simplest local setup; PostgreSQL for multi-service durability.",
    "Step 4/7: Select object storage. Local filesystem is simplest; S3/GDrive require external credential setup.",
    "Step 5/7: Configure Foundry endpoint. In WSL, avoid loopback targets when Foundry runs on Windows host.",
    "Step 6/7: Set service topology/API details. Validate manager host/port and external API options.",
    "Step 7/7: Review, validate, then save. Fix any blocking errors before launch.",
  ];

  const basePrompt = stepPrompts[Math.max(0, Math.min(stepPrompts.length - 1, Number(stepIndex) || 0))];
  const errors = Array.isArray(analysis?.coreRecommendations?.errors) ? analysis.coreRecommendations.errors : [];
  const warnings = Array.isArray(analysis?.coreRecommendations?.warnings) ? analysis.coreRecommendations.warnings : [];
  const checklist = Array.isArray(analysis?.checklist) ? analysis.checklist : [];
  const lines = [basePrompt];
  for (const check of checklist) {
    lines.push(`Check [${check.status || "info"}] ${check.title}: ${check.detail}`);
  }
  for (const error of errors) {
    lines.push(`Blocking: ${error}`);
  }
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }
  return lines.join("\n");
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
          <label for="installGuidance">Workflow mode</label>
          <select id="installGuidance">
            <option value="standard">Standard guided install</option>
            <option value="ai-guided">AI guided install (chat-assisted)</option>
          </select>
        </div>
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
            <option value="windows">Windows</option>
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
        <div id="tlsContainerGroup" class="hidden">
          <div class="row">
            <label for="publicDomain">Public domain (TLS)</label>
            <input id="publicDomain" placeholder="blastdoor.example.com" />
          </div>
          <div class="row">
            <label for="letsEncryptEmail">Let's Encrypt email</label>
            <input id="letsEncryptEmail" placeholder="admin@example.com" />
          </div>
          <p class="hint">Used by Caddy for external HTTPS certificates (ports 80/443 must be reachable).</p>
        </div>
      </section>

      <section class="step" data-step="6">
        <h2>7. Review + Save</h2>
        <p>Review global install settings (written to installation_config.json):</p>
        <pre id="review"></pre>
      </section>

      <section id="aiGuidePanel" class="hidden">
        <h2>AI Guided Core Install Workflow</h2>
        <p class="hint">Use AI mode for environment-aware recommendations, preflight checks, and step guidance.</p>
        <div class="buttons">
          <button id="aiAnalyzeBtn" type="button" class="secondary">Analyze + Recommend</button>
          <button id="aiApplyBtn" type="button" class="secondary" disabled>Apply Suggested Values</button>
          <button id="aiValidateBtn" type="button" class="secondary">Validate Install Path</button>
        </div>
        <div class="row">
          <label for="aiQuestion">Ask AI</label>
          <div style="display:flex; gap:8px;">
            <input id="aiQuestion" placeholder="Ask about install choices, detected risks, or next steps." />
            <button id="aiAskBtn" type="button" class="secondary">Send</button>
          </div>
        </div>
        <pre id="aiLog"></pre>
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
      const installType = document.getElementById("installType");
      const installGuidance = document.getElementById("installGuidance");
      const foundryLocalGroup = document.getElementById("foundryLocalGroup");
      const foundryExternalGroup = document.getElementById("foundryExternalGroup");
      const useExternalBlastdoorApi = document.getElementById("useExternalBlastdoorApi");
      const externalApiGroup = document.getElementById("externalApiGroup");
      const tlsContainerGroup = document.getElementById("tlsContainerGroup");
      const aiGuidePanel = document.getElementById("aiGuidePanel");
      const aiAnalyzeBtn = document.getElementById("aiAnalyzeBtn");
      const aiApplyBtn = document.getElementById("aiApplyBtn");
      const aiValidateBtn = document.getElementById("aiValidateBtn");
      const aiAskBtn = document.getElementById("aiAskBtn");
      const aiQuestion = document.getElementById("aiQuestion");
      const aiLog = document.getElementById("aiLog");
      let current = 0;
      let model = null;
      let aiSuggestedPatch = null;
      let aiLastAnalysis = null;

      function formData() {
        return {
          installGuidance: installGuidance.value,
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
          blastdoorApiToken: document.getElementById("blastdoorApiToken").value.trim(),
          publicDomain: document.getElementById("publicDomain").value.trim(),
          letsEncryptEmail: document.getElementById("letsEncryptEmail").value.trim()
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

      function syncTlsSection() {
        if (installType.value === "container") {
          tlsContainerGroup.classList.remove("hidden");
          return;
        }
        tlsContainerGroup.classList.add("hidden");
      }

      function syncAiGuidanceSection() {
        const enabled = installGuidance.value === "ai-guided";
        aiGuidePanel.classList.toggle("hidden", !enabled);
        if (!enabled) {
          aiSuggestedPatch = null;
          aiLastAnalysis = null;
          aiApplyBtn.disabled = true;
        }
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

      function appendAiLog(role, text) {
        const stamp = new Date().toISOString().replace("T", " ").replace("Z", "");
        aiLog.textContent += "[" + stamp + "] " + role + ": " + text + "\n";
        aiLog.scrollTop = aiLog.scrollHeight;
      }

      async function postAi(pathname, body) {
        const response = await fetch(pathname, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "AI workflow request failed.");
        }
        return payload;
      }

      function applyInstallPatch(patch = {}) {
        if (patch.installGuidance) installGuidance.value = String(patch.installGuidance);
        if (patch.installType) installType.value = String(patch.installType);
        if (patch.platform) document.getElementById("platform").value = String(patch.platform);
        if (patch.database) document.getElementById("database").value = String(patch.database);
        if (patch.objectStorage) document.getElementById("objectStorage").value = String(patch.objectStorage);
        if (patch.foundryMode) foundryMode.value = String(patch.foundryMode);
        if (patch.foundryLocalHost) document.getElementById("foundryLocalHost").value = String(patch.foundryLocalHost);
        if (patch.foundryLocalPort) document.getElementById("foundryLocalPort").value = String(patch.foundryLocalPort);
        if (patch.foundryExternalIp) document.getElementById("foundryExternalIp").value = String(patch.foundryExternalIp);
        if (patch.foundryExternalPort) document.getElementById("foundryExternalPort").value = String(patch.foundryExternalPort);
        if (patch.gatewayHost) document.getElementById("gatewayHost").value = String(patch.gatewayHost);
        if (patch.gatewayPort) document.getElementById("gatewayPort").value = String(patch.gatewayPort);
        if (patch.managerHost) document.getElementById("managerHost").value = String(patch.managerHost);
        if (patch.managerPort) document.getElementById("managerPort").value = String(patch.managerPort);
        if (patch.apiHost) document.getElementById("apiHost").value = String(patch.apiHost);
        if (patch.apiPort) document.getElementById("apiPort").value = String(patch.apiPort);
        if (Object.prototype.hasOwnProperty.call(patch, "useExternalBlastdoorApi")) {
          useExternalBlastdoorApi.checked = patch.useExternalBlastdoorApi === true || String(patch.useExternalBlastdoorApi) === "true";
        }
        if (patch.blastdoorApiUrl) document.getElementById("blastdoorApiUrl").value = String(patch.blastdoorApiUrl);
        if (patch.blastdoorApiToken) document.getElementById("blastdoorApiToken").value = String(patch.blastdoorApiToken);
        if (patch.publicDomain) document.getElementById("publicDomain").value = String(patch.publicDomain);
        if (patch.letsEncryptEmail) document.getElementById("letsEncryptEmail").value = String(patch.letsEncryptEmail);
        syncFoundrySections();
        syncApiSection();
        syncTlsSection();
        syncAiGuidanceSection();
        renderStep();
      }

      function summarizeAnalysis(payload) {
        const env = payload?.analysis?.environment || {};
        const checks = Array.isArray(payload?.analysis?.checklist) ? payload.analysis.checklist : [];
        const notes = Array.isArray(payload?.analysis?.coreRecommendations?.notes)
          ? payload.analysis.coreRecommendations.notes
          : [];
        const warnings = Array.isArray(payload?.analysis?.coreRecommendations?.warnings)
          ? payload.analysis.coreRecommendations.warnings
          : [];
        const errors = Array.isArray(payload?.analysis?.coreRecommendations?.errors)
          ? payload.analysis.coreRecommendations.errors
          : [];
        const assistantSummary = payload?.analysis?.assistantRecommendations?.summary || "";
        const runtimeLabel =
          "Detected runtime: " +
          (env.platform || "unknown") +
          (env.isWsl ? " (" + (env.wslDistro || "WSL") + ")" : "");
        const lines = [
          runtimeLabel,
          "Docker Compose: " + (env.dockerComposeAvailable ? "available" : "not available"),
          assistantSummary ? "Assistant summary: " + assistantSummary : "",
          ...checks.map((entry) => "Check [" + (entry.status || "info") + "] " + entry.title + ": " + entry.detail),
          ...notes.map((entry) => "Note: " + entry),
          ...warnings.map((entry) => "Warning: " + entry),
          ...errors.map((entry) => "Error: " + entry),
        ].filter(Boolean);
        return lines.join("\n");
      }

      async function runAiAnalyzeAndRecommend() {
        const payload = await postAi("/api/core-workflow/analyze", {
          config: formData(),
          stepIndex: current,
        });
        aiLastAnalysis = payload.analysis || null;
        aiSuggestedPatch = payload.analysis?.recommendedPatch || null;
        aiApplyBtn.disabled = !aiSuggestedPatch || Object.keys(aiSuggestedPatch).length === 0;
        appendAiLog("assistant", summarizeAnalysis(payload));
      }

      async function runAiStepGuidance() {
        if (installGuidance.value !== "ai-guided") {
          return;
        }
        const payload = await postAi("/api/core-workflow/step", {
          config: formData(),
          stepIndex: current,
        });
        if (payload?.prompt) {
          appendAiLog("assistant", payload.prompt);
        }
      }

      function fillForm(config) {
        installGuidance.value = config.installGuidance || "standard";
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
        document.getElementById("publicDomain").value = config.publicDomain || "";
        document.getElementById("letsEncryptEmail").value = config.letsEncryptEmail || "";
        syncFoundrySections();
        syncApiSection();
        syncTlsSection();
        syncAiGuidanceSection();
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
        runAiStepGuidance().catch((error) => {
          appendAiLog("assistant", "Step guidance unavailable: " + (error.message || String(error)));
        });
      });

      foundryMode.addEventListener("change", syncFoundrySections);
      installType.addEventListener("change", syncTlsSection);
      useExternalBlastdoorApi.addEventListener("change", syncApiSection);
      installGuidance.addEventListener("change", () => {
        syncAiGuidanceSection();
        if (installGuidance.value === "ai-guided") {
          appendAiLog("assistant", "AI-guided install enabled. Click 'Analyze + Recommend' to start the core workflow.");
          runAiStepGuidance().catch((error) => {
            appendAiLog("assistant", "Step guidance unavailable: " + (error.message || String(error)));
          });
        }
      });

      aiAnalyzeBtn.addEventListener("click", () => {
        runAiAnalyzeAndRecommend().catch((error) => {
          appendAiLog("assistant", "Analyze failed: " + (error.message || String(error)));
        });
      });

      aiApplyBtn.addEventListener("click", () => {
        if (!aiSuggestedPatch || Object.keys(aiSuggestedPatch).length === 0) {
          appendAiLog("assistant", "No AI patch is available to apply yet.");
          return;
        }
        applyInstallPatch(aiSuggestedPatch);
        appendAiLog("assistant", "Applied suggested values: " + JSON.stringify(aiSuggestedPatch));
      });

      aiValidateBtn.addEventListener("click", () => {
        postAi("/api/core-workflow/validate", {
          config: formData(),
        })
          .then((payload) => {
            const checks = Array.isArray(payload?.checks) ? payload.checks : [];
            const lines = [
              "Validation ready: " + (payload.ready ? "yes" : "no"),
              ...checks.map((entry) => "[" + (entry.status || "info") + "] " + entry.title + ": " + entry.detail),
            ];
            appendAiLog("assistant", lines.join("\n"));
          })
          .catch((error) => {
            appendAiLog("assistant", "Validate failed: " + (error.message || String(error)));
          });
      });

      aiAskBtn.addEventListener("click", () => {
        const question = aiQuestion.value.trim();
        if (!question) {
          return;
        }
        appendAiLog("you", question);
        aiQuestion.value = "";
        postAi("/api/core-workflow/chat", {
          config: formData(),
          stepIndex: current,
          question,
        })
          .then((payload) => {
            if (payload?.reply) {
              appendAiLog("assistant", payload.reply);
            }
            if (payload?.recommendedPatch && Object.keys(payload.recommendedPatch).length > 0) {
              aiSuggestedPatch = payload.recommendedPatch;
              aiApplyBtn.disabled = false;
              appendAiLog("assistant", "Suggested patch available: " + JSON.stringify(aiSuggestedPatch));
            }
          })
          .catch((error) => {
            appendAiLog("assistant", "Chat failed: " + (error.message || String(error)));
          });
      });

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
        if (payload.installType === "container" && (!payload.publicDomain || !payload.letsEncryptEmail)) {
          status.textContent = "Container mode requires Public domain and Let's Encrypt email for external TLS.";
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
      syncTlsSection();
      syncAiGuidanceSection();
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

  app.post("/api/core-workflow/analyze", async (req, res) => {
    try {
      const existing = await readInstallationConfig(configPath);
      const analysis = await buildCoreInstallAnalysis({
        rawConfig: req.body?.config || {},
        existingConfig: existing,
      });
      res.json({
        ok: true,
        analysis,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/core-workflow/step", async (req, res) => {
    try {
      const existing = await readInstallationConfig(configPath);
      const analysis = await buildCoreInstallAnalysis({
        rawConfig: req.body?.config || {},
        existingConfig: existing,
      });
      const stepIndex = Number.parseInt(String(req.body?.stepIndex ?? "0"), 10);
      const prompt = buildCoreStepPrompt({ stepIndex, analysis });
      res.json({
        ok: true,
        stepIndex,
        prompt,
        recommendedPatch: analysis.recommendedPatch || {},
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/core-workflow/chat", async (req, res) => {
    try {
      const existing = await readInstallationConfig(configPath);
      const question = normalizeString(req.body?.question, "");
      const analysis = await buildCoreInstallAnalysis({
        rawConfig: req.body?.config || {},
        existingConfig: existing,
        userMessage: question,
      });
      const fallbackReply = [
        question ? `Question: ${question}` : "",
        buildCoreStepPrompt({
          stepIndex: Number.parseInt(String(req.body?.stepIndex ?? "0"), 10),
          analysis,
        }),
      ]
        .filter(Boolean)
        .join("\n\n");
      const reply = normalizeString(analysis.assistantChatReply, "") || fallbackReply;
      res.json({
        ok: true,
        reply,
        recommendedPatch: analysis.recommendedPatch || {},
        analysis: {
          checklist: analysis.checklist || [],
          coreRecommendations: analysis.coreRecommendations || {},
        },
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/core-workflow/validate", async (req, res) => {
    try {
      const existing = await readInstallationConfig(configPath);
      const analysis = await buildCoreInstallAnalysis({
        rawConfig: req.body?.config || {},
        existingConfig: existing,
      });
      const checks = [];
      const errors = Array.isArray(analysis.coreRecommendations?.errors) ? analysis.coreRecommendations.errors : [];
      const warnings = Array.isArray(analysis.coreRecommendations?.warnings)
        ? analysis.coreRecommendations.warnings
        : [];
      for (const entry of analysis.checklist || []) {
        checks.push(entry);
      }
      for (const entry of errors) {
        checks.push({
          status: "error",
          title: "Blocking issue",
          detail: entry,
        });
      }
      for (const entry of warnings) {
        checks.push({
          status: "warn",
          title: "Warning",
          detail: entry,
        });
      }
      res.json({
        ok: true,
        ready: errors.length === 0,
        checks,
        recommendedPatch: analysis.recommendedPatch || {},
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
