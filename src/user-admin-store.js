import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createPasswordHash, verifyPassword } from "./security.js";

const USER_STATUSES = new Set(["active", "deactivated", "banned"]);

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStatus(value, fallback = "active") {
  const normalized = String(value || "").trim().toLowerCase();
  if (USER_STATUSES.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeOptionalString(value, maxLength = 2048) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, maxLength);
}

function normalizeIsoDatetime(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString();
}

function normalizeSessionVersion(value, fallback = 1) {
  const version = Number.parseInt(String(value || ""), 10);
  if (!Number.isInteger(version) || version < 1) {
    return fallback;
  }
  return version;
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

function normalizeStoredProfile(username, raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const normalizedUsername = normalizeUsername(username || source.username);
  if (!normalizedUsername) {
    return null;
  }

  const createdAt = normalizeIsoDatetime(source.createdAt) || new Date().toISOString();
  const updatedAt = normalizeIsoDatetime(source.updatedAt) || createdAt;
  const tempLoginCodeExpiresAt = normalizeIsoDatetime(source.tempLoginCodeExpiresAt);

  return {
    username: normalizedUsername,
    friendlyName: normalizeOptionalString(source.friendlyName, 160),
    email: normalizeOptionalString(source.email, 320),
    contactInfo: normalizeOptionalString(source.contactInfo, 1024),
    avatarUrl: normalizeOptionalString(source.avatarUrl, 1024),
    status: normalizeStatus(source.status, "active"),
    displayInfo: normalizeOptionalString(source.displayInfo, 2048),
    notes: normalizeOptionalString(source.notes, 4096),
    lastLoginAt: normalizeIsoDatetime(source.lastLoginAt),
    lastKnownIp: normalizeOptionalString(source.lastKnownIp, 96),
    sessionVersion: normalizeSessionVersion(source.sessionVersion, 1),
    requirePasswordChange: normalizeBoolean(source.requirePasswordChange, false),
    firstLoginCompletedAt: normalizeIsoDatetime(source.firstLoginCompletedAt),
    tempLoginCodeHash: typeof source.tempLoginCodeHash === "string" ? source.tempLoginCodeHash : "",
    tempLoginCodeExpiresAt,
    tempLoginIssuedAt: normalizeIsoDatetime(source.tempLoginIssuedAt),
    tempLoginDelivery: normalizeOptionalString(source.tempLoginDelivery, 64),
    createdAt,
    updatedAt,
  };
}

function normalizeStorePayload(raw) {
  const users = {};

  if (raw && typeof raw === "object" && raw.users && typeof raw.users === "object") {
    for (const [username, value] of Object.entries(raw.users)) {
      const normalized = normalizeStoredProfile(username, value);
      if (normalized) {
        users[normalized.username] = normalized;
      }
    }
  }

  if (Array.isArray(raw?.profiles)) {
    for (const value of raw.profiles) {
      const normalized = normalizeStoredProfile(value?.username, value);
      if (normalized) {
        users[normalized.username] = normalized;
      }
    }
  }

  return { users };
}

function blankStore() {
  return { users: {} };
}

function sanitizeProfileForClient(profile, sessionMaxAgeHours = 12) {
  const nowMs = Date.now();
  const loginMs = profile.lastLoginAt ? new Date(profile.lastLoginAt).getTime() : Number.NaN;
  const maxAgeMs = Math.max(1, Number.parseInt(String(sessionMaxAgeHours || "12"), 10)) * 60 * 60 * 1000;
  const authenticatedNow = Number.isFinite(loginMs) && nowMs - loginMs <= maxAgeMs && profile.status === "active";
  const tempCodeExpiresAt = profile.tempLoginCodeExpiresAt || "";
  const tempCodeActive =
    Boolean(profile.tempLoginCodeHash) &&
    Boolean(tempCodeExpiresAt) &&
    Number.isFinite(new Date(tempCodeExpiresAt).getTime()) &&
    new Date(tempCodeExpiresAt).getTime() > nowMs;

  return {
    username: profile.username,
    friendlyName: profile.friendlyName,
    email: profile.email,
    contactInfo: profile.contactInfo,
    avatarUrl: profile.avatarUrl,
    status: profile.status,
    displayInfo: profile.displayInfo,
    notes: profile.notes,
    lastLoginAt: profile.lastLoginAt,
    lastKnownIp: profile.lastKnownIp,
    sessionVersion: profile.sessionVersion,
    requirePasswordChange: Boolean(profile.requirePasswordChange),
    firstLoginCompletedAt: profile.firstLoginCompletedAt,
    authenticatedNow,
    tempCodeActive,
    tempCodeExpiresAt,
    updatedAt: profile.updatedAt,
    createdAt: profile.createdAt,
  };
}

async function readStoreFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) {
      return blankStore();
    }
    const parsed = JSON.parse(raw);
    return normalizeStorePayload(parsed);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return blankStore();
    }
    throw new Error(
      `Failed to read user profile store at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function writeStoreFile(filePath, store) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

export function createUserAdminStore(options = {}) {
  const filePath = path.resolve(options.filePath || path.join(process.cwd(), "data", "user-profiles.json"));
  let operationQueue = Promise.resolve();

  async function withStore(writeOperation) {
    const run = async () => {
      const store = await readStoreFile(filePath);
      const output = await writeOperation(store);
      await writeStoreFile(filePath, store);
      return output;
    };
    const next = operationQueue.then(run, run);
    operationQueue = next.catch(() => {});
    return next;
  }

  async function readOnly(readOperation) {
    await operationQueue.catch(() => {});
    const store = await readStoreFile(filePath);
    return readOperation(store);
  }

  async function ensureProfile(username, defaults = {}) {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      throw new Error("username is required.");
    }

    return withStore((store) => {
      const existing = normalizeStoredProfile(normalizedUsername, store.users[normalizedUsername] || {});
      const merged = normalizeStoredProfile(normalizedUsername, {
        ...existing,
        ...defaults,
        username: normalizedUsername,
        updatedAt: new Date().toISOString(),
      });
      store.users[normalizedUsername] = merged;
      return merged;
    });
  }

  return {
    async listProfiles({ sessionMaxAgeHours = 12 } = {}) {
      return readOnly((store) => {
        const users = Object.values(store.users)
          .map((entry) => normalizeStoredProfile(entry.username, entry))
          .filter(Boolean)
          .sort((a, b) => a.username.localeCompare(b.username))
          .map((entry) => sanitizeProfileForClient(entry, sessionMaxAgeHours));
        return users;
      });
    },

    async getProfile(username, { sessionMaxAgeHours = 12 } = {}) {
      const normalizedUsername = normalizeUsername(username);
      if (!normalizedUsername) {
        return null;
      }

      return readOnly((store) => {
        const rawProfile = store.users[normalizedUsername];
        if (!rawProfile) {
          return null;
        }
        const profile = normalizeStoredProfile(normalizedUsername, rawProfile);
        if (!profile) {
          return null;
        }
        return sanitizeProfileForClient(profile, sessionMaxAgeHours);
      });
    },

    async getRawProfile(username) {
      const normalizedUsername = normalizeUsername(username);
      if (!normalizedUsername) {
        return null;
      }

      return readOnly((store) => {
        const rawProfile = store.users[normalizedUsername];
        if (!rawProfile) {
          return null;
        }
        return normalizeStoredProfile(normalizedUsername, rawProfile);
      });
    },

    async upsertProfile({
      username,
      friendlyName,
      email,
      status,
      displayInfo,
      notes,
      contactInfo,
      avatarUrl,
      requirePasswordChange,
      firstLoginCompletedAt,
      sessionVersion,
      lastLoginAt,
      lastKnownIp,
    }) {
      const normalizedUsername = normalizeUsername(username);
      if (!normalizedUsername) {
        throw new Error("username is required.");
      }

      return withStore((store) => {
        const existing = normalizeStoredProfile(normalizedUsername, store.users[normalizedUsername] || {});
        const merged = normalizeStoredProfile(normalizedUsername, {
          ...existing,
          username: normalizedUsername,
          friendlyName:
            friendlyName === undefined ? existing?.friendlyName : normalizeOptionalString(friendlyName, 160),
          email: email === undefined ? existing?.email : normalizeOptionalString(email, 320),
          contactInfo:
            contactInfo === undefined ? existing?.contactInfo : normalizeOptionalString(contactInfo, 1024),
          avatarUrl: avatarUrl === undefined ? existing?.avatarUrl : normalizeOptionalString(avatarUrl, 1024),
          status: status === undefined ? existing?.status : normalizeStatus(status, existing?.status || "active"),
          displayInfo:
            displayInfo === undefined ? existing?.displayInfo : normalizeOptionalString(displayInfo, 2048),
          notes: notes === undefined ? existing?.notes : normalizeOptionalString(notes, 4096),
          requirePasswordChange:
            requirePasswordChange === undefined
              ? normalizeBoolean(existing?.requirePasswordChange, false)
              : normalizeBoolean(requirePasswordChange, normalizeBoolean(existing?.requirePasswordChange, false)),
          firstLoginCompletedAt:
            firstLoginCompletedAt === undefined
              ? existing?.firstLoginCompletedAt
              : normalizeIsoDatetime(firstLoginCompletedAt),
          sessionVersion:
            sessionVersion === undefined
              ? normalizeSessionVersion(existing?.sessionVersion, 1)
              : normalizeSessionVersion(sessionVersion, existing?.sessionVersion || 1),
          lastLoginAt: lastLoginAt === undefined ? existing?.lastLoginAt : normalizeIsoDatetime(lastLoginAt),
          lastKnownIp: lastKnownIp === undefined ? existing?.lastKnownIp : normalizeOptionalString(lastKnownIp, 96),
          updatedAt: new Date().toISOString(),
        });
        store.users[normalizedUsername] = merged;
        return sanitizeProfileForClient(merged);
      });
    },

    async recordSuccessfulLogin(username, ipAddress = "") {
      const profile = await ensureProfile(username, {});
      return withStore((store) => {
        const current = normalizeStoredProfile(profile.username, store.users[profile.username] || profile);
        const now = new Date().toISOString();
        const next = normalizeStoredProfile(profile.username, {
          ...current,
          lastLoginAt: now,
          lastKnownIp: normalizeOptionalString(ipAddress, 96),
          tempLoginCodeHash: "",
          tempLoginCodeExpiresAt: "",
          tempLoginIssuedAt: "",
          tempLoginDelivery: "",
          updatedAt: now,
        });
        store.users[profile.username] = next;
        return sanitizeProfileForClient(next);
      });
    },

    async invalidateUserSessions(username) {
      const profile = await ensureProfile(username, {});
      return withStore((store) => {
        const current = normalizeStoredProfile(profile.username, store.users[profile.username] || profile);
        const nextVersion = normalizeSessionVersion(current?.sessionVersion, 1) + 1;
        const next = normalizeStoredProfile(profile.username, {
          ...current,
          sessionVersion: nextVersion,
          updatedAt: new Date().toISOString(),
        });
        store.users[profile.username] = next;
        return sanitizeProfileForClient(next);
      });
    },

    async issueTemporaryLoginCode(username, options = {}) {
      const profile = await ensureProfile(username, {});
      const ttlMinutes = Math.max(5, Math.min(240, Number.parseInt(String(options.ttlMinutes || "30"), 10) || 30));
      const delivery = normalizeOptionalString(options.delivery || "manual", 64) || "manual";
      const code = randomBytes(9).toString("base64url").slice(0, 12);
      const codeHash = createPasswordHash(code);
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
      const issuedAt = new Date().toISOString();

      await withStore((store) => {
        const current = normalizeStoredProfile(profile.username, store.users[profile.username] || profile);
        const next = normalizeStoredProfile(profile.username, {
          ...current,
          tempLoginCodeHash: codeHash,
          tempLoginCodeExpiresAt: expiresAt,
          tempLoginIssuedAt: issuedAt,
          tempLoginDelivery: delivery,
          requirePasswordChange: true,
          updatedAt: issuedAt,
        });
        store.users[profile.username] = next;
      });

      return {
        code,
        expiresAt,
        delivery,
      };
    },

    async verifyTemporaryLoginCode(username, code, { consume = false } = {}) {
      const normalizedUsername = normalizeUsername(username);
      if (!normalizedUsername || typeof code !== "string" || !code.trim()) {
        return false;
      }

      const now = Date.now();
      const targetCode = code.trim();

      if (!consume) {
        return readOnly((store) => {
          const current = normalizeStoredProfile(normalizedUsername, store.users[normalizedUsername] || null);
          if (!current?.tempLoginCodeHash || !current.tempLoginCodeExpiresAt) {
            return false;
          }
          const expiryMs = new Date(current.tempLoginCodeExpiresAt).getTime();
          if (!Number.isFinite(expiryMs) || expiryMs < now) {
            return false;
          }
          return verifyPassword(targetCode, current.tempLoginCodeHash);
        });
      }

      return withStore((store) => {
        const current = normalizeStoredProfile(normalizedUsername, store.users[normalizedUsername] || null);
        if (!current?.tempLoginCodeHash || !current.tempLoginCodeExpiresAt) {
          return false;
        }
        const expiryMs = new Date(current.tempLoginCodeExpiresAt).getTime();
        if (!Number.isFinite(expiryMs) || expiryMs < now) {
          return false;
        }
        const matches = verifyPassword(targetCode, current.tempLoginCodeHash);
        if (!matches) {
          return false;
        }

        const next = normalizeStoredProfile(normalizedUsername, {
          ...current,
          tempLoginCodeHash: "",
          tempLoginCodeExpiresAt: "",
          tempLoginIssuedAt: "",
          tempLoginDelivery: "",
          updatedAt: new Date().toISOString(),
        });
        store.users[normalizedUsername] = next;
        return true;
      });
    },

    async close() {},
  };
}
