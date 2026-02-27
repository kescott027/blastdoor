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
const appearanceModal = document.getElementById("appearanceModal");
const appearanceStatusMessage = document.getElementById("appearanceStatusMessage");
const appearanceThemeSelect = document.getElementById("appearanceThemeSelect");
const appearanceForm = document.getElementById("appearanceForm");
const appearanceThemeName = document.getElementById("appearanceThemeName");
const appearanceLogoSelect = document.getElementById("appearanceLogoSelect");
const appearanceClosedBgSelect = document.getElementById("appearanceClosedBgSelect");
const appearanceOpenBgSelect = document.getElementById("appearanceOpenBgSelect");
const appearanceMakeActive = document.getElementById("appearanceMakeActive");
const API_BASE = resolveApiBasePath(window.location.href);
const API_BASE_CANDIDATES = getApiBaseCandidates(API_BASE);

let latestDiagnostics = null;
let latestTroubleshootReport = null;

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

function setAppearanceMessage(text, isError = false) {
  appearanceStatusMessage.textContent = text;
  appearanceStatusMessage.style.color = isError ? "#ff8a8a" : "#9be0ff";
}

function toBooleanString(value) {
  return value ? "true" : "false";
}

function parseBooleanish(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
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

function optionMarkup(value, label, selected = false) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  option.selected = selected;
  return option;
}

function fillAssetSelect(selectEl, assets, { allowEmpty, emptyLabel, required }) {
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

function fillThemeSelect(themes, activeThemeId) {
  appearanceThemeSelect.innerHTML = "";
  if (!themes.length) {
    appearanceThemeSelect.append(optionMarkup("", "No themes saved", true));
    appearanceThemeSelect.disabled = true;
    return;
  }

  appearanceThemeSelect.disabled = false;
  for (const theme of themes) {
    const selected = theme.id === activeThemeId;
    appearanceThemeSelect.append(optionMarkup(theme.id, theme.name, selected));
  }
}

function renderThemeCatalog(payload) {
  fillThemeSelect(payload.themes || [], payload.activeThemeId || "");
  fillAssetSelect(appearanceLogoSelect, payload.assets?.logos || [], {
    allowEmpty: true,
    emptyLabel: "No logo",
    required: false,
  });
  fillAssetSelect(appearanceClosedBgSelect, payload.assets?.backgrounds || [], {
    allowEmpty: false,
    emptyLabel: "",
    required: true,
  });
  fillAssetSelect(appearanceOpenBgSelect, payload.assets?.backgrounds || [], {
    allowEmpty: true,
    emptyLabel: "Same as closed background",
    required: false,
  });
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
  appearanceModal.hidden = true;
  appearanceModal.classList.add("hidden");
}

function buildAppearanceCreatePayload() {
  return {
    name: String(appearanceThemeName.value || ""),
    logoPath: String(appearanceLogoSelect.value || ""),
    closedBackgroundPath: String(appearanceClosedBgSelect.value || ""),
    openBackgroundPath: String(appearanceOpenBgSelect.value || ""),
    makeActive: toBooleanString(appearanceMakeActive.checked),
  };
}

async function refreshAll() {
  try {
    const [configResult, monitorResult] = await Promise.all([api("GET", "/config"), api("GET", "/monitor")]);
    fillForm(configResult.config);
    updateStatusCards(monitorResult);
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = buildConfigPayloadFromForm();

  try {
    await saveConfig(payload, "Configuration saved.");
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
});

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
    if (closed) {
      setMessage(
        serviceRestarted
          ? "Blast doors locked. Gateway was restarted and lockout is active."
          : "Blast doors locked. Start/restart the gateway service if lockout is not active yet.",
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

document.getElementById("startBtn").addEventListener("click", async () => {
  try {
    await api("POST", "/start");
    setMessage("Blastdoor start signal sent.");
    await refreshAll();
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
});

document.getElementById("stopBtn").addEventListener("click", async () => {
  try {
    await api("POST", "/stop");
    setMessage("Blastdoor stop signal sent.");
    await refreshAll();
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
});

document.getElementById("restartBtn").addEventListener("click", async () => {
  try {
    await api("POST", "/restart");
    setMessage("Blastdoor restart signal sent.");
    await refreshAll();
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
});

document.getElementById("revokeSessionsBtn").addEventListener("click", async () => {
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

document.getElementById("refreshBtn").addEventListener("click", async () => {
  await refreshAll();
  setMessage("Status refreshed.");
});

document.getElementById("appearanceBtn").addEventListener("click", async () => {
  if (!appearanceModal.hidden) {
    closeAppearanceModal();
    setAppearanceMessage("Appearance panel closed.");
    return;
  }

  openAppearanceModal();
  setAppearanceMessage("Loading themes...");
  try {
    await refreshThemes();
    setAppearanceMessage("Theme catalog loaded.");
  } catch (error) {
    setAppearanceMessage(error.message || String(error), true);
  }
});

document.getElementById("appearanceCloseBtn").addEventListener("click", () => {
  closeAppearanceModal();
});

document.getElementById("appearanceCancelBtn").addEventListener("click", () => {
  closeAppearanceModal();
});

document.getElementById("appearanceApplyBtn").addEventListener("click", async () => {
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

appearanceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = buildAppearanceCreatePayload();
    const created = await api("POST", "/themes/create", payload);
    renderThemeCatalog(created);
    appearanceThemeName.value = "";
    appearanceMakeActive.checked = true;
    setAppearanceMessage("Theme saved.");
  } catch (error) {
    setAppearanceMessage(error.message || String(error), true);
  }
});

document.getElementById("diagGenerateBtn").addEventListener("click", async () => {
  try {
    const payload = await api("GET", "/diagnostics");
    renderDiagnostics(payload);
    setDiagMessage("Diagnostics generated.");
  } catch (error) {
    setDiagMessage(error.message || String(error), true);
  }
});

document.getElementById("diagCopySummaryBtn").addEventListener("click", async () => {
  try {
    await copyToClipboard(latestDiagnostics?.summary || "");
    setDiagMessage("Summary copied.");
  } catch (error) {
    setDiagMessage(error.message || String(error), true);
  }
});

document.getElementById("diagCopyJsonBtn").addEventListener("click", async () => {
  try {
    await copyToClipboard(latestDiagnostics ? JSON.stringify(latestDiagnostics.report || {}, null, 2) : "");
    setDiagMessage("JSON copied.");
  } catch (error) {
    setDiagMessage(error.message || String(error), true);
  }
});

document.getElementById("tsAnalyzeBtn").addEventListener("click", async () => {
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

document.getElementById("tsSnapshotBtn").addEventListener("click", async () => {
  await runTroubleshootAction("snapshot.network", "Network snapshot complete.");
});

document.getElementById("tsGatewayBtn").addEventListener("click", async () => {
  await runTroubleshootAction("check.gateway-local", "Gateway access checks complete.");
});

document.getElementById("tsPortproxyDetectBtn").addEventListener("click", async () => {
  await runTroubleshootAction("detect.wsl-portproxy", "WSL2 portproxy detection complete.");
});

document.getElementById("tsPortproxyScriptBtn").addEventListener("click", async () => {
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

document.getElementById("tsCopyScriptBtn").addEventListener("click", async () => {
  try {
    await copyToClipboard(tsScript.textContent || "");
    setTsMessage("Guided script copied.");
  } catch (error) {
    setTsMessage(error.message || String(error), true);
  }
});

refreshAll();
setInterval(refreshAll, 3000);
closeAppearanceModal();
