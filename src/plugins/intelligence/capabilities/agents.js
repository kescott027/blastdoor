import {
  buildAgentScaffoldPrompt,
  composeAgentDraft,
  hydrateAgentExecutionGraph,
  listAgentScaffolds,
  validateExecutionGraph,
} from "../../../intelligence-agent-scaffold.js";
import {
  deleteIntelligenceAgent,
  readIntelligenceAgentStore,
  upsertIntelligenceAgent,
  writeIntelligenceAgentStore,
} from "../../../intelligence-agent-store.js";
import { createPasswordHash, safeEqual, verifyPassword } from "../../../security.js";
import {
  createAgentScopedToken,
  createScopedTokenRecord,
  createSignedAgentToken,
  getIntelligenceEnvFieldDefaults,
  isScopedTokenActive,
  normalizeAgentExternalAccess,
  normalizeExternalAssistantToken,
  nowIso,
  parsePositiveInteger,
  sanitizeAgentForManager,
  summarizeAgentForList,
  verifySignedAgentToken,
} from "../helpers.js";

export function registerIntelligenceAgentRoutes(context) {
  const {
    registerApiGet,
    registerApiPost,
    readEnvConfig,
    withBlastdoorApi,
    envPath,
    normalizeManagerString,
    parseBooleanLike,
    CONFIG_DEFAULTS,
    agentStorePath,
  } = context;

  function summarizeAgentExternalTokens(agent) {
    const externalAccess = normalizeAgentExternalAccess(agent);
    return externalAccess.tokens.map((token) => ({
      tokenId: token.tokenId,
      label: token.label,
      createdAt: token.createdAt || null,
      expiresAt: token.expiresAt || null,
      lastUsedAt: token.lastUsedAt || null,
      revokedAt: token.revokedAt || null,
      active: isScopedTokenActive(token),
    }));
  }

  function readExternalApiConfig(envConfig = {}) {
    const defaults = getIntelligenceEnvFieldDefaults({
      forDocker: false,
      existing: CONFIG_DEFAULTS,
    });
    const enabled = parseBooleanLike(
      envConfig.ASSISTANT_EXTERNAL_API_ENABLED,
      parseBooleanLike(defaults.ASSISTANT_EXTERNAL_API_ENABLED, false),
    );
    const signedTokensEnabled = parseBooleanLike(
      envConfig.ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED,
      parseBooleanLike(defaults.ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED, false),
    );
    const signingSecret = normalizeManagerString(
      envConfig.ASSISTANT_EXTERNAL_API_SIGNING_SECRET,
      defaults.ASSISTANT_EXTERNAL_API_SIGNING_SECRET,
    );
    const signedTokenTtlSeconds = parsePositiveInteger(
      normalizeManagerString(
        envConfig.ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS,
        defaults.ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS,
      ),
      900,
    );
    const legacySharedToken = normalizeManagerString(
      envConfig.ASSISTANT_EXTERNAL_API_TOKEN,
      defaults.ASSISTANT_EXTERNAL_API_TOKEN,
    );
    return {
      enabled,
      signedTokensEnabled,
      signingSecret,
      signedTokenTtlSeconds,
      legacySharedToken,
    };
  }

  function buildExternalApiOpenApi(managerPort) {
    const baseUrl = `http://127.0.0.1:${managerPort}`;
    return {
      openapi: "3.0.3",
      info: {
        title: "Blastdoor Assistant External API",
        version: "1.0.0",
        description:
          "Read-only runtime telemetry API for scaffold agents. Disabled by default. Requires scoped token or signed bearer token.",
      },
      servers: [{ url: baseUrl }],
      components: {
        securitySchemes: {
          ScopedTokenHeader: {
            type: "apiKey",
            in: "header",
            name: "x-blastdoor-assistant-token",
          },
          BearerToken: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
      paths: {
        "/api/assistant/v1/openapi.json": {
          get: {
            summary: "Return OpenAPI document for assistant external API.",
            responses: {
              200: {
                description: "OpenAPI schema",
              },
            },
          },
        },
        "/api/assistant/v1/auth/exchange": {
          post: {
            summary: "Exchange scoped token for short-lived signed token (optional).",
            security: [{ ScopedTokenHeader: [] }],
            responses: {
              200: { description: "Signed token issued." },
              401: { description: "Unauthorized." },
              404: { description: "External API disabled." },
            },
          },
        },
        "/api/assistant/v1/agents": {
          get: {
            summary: "List agents accessible by supplied scoped token.",
            security: [{ ScopedTokenHeader: [] }, { BearerToken: [] }],
            responses: {
              200: { description: "Accessible agents list." },
              401: { description: "Unauthorized." },
            },
          },
        },
        "/api/assistant/v1/agents/{agentName}/report": {
          get: {
            summary: "Return runtime report for scoped agent.",
            security: [{ ScopedTokenHeader: [] }, { BearerToken: [] }],
            parameters: [
              {
                in: "path",
                name: "agentName",
                required: true,
                schema: { type: "string" },
              },
              {
                in: "query",
                name: "limit",
                required: false,
                schema: { type: "integer", minimum: 1, maximum: 200, default: 40 },
              },
            ],
            responses: {
              200: { description: "Agent runtime report." },
              401: { description: "Unauthorized." },
              404: { description: "Agent not found or API disabled." },
            },
          },
        },
      },
    };
  }

  function findAgentByLookup(agents = [], lookupValue = "") {
    const normalizedLookup = normalizeManagerString(lookupValue, "").toLowerCase();
    if (!normalizedLookup) {
      return null;
    }
    return (
      agents.find((agent) => normalizeManagerString(agent?.id, "").toLowerCase() === normalizedLookup) ||
      agents.find((agent) => normalizeManagerString(agent?.name, "").toLowerCase() === normalizedLookup) ||
      null
    );
  }

  async function resolveAgentRunDetails(blastdoorApi, agent, limit = 40) {
    const runSummaries = await blastdoorApi.plugins?.intelligence?.listPlanRuns({ limit: Math.max(1, limit * 3) });
    const details = [];
    for (const summary of Array.isArray(runSummaries) ? runSummaries : []) {
      const runId = normalizeManagerString(summary?.runId, "");
      if (!runId) {
        continue;
      }
      const run = await blastdoorApi.plugins?.intelligence?.getPlanRun({ runId });
      if (!run) {
        continue;
      }
      const agentId = normalizeManagerString(agent?.id, "");
      const agentName = normalizeManagerString(agent?.name, "");
      const workflowId = normalizeManagerString(agent?.workflow?.id, "");
      const matches =
        normalizeManagerString(run?.meta?.agentId, "") === agentId ||
        normalizeManagerString(run?.meta?.agentName, "").toLowerCase() === agentName.toLowerCase() ||
        normalizeManagerString(run?.workflowId, "") === workflowId;
      if (matches) {
        details.push(run);
      }
    }
    return details
      .sort((a, b) => normalizeManagerString(b?.updatedAt, "").localeCompare(normalizeManagerString(a?.updatedAt, "")))
      .slice(0, limit);
  }

  function summarizeAgentRuntime(agent, runDetails = []) {
    const diagnostics = [];
    const troubleshoot = [];
    const errors = [];
    const humanInteractions = [];

    for (const run of runDetails) {
      const evidence = Array.isArray(run?.evidence) ? run.evidence : [];
      for (const entry of evidence) {
        const type = normalizeManagerString(entry?.type, "");
        if (type === "diagnostics-report") {
          diagnostics.push({
            runId: run.runId,
            collectedAt: entry?.collectedAt || null,
            payload: entry?.payload || {},
          });
        }
        if (type === "troubleshoot-report") {
          const payload = entry?.payload || {};
          troubleshoot.push({
            runId: run.runId,
            collectedAt: entry?.collectedAt || null,
            payload,
          });
          const checks = Array.isArray(payload?.checks) ? payload.checks : [];
          for (const check of checks) {
            const status = normalizeManagerString(check?.status, "").toLowerCase();
            if (status === "error" || status === "fail") {
              errors.push({
                runId: run.runId,
                title: normalizeManagerString(check?.title, "Troubleshooting check"),
                detail: normalizeManagerString(check?.detail || check?.recommendation, ""),
              });
            }
          }
        }
        if (type === "operator-note") {
          humanInteractions.push({
            runId: run.runId,
            ts: entry?.collectedAt || null,
            type: "operator-note",
            message: normalizeManagerString(entry?.summary, ""),
          });
        }
      }
    }

    const latestRun = runDetails[0] || null;
    const latestLayer = latestRun && Array.isArray(latestRun.layers) && latestRun.layers.length > 0
      ? latestRun.layers[latestRun.layers.length - 1]
      : null;
    const latestSteps = Array.isArray(latestLayer?.plan?.steps) ? latestLayer.plan.steps : [];
    const currentStepIndex = latestSteps.findIndex((step) => normalizeManagerString(step?.status, "pending") !== "completed");
    const resolvedCurrentIndex = currentStepIndex >= 0 ? currentStepIndex : latestSteps.length > 0 ? 0 : -1;
    const currentStep = resolvedCurrentIndex >= 0 ? latestSteps[resolvedCurrentIndex] : null;
    const nextSteps = resolvedCurrentIndex >= 0 ? latestSteps.slice(resolvedCurrentIndex + 1) : [];

    return {
      generatedAt: new Date().toISOString(),
      agent: {
        id: agent.id,
        name: agent.name,
        intent: agent.intent || "",
        workflowId: agent.workflow?.id || "",
      },
      summary: {
        runCount: runDetails.length,
        diagnosticsCount: diagnostics.length,
        troubleshootCount: troubleshoot.length,
        errorCount: errors.length,
        interactionCount: humanInteractions.length,
      },
      progress: {
        currentRunId: latestRun?.runId || null,
        currentLayer: latestLayer?.layer ?? null,
        currentStep: currentStep || null,
        nextSteps,
      },
      diagnostics,
      troubleshoot,
      errors,
      humanInteractions,
      planRuns: runDetails.map((run) => ({
        runId: run.runId,
        goal: run.goal,
        status: run.status,
        workflowId: run.workflowId,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        layerCount: Array.isArray(run.layers) ? run.layers.length : 0,
        evidenceCount: Array.isArray(run.evidence) ? run.evidence.length : 0,
      })),
    };
  }

  async function matchScopedAgentToken({ token, agents }) {
    const providedToken = normalizeManagerString(token, "");
    if (!providedToken) {
      return null;
    }
    for (const agent of Array.isArray(agents) ? agents : []) {
      const externalAccess = normalizeAgentExternalAccess(agent);
      if (!externalAccess.enabled) {
        continue;
      }
      for (const tokenMeta of externalAccess.tokens) {
        if (!isScopedTokenActive(tokenMeta)) {
          continue;
        }
        if (verifyPassword(providedToken, tokenMeta.tokenHash)) {
          return {
            agent,
            tokenMeta,
            authType: "scoped-token",
          };
        }
      }
    }
    return null;
  }

  async function authenticateExternalAgentRequest({ req, store, externalApiConfig }) {
    if (!externalApiConfig.enabled) {
      return { ok: false, status: 404, error: "Assistant external API is disabled." };
    }

    const suppliedToken = normalizeExternalAssistantToken(req);
    if (!suppliedToken) {
      return { ok: false, status: 401, error: "Missing assistant token." };
    }

    if (
      externalApiConfig.legacySharedToken &&
      safeEqual(suppliedToken, externalApiConfig.legacySharedToken)
    ) {
      return {
        ok: true,
        agent: null,
        tokenMeta: null,
        authType: "legacy-shared-token",
      };
    }

    if (externalApiConfig.signedTokensEnabled && externalApiConfig.signingSecret) {
      const verifiedSigned = verifySignedAgentToken(suppliedToken, externalApiConfig.signingSecret);
      if (verifiedSigned.ok) {
        const payload = verifiedSigned.payload || {};
        const targetAgent = (store.agents || []).find(
          (agent) => normalizeManagerString(agent?.id, "") === normalizeManagerString(payload.aid, ""),
        );
        if (!targetAgent) {
          return { ok: false, status: 401, error: "Signed token references unknown agent." };
        }
        const externalAccess = normalizeAgentExternalAccess(targetAgent);
        const tokenMeta = externalAccess.tokens.find(
          (entry) => normalizeManagerString(entry?.tokenId, "") === normalizeManagerString(payload.tid, ""),
        );
        if (!tokenMeta || !isScopedTokenActive(tokenMeta)) {
          return { ok: false, status: 401, error: "Signed token references inactive scoped token." };
        }
        return {
          ok: true,
          agent: targetAgent,
          tokenMeta,
          authType: "signed-token",
        };
      }
    }

    const scopedMatch = await matchScopedAgentToken({
      token: suppliedToken,
      agents: store.agents || [],
    });
    if (!scopedMatch) {
      return { ok: false, status: 401, error: "Unauthorized assistant external API request." };
    }
    return {
      ok: true,
      ...scopedMatch,
    };
  }

  async function updateAgentTokenLastUsed(store, matchedAgent, tokenMeta) {
    const agentId = normalizeManagerString(matchedAgent?.id, "");
    const tokenId = normalizeManagerString(tokenMeta?.tokenId, "");
    if (!agentId || !tokenId) {
      return store;
    }
    const nextAgents = (store.agents || []).map((agent) => {
      if (normalizeManagerString(agent?.id, "") !== agentId) {
        return agent;
      }
      const externalAccess = normalizeAgentExternalAccess(agent);
      const nextTokens = externalAccess.tokens.map((entry) => {
        if (normalizeManagerString(entry?.tokenId, "") !== tokenId) {
          return entry;
        }
        return {
          ...entry,
          lastUsedAt: nowIso(),
        };
      });
      return {
        ...agent,
        externalAccess: {
          ...externalAccess,
          tokens: nextTokens,
        },
      };
    });
    return await writeIntelligenceAgentStore(agentStorePath, {
      ...store,
      agents: nextAgents,
    });
  }

  async function handleExternalAgentListRequest(req, res) {
    const envConfig = await readEnvConfig(envPath);
    const externalApiConfig = readExternalApiConfig(envConfig);
    const store = await readIntelligenceAgentStore(agentStorePath);
    const auth = await authenticateExternalAgentRequest({
      req,
      store,
      externalApiConfig,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({
        error: auth.error,
      });
    }
    if (auth.agent) {
      await updateAgentTokenLastUsed(store, auth.agent, auth.tokenMeta);
      return res.json({
        ok: true,
        agents: [
          {
            id: auth.agent.id,
            name: auth.agent.name,
            workflowId: normalizeManagerString(auth.agent?.workflow?.id, ""),
            intent: normalizeManagerString(auth.agent?.intent, ""),
          },
        ],
      });
    }

    return res.json({
      ok: true,
      agents: (store.agents || []).map((agent) => ({
        id: agent.id,
        name: agent.name,
        workflowId: normalizeManagerString(agent?.workflow?.id, ""),
        intent: normalizeManagerString(agent?.intent, ""),
      })),
    });
  }

  async function handleExternalAgentReportRequest(req, res) {
    const envConfig = await readEnvConfig(envPath);
    const externalApiConfig = readExternalApiConfig(envConfig);
    const store = await readIntelligenceAgentStore(agentStorePath);
    const auth = await authenticateExternalAgentRequest({
      req,
      store,
      externalApiConfig,
    });
    if (!auth.ok) {
      return res.status(auth.status).json({
        error: auth.error,
      });
    }
    const agentName = normalizeManagerString(req.params?.agentName, "");
    const agent = findAgentByLookup(store.agents || [], agentName);
    if (!agent) {
      return res.status(404).json({
        error: "Agent not found.",
      });
    }
    if (auth.agent && normalizeManagerString(agent?.id, "") !== normalizeManagerString(auth.agent?.id, "")) {
      return res.status(403).json({
        error: "Token scope does not allow access to requested agent.",
      });
    }

    const limit = Number.parseInt(normalizeManagerString(req.query?.limit, "40"), 10);
    const response = await withBlastdoorApi(async ({ blastdoorApi }) => {
      const runDetails = await resolveAgentRunDetails(
        blastdoorApi,
        agent,
        Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 40,
      );
      return summarizeAgentRuntime(agent, runDetails);
    });
    if (auth.agent) {
      await updateAgentTokenLastUsed(store, auth.agent, auth.tokenMeta);
    }
    return res.json({
      ok: true,
      report: response,
    });
  }

  registerApiGet("/assistant/agents/scaffolds", async (_req, res) => {
    try {
      const scaffolds = listAgentScaffolds();
      res.json({
        ok: true,
        scaffolds,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/assistant/agents", async (_req, res) => {
    try {
      const store = await readIntelligenceAgentStore(agentStorePath);
      res.json({
        ok: true,
        agents: (store.agents || []).map(summarizeAgentForList),
        agentConfigs: (store.agents || []).map(sanitizeAgentForManager),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/agents/generate", async (req, res) => {
    try {
      const name = normalizeManagerString(req.body?.name, "Scaffold Agent");
      const intent = normalizeManagerString(req.body?.intent, "");
      if (!intent) {
        throw new Error("intent is required.");
      }
      const scaffoldIds = Array.isArray(req.body?.scaffoldIds) ? req.body.scaffoldIds : [];

      const scaffoldPrompt = buildAgentScaffoldPrompt({
        name,
        intent,
        scaffoldIds,
      });

      const result = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
          workflow: {
            id: "workflow-config-builder",
            name: "Workflow Config Builder",
            type: "workflow-config-builder",
          },
          message: scaffoldPrompt.prompt,
          context: {
            requestSource: "manager-agent-scaffold",
            scaffoldIds: scaffoldPrompt.selectedIds,
          },
        });
      });

      const draft = composeAgentDraft({
        name,
        intent,
        scaffoldIds: scaffoldPrompt.selectedIds,
        workflowSuggestion: result?.suggestedWorkflow || {},
        workflowResult: result || {},
      });

      res.json({
        ok: true,
        draft: sanitizeAgentForManager({
          ...draft,
          externalAccess: draft.externalAccess || { enabled: true, tokens: [] },
        }),
        scaffolds: scaffoldPrompt.selectedScaffolds,
        result: result || {},
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/agents/validate", async (req, res) => {
    try {
      const draft = req.body?.agent && typeof req.body.agent === "object" ? req.body.agent : req.body || {};
      const hydrated = hydrateAgentExecutionGraph(draft);
      const validation = validateExecutionGraph(hydrated.executionGraph);
      res.json({
        ok: true,
        agent: sanitizeAgentForManager(hydrated),
        validation,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/agents/save", async (req, res) => {
    try {
      const draft = req.body?.agent && typeof req.body.agent === "object" ? req.body.agent : req.body || {};
      const saved = await upsertIntelligenceAgent(agentStorePath, draft);
      res.json({
        ok: true,
        agent: saved.agent ? sanitizeAgentForManager(saved.agent) : null,
        agents: (saved.store?.agents || []).map(summarizeAgentForList),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/agents/delete", async (req, res) => {
    try {
      const agentId = normalizeManagerString(req.body?.agentId, "");
      const saved = await deleteIntelligenceAgent(agentStorePath, agentId);
      res.json({
        ok: true,
        deletedAgentId: agentId,
        agents: (saved.agents || []).map(summarizeAgentForList),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/agents/tokens/create", async (req, res) => {
    try {
      const agentId = normalizeManagerString(req.body?.agentId, "");
      if (!agentId) {
        throw new Error("agentId is required.");
      }
      const label = normalizeManagerString(req.body?.label, "Scoped token");
      const expiresInHours = Number.parseFloat(normalizeManagerString(req.body?.expiresInHours, ""));
      const expiresAt =
        Number.isFinite(expiresInHours) && expiresInHours > 0
          ? new Date(Date.now() + Math.floor(expiresInHours * 3600 * 1000)).toISOString()
          : "";

      const store = await readIntelligenceAgentStore(agentStorePath);
      const targetAgent = (store.agents || []).find(
        (agent) => normalizeManagerString(agent?.id, "") === agentId,
      );
      if (!targetAgent) {
        return res.status(404).json({
          error: "Agent not found.",
        });
      }

      const rawToken = createAgentScopedToken();
      const tokenRecord = createScopedTokenRecord({ label, expiresAt });
      tokenRecord.tokenHash = createPasswordHash(rawToken);

      const externalAccess = normalizeAgentExternalAccess(targetAgent);
      const updatedAgent = {
        ...targetAgent,
        externalAccess: {
          ...externalAccess,
          tokens: [...externalAccess.tokens, tokenRecord],
        },
      };
      const saved = await upsertIntelligenceAgent(agentStorePath, updatedAgent);

      return res.json({
        ok: true,
        agentId,
        token: rawToken,
        tokenMeta: {
          tokenId: tokenRecord.tokenId,
          label: tokenRecord.label,
          createdAt: tokenRecord.createdAt,
          expiresAt: tokenRecord.expiresAt || null,
        },
        tokens: summarizeAgentExternalTokens(saved.agent),
      });
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/agents/tokens/revoke", async (req, res) => {
    try {
      const agentId = normalizeManagerString(req.body?.agentId, "");
      const tokenId = normalizeManagerString(req.body?.tokenId, "");
      if (!agentId || !tokenId) {
        throw new Error("agentId and tokenId are required.");
      }

      const store = await readIntelligenceAgentStore(agentStorePath);
      const targetAgent = (store.agents || []).find(
        (agent) => normalizeManagerString(agent?.id, "") === agentId,
      );
      if (!targetAgent) {
        return res.status(404).json({
          error: "Agent not found.",
        });
      }

      const externalAccess = normalizeAgentExternalAccess(targetAgent);
      const nextTokens = externalAccess.tokens.map((entry) => {
        if (normalizeManagerString(entry?.tokenId, "") !== tokenId) {
          return entry;
        }
        return {
          ...entry,
          revokedAt: nowIso(),
        };
      });
      const updatedAgent = {
        ...targetAgent,
        externalAccess: {
          ...externalAccess,
          tokens: nextTokens,
        },
      };
      const saved = await upsertIntelligenceAgent(agentStorePath, updatedAgent);
      return res.json({
        ok: true,
        agentId,
        tokenId,
        tokens: summarizeAgentExternalTokens(saved.agent),
      });
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/assistant/v1/openapi.json", async (req, res) => {
    try {
      const hostHeader = normalizeManagerString(req.get("host"), `127.0.0.1:${CONFIG_DEFAULTS.MANAGER_PORT || 8090}`);
      const managerPort = Number.parseInt(hostHeader.split(":")[1] || String(CONFIG_DEFAULTS.MANAGER_PORT || 8090), 10);
      return res.json(buildExternalApiOpenApi(Number.isInteger(managerPort) ? managerPort : 8090));
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/v1/auth/exchange", async (req, res) => {
    try {
      const envConfig = await readEnvConfig(envPath);
      const externalApiConfig = readExternalApiConfig(envConfig);
      if (!externalApiConfig.enabled) {
        return res.status(404).json({
          error: "Assistant external API is disabled.",
        });
      }
      if (!externalApiConfig.signedTokensEnabled || !externalApiConfig.signingSecret) {
        return res.status(400).json({
          error: "Signed token exchange is disabled or not configured.",
        });
      }
      const store = await readIntelligenceAgentStore(agentStorePath);
      const auth = await authenticateExternalAgentRequest({
        req,
        store,
        externalApiConfig: {
          ...externalApiConfig,
          signedTokensEnabled: false,
        },
      });
      if (!auth.ok) {
        return res.status(auth.status).json({
          error: auth.error,
        });
      }
      if (!auth.agent || !auth.tokenMeta) {
        return res.status(400).json({
          error: "Signed token exchange requires a scoped per-agent token.",
        });
      }
      const signed = createSignedAgentToken({
        signingSecret: externalApiConfig.signingSecret,
        agentId: auth.agent.id,
        tokenId: auth.tokenMeta.tokenId,
        ttlSeconds: externalApiConfig.signedTokenTtlSeconds,
      });
      await updateAgentTokenLastUsed(store, auth.agent, auth.tokenMeta);
      return res.json({
        ok: true,
        tokenType: "Bearer",
        accessToken: signed.token,
        expiresAt: new Date(signed.payload.exp * 1000).toISOString(),
        agent: {
          id: auth.agent.id,
          name: auth.agent.name,
        },
      });
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/assistant/v1/agents", async (req, res) => {
    try {
      return await handleExternalAgentListRequest(req, res);
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/assistant/v1/agents/:agentName/report", async (req, res) => {
    try {
      return await handleExternalAgentReportRequest(req, res);
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/assistant/agents/external", async (req, res) => {
    try {
      return await handleExternalAgentListRequest(req, res);
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/assistant/agents/external/:agentName", async (req, res) => {
    try {
      return await handleExternalAgentReportRequest(req, res);
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
