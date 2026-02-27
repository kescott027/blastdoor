import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function resolveDatabasePath(filePath) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new Error("DATABASE_FILE must be a non-empty path.");
  }

  return path.resolve(filePath.trim());
}

export class BlastdoorDatabase {
  constructor({ filePath }) {
    this.filePath = resolveDatabasePath(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        totp_secret TEXT,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_config (
        config_key TEXT PRIMARY KEY,
        config_value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS config_files (
        file_name TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  upsertUser({ username, passwordHash, totpSecret = null, disabled = false }) {
    if (typeof username !== "string" || username.length === 0) {
      throw new Error("username is required.");
    }

    if (typeof passwordHash !== "string" || passwordHash.length === 0) {
      throw new Error("passwordHash is required.");
    }

    const statement = this.db.prepare(`
      INSERT INTO users (username, password_hash, totp_secret, disabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        password_hash = excluded.password_hash,
        totp_secret = excluded.totp_secret,
        disabled = excluded.disabled,
        updated_at = CURRENT_TIMESTAMP
    `);

    statement.run(username, passwordHash, totpSecret || null, disabled ? 1 : 0);
  }

  getUser(username) {
    if (typeof username !== "string" || username.length === 0) {
      return null;
    }

    const statement = this.db.prepare(`
      SELECT username, password_hash, totp_secret, disabled
      FROM users
      WHERE username = ?
      LIMIT 1
    `);

    const row = statement.get(username);
    if (!row) {
      return null;
    }

    return {
      username: row.username,
      passwordHash: row.password_hash,
      totpSecret: row.totp_secret || null,
      disabled: row.disabled === 1,
    };
  }

  listUsers() {
    const statement = this.db.prepare(`
      SELECT username, password_hash, totp_secret, disabled
      FROM users
      ORDER BY username ASC
    `);

    const rows = statement.all();
    return rows.map((row) => ({
      username: row.username,
      passwordHash: row.password_hash,
      totpSecret: row.totp_secret || null,
      disabled: row.disabled === 1,
    }));
  }

  setConfigValue(key, value) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("config key is required.");
    }

    if (typeof value !== "string") {
      throw new Error("config value must be a string.");
    }

    const statement = this.db.prepare(`
      INSERT INTO app_config (config_key, config_value)
      VALUES (?, ?)
      ON CONFLICT(config_key) DO UPDATE SET
        config_value = excluded.config_value,
        updated_at = CURRENT_TIMESTAMP
    `);

    statement.run(key, value);
  }

  getConfigValue(key) {
    if (typeof key !== "string" || key.length === 0) {
      return null;
    }

    const statement = this.db.prepare(`
      SELECT config_value
      FROM app_config
      WHERE config_key = ?
      LIMIT 1
    `);
    const row = statement.get(key);
    return row ? row.config_value : null;
  }

  getAllConfigValues() {
    const statement = this.db.prepare(`
      SELECT config_key, config_value
      FROM app_config
    `);

    const entries = statement.all();
    const output = {};
    for (const entry of entries) {
      output[entry.config_key] = entry.config_value;
    }

    return output;
  }

  upsertConfigFile(fileName, content) {
    if (typeof fileName !== "string" || fileName.length === 0) {
      throw new Error("fileName is required.");
    }

    if (typeof content !== "string") {
      throw new Error("content must be a string.");
    }

    const statement = this.db.prepare(`
      INSERT INTO config_files (file_name, content)
      VALUES (?, ?)
      ON CONFLICT(file_name) DO UPDATE SET
        content = excluded.content,
        updated_at = CURRENT_TIMESTAMP
    `);

    statement.run(fileName, content);
  }

  getConfigFile(fileName) {
    if (typeof fileName !== "string" || fileName.length === 0) {
      return null;
    }

    const statement = this.db.prepare(`
      SELECT file_name, content, updated_at
      FROM config_files
      WHERE file_name = ?
      LIMIT 1
    `);
    const row = statement.get(fileName);
    if (!row) {
      return null;
    }

    return {
      fileName: row.file_name,
      content: row.content,
      updatedAt: row.updated_at,
    };
  }

  close() {
    this.db.close();
  }
}

function resolvePostgresConnectionString(connectionString) {
  if (typeof connectionString !== "string" || connectionString.trim().length === 0) {
    throw new Error("POSTGRES_URL must be a non-empty connection string.");
  }

  return connectionString.trim();
}

async function loadPostgresPoolConstructor() {
  try {
    const module = await import("pg");
    return module.Pool;
  } catch {
    throw new Error("PostgreSQL support requires the 'pg' package. Run: npm install pg");
  }
}

export class BlastdoorPostgresDatabase {
  constructor({ connectionString, ssl = false, poolFactory = null }) {
    this.connectionString = resolvePostgresConnectionString(connectionString);
    this.ssl = ssl === true;
    this.poolFactory = typeof poolFactory === "function" ? poolFactory : null;
    this.pool = null;
    this.initPromise = null;
  }

  async ensureReady() {
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }

    await this.initPromise;
  }

  async initialize() {
    const options = {
      connectionString: this.connectionString,
      ssl: this.ssl ? { rejectUnauthorized: false } : false,
    };

    if (this.poolFactory) {
      this.pool = await this.poolFactory(options);
    } else {
      const Pool = await loadPostgresPoolConstructor();
      this.pool = new Pool(options);
    }

    await this.migrate();
  }

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        totp_secret TEXT,
        disabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        config_key TEXT PRIMARY KEY,
        config_value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS config_files (
        file_name TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async upsertUser({ username, passwordHash, totpSecret = null, disabled = false }) {
    await this.ensureReady();
    if (typeof username !== "string" || username.length === 0) {
      throw new Error("username is required.");
    }

    if (typeof passwordHash !== "string" || passwordHash.length === 0) {
      throw new Error("passwordHash is required.");
    }

    await this.pool.query(
      `
      INSERT INTO users (username, password_hash, totp_secret, disabled)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(username) DO UPDATE SET
        password_hash = excluded.password_hash,
        totp_secret = excluded.totp_secret,
        disabled = excluded.disabled,
        updated_at = NOW()
      `,
      [username, passwordHash, totpSecret || null, disabled === true],
    );
  }

  async getUser(username) {
    await this.ensureReady();
    if (typeof username !== "string" || username.length === 0) {
      return null;
    }

    const result = await this.pool.query(
      `
      SELECT username, password_hash, totp_secret, disabled
      FROM users
      WHERE username = $1
      LIMIT 1
      `,
      [username],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      username: row.username,
      passwordHash: row.password_hash,
      totpSecret: row.totp_secret || null,
      disabled: row.disabled === true,
    };
  }

  async listUsers() {
    await this.ensureReady();
    const result = await this.pool.query(
      `
      SELECT username, password_hash, totp_secret, disabled
      FROM users
      ORDER BY username ASC
      `,
      [],
    );

    return result.rows.map((row) => ({
      username: row.username,
      passwordHash: row.password_hash,
      totpSecret: row.totp_secret || null,
      disabled: row.disabled === true,
    }));
  }

  async setConfigValue(key, value) {
    await this.ensureReady();
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("config key is required.");
    }

    if (typeof value !== "string") {
      throw new Error("config value must be a string.");
    }

    await this.pool.query(
      `
      INSERT INTO app_config (config_key, config_value)
      VALUES ($1, $2)
      ON CONFLICT(config_key) DO UPDATE SET
        config_value = excluded.config_value,
        updated_at = NOW()
      `,
      [key, value],
    );
  }

  async getConfigValue(key) {
    await this.ensureReady();
    if (typeof key !== "string" || key.length === 0) {
      return null;
    }

    const result = await this.pool.query(
      `
      SELECT config_value
      FROM app_config
      WHERE config_key = $1
      LIMIT 1
      `,
      [key],
    );

    const row = result.rows[0];
    return row ? row.config_value : null;
  }

  async getAllConfigValues() {
    await this.ensureReady();
    const result = await this.pool.query(`
      SELECT config_key, config_value
      FROM app_config
    `);

    const output = {};
    for (const entry of result.rows) {
      output[entry.config_key] = entry.config_value;
    }

    return output;
  }

  async upsertConfigFile(fileName, content) {
    await this.ensureReady();
    if (typeof fileName !== "string" || fileName.length === 0) {
      throw new Error("fileName is required.");
    }

    if (typeof content !== "string") {
      throw new Error("content must be a string.");
    }

    await this.pool.query(
      `
      INSERT INTO config_files (file_name, content)
      VALUES ($1, $2)
      ON CONFLICT(file_name) DO UPDATE SET
        content = excluded.content,
        updated_at = NOW()
      `,
      [fileName, content],
    );
  }

  async getConfigFile(fileName) {
    await this.ensureReady();
    if (typeof fileName !== "string" || fileName.length === 0) {
      return null;
    }

    const result = await this.pool.query(
      `
      SELECT file_name, content, updated_at
      FROM config_files
      WHERE file_name = $1
      LIMIT 1
      `,
      [fileName],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      fileName: row.file_name,
      content: row.content,
      updatedAt: row.updated_at,
    };
  }

  async close() {
    if (!this.pool) {
      return;
    }

    if (typeof this.pool.end === "function") {
      await this.pool.end();
    }
  }
}
