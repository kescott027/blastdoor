import path from "node:path";

export function createManagerDiagnosticsService(options = {}) {
  const {
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
    defaultThemeId = "blastdoor-default",
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
  } = options;

  function normalizeThemeAssetRelativePath(value) {
    const normalized = normalizeString(value, "").replaceAll("\\", "/").replace(/^\/+/, "");
    if (!normalized || normalized.includes("..")) {
      return "";
    }
    return normalized;
  }

  function resolveThemeAssetAbsolutePath(graphicsDir, relativePath) {
    const normalized = normalizeThemeAssetRelativePath(relativePath);
    if (!normalized) {
      return "";
    }

    const baseDir = path.resolve(graphicsDir);
    const absolutePath = path.resolve(baseDir, normalized);
    if (absolutePath === baseDir || !absolutePath.startsWith(`${baseDir}${path.sep}`)) {
      return "";
    }

    return absolutePath;
  }

  function normalizeLoginAppearanceTheme(theme) {
    const normalized = theme && typeof theme === "object" ? theme : {};
    return {
      id: normalizeString(normalized.id, ""),
      name: normalizeString(normalized.name, ""),
      logoPath: normalizeThemeAssetRelativePath(normalized.logoPath),
      logoUrl: normalizeString(normalized.logoUrl, ""),
      closedBackgroundPath: normalizeThemeAssetRelativePath(normalized.closedBackgroundPath),
      closedBackgroundUrl: normalizeString(normalized.closedBackgroundUrl, ""),
      openBackgroundPath: normalizeThemeAssetRelativePath(normalized.openBackgroundPath),
      openBackgroundUrl: normalizeString(normalized.openBackgroundUrl, ""),
      loginBoxMode: normalizeString(normalized.loginBoxMode, "dark"),
      loginBoxWidthPercent: Number.parseInt(String(normalized.loginBoxWidthPercent || 100), 10) || 100,
      loginBoxHeightPercent: Number.parseInt(String(normalized.loginBoxHeightPercent || 100), 10) || 100,
      loginBoxOpacityPercent: Number.parseInt(String(normalized.loginBoxOpacityPercent || 100), 10) || 100,
      loginBoxHoverOpacityPercent: Number.parseInt(String(normalized.loginBoxHoverOpacityPercent || 100), 10) || 100,
      loginBoxPosXPercent: Number.parseInt(String(normalized.loginBoxPosXPercent || 50), 10) || 50,
      loginBoxPosYPercent: Number.parseInt(String(normalized.loginBoxPosYPercent || 50), 10) || 50,
      logoSizePercent: Number.parseInt(String(normalized.logoSizePercent || 30), 10) || 30,
      logoOffsetXPercent: Number.parseInt(String(normalized.logoOffsetXPercent || 2), 10) || 2,
      logoOffsetYPercent: Number.parseInt(String(normalized.logoOffsetYPercent || 2), 10) || 2,
      backgroundZoomPercent: Number.parseInt(String(normalized.backgroundZoomPercent || 100), 10) || 100,
    };
  }

  function formatLoginAppearanceCopyPasteText(details) {
    return [
      `activeThemeId: ${details.activeThemeId || ""}`,
      `theme.id: ${details.activeTheme.id || ""}`,
      `theme.name: ${details.activeTheme.name || ""}`,
      `theme.logoPath: ${details.activeTheme.logoPath || ""}`,
      `theme.closedBackgroundPath: ${details.activeTheme.closedBackgroundPath || ""}`,
      `theme.openBackgroundPath: ${details.activeTheme.openBackgroundPath || ""}`,
      `theme.loginBoxMode: ${details.activeTheme.loginBoxMode || "dark"}`,
      `theme.loginBoxWidthPercent: ${details.activeTheme.loginBoxWidthPercent}`,
      `theme.loginBoxHeightPercent: ${details.activeTheme.loginBoxHeightPercent}`,
      `theme.loginBoxOpacityPercent: ${details.activeTheme.loginBoxOpacityPercent}`,
      `theme.loginBoxHoverOpacityPercent: ${details.activeTheme.loginBoxHoverOpacityPercent}`,
      `theme.loginBoxPosXPercent: ${details.activeTheme.loginBoxPosXPercent}`,
      `theme.loginBoxPosYPercent: ${details.activeTheme.loginBoxPosYPercent}`,
      `theme.logoSizePercent: ${details.activeTheme.logoSizePercent}`,
      `theme.logoOffsetXPercent: ${details.activeTheme.logoOffsetXPercent}`,
      `theme.logoOffsetYPercent: ${details.activeTheme.logoOffsetYPercent}`,
      `theme.backgroundZoomPercent: ${details.activeTheme.backgroundZoomPercent}`,
    ].join("\n");
  }

  function createDiagnosticsSummary(report) {
    const config = report.config;
    const status = report.serviceStatus || {};
    const health = report.health || {};
    const foundryHealth = report.foundryHealth || {};
    const env = report.environment || {};
    const loginAppearance = report.loginAppearance || {};
    const usesPostgres = config.PASSWORD_STORE_MODE === "postgres" || config.CONFIG_STORE_MODE === "postgres";
    const usesSqlite = config.PASSWORD_STORE_MODE === "sqlite" || config.CONFIG_STORE_MODE === "sqlite";
    const backend = usesPostgres ? "postgres" : usesSqlite ? "sqlite" : "env/file";

    const pluginLines = pluginManager.getManagerDiagnosticsSummaryLines(config);
    const redactionKeys = ["AUTH_PASSWORD_HASH", ...sensitiveConfigKeys, "POSTGRES_URL credentials"];

    const lines = [
      `Generated: ${report.generatedAt}`,
      `Gateway Bind: ${config.HOST || "unset"}:${config.PORT || "unset"}`,
      `Foundry Target: ${config.FOUNDRY_TARGET || "unset"}`,
      `Service Running: ${status.running ? "yes" : "no"} (pid: ${status.pid || "n/a"})`,
      `Health Check: ${health.ok ? "healthy" : "unhealthy"}${health.statusCode ? ` (${health.statusCode})` : ""}`,
      `Foundry Reachability: ${
        foundryHealth.ok
          ? `reachable (${foundryHealth.statusCode || "n/a"})`
          : `unreachable${foundryHealth.error ? ` (${foundryHealth.error})` : ""}`
      }`,
      `Auth Username: ${config.AUTH_USERNAME || "unset"}`,
      `Require TOTP: ${config.REQUIRE_TOTP || "false"}`,
      `Password Store Mode: ${config.PASSWORD_STORE_MODE || "unset"}`,
      `Config Store Mode: ${config.CONFIG_STORE_MODE || "unset"}`,
      `Database Backend: ${backend}`,
      `Postgres URL: ${config.POSTGRES_URL || "n/a"}`,
      `Login Theme: ${loginAppearance.activeThemeName || "n/a"} (${loginAppearance.activeThemeId || "n/a"})`,
      `Login Assets: logo=${loginAppearance.assets?.logo?.status || "n/a"}, closed=${loginAppearance.assets?.closedBackground?.status || "n/a"}, open=${loginAppearance.assets?.openBackground?.status || "n/a"}`,
      ...pluginLines,
      `Debug Mode: ${config.DEBUG_MODE || "false"} (log: ${config.DEBUG_LOG_FILE || "unset"})`,
      `Manager UI: http://${env.managerHost || managerHost}:${env.managerPort || managerPort}/manager/`,
      `Runtime: ${env.platform || "unknown"} ${env.arch || "unknown"}, Node ${env.nodeVersion || "unknown"}${env.isWsl ? `, WSL (${env.wslDistro || "unknown"})` : ""}`,
      `Redactions: ${redactionKeys.join(", ")}`,
    ];

    return lines.join("\n");
  }

  function createTroubleshootChecks({ config, health, foundryHealth, environment }) {
    const checks = [];
    const blastDoorsClosed = parseBooleanLike(config.BLAST_DOORS_CLOSED, false);
    const selfTarget = detectSelfProxyTarget({
      host: normalizeString(config.HOST, configDefaults.HOST),
      port: Number.parseInt(config.PORT || configDefaults.PORT, 10),
      foundryTarget: normalizeString(config.FOUNDRY_TARGET, configDefaults.FOUNDRY_TARGET),
    });

    checks.push({
      id: "gateway.blastdoors",
      title: "Blast doors lockout state",
      status: blastDoorsClosed ? "warn" : "ok",
      detail: blastDoorsClosed
        ? "Blast doors are LOCKED. All gateway routes are intentionally blocked."
        : "Blast doors are UNLOCKED. Normal authenticated gateway routing is available.",
      recommendation: blastDoorsClosed
        ? "Unlock blast doors from the admin panel when maintenance is complete."
        : null,
    });

    const bindValidation = evaluateGatewayBindHost({
      host: config.HOST,
      environment,
    });
    checks.push({
      id: "network.bind-address",
      title: "Gateway bind address",
      status: bindValidation.ok ? (config.HOST === "0.0.0.0" ? "ok" : "warn") : "error",
      detail: bindValidation.ok
        ? config.HOST === "0.0.0.0"
          ? "Gateway is listening on all interfaces."
          : `Gateway is bound to ${config.HOST}. LAN access may fail unless HOST=0.0.0.0.`
        : `Configured HOST=${bindValidation.host} is not available on this runtime host and startup will fail with EADDRNOTAVAIL.`,
      recommendation: bindValidation.ok
        ? config.HOST === "0.0.0.0"
          ? null
          : "Set HOST=0.0.0.0 and restart Blastdoor."
        : bindValidation.recommendation || "Set HOST=0.0.0.0 and restart Blastdoor.",
    });

    checks.push({
      id: "gateway.local-health",
      title: "Local health check",
      status: health.ok ? "ok" : "error",
      detail: health.ok
        ? `Gateway responded from ${health.url} with status ${health.statusCode}.`
        : `Gateway health endpoint is unreachable at ${health.url}${health.error ? ` (${health.error})` : ""}.`,
      recommendation: health.ok ? null : "Confirm service status and check Runtime/Debug logs.",
    });

    if (selfTarget.isSelfTarget) {
      checks.push({
        id: "proxy.self-target",
        title: "Proxy self-target loop detection",
        status: "error",
        detail: `FOUNDRY_TARGET resolves to the Blastdoor gateway address (${selfTarget.targetHost}:${selfTarget.targetPort}).`,
        recommendation:
          "Set FOUNDRY_TARGET to your Foundry VTT server endpoint (different host/port than Blastdoor), then restart.",
      });
    } else {
      checks.push({
        id: "proxy.foundry-target-health",
        title: "Foundry target reachability",
        status: foundryHealth.ok ? "ok" : "error",
        detail: foundryHealth.ok
          ? `Foundry target responded from ${foundryHealth.url} with status ${foundryHealth.statusCode}.`
          : `Unable to reach Foundry target at ${foundryHealth.url || "unset"}${foundryHealth.error ? ` (${foundryHealth.error})` : ""}.`,
        recommendation: foundryHealth.ok
          ? null
          : environment.isWsl
            ? "When running in WSL, ensure FOUNDRY_TARGET points to an address reachable from Linux and that Foundry is running."
            : "Verify Foundry is running and FOUNDRY_TARGET points to the correct service address and port.",
      });
    }

    if (foundryHealth.targetHost) {
      checks.push({
        id: "proxy.foundry-dns",
        title: "Foundry target DNS resolution",
        status: foundryHealth.dns?.ok ? "ok" : "error",
        detail: foundryHealth.dns?.ok
          ? `Resolved ${foundryHealth.targetHost} to: ${(foundryHealth.dns?.addresses || []).join(", ")}.`
          : `DNS resolution failed for ${foundryHealth.targetHost}${foundryHealth.dns?.error ? ` (${foundryHealth.dns.error})` : ""}.`,
        recommendation: foundryHealth.dns?.ok
          ? null
          : "Verify FOUNDRY_TARGET hostname spelling and DNS availability from this runtime.",
      });
    }

    if (foundryHealth.targetHost && foundryHealth.targetPort) {
      checks.push({
        id: "proxy.foundry-tcp",
        title: "Foundry target TCP connect",
        status: foundryHealth.tcp?.ok ? "ok" : "error",
        detail: foundryHealth.tcp?.ok
          ? `TCP connect to ${foundryHealth.targetHost}:${foundryHealth.targetPort} succeeded in ${foundryHealth.tcp.durationMs}ms.`
          : `TCP connect to ${foundryHealth.targetHost}:${foundryHealth.targetPort} failed${foundryHealth.tcp?.error ? ` (${foundryHealth.tcp.error})` : ""}.`,
        recommendation: foundryHealth.tcp?.ok
          ? null
          : "Check Foundry listener bind address, firewall rules, and whether the target host:port is reachable from Blastdoor runtime.",
      });
    }

    if (foundryHealth.targetIsLoopback && (environment.isWsl || environment.isContainer)) {
      checks.push({
        id: "proxy.foundry-loopback-runtime",
        title: "Foundry loopback target in isolated runtime",
        status: "warn",
        detail: foundryHealth.runtimeHint || "Foundry target uses localhost/loopback from an isolated runtime.",
        recommendation:
          "Set FOUNDRY_TARGET to a host-reachable address (for Docker often host.docker.internal, otherwise host/LAN IP) and restart Blastdoor.",
      });
    }

    const assistantEnabled = parseBooleanLike(config.ASSISTANT_ENABLED, false);
    const assistantProvider = normalizeString(config.ASSISTANT_PROVIDER, "ollama").toLowerCase();
    const assistantOllamaUrl = normalizeString(config.ASSISTANT_OLLAMA_URL, "");
    if (assistantEnabled && assistantProvider === "ollama" && assistantOllamaUrl) {
      try {
        const parsedAssistantUrl = new URL(assistantOllamaUrl);
        if (isLoopbackHost(parsedAssistantUrl.hostname) && (environment.isWsl || environment.isContainer)) {
          checks.push({
            id: "assistant.ollama-loopback-runtime",
            title: "Ollama loopback URL in isolated runtime",
            status: "warn",
            detail:
              "ASSISTANT_OLLAMA_URL uses localhost/loopback while Blastdoor runs in WSL/container, which usually cannot reach host Ollama.",
            recommendation:
              "Set ASSISTANT_OLLAMA_URL to a host-reachable address (for WSL use the Windows host gateway IP; for Docker often host.docker.internal), then restart Blastdoor.",
          });
        }
      } catch {
        checks.push({
          id: "assistant.ollama-url-invalid",
          title: "Ollama URL format",
          status: "error",
          detail: `ASSISTANT_OLLAMA_URL is invalid (${assistantOllamaUrl}).`,
          recommendation: "Set ASSISTANT_OLLAMA_URL to a valid http(s) URL such as http://127.0.0.1:11434.",
        });
      }
    }

    const cookieSecure = parseBooleanLike(config.COOKIE_SECURE, false);
    checks.push({
      id: "auth.cookie-secure",
      title: "Cookie security over HTTP",
      status: cookieSecure ? "warn" : "ok",
      detail: cookieSecure
        ? "COOKIE_SECURE=true. Authentication cookies are only sent over HTTPS."
        : "COOKIE_SECURE=false. Local HTTP testing is allowed.",
      recommendation: cookieSecure
        ? "Use HTTPS for external access, or set COOKIE_SECURE=false for local HTTP testing only."
        : "Enable COOKIE_SECURE=true when fronting Blastdoor with TLS.",
    });

    if (environment.isWsl) {
      checks.push({
        id: "network.wsl2-portproxy",
        title: "WSL2 LAN routing",
        status: "warn",
        detail:
          "WSL2 uses NAT. localhost works on the host machine, but LAN clients usually need Windows portproxy and firewall rules.",
        recommendation:
          "Run non-destructive detection first, then review and apply the generated Windows portproxy script if needed.",
      });
    }

    return checks;
  }

  function buildGuidedActions({ environment, config }) {
    if (!environment.isWsl) {
      return [];
    }

    return [
      {
        id: "guide.wsl2-portproxy-fix",
        title: "WSL2 portproxy update script",
        destructive: true,
        riskLevel: "potentially-destructive",
        description:
          "Generates a Windows PowerShell script to update portproxy and firewall rules for LAN access.",
        script: buildWslPortproxyScript({ environment, config }),
        warning:
          "This changes Windows networking configuration. Review and run manually, and research commands independently before applying.",
      },
    ];
  }

  function buildSafeActions(environment) {
    const actions = [
      {
        id: "snapshot.network",
        title: "Gather network snapshot",
        destructive: false,
        description: "Collect read-only networking command outputs (ss, ip, route, hostname, ufw status).",
      },
      {
        id: "check.gateway-local",
        title: "Test gateway access",
        destructive: false,
        description: "Runs local health checks against configured Blastdoor endpoints.",
      },
    ];

    if (environment.isWsl) {
      actions.push({
        id: "detect.wsl-portproxy",
        title: "Detect Windows portproxy",
        destructive: false,
        description: "Runs read-only checks for Windows portproxy and firewall rule visibility from WSL.",
      });
      actions.push({
        id: "fix.wsl-foundry-target",
        title: "Auto-fix WSL Foundry target",
        destructive: false,
        description: "Detects Windows host gateway IP and updates FOUNDRY_TARGET in .env for WSL reachability.",
      });
    }

    return actions;
  }

  function createLoginAppearanceChecks(loginAppearance) {
    if (!loginAppearance || typeof loginAppearance !== "object") {
      return [];
    }

    if (loginAppearance.error) {
      return [
        {
          id: "login-theme.diagnostics-error",
          title: "Login appearance diagnostics",
          status: "warn",
          detail: `Unable to evaluate login appearance settings (${loginAppearance.error}).`,
          recommendation: "Verify theme store configuration and graphics directory permissions.",
        },
      ];
    }

    const checks = [];
    const themeName = loginAppearance.activeThemeName || loginAppearance.activeThemeId || "unknown";
    const logo = loginAppearance.assets?.logo;
    const closedBackground = loginAppearance.assets?.closedBackground;
    const openBackground = loginAppearance.assets?.openBackground;

    if (logo?.exists === false) {
      checks.push({
        id: "login-theme.logo-missing",
        title: "Login logo asset",
        status: "warn",
        detail: `Active theme '${themeName}' references missing logo asset '${logo.path || "unset"}'.`,
        recommendation: "Select a valid logo in Login Screen Management, or clear the logo path.",
      });
    }

    if (closedBackground?.exists === false) {
      checks.push({
        id: "login-theme.closed-background-missing",
        title: "Login closed background asset",
        status: "error",
        detail: `Active theme '${themeName}' references missing closed background '${closedBackground.path || "unset"}'.`,
        recommendation: "Set a valid closed background image in Login Screen Management.",
      });
    }

    if (openBackground?.exists === false) {
      checks.push({
        id: "login-theme.open-background-missing",
        title: "Login open background asset",
        status: "warn",
        detail: `Active theme '${themeName}' references missing open background '${openBackground.path || "unset"}'.`,
        recommendation: "Set a valid open background image, or leave it empty to keep closed background during transition.",
      });
    }

    if (checks.length === 0) {
      checks.push({
        id: "login-theme.assets",
        title: "Login theme assets",
        status: "ok",
        detail: `Active theme '${themeName}' asset paths are valid.`,
        recommendation: null,
      });
    }

    return checks;
  }

  function createTroubleshootReport({ config, health, foundryHealth, environment, serviceStatus, loginAppearance }) {
    const checks = [
      ...createTroubleshootChecks({ config, health, foundryHealth, environment }),
      ...createLoginAppearanceChecks(loginAppearance),
    ];

    return {
      generatedAt: new Date().toISOString(),
      serviceStatus,
      environment,
      loginAppearance,
      checks,
      safeActions: buildSafeActions(environment),
      guidedActions: buildGuidedActions({ environment, config }),
    };
  }

  async function resolveThemeAssetState(graphicsDir, relativePath, url) {
    const normalizedPath = normalizeThemeAssetRelativePath(relativePath);
    const normalizedUrl = normalizeString(url, "");
    if (!normalizedPath) {
      return {
        path: "",
        url: normalizedUrl,
        exists: null,
        status: "unset",
      };
    }

    const absolutePath = resolveThemeAssetAbsolutePath(graphicsDir, normalizedPath);
    if (!absolutePath) {
      return {
        path: normalizedPath,
        url: normalizedUrl,
        exists: false,
        status: "invalid-path",
      };
    }

    try {
      await accessFile(absolutePath);
      return {
        path: normalizedPath,
        url: normalizedUrl,
        exists: true,
        status: "ok",
      };
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return {
          path: normalizedPath,
          url: normalizedUrl,
          exists: false,
          status: "missing",
        };
      }
      return {
        path: normalizedPath,
        url: normalizedUrl,
        exists: false,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function resolveLoginAppearanceDetails() {
    try {
      return await withBlastdoorApi(async ({ blastdoorApi, runtimeConfig }) => {
        const [store, assets] = await Promise.all([blastdoorApi.readThemeStore(), blastdoorApi.listThemeAssets()]);
        const themes = Array.isArray(store?.themes) ? store.themes : [];
        const activeThemeId = normalizeString(store?.activeThemeId, defaultThemeId);
        const activeThemeRaw = themes.find((theme) => normalizeString(theme?.id, "") === activeThemeId) || themes[0] || null;
        const activeTheme = normalizeLoginAppearanceTheme(activeThemeRaw ? mapThemeForClient(activeThemeRaw) : {});

        const graphicsDir = runtimeConfig?.graphicsDir;
        const [logoState, closedBackgroundState, openBackgroundState] = await Promise.all([
          resolveThemeAssetState(graphicsDir, activeTheme.logoPath, activeTheme.logoUrl),
          resolveThemeAssetState(graphicsDir, activeTheme.closedBackgroundPath, activeTheme.closedBackgroundUrl),
          resolveThemeAssetState(graphicsDir, activeTheme.openBackgroundPath, activeTheme.openBackgroundUrl),
        ]);

        const details = {
          activeThemeId,
          activeThemeName: activeTheme.name || activeTheme.id || "",
          themesAvailable: themes.length,
          themeCatalog: themes.map((theme) => ({
            id: normalizeString(theme?.id, ""),
            name: normalizeString(theme?.name, ""),
          })),
          assetCounts: {
            logos: Array.isArray(assets?.logos) ? assets.logos.length : 0,
            backgrounds: Array.isArray(assets?.backgrounds) ? assets.backgrounds.length : 0,
          },
          assets: {
            logo: logoState,
            closedBackground: closedBackgroundState,
            openBackground: openBackgroundState,
          },
          activeTheme: {
            id: activeTheme.id,
            name: activeTheme.name,
            logoPath: activeTheme.logoPath,
            logoUrl: activeTheme.logoUrl,
            closedBackgroundPath: activeTheme.closedBackgroundPath,
            closedBackgroundUrl: activeTheme.closedBackgroundUrl,
            openBackgroundPath: activeTheme.openBackgroundPath,
            openBackgroundUrl: activeTheme.openBackgroundUrl,
            loginBoxMode: activeTheme.loginBoxMode,
            loginBoxWidthPercent: activeTheme.loginBoxWidthPercent,
            loginBoxHeightPercent: activeTheme.loginBoxHeightPercent,
            loginBoxOpacityPercent: activeTheme.loginBoxOpacityPercent,
            loginBoxHoverOpacityPercent: activeTheme.loginBoxHoverOpacityPercent,
            loginBoxPosXPercent: activeTheme.loginBoxPosXPercent,
            loginBoxPosYPercent: activeTheme.loginBoxPosYPercent,
            logoSizePercent: activeTheme.logoSizePercent,
            logoOffsetXPercent: activeTheme.logoOffsetXPercent,
            logoOffsetYPercent: activeTheme.logoOffsetYPercent,
            backgroundZoomPercent: activeTheme.backgroundZoomPercent,
          },
        };

        details.copyPasteText = formatLoginAppearanceCopyPasteText(details);
        return details;
      });
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        activeThemeId: "",
        activeThemeName: "",
        themesAvailable: 0,
        themeCatalog: [],
        assetCounts: { logos: 0, backgrounds: 0 },
        assets: {
          logo: { path: "", url: "", exists: null, status: "unknown" },
          closedBackground: { path: "", url: "", exists: null, status: "unknown" },
          openBackground: { path: "", url: "", exists: null, status: "unknown" },
        },
        activeTheme: {
          id: "",
          name: "",
          logoPath: "",
          logoUrl: "",
          closedBackgroundPath: "",
          closedBackgroundUrl: "",
          openBackgroundPath: "",
          openBackgroundUrl: "",
          loginBoxMode: "dark",
          loginBoxWidthPercent: 100,
          loginBoxHeightPercent: 100,
          loginBoxOpacityPercent: 100,
          loginBoxHoverOpacityPercent: 100,
          loginBoxPosXPercent: 50,
          loginBoxPosYPercent: 50,
          logoSizePercent: 30,
          logoOffsetXPercent: 2,
          logoOffsetYPercent: 2,
          backgroundZoomPercent: 100,
        },
        copyPasteText: "",
      };
    }
  }

  async function buildDiagnosticsPayload() {
    const config = await readEnvConfig(envPath);
    const serviceStatus = processState.getStatus();
    const [health, foundryHealth] = await Promise.all([checkBlastdoorHealth(config), checkFoundryTargetHealth(config)]);
    const environment = detectEnvironmentInfo({ workspaceDir, envPath });
    const diagnosticsConfig = sanitizeConfigForDiagnostics(config);
    const loginAppearance = await resolveLoginAppearanceDetails();

    const report = {
      generatedAt: new Date().toISOString(),
      serviceStatus,
      health,
      foundryHealth,
      environment,
      config: diagnosticsConfig,
      loginAppearance,
    };

    return {
      ok: true,
      report,
      summary: createDiagnosticsSummary(report),
    };
  }

  async function buildTroubleshootPayload() {
    const config = await readEnvConfig(envPath);
    const serviceStatus = processState.getStatus();
    const [health, foundryHealth] = await Promise.all([checkBlastdoorHealth(config), checkFoundryTargetHealth(config)]);
    const environment = detectEnvironmentInfo({ workspaceDir, envPath });
    const loginAppearance = await resolveLoginAppearanceDetails();
    const report = createTroubleshootReport({ config, health, foundryHealth, environment, serviceStatus, loginAppearance });
    return {
      ok: true,
      report,
    };
  }

  async function runTroubleshootAction({ actionId, config, environment, workspaceDir: runWorkspaceDir, commandRunner: runCommandRunner, envPath: runEnvPath }) {
    const runtimeWorkspaceDir = runWorkspaceDir || workspaceDir;
    const runtimeCommandRunner = runCommandRunner || commandRunner;
    const runtimeEnvPath = runEnvPath || envPath;

    if (actionId === "snapshot.network") {
      const outputs = await runCommandBatch(
        runtimeCommandRunner,
        [
          { label: "Listening TCP sockets", command: "ss", args: ["-ltn"] },
          { label: "IPv4 interfaces", command: "ip", args: ["-4", "addr", "show"] },
          { label: "Route table", command: "ip", args: ["route"] },
          { label: "Host IP addresses", command: "hostname", args: ["-I"] },
          { label: "UFW status (if installed)", command: "ufw", args: ["status"] },
        ],
        runtimeWorkspaceDir,
      );

      return {
        actionId,
        title: "Network snapshot",
        destructive: false,
        generatedAt: new Date().toISOString(),
        outputs,
      };
    }

    if (actionId === "check.gateway-local") {
      const outputs = await runGatewayLocalChecks(config);
      return {
        actionId,
        title: "Gateway local access checks",
        destructive: false,
        generatedAt: new Date().toISOString(),
        outputs,
      };
    }

    if (actionId === "detect.wsl-portproxy") {
      if (!environment.isWsl) {
        throw new Error("detect.wsl-portproxy is only available when running inside WSL.");
      }

      const port = Number.parseInt(config.PORT || configDefaults.PORT, 10);
      const outputs = await runCommandBatch(
        runtimeCommandRunner,
        [
          {
            label: "Windows portproxy entries",
            command: "powershell.exe",
            args: ["-NoProfile", "-Command", "netsh interface portproxy show all"],
          },
          {
            label: "Windows firewall rule check",
            command: "powershell.exe",
            args: [
              "-NoProfile",
              "-Command",
              `Get-NetFirewallRule -DisplayName 'Blastdoor ${port}' | Format-Table -AutoSize DisplayName,Enabled,Direction,Action`,
            ],
          },
        ],
        runtimeWorkspaceDir,
      );

      return {
        actionId,
        title: "WSL2 portproxy detection",
        destructive: false,
        generatedAt: new Date().toISOString(),
        outputs,
      };
    }

    if (actionId === "fix.wsl-foundry-target") {
      if (!environment.isWsl) {
        throw new Error("fix.wsl-foundry-target is only available when running inside WSL.");
      }
      if (!runtimeEnvPath) {
        throw new Error("envPath is required for fix.wsl-foundry-target.");
      }

      const { gatewayIp, commandResult: routeResult } = await detectWslDefaultGatewayIp({
        workspaceDir: runtimeWorkspaceDir,
        commandRunner: runtimeCommandRunner,
      });

      const previousFoundryTarget = normalizeString(config.FOUNDRY_TARGET, configDefaults.FOUNDRY_TARGET);
      const newFoundryTarget = buildWslFoundryTarget(config, gatewayIp);
      const changedConfig = previousFoundryTarget !== newFoundryTarget;
      if (changedConfig) {
        const nextConfig = {
          ...config,
          FOUNDRY_TARGET: newFoundryTarget,
        };
        validateConfig(loadConfigFromEnv(nextConfig));
        await writeEnvConfig(runtimeEnvPath, nextConfig);
      }

      return {
        actionId,
        title: "WSL Foundry target auto-fix",
        destructive: false,
        generatedAt: new Date().toISOString(),
        changedConfig,
        requiresRestart: changedConfig,
        previousFoundryTarget,
        newFoundryTarget,
        outputs: [
          {
            label: "WSL default gateway detection",
            command: "ip route show default",
            ok: true,
            stdout: String(routeResult.stdout || "").trim(),
            stderr: String(routeResult.stderr || "").trim(),
          },
          {
            label: "FOUNDRY_TARGET update",
            ok: true,
            stdout: changedConfig
              ? `Updated FOUNDRY_TARGET\nfrom: ${previousFoundryTarget}\nto:   ${newFoundryTarget}\nRestart required: yes`
              : `No change needed. FOUNDRY_TARGET already set to ${newFoundryTarget}`,
          },
        ],
      };
    }

    throw new Error(`Unknown or unsupported troubleshooting action '${actionId}'.`);
  }

  return {
    createTroubleshootReport,
    buildDiagnosticsPayload,
    buildTroubleshootPayload,
    runTroubleshootAction,
  };
}
