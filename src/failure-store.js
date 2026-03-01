import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_MAX_ENTRIES = 250;

function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

function normalizeArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => normalizeString(entry, "")).filter(Boolean);
}

function inferFailureNature(message = "") {
  const text = normalizeString(message, "").toLowerCase();
  if (!text) {
    return "unknown";
  }

  if (text.includes("eaddrnotavail") || text.includes("not available on this runtime host")) {
    return "bind-address-unavailable";
  }
  if (text.includes("eaddrinuse") || text.includes("already in use")) {
    return "port-in-use";
  }
  if (text.includes("invalid csrf token") || text.includes("csrf")) {
    return "csrf-validation-failed";
  }
  if (text.includes("origin") && text.includes("rejected")) {
    return "origin-rejected";
  }
  if (text.includes("econrefused")) {
    return "connection-refused";
  }
  if (text.includes("cannot find module") || text.includes("err_module_not_found")) {
    return "module-missing";
  }
  if (text.includes("forbidden")) {
    return "forbidden-response";
  }

  return "unknown";
}

function inferFailureSeverity(nature = "unknown") {
  if (["bind-address-unavailable", "port-in-use", "connection-refused", "module-missing"].includes(nature)) {
    return "error";
  }
  if (["csrf-validation-failed", "origin-rejected", "forbidden-response"].includes(nature)) {
    return "warn";
  }
  return "info";
}

function inferSuggestedFixes(nature, { isWsl = false } = {}) {
  if (nature === "bind-address-unavailable") {
    return isWsl
      ? [
          "Set HOST=0.0.0.0 in .env and restart Blastdoor.",
          "Use Windows portproxy + firewall rules for LAN access to WSL services.",
        ]
      : [
          "Set HOST=0.0.0.0 for LAN access or 127.0.0.1 for local-only access.",
          "Avoid binding HOST to an IP that is not present on this machine.",
        ];
  }

  if (nature === "port-in-use") {
    return [
      "Stop the conflicting process using this port.",
      "Or change PORT in .env and restart Blastdoor.",
    ];
  }

  if (nature === "connection-refused") {
    return [
      "Verify target service is running and reachable from this host.",
      "Check host/port values in configuration and retry.",
    ];
  }

  if (nature === "module-missing") {
    return [
      "Install missing dependencies with npm install.",
      "Re-run the command after dependency install completes.",
    ];
  }

  if (nature === "csrf-validation-failed") {
    return [
      "Reload the login page to refresh CSRF token and retry.",
      "Ensure requests originate from the same host/origin expected by Blastdoor.",
    ];
  }

  if (nature === "origin-rejected") {
    return [
      "Verify browser origin matches Blastdoor host/port.",
      "Adjust ALLOWED_ORIGINS or ALLOW_NULL_ORIGIN only if required for your environment.",
    ];
  }

  if (nature === "forbidden-response") {
    return [
      "Check auth/session state and blast door lock status.",
      "Review manager diagnostics for CSRF/origin/auth guard details.",
    ];
  }

  return ["Review logs and diagnostics for context, then retry."];
}

function normalizeFailureEntry(raw = {}) {
  const message = normalizeString(raw.message, "");
  const nature = normalizeString(raw.nature, "") || inferFailureNature(message);
  const createdAt = normalizeString(raw.createdAt, "") || new Date().toISOString();
  const fixes = normalizeArray(raw.fixes);
  return {
    id: normalizeString(raw.id, "") || crypto.randomUUID(),
    createdAt,
    source: normalizeString(raw.source, "") || "runtime",
    action: normalizeString(raw.action, "") || "",
    nature,
    severity: normalizeString(raw.severity, "") || inferFailureSeverity(nature),
    message,
    details: normalizeString(raw.details, ""),
    fixes: fixes.length > 0 ? fixes : inferSuggestedFixes(nature, { isWsl: raw.isWsl === true }),
    context: raw.context && typeof raw.context === "object" ? raw.context : {},
  };
}

export async function readFailureStore(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const entriesRaw = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const entries = entriesRaw.map((entry) => normalizeFailureEntry(entry));
    return {
      version: 1,
      updatedAt: normalizeString(parsed?.updatedAt, "") || "",
      entries,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { version: 1, updatedAt: "", entries: [] };
    }
    throw new Error(`Failed to read failure store at ${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

async function writeFailureStore(filePath, payload) {
  const safeEntries = Array.isArray(payload?.entries) ? payload.entries.map((entry) => normalizeFailureEntry(entry)) : [];
  const normalized = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: safeEntries,
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export async function appendFailureRecord(filePath, record, options = {}) {
  const maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : DEFAULT_MAX_ENTRIES;
  const existing = await readFailureStore(filePath);
  const nextEntry = normalizeFailureEntry(record);
  const nextEntries = [...existing.entries, nextEntry];
  while (nextEntries.length > maxEntries) {
    nextEntries.shift();
  }
  await writeFailureStore(filePath, {
    ...existing,
    entries: nextEntries,
  });
  return nextEntry;
}

export async function clearFailureStore(filePath) {
  return await writeFailureStore(filePath, {
    version: 1,
    entries: [],
  });
}

export function summarizeFailureStore(payload = {}) {
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const sorted = [...entries].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const latest = sorted[0] || null;
  return {
    count: sorted.length,
    latestAt: latest?.createdAt || "",
    latestSeverity: latest?.severity || "",
    latestNature: latest?.nature || "",
  };
}
