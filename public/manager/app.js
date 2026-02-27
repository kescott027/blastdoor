import { formatUnexpectedPayload, resolveApiBasePath, resolveApiPath } from "./client-utils.js";

const statusMessage = document.getElementById("statusMessage");
const form = document.getElementById("configForm");
const diagStatusMessage = document.getElementById("diagStatusMessage");
const diagSummary = document.getElementById("diagSummary");
const diagJson = document.getElementById("diagJson");
const API_BASE = resolveApiBasePath(window.location.href);

let latestDiagnostics = null;

function setMessage(text, isError = false) {
  statusMessage.textContent = text;
  statusMessage.style.color = isError ? "#ff8a8a" : "#9be0ff";
}

function setDiagMessage(text, isError = false) {
  diagStatusMessage.textContent = text;
  diagStatusMessage.style.color = isError ? "#ff8a8a" : "#9be0ff";
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
}

async function api(method, routePath, body) {
  const response = await fetch(resolveApiPath(API_BASE, routePath), {
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
      throw new Error(formatUnexpectedPayload(response, rawBody));
    }
  }

  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return payload;
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
  const data = new FormData(form);
  const payload = {};
  for (const [key, value] of data.entries()) {
    payload[key] = String(value);
  }

  try {
    await api("POST", "/config", payload);
    setMessage("Configuration saved.");
    await refreshAll();
  } catch (error) {
    setMessage(error.message || String(error), true);
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

document.getElementById("refreshBtn").addEventListener("click", async () => {
  await refreshAll();
  setMessage("Status refreshed.");
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

refreshAll();
setInterval(refreshAll, 3000);
