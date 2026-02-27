import { createPasswordStore } from "./password-store.js";
import { createUserAdminStore } from "./user-admin-store.js";
import { listThemeAssets, mapThemeForClient, readThemeStore, resolveActiveTheme, writeThemeStore } from "./login-theme.js";

function fallbackTheme() {
  return {
    id: "",
    name: "Default",
    logoPath: "",
    logoUrl: "",
    closedBackgroundPath: "",
    closedBackgroundUrl: "",
    openBackgroundPath: "",
    openBackgroundUrl: "",
    createdAt: "",
    updatedAt: "",
  };
}

function normalizeApiBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const parsed = new URL(raw);
  return parsed.toString().replace(/\/+$/, "");
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function createRemoteApiError(message, statusCode = 500, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function computeRetryDelayMs(baseDelayMs, maxDelayMs, retryAttemptIndex) {
  const exponent = Math.max(0, retryAttemptIndex - 1);
  const backoff = baseDelayMs * 2 ** exponent;
  return Math.min(maxDelayMs, backoff);
}

function shouldRetryRequest({
  retryable,
  attempt,
  maxAttempts,
  statusCode,
  timedOut = false,
  networkError = false,
}) {
  if (!retryable || attempt >= maxAttempts) {
    return false;
  }

  if (timedOut || networkError) {
    return true;
  }

  return [408, 425, 429, 500, 502, 503, 504].includes(Number.parseInt(String(statusCode || ""), 10));
}

async function parseJsonBody(response) {
  const raw = await response.text();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return { error: raw.slice(0, 500) };
  }
}

export function createLocalBlastdoorApi(options = {}) {
  const config = options.config || null;
  const graphicsDir = options.graphicsDir || "";
  const themeStorePath = options.themeStorePath || "";
  const userProfileStorePath = options.userProfileStorePath || "";
  const logger = options.logger;
  const postgresPoolFactory = options.postgresPoolFactory;

  let passwordStore = null;
  let userAdminStore = null;

  function getPasswordStore() {
    if (passwordStore) {
      return passwordStore;
    }
    if (!config) {
      throw new Error("Blastdoor API password store requires runtime config.");
    }
    passwordStore = createPasswordStore(config, {
      logger,
      postgresPoolFactory,
    });
    return passwordStore;
  }

  function getUserAdminStore() {
    if (userAdminStore) {
      return userAdminStore;
    }
    userAdminStore = createUserAdminStore({
      filePath: userProfileStorePath,
    });
    return userAdminStore;
  }

  async function getActiveTheme() {
    const themeStore = await readThemeStore(themeStorePath);
    const activeTheme = resolveActiveTheme(themeStore);
    if (!activeTheme) {
      return fallbackTheme();
    }
    return mapThemeForClient(activeTheme);
  }

  return {
    async getUserCredential(username) {
      return await getPasswordStore().getUserByUsername(username);
    },

    async listCredentialUsers() {
      return await getPasswordStore().listUsers();
    },

    async upsertCredentialUser(record) {
      return await getPasswordStore().upsertUser(record);
    },

    async listUserProfiles(options = {}) {
      return await getUserAdminStore().listProfiles(options);
    },

    async getUserProfile(username, options = {}) {
      return await getUserAdminStore().getProfile(username, options);
    },

    async getRawUserProfile(username) {
      return await getUserAdminStore().getRawProfile(username);
    },

    async upsertUserProfile(profile) {
      return await getUserAdminStore().upsertProfile(profile);
    },

    async recordSuccessfulLogin(username, ipAddress = "") {
      return await getUserAdminStore().recordSuccessfulLogin(username, ipAddress);
    },

    async issueTemporaryLoginCode(username, options = {}) {
      return await getUserAdminStore().issueTemporaryLoginCode(username, options);
    },

    async verifyTemporaryLoginCode(username, code, options = {}) {
      return await getUserAdminStore().verifyTemporaryLoginCode(username, code, options);
    },

    async invalidateUserSessions(username) {
      return await getUserAdminStore().invalidateUserSessions(username);
    },

    async getActiveTheme() {
      return await getActiveTheme();
    },

    async readThemeStore() {
      return await readThemeStore(themeStorePath);
    },

    async writeThemeStore(payload) {
      return await writeThemeStore(themeStorePath, payload);
    },

    async listThemeAssets() {
      return await listThemeAssets(graphicsDir);
    },

    async close() {
      if (typeof passwordStore?.close === "function") {
        await passwordStore.close();
      }
      if (typeof userAdminStore?.close === "function") {
        await userAdminStore.close();
      }
    },
  };
}

export function createRemoteBlastdoorApi(options = {}) {
  const baseUrl = normalizeApiBaseUrl(options.baseUrl || options.config?.blastdoorApiUrl || process.env.BLASTDOOR_API_URL);
  if (!baseUrl) {
    throw new Error("Remote Blastdoor API requires a non-empty base URL.");
  }

  const token = String(options.token || options.config?.blastdoorApiToken || process.env.BLASTDOOR_API_TOKEN || "").trim();
  const timeoutMs = toPositiveInteger(options.timeoutMs || options.config?.blastdoorApiTimeoutMs, 2500);
  const retryMaxAttempts = toPositiveInteger(
    options.retryMaxAttempts || options.config?.blastdoorApiRetryMaxAttempts,
    3,
  );
  const retryBaseDelayMs = toPositiveInteger(
    options.retryBaseDelayMs || options.config?.blastdoorApiRetryBaseDelayMs,
    120,
  );
  const retryMaxDelayMs = toPositiveInteger(
    options.retryMaxDelayMs || options.config?.blastdoorApiRetryMaxDelayMs,
    1200,
  );
  const circuitFailureThreshold = toPositiveInteger(
    options.circuitFailureThreshold || options.config?.blastdoorApiCircuitFailureThreshold,
    5,
  );
  const circuitResetMs = toPositiveInteger(options.circuitResetMs || options.config?.blastdoorApiCircuitResetMs, 10000);
  const logger = options.logger || null;

  const circuit = {
    consecutiveFailures: 0,
    openUntil: 0,
  };

  function markSuccess() {
    circuit.consecutiveFailures = 0;
    circuit.openUntil = 0;
  }

  function markFailure() {
    circuit.consecutiveFailures += 1;
    if (circuit.consecutiveFailures >= circuitFailureThreshold) {
      circuit.openUntil = Date.now() + circuitResetMs;
      if (typeof logger?.warn === "function") {
        logger.warn("blastdoor_api.circuit_open", {
          baseUrl,
          circuitFailureThreshold,
          circuitResetMs,
        });
      }
    }
  }

  function ensureCircuitClosed() {
    if (Date.now() < circuit.openUntil) {
      throw createRemoteApiError("Blastdoor API circuit is open. Retry shortly.", 503, {
        circuitOpenUntil: new Date(circuit.openUntil).toISOString(),
      });
    }
  }

  async function request(pathname, { method = "GET", payload = null, retryable = false } = {}) {
    ensureCircuitClosed();

    let lastError = null;
    for (let attempt = 1; attempt <= retryMaxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let timedOut = false;

      try {
        const response = await fetch(`${baseUrl}${pathname}`, {
          method,
          headers: {
            "content-type": "application/json",
            ...(token ? { "x-blastdoor-api-token": token } : {}),
          },
          body: payload === null ? undefined : JSON.stringify(payload),
          signal: controller.signal,
        });

        const body = await parseJsonBody(response);
        if (!response.ok) {
          const message =
            (body && typeof body.error === "string" && body.error) ||
            `Blastdoor API request failed with HTTP ${response.status}.`;
          const httpError = createRemoteApiError(message, response.status, body);
          lastError = httpError;

          const retryNow = shouldRetryRequest({
            retryable,
            attempt,
            maxAttempts: retryMaxAttempts,
            statusCode: response.status,
          });
          if (retryNow) {
            if (typeof logger?.warn === "function") {
              logger.warn("blastdoor_api.retry", {
                baseUrl,
                pathname,
                method,
                attempt,
                retryMaxAttempts,
                statusCode: response.status,
              });
            }
            const retryDelayMs = computeRetryDelayMs(retryBaseDelayMs, retryMaxDelayMs, attempt);
            await delay(retryDelayMs);
            continue;
          }

          break;
        }

        markSuccess();
        return body;
      } catch (error) {
        if (error?.name === "AbortError") {
          timedOut = true;
          lastError = createRemoteApiError(`Blastdoor API request timed out after ${timeoutMs}ms.`, 504);
        } else if (error && Object.prototype.hasOwnProperty.call(error, "statusCode")) {
          lastError = error;
        } else {
          lastError = createRemoteApiError(
            `Blastdoor API request failed: ${error instanceof Error ? error.message : String(error)}`,
            502,
          );
        }

        const retryNow = shouldRetryRequest({
          retryable,
          attempt,
          maxAttempts: retryMaxAttempts,
          statusCode: lastError?.statusCode,
          timedOut,
          networkError: !timedOut && lastError?.statusCode === 502,
        });

        if (retryNow) {
          if (typeof logger?.warn === "function") {
            logger.warn("blastdoor_api.retry", {
              baseUrl,
              pathname,
              method,
              attempt,
              retryMaxAttempts,
              statusCode: lastError?.statusCode || null,
              timedOut,
            });
          }
          const retryDelayMs = computeRetryDelayMs(retryBaseDelayMs, retryMaxDelayMs, attempt);
          await delay(retryDelayMs);
          continue;
        }

        break;
      } finally {
        clearTimeout(timeout);
      }
    }

    markFailure();
    throw lastError || createRemoteApiError("Blastdoor API request failed.", 502);
  }

  return {
    async getUserCredential(username) {
      const body = await request("/internal/users/credential/get", {
        method: "POST",
        payload: { username },
        retryable: true,
      });
      return body.user || null;
    },

    async listCredentialUsers() {
      const body = await request("/internal/users/credentials", {
        method: "GET",
        retryable: true,
      });
      return Array.isArray(body.users) ? body.users : [];
    },

    async upsertCredentialUser(record) {
      const body = await request("/internal/users/credential/upsert", {
        method: "POST",
        payload: { record },
      });
      return body.user || null;
    },

    async listUserProfiles(options = {}) {
      const body = await request("/internal/users/profiles/list", {
        method: "POST",
        payload: { options },
        retryable: true,
      });
      return Array.isArray(body.profiles) ? body.profiles : [];
    },

    async getUserProfile(username, options = {}) {
      const body = await request("/internal/users/profile/get", {
        method: "POST",
        payload: { username, options },
        retryable: true,
      });
      return body.profile || null;
    },

    async getRawUserProfile(username) {
      const body = await request("/internal/users/profile/get-raw", {
        method: "POST",
        payload: { username },
        retryable: true,
      });
      return body.profile || null;
    },

    async upsertUserProfile(profile) {
      const body = await request("/internal/users/profile/upsert", {
        method: "POST",
        payload: { profile },
      });
      return body.profile || null;
    },

    async recordSuccessfulLogin(username, ipAddress = "") {
      const body = await request("/internal/users/profile/record-login", {
        method: "POST",
        payload: { username, ipAddress },
      });
      return body.profile || null;
    },

    async issueTemporaryLoginCode(username, options = {}) {
      const body = await request("/internal/users/profile/issue-temp-code", {
        method: "POST",
        payload: { username, options },
      });
      return body.issued || null;
    },

    async verifyTemporaryLoginCode(username, code, options = {}) {
      const body = await request("/internal/users/profile/verify-temp-code", {
        method: "POST",
        payload: { username, code, options },
      });
      return Boolean(body.valid);
    },

    async invalidateUserSessions(username) {
      const body = await request("/internal/users/profile/invalidate-sessions", {
        method: "POST",
        payload: { username },
      });
      return body.profile || null;
    },

    async getActiveTheme() {
      const body = await request("/internal/themes/active", {
        method: "GET",
        retryable: true,
      });
      return body.theme || fallbackTheme();
    },

    async readThemeStore() {
      const body = await request("/internal/themes/store", {
        method: "GET",
        retryable: true,
      });
      return body.store || { activeThemeId: "", themes: [] };
    },

    async writeThemeStore(payload) {
      const body = await request("/internal/themes/store/write", {
        method: "POST",
        payload: { store: payload },
      });
      return body.store || { activeThemeId: "", themes: [] };
    },

    async listThemeAssets() {
      const body = await request("/internal/themes/assets", {
        method: "GET",
        retryable: true,
      });
      return body.assets || { logos: [], backgrounds: [] };
    },

    async close() {},
  };
}

export function loadBlastdoorApiRuntimeConfig(env = process.env) {
  const passwordStoreMode = String(env.PASSWORD_STORE_MODE || "env").toLowerCase();
  return {
    passwordStoreMode,
    passwordStoreFile: env.PASSWORD_STORE_FILE || "mock/password-store.json",
    authUsername: env.AUTH_USERNAME || "",
    authPasswordHash: env.AUTH_PASSWORD_HASH || "",
    totpSecret: env.TOTP_SECRET || "",
    databaseFile: env.DATABASE_FILE || "data/blastdoor.sqlite",
    configStoreMode: String(env.CONFIG_STORE_MODE || "env").toLowerCase(),
    postgresUrl: env.POSTGRES_URL || "",
    postgresSsl: ["1", "true", "yes", "on"].includes(String(env.POSTGRES_SSL || "false").toLowerCase()),
    sessionMaxAgeHours: toPositiveInteger(env.SESSION_MAX_AGE_HOURS, 12),
    blastdoorApiUrl: String(env.BLASTDOOR_API_URL || "").trim(),
    blastdoorApiToken: String(env.BLASTDOOR_API_TOKEN || "").trim(),
    blastdoorApiTimeoutMs: toPositiveInteger(env.BLASTDOOR_API_TIMEOUT_MS, 2500),
    blastdoorApiRetryMaxAttempts: toPositiveInteger(env.BLASTDOOR_API_RETRY_MAX_ATTEMPTS, 3),
    blastdoorApiRetryBaseDelayMs: toPositiveInteger(env.BLASTDOOR_API_RETRY_BASE_DELAY_MS, 120),
    blastdoorApiRetryMaxDelayMs: toPositiveInteger(env.BLASTDOOR_API_RETRY_MAX_DELAY_MS, 1200),
    blastdoorApiCircuitFailureThreshold: toPositiveInteger(env.BLASTDOOR_API_CIRCUIT_FAILURE_THRESHOLD, 5),
    blastdoorApiCircuitResetMs: toPositiveInteger(env.BLASTDOOR_API_CIRCUIT_RESET_MS, 10000),
  };
}

export function createBlastdoorApi(options = {}) {
  const config = options.config || null;
  const remoteUrl = String(options.baseUrl || config?.blastdoorApiUrl || process.env.BLASTDOOR_API_URL || "").trim();
  if (remoteUrl) {
    return createRemoteBlastdoorApi({
      ...options,
      baseUrl: remoteUrl,
      config,
    });
  }

  return createLocalBlastdoorApi(options);
}
