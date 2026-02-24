import fs from "node:fs/promises";
import path from "node:path";
import { safeEqual } from "./security.js";

function noopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function normalizeUserEntry(entry, usernameFallback = "") {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const username = typeof entry.username === "string" && entry.username.length > 0
    ? entry.username
    : usernameFallback;

  if (!username) {
    return null;
  }

  const passwordHash = typeof entry.passwordHash === "string" ? entry.passwordHash : "";
  if (!passwordHash) {
    return null;
  }

  const totpSecret = typeof entry.totpSecret === "string" && entry.totpSecret.length > 0
    ? entry.totpSecret
    : null;
  const disabled = entry.disabled === true;

  return { username, passwordHash, totpSecret, disabled };
}

function normalizeUsersFromFilePayload(payload) {
  const users = [];

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const normalized = normalizeUserEntry(item);
      if (normalized) {
        users.push(normalized);
      }
    }
    return users;
  }

  if (payload && typeof payload === "object" && Array.isArray(payload.users)) {
    for (const item of payload.users) {
      const normalized = normalizeUserEntry(item);
      if (normalized) {
        users.push(normalized);
      }
    }
    return users;
  }

  if (payload && typeof payload === "object") {
    for (const [username, value] of Object.entries(payload)) {
      if (typeof value === "string") {
        users.push({
          username,
          passwordHash: value,
          totpSecret: null,
          disabled: false,
        });
        continue;
      }

      const normalized = normalizeUserEntry(value, username);
      if (normalized) {
        users.push(normalized);
      }
    }
    return users;
  }

  return users;
}

export class PasswordStore {
  async getUserByUsername() {
    throw new Error("getUserByUsername is not implemented.");
  }
}

export class EnvPasswordStore extends PasswordStore {
  constructor({ authUsername, authPasswordHash, totpSecret = "" }) {
    super();
    this.authUsername = authUsername;
    this.authPasswordHash = authPasswordHash;
    this.totpSecret = totpSecret || null;
  }

  async getUserByUsername(username) {
    if (typeof username !== "string" || typeof this.authUsername !== "string") {
      return null;
    }

    if (!safeEqual(username, this.authUsername)) {
      return null;
    }

    return {
      username: this.authUsername,
      passwordHash: this.authPasswordHash,
      totpSecret: this.totpSecret,
      disabled: false,
    };
  }
}

export class FilePasswordStore extends PasswordStore {
  constructor({ filePath, logger }) {
    super();
    this.filePath = path.resolve(filePath);
    this.logger = logger || noopLogger();
  }

  async getUserByUsername(username) {
    if (typeof username !== "string" || username.length === 0) {
      return null;
    }

    const users = await this.readUsers();
    for (const user of users) {
      if (!safeEqual(username, user.username)) {
        continue;
      }

      if (user.disabled) {
        this.logger.warn("password_store.user_disabled");
        return null;
      }

      return user;
    }

    return null;
  }

  async readUsers() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      throw new Error(`Failed to read password store file at ${this.filePath}: ${error.message}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Password store file is not valid JSON: ${error.message}`);
    }

    const users = normalizeUsersFromFilePayload(parsed);
    if (users.length === 0) {
      throw new Error("Password store file contains no valid users.");
    }

    return users;
  }
}

export function createPasswordStore(config, options = {}) {
  const mode = String(config.passwordStoreMode || "env").toLowerCase();

  if (mode === "file") {
    return new FilePasswordStore({
      filePath: config.passwordStoreFile,
      logger: options.logger,
    });
  }

  return new EnvPasswordStore({
    authUsername: config.authUsername,
    authPasswordHash: config.authPasswordHash,
    totpSecret: config.totpSecret,
  });
}
