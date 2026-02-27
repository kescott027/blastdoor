import fs from "node:fs/promises";
import path from "node:path";
import { safeEqual } from "./security.js";
import { BlastdoorDatabase, BlastdoorPostgresDatabase } from "./database-store.js";

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

  async listUsers() {
    throw new Error("listUsers is not implemented.");
  }

  async upsertUser() {
    throw new Error("upsertUser is not implemented.");
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

  async listUsers() {
    if (!this.authUsername || !this.authPasswordHash) {
      return [];
    }

    return [
      {
        username: this.authUsername,
        passwordHash: this.authPasswordHash,
        totpSecret: this.totpSecret,
        disabled: false,
      },
    ];
  }

  async upsertUser() {
    throw new Error("PASSWORD_STORE_MODE=env is read-only in the admin user manager.");
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

  async listUsers() {
    return this.readUsers({ allowEmpty: true });
  }

  async upsertUser({ username, passwordHash, totpSecret = null, disabled = false }) {
    const normalized = normalizeUserEntry({ username, passwordHash, totpSecret, disabled });
    if (!normalized) {
      throw new Error("username and passwordHash are required.");
    }

    const users = await this.readUsers({ allowEmpty: true });
    const nextUsers = [...users];
    const existingIndex = nextUsers.findIndex((entry) => safeEqual(entry.username, normalized.username));
    if (existingIndex >= 0) {
      nextUsers[existingIndex] = {
        ...nextUsers[existingIndex],
        ...normalized,
      };
    } else {
      nextUsers.push(normalized);
    }

    await this.writeUsers(nextUsers);
    return normalized;
  }

  async readUsers(options = {}) {
    const allowEmpty = options.allowEmpty === true;
    let raw;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      throw new Error(`Failed to read password store file at ${this.filePath}: ${error.message}`, { cause: error });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Password store file is not valid JSON: ${error.message}`, { cause: error });
    }

    const users = normalizeUsersFromFilePayload(parsed);
    if (users.length === 0 && !allowEmpty) {
      throw new Error("Password store file contains no valid users.");
    }

    return users;
  }

  async writeUsers(users) {
    const output = {
      users: users.map((entry) => ({
        username: entry.username,
        passwordHash: entry.passwordHash,
        totpSecret: entry.totpSecret || "",
        disabled: entry.disabled === true,
      })),
    };
    const serialized = `${JSON.stringify(output, null, 2)}\n`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, serialized, "utf8");
  }
}

export class SqlitePasswordStore extends PasswordStore {
  constructor({ databaseFile, logger }) {
    super();
    this.logger = logger || noopLogger();
    this.database = new BlastdoorDatabase({ filePath: databaseFile });
  }

  async getUserByUsername(username) {
    if (typeof username !== "string" || username.length === 0) {
      return null;
    }

    const user = this.database.getUser(username);
    if (!user) {
      return null;
    }

    if (user.disabled) {
      this.logger.warn("password_store.user_disabled");
      return null;
    }

    return user;
  }

  async listUsers() {
    return this.database.listUsers();
  }

  async upsertUser({ username, passwordHash, totpSecret = null, disabled = false }) {
    this.database.upsertUser({ username, passwordHash, totpSecret, disabled });
    return this.database.getUser(username);
  }

  close() {
    this.database.close();
  }
}

export class PostgresPasswordStore extends PasswordStore {
  constructor({ postgresUrl, postgresSsl = false, poolFactory, logger }) {
    super();
    this.logger = logger || noopLogger();
    this.database = new BlastdoorPostgresDatabase({
      connectionString: postgresUrl,
      ssl: postgresSsl === true,
      poolFactory,
    });
  }

  async getUserByUsername(username) {
    if (typeof username !== "string" || username.length === 0) {
      return null;
    }

    const user = await this.database.getUser(username);
    if (!user) {
      return null;
    }

    if (user.disabled) {
      this.logger.warn("password_store.user_disabled");
      return null;
    }

    return user;
  }

  async listUsers() {
    return this.database.listUsers();
  }

  async upsertUser({ username, passwordHash, totpSecret = null, disabled = false }) {
    await this.database.upsertUser({ username, passwordHash, totpSecret, disabled });
    return this.database.getUser(username);
  }

  async close() {
    await this.database.close();
  }
}

export function createPasswordStore(config, options = {}) {
  const mode = String(config.passwordStoreMode || "env").toLowerCase();

  if (mode === "sqlite") {
    return new SqlitePasswordStore({
      databaseFile: config.databaseFile,
      logger: options.logger,
    });
  }

  if (mode === "file") {
    return new FilePasswordStore({
      filePath: config.passwordStoreFile,
      logger: options.logger,
    });
  }

  if (mode === "postgres") {
    return new PostgresPasswordStore({
      postgresUrl: config.postgresUrl,
      postgresSsl: config.postgresSsl,
      poolFactory: options.postgresPoolFactory,
      logger: options.logger,
    });
  }

  return new EnvPasswordStore({
    authUsername: config.authUsername,
    authPasswordHash: config.authPasswordHash,
    totpSecret: config.totpSecret,
  });
}
