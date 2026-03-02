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
  remoteSupport: {
    enabled: false,
    callHomeEnabled: false,
    defaultTokenTtlMinutes: 30,
    tokens: [],
    callHomeEvents: [],
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

function normalizeRemoteSupportTokenTtlMinutes(value, fallback = 30) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(30, Math.min(1440, parsed));
}

function normalizeRemoteSupportTokens(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const token = entry && typeof entry === "object" ? entry : {};
      return {
        tokenId: typeof token.tokenId === "string" ? token.tokenId : "",
        label: typeof token.label === "string" ? token.label : "",
        tokenHash: typeof token.tokenHash === "string" ? token.tokenHash : "",
        createdAt: typeof token.createdAt === "string" ? token.createdAt : "",
        expiresAt: typeof token.expiresAt === "string" ? token.expiresAt : "",
        lastUsedAt: typeof token.lastUsedAt === "string" ? token.lastUsedAt : "",
        revokedAt: typeof token.revokedAt === "string" ? token.revokedAt : "",
      };
    })
    .filter((entry) => entry.tokenId && entry.tokenHash);
}

function normalizeCallHomeEvents(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const event = entry && typeof entry === "object" ? entry : {};
      const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
      return {
        eventId: typeof event.eventId === "string" ? event.eventId : "",
        type: typeof event.type === "string" ? event.type : "",
        createdAt: typeof event.createdAt === "string" ? event.createdAt : "",
        satelliteId: typeof event.satelliteId === "string" ? event.satelliteId : "",
        status: typeof event.status === "string" ? event.status : "",
        message: typeof event.message === "string" ? event.message : "",
        payload,
      };
    })
    .filter((entry) => entry.eventId && entry.createdAt)
    .slice(-200);
}

function isRemoteSupportTokenActive(token, nowMs = Date.now()) {
  if (!token || typeof token !== "object") {
    return false;
  }
  if (token.revokedAt) {
    return false;
  }
  if (!token.expiresAt) {
    return true;
  }
  const expiresAtMs = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }
  return expiresAtMs > nowMs;
}

export function normalizeManagerConsoleSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const sourceLayout = source.layout && typeof source.layout === "object" ? source.layout : {};
  const sourceAccess = source.access && typeof source.access === "object" ? source.access : {};
  const sourceRemoteSupport =
    source.remoteSupport && typeof source.remoteSupport === "object" ? source.remoteSupport : {};

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
    remoteSupport: {
      enabled: normalizeBoolean(
        sourceRemoteSupport.enabled,
        DEFAULT_MANAGER_CONSOLE_SETTINGS.remoteSupport.enabled,
      ),
      callHomeEnabled: normalizeBoolean(
        sourceRemoteSupport.callHomeEnabled,
        DEFAULT_MANAGER_CONSOLE_SETTINGS.remoteSupport.callHomeEnabled,
      ),
      defaultTokenTtlMinutes: normalizeRemoteSupportTokenTtlMinutes(
        sourceRemoteSupport.defaultTokenTtlMinutes,
        DEFAULT_MANAGER_CONSOLE_SETTINGS.remoteSupport.defaultTokenTtlMinutes,
      ),
      tokens: normalizeRemoteSupportTokens(sourceRemoteSupport.tokens),
      callHomeEvents: normalizeCallHomeEvents(sourceRemoteSupport.callHomeEvents),
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
    remoteSupport: {
      enabled: normalized.remoteSupport.enabled,
      callHomeEnabled: normalized.remoteSupport.callHomeEnabled,
      defaultTokenTtlMinutes: normalized.remoteSupport.defaultTokenTtlMinutes,
      tokenCount: normalized.remoteSupport.tokens.length,
      activeTokenCount: normalized.remoteSupport.tokens.filter((entry) => isRemoteSupportTokenActive(entry)).length,
      callHomeEventCount: normalized.remoteSupport.callHomeEvents.length,
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
