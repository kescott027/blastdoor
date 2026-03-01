import fs from "node:fs/promises";
import path from "node:path";

const SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_MANAGER_CONSOLE_SETTINGS = {
  version: SETTINGS_SCHEMA_VERSION,
  layout: {
    darkModePercent: 100,
    lightModePercent: 0,
  },
  access: {
    requirePassword: false,
    passwordHash: "",
    sessionTtlHours: 12,
  },
};

function clampPercent(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, parsed));
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function normalizeSessionTtlHours(value, fallback = 12) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(168, parsed));
}

export function normalizeManagerConsoleSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const sourceLayout = source.layout && typeof source.layout === "object" ? source.layout : {};
  const sourceAccess = source.access && typeof source.access === "object" ? source.access : {};

  const settings = {
    version: SETTINGS_SCHEMA_VERSION,
    layout: {
      darkModePercent: clampPercent(
        sourceLayout.darkModePercent,
        DEFAULT_MANAGER_CONSOLE_SETTINGS.layout.darkModePercent,
      ),
      lightModePercent: clampPercent(
        sourceLayout.lightModePercent,
        DEFAULT_MANAGER_CONSOLE_SETTINGS.layout.lightModePercent,
      ),
    },
    access: {
      requirePassword: normalizeBoolean(
        sourceAccess.requirePassword,
        DEFAULT_MANAGER_CONSOLE_SETTINGS.access.requirePassword,
      ),
      passwordHash:
        typeof sourceAccess.passwordHash === "string"
          ? sourceAccess.passwordHash
          : DEFAULT_MANAGER_CONSOLE_SETTINGS.access.passwordHash,
      sessionTtlHours: normalizeSessionTtlHours(
        sourceAccess.sessionTtlHours,
        DEFAULT_MANAGER_CONSOLE_SETTINGS.access.sessionTtlHours,
      ),
    },
  };

  return settings;
}

export function sanitizeManagerConsoleSettingsForClient(settings) {
  const normalized = normalizeManagerConsoleSettings(settings);
  return {
    version: normalized.version,
    layout: normalized.layout,
    access: {
      requirePassword: normalized.access.requirePassword,
      sessionTtlHours: normalized.access.sessionTtlHours,
      passwordConfigured: Boolean(normalized.access.passwordHash),
    },
  };
}

export async function readManagerConsoleSettings(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) {
      return normalizeManagerConsoleSettings({});
    }
    return normalizeManagerConsoleSettings(JSON.parse(raw));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return normalizeManagerConsoleSettings({});
    }
    throw new Error(
      `Failed to read manager console settings from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function writeManagerConsoleSettings(filePath, settings) {
  const normalized = normalizeManagerConsoleSettings(settings);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
  return normalized;
}
