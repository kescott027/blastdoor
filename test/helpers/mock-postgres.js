function normalizeSql(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function createState() {
  return {
    users: new Map(),
    appConfig: new Map(),
    configFiles: new Map(),
  };
}

function createPool(state) {
  return {
    async query(text, values = []) {
      const sql = normalizeSql(text);

      if (sql.startsWith("create table if not exists")) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("insert into users")) {
        const [username, passwordHash, totpSecret, disabled] = values;
        state.users.set(username, {
          username,
          password_hash: passwordHash,
          totp_secret: totpSecret ?? null,
          disabled: disabled === true,
          updated_at: new Date().toISOString(),
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("select username, password_hash, totp_secret, disabled")) {
        const [username] = values;
        const row = state.users.get(username);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      if (sql.includes("insert into app_config")) {
        const [key, value] = values;
        state.appConfig.set(key, value);
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("select config_value from app_config")) {
        const [key] = values;
        const value = state.appConfig.get(key);
        return {
          rows: value === undefined ? [] : [{ config_value: value }],
          rowCount: value === undefined ? 0 : 1,
        };
      }

      if (sql.includes("select config_key, config_value from app_config")) {
        const rows = [];
        for (const [config_key, config_value] of state.appConfig.entries()) {
          rows.push({ config_key, config_value });
        }
        return { rows, rowCount: rows.length };
      }

      if (sql.includes("insert into config_files")) {
        const [fileName, content] = values;
        state.configFiles.set(fileName, {
          file_name: fileName,
          content,
          updated_at: new Date().toISOString(),
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("select file_name, content, updated_at from config_files")) {
        const [fileName] = values;
        const row = state.configFiles.get(fileName);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      throw new Error(`MockPostgresPool does not support query: ${text}`);
    },
    async end() {},
  };
}

export function createMockPostgresPoolFactory(sharedState = null) {
  const state = sharedState || createState();
  const factory = async () => createPool(state);
  return { factory, state };
}
