export function createControlPlaneStatusService(options = {}) {
  const {
    readEnvConfig,
    envPath,
    readInstallationConfig,
    installationConfigPath,
    detectEnvironmentInfo,
    workspaceDir,
    normalizeString,
    parseBooleanLike,
    processState,
    checkBlastdoorHealth,
    checkFoundryTargetHealth,
    probeFoundryApiStatus,
    buildObjectStoreStatus,
    readFailureStore,
    summarizeFailureStore,
    failureStorePath,
    pluginManager,
    loadComposeServiceStates,
    commandRunner,
    probeHttpHealth,
    detectHostProcessState,
    parsePostgresUrlEndpoint,
    probeTcpPort,
    formatPluginName,
    managerStartedAtMs,
  } = options;

  const cache = {
    payload: null,
    updatedAtMs: 0,
    inflight: null,
  };

  async function resolveControlPlaneStatus() {
    const [config, installationConfigRaw] = await Promise.all([
      readEnvConfig(envPath),
      readInstallationConfig(installationConfigPath),
    ]);

    const environment = detectEnvironmentInfo({ workspaceDir, envPath });
    const installationConfig = installationConfigRaw || null;
    const installType = normalizeString(installationConfig?.installType, "local").toLowerCase();
    const portal = processState.getStatus();
    const [portalHealth, foundryHealth, foundryApiStatus] = await Promise.all([
      checkBlastdoorHealth(config),
      checkFoundryTargetHealth(config),
      probeFoundryApiStatus(config, 1500),
    ]);
    const adminUptimeSeconds = Math.max(0, Math.floor((Date.now() - managerStartedAtMs) / 1000));
    const objectStore = await buildObjectStoreStatus(config, installationConfig);
    const [failureStore, enabledPlugins] = await Promise.all([
      readFailureStore(failureStorePath),
      Promise.resolve(pluginManager.getEnabledPlugins()),
    ]);
    const failureSummary = summarizeFailureStore(failureStore);

    const response = {
      ok: true,
      generatedAt: new Date().toISOString(),
      installation: {
        profile: installType === "container" ? "container" : "local",
      },
      environment: {
        isWsl: Boolean(environment.isWsl),
        wslDistro: normalizeString(environment.wslDistro, ""),
        isContainer: Boolean(environment.isContainer),
      },
      admin: {
        running: true,
        pid: process.pid,
        uptimeSeconds: adminUptimeSeconds,
        health: { ok: true, statusCode: 200 },
      },
      portal: {
        running: portal.running,
        pid: portal.pid,
        uptimeSeconds: portal.uptimeSeconds || 0,
        health: portalHealth,
      },
      foundry: {
        target: normalizeString(config.FOUNDRY_TARGET, ""),
        reachable: Boolean(foundryApiStatus.reachable || foundryHealth.ok || foundryHealth.tcp?.ok),
        health: foundryHealth,
        apiStatus: foundryApiStatus,
      },
      api: {
        running: false,
        pid: null,
        uptimeSeconds: 0,
        health: { ok: false, statusCode: null, error: "unknown" },
      },
      postgres: {
        running: false,
        pid: null,
        uptimeSeconds: 0,
        health: { ok: false, statusCode: null, error: "not-configured" },
      },
      failures: failureSummary,
      objectStore,
      plugins: [],
    };

    if (installType === "container") {
      const composeState = await loadComposeServiceStates({
        commandRunner,
        workspaceDir,
      });
      const services = composeState.services || {};

      const portalContainer = services.blastdoor || null;
      if (portalContainer) {
        response.portal = {
          running: Boolean(portalContainer.running),
          pid: portalContainer.pid || null,
          uptimeSeconds: portalContainer.uptimeSeconds || 0,
          health: portalContainer.health || portalHealth,
        };
      }

      const apiContainer = services["blastdoor-api"] || null;
      response.api = apiContainer
        ? {
            running: Boolean(apiContainer.running),
            pid: apiContainer.pid || null,
            uptimeSeconds: apiContainer.uptimeSeconds || 0,
            health: apiContainer.health || { ok: false, statusCode: null, error: "unknown" },
          }
        : {
            running: false,
            pid: null,
            uptimeSeconds: 0,
            health: composeState.ok
              ? { ok: false, statusCode: null, error: "not-running" }
              : { ok: false, statusCode: null, error: composeState.error || "compose-unavailable" },
          };

      const postgresContainer = services.postgres || null;
      response.postgres = postgresContainer
        ? {
            running: Boolean(postgresContainer.running),
            pid: postgresContainer.pid || null,
            uptimeSeconds: postgresContainer.uptimeSeconds || 0,
            health: postgresContainer.health || { ok: false, statusCode: null, error: "unknown" },
          }
        : {
            running: false,
            pid: null,
            uptimeSeconds: 0,
            health: composeState.ok
              ? { ok: false, statusCode: null, error: "not-running" }
              : { ok: false, statusCode: null, error: composeState.error || "compose-unavailable" },
          };

      response.plugins = enabledPlugins.map((plugin) => {
        const id = normalizeString(plugin?.id, "");
        const assistantContainer = id === "intelligence" ? services["blastdoor-assistant"] || null : null;
        if (assistantContainer) {
          return {
            id,
            name: formatPluginName(id),
            running: Boolean(assistantContainer.running),
            pid: assistantContainer.pid || null,
            uptimeSeconds: assistantContainer.uptimeSeconds || 0,
            health: assistantContainer.health || { ok: false, statusCode: null, error: "unknown" },
          };
        }
        return {
          id,
          name: formatPluginName(id),
          running: true,
          pid: null,
          uptimeSeconds: adminUptimeSeconds,
          health: { ok: true, statusCode: 200 },
        };
      });

      return response;
    }

    const apiUrl = normalizeString(config.BLASTDOOR_API_URL, "");
    if (apiUrl) {
      const healthUrl = (() => {
        try {
          const parsed = new URL(apiUrl);
          parsed.pathname = "/healthz";
          parsed.search = "";
          parsed.hash = "";
          return parsed.toString();
        } catch {
          return apiUrl;
        }
      })();

      const apiHealth = await probeHttpHealth(healthUrl, 1500);
      const apiProcess = await detectHostProcessState({
        commandRunner,
        workspaceDir,
        matchers: ["blastdoor-api", "src/api-server.js"],
      });
      response.api = {
        running: apiProcess?.running || apiHealth.ok,
        pid: apiProcess?.pid || null,
        uptimeSeconds: apiProcess?.uptimeSeconds || 0,
        health: apiHealth,
      };
    } else {
      const apiProcess = await detectHostProcessState({
        commandRunner,
        workspaceDir,
        matchers: ["blastdoor-api", "src/api-server.js"],
      });
      response.api = apiProcess
        ? {
            running: true,
            pid: apiProcess.pid || null,
            uptimeSeconds: apiProcess.uptimeSeconds || 0,
            health: { ok: true, statusCode: 200 },
          }
        : {
            running: response.portal.running,
            pid: response.portal.pid,
            uptimeSeconds: response.portal.uptimeSeconds,
            health: response.portal.health,
          };
    }

    const postgresMode =
      normalizeString(config.PASSWORD_STORE_MODE, "").toLowerCase() === "postgres" ||
      normalizeString(config.CONFIG_STORE_MODE, "").toLowerCase() === "postgres";
    if (postgresMode) {
      const endpoint = parsePostgresUrlEndpoint(config.POSTGRES_URL);
      if (!endpoint) {
        response.postgres = {
          running: false,
          pid: null,
          uptimeSeconds: 0,
          health: {
            ok: false,
            statusCode: null,
            error: "invalid-postgres-url",
          },
        };
      } else {
        const [tcpHealth, processHealth] = await Promise.all([
          probeTcpPort({
            host: endpoint.host,
            port: endpoint.port,
            timeoutMs: 1500,
          }),
          detectHostProcessState({
            commandRunner,
            workspaceDir,
            matchers: ["postgres"],
          }),
        ]);

        response.postgres = {
          running: processHealth?.running || tcpHealth.ok,
          pid: processHealth?.pid || null,
          uptimeSeconds: processHealth?.uptimeSeconds || 0,
          health: tcpHealth.ok
            ? {
                ok: true,
                statusCode: 200,
                detail: `${endpoint.host}:${endpoint.port}`,
              }
            : {
                ok: false,
                statusCode: null,
                error: tcpHealth.error || "unreachable",
                detail: `${endpoint.host}:${endpoint.port}`,
              },
        };
      }
    }

    response.plugins = await Promise.all(
      enabledPlugins.map(async (plugin) => {
        const id = normalizeString(plugin?.id, "");
        if (id === "intelligence") {
          const enabled = parseBooleanLike(config.ASSISTANT_ENABLED, true);
          if (!enabled) {
            return {
              id,
              name: formatPluginName(id),
              running: false,
              pid: null,
              uptimeSeconds: 0,
              health: { ok: false, statusCode: null, error: "disabled" },
            };
          }

          const assistantUrl = normalizeString(config.ASSISTANT_URL, "");
          if (assistantUrl) {
            const healthUrl = (() => {
              try {
                const parsed = new URL(assistantUrl);
                parsed.pathname = "/healthz";
                parsed.search = "";
                parsed.hash = "";
                return parsed.toString();
              } catch {
                return assistantUrl;
              }
            })();

            const assistantHealth = await probeHttpHealth(healthUrl, 1500);
            return {
              id,
              name: formatPluginName(id),
              running: assistantHealth.ok,
              pid: null,
              uptimeSeconds: 0,
              health: assistantHealth,
            };
          }

          return {
            id,
            name: formatPluginName(id),
            running: true,
            pid: null,
            uptimeSeconds: adminUptimeSeconds,
            health: { ok: true, statusCode: 200 },
          };
        }

        return {
          id,
          name: formatPluginName(id),
          running: true,
          pid: null,
          uptimeSeconds: adminUptimeSeconds,
          health: { ok: true, statusCode: 200 },
        };
      }),
    );

    return response;
  }

  async function getControlPlaneStatusCached() {
    const now = Date.now();
    if (cache.payload && now - cache.updatedAtMs < 2000) {
      return cache.payload;
    }

    if (cache.inflight) {
      return await cache.inflight;
    }

    cache.inflight = resolveControlPlaneStatus()
      .then((payload) => {
        cache.payload = payload;
        cache.updatedAtMs = Date.now();
        return payload;
      })
      .finally(() => {
        cache.inflight = null;
      });

    return await cache.inflight;
  }

  return {
    cache,
    getControlPlaneStatusCached,
  };
}
