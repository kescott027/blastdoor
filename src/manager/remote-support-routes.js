export function registerRemoteSupportRoutes(options = {}) {
  const {
    registerApiGet,
    registerApiPost,
    registerRemoteSupportGet,
    registerRemoteSupportPost,
    normalizeString,
    parseBooleanLike,
    readConsoleSettings,
    writeConsoleSettings,
    clampRemoteSupportTokenTtlMinutes,
    remoteSupportTokenMinTtlMinutes,
    remoteSupportTokenMaxTtlMinutes,
    remoteSupportDefaultTokenLabel,
    trimCallHomeEvents,
    summarizeRemoteSupportToken,
    callHomeEventsMax,
    syncRemoteSupportWslExposure,
    detectEnvironmentInfo,
    workspaceDir,
    envPath,
    commandRunner,
    randomBytes,
    randomUUID,
    createPasswordHash,
    buildRemoteSupportCurlExamples,
    buildCallHomePodBundle,
    buildRemoteSupportApiBasePath,
    appendCallHomeEvent,
    buildDiagnosticsPayload,
    buildRemoteSupportCommandHints,
    buildTroubleshootPayload,
    remoteSupportSafeActionAllowlist,
    readEnvConfig,
    runTroubleshootAction,
    withBlastdoorApi,
    readIntelligenceAgentStore,
    intelligenceAgentStorePath,
    operationTimeoutMs = 20_000,
  } = options;

  async function withOperationTimeout(task, label) {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${label} timed out after ${operationTimeoutMs}ms.`));
      }, operationTimeoutMs);
      Promise.resolve()
        .then(task)
        .then((value) => {
          clearTimeout(timeout);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }

  registerApiGet("/remote-support/config", async (_req, res) => {
    try {
      const settings = await readConsoleSettings();
      const remoteSupport = settings.remoteSupport || {};
      const tokens = Array.isArray(remoteSupport.tokens) ? remoteSupport.tokens : [];
      res.json({
        ok: true,
        config: {
          enabled: remoteSupport.enabled === true,
          callHomeEnabled: remoteSupport.callHomeEnabled === true,
          defaultTokenTtlMinutes: clampRemoteSupportTokenTtlMinutes(
            remoteSupport.defaultTokenTtlMinutes,
            remoteSupportTokenMinTtlMinutes,
          ),
          minTokenTtlMinutes: remoteSupportTokenMinTtlMinutes,
          maxTokenTtlMinutes: remoteSupportTokenMaxTtlMinutes,
          tokens: tokens.map(summarizeRemoteSupportToken),
          callHomeEvents: trimCallHomeEvents(remoteSupport.callHomeEvents, 50),
        },
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/remote-support/config", async (req, res) => {
    try {
      const current = await readConsoleSettings();
      const currentRemoteSupport = current.remoteSupport || {};
      const previousEnabled = currentRemoteSupport.enabled === true;
      const enabled = parseBooleanLike(req.body?.enabled, currentRemoteSupport.enabled === true);
      const callHomeEnabled = parseBooleanLike(req.body?.callHomeEnabled, currentRemoteSupport.callHomeEnabled === true);
      const defaultTokenTtlMinutes = clampRemoteSupportTokenTtlMinutes(
        req.body?.defaultTokenTtlMinutes,
        clampRemoteSupportTokenTtlMinutes(
          currentRemoteSupport.defaultTokenTtlMinutes,
          remoteSupportTokenMinTtlMinutes,
        ),
      );

      const next = await writeConsoleSettings({
        ...current,
        remoteSupport: {
          ...currentRemoteSupport,
          enabled,
          callHomeEnabled,
          defaultTokenTtlMinutes,
          tokens: Array.isArray(currentRemoteSupport.tokens) ? currentRemoteSupport.tokens : [],
          callHomeEvents: trimCallHomeEvents(currentRemoteSupport.callHomeEvents, callHomeEventsMax),
        },
      });

      let networkExposure = null;
      if (enabled !== previousEnabled) {
        const environment = detectEnvironmentInfo({ workspaceDir, envPath });
        networkExposure = await withOperationTimeout(
          async () =>
            await syncRemoteSupportWslExposure({
              enabled,
              environment,
              workspaceDir,
              commandRunner,
            }),
          "syncRemoteSupportWslExposure",
        );
      }

      res.json({
        ok: true,
        config: {
          enabled: next.remoteSupport.enabled === true,
          callHomeEnabled: next.remoteSupport.callHomeEnabled === true,
          defaultTokenTtlMinutes: next.remoteSupport.defaultTokenTtlMinutes,
          minTokenTtlMinutes: remoteSupportTokenMinTtlMinutes,
          maxTokenTtlMinutes: remoteSupportTokenMaxTtlMinutes,
          tokens: (next.remoteSupport.tokens || []).map(summarizeRemoteSupportToken),
          callHomeEvents: trimCallHomeEvents(next.remoteSupport.callHomeEvents, 50),
        },
        networkExposure,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/remote-support/tokens/create", async (req, res) => {
    try {
      const current = await readConsoleSettings();
      const currentRemoteSupport = current.remoteSupport || {};
      if (currentRemoteSupport.enabled !== true) {
        throw new Error("Remote support API is disabled. Enable and save config before creating tokens.");
      }
      const ttlMinutes = clampRemoteSupportTokenTtlMinutes(
        req.body?.ttlMinutes,
        clampRemoteSupportTokenTtlMinutes(
          currentRemoteSupport.defaultTokenTtlMinutes,
          remoteSupportTokenMinTtlMinutes,
        ),
      );
      const label = normalizeString(req.body?.label, remoteSupportDefaultTokenLabel);
      const rawToken = randomBytes(24).toString("base64url");
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
      const tokenRecord = {
        tokenId: randomUUID(),
        label,
        tokenHash: createPasswordHash(rawToken),
        createdAt,
        expiresAt,
        lastUsedAt: "",
        revokedAt: "",
      };

      const next = await writeConsoleSettings({
        ...current,
        remoteSupport: {
          ...currentRemoteSupport,
          enabled: currentRemoteSupport.enabled === true,
          defaultTokenTtlMinutes: clampRemoteSupportTokenTtlMinutes(
            currentRemoteSupport.defaultTokenTtlMinutes,
            remoteSupportTokenMinTtlMinutes,
          ),
          tokens: [...(Array.isArray(currentRemoteSupport.tokens) ? currentRemoteSupport.tokens : []), tokenRecord],
        },
      });

      res.json({
        ok: true,
        token: rawToken,
        tokenMeta: summarizeRemoteSupportToken(tokenRecord),
        config: {
          enabled: next.remoteSupport.enabled === true,
          callHomeEnabled: next.remoteSupport.callHomeEnabled === true,
          defaultTokenTtlMinutes: next.remoteSupport.defaultTokenTtlMinutes,
          tokens: (next.remoteSupport.tokens || []).map(summarizeRemoteSupportToken),
          callHomeEvents: trimCallHomeEvents(next.remoteSupport.callHomeEvents, 50),
        },
        examples: buildRemoteSupportCurlExamples({ req, token: rawToken }),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/remote-support/tokens/revoke", async (req, res) => {
    try {
      const tokenId = normalizeString(req.body?.tokenId, "");
      if (!tokenId) {
        throw new Error("tokenId is required.");
      }

      const current = await readConsoleSettings();
      const currentRemoteSupport = current.remoteSupport || {};
      const currentTokens = Array.isArray(currentRemoteSupport.tokens) ? currentRemoteSupport.tokens : [];
      let found = false;
      const nextTokens = currentTokens.map((entry) => {
        if (normalizeString(entry?.tokenId, "") !== tokenId) {
          return entry;
        }
        found = true;
        return {
          ...entry,
          revokedAt: new Date().toISOString(),
        };
      });
      if (!found) {
        throw new Error("Token not found.");
      }

      const next = await writeConsoleSettings({
        ...current,
        remoteSupport: {
          ...currentRemoteSupport,
          enabled: currentRemoteSupport.enabled === true,
          defaultTokenTtlMinutes: clampRemoteSupportTokenTtlMinutes(
            currentRemoteSupport.defaultTokenTtlMinutes,
            remoteSupportTokenMinTtlMinutes,
          ),
          tokens: nextTokens,
        },
      });

      res.json({
        ok: true,
        tokenId,
        tokens: (next.remoteSupport.tokens || []).map(summarizeRemoteSupportToken),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/remote-support/tokens/rotate", async (req, res) => {
    try {
      const tokenId = normalizeString(req.body?.tokenId, "");
      if (!tokenId) {
        throw new Error("tokenId is required.");
      }

      const current = await readConsoleSettings();
      const currentRemoteSupport = current.remoteSupport || {};
      if (currentRemoteSupport.enabled !== true) {
        throw new Error("Remote support API is disabled. Enable and save config before rotating tokens.");
      }

      const currentTokens = Array.isArray(currentRemoteSupport.tokens) ? currentRemoteSupport.tokens : [];
      const existingToken = currentTokens.find((entry) => normalizeString(entry?.tokenId, "") === tokenId);
      if (!existingToken) {
        throw new Error("Token not found.");
      }

      const ttlMinutes = clampRemoteSupportTokenTtlMinutes(
        req.body?.ttlMinutes,
        clampRemoteSupportTokenTtlMinutes(
          currentRemoteSupport.defaultTokenTtlMinutes,
          remoteSupportTokenMinTtlMinutes,
        ),
      );
      const label = normalizeString(req.body?.label, normalizeString(existingToken?.label, remoteSupportDefaultTokenLabel));
      const rawToken = randomBytes(24).toString("base64url");
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
      const rotatedTokenRecord = {
        tokenId: randomUUID(),
        label,
        tokenHash: createPasswordHash(rawToken),
        createdAt,
        expiresAt,
        lastUsedAt: "",
        revokedAt: "",
      };

      const revokedAt = new Date().toISOString();
      const nextTokens = currentTokens.map((entry) => {
        if (normalizeString(entry?.tokenId, "") !== tokenId) {
          return entry;
        }
        return {
          ...entry,
          revokedAt,
        };
      });
      nextTokens.push(rotatedTokenRecord);

      const next = await writeConsoleSettings({
        ...current,
        remoteSupport: {
          ...currentRemoteSupport,
          enabled: true,
          defaultTokenTtlMinutes: clampRemoteSupportTokenTtlMinutes(
            currentRemoteSupport.defaultTokenTtlMinutes,
            remoteSupportTokenMinTtlMinutes,
          ),
          tokens: nextTokens,
        },
      });

      res.json({
        ok: true,
        revokedTokenId: tokenId,
        token: rawToken,
        tokenMeta: summarizeRemoteSupportToken(rotatedTokenRecord),
        config: {
          enabled: next.remoteSupport.enabled === true,
          callHomeEnabled: next.remoteSupport.callHomeEnabled === true,
          defaultTokenTtlMinutes: next.remoteSupport.defaultTokenTtlMinutes,
          tokens: (next.remoteSupport.tokens || []).map(summarizeRemoteSupportToken),
          callHomeEvents: trimCallHomeEvents(next.remoteSupport.callHomeEvents, 50),
        },
        examples: buildRemoteSupportCurlExamples({ req, token: rawToken }),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/call-home/config", async (_req, res) => {
    try {
      const settings = await readConsoleSettings();
      const remoteSupport = settings.remoteSupport || {};
      res.json({
        ok: true,
        config: {
          remoteSupportEnabled: remoteSupport.enabled === true,
          callHomeEnabled: remoteSupport.callHomeEnabled === true,
          callHomeEventCount: Array.isArray(remoteSupport.callHomeEvents) ? remoteSupport.callHomeEvents.length : 0,
          defaultTokenTtlMinutes: clampRemoteSupportTokenTtlMinutes(
            remoteSupport.defaultTokenTtlMinutes,
            remoteSupportTokenMinTtlMinutes,
          ),
          minTokenTtlMinutes: remoteSupportTokenMinTtlMinutes,
          maxTokenTtlMinutes: remoteSupportTokenMaxTtlMinutes,
        },
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/call-home/events", async (req, res) => {
    try {
      const settings = await readConsoleSettings();
      const remoteSupport = settings.remoteSupport || {};
      const limit = Math.max(1, Math.min(200, Number.parseInt(String(req.query?.limit || "50"), 10) || 50));
      const events = trimCallHomeEvents(remoteSupport.callHomeEvents, limit);
      res.json({
        ok: true,
        events,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/call-home/events/clear", async (_req, res) => {
    try {
      const current = await readConsoleSettings();
      const currentRemoteSupport = current.remoteSupport || {};
      const next = await writeConsoleSettings({
        ...current,
        remoteSupport: {
          ...currentRemoteSupport,
          callHomeEvents: [],
        },
      });
      res.json({
        ok: true,
        events: trimCallHomeEvents(next.remoteSupport.callHomeEvents, 50),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/call-home/pods/generate", async (req, res) => {
    try {
      const current = await readConsoleSettings();
      const currentRemoteSupport = current.remoteSupport || {};
      if (currentRemoteSupport.enabled !== true) {
        throw new Error("Remote support API must be enabled before generating a diagnostic pod.");
      }
      if (currentRemoteSupport.callHomeEnabled !== true) {
        throw new Error("Call-home API must be enabled before generating a diagnostic pod.");
      }

      const ttlMinutes = clampRemoteSupportTokenTtlMinutes(
        req.body?.ttlMinutes,
        clampRemoteSupportTokenTtlMinutes(
          currentRemoteSupport.defaultTokenTtlMinutes,
          remoteSupportTokenMinTtlMinutes,
        ),
      );
      const label = normalizeString(req.body?.label, "Diagnostic Pod Token");
      const rawToken = randomBytes(24).toString("base64url");
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
      const tokenRecord = {
        tokenId: randomUUID(),
        label,
        tokenHash: createPasswordHash(rawToken),
        createdAt,
        expiresAt,
        lastUsedAt: "",
        revokedAt: "",
      };

      const next = await writeConsoleSettings({
        ...current,
        remoteSupport: {
          ...currentRemoteSupport,
          tokens: [...(Array.isArray(currentRemoteSupport.tokens) ? currentRemoteSupport.tokens : []), tokenRecord],
          callHomeEvents: trimCallHomeEvents(currentRemoteSupport.callHomeEvents, callHomeEventsMax),
        },
      });

      const pod = buildCallHomePodBundle({
        req,
        token: rawToken,
        tokenMeta: summarizeRemoteSupportToken(tokenRecord),
        ttlMinutes,
      });

      res.json({
        ok: true,
        pod,
        config: {
          enabled: next.remoteSupport.enabled === true,
          callHomeEnabled: next.remoteSupport.callHomeEnabled === true,
          defaultTokenTtlMinutes: next.remoteSupport.defaultTokenTtlMinutes,
          tokens: (next.remoteSupport.tokens || []).map(summarizeRemoteSupportToken),
        },
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerRemoteSupportGet("/openapi.json", async (req, res) => {
    const baseUrl = buildRemoteSupportApiBasePath(req).replace(/\/+$/, "");
    res.json({
      openapi: "3.0.3",
      info: {
        title: "Blastdoor Remote Support API",
        version: "1.0.0",
        description: "Token-authenticated, non-destructive diagnostics and intelligence command API.",
      },
      servers: [{ url: baseUrl }],
      components: {
        securitySchemes: {
          SupportTokenHeader: {
            type: "apiKey",
            in: "header",
            name: "x-blastdoor-support-token",
          },
          BearerToken: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
      security: [{ SupportTokenHeader: [] }, { BearerToken: [] }],
      paths: {
        "/diagnostics": { get: { summary: "Get sanitized diagnostics report." } },
        "/troubleshoot": { get: { summary: "Get troubleshooting report with safe actions." } },
        "/troubleshoot/run": { post: { summary: "Run non-destructive troubleshooting action by actionId." } },
        "/intelligence/status": { get: { summary: "Get intelligence module status." } },
        "/intelligence/workflow/chat": { post: { summary: "Send a command to an intelligence workflow." } },
        "/intelligence/agents": { get: { summary: "List configured intelligence agents." } },
        "/intelligence/agents/{agentName}/command": { post: { summary: "Send a command to an agent workflow." } },
        "/call-home/healthz": { get: { summary: "Call-home endpoint health check." } },
        "/call-home/register": { post: { summary: "Register a diagnostic satellite pod with the control plane." } },
        "/call-home/report": { post: { summary: "Submit call-home diagnostic event/report payload." } },
      },
    });
  });

  registerRemoteSupportGet("/healthz", async (_req, res) => {
    res.json({
      ok: true,
      service: "remote-support-api",
      generatedAt: new Date().toISOString(),
    });
  });

  registerRemoteSupportGet("/call-home/healthz", async (req, res) => {
    const remoteSupport = req.remoteSupportSettings?.remoteSupport || {};
    if (remoteSupport.callHomeEnabled !== true) {
      res.status(404).json({
        error: "Call-home API is disabled.",
      });
      return;
    }
    res.json({
      ok: true,
      service: "call-home-api",
      generatedAt: new Date().toISOString(),
      callHomeEnabled: true,
      tokenId: req.remoteSupportToken?.tokenId || "",
    });
  });

  registerRemoteSupportPost("/call-home/register", async (req, res) => {
    const remoteSupport = req.remoteSupportSettings?.remoteSupport || {};
    if (remoteSupport.callHomeEnabled !== true) {
      res.status(404).json({
        error: "Call-home API is disabled.",
      });
      return;
    }
    try {
      const satelliteId = normalizeString(req.body?.satelliteId, "");
      const status = normalizeString(req.body?.status, "starting");
      const message = normalizeString(req.body?.message, "");
      const payload = req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {};
      const next = await appendCallHomeEvent({
        settings: req.remoteSupportSettings,
        type: "register",
        satelliteId,
        status,
        message,
        payload: {
          ...payload,
          tokenId: req.remoteSupportToken?.tokenId || "",
          tokenLabel: req.remoteSupportToken?.label || "",
          sourceIp: normalizeString(req.ip, ""),
        },
      });
      res.json({
        ok: true,
        accepted: true,
        eventCount: Array.isArray(next.remoteSupport?.callHomeEvents) ? next.remoteSupport.callHomeEvents.length : 0,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerRemoteSupportPost("/call-home/report", async (req, res) => {
    const remoteSupport = req.remoteSupportSettings?.remoteSupport || {};
    if (remoteSupport.callHomeEnabled !== true) {
      res.status(404).json({
        error: "Call-home API is disabled.",
      });
      return;
    }
    try {
      const satelliteId = normalizeString(req.body?.satelliteId, "");
      const status = normalizeString(req.body?.status, "unknown");
      const message = normalizeString(req.body?.message, "");
      const payload = req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {};
      const next = await appendCallHomeEvent({
        settings: req.remoteSupportSettings,
        type: "report",
        satelliteId,
        status,
        message,
        payload: {
          ...payload,
          tokenId: req.remoteSupportToken?.tokenId || "",
          sourceIp: normalizeString(req.ip, ""),
        },
      });
      res.json({
        ok: true,
        accepted: true,
        eventCount: Array.isArray(next.remoteSupport?.callHomeEvents) ? next.remoteSupport.callHomeEvents.length : 0,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerRemoteSupportGet("/diagnostics", async (req, res) => {
    const payload = await buildDiagnosticsPayload();
    res.json({
      ...payload,
      commands: buildRemoteSupportCommandHints({
        req,
        config: payload?.report?.config || {},
        environment: payload?.report?.environment || {},
      }),
    });
  });

  registerRemoteSupportGet("/troubleshoot", async (_req, res) => {
    const payload = await buildTroubleshootPayload();
    const report = payload.report || {};
    report.safeActions = (report.safeActions || []).filter((entry) =>
      remoteSupportSafeActionAllowlist.has(normalizeString(entry?.id, "")),
    );
    report.guidedActions = [];
    res.json({
      ...payload,
      report,
    });
  });

  registerRemoteSupportPost("/troubleshoot/run", async (req, res) => {
    const actionId = normalizeString(req.body?.actionId, "");
    if (!actionId) {
      res.status(400).json({ error: "actionId is required." });
      return;
    }
    if (!remoteSupportSafeActionAllowlist.has(actionId)) {
      res.status(400).json({
        error: `Action '${actionId}' is not allowed for the remote support API.`,
        allowedActions: Array.from(remoteSupportSafeActionAllowlist.values()),
      });
      return;
    }

    try {
      const config = await readEnvConfig(envPath);
      const environment = detectEnvironmentInfo({ workspaceDir, envPath });
      const result = await withOperationTimeout(
        async () =>
          await runTroubleshootAction({
            actionId,
            config,
            environment,
            workspaceDir,
            commandRunner,
            envPath,
          }),
        "runTroubleshootAction",
      );

      res.json({
        ok: true,
        result,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerRemoteSupportGet("/intelligence/status", async (_req, res) => {
    try {
      const status = await withOperationTimeout(
        async () =>
          await withBlastdoorApi(async ({ blastdoorApi }) => {
            return await blastdoorApi.plugins?.intelligence?.getStatus();
          }),
        "intelligence.status",
      );
      res.json({
        ok: true,
        status: status || {},
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerRemoteSupportPost("/intelligence/workflow/chat", async (req, res) => {
    try {
      const workflowId = normalizeString(req.body?.workflowId, "troubleshoot-recommendation");
      const input = normalizeString(req.body?.input || req.body?.message, "");
      if (!input) {
        res.status(400).json({
          error: "input is required.",
        });
        return;
      }
      const context = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
      const result = await withOperationTimeout(
        async () =>
          await withBlastdoorApi(async ({ blastdoorApi }) => {
            return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
              workflowId,
              input,
              context,
            });
          }),
        "intelligence.workflow.chat",
      );
      res.json({
        ok: true,
        result: result || {},
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerRemoteSupportGet("/intelligence/agents", async (_req, res) => {
    try {
      const store = await readIntelligenceAgentStore(intelligenceAgentStorePath);
      const agents = (store.agents || []).map((agent) => ({
        id: normalizeString(agent?.id, ""),
        name: normalizeString(agent?.name, ""),
        intent: normalizeString(agent?.intent, ""),
        workflowId: normalizeString(agent?.workflow?.id, ""),
      }));
      res.json({
        ok: true,
        agents,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerRemoteSupportPost("/intelligence/agents/:agentName/command", async (req, res) => {
    try {
      const lookup = normalizeString(req.params?.agentName, "").toLowerCase();
      if (!lookup) {
        res.status(400).json({
          error: "agentName is required.",
        });
        return;
      }

      const store = await readIntelligenceAgentStore(intelligenceAgentStorePath);
      const agent = (store.agents || []).find((entry) => {
        return (
          normalizeString(entry?.id, "").toLowerCase() === lookup ||
          normalizeString(entry?.name, "").toLowerCase() === lookup
        );
      });

      if (!agent) {
        res.status(404).json({
          error: "Agent not found.",
        });
        return;
      }

      const workflowId = normalizeString(req.body?.workflowId, normalizeString(agent?.workflow?.id, ""));
      if (!workflowId) {
        res.status(400).json({
          error: "Agent does not have a workflowId configured.",
        });
        return;
      }
      const input = normalizeString(req.body?.input || req.body?.message, "");
      if (!input) {
        res.status(400).json({
          error: "input is required.",
        });
        return;
      }
      const result = await withOperationTimeout(
        async () =>
          await withBlastdoorApi(async ({ blastdoorApi }) => {
            return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
              workflowId,
              input,
              context: {
                remoteSupport: true,
                agentId: normalizeString(agent?.id, ""),
                agentName: normalizeString(agent?.name, ""),
                agentIntent: normalizeString(agent?.intent, ""),
              },
            });
          }),
        "intelligence.agent.command",
      );
      res.json({
        ok: true,
        agent: {
          id: normalizeString(agent?.id, ""),
          name: normalizeString(agent?.name, ""),
          workflowId,
        },
        result: result || {},
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
