export function registerManagerConfigRoutes(options = {}) {
  const {
    registerApiGet,
    registerApiPost,
    readConsoleSettings,
    writeConsoleSettings,
    sanitizeManagerConsoleSettingsForClient,
    normalizeManagerConsoleSettings,
    parseBooleanLikeBody,
    normalizeString,
    createPasswordHash,
    readEnvConfig,
    envPath,
    scrubConfigForClient,
    detectEnvironmentInfo,
    workspaceDir,
    detectWslDefaultGatewayIp,
    commandRunner,
    buildWslFoundryTarget,
    checkFoundryTargetHealth,
    probeFoundryApiStatus,
    buildWslOllamaUrl,
    probeHttpHealth,
    parseBodyConfig,
    sensitiveConfigKeys,
    parseBooleanLike,
    createSessionSecret,
    validateConfig,
    loadConfigFromEnv,
    writeEnvConfig,
    writeBlastDoorsState,
    runtimeStatePath,
    configDefaults,
    processState,
    listConfigBackups,
    configBackupDir,
    validateConfigBackupId,
    viewConfigBackup,
    createConfigBackup,
    restoreConfigBackup,
    deleteConfigBackup,
    cleanInstallConfiguration,
    detectTlsEnvironment,
    normalizeTlsChallengeMethod,
    normalizeTlsConfigBody,
    buildLetsEncryptPlan,
    accessFile,
    resolvePath,
  } = options;

  registerApiGet("/manager-settings", async (_req, res) => {
    try {
      const settings = await readConsoleSettings();
      res.json({
        ok: true,
        settings: sanitizeManagerConsoleSettingsForClient(settings),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/manager-settings/layout", async (req, res) => {
    try {
      const current = await readConsoleSettings();
      const next = normalizeManagerConsoleSettings({
        ...current,
        layout: {
          ...(current.layout || {}),
          darkModePercent: req.body?.darkModePercent,
          lightModePercent: req.body?.lightModePercent,
        },
      });
      const saved = await writeConsoleSettings(next);
      res.json({
        ok: true,
        settings: sanitizeManagerConsoleSettingsForClient(saved),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/manager-settings/access", async (req, res) => {
    try {
      const current = await readConsoleSettings();
      const requirePassword = parseBooleanLikeBody(req.body?.requirePassword);
      const newPassword = normalizeString(req.body?.password, "");
      const clearPassword = parseBooleanLikeBody(req.body?.clearPassword);
      const next = normalizeManagerConsoleSettings({
        ...current,
        access: {
          ...(current.access || {}),
          requirePassword,
          sessionTtlHours: req.body?.sessionTtlHours,
          passwordHash: current.access?.passwordHash || "",
        },
      });

      if (newPassword) {
        next.access.passwordHash = createPasswordHash(newPassword);
      } else if (clearPassword && !requirePassword) {
        next.access.passwordHash = "";
      }

      if (requirePassword && !next.access.passwordHash) {
        throw new Error("Password is required when manager access protection is enabled.");
      }

      const saved = await writeConsoleSettings(next);
      res.json({
        ok: true,
        settings: sanitizeManagerConsoleSettingsForClient(saved),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/config", async (_req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      res.json({
        envPath,
        config: scrubConfigForClient(config),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/config/foundry-target-autodetect", async (_req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const environment = detectEnvironmentInfo({ workspaceDir, envPath });
      if (!environment.isWsl) {
        throw new Error("FOUNDRY_TARGET autodetect is currently available only in WSL.");
      }

      const { gatewayIp } = await detectWslDefaultGatewayIp({
        workspaceDir,
        commandRunner,
      });

      const foundryTarget = buildWslFoundryTarget(config, gatewayIp);
      const suggestedConfig = {
        ...config,
        FOUNDRY_TARGET: foundryTarget,
      };
      const [health, apiStatus] = await Promise.all([
        checkFoundryTargetHealth(suggestedConfig),
        probeFoundryApiStatus(suggestedConfig, 1500),
      ]);

      res.json({
        ok: true,
        foundryTarget,
        gatewayIp,
        health,
        apiStatus,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/config/assistant-ollama-url-autodetect", async (_req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const environment = detectEnvironmentInfo({ workspaceDir, envPath });
      if (!environment.isWsl) {
        throw new Error("ASSISTANT_OLLAMA_URL autodetect is currently available only in WSL.");
      }

      const { gatewayIp } = await detectWslDefaultGatewayIp({
        workspaceDir,
        commandRunner,
      });
      const assistantOllamaUrl = buildWslOllamaUrl(config, gatewayIp);
      const health = await probeHttpHealth(`${assistantOllamaUrl.replace(/\/+$/, "")}/api/tags`, 1500);

      res.json({
        ok: true,
        assistantOllamaUrl,
        gatewayIp,
        health,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/config", async (req, res) => {
    try {
      const existing = await readEnvConfig(envPath);
      const incoming = parseBodyConfig(req.body || {}, existing);

      const passwordInput = normalizeString(req.body?.AUTH_PASSWORD || "");
      if (passwordInput.length > 0) {
        incoming.AUTH_PASSWORD_HASH = createPasswordHash(passwordInput);
      } else {
        incoming.AUTH_PASSWORD_HASH = existing.AUTH_PASSWORD_HASH || "";
      }

      for (const key of sensitiveConfigKeys) {
        if (incoming[key] === "********") {
          incoming[key] = existing[key] || "";
        }
      }

      const wasBlastDoorsClosed = parseBooleanLike(existing.BLAST_DOORS_CLOSED, false);
      const willBlastDoorsClose = parseBooleanLike(incoming.BLAST_DOORS_CLOSED, false);
      let sessionSecretRotated = false;
      if (!wasBlastDoorsClosed && willBlastDoorsClose) {
        incoming.SESSION_SECRET = createSessionSecret();
        sessionSecretRotated = true;
      }

      validateConfig(loadConfigFromEnv({ ...incoming }));
      await writeEnvConfig(envPath, incoming);
      await writeBlastDoorsState(runtimeStatePath, parseBooleanLike(incoming.BLAST_DOORS_CLOSED, false));

      const blastDoorsChanged =
        normalizeString(existing.BLAST_DOORS_CLOSED, configDefaults.BLAST_DOORS_CLOSED) !==
        normalizeString(incoming.BLAST_DOORS_CLOSED, configDefaults.BLAST_DOORS_CLOSED);

      let serviceRestarted = false;
      if (blastDoorsChanged && processState.getStatus().running) {
        await processState.stop();
        await processState.start();
        serviceRestarted = true;
      }

      res.json({
        ok: true,
        config: scrubConfigForClient({ ...existing, ...incoming }),
        runtime: {
          blastDoorsChanged,
          serviceRestarted,
          sessionSecretRotated,
        },
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/config-backups", async (_req, res) => {
    try {
      const backups = await listConfigBackups();
      res.json({
        ok: true,
        backupDir: configBackupDir,
        backups,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/config-backups/view", async (req, res) => {
    try {
      const backupId = validateConfigBackupId(req.query.backupId);
      const payload = await viewConfigBackup(backupId);
      res.json({
        ok: true,
        ...payload,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/config-backups/create", async (req, res) => {
    try {
      const manifest = await createConfigBackup(req.body?.name || "");
      const backups = await listConfigBackups();
      res.json({
        ok: true,
        backup: manifest,
        backups,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/config-backups/restore", async (req, res) => {
    try {
      const backupId = validateConfigBackupId(req.body?.backupId);
      const result = await restoreConfigBackup(backupId);
      const backups = await listConfigBackups();
      res.json({
        ok: true,
        result,
        backups,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/config-backups/delete", async (req, res) => {
    try {
      const backupId = validateConfigBackupId(req.body?.backupId);
      const result = await deleteConfigBackup(backupId);
      const backups = await listConfigBackups();
      res.json({
        ok: true,
        result,
        backups,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/config-backups/clean-install", async (_req, res) => {
    try {
      const result = await cleanInstallConfiguration();
      res.json({
        ok: true,
        result,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/tls", async (_req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const detection = await detectTlsEnvironment(config);
      const tlsConfig = {
        tlsEnabled: parseBooleanLike(config.TLS_ENABLED, false),
        tlsDomain: normalizeString(config.TLS_DOMAIN, ""),
        tlsEmail: normalizeString(config.TLS_EMAIL, ""),
        tlsChallengeMethod: normalizeTlsChallengeMethod(config.TLS_CHALLENGE_METHOD, "webroot"),
        tlsWebrootPath: normalizeString(config.TLS_WEBROOT_PATH, "/var/www/html"),
        tlsCertFile: normalizeString(config.TLS_CERT_FILE, ""),
        tlsKeyFile: normalizeString(config.TLS_KEY_FILE, ""),
        tlsCaFile: normalizeString(config.TLS_CA_FILE, ""),
        tlsPassphraseSet: Boolean(normalizeString(config.TLS_PASSPHRASE, "")),
      };
      res.json({
        ok: true,
        tls: tlsConfig,
        detection,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/tls/save", async (req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const tlsConfig = normalizeTlsConfigBody(req.body || {}, config);

      if (tlsConfig.TLS_ENABLED === "true") {
        try {
          await accessFile(resolvePath(tlsConfig.TLS_CERT_FILE));
          await accessFile(resolvePath(tlsConfig.TLS_KEY_FILE));
        } catch (error) {
          throw new Error(
            `TLS is enabled but certificate/key files are not accessible: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }

      const merged = {
        ...config,
        ...tlsConfig,
      };
      validateConfig(loadConfigFromEnv(merged));
      await writeEnvConfig(envPath, merged);

      res.json({
        ok: true,
        tls: {
          tlsEnabled: parseBooleanLike(merged.TLS_ENABLED, false),
          tlsDomain: merged.TLS_DOMAIN || "",
          tlsEmail: merged.TLS_EMAIL || "",
          tlsChallengeMethod: normalizeTlsChallengeMethod(merged.TLS_CHALLENGE_METHOD, "webroot"),
          tlsWebrootPath: merged.TLS_WEBROOT_PATH || "",
          tlsCertFile: merged.TLS_CERT_FILE || "",
          tlsKeyFile: merged.TLS_KEY_FILE || "",
          tlsCaFile: merged.TLS_CA_FILE || "",
          tlsPassphraseSet: Boolean(merged.TLS_PASSPHRASE),
        },
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/tls/letsencrypt-plan", async (req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const tlsInput = normalizeTlsConfigBody(
        {
          ...config,
          ...(req.body || {}),
          tlsEnabled: false,
        },
        config,
      );
      const detection = await detectTlsEnvironment({
        ...config,
        ...tlsInput,
      });
      const plan = buildLetsEncryptPlan({
        domain: tlsInput.TLS_DOMAIN,
        email: tlsInput.TLS_EMAIL,
        challengeMethod: tlsInput.TLS_CHALLENGE_METHOD,
        webrootPath: tlsInput.TLS_WEBROOT_PATH || "/var/www/html",
        certFile: tlsInput.TLS_CERT_FILE,
        keyFile: tlsInput.TLS_KEY_FILE,
        certbotAvailable: detection.certbotAvailable,
        dockerAvailable: detection.dockerAvailable,
      });
      res.json({
        ok: true,
        plan,
        detection,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
