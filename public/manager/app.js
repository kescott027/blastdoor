import { formatUnexpectedPayload, getApiBaseCandidates, resolveApiBasePath, resolveApiPath } from "./client-utils.js";

const statusMessage = document.getElementById("statusMessage");
const form = document.getElementById("configForm");
const diagStatusMessage = document.getElementById("diagStatusMessage");
const diagSummary = document.getElementById("diagSummary");
const diagJson = document.getElementById("diagJson");
const blastDoorsToggle = document.getElementById("blastDoorsToggle");
const blastDoorsState = document.getElementById("blastDoorsState");
const blastDoorsClosedField = document.getElementById("blastDoorsClosedField");
const tsStatusMessage = document.getElementById("tsStatusMessage");
const tsHints = document.getElementById("tsHints");
const tsOutput = document.getElementById("tsOutput");
const tsScript = document.getElementById("tsScript");
const configBackupStatusMessage = document.getElementById("configBackupStatusMessage");
const configBackupName = document.getElementById("configBackupName");
const configBackupSelect = document.getElementById("configBackupSelect");
const configBackupDetails = document.getElementById("configBackupDetails");
const pluginPanelsContainer = document.getElementById("pluginPanels");
const appearanceModal = document.getElementById("appearanceModal");
const appearanceStatusMessage = document.getElementById("appearanceStatusMessage");
const appearanceThemeSelect = document.getElementById("appearanceThemeSelect");
const appearanceEditBtn = document.getElementById("appearanceEditBtn");
const appearanceNewBtn = document.getElementById("appearanceNewBtn");
const appearanceEditorSection = document.getElementById("appearanceEditorSection");
const appearanceEditorHeading = document.getElementById("appearanceEditorHeading");
const appearanceForm = document.getElementById("appearanceForm");
const appearanceCancelBtn = document.getElementById("appearanceCancelBtn");
const appearanceRenameBtn = document.getElementById("appearanceRenameBtn");
const appearanceDeleteBtn = document.getElementById("appearanceDeleteBtn");
const appearanceThemeName = document.getElementById("appearanceThemeName");
const appearanceLogoSelectLegacy = document.getElementById("appearanceLogoSelect");
const appearanceClosedBgSelectLegacy = document.getElementById("appearanceClosedBgSelect");
const appearanceOpenBgSelectLegacy = document.getElementById("appearanceOpenBgSelect");
const appearanceLogoDisplay = document.getElementById("appearanceLogoDisplay");
const appearanceLogoPath = document.getElementById("appearanceLogoPath");
const appearanceClosedBgDisplay = document.getElementById("appearanceClosedBgDisplay");
const appearanceClosedBgPath = document.getElementById("appearanceClosedBgPath");
const appearanceOpenBgDisplay = document.getElementById("appearanceOpenBgDisplay");
const appearanceOpenBgPath = document.getElementById("appearanceOpenBgPath");
const appearanceChooseLogoBtn = document.getElementById("appearanceChooseLogoBtn");
const appearanceChooseClosedBgBtn = document.getElementById("appearanceChooseClosedBgBtn");
const appearanceChooseOpenBgBtn = document.getElementById("appearanceChooseOpenBgBtn");
const appearanceAssetChooser = document.getElementById("appearanceAssetChooser");
const appearanceAssetChooserTitle = document.getElementById("appearanceAssetChooserTitle");
const appearanceAssetChooserList = document.getElementById("appearanceAssetChooserList");
const appearanceAssetSelectBtn = document.getElementById("appearanceAssetSelectBtn");
const appearanceAssetCancelBtn = document.getElementById("appearanceAssetCancelBtn");
const appearanceMakeActive = document.getElementById("appearanceMakeActive");
const appearanceLoginBoxWidthPercent = document.getElementById("appearanceLoginBoxWidthPercent");
const appearanceLoginBoxHeightPercent = document.getElementById("appearanceLoginBoxHeightPercent");
const appearanceLoginBoxOpacityPercent = document.getElementById("appearanceLoginBoxOpacityPercent");
const appearanceLoginBoxHoverOpacityPercent = document.getElementById("appearanceLoginBoxHoverOpacityPercent");
const appearanceLoginBoxPosXPercent = document.getElementById("appearanceLoginBoxPosXPercent");
const appearanceLoginBoxPosYPercent = document.getElementById("appearanceLoginBoxPosYPercent");
const appearanceLogoSizePercent = document.getElementById("appearanceLogoSizePercent");
const appearanceLogoOffsetXPercent = document.getElementById("appearanceLogoOffsetXPercent");
const appearanceLogoOffsetYPercent = document.getElementById("appearanceLogoOffsetYPercent");
const appearanceBackgroundZoomPercent = document.getElementById("appearanceBackgroundZoomPercent");
const appearanceLoginBoxWidthValue = document.getElementById("appearanceLoginBoxWidthValue");
const appearanceLoginBoxHeightValue = document.getElementById("appearanceLoginBoxHeightValue");
const appearanceLoginBoxOpacityValue = document.getElementById("appearanceLoginBoxOpacityValue");
const appearanceLoginBoxHoverOpacityValue = document.getElementById("appearanceLoginBoxHoverOpacityValue");
const appearanceLoginBoxPosXValue = document.getElementById("appearanceLoginBoxPosXValue");
const appearanceLoginBoxPosYValue = document.getElementById("appearanceLoginBoxPosYValue");
const appearanceLogoSizeValue = document.getElementById("appearanceLogoSizeValue");
const appearanceLogoOffsetXValue = document.getElementById("appearanceLogoOffsetXValue");
const appearanceLogoOffsetYValue = document.getElementById("appearanceLogoOffsetYValue");
const appearanceBackgroundZoomValue = document.getElementById("appearanceBackgroundZoomValue");
const appearanceLoginBoxModeDark = document.getElementById("appearanceLoginBoxModeDark");
const appearanceLoginBoxModeLight = document.getElementById("appearanceLoginBoxModeLight");
const userModal = document.getElementById("userModal");
const userStatusMessage = document.getElementById("userStatusMessage");
const userTableBody = document.getElementById("userTableBody");
const userForm = document.getElementById("userForm");
const userEditorHeading = document.getElementById("userEditorHeading");
const userFriendlyName = document.getElementById("userFriendlyName");
const userUsername = document.getElementById("userUsername");
const userEmail = document.getElementById("userEmail");
const userPassword = document.getElementById("userPassword");
const userStatus = document.getElementById("userStatus");
const userDisplayInfo = document.getElementById("userDisplayInfo");
const userNotes = document.getElementById("userNotes");
const userLastLoginAt = document.getElementById("userLastLoginAt");
const userLastKnownIp = document.getElementById("userLastKnownIp");
const userBanReinstateBtn = document.getElementById("userBanReinstateBtn");
const userTempCodeBox = document.getElementById("userTempCodeBox");
const userFilterInputs = Array.from(document.querySelectorAll("input[name='userFilter']"));
const tlsModal = document.getElementById("tlsModal");
const tlsStatusMessage = document.getElementById("tlsStatusMessage");
const tlsForm = document.getElementById("tlsForm");
const tlsEnabled = document.getElementById("tlsEnabled");
const tlsDomain = document.getElementById("tlsDomain");
const tlsEmail = document.getElementById("tlsEmail");
const tlsChallengeMethod = document.getElementById("tlsChallengeMethod");
const tlsWebrootPath = document.getElementById("tlsWebrootPath");
const tlsCertFile = document.getElementById("tlsCertFile");
const tlsKeyFile = document.getElementById("tlsKeyFile");
const tlsCaFile = document.getElementById("tlsCaFile");
const tlsPassphrase = document.getElementById("tlsPassphrase");
const tlsDetectionOutput = document.getElementById("tlsDetectionOutput");
const tlsPlanOutput = document.getElementById("tlsPlanOutput");
const API_BASE = resolveApiBasePath(window.location.href);
const API_BASE_CANDIDATES = getApiBaseCandidates(API_BASE);
const THEME_LAYOUT_DEFAULTS = {
  loginBoxWidthPercent: 100,
  loginBoxHeightPercent: 100,
  loginBoxOpacityPercent: 100,
  loginBoxHoverOpacityPercent: 100,
  loginBoxPosXPercent: 50,
  loginBoxPosYPercent: 50,
  logoSizePercent: 30,
  logoOffsetXPercent: 2,
  logoOffsetYPercent: 2,
  backgroundZoomPercent: 100,
  loginBoxMode: "dark",
};
const hasThemeEditorPanelControls = Boolean(
  appearanceEditBtn &&
    appearanceNewBtn &&
    appearanceEditorSection &&
    appearanceEditorHeading,
);
const hasThemeEditorFormControls = Boolean(
  appearanceForm &&
    appearanceRenameBtn &&
    appearanceDeleteBtn &&
    appearanceThemeName &&
    appearanceMakeActive &&
    appearanceLoginBoxWidthPercent &&
    appearanceLoginBoxHeightPercent &&
    appearanceLoginBoxOpacityPercent &&
    appearanceLoginBoxHoverOpacityPercent &&
    appearanceLoginBoxPosXPercent &&
    appearanceLoginBoxPosYPercent &&
    appearanceLogoSizePercent &&
    appearanceLogoOffsetXPercent &&
    appearanceLogoOffsetYPercent &&
    appearanceBackgroundZoomPercent &&
    appearanceLoginBoxModeDark &&
    appearanceLoginBoxModeLight,
);
const hasAssetPickerControls = Boolean(
  appearanceLogoDisplay &&
    appearanceLogoPath &&
    appearanceClosedBgDisplay &&
    appearanceClosedBgPath &&
    appearanceOpenBgDisplay &&
    appearanceOpenBgPath &&
    appearanceChooseLogoBtn &&
    appearanceChooseClosedBgBtn &&
    appearanceChooseOpenBgBtn &&
    appearanceAssetChooser &&
    appearanceAssetChooserTitle &&
    appearanceAssetChooserList &&
    appearanceAssetSelectBtn &&
    appearanceAssetCancelBtn,
);
const hasLegacyAppearancePicker = Boolean(
  appearanceLogoSelectLegacy &&
    appearanceClosedBgSelectLegacy &&
    appearanceOpenBgSelectLegacy,
);

let latestDiagnostics = null;
let latestTroubleshootReport = null;
let latestThemes = [];
let latestActiveThemeId = "";
let latestThemeAssets = { logos: [], backgrounds: [] };
let appearanceSelection = {
  logoPath: "",
  closedBackgroundPath: "",
  openBackgroundPath: "",
  loginBoxWidthPercent: THEME_LAYOUT_DEFAULTS.loginBoxWidthPercent,
  loginBoxHeightPercent: THEME_LAYOUT_DEFAULTS.loginBoxHeightPercent,
  loginBoxOpacityPercent: THEME_LAYOUT_DEFAULTS.loginBoxOpacityPercent,
  loginBoxHoverOpacityPercent: THEME_LAYOUT_DEFAULTS.loginBoxHoverOpacityPercent,
  loginBoxPosXPercent: THEME_LAYOUT_DEFAULTS.loginBoxPosXPercent,
  loginBoxPosYPercent: THEME_LAYOUT_DEFAULTS.loginBoxPosYPercent,
  logoSizePercent: THEME_LAYOUT_DEFAULTS.logoSizePercent,
  logoOffsetXPercent: THEME_LAYOUT_DEFAULTS.logoOffsetXPercent,
  logoOffsetYPercent: THEME_LAYOUT_DEFAULTS.logoOffsetYPercent,
  backgroundZoomPercent: THEME_LAYOUT_DEFAULTS.backgroundZoomPercent,
  loginBoxMode: THEME_LAYOUT_DEFAULTS.loginBoxMode,
};
let appearanceAssetChooserState = null;
let appearanceEditorMode = "hidden";
let appearanceEditingThemeId = "";
let latestUsers = [];
let selectedUserUsername = "";
let userEditorMode = "new";
let latestTlsPlan = "";
let latestConfigBackups = [];
const managerPluginState = {
  loaded: false,
  modules: [],
  refreshHandlers: [],
  styles: new Set(),
};

function bindClick(id, handler) {
  const element = document.getElementById(id);
  if (!element) {
    console.warn(`[manager-ui] missing #${id}; skipping click handler`);
    return false;
  }

  element.addEventListener("click", handler);
  return true;
}

function ensureThemeEditorFormControls() {
  if (!hasThemeEditorFormControls) {
    throw new Error(
      "Theme editor controls are missing in this admin UI build. Hard refresh the admin panel and retry.",
    );
  }
}

function setMessage(text, isError = false) {
  statusMessage.textContent = text;
  statusMessage.style.color = isError ? "#ff8a8a" : "#9be0ff";
}

function setDiagMessage(text, isError = false) {
  diagStatusMessage.textContent = text;
  diagStatusMessage.style.color = isError ? "#ff8a8a" : "#9be0ff";
}

function setTsMessage(text, isError = false) {
  tsStatusMessage.textContent = text;
  tsStatusMessage.style.color = isError ? "#ff8a8a" : "#9be0ff";
}

function setConfigBackupMessage(text, isError = false) {
  if (!configBackupStatusMessage) {
    return;
  }
  configBackupStatusMessage.textContent = text;
  configBackupStatusMessage.style.color = isError ? "#ff8a8a" : "#9be0ff";
}

function setAppearanceMessage(text, isError = false) {
  appearanceStatusMessage.textContent = text;
  appearanceStatusMessage.style.color = isError ? "#ff8a8a" : "#9be0ff";
}

function setUserMessage(text, isError = false) {
  if (!userStatusMessage) {
    return;
  }
  userStatusMessage.textContent = text;
  userStatusMessage.style.color = isError ? "#ff8a8a" : "#9be0ff";
}

function setTlsMessage(text, isError = false) {
  if (!tlsStatusMessage) {
    return;
  }
  tlsStatusMessage.textContent = text;
  tlsStatusMessage.style.color = isError ? "#ff8a8a" : "#9be0ff";
}

function toBooleanString(value) {
  return value ? "true" : "false";
}

function parseBooleanish(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function resolvePortalUrl(config = {}) {
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const configuredHost = String(config.HOST || "").trim();
  const configuredPort = String(config.PORT || "").trim();
  const host =
    !configuredHost || configuredHost === "0.0.0.0" || configuredHost === "::"
      ? window.location.hostname || "127.0.0.1"
      : configuredHost;
  const shouldIncludePort =
    configuredPort && !((protocol === "http:" && configuredPort === "80") || (protocol === "https:" && configuredPort === "443"));
  const portSegment = shouldIncludePort ? `:${configuredPort}` : "";
  return `${protocol}//${host}${portSegment}/`;
}

function clampThemeLayoutNumber(value, fallback, min, max) {
  const raw = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(raw)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, raw));
}

function normalizeLoginBoxMode(value) {
  return String(value || "").trim().toLowerCase() === "light" ? "light" : THEME_LAYOUT_DEFAULTS.loginBoxMode;
}

function toSecondsLabel(seconds) {
  if (!Number.isFinite(seconds)) {
    return "0s";
  }

  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) {
    return `${s}s`;
  }

  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) {
    return `${m}m ${rs}s`;
  }

  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function updateStatusCards(monitor) {
  const status = monitor?.status || {};
  const health = monitor?.health || {};

  document.getElementById("runningValue").textContent = status.running ? "Yes" : "No";
  document.getElementById("pidValue").textContent = status.pid || "-";
  document.getElementById("uptimeValue").textContent = toSecondsLabel(status.uptimeSeconds || 0);

  if (health.ok) {
    document.getElementById("healthValue").textContent = `Healthy (${health.statusCode})`;
  } else if (health.statusCode) {
    document.getElementById("healthValue").textContent = `Degraded (${health.statusCode})`;
  } else {
    document.getElementById("healthValue").textContent = "Unreachable";
  }

  document.getElementById("runtimeLogs").textContent = (monitor.runtimeLogLines || []).join("\n");
  document.getElementById("debugLogs").textContent = (monitor.debugLogLines || []).join("\n");
}

function fillForm(config) {
  const fields = form.querySelectorAll("input[name]");
  for (const field of fields) {
    if (field.name === "AUTH_PASSWORD") {
      field.value = "";
      continue;
    }

    field.value = config[field.name] || "";
  }

  const blastDoorsClosed = parseBooleanish(config.BLAST_DOORS_CLOSED);
  blastDoorsToggle.checked = blastDoorsClosed;
  blastDoorsClosedField.value = toBooleanString(blastDoorsClosed);
  blastDoorsState.textContent = blastDoorsClosed ? "Locked" : "Unlocked";
}

function buildConfigPayloadFromForm() {
  const payload = {};
  const fields = form.querySelectorAll("input[name]");
  for (const field of fields) {
    if (field.type === "checkbox") {
      payload[field.name] = toBooleanString(field.checked);
      continue;
    }

    payload[field.name] = String(field.value || "");
  }

  return payload;
}

async function saveConfig(payload, successMessage) {
  const result = await api("POST", "/config", payload);
  setMessage(successMessage);
  await refreshAll();
  return result;
}

function normalizeConfigValue(value) {
  if (typeof value === "boolean") {
    return toBooleanString(value);
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

async function saveConfigPatch(configPatch = {}, successMessage = "Configuration saved.") {
  const payload = {};
  for (const [key, value] of Object.entries(configPatch || {})) {
    payload[key] = normalizeConfigValue(value);
  }
  return await saveConfig(payload, successMessage);
}

function resolveManagerAssetUrl(assetPath) {
  return new URL(String(assetPath || ""), window.location.origin).toString();
}

function ensurePluginStylesheet(cssPath) {
  if (!cssPath) {
    return;
  }

  const href = resolveManagerAssetUrl(cssPath);
  if (managerPluginState.styles.has(href)) {
    return;
  }

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.pluginCss = "true";
  document.head.append(link);
  managerPluginState.styles.add(href);
}

function createPluginPanel({ pluginId, title, note = "", className = "" }) {
  if (!pluginPanelsContainer) {
    throw new Error("Plugin panel container is not available in this admin UI build.");
  }

  const root = document.createElement("section");
  root.className = `panel plugin-panel ${className}`.trim();
  root.dataset.pluginId = String(pluginId || "");

  const heading = document.createElement("h2");
  heading.textContent = String(title || pluginId || "Plugin");
  root.append(heading);

  if (note) {
    const noteEl = document.createElement("p");
    noteEl.className = "panel-note";
    noteEl.textContent = String(note);
    root.append(noteEl);
  }

  const statusEl = document.createElement("p");
  statusEl.className = "status-message";
  root.append(statusEl);

  const body = document.createElement("div");
  body.className = "plugin-panel-body";
  root.append(body);

  pluginPanelsContainer.append(root);

  return {
    root,
    body,
    statusEl,
    setStatus(message, isError = false) {
      statusEl.textContent = String(message || "");
      statusEl.style.color = isError ? "#ff8a8a" : "#9be0ff";
    },
  };
}

async function runPluginRefreshHandlers() {
  if (managerPluginState.refreshHandlers.length === 0) {
    return;
  }

  await Promise.all(
    managerPluginState.refreshHandlers.map(async ({ pluginId, onRefresh }) => {
      try {
        await onRefresh();
      } catch (error) {
        console.warn(`[manager-ui] plugin refresh failed (${pluginId}):`, error);
      }
    }),
  );
}

function buildPluginInitContext(pluginDef = {}) {
  return {
    pluginId: String(pluginDef.pluginId || ""),
    apiGet: async (routePath) => await api("GET", routePath),
    apiPost: async (routePath, body) => await api("POST", routePath, body || {}),
    saveConfigPatch,
    refreshManager: async () => {
      await refreshAll();
    },
    setGlobalMessage: setMessage,
    createPanel: (panelOptions = {}) =>
      createPluginPanel({
        pluginId: panelOptions.pluginId || pluginDef.pluginId || "",
        title: panelOptions.title || pluginDef.pluginId || "Plugin",
        note: panelOptions.note || "",
        className: panelOptions.className || "",
      }),
    copyToClipboard,
    resolveAssetUrl: resolveManagerAssetUrl,
  };
}

async function loadManagerPlugins() {
  if (managerPluginState.loaded) {
    return;
  }
  managerPluginState.loaded = true;

  if (!pluginPanelsContainer) {
    return;
  }

  let payload;
  try {
    payload = await api("GET", "/plugins/ui");
  } catch (error) {
    console.warn("[manager-ui] failed to load plugin manifest:", error);
    return;
  }

  const plugins = Array.isArray(payload?.plugins) ? payload.plugins : [];
  for (const pluginDef of plugins) {
    const pluginId = String(pluginDef?.pluginId || "").trim();
    const jsPath = String(pluginDef?.jsPath || "").trim();
    if (!pluginId || !jsPath) {
      continue;
    }

    try {
      ensurePluginStylesheet(pluginDef?.cssPath);
      const moduleUrl = resolveManagerAssetUrl(jsPath);
      const moduleExports = await import(moduleUrl);
      const register = moduleExports.registerManagerPlugin || moduleExports.default;
      if (typeof register !== "function") {
        console.warn(`[manager-ui] plugin '${pluginId}' has no registerManagerPlugin export`);
        continue;
      }

      const instance = (await register(buildPluginInitContext(pluginDef))) || {};
      if (typeof instance.onRefresh === "function") {
        managerPluginState.refreshHandlers.push({
          pluginId,
          onRefresh: instance.onRefresh,
        });
      }

      managerPluginState.modules.push({
        pluginId,
        dispose: typeof instance.dispose === "function" ? instance.dispose : null,
      });
    } catch (error) {
      console.warn(`[manager-ui] failed to initialize plugin '${pluginId}':`, error);
      try {
        const panel = createPluginPanel({
          pluginId,
          title: `Plugin Error: ${pluginId}`,
          note: "This plugin failed to load. Check manager console logs for details.",
          className: "plugin-panel-error",
        });
        panel.setStatus(error?.message || String(error), true);
      } catch (panelError) {
        console.warn("[manager-ui] failed to render plugin error panel:", panelError);
      }
    }
  }
}

async function api(method, routePath, body) {
  let lastError = null;

  for (let index = 0; index < API_BASE_CANDIDATES.length; index += 1) {
    const baseCandidate = API_BASE_CANDIDATES[index];
    const hasFallback = index < API_BASE_CANDIDATES.length - 1;

    try {
      const response = await fetch(resolveApiPath(baseCandidate, routePath), {
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
          const parseError = new Error(formatUnexpectedPayload(response, rawBody));
          if (hasFallback && response.status === 404) {
            lastError = parseError;
            continue;
          }

          throw parseError;
        }
      }

      if (!response.ok) {
        const requestError = new Error(payload.error || `Request failed (${response.status})`);
        if (hasFallback && response.status === 404) {
          lastError = requestError;
          continue;
        }

        throw requestError;
      }

      return payload;
    } catch (error) {
      if (hasFallback && error instanceof TypeError) {
        lastError = error;
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error("Request failed");
}

async function copyToClipboard(text) {
  if (!text) {
    throw new Error("No diagnostics generated yet.");
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const fallback = document.createElement("textarea");
  fallback.value = text;
  fallback.setAttribute("readonly", "readonly");
  fallback.style.position = "absolute";
  fallback.style.left = "-9999px";
  document.body.appendChild(fallback);
  fallback.select();
  document.execCommand("copy");
  document.body.removeChild(fallback);
}

function renderDiagnostics(payload) {
  latestDiagnostics = payload;
  diagSummary.textContent = payload.summary || "";
  diagJson.textContent = JSON.stringify(payload.report || {}, null, 2);
}

function formatCheckLine(check) {
  const status = String(check?.status || "info").toUpperCase();
  const detail = check?.detail || "";
  const recommendation = check?.recommendation ? ` Recommendation: ${check.recommendation}` : "";
  return `[${status}] ${check?.title || check?.id || "Check"}: ${detail}${recommendation}`;
}

function formatSafeActionLine(action) {
  return `- ${action.title} (${action.id}): ${action.description}`;
}

function formatGuidedActionLine(action) {
  return `- ${action.title} (${action.id}) [${action.riskLevel || "manual"}]: ${action.warning || action.description || ""}`;
}

function setPortproxyButtonState(report) {
  const isWsl = Boolean(report?.environment?.isWsl);
  const detectBtn = document.getElementById("tsPortproxyDetectBtn");
  const scriptBtn = document.getElementById("tsPortproxyScriptBtn");
  detectBtn.disabled = !isWsl;
  scriptBtn.disabled = !isWsl;
}

function renderTroubleshootReport(report) {
  latestTroubleshootReport = report;
  setPortproxyButtonState(report);

  const lines = [
    `Generated: ${report.generatedAt || "unknown"}`,
    `Runtime: ${report.environment?.platform || "unknown"} ${report.environment?.arch || "unknown"}${report.environment?.isWsl ? ` (WSL: ${report.environment?.wslDistro || "unknown"})` : ""}`,
    "",
    "Checks:",
    ...(report.checks || []).map(formatCheckLine),
    "",
    "Safe Actions:",
    ...(report.safeActions || []).map(formatSafeActionLine),
    "",
    "Guided Actions (manual review required):",
    ...(report.guidedActions || []).map(formatGuidedActionLine),
  ];

  tsHints.textContent = lines.join("\n");

  const defaultGuided = (report.guidedActions || []).find((entry) => entry.id === "guide.wsl2-portproxy-fix");
  tsScript.textContent =
    defaultGuided?.script ||
    "No guided script is required for this environment. Use Analyze System after environment changes.";
}

function formatActionOutputEntry(entry) {
  const status = entry.ok ? "OK" : "FAIL";
  const parts = [
    `[${status}] ${entry.label || entry.command || "Command"}`,
    entry.command ? `Command: ${entry.command}` : "",
    entry.statusCode ? `Status Code: ${entry.statusCode}` : "",
    entry.exitCode !== undefined && entry.exitCode !== null ? `Exit Code: ${entry.exitCode}` : "",
    entry.error ? `Error: ${entry.error}` : "",
    entry.stdout ? `STDOUT:\n${entry.stdout}` : "",
    entry.stderr ? `STDERR:\n${entry.stderr}` : "",
  ];

  return parts.filter(Boolean).join("\n");
}

function renderTroubleshootActionResult(result) {
  const lines = [
    `Action: ${result.title || result.actionId}`,
    `Generated: ${result.generatedAt || "unknown"}`,
    "",
    ...(result.outputs || []).map(formatActionOutputEntry),
  ];
  tsOutput.textContent = lines.join("\n\n");
}

function renderConfigBackupList(payload = {}, preferredBackupId = "") {
  latestConfigBackups = Array.isArray(payload.backups) ? payload.backups : [];
  if (!configBackupSelect) {
    return;
  }

  configBackupSelect.innerHTML = "";
  if (latestConfigBackups.length === 0) {
    configBackupSelect.disabled = true;
    configBackupSelect.append(optionMarkup("", "No backups found", true));
    return;
  }

  configBackupSelect.disabled = false;
  const targetId = preferredBackupId || latestConfigBackups[0].backupId || "";
  for (const backup of latestConfigBackups) {
    const label = `${backup.name || backup.backupId} (${backup.createdAt || "unknown"})`;
    configBackupSelect.append(optionMarkup(backup.backupId, label, backup.backupId === targetId));
  }
}

function getSelectedConfigBackupId() {
  if (!configBackupSelect || configBackupSelect.disabled) {
    return "";
  }
  return String(configBackupSelect.value || "");
}

function renderConfigBackupView(payload = {}) {
  if (!configBackupDetails) {
    return;
  }
  const backup = payload.backup || {};
  const files = Array.isArray(payload.files) ? payload.files : [];
  const lines = [
    `Backup: ${backup.name || backup.backupId || "unknown"}`,
    `Backup ID: ${backup.backupId || "unknown"}`,
    `Created: ${backup.createdAt || "unknown"}`,
    "",
  ];

  for (const file of files) {
    lines.push(`# ${file.relativePath} (${file.exists ? `${file.sizeBytes || 0} bytes` : "missing"})`);
    lines.push(file.content || "");
    lines.push("");
  }
  configBackupDetails.textContent = lines.join("\n");
}

async function refreshConfigBackups(showMessage = false) {
  if (!configBackupSelect) {
    return;
  }
  const currentId = getSelectedConfigBackupId();
  const payload = await api("GET", "/config-backups");
  renderConfigBackupList(payload, currentId);
  if (showMessage) {
    setConfigBackupMessage(`Loaded ${latestConfigBackups.length} backup(s).`);
  }
}

function optionMarkup(value, label, selected = false) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  option.selected = selected;
  return option;
}

function sortAssetsByName(assets) {
  return [...assets].sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || "")));
}

function fillAssetSelect(selectEl, assets, { allowEmpty, emptyLabel, required }) {
  if (!selectEl) {
    return;
  }

  selectEl.innerHTML = "";
  if (allowEmpty) {
    selectEl.append(optionMarkup("", emptyLabel, true));
  }

  for (const asset of assets) {
    selectEl.append(optionMarkup(asset.path, asset.name, !allowEmpty && selectEl.options.length === 0));
  }

  selectEl.required = Boolean(required);
  if (!allowEmpty && selectEl.options.length > 0 && !selectEl.value) {
    selectEl.value = selectEl.options[0].value;
  }
}

function fillThemeSelect(themes, activeThemeId, preferredThemeId = "") {
  appearanceThemeSelect.innerHTML = "";
  if (!themes.length) {
    appearanceThemeSelect.append(optionMarkup("", "No themes saved", true));
    appearanceThemeSelect.disabled = true;
    return;
  }

  appearanceThemeSelect.disabled = false;
  const effectiveSelectedId = preferredThemeId || activeThemeId || "";
  for (const theme of themes) {
    const selected = theme.id === effectiveSelectedId;
    appearanceThemeSelect.append(optionMarkup(theme.id, theme.name, selected));
  }
}

function setAppearanceSelection(nextSelection) {
  appearanceSelection = {
    logoPath: String(nextSelection?.logoPath || ""),
    closedBackgroundPath: String(nextSelection?.closedBackgroundPath || ""),
    openBackgroundPath: String(nextSelection?.openBackgroundPath || ""),
    loginBoxWidthPercent: clampThemeLayoutNumber(
      nextSelection?.loginBoxWidthPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxWidthPercent,
      20,
      100,
    ),
    loginBoxHeightPercent: clampThemeLayoutNumber(
      nextSelection?.loginBoxHeightPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxHeightPercent,
      20,
      100,
    ),
    loginBoxOpacityPercent: clampThemeLayoutNumber(
      nextSelection?.loginBoxOpacityPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxOpacityPercent,
      10,
      100,
    ),
    loginBoxHoverOpacityPercent: clampThemeLayoutNumber(
      nextSelection?.loginBoxHoverOpacityPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxHoverOpacityPercent,
      10,
      100,
    ),
    loginBoxPosXPercent: clampThemeLayoutNumber(
      nextSelection?.loginBoxPosXPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxPosXPercent,
      0,
      100,
    ),
    loginBoxPosYPercent: clampThemeLayoutNumber(
      nextSelection?.loginBoxPosYPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxPosYPercent,
      0,
      100,
    ),
    logoSizePercent: clampThemeLayoutNumber(
      nextSelection?.logoSizePercent,
      THEME_LAYOUT_DEFAULTS.logoSizePercent,
      30,
      100,
    ),
    logoOffsetXPercent: clampThemeLayoutNumber(
      nextSelection?.logoOffsetXPercent,
      THEME_LAYOUT_DEFAULTS.logoOffsetXPercent,
      0,
      100,
    ),
    logoOffsetYPercent: clampThemeLayoutNumber(
      nextSelection?.logoOffsetYPercent,
      THEME_LAYOUT_DEFAULTS.logoOffsetYPercent,
      0,
      100,
    ),
    backgroundZoomPercent: clampThemeLayoutNumber(
      nextSelection?.backgroundZoomPercent,
      THEME_LAYOUT_DEFAULTS.backgroundZoomPercent,
      50,
      200,
    ),
    loginBoxMode: normalizeLoginBoxMode(nextSelection?.loginBoxMode),
  };
}

function normalizeThemeForEditor(theme) {
  if (!theme || typeof theme !== "object") {
    return null;
  }

  return {
    id: String(theme.id || ""),
    name: String(theme.name || ""),
    logoPath: String(theme.logoPath || ""),
    closedBackgroundPath: String(theme.closedBackgroundPath || ""),
    openBackgroundPath: String(theme.openBackgroundPath || ""),
    loginBoxWidthPercent: clampThemeLayoutNumber(
      theme.loginBoxWidthPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxWidthPercent,
      20,
      100,
    ),
    loginBoxHeightPercent: clampThemeLayoutNumber(
      theme.loginBoxHeightPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxHeightPercent,
      20,
      100,
    ),
    loginBoxOpacityPercent: clampThemeLayoutNumber(
      theme.loginBoxOpacityPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxOpacityPercent,
      10,
      100,
    ),
    loginBoxHoverOpacityPercent: clampThemeLayoutNumber(
      theme.loginBoxHoverOpacityPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxHoverOpacityPercent,
      10,
      100,
    ),
    loginBoxPosXPercent: clampThemeLayoutNumber(
      theme.loginBoxPosXPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxPosXPercent,
      0,
      100,
    ),
    loginBoxPosYPercent: clampThemeLayoutNumber(
      theme.loginBoxPosYPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxPosYPercent,
      0,
      100,
    ),
    logoSizePercent: clampThemeLayoutNumber(theme.logoSizePercent, THEME_LAYOUT_DEFAULTS.logoSizePercent, 30, 100),
    logoOffsetXPercent: clampThemeLayoutNumber(
      theme.logoOffsetXPercent,
      THEME_LAYOUT_DEFAULTS.logoOffsetXPercent,
      0,
      100,
    ),
    logoOffsetYPercent: clampThemeLayoutNumber(
      theme.logoOffsetYPercent,
      THEME_LAYOUT_DEFAULTS.logoOffsetYPercent,
      0,
      100,
    ),
    backgroundZoomPercent: clampThemeLayoutNumber(
      theme.backgroundZoomPercent,
      THEME_LAYOUT_DEFAULTS.backgroundZoomPercent,
      50,
      200,
    ),
    loginBoxMode: normalizeLoginBoxMode(theme.loginBoxMode),
  };
}

function findSelectedThemeForEditor() {
  const selectedId = String(appearanceThemeSelect?.value || "");
  if (!selectedId) {
    return null;
  }

  const selectedTheme = latestThemes.find((theme) => theme.id === selectedId);
  return normalizeThemeForEditor(selectedTheme);
}

function setManageActionState() {
  if (!hasThemeEditorPanelControls || !appearanceRenameBtn || !appearanceDeleteBtn) {
    return;
  }

  const canManageExisting = appearanceEditorMode === "edit" && Boolean(appearanceEditingThemeId);
  appearanceRenameBtn.disabled = !canManageExisting;
  appearanceDeleteBtn.disabled = !canManageExisting;
}

function showAppearanceEditor(mode) {
  if (!hasThemeEditorPanelControls) {
    return;
  }

  appearanceEditorMode = mode;
  appearanceEditorSection.hidden = false;
  appearanceEditorSection.classList.remove("hidden");
  appearanceEditorHeading.textContent = mode === "edit" ? "Edit Existing Theme" : "Add New Theme";
  setManageActionState();
}

function hideAppearanceEditor() {
  if (!hasThemeEditorPanelControls) {
    return;
  }

  appearanceEditorMode = "hidden";
  appearanceEditingThemeId = "";
  if (hasAssetPickerControls) {
    closeAppearanceAssetPicker();
  }
  appearanceEditorSection.hidden = true;
  appearanceEditorSection.classList.add("hidden");
  setManageActionState();
}

function startNewThemeEditor() {
  if (!hasThemeEditorPanelControls) {
    throw new Error("Theme editor panel controls are missing in this admin UI build. Hard refresh and retry.");
  }
  ensureThemeEditorFormControls();

  appearanceEditingThemeId = "";
  appearanceThemeName.value = "";
  setAppearanceSelection({
    logoPath: "",
    closedBackgroundPath: "",
    openBackgroundPath: "",
    loginBoxWidthPercent: THEME_LAYOUT_DEFAULTS.loginBoxWidthPercent,
    loginBoxHeightPercent: THEME_LAYOUT_DEFAULTS.loginBoxHeightPercent,
    loginBoxOpacityPercent: THEME_LAYOUT_DEFAULTS.loginBoxOpacityPercent,
    loginBoxHoverOpacityPercent: THEME_LAYOUT_DEFAULTS.loginBoxHoverOpacityPercent,
    loginBoxPosXPercent: THEME_LAYOUT_DEFAULTS.loginBoxPosXPercent,
    loginBoxPosYPercent: THEME_LAYOUT_DEFAULTS.loginBoxPosYPercent,
    logoSizePercent: THEME_LAYOUT_DEFAULTS.logoSizePercent,
    logoOffsetXPercent: THEME_LAYOUT_DEFAULTS.logoOffsetXPercent,
    logoOffsetYPercent: THEME_LAYOUT_DEFAULTS.logoOffsetYPercent,
    backgroundZoomPercent: THEME_LAYOUT_DEFAULTS.backgroundZoomPercent,
    loginBoxMode: THEME_LAYOUT_DEFAULTS.loginBoxMode,
  });
  renderAppearanceSelection();
  appearanceMakeActive.checked = true;
  showAppearanceEditor("new");
}

function startManageThemeEditor() {
  if (!hasThemeEditorPanelControls) {
    throw new Error("Theme editor panel controls are missing in this admin UI build. Hard refresh and retry.");
  }
  ensureThemeEditorFormControls();

  const selectedTheme = findSelectedThemeForEditor();
  if (!selectedTheme) {
    throw new Error("Select a saved theme before choosing Manage Theme.");
  }

  appearanceEditingThemeId = selectedTheme.id;
  appearanceThemeName.value = selectedTheme.name;
  setAppearanceSelection({
    logoPath: selectedTheme.logoPath,
    closedBackgroundPath: selectedTheme.closedBackgroundPath,
    openBackgroundPath: selectedTheme.openBackgroundPath,
    loginBoxWidthPercent: selectedTheme.loginBoxWidthPercent,
    loginBoxHeightPercent: selectedTheme.loginBoxHeightPercent,
    loginBoxOpacityPercent: selectedTheme.loginBoxOpacityPercent,
    loginBoxHoverOpacityPercent: selectedTheme.loginBoxHoverOpacityPercent,
    loginBoxPosXPercent: selectedTheme.loginBoxPosXPercent,
    loginBoxPosYPercent: selectedTheme.loginBoxPosYPercent,
    logoSizePercent: selectedTheme.logoSizePercent,
    logoOffsetXPercent: selectedTheme.logoOffsetXPercent,
    logoOffsetYPercent: selectedTheme.logoOffsetYPercent,
    backgroundZoomPercent: selectedTheme.backgroundZoomPercent,
    loginBoxMode: selectedTheme.loginBoxMode,
  });
  renderAppearanceSelection();
  appearanceMakeActive.checked = selectedTheme.id === latestActiveThemeId;
  showAppearanceEditor("edit");
}

function renderAppearanceSelection() {
  if (!hasAssetPickerControls) {
    return;
  }

  const logo = appearanceSelection.logoPath || "";
  const closed = appearanceSelection.closedBackgroundPath || "";
  const open = appearanceSelection.openBackgroundPath || "";

  appearanceLogoPath.value = logo;
  appearanceClosedBgPath.value = closed;
  appearanceOpenBgPath.value = open;

  appearanceLogoDisplay.value = logo || "None";
  appearanceClosedBgDisplay.value = closed || "None";
  appearanceOpenBgDisplay.value = open || "None";

  if (appearanceLoginBoxWidthPercent) {
    appearanceLoginBoxWidthPercent.value = String(Math.round(appearanceSelection.loginBoxWidthPercent));
  }
  if (appearanceLoginBoxHeightPercent) {
    appearanceLoginBoxHeightPercent.value = String(Math.round(appearanceSelection.loginBoxHeightPercent));
  }
  if (appearanceLoginBoxOpacityPercent) {
    appearanceLoginBoxOpacityPercent.value = String(Math.round(appearanceSelection.loginBoxOpacityPercent));
  }
  if (appearanceLoginBoxHoverOpacityPercent) {
    appearanceLoginBoxHoverOpacityPercent.value = String(Math.round(appearanceSelection.loginBoxHoverOpacityPercent));
  }
  if (appearanceLoginBoxPosXPercent) {
    appearanceLoginBoxPosXPercent.value = String(Math.round(appearanceSelection.loginBoxPosXPercent));
  }
  if (appearanceLoginBoxPosYPercent) {
    appearanceLoginBoxPosYPercent.value = String(Math.round(appearanceSelection.loginBoxPosYPercent));
  }
  if (appearanceLogoSizePercent) {
    appearanceLogoSizePercent.value = String(Math.round(appearanceSelection.logoSizePercent));
  }
  if (appearanceLogoOffsetXPercent) {
    appearanceLogoOffsetXPercent.value = String(Math.round(appearanceSelection.logoOffsetXPercent));
  }
  if (appearanceLogoOffsetYPercent) {
    appearanceLogoOffsetYPercent.value = String(Math.round(appearanceSelection.logoOffsetYPercent));
  }
  if (appearanceBackgroundZoomPercent) {
    appearanceBackgroundZoomPercent.value = String(Math.round(appearanceSelection.backgroundZoomPercent));
  }
  if (appearanceLoginBoxWidthValue) {
    appearanceLoginBoxWidthValue.textContent = `${Math.round(appearanceSelection.loginBoxWidthPercent)}%`;
  }
  if (appearanceLoginBoxHeightValue) {
    appearanceLoginBoxHeightValue.textContent = `${Math.round(appearanceSelection.loginBoxHeightPercent)}%`;
  }
  if (appearanceLoginBoxOpacityValue) {
    appearanceLoginBoxOpacityValue.textContent = `${Math.round(appearanceSelection.loginBoxOpacityPercent)}%`;
  }
  if (appearanceLoginBoxHoverOpacityValue) {
    appearanceLoginBoxHoverOpacityValue.textContent = `${Math.round(appearanceSelection.loginBoxHoverOpacityPercent)}%`;
  }
  if (appearanceLoginBoxPosXValue) {
    appearanceLoginBoxPosXValue.textContent = `${Math.round(appearanceSelection.loginBoxPosXPercent)}%`;
  }
  if (appearanceLoginBoxPosYValue) {
    appearanceLoginBoxPosYValue.textContent = `${Math.round(appearanceSelection.loginBoxPosYPercent)}%`;
  }
  if (appearanceLogoSizeValue) {
    appearanceLogoSizeValue.textContent = `${Math.round(appearanceSelection.logoSizePercent)}%`;
  }
  if (appearanceLogoOffsetXValue) {
    appearanceLogoOffsetXValue.textContent = `${Math.round(appearanceSelection.logoOffsetXPercent)}%`;
  }
  if (appearanceLogoOffsetYValue) {
    appearanceLogoOffsetYValue.textContent = `${Math.round(appearanceSelection.logoOffsetYPercent)}%`;
  }
  if (appearanceBackgroundZoomValue) {
    appearanceBackgroundZoomValue.textContent = `${Math.round(appearanceSelection.backgroundZoomPercent)}%`;
  }
  if (appearanceLoginBoxModeDark && appearanceLoginBoxModeLight) {
    appearanceLoginBoxModeDark.checked = appearanceSelection.loginBoxMode === "dark";
    appearanceLoginBoxModeLight.checked = appearanceSelection.loginBoxMode === "light";
  }
}

function bindAppearanceRangeInput(input, key, min, max, fallback) {
  if (!input) {
    return;
  }

  input.addEventListener("input", () => {
    setAppearanceSelection({
      ...appearanceSelection,
      [key]: clampThemeLayoutNumber(input.value, fallback, min, max),
    });
    renderAppearanceSelection();
  });
}

function closeAppearanceAssetPicker() {
  if (!hasAssetPickerControls) {
    return;
  }

  appearanceAssetChooserState = null;
  appearanceAssetChooserList.innerHTML = "";
  appearanceAssetChooser.hidden = true;
  appearanceAssetChooser.classList.add("hidden");
}

function openAppearanceAssetPicker({ key, title, assets, allowNone, noneLabel }) {
  if (!hasAssetPickerControls) {
    setAppearanceMessage("Theme asset picker is unavailable in this cached UI. Hard refresh the admin panel.", true);
    return;
  }

  const sortedAssets = sortAssetsByName(assets || []);
  const options = [];
  if (allowNone) {
    options.push({
      path: "",
      name: noneLabel,
      url: "",
      isEmpty: true,
    });
  }

  for (const asset of sortedAssets) {
    options.push({
      path: String(asset.path || ""),
      name: String(asset.name || asset.path || ""),
      url: String(asset.url || ""),
      isEmpty: false,
    });
  }

  if (!options.length) {
    setAppearanceMessage("No assets were found for that selection.", true);
    return;
  }

  let selectedPath = appearanceSelection[key] || "";
  const hasSelectedPath = options.some((option) => option.path === selectedPath);
  if (!hasSelectedPath) {
    selectedPath = options[0].path;
  }

  appearanceAssetChooserState = { key };
  appearanceAssetChooserTitle.textContent = title;
  appearanceAssetChooserList.innerHTML = "";

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const row = document.createElement("label");
    row.className = "asset-option";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "appearanceAssetPickerChoice";
    radio.value = option.path;
    radio.checked = option.path === selectedPath;
    row.append(radio);

    if (option.url) {
      const preview = document.createElement("img");
      preview.className = "asset-option-preview";
      preview.src = option.url;
      preview.alt = option.name;
      row.append(preview);
    } else {
      const emptyPreview = document.createElement("span");
      emptyPreview.className = "asset-option-preview asset-option-preview-empty";
      emptyPreview.textContent = "None";
      row.append(emptyPreview);
    }

    const details = document.createElement("span");
    details.className = "asset-option-details";
    details.textContent = option.isEmpty ? option.name : `${option.name} (${option.path})`;
    row.append(details);

    appearanceAssetChooserList.append(row);
  }

  appearanceAssetChooser.hidden = false;
  appearanceAssetChooser.classList.remove("hidden");
}

function renderThemeCatalog(payload) {
  latestThemes = Array.isArray(payload.themes) ? payload.themes.map(normalizeThemeForEditor).filter(Boolean) : [];
  latestActiveThemeId = String(payload.activeThemeId || "");
  latestThemeAssets = {
    logos: sortAssetsByName(payload.assets?.logos || []),
    backgrounds: sortAssetsByName(payload.assets?.backgrounds || []),
  };

  const preferredThemeId = appearanceEditingThemeId || String(appearanceThemeSelect?.value || "");
  fillThemeSelect(payload.themes || [], payload.activeThemeId || "", preferredThemeId);

  if (hasThemeEditorPanelControls && hasThemeEditorFormControls && hasAssetPickerControls) {
    let nextSelection = { ...appearanceSelection };
    if (appearanceEditorMode === "edit" && appearanceEditingThemeId) {
      const matchingTheme = latestThemes.find((theme) => theme.id === appearanceEditingThemeId);
      if (matchingTheme) {
        nextSelection = {
          logoPath: matchingTheme.logoPath,
          closedBackgroundPath: matchingTheme.closedBackgroundPath,
          openBackgroundPath: matchingTheme.openBackgroundPath,
          loginBoxWidthPercent: matchingTheme.loginBoxWidthPercent,
          loginBoxHeightPercent: matchingTheme.loginBoxHeightPercent,
          loginBoxOpacityPercent: matchingTheme.loginBoxOpacityPercent,
          loginBoxHoverOpacityPercent: matchingTheme.loginBoxHoverOpacityPercent,
          loginBoxPosXPercent: matchingTheme.loginBoxPosXPercent,
          loginBoxPosYPercent: matchingTheme.loginBoxPosYPercent,
          logoSizePercent: matchingTheme.logoSizePercent,
          logoOffsetXPercent: matchingTheme.logoOffsetXPercent,
          logoOffsetYPercent: matchingTheme.logoOffsetYPercent,
          backgroundZoomPercent: matchingTheme.backgroundZoomPercent,
          loginBoxMode: matchingTheme.loginBoxMode,
        };
        appearanceThemeName.value = matchingTheme.name;
      }
    }

    const validLogo = latestThemeAssets.logos.some((asset) => asset.path === nextSelection.logoPath)
      ? nextSelection.logoPath
      : "";
    const validClosed = latestThemeAssets.backgrounds.some((asset) => asset.path === nextSelection.closedBackgroundPath)
      ? nextSelection.closedBackgroundPath
      : "";
    const validOpen = latestThemeAssets.backgrounds.some((asset) => asset.path === nextSelection.openBackgroundPath)
      ? nextSelection.openBackgroundPath
      : "";

    setAppearanceSelection({
      logoPath: validLogo,
      closedBackgroundPath: validClosed,
      openBackgroundPath: validOpen,
      loginBoxWidthPercent: nextSelection.loginBoxWidthPercent,
      loginBoxHeightPercent: nextSelection.loginBoxHeightPercent,
      loginBoxOpacityPercent: nextSelection.loginBoxOpacityPercent,
      loginBoxHoverOpacityPercent: nextSelection.loginBoxHoverOpacityPercent,
      loginBoxPosXPercent: nextSelection.loginBoxPosXPercent,
      loginBoxPosYPercent: nextSelection.loginBoxPosYPercent,
      logoSizePercent: nextSelection.logoSizePercent,
      logoOffsetXPercent: nextSelection.logoOffsetXPercent,
      logoOffsetYPercent: nextSelection.logoOffsetYPercent,
      backgroundZoomPercent: nextSelection.backgroundZoomPercent,
      loginBoxMode: nextSelection.loginBoxMode,
    });
    renderAppearanceSelection();
    closeAppearanceAssetPicker();
    return;
  }

  if (hasLegacyAppearancePicker) {
    fillAssetSelect(appearanceLogoSelectLegacy, latestThemeAssets.logos, {
      allowEmpty: true,
      emptyLabel: "No logo",
      required: false,
    });
    fillAssetSelect(appearanceClosedBgSelectLegacy, latestThemeAssets.backgrounds, {
      allowEmpty: false,
      emptyLabel: "",
      required: true,
    });
    fillAssetSelect(appearanceOpenBgSelectLegacy, latestThemeAssets.backgrounds, {
      allowEmpty: true,
      emptyLabel: "Same as closed background",
      required: false,
    });
    return;
  }

  if (hasThemeEditorPanelControls) {
    return;
  }

  throw new Error("Appearance panel controls are missing. Hard refresh the admin panel and try again.");
}

async function refreshThemes() {
  const payload = await api("GET", "/themes");
  renderThemeCatalog(payload);
}

function openAppearanceModal() {
  appearanceModal.hidden = false;
  appearanceModal.classList.remove("hidden");
}

function closeAppearanceModal() {
  if (hasThemeEditorPanelControls) {
    hideAppearanceEditor();
  }
  appearanceModal.hidden = true;
  appearanceModal.classList.add("hidden");
}

function buildAppearanceCreatePayload() {
  ensureThemeEditorFormControls();

  if (hasAssetPickerControls) {
    if (!appearanceSelection.closedBackgroundPath) {
      throw new Error("Choose a closed background before saving the theme.");
    }

    return {
      name: String(appearanceThemeName.value || ""),
      logoPath: String(appearanceSelection.logoPath || ""),
      closedBackgroundPath: String(appearanceSelection.closedBackgroundPath || ""),
      openBackgroundPath: String(appearanceSelection.openBackgroundPath || ""),
      loginBoxWidthPercent: Math.round(appearanceSelection.loginBoxWidthPercent),
      loginBoxHeightPercent: Math.round(appearanceSelection.loginBoxHeightPercent),
      loginBoxOpacityPercent: Math.round(appearanceSelection.loginBoxOpacityPercent),
      loginBoxHoverOpacityPercent: Math.round(appearanceSelection.loginBoxHoverOpacityPercent),
      loginBoxPosXPercent: Math.round(appearanceSelection.loginBoxPosXPercent),
      loginBoxPosYPercent: Math.round(appearanceSelection.loginBoxPosYPercent),
      logoSizePercent: Math.round(appearanceSelection.logoSizePercent),
      logoOffsetXPercent: Math.round(appearanceSelection.logoOffsetXPercent),
      logoOffsetYPercent: Math.round(appearanceSelection.logoOffsetYPercent),
      backgroundZoomPercent: Math.round(appearanceSelection.backgroundZoomPercent),
      loginBoxMode: normalizeLoginBoxMode(appearanceSelection.loginBoxMode),
      makeActive: toBooleanString(appearanceMakeActive.checked),
    };
  }

  if (hasLegacyAppearancePicker) {
    const closedPath = String(appearanceClosedBgSelectLegacy.value || "");
    if (!closedPath) {
      throw new Error("Choose a closed background before saving the theme.");
    }

    return {
      name: String(appearanceThemeName.value || ""),
      logoPath: String(appearanceLogoSelectLegacy.value || ""),
      closedBackgroundPath: closedPath,
      openBackgroundPath: String(appearanceOpenBgSelectLegacy.value || ""),
      loginBoxWidthPercent: clampThemeLayoutNumber(
        appearanceLoginBoxWidthPercent?.value,
        THEME_LAYOUT_DEFAULTS.loginBoxWidthPercent,
        20,
        100,
      ),
      loginBoxHeightPercent: clampThemeLayoutNumber(
        appearanceLoginBoxHeightPercent?.value,
        THEME_LAYOUT_DEFAULTS.loginBoxHeightPercent,
        20,
        100,
      ),
      loginBoxOpacityPercent: clampThemeLayoutNumber(
        appearanceLoginBoxOpacityPercent?.value,
        THEME_LAYOUT_DEFAULTS.loginBoxOpacityPercent,
        10,
        100,
      ),
      loginBoxHoverOpacityPercent: clampThemeLayoutNumber(
        appearanceLoginBoxHoverOpacityPercent?.value,
        THEME_LAYOUT_DEFAULTS.loginBoxHoverOpacityPercent,
        10,
        100,
      ),
      loginBoxPosXPercent: clampThemeLayoutNumber(
        appearanceLoginBoxPosXPercent?.value,
        THEME_LAYOUT_DEFAULTS.loginBoxPosXPercent,
        0,
        100,
      ),
      loginBoxPosYPercent: clampThemeLayoutNumber(
        appearanceLoginBoxPosYPercent?.value,
        THEME_LAYOUT_DEFAULTS.loginBoxPosYPercent,
        0,
        100,
      ),
      logoSizePercent: clampThemeLayoutNumber(
        appearanceLogoSizePercent?.value,
        THEME_LAYOUT_DEFAULTS.logoSizePercent,
        30,
        100,
      ),
      logoOffsetXPercent: clampThemeLayoutNumber(
        appearanceLogoOffsetXPercent?.value,
        THEME_LAYOUT_DEFAULTS.logoOffsetXPercent,
        0,
        100,
      ),
      logoOffsetYPercent: clampThemeLayoutNumber(
        appearanceLogoOffsetYPercent?.value,
        THEME_LAYOUT_DEFAULTS.logoOffsetYPercent,
        0,
        100,
      ),
      backgroundZoomPercent: clampThemeLayoutNumber(
        appearanceBackgroundZoomPercent?.value,
        THEME_LAYOUT_DEFAULTS.backgroundZoomPercent,
        50,
        200,
      ),
      loginBoxMode: normalizeLoginBoxMode(
        appearanceLoginBoxModeLight?.checked ? "light" : appearanceLoginBoxModeDark?.checked ? "dark" : "",
      ),
      makeActive: toBooleanString(appearanceMakeActive.checked),
    };
  }

  throw new Error("Appearance panel controls are missing. Hard refresh the admin panel and try again.");
}

function getSelectedUserFilter() {
  const selected = userFilterInputs.find((input) => input.checked);
  return selected ? selected.value : "active";
}

function formatUserDate(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "-";
  }
  return date.toLocaleString();
}

function findUserByUsername(username) {
  const target = String(username || "");
  return latestUsers.find((entry) => String(entry.username || "") === target) || null;
}

function openUserModal() {
  if (!userModal) {
    return;
  }
  userModal.hidden = false;
  userModal.classList.remove("hidden");
}

function closeUserModal() {
  if (!userModal) {
    return;
  }
  userModal.hidden = true;
  userModal.classList.add("hidden");
}

function clearUserEditor() {
  selectedUserUsername = "";
  userEditorMode = "new";
  if (userEditorHeading) {
    userEditorHeading.textContent = "Add New User";
  }
  if (userFriendlyName) {
    userFriendlyName.value = "";
  }
  if (userUsername) {
    userUsername.value = "";
    userUsername.readOnly = false;
  }
  if (userEmail) {
    userEmail.value = "";
  }
  if (userPassword) {
    userPassword.value = "";
  }
  if (userStatus) {
    userStatus.value = "active";
  }
  if (userDisplayInfo) {
    userDisplayInfo.value = "";
  }
  if (userNotes) {
    userNotes.value = "";
  }
  if (userLastLoginAt) {
    userLastLoginAt.value = "";
  }
  if (userLastKnownIp) {
    userLastKnownIp.value = "";
  }
  if (userBanReinstateBtn) {
    userBanReinstateBtn.textContent = "Ban / Reinstate";
  }
}

function loadUserEditor(user) {
  if (!user) {
    clearUserEditor();
    return;
  }
  selectedUserUsername = String(user.username || "");
  userEditorMode = "edit";
  if (userEditorHeading) {
    userEditorHeading.textContent = `Manage User: ${selectedUserUsername}`;
  }
  if (userFriendlyName) {
    userFriendlyName.value = String(user.friendlyName || "");
  }
  if (userUsername) {
    userUsername.value = selectedUserUsername;
    userUsername.readOnly = true;
  }
  if (userEmail) {
    userEmail.value = String(user.email || "");
  }
  if (userPassword) {
    userPassword.value = "";
  }
  if (userStatus) {
    userStatus.value = String(user.status || "active");
  }
  if (userDisplayInfo) {
    userDisplayInfo.value = String(user.displayInfo || "");
  }
  if (userNotes) {
    userNotes.value = String(user.notes || "");
  }
  if (userLastLoginAt) {
    userLastLoginAt.value = user.lastLoginAt ? formatUserDate(user.lastLoginAt) : "";
  }
  if (userLastKnownIp) {
    userLastKnownIp.value = String(user.lastKnownIp || "");
  }
  if (userBanReinstateBtn) {
    userBanReinstateBtn.textContent = user.status === "active" ? "Ban User" : "Reinstate User";
  }
}

function buildUserPayloadFromForm() {
  return {
    username: String(userUsername?.value || ""),
    password: String(userPassword?.value || ""),
    friendlyName: String(userFriendlyName?.value || ""),
    email: String(userEmail?.value || ""),
    status: String(userStatus?.value || "active"),
    displayInfo: String(userDisplayInfo?.value || ""),
    notes: String(userNotes?.value || ""),
  };
}

function buildUserRowActionButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function renderUserTable(users) {
  if (!userTableBody) {
    return;
  }
  userTableBody.innerHTML = "";

  if (!Array.isArray(users) || users.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No users found for this filter.";
    row.append(cell);
    userTableBody.append(row);
    return;
  }

  for (const user of users) {
    const row = document.createElement("tr");
    const userCell = document.createElement("td");
    userCell.textContent = `${user.friendlyName || user.username} (${user.username})`;
    row.append(userCell);

    const statusCell = document.createElement("td");
    statusCell.textContent = user.authenticatedNow
      ? `${user.status} / authenticated`
      : user.status;
    row.append(statusCell);

    const lastLoginCell = document.createElement("td");
    lastLoginCell.textContent = formatUserDate(user.lastLoginAt);
    row.append(lastLoginCell);

    const lastIpCell = document.createElement("td");
    lastIpCell.textContent = user.lastKnownIp || "-";
    row.append(lastIpCell);

    const actionsCell = document.createElement("td");
    actionsCell.className = "actions-cell";
    const actions = document.createElement("div");
    actions.className = "user-row-actions";
    actions.append(
      buildUserRowActionButton("Manage", () => {
        loadUserEditor(user);
      }),
      buildUserRowActionButton("Reset Code", async () => {
        try {
          const payload = await api("POST", "/users/reset-login-code", {
            username: user.username,
            delivery: "email",
          });
          userTempCodeBox.textContent = [
            `Temporary code for ${user.username}`,
            `Code: ${payload.code || ""}`,
            `Expires: ${formatUserDate(payload.expiresAt)}`,
            payload.warning || "",
          ]
            .filter(Boolean)
            .join("\n");
          setUserMessage(`Temporary login code created for ${user.username}.`);
          await refreshUsers(false);
        } catch (error) {
          setUserMessage(error.message || String(error), true);
        }
      }),
      buildUserRowActionButton("Invalidate", async () => {
        try {
          await api("POST", "/users/invalidate-token", {
            username: user.username,
          });
          setUserMessage(`Session tokens invalidated for ${user.username}.`);
          await refreshUsers(false);
        } catch (error) {
          setUserMessage(error.message || String(error), true);
        }
      }),
    );
    actionsCell.append(actions);
    row.append(actionsCell);
    userTableBody.append(row);
  }
}

async function refreshUsers(showMessage = true) {
  const view = getSelectedUserFilter();
  const payload = await api("GET", `/users?view=${encodeURIComponent(view)}`);
  latestUsers = Array.isArray(payload.users) ? payload.users : [];
  renderUserTable(latestUsers);

  if (selectedUserUsername) {
    const selected = findUserByUsername(selectedUserUsername);
    if (selected) {
      loadUserEditor(selected);
    } else {
      clearUserEditor();
    }
  }

  if (showMessage) {
    setUserMessage(`Loaded ${latestUsers.length} user(s) for '${view}' view.`);
  }
}

function openTlsModal() {
  if (!tlsModal) {
    return;
  }
  tlsModal.hidden = false;
  tlsModal.classList.remove("hidden");
}

function closeTlsModal() {
  if (!tlsModal) {
    return;
  }
  tlsModal.hidden = true;
  tlsModal.classList.add("hidden");
}

function buildTlsPayload() {
  return {
    tlsEnabled: Boolean(tlsEnabled?.checked),
    tlsDomain: String(tlsDomain?.value || ""),
    tlsEmail: String(tlsEmail?.value || ""),
    tlsChallengeMethod: String(tlsChallengeMethod?.value || "webroot"),
    tlsWebrootPath: String(tlsWebrootPath?.value || ""),
    tlsCertFile: String(tlsCertFile?.value || ""),
    tlsKeyFile: String(tlsKeyFile?.value || ""),
    tlsCaFile: String(tlsCaFile?.value || ""),
    tlsPassphrase: String(tlsPassphrase?.value || ""),
  };
}

function fillTlsForm(payload = {}) {
  if (tlsEnabled) {
    tlsEnabled.checked = Boolean(payload.tlsEnabled);
  }
  if (tlsDomain) {
    tlsDomain.value = String(payload.tlsDomain || "");
  }
  if (tlsEmail) {
    tlsEmail.value = String(payload.tlsEmail || "");
  }
  if (tlsChallengeMethod) {
    tlsChallengeMethod.value = String(payload.tlsChallengeMethod || "webroot");
  }
  if (tlsWebrootPath) {
    tlsWebrootPath.value = String(payload.tlsWebrootPath || "/var/www/html");
  }
  if (tlsCertFile) {
    tlsCertFile.value = String(payload.tlsCertFile || "");
  }
  if (tlsKeyFile) {
    tlsKeyFile.value = String(payload.tlsKeyFile || "");
  }
  if (tlsCaFile) {
    tlsCaFile.value = String(payload.tlsCaFile || "");
  }
  if (tlsPassphrase) {
    tlsPassphrase.value = "";
  }
}

function renderTlsDetection(detection = {}) {
  if (!tlsDetectionOutput) {
    return;
  }
  const lines = [
    `certbot available: ${detection.certbotAvailable ? "yes" : "no"}`,
    `docker available: ${detection.dockerAvailable ? "yes" : "no"}`,
    `openssl available: ${detection.opensslAvailable ? "yes" : "no"}`,
    `cert file present: ${detection.certExists ? "yes" : "no"}`,
    `key file present: ${detection.keyExists ? "yes" : "no"}`,
    detection.certbotVersion ? `certbot: ${detection.certbotVersion}` : "",
    detection.dockerVersion ? `docker: ${detection.dockerVersion}` : "",
    detection.opensslVersion ? `openssl: ${detection.opensslVersion}` : "",
  ].filter(Boolean);
  tlsDetectionOutput.textContent = lines.join("\n");
}

function renderTlsPlan(plan = {}) {
  if (!tlsPlanOutput) {
    return;
  }
  const lines = [
    "Steps:",
    ...(plan.steps || []),
    "",
    "Install Hints:",
    ...(plan.certbotInstallHints || []),
    "",
    "Issue Certificate:",
    ...(plan.commands || []),
    "",
    "Blastdoor .env Preview:",
    ...(plan.envPreview || []),
    "",
    "Renewal:",
    ...(plan.renew || []),
    "",
    "Notes:",
    ...(plan.notes || []),
  ];
  latestTlsPlan = lines.join("\n");
  tlsPlanOutput.textContent = latestTlsPlan;
}

async function refreshTlsPanel(showMessage = true) {
  const payload = await api("GET", "/tls");
  fillTlsForm(payload.tls || {});
  renderTlsDetection(payload.detection || {});
  if (showMessage) {
    setTlsMessage("TLS status loaded.");
  }
}

async function refreshAll() {
  try {
    const [configResult, monitorResult] = await Promise.all([api("GET", "/config"), api("GET", "/monitor")]);
    fillForm(configResult.config);
    updateStatusCards(monitorResult);
    await runPluginRefreshHandlers();
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
}

if (form) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = buildConfigPayloadFromForm();

    try {
      await saveConfig(payload, "Configuration saved.");
    } catch (error) {
      setMessage(error.message || String(error), true);
    }
  });
} else {
  console.warn("[manager-ui] missing #configForm; skipping config submit binding");
}

if (blastDoorsToggle && blastDoorsClosedField && blastDoorsState) {
  blastDoorsToggle.addEventListener("change", async () => {
    const closed = blastDoorsToggle.checked;
    blastDoorsClosedField.value = toBooleanString(closed);
    blastDoorsState.textContent = closed ? "Locked" : "Unlocked";

    const payload = buildConfigPayloadFromForm();
    try {
      const result = await saveConfig(
        payload,
        closed ? "Blast doors locked." : "Blast doors unlocked.",
      );
      const serviceRestarted = Boolean(result?.runtime?.serviceRestarted);
      const sessionSecretRotated = Boolean(result?.runtime?.sessionSecretRotated);
      if (closed) {
        setMessage(
          serviceRestarted
            ? sessionSecretRotated
              ? "Blast doors locked. Gateway restarted, lockout is active, and all sessions were invalidated."
              : "Blast doors locked. Gateway was restarted and lockout is active."
            : sessionSecretRotated
              ? "Blast doors locked and all sessions were invalidated. Restart gateway service if lockout is not active yet."
              : "Blast doors locked. Restart gateway service to enforce lockout.",
        );
      } else {
        setMessage(
          serviceRestarted
            ? "Blast doors unlocked. Gateway was restarted and routing is restored."
            : "Blast doors unlocked. Start/restart the gateway service if routing is still blocked.",
        );
      }
    } catch (error) {
      setMessage(error.message || String(error), true);
      await refreshAll();
    }
  });
} else {
  console.warn("[manager-ui] missing blast doors controls; skipping blast doors binding");
}

bindClick("startBtn", async () => {
  try {
    await api("POST", "/start");
    setMessage("Blastdoor start signal sent.");
    await refreshAll();
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
});

bindClick("stopBtn", async () => {
  try {
    await api("POST", "/stop");
    setMessage("Blastdoor stop signal sent.");
    await refreshAll();
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
});

bindClick("restartBtn", async () => {
  try {
    await api("POST", "/restart");
    setMessage("Blastdoor restart signal sent.");
    await refreshAll();
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
});

bindClick("revokeSessionsBtn", async () => {
  try {
    const result = await api("POST", "/sessions/revoke-all");
    setMessage(
      result?.serviceRestarted
        ? "All sessions were revoked (SESSION_SECRET rotated). Gateway restarted."
        : "All sessions were revoked (SESSION_SECRET rotated). Restart gateway to enforce immediately.",
    );
    await refreshAll();
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
});

bindClick("refreshBtn", async () => {
  await refreshAll();
  setMessage("Status refreshed.");
});

bindClick("openPortalBtn", async () => {
  try {
    let config = buildConfigPayloadFromForm();
    if (!config.HOST || !config.PORT) {
      const configResult = await api("GET", "/config");
      config = configResult.config || config;
    }

    const portalUrl = resolvePortalUrl(config);
    const newWindow = window.open(portalUrl, "_blank", "noopener,noreferrer");
    if (!newWindow) {
      throw new Error(`Popup blocked while opening ${portalUrl}`);
    }

    setMessage(`Opened Blastdoor portal: ${portalUrl}`);
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
});

bindClick("appearanceBtn", async () => {
  if (!appearanceModal.hidden) {
    closeAppearanceModal();
    setAppearanceMessage("Appearance panel closed.");
    return;
  }

  openAppearanceModal();
  setAppearanceMessage("Loading themes...");
  try {
    await refreshThemes();
    if (hasThemeEditorPanelControls) {
      hideAppearanceEditor();
    }
    setAppearanceMessage("Theme catalog loaded.");
  } catch (error) {
    setAppearanceMessage(error.message || String(error), true);
  }
});

bindClick("appearanceCloseBtn", () => {
  closeAppearanceModal();
});

if (appearanceCancelBtn) {
  appearanceCancelBtn.addEventListener("click", () => {
    if (hasThemeEditorPanelControls) {
      hideAppearanceEditor();
      setAppearanceMessage("Theme editor hidden.");
      return;
    }

    closeAppearanceModal();
  });
}

if (appearanceNewBtn) {
  appearanceNewBtn.addEventListener("click", () => {
    try {
      startNewThemeEditor();
      setAppearanceMessage("Add New Theme mode.");
    } catch (error) {
      setAppearanceMessage(error.message || String(error), true);
    }
  });
}

if (appearanceEditBtn) {
  appearanceEditBtn.addEventListener("click", () => {
    try {
      startManageThemeEditor();
      setAppearanceMessage("Manage Theme mode.");
    } catch (error) {
      setAppearanceMessage(error.message || String(error), true);
    }
  });
}

if (hasThemeEditorFormControls && appearanceRenameBtn) {
  appearanceRenameBtn.addEventListener("click", async () => {
    try {
      if (appearanceEditorMode !== "edit" || !appearanceEditingThemeId) {
        throw new Error("Open Manage Theme for a selected theme before renaming.");
      }

      const name = String(appearanceThemeName.value || "").trim();
      if (!name) {
        throw new Error("Theme name is required.");
      }

      const payload = await api("POST", "/themes/rename", {
        themeId: appearanceEditingThemeId,
        name,
      });
      renderThemeCatalog(payload);
      setAppearanceMessage("Theme renamed.");
    } catch (error) {
      setAppearanceMessage(error.message || String(error), true);
    }
  });
}

if (hasThemeEditorFormControls && appearanceDeleteBtn) {
  appearanceDeleteBtn.addEventListener("click", async () => {
    try {
      if (appearanceEditorMode !== "edit" || !appearanceEditingThemeId) {
        throw new Error("Open Manage Theme for a selected theme before deleting.");
      }

      const selectedTheme = findSelectedThemeForEditor();
      const themeLabel = selectedTheme?.name || appearanceEditingThemeId;
      const confirmed = window.confirm(`Delete theme '${themeLabel}'? This cannot be undone.`);
      if (!confirmed) {
        return;
      }

      const payload = await api("POST", "/themes/delete", {
        themeId: appearanceEditingThemeId,
      });
      renderThemeCatalog(payload);
      hideAppearanceEditor();
      setAppearanceMessage("Theme deleted.");
    } catch (error) {
      setAppearanceMessage(error.message || String(error), true);
    }
  });
}

if (hasThemeEditorFormControls) {
  bindAppearanceRangeInput(
    appearanceLoginBoxWidthPercent,
    "loginBoxWidthPercent",
    20,
    100,
    THEME_LAYOUT_DEFAULTS.loginBoxWidthPercent,
  );
  bindAppearanceRangeInput(
    appearanceLoginBoxHeightPercent,
    "loginBoxHeightPercent",
    20,
    100,
    THEME_LAYOUT_DEFAULTS.loginBoxHeightPercent,
  );
  bindAppearanceRangeInput(
    appearanceLoginBoxOpacityPercent,
    "loginBoxOpacityPercent",
    10,
    100,
    THEME_LAYOUT_DEFAULTS.loginBoxOpacityPercent,
  );
  bindAppearanceRangeInput(
    appearanceLoginBoxHoverOpacityPercent,
    "loginBoxHoverOpacityPercent",
    10,
    100,
    THEME_LAYOUT_DEFAULTS.loginBoxHoverOpacityPercent,
  );
  bindAppearanceRangeInput(
    appearanceLoginBoxPosXPercent,
    "loginBoxPosXPercent",
    0,
    100,
    THEME_LAYOUT_DEFAULTS.loginBoxPosXPercent,
  );
  bindAppearanceRangeInput(
    appearanceLoginBoxPosYPercent,
    "loginBoxPosYPercent",
    0,
    100,
    THEME_LAYOUT_DEFAULTS.loginBoxPosYPercent,
  );
  bindAppearanceRangeInput(
    appearanceLogoSizePercent,
    "logoSizePercent",
    30,
    100,
    THEME_LAYOUT_DEFAULTS.logoSizePercent,
  );
  bindAppearanceRangeInput(
    appearanceLogoOffsetXPercent,
    "logoOffsetXPercent",
    0,
    100,
    THEME_LAYOUT_DEFAULTS.logoOffsetXPercent,
  );
  bindAppearanceRangeInput(
    appearanceLogoOffsetYPercent,
    "logoOffsetYPercent",
    0,
    100,
    THEME_LAYOUT_DEFAULTS.logoOffsetYPercent,
  );
  bindAppearanceRangeInput(
    appearanceBackgroundZoomPercent,
    "backgroundZoomPercent",
    50,
    200,
    THEME_LAYOUT_DEFAULTS.backgroundZoomPercent,
  );

  appearanceLoginBoxModeDark.addEventListener("change", () => {
    if (!appearanceLoginBoxModeDark.checked) {
      return;
    }

    setAppearanceSelection({
      ...appearanceSelection,
      loginBoxMode: "dark",
    });
    renderAppearanceSelection();
  });

  appearanceLoginBoxModeLight.addEventListener("change", () => {
    if (!appearanceLoginBoxModeLight.checked) {
      return;
    }

    setAppearanceSelection({
      ...appearanceSelection,
      loginBoxMode: "light",
    });
    renderAppearanceSelection();
  });
}

if (hasAssetPickerControls) {
  appearanceChooseLogoBtn.addEventListener("click", () => {
    openAppearanceAssetPicker({
      key: "logoPath",
      title: "Choose Logo",
      assets: latestThemeAssets.logos,
      allowNone: true,
      noneLabel: "None",
    });
  });

  appearanceChooseClosedBgBtn.addEventListener("click", () => {
    openAppearanceAssetPicker({
      key: "closedBackgroundPath",
      title: "Choose Closed Background",
      assets: latestThemeAssets.backgrounds,
      allowNone: false,
      noneLabel: "",
    });
  });

  appearanceChooseOpenBgBtn.addEventListener("click", () => {
    openAppearanceAssetPicker({
      key: "openBackgroundPath",
      title: "Choose Open Background",
      assets: latestThemeAssets.backgrounds,
      allowNone: true,
      noneLabel: "None",
    });
  });

  appearanceAssetSelectBtn.addEventListener("click", () => {
    if (!appearanceAssetChooserState?.key) {
      closeAppearanceAssetPicker();
      return;
    }

    const selected = appearanceAssetChooserList.querySelector("input[name='appearanceAssetPickerChoice']:checked");
    if (!selected) {
      setAppearanceMessage("Choose an asset before confirming.", true);
      return;
    }

    setAppearanceSelection({
      ...appearanceSelection,
      [appearanceAssetChooserState.key]: String(selected.value || ""),
    });
    renderAppearanceSelection();
    closeAppearanceAssetPicker();
    setAppearanceMessage("Asset selection updated.");
  });

  appearanceAssetCancelBtn.addEventListener("click", () => {
    closeAppearanceAssetPicker();
  });
}

bindClick("appearanceApplyBtn", async () => {
  try {
    if (appearanceThemeSelect.disabled || !appearanceThemeSelect.value) {
      throw new Error("No saved theme is available to apply.");
    }

    const payload = await api("POST", "/themes/apply", { themeId: appearanceThemeSelect.value });
    renderThemeCatalog(payload);
    setAppearanceMessage("Theme applied. Refresh /login to preview.");
  } catch (error) {
    setAppearanceMessage(error.message || String(error), true);
  }
});

if (appearanceForm) {
  appearanceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = buildAppearanceCreatePayload();
      if (hasThemeEditorPanelControls && appearanceEditorMode === "edit") {
        if (!appearanceEditingThemeId) {
          throw new Error("No theme is selected for editing.");
        }

        const updated = await api("POST", "/themes/update", {
          ...payload,
          themeId: appearanceEditingThemeId,
        });
        renderThemeCatalog(updated);
        setAppearanceMessage("Theme updated.");
        return;
      }

      const created = await api("POST", "/themes/create", payload);
      renderThemeCatalog(created);
      if (hasThemeEditorPanelControls) {
        startNewThemeEditor();
      } else if (appearanceThemeName && appearanceMakeActive) {
        appearanceThemeName.value = "";
        appearanceMakeActive.checked = true;
      }
      setAppearanceMessage("Theme saved.");
    } catch (error) {
      setAppearanceMessage(error.message || String(error), true);
    }
  });
}

bindClick("diagGenerateBtn", async () => {
  try {
    const payload = await api("GET", "/diagnostics");
    renderDiagnostics(payload);
    setDiagMessage("Diagnostics generated.");
  } catch (error) {
    setDiagMessage(error.message || String(error), true);
  }
});

bindClick("diagCopySummaryBtn", async () => {
  try {
    await copyToClipboard(latestDiagnostics?.summary || "");
    setDiagMessage("Summary copied.");
  } catch (error) {
    setDiagMessage(error.message || String(error), true);
  }
});

bindClick("diagCopyJsonBtn", async () => {
  try {
    await copyToClipboard(latestDiagnostics ? JSON.stringify(latestDiagnostics.report || {}, null, 2) : "");
    setDiagMessage("JSON copied.");
  } catch (error) {
    setDiagMessage(error.message || String(error), true);
  }
});

bindClick("tsAnalyzeBtn", async () => {
  try {
    const payload = await api("GET", "/troubleshoot");
    renderTroubleshootReport(payload.report || {});
    setTsMessage("Troubleshooting analysis complete.");
  } catch (error) {
    setTsMessage(error.message || String(error), true);
  }
});

async function runTroubleshootAction(actionId, successMessage) {
  try {
    const payload = await api("POST", "/troubleshoot/run", { actionId });
    renderTroubleshootActionResult(payload.result || {});
    setTsMessage(successMessage);
  } catch (error) {
    setTsMessage(error.message || String(error), true);
  }
}

bindClick("tsSnapshotBtn", async () => {
  await runTroubleshootAction("snapshot.network", "Network snapshot complete.");
});

bindClick("tsGatewayBtn", async () => {
  await runTroubleshootAction("check.gateway-local", "Gateway access checks complete.");
});

bindClick("tsPortproxyDetectBtn", async () => {
  await runTroubleshootAction("detect.wsl-portproxy", "WSL2 portproxy detection complete.");
});

bindClick("tsPortproxyScriptBtn", async () => {
  try {
    if (!latestTroubleshootReport) {
      const payload = await api("GET", "/troubleshoot");
      renderTroubleshootReport(payload.report || {});
    }

    const action = (latestTroubleshootReport?.guidedActions || []).find((entry) => entry.id === "guide.wsl2-portproxy-fix");
    if (!action?.script) {
      setTsMessage("No guided script is needed for this environment.");
      return;
    }

    tsScript.textContent = action.script;
    setTsMessage("Guided script loaded. Review carefully before applying.");
  } catch (error) {
    setTsMessage(error.message || String(error), true);
  }
});

bindClick("tsCopyScriptBtn", async () => {
  try {
    await copyToClipboard(tsScript.textContent || "");
    setTsMessage("Guided script copied.");
  } catch (error) {
    setTsMessage(error.message || String(error), true);
  }
});

bindClick("configBackupRefreshBtn", async () => {
  try {
    await refreshConfigBackups(true);
  } catch (error) {
    setConfigBackupMessage(error.message || String(error), true);
  }
});

bindClick("configBackupCreateBtn", async () => {
  try {
    const payload = await api("POST", "/config-backups/create", {
      name: String(configBackupName?.value || ""),
    });
    renderConfigBackupList(payload, payload.backup?.backupId || "");
    if (configBackupName) {
      configBackupName.value = "";
    }
    setConfigBackupMessage(`Backup created: ${payload.backup?.backupId || "unknown"}.`);
  } catch (error) {
    setConfigBackupMessage(error.message || String(error), true);
  }
});

bindClick("configBackupViewBtn", async () => {
  try {
    const backupId = getSelectedConfigBackupId();
    if (!backupId) {
      throw new Error("Select a backup to view.");
    }
    const payload = await api("GET", `/config-backups/view?backupId=${encodeURIComponent(backupId)}`);
    renderConfigBackupView(payload);
    setConfigBackupMessage(`Loaded backup view for ${backupId}.`);
  } catch (error) {
    setConfigBackupMessage(error.message || String(error), true);
  }
});

bindClick("configBackupRestoreBtn", async () => {
  try {
    const backupId = getSelectedConfigBackupId();
    if (!backupId) {
      throw new Error("Select a backup to restore.");
    }
    if (!window.confirm(`Restore configuration from backup '${backupId}'?`)) {
      return;
    }

    const payload = await api("POST", "/config-backups/restore", {
      backupId,
    });
    renderConfigBackupList(payload, backupId);
    await refreshAll();
    setConfigBackupMessage(
      payload.result?.serviceRestarted
        ? `Backup restored (${backupId}) and service restarted.`
        : `Backup restored (${backupId}). Restart service if needed.`,
    );
  } catch (error) {
    setConfigBackupMessage(error.message || String(error), true);
  }
});

bindClick("configBackupDeleteBtn", async () => {
  try {
    const backupId = getSelectedConfigBackupId();
    if (!backupId) {
      throw new Error("Select a backup to delete.");
    }
    if (!window.confirm(`Delete backup '${backupId}'? This cannot be undone.`)) {
      return;
    }

    const payload = await api("POST", "/config-backups/delete", {
      backupId,
    });
    renderConfigBackupList(payload);
    if (configBackupDetails) {
      configBackupDetails.textContent = "";
    }
    setConfigBackupMessage(`Backup deleted: ${backupId}.`);
  } catch (error) {
    setConfigBackupMessage(error.message || String(error), true);
  }
});

bindClick("configBackupCleanBtn", async () => {
  try {
    if (
      !window.confirm(
        "Clean install config will reset installation_config.json, .env, and docker/blastdoor.env to defaults. Continue?",
      )
    ) {
      return;
    }
    const payload = await api("POST", "/config-backups/clean-install", {});
    await refreshAll();
    await refreshConfigBackups(false);
    if (configBackupDetails) {
      configBackupDetails.textContent = JSON.stringify(payload.result || {}, null, 2);
    }
    setConfigBackupMessage(
      payload.result?.serviceRestarted
        ? "Clean install config complete. Service restarted."
        : "Clean install config complete. Restart service if needed.",
    );
  } catch (error) {
    setConfigBackupMessage(error.message || String(error), true);
  }
});

bindClick("userMgmtBtn", async () => {
  if (!userModal) {
    setMessage("User management panel is unavailable in this UI build.", true);
    return;
  }

  if (!userModal.hidden) {
    closeUserModal();
    setUserMessage("User management panel closed.");
    return;
  }

  openUserModal();
  clearUserEditor();
  if (userTempCodeBox) {
    userTempCodeBox.textContent = "";
  }
  setUserMessage("Loading users...");
  try {
    await refreshUsers();
  } catch (error) {
    setUserMessage(error.message || String(error), true);
  }
});

bindClick("userCloseBtn", () => {
  closeUserModal();
});

bindClick("userRefreshBtn", async () => {
  try {
    await refreshUsers();
  } catch (error) {
    setUserMessage(error.message || String(error), true);
  }
});

bindClick("userNewBtn", () => {
  clearUserEditor();
  setUserMessage("Add New User mode.");
});

bindClick("userCancelBtn", () => {
  clearUserEditor();
  setUserMessage("User editor reset.");
});

if (userFilterInputs.length > 0) {
  for (const input of userFilterInputs) {
    input.addEventListener("change", async () => {
      try {
        await refreshUsers();
      } catch (error) {
        setUserMessage(error.message || String(error), true);
      }
    });
  }
}

bindClick("userResetCodeBtn", async () => {
  try {
    const target = selectedUserUsername || String(userUsername?.value || "");
    if (!target) {
      throw new Error("Select a user before resetting login.");
    }
    const payload = await api("POST", "/users/reset-login-code", {
      username: target,
      delivery: "email",
    });
    if (userTempCodeBox) {
      userTempCodeBox.textContent = [
        `Temporary code for ${target}`,
        `Code: ${payload.code || ""}`,
        `Expires: ${formatUserDate(payload.expiresAt)}`,
        payload.warning || "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    setUserMessage(`Temporary login code created for ${target}.`);
    await refreshUsers(false);
  } catch (error) {
    setUserMessage(error.message || String(error), true);
  }
});

bindClick("userInvalidateBtn", async () => {
  try {
    const target = selectedUserUsername || String(userUsername?.value || "");
    if (!target) {
      throw new Error("Select a user before invalidating login token.");
    }
    await api("POST", "/users/invalidate-token", {
      username: target,
    });
    setUserMessage(`Login token invalidated for ${target}.`);
    await refreshUsers(false);
  } catch (error) {
    setUserMessage(error.message || String(error), true);
  }
});

bindClick("userBanReinstateBtn", async () => {
  try {
    const target = selectedUserUsername || String(userUsername?.value || "");
    if (!target) {
      throw new Error("Select a user before changing status.");
    }
    const current = findUserByUsername(target);
    const nextStatus = current?.status === "active" ? "banned" : "active";
    const payload = await api("POST", "/users/set-status", {
      username: target,
      status: nextStatus,
    });
    if (payload.user) {
      loadUserEditor(payload.user);
    }
    setUserMessage(nextStatus === "active" ? `User ${target} reinstated.` : `User ${target} banned.`);
    await refreshUsers(false);
  } catch (error) {
    setUserMessage(error.message || String(error), true);
  }
});

if (userForm) {
  userForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = buildUserPayloadFromForm();
      const isUpdate = userEditorMode === "edit" && Boolean(selectedUserUsername);
      if (!isUpdate && payload.password.length < 12) {
        throw new Error("New users require a password of at least 12 characters.");
      }
      const response = await api("POST", isUpdate ? "/users/update" : "/users/create", payload);
      if (response.user) {
        loadUserEditor(response.user);
        selectedUserUsername = response.user.username || "";
        userEditorMode = "edit";
      }
      if (userPassword) {
        userPassword.value = "";
      }
      setUserMessage(isUpdate ? "User updated." : "User created.");
      await refreshUsers(false);
    } catch (error) {
      setUserMessage(error.message || String(error), true);
    }
  });
}

bindClick("tlsBtn", async () => {
  if (!tlsModal) {
    setMessage("TLS panel is unavailable in this UI build.", true);
    return;
  }

  if (!tlsModal.hidden) {
    closeTlsModal();
    setTlsMessage("TLS panel closed.");
    return;
  }

  openTlsModal();
  setTlsMessage("Loading TLS status...");
  try {
    await refreshTlsPanel();
    if (tlsPlanOutput) {
      tlsPlanOutput.textContent = "";
    }
    latestTlsPlan = "";
  } catch (error) {
    setTlsMessage(error.message || String(error), true);
  }
});

bindClick("tlsCloseBtn", () => {
  closeTlsModal();
});

bindClick("tlsDetectBtn", async () => {
  try {
    await refreshTlsPanel();
  } catch (error) {
    setTlsMessage(error.message || String(error), true);
  }
});

bindClick("tlsPlanBtn", async () => {
  try {
    const payload = await api("POST", "/tls/letsencrypt-plan", buildTlsPayload());
    renderTlsDetection(payload.detection || {});
    renderTlsPlan(payload.plan || {});
    setTlsMessage("Let's Encrypt plan generated.");
  } catch (error) {
    setTlsMessage(error.message || String(error), true);
  }
});

bindClick("tlsCopyPlanBtn", async () => {
  try {
    await copyToClipboard(latestTlsPlan || "");
    setTlsMessage("TLS setup plan copied.");
  } catch (error) {
    setTlsMessage(error.message || String(error), true);
  }
});

if (tlsForm) {
  tlsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("POST", "/tls/save", buildTlsPayload());
      setTlsMessage("TLS configuration saved. Restart Blastdoor to apply certificate changes.");
      await refreshTlsPanel(false);
      await refreshAll();
    } catch (error) {
      setTlsMessage(error.message || String(error), true);
    }
  });
}

closeAppearanceModal();
closeUserModal();
closeTlsModal();

loadManagerPlugins()
  .catch((error) => {
    console.warn("[manager-ui] plugin bootstrap failed:", error);
  })
  .finally(async () => {
    await refreshAll();
    try {
      await refreshConfigBackups(false);
    } catch (error) {
      setConfigBackupMessage(error.message || String(error), true);
    }
    setInterval(() => {
      refreshAll().catch(() => {});
    }, 3000);
  });
