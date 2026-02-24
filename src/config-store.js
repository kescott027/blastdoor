import { BlastdoorDatabase, BlastdoorPostgresDatabase } from "./database-store.js";

class NoopConfigStore {
  async setValue() {}
  async getValue() {
    return null;
  }
  async getAllValues() {
    return {};
  }
  async putFile() {}
  async getFile() {
    return null;
  }
  close() {}
}

export class SqliteConfigStore {
  constructor({ databaseFile }) {
    this.database = new BlastdoorDatabase({ filePath: databaseFile });
  }

  async setValue(key, value) {
    this.database.setConfigValue(key, value);
  }

  async getValue(key) {
    return this.database.getConfigValue(key);
  }

  async getAllValues() {
    return this.database.getAllConfigValues();
  }

  async putFile(fileName, content) {
    this.database.upsertConfigFile(fileName, content);
  }

  async getFile(fileName) {
    return this.database.getConfigFile(fileName);
  }

  close() {
    this.database.close();
  }
}

export class PostgresConfigStore {
  constructor({ postgresUrl, postgresSsl = false, poolFactory }) {
    this.database = new BlastdoorPostgresDatabase({
      connectionString: postgresUrl,
      ssl: postgresSsl === true,
      poolFactory,
    });
  }

  async setValue(key, value) {
    await this.database.setConfigValue(key, value);
  }

  async getValue(key) {
    return this.database.getConfigValue(key);
  }

  async getAllValues() {
    return this.database.getAllConfigValues();
  }

  async putFile(fileName, content) {
    await this.database.upsertConfigFile(fileName, content);
  }

  async getFile(fileName) {
    return this.database.getConfigFile(fileName);
  }

  async close() {
    await this.database.close();
  }
}

export function createConfigStore(config, options = {}) {
  const mode = String(config.configStoreMode || "env").toLowerCase();
  if (mode === "sqlite") {
    return new SqliteConfigStore({ databaseFile: config.databaseFile });
  }

  if (mode === "postgres") {
    return new PostgresConfigStore({
      postgresUrl: config.postgresUrl,
      postgresSsl: config.postgresSsl,
      poolFactory: options.postgresPoolFactory,
    });
  }

  return new NoopConfigStore();
}
