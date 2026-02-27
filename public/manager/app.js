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
const API_BASE = resolveApiBasePath(window.location.href);
const API_BASE_CANDIDATES = getApiBaseCandidates(API_BASE);
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
    appearanceMakeActive,
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
};
let appearanceAssetChooserState = null;
let appearanceEditorMode = "hidden";
let appearanceEditingThemeId = "";

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
      makeActive: toBooleanString(appearanceMakeActive.checked),
    };
  }

  throw new Error("Appearance panel controls are missing. Hard refresh the admin panel and try again.");
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
    if (hasThemeEditorPanelControls) {
      hideAppearanceEditor();
    }
    setAppearanceMessage("Theme catalog loaded.");
  } catch (error) {
    setAppearanceMessage(error.message || String(error), true);
  }
});

document.getElementById("appearanceCloseBtn").addEventListener("click", () => {
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
