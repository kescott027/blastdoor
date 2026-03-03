import { createBlastdoorApi } from "../blastdoor-api.js";
import { createManagerAuthService } from "./auth-session-service.js";
import { createControlPlaneStatusService } from "./control-plane-service.js";
import { createRemoteSupportService } from "./remote-support-service.js";
import { createManagerDiagnosticsService } from "./diagnostics-service.js";

export function createManagerServiceComposition(options = {}) {
  const {
    readEnvConfig,
    loadConfigFromEnv,
    envPath,
    graphicsDir,
    themeStorePath,
    userProfileStorePath,
    postgresPoolFactory,
    managerConsoleSettingsPath,
    normalizeManagerConsoleSettings,
    readManagerConsoleSettings,
    writeManagerConsoleSettings,
    normalizeString,
    randomBytes,
    managerAuthCookieName,
    readInstallationConfig,
    installationConfigPath,
    detectEnvironmentInfo,
    workspaceDir,
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
    verifyPassword,
    randomUUID,
    configDefaults,
    remoteSupportTokenMinTtlMinutes,
    remoteSupportTokenMaxTtlMinutes,
    callHomeEventsMax,
    callHomeReportPayloadMaxChars,
    sanitizeConfigForDiagnostics,
    mapThemeForClient,
    defaultThemeId,
    accessFile,
    detectSelfProxyTarget,
    evaluateGatewayBindHost,
    isLoopbackHost,
    buildWslPortproxyScript,
    runCommandBatch,
    runGatewayLocalChecks,
    detectWslDefaultGatewayIp,
    buildWslFoundryTarget,
    validateConfig,
    writeEnvConfig,
    sensitiveConfigKeys,
    managerHost,
    managerPort,
  } = options;

  let managerConsoleSettingsCache = null;

  async function withBlastdoorApi(handler) {
    const configFromEnv = await readEnvConfig(envPath);
    const runtimeConfig = loadConfigFromEnv(configFromEnv);
    const blastdoorApi = createBlastdoorApi({
      config: runtimeConfig,
      graphicsDir,
      themeStorePath,
      userProfileStorePath,
      postgresPoolFactory,
    });

    try {
      return await handler({
        configFromEnv,
        runtimeConfig,
        config: runtimeConfig,
        blastdoorApi,
      });
    } finally {
      if (typeof blastdoorApi?.close === "function") {
        await blastdoorApi.close();
      }
    }
  }

  async function readConsoleSettings() {
    if (managerConsoleSettingsCache) {
      return managerConsoleSettingsCache;
    }
    managerConsoleSettingsCache = await readManagerConsoleSettings(managerConsoleSettingsPath);
    return managerConsoleSettingsCache;
  }

  async function writeConsoleSettings(nextSettings) {
    const normalized = normalizeManagerConsoleSettings(nextSettings);
    const saved = await writeManagerConsoleSettings(managerConsoleSettingsPath, normalized);
    managerConsoleSettingsCache = saved;
    return saved;
  }

  const managerAuthService = createManagerAuthService({
    readConsoleSettings,
    normalizeString,
    randomBytes,
    managerAuthCookieName,
  });

  const controlPlaneStatusService = createControlPlaneStatusService({
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
  });

  const remoteSupportService = createRemoteSupportService({
    normalizeString,
    verifyPassword,
    readConsoleSettings,
    writeConsoleSettings,
    randomUUID,
    configDefaults,
    remoteSupportTokenMinTtlMinutes,
    remoteSupportTokenMaxTtlMinutes,
    callHomeEventsMax,
    callHomeReportPayloadMaxChars,
  });

  const diagnosticsService = createManagerDiagnosticsService({
    readEnvConfig,
    envPath,
    processState,
    checkBlastdoorHealth,
    checkFoundryTargetHealth,
    detectEnvironmentInfo,
    workspaceDir,
    sanitizeConfigForDiagnostics,
    withBlastdoorApi,
    mapThemeForClient,
    normalizeString,
    defaultThemeId,
    accessFile,
    parseBooleanLike,
    detectSelfProxyTarget,
    configDefaults,
    evaluateGatewayBindHost,
    isLoopbackHost,
    buildWslPortproxyScript,
    runCommandBatch,
    runGatewayLocalChecks,
    commandRunner,
    detectWslDefaultGatewayIp,
    buildWslFoundryTarget,
    validateConfig,
    loadConfigFromEnv,
    writeEnvConfig,
    pluginManager,
    sensitiveConfigKeys,
    managerHost,
    managerPort,
  });

  return {
    withBlastdoorApi,
    readConsoleSettings,
    writeConsoleSettings,
    managerAuthService,
    controlPlaneStatusService,
    remoteSupportService,
    diagnosticsService,
  };
}
