import { createAssistantClient, loadAssistantRuntimeConfig } from "../assistant-client.js";
import path from "node:path";
import { readInstallationConfig } from "../installation-config.js";
import {
  deleteIntelligenceWorkflow,
  readIntelligenceWorkflowStore,
  summarizeWorkflowForList,
  upsertIntelligenceWorkflow,
} from "../intelligence-workflow-store.js";
import { createIntelligencePlanStore } from "../intelligence-plan-store.js";
import {
  buildAgentScaffoldPrompt,
  composeAgentDraft,
  hydrateAgentExecutionGraph,
  listAgentScaffolds,
  validateExecutionGraph,
} from "../intelligence-agent-scaffold.js";
import {
  deleteIntelligenceAgent,
  readIntelligenceAgentStore,
  upsertIntelligenceAgent,
} from "../intelligence-agent-store.js";

function normalizeAssistantProvider(value) {
  const normalized = String(value || "ollama").trim().toLowerCase();
  if (normalized === "heuristic") {
    return "ollama";
  }
  return normalized || "ollama";
}

function validateAssistantConfig(config) {
  const assistantProvider = normalizeAssistantProvider(config.assistantProvider);
  if (assistantProvider !== "ollama") {
    throw new Error("ASSISTANT_PROVIDER must be: ollama.");
  }

  const assistantTimeoutMs = Number.parseInt(String(config.assistantTimeoutMs ?? "6000"), 10);
  if (!Number.isInteger(assistantTimeoutMs) || assistantTimeoutMs < 100) {
    throw new Error("ASSISTANT_TIMEOUT_MS must be at least 100.");
  }

  const assistantRetryMaxAttempts = Number.parseInt(String(config.assistantRetryMaxAttempts ?? "2"), 10);
  if (!Number.isInteger(assistantRetryMaxAttempts) || assistantRetryMaxAttempts < 1) {
    throw new Error("ASSISTANT_RETRY_MAX_ATTEMPTS must be a positive integer.");
  }

  const assistantThreatScoreThreshold = Number.parseInt(String(config.assistantThreatScoreThreshold ?? "80"), 10);
  if (
    !Number.isInteger(assistantThreatScoreThreshold) ||
    assistantThreatScoreThreshold < 20 ||
    assistantThreatScoreThreshold > 100
  ) {
    throw new Error("ASSISTANT_THREAT_SCORE_THRESHOLD must be between 20 and 100.");
  }
}

function ensureIntelligenceNamespace(api) {
  if (!api.plugins || typeof api.plugins !== "object") {
    api.plugins = {};
  }
  if (!api.plugins.intelligence || typeof api.plugins.intelligence !== "object") {
    api.plugins.intelligence = {};
  }
  return api.plugins.intelligence;
}

function getIntelligenceEnvFieldDefaults({ forDocker = false, existing = {} } = {}) {
  return {
    ASSISTANT_ENABLED: String(existing.ASSISTANT_ENABLED || "true"),
    ASSISTANT_URL: String(existing.ASSISTANT_URL || (forDocker ? "http://blastdoor-assistant:8060" : "")),
    ASSISTANT_TOKEN: String(existing.ASSISTANT_TOKEN || ""),
    ASSISTANT_PROVIDER: normalizeAssistantProvider(existing.ASSISTANT_PROVIDER),
    ASSISTANT_OLLAMA_URL: String(existing.ASSISTANT_OLLAMA_URL || "http://127.0.0.1:11434"),
    ASSISTANT_OLLAMA_MODEL: String(existing.ASSISTANT_OLLAMA_MODEL || "llama3.1:8b"),
    ASSISTANT_TIMEOUT_MS: String(existing.ASSISTANT_TIMEOUT_MS || "6000"),
    ASSISTANT_RETRY_MAX_ATTEMPTS: String(existing.ASSISTANT_RETRY_MAX_ATTEMPTS || "2"),
    ASSISTANT_RAG_ENABLED: String(existing.ASSISTANT_RAG_ENABLED || "false"),
    ASSISTANT_ALLOW_WEB_SEARCH: String(existing.ASSISTANT_ALLOW_WEB_SEARCH || "false"),
    ASSISTANT_AUTO_LOCK_ON_THREAT: String(existing.ASSISTANT_AUTO_LOCK_ON_THREAT || "false"),
    ASSISTANT_THREAT_SCORE_THRESHOLD: String(existing.ASSISTANT_THREAT_SCORE_THRESHOLD || "80"),
    ASSISTANT_HOST: String(existing.ASSISTANT_HOST || "0.0.0.0"),
    ASSISTANT_PORT: String(existing.ASSISTANT_PORT || "8060"),
  };
}

function makeApiDocSnapshot() {
  return [
    "POST /api/start",
    "POST /api/stop",
    "POST /api/restart",
    "POST /api/config",
    "GET /api/config",
    "GET /api/diagnostics",
    "GET /api/troubleshoot",
    "POST /api/troubleshoot/run",
    "GET /api/users?view=active|inactive|authenticated|all",
    "POST /api/users/create",
    "POST /api/users/update",
    "POST /api/users/set-status",
    "POST /api/users/reset-login-code",
    "POST /api/users/invalidate-token",
    "GET /api/themes",
    "POST /api/themes/create",
    "POST /api/themes/update",
    "POST /api/themes/rename",
    "POST /api/themes/delete",
    "POST /api/themes/apply",
    "POST /api/sessions/revoke-all",
  ];
}

function parseEmbeddedJsonObject(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore invalid JSON; the caller will fall back to plain-text handling.
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  const candidate = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore invalid JSON; this is a best-effort extractor.
  }
  return null;
}

function normalizePlanSteps(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry, index) => {
      const source = entry && typeof entry === "object" ? entry : {};
      const stepIdRaw = String(source.id || source.stepId || `step-${index + 1}`).trim();
      const stepId = stepIdRaw || `step-${index + 1}`;
      return {
        id: stepId,
        title: String(source.title || source.name || `Step ${index + 1}`).trim(),
        objective: String(source.objective || source.goal || "").trim(),
        actions: Array.isArray(source.actions)
          ? source.actions.map((action) => String(action || "").trim()).filter(Boolean)
          : [],
        validation: String(source.validation || source.verify || "").trim(),
        safeOnly: source.safeOnly !== false,
      };
    })
    .filter((step) => step.id && step.title);
}

function derivePlanLayerFromChatResult(chatResult, { goal = "", fallbackSummary = "" } = {}) {
  const safeGoal = String(goal || "").trim();
  const fallback = String(fallbackSummary || "").trim() || (safeGoal ? `Plan draft for: ${safeGoal}` : "Plan draft");
  const replyText = String(
    chatResult?.reply || chatResult?.result?.assistantNarrative || chatResult?.summary || "",
  ).trim();

  const candidates = [
    chatResult?.result?.plan,
    chatResult?.result?.phase0Plan,
    chatResult?.result,
    chatResult?.suggestedPlan,
    parseEmbeddedJsonObject(replyText),
  ];
  const planCandidate = candidates.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) || {};

  const planSummary = String(planCandidate.summary || planCandidate.planSummary || replyText || fallback).trim() || fallback;
  const steps = normalizePlanSteps(planCandidate.steps);
  const normalizedPlan = {
    goal: safeGoal,
    summary: planSummary,
    steps,
    source: "assistant",
    assistantReply: replyText,
    metadata: {
      workflowId: String(chatResult?.workflowId || "").trim(),
      workflowType: String(chatResult?.workflowType || "").trim(),
      generatedAt: String(chatResult?.generatedAt || new Date().toISOString()).trim(),
    },
  };

  return {
    summary: planSummary,
    plan: normalizedPlan,
  };
}

function chooseWorkflowById(workflowStore, workflowId) {
  const workflows = Array.isArray(workflowStore?.workflows) ? workflowStore.workflows : [];
  const desired = String(workflowId || "").trim();
  return (
    workflows.find((workflow) => workflow.id === desired) ||
    workflows.find((workflow) => workflow.id === "troubleshoot-recommendation") ||
    workflows.find((workflow) => workflow.id === "config-recommendations") ||
    workflows[0] ||
    null
  );
}

function summarizeAgentForList(agent) {
  const source = agent && typeof agent === "object" ? agent : {};
  const graph = source.executionGraph && typeof source.executionGraph === "object" ? source.executionGraph : {};
  const graphNodes = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
  const graphEdges = Array.isArray(graph.edges) ? graph.edges.length : 0;
  const graphGates = Array.isArray(graph.approvalGates) ? graph.approvalGates.length : 0;
  return {
    id: String(source.id || "").trim(),
    name: String(source.name || "").trim(),
    intent: String(source.intent || "").trim(),
    scaffoldCount: Array.isArray(source.scaffoldIds) ? source.scaffoldIds.length : 0,
    approvalRequired: Boolean(source.approvals?.required),
    graphNodes,
    graphEdges,
    graphGates,
    updatedAt: String(source.updatedAt || "").trim(),
  };
}

export function createIntelligencePlugin() {
  return {
    id: "intelligence",

    managerConfig: {
      fields: [
        "ASSISTANT_ENABLED",
        "ASSISTANT_URL",
        "ASSISTANT_TOKEN",
        "ASSISTANT_PROVIDER",
        "ASSISTANT_OLLAMA_URL",
        "ASSISTANT_OLLAMA_MODEL",
        "ASSISTANT_TIMEOUT_MS",
        "ASSISTANT_RETRY_MAX_ATTEMPTS",
        "ASSISTANT_RAG_ENABLED",
        "ASSISTANT_ALLOW_WEB_SEARCH",
        "ASSISTANT_AUTO_LOCK_ON_THREAT",
        "ASSISTANT_THREAT_SCORE_THRESHOLD",
      ],
      defaults: {
        ASSISTANT_ENABLED: "true",
        ASSISTANT_URL: "",
        ASSISTANT_TOKEN: "",
        ASSISTANT_PROVIDER: "ollama",
        ASSISTANT_OLLAMA_URL: "http://127.0.0.1:11434",
        ASSISTANT_OLLAMA_MODEL: "llama3.1:8b",
        ASSISTANT_TIMEOUT_MS: "6000",
        ASSISTANT_RETRY_MAX_ATTEMPTS: "2",
        ASSISTANT_RAG_ENABLED: "false",
        ASSISTANT_ALLOW_WEB_SEARCH: "false",
        ASSISTANT_AUTO_LOCK_ON_THREAT: "false",
        ASSISTANT_THREAT_SCORE_THRESHOLD: "80",
      },
      sensitiveKeys: ["ASSISTANT_TOKEN"],
      diagnosticsSummaryLines(config) {
        return [
          `Assistant: ${config.ASSISTANT_ENABLED === "true" ? "enabled" : "disabled"} (${normalizeAssistantProvider(config.ASSISTANT_PROVIDER)})`,
          `Assistant RAG/Web: ${config.ASSISTANT_RAG_ENABLED || "false"} / ${config.ASSISTANT_ALLOW_WEB_SEARCH || "false"}`,
          `Assistant Auto-Lock: ${config.ASSISTANT_AUTO_LOCK_ON_THREAT || "false"} (threshold: ${config.ASSISTANT_THREAT_SCORE_THRESHOLD || "80"})`,
        ];
      },
      uiAssets() {
        return [
          {
            pluginId: "intelligence",
            jsPath: "/manager/plugins/intelligence.js",
            cssPath: "/manager/plugins/intelligence.css",
          },
        ];
      },
    },

    installationEnv: {
      order: [
        "ASSISTANT_ENABLED",
        "ASSISTANT_URL",
        "ASSISTANT_TOKEN",
        "ASSISTANT_PROVIDER",
        "ASSISTANT_OLLAMA_URL",
        "ASSISTANT_OLLAMA_MODEL",
        "ASSISTANT_TIMEOUT_MS",
        "ASSISTANT_RETRY_MAX_ATTEMPTS",
        "ASSISTANT_RAG_ENABLED",
        "ASSISTANT_ALLOW_WEB_SEARCH",
        "ASSISTANT_AUTO_LOCK_ON_THREAT",
        "ASSISTANT_THREAT_SCORE_THRESHOLD",
        "ASSISTANT_HOST",
        "ASSISTANT_PORT",
      ],
      values({ forDocker, existing }) {
        return getIntelligenceEnvFieldDefaults({ forDocker, existing });
      },
    },

    serverConfig: {
      loadFromEnv(env) {
        return loadAssistantRuntimeConfig(env);
      },
      validate(config) {
        validateAssistantConfig(config);
      },
      persistValues(config) {
        return {
          ASSISTANT_ENABLED: String(Boolean(config.assistantEnabled)),
          ASSISTANT_URL: String(config.assistantUrl || ""),
          ASSISTANT_TOKEN: String(config.assistantToken || ""),
          ASSISTANT_PROVIDER: normalizeAssistantProvider(config.assistantProvider),
          ASSISTANT_OLLAMA_URL: String(config.assistantOllamaUrl || ""),
          ASSISTANT_OLLAMA_MODEL: String(config.assistantOllamaModel || ""),
          ASSISTANT_TIMEOUT_MS: String(config.assistantTimeoutMs || 6000),
          ASSISTANT_RETRY_MAX_ATTEMPTS: String(config.assistantRetryMaxAttempts || 2),
          ASSISTANT_RAG_ENABLED: String(Boolean(config.assistantRagEnabled)),
          ASSISTANT_ALLOW_WEB_SEARCH: String(Boolean(config.assistantAllowWebSearch)),
          ASSISTANT_AUTO_LOCK_ON_THREAT: String(Boolean(config.assistantAutoLockOnThreat)),
          ASSISTANT_THREAT_SCORE_THRESHOLD: String(config.assistantThreatScoreThreshold || 80),
        };
      },
    },

    api: {
      decorateLocalApi(api, context) {
        const intelligence = ensureIntelligenceNamespace(api);
        let assistantClient = null;
        let planStorePromise = null;
        function getAssistantClient() {
          if (assistantClient) {
            return assistantClient;
          }
          assistantClient = createAssistantClient({
            config: {
              ...loadAssistantRuntimeConfig(process.env),
              ...(context?.config && typeof context.config === "object" ? context.config : {}),
            },
          });
          return assistantClient;
        }
        async function getPlanStore() {
          if (!planStorePromise) {
            const runtimeConfig =
              context?.config && typeof context.config === "object"
                ? context.config
                : {
                    configStoreMode: "env",
                    databaseFile: "",
                    postgresUrl: "",
                    postgresSsl: false,
                  };
            planStorePromise = createIntelligencePlanStore(runtimeConfig, {
              postgresPoolFactory: context?.postgresPoolFactory || context?.options?.postgresPoolFactory,
            });
          }
          return await planStorePromise;
        }

        intelligence.getStatus = async () => {
          return await getAssistantClient().getStatus();
        };
        intelligence.runConfigRecommendations = async (payload = {}) => {
          return await getAssistantClient().runConfigRecommendations(payload);
        };
        intelligence.runTroubleshootRecommendation = async (payload = {}) => {
          return await getAssistantClient().runTroubleshootRecommendation(payload);
        };
        intelligence.runThreatMonitor = async (payload = {}) => {
          return await getAssistantClient().runThreatMonitor(payload);
        };
        intelligence.runGrimoire = async (payload = {}) => {
          return await getAssistantClient().runGrimoireWorkflow(payload);
        };
        intelligence.runWorkflowChat = async (payload = {}) => {
          return await getAssistantClient().runWorkflowChat(payload);
        };
        intelligence.listPlanRuns = async (payload = {}) => {
          const planStore = await getPlanStore();
          return await planStore.listRuns({
            limit: Number.parseInt(String(payload?.limit ?? "20"), 10),
          });
        };
        intelligence.getPlanRun = async (payload = {}) => {
          const runId = String(payload?.runId || "").trim();
          if (!runId) {
            throw new Error("runId is required.");
          }
          const planStore = await getPlanStore();
          return await planStore.getRun(runId);
        };
        intelligence.createPlanRun = async (payload = {}) => {
          const planStore = await getPlanStore();
          return await planStore.createRun(payload);
        };
        intelligence.addPlanEvidence = async (payload = {}) => {
          const runId = String(payload?.runId || "").trim();
          if (!runId) {
            throw new Error("runId is required.");
          }
          const planStore = await getPlanStore();
          return await planStore.addEvidence(runId, payload?.entries || []);
        };
        intelligence.addPlanLayer = async (payload = {}) => {
          const runId = String(payload?.runId || "").trim();
          if (!runId) {
            throw new Error("runId is required.");
          }
          const planStore = await getPlanStore();
          return await planStore.addLayer(runId, payload?.layer || {});
        };

        const previousClose = api.close;
        api.close = async () => {
          if (typeof previousClose === "function") {
            await previousClose();
          }
          if (typeof assistantClient?.close === "function") {
            await assistantClient.close();
          }
          if (planStorePromise) {
            const planStore = await planStorePromise;
            if (typeof planStore?.close === "function") {
              await planStore.close();
            }
          }
        };
      },

      decorateRemoteApi(api, context) {
        const intelligence = ensureIntelligenceNamespace(api);
        const request = context?.request;
        if (typeof request !== "function") {
          return;
        }

        intelligence.getStatus = async () => {
          const body = await request("/internal/plugins/intelligence/status", {
            method: "GET",
            retryable: true,
          });
          return body.status || {};
        };
        intelligence.runConfigRecommendations = async (payload = {}) => {
          const body = await request("/internal/plugins/intelligence/workflows/config-recommendations", {
            method: "POST",
            payload,
          });
          return body.result || {};
        };
        intelligence.runTroubleshootRecommendation = async (payload = {}) => {
          const body = await request("/internal/plugins/intelligence/workflows/troubleshoot-recommendation", {
            method: "POST",
            payload,
          });
          return body.result || {};
        };
        intelligence.runThreatMonitor = async (payload = {}) => {
          const body = await request("/internal/plugins/intelligence/workflows/threat-monitor", {
            method: "POST",
            payload,
          });
          return body.result || {};
        };
        intelligence.runGrimoire = async (payload = {}) => {
          const body = await request("/internal/plugins/intelligence/workflows/grimoire", {
            method: "POST",
            payload,
          });
          return body.result || {};
        };
        intelligence.runWorkflowChat = async (payload = {}) => {
          const body = await request("/internal/plugins/intelligence/workflows/chat", {
            method: "POST",
            payload,
          });
          return body.result || {};
        };
        intelligence.listPlanRuns = async (payload = {}) => {
          const limit = Number.parseInt(String(payload?.limit ?? "20"), 10);
          const body = await request(`/internal/plugins/intelligence/plans?limit=${encodeURIComponent(String(limit))}`, {
            method: "GET",
            retryable: true,
          });
          return Array.isArray(body.runs) ? body.runs : [];
        };
        intelligence.getPlanRun = async (payload = {}) => {
          const runId = String(payload?.runId || "").trim();
          if (!runId) {
            throw new Error("runId is required.");
          }
          const body = await request(`/internal/plugins/intelligence/plans/${encodeURIComponent(runId)}`, {
            method: "GET",
            retryable: true,
          });
          return body.run || null;
        };
        intelligence.createPlanRun = async (payload = {}) => {
          const body = await request("/internal/plugins/intelligence/plans", {
            method: "POST",
            payload,
          });
          return body.run || null;
        };
        intelligence.addPlanEvidence = async (payload = {}) => {
          const runId = String(payload?.runId || "").trim();
          if (!runId) {
            throw new Error("runId is required.");
          }
          const body = await request(`/internal/plugins/intelligence/plans/${encodeURIComponent(runId)}/evidence`, {
            method: "POST",
            payload,
          });
          return body.run || null;
        };
        intelligence.addPlanLayer = async (payload = {}) => {
          const runId = String(payload?.runId || "").trim();
          if (!runId) {
            throw new Error("runId is required.");
          }
          const body = await request(`/internal/plugins/intelligence/plans/${encodeURIComponent(runId)}/layers`, {
            method: "POST",
            payload,
          });
          return body.run || null;
        };
      },

      registerApiServerRoutes({ registerRead, registerWrite, api }) {
        registerRead("/internal/plugins/intelligence/status", async (_req, res) => {
          const status = await api.plugins?.intelligence?.getStatus();
          res.json({ ok: true, status: status || {} });
        });

        registerWrite("/internal/plugins/intelligence/workflows/config-recommendations", async (req, res) => {
          const result = await api.plugins?.intelligence?.runConfigRecommendations(req.body || {});
          res.json({ ok: true, result: result || {} });
        });

        registerWrite("/internal/plugins/intelligence/workflows/troubleshoot-recommendation", async (req, res) => {
          const result = await api.plugins?.intelligence?.runTroubleshootRecommendation(req.body || {});
          res.json({ ok: true, result: result || {} });
        });

        registerWrite("/internal/plugins/intelligence/workflows/threat-monitor", async (req, res) => {
          const result = await api.plugins?.intelligence?.runThreatMonitor(req.body || {});
          res.json({ ok: true, result: result || {} });
        });

        registerWrite("/internal/plugins/intelligence/workflows/grimoire", async (req, res) => {
          const result = await api.plugins?.intelligence?.runGrimoire(req.body || {});
          res.json({ ok: true, result: result || {} });
        });
        registerWrite("/internal/plugins/intelligence/workflows/chat", async (req, res) => {
          const result = await api.plugins?.intelligence?.runWorkflowChat(req.body || {});
          res.json({ ok: true, result: result || {} });
        });
        registerRead("/internal/plugins/intelligence/plans", async (req, res) => {
          const limit = Number.parseInt(String(req.query?.limit ?? "20"), 10);
          const runs = await api.plugins?.intelligence?.listPlanRuns({ limit });
          res.json({ ok: true, runs: Array.isArray(runs) ? runs : [] });
        });
        registerRead("/internal/plugins/intelligence/plans/:runId", async (req, res) => {
          const run = await api.plugins?.intelligence?.getPlanRun({
            runId: req.params?.runId,
          });
          if (!run) {
            return res.status(404).json({ error: "Plan run not found." });
          }
          return res.json({ ok: true, run });
        });
        registerWrite("/internal/plugins/intelligence/plans", async (req, res) => {
          const run = await api.plugins?.intelligence?.createPlanRun(req.body || {});
          res.json({ ok: true, run: run || null });
        });
        registerWrite("/internal/plugins/intelligence/plans/:runId/evidence", async (req, res) => {
          const run = await api.plugins?.intelligence?.addPlanEvidence({
            ...(req.body || {}),
            runId: req.params?.runId,
          });
          res.json({ ok: true, run: run || null });
        });
        registerWrite("/internal/plugins/intelligence/plans/:runId/layers", async (req, res) => {
          const run = await api.plugins?.intelligence?.addPlanLayer({
            ...(req.body || {}),
            runId: req.params?.runId,
          });
          res.json({ ok: true, run: run || null });
        });
      },
    },

    manager: {
      registerRoutes({
        registerApiGet,
        registerApiPost,
        readEnvConfig,
        withBlastdoorApi,
        processState,
        workspaceDir,
        envPath,
        checkBlastdoorHealth,
        checkFoundryTargetHealth,
        detectEnvironmentInfo,
        sanitizeConfigForDiagnostics,
        createTroubleshootReport,
        tailFile,
        parseBooleanLike,
        parseBooleanLikeBody,
        normalizeString: normalizeManagerString,
        applyThreatLockdown,
        CONFIG_DEFAULTS,
        installationConfigPath,
      }) {
        const workflowStorePath = path.join(workspaceDir, "data", "intelligence-workflows.json");
        const agentStorePath = path.join(workspaceDir, "data", "intelligence-agents.json");
        const DEFAULT_PHASE0_WORKFLOW_ID = "troubleshoot-recommendation";

        async function buildAssistantContext(config) {
          const serviceStatus = processState.getStatus();
          const [health, foundryHealth] = await Promise.all([
            checkBlastdoorHealth(config),
            checkFoundryTargetHealth(config),
          ]);
          const environment = detectEnvironmentInfo({ workspaceDir, envPath });
          const diagnosticsReport = {
            generatedAt: new Date().toISOString(),
            serviceStatus,
            health,
            environment,
            config: sanitizeConfigForDiagnostics(config),
          };
          const troubleshootReport = createTroubleshootReport({
            config,
            health,
            foundryHealth,
            environment,
            serviceStatus,
          });
          const installationConfig = await readInstallationConfig(installationConfigPath);

          return {
            serviceStatus,
            health,
            foundryHealth,
            environment,
            diagnosticsReport,
            troubleshootReport,
            installationConfig: installationConfig || {},
          };
        }

        registerApiGet("/assistant/status", async (_req, res) => {
          try {
            const config = await readEnvConfig(envPath);
            const status = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.getStatus();
            });

            res.json({
              ok: true,
              status: status || {},
              config: {
                ASSISTANT_ENABLED: normalizeManagerString(
                  config.ASSISTANT_ENABLED,
                  CONFIG_DEFAULTS.ASSISTANT_ENABLED,
                ),
                ASSISTANT_PROVIDER: normalizeManagerString(
                  normalizeAssistantProvider(config.ASSISTANT_PROVIDER),
                  normalizeAssistantProvider(CONFIG_DEFAULTS.ASSISTANT_PROVIDER),
                ),
                ASSISTANT_URL: normalizeManagerString(config.ASSISTANT_URL, CONFIG_DEFAULTS.ASSISTANT_URL),
                ASSISTANT_OLLAMA_URL: normalizeManagerString(
                  config.ASSISTANT_OLLAMA_URL,
                  CONFIG_DEFAULTS.ASSISTANT_OLLAMA_URL,
                ),
                ASSISTANT_OLLAMA_MODEL: normalizeManagerString(
                  config.ASSISTANT_OLLAMA_MODEL,
                  CONFIG_DEFAULTS.ASSISTANT_OLLAMA_MODEL,
                ),
                ASSISTANT_TIMEOUT_MS: normalizeManagerString(
                  config.ASSISTANT_TIMEOUT_MS,
                  CONFIG_DEFAULTS.ASSISTANT_TIMEOUT_MS,
                ),
                ASSISTANT_RETRY_MAX_ATTEMPTS: normalizeManagerString(
                  config.ASSISTANT_RETRY_MAX_ATTEMPTS,
                  CONFIG_DEFAULTS.ASSISTANT_RETRY_MAX_ATTEMPTS,
                ),
                ASSISTANT_RAG_ENABLED: normalizeManagerString(
                  config.ASSISTANT_RAG_ENABLED,
                  CONFIG_DEFAULTS.ASSISTANT_RAG_ENABLED,
                ),
                ASSISTANT_ALLOW_WEB_SEARCH: normalizeManagerString(
                  config.ASSISTANT_ALLOW_WEB_SEARCH,
                  CONFIG_DEFAULTS.ASSISTANT_ALLOW_WEB_SEARCH,
                ),
                ASSISTANT_AUTO_LOCK_ON_THREAT: normalizeManagerString(
                  config.ASSISTANT_AUTO_LOCK_ON_THREAT,
                  CONFIG_DEFAULTS.ASSISTANT_AUTO_LOCK_ON_THREAT,
                ),
                ASSISTANT_THREAT_SCORE_THRESHOLD: normalizeManagerString(
                  config.ASSISTANT_THREAT_SCORE_THRESHOLD,
                  CONFIG_DEFAULTS.ASSISTANT_THREAT_SCORE_THRESHOLD,
                ),
              },
            });
          } catch (error) {
            res.status(500).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/workflow/config-recommendations", async (_req, res) => {
          try {
            const config = await readEnvConfig(envPath);
            const serviceStatus = processState.getStatus();
            const health = await checkBlastdoorHealth(config);
            const environment = detectEnvironmentInfo({ workspaceDir, envPath });
            const diagnosticsReport = {
              generatedAt: new Date().toISOString(),
              serviceStatus,
              health,
              environment,
              config: sanitizeConfigForDiagnostics(config),
            };
            const installationConfig = await readInstallationConfig(installationConfigPath);

            const result = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.runConfigRecommendations({
                diagnosticsReport,
                installationConfig: installationConfig || {},
              });
            });

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

        registerApiPost("/assistant/workflow/troubleshoot-recommendation", async (req, res) => {
          try {
            const config = await readEnvConfig(envPath);
            const serviceStatus = processState.getStatus();
            const [health, foundryHealth] = await Promise.all([
              checkBlastdoorHealth(config),
              checkFoundryTargetHealth(config),
            ]);
            const environment = detectEnvironmentInfo({ workspaceDir, envPath });
            const diagnosticsReport = {
              generatedAt: new Date().toISOString(),
              serviceStatus,
              health,
              environment,
              config: sanitizeConfigForDiagnostics(config),
            };
            const troubleshootReport = createTroubleshootReport({
              config,
              health,
              foundryHealth,
              environment,
              serviceStatus,
            });

            const result = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.runTroubleshootRecommendation({
                errorText: normalizeManagerString(req.body?.errorText, ""),
                diagnosticsReport,
                troubleshootReport,
              });
            });

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

        registerApiPost("/assistant/workflow/threat-monitor", async (req, res) => {
          try {
            const config = await readEnvConfig(envPath);
            const blastDoorsClosed = parseBooleanLike(config.BLAST_DOORS_CLOSED, false);
            const debugPath = path.join(workspaceDir, config.DEBUG_LOG_FILE || CONFIG_DEFAULTS.DEBUG_LOG_FILE);
            const debugLogLines = await tailFile(debugPath, 400);
            const runtimeLogLines = processState.recentRuntimeLogs(400);
            const logLines = [...runtimeLogLines, ...debugLogLines];
            const threshold = Number.parseInt(
              normalizeManagerString(
                config.ASSISTANT_THREAT_SCORE_THRESHOLD,
                CONFIG_DEFAULTS.ASSISTANT_THREAT_SCORE_THRESHOLD,
              ),
              10,
            );

            const result = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.runThreatMonitor({
                logLines,
                blastDoorsClosed,
                threatScoreThreshold: Number.isInteger(threshold) ? threshold : 80,
              });
            });

            const autoLockEnabled = parseBooleanLike(
              config.ASSISTANT_AUTO_LOCK_ON_THREAT,
              parseBooleanLike(CONFIG_DEFAULTS.ASSISTANT_AUTO_LOCK_ON_THREAT, false),
            );
            const applyLockdownRequested = parseBooleanLikeBody(req.body?.applyLockdown ?? true);
            let lockdown = {
              applied: false,
              serviceRestarted: false,
              sessionSecretRotated: false,
            };

            if (autoLockEnabled && applyLockdownRequested && result?.shouldLockdown && !blastDoorsClosed) {
              const lockResult = await applyThreatLockdown(config);
              lockdown = {
                applied: true,
                serviceRestarted: Boolean(lockResult.serviceRestarted),
                sessionSecretRotated: Boolean(lockResult.sessionSecretRotated),
              };
            }

            res.json({
              ok: true,
              result: result || {},
              lockdown,
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/workflow/grimoire", async (req, res) => {
          try {
            const intent = normalizeManagerString(req.body?.intent, "");
            if (!intent) {
              throw new Error("intent is required.");
            }

            const result = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.runGrimoire({
                intent,
                apiDocs: Array.isArray(req.body?.apiDocs) ? req.body.apiDocs : makeApiDocSnapshot(),
              });
            });

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
              agentConfigs: store.agents || [],
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
              draft,
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
              agent: hydrated,
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
              agent: saved.agent || null,
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

        registerApiGet("/assistant/plans", async (req, res) => {
          try {
            const limit = Number.parseInt(normalizeManagerString(req.query?.limit, "20"), 10);
            const runs = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.listPlanRuns({ limit });
            });
            res.json({
              ok: true,
              runs: Array.isArray(runs) ? runs : [],
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiGet("/assistant/plans/:runId", async (req, res) => {
          try {
            const runId = normalizeManagerString(req.params?.runId, "");
            if (!runId) {
              throw new Error("runId is required.");
            }
            const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.getPlanRun({ runId });
            });
            if (!run) {
              return res.status(404).json({ error: "Plan run not found." });
            }
            return res.json({
              ok: true,
              run,
            });
          } catch (error) {
            return res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/plans/create", async (req, res) => {
          try {
            const goal = normalizeManagerString(req.body?.goal, "");
            if (!goal) {
              throw new Error("goal is required.");
            }

            const requestedWorkflowId = normalizeManagerString(req.body?.workflowId, DEFAULT_PHASE0_WORKFLOW_ID);
            const workflowStore = await readIntelligenceWorkflowStore(workflowStorePath);
            const selectedWorkflow = chooseWorkflowById(workflowStore, requestedWorkflowId);
            if (!selectedWorkflow) {
              throw new Error("No workflow is available to generate plan scaffolding.");
            }

            const config = await readEnvConfig(envPath);
            const contextData = await buildAssistantContext(config);
            const assistantMessage =
              normalizeManagerString(req.body?.message, "") ||
              `Create a phase 0 plan for this goal: ${goal}. Return concise JSON with summary and steps[].`;

            const chatResult = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
                workflow: selectedWorkflow,
                message: assistantMessage,
                context: {
                  diagnosticsReport: contextData.diagnosticsReport,
                  troubleshootReport: contextData.troubleshootReport,
                  installationConfig: contextData.installationConfig || {},
                  apiDocs: makeApiDocSnapshot(),
                  planGoal: goal,
                  phase: "phase-0",
                },
              });
            });

            const initialLayer = derivePlanLayerFromChatResult(chatResult, {
              goal,
              fallbackSummary: `Phase 0 plan created for: ${goal}`,
            });

            const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.createPlanRun({
                workflowId: selectedWorkflow.id,
                goal,
                createdBy: "manager-ui",
                initialLayer: {
                  summary: initialLayer.summary,
                  plan: {
                    ...initialLayer.plan,
                    bootstrap: true,
                  },
                },
                meta: {
                  phase: "phase-0",
                  workflowType: selectedWorkflow.type,
                },
              });
            });

            res.json({
              ok: true,
              run: run || null,
              selectedWorkflow: summarizeWorkflowForList(selectedWorkflow),
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/plans/:runId/evidence", async (req, res) => {
          try {
            const runId = normalizeManagerString(req.params?.runId, "");
            if (!runId) {
              throw new Error("runId is required.");
            }
            const title = normalizeManagerString(req.body?.title, "Operator note");
            const summary = normalizeManagerString(req.body?.summary, "");
            if (!summary) {
              throw new Error("summary is required.");
            }
            const payload =
              req.body?.payload && typeof req.body.payload === "object"
                ? req.body.payload
                : {
                    note: summary,
                  };

            const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.addPlanEvidence({
                runId,
                entries: [
                  {
                    type: "operator-note",
                    title,
                    summary,
                    payload,
                  },
                ],
              });
            });
            res.json({
              ok: true,
              run: run || null,
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/plans/:runId/collect-evidence", async (req, res) => {
          try {
            const runId = normalizeManagerString(req.params?.runId, "");
            if (!runId) {
              throw new Error("runId is required.");
            }
            const config = await readEnvConfig(envPath);
            const contextData = await buildAssistantContext(config);
            const operatorNote = normalizeManagerString(req.body?.note, "");
            const entries = [
              {
                type: "diagnostics-report",
                title: "Diagnostics report snapshot",
                summary: "Captured current diagnostics report for this plan run.",
                payload: contextData.diagnosticsReport,
              },
              {
                type: "troubleshoot-report",
                title: "Troubleshooting report snapshot",
                summary: "Captured troubleshooting report for current runtime state.",
                payload: contextData.troubleshootReport,
              },
            ];
            if (operatorNote) {
              entries.push({
                type: "operator-note",
                title: "Operator note",
                summary: operatorNote,
                payload: {
                  note: operatorNote,
                },
              });
            }

            const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.addPlanEvidence({
                runId,
                entries,
              });
            });

            res.json({
              ok: true,
              run: run || null,
              evidenceAdded: entries.length,
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/plans/:runId/refine", async (req, res) => {
          try {
            const runId = normalizeManagerString(req.params?.runId, "");
            if (!runId) {
              throw new Error("runId is required.");
            }

            const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.getPlanRun({ runId });
            });
            if (!run) {
              return res.status(404).json({ error: "Plan run not found." });
            }

            const workflowStore = await readIntelligenceWorkflowStore(workflowStorePath);
            const selectedWorkflow = chooseWorkflowById(
              workflowStore,
              normalizeManagerString(req.body?.workflowId, run.workflowId || DEFAULT_PHASE0_WORKFLOW_ID),
            );
            if (!selectedWorkflow) {
              return res.status(400).json({ error: "No workflow is available to refine this plan." });
            }

            const config = await readEnvConfig(envPath);
            const contextData = await buildAssistantContext(config);
            const operatorMessage =
              normalizeManagerString(req.body?.message, "") ||
              `Refine this plan with a deeper layer based on evidence and diagnostics. Goal: ${run.goal || ""}`.trim();

            const chatResult = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
                workflow: selectedWorkflow,
                message: operatorMessage,
                context: {
                  diagnosticsReport: contextData.diagnosticsReport,
                  troubleshootReport: contextData.troubleshootReport,
                  installationConfig: contextData.installationConfig || {},
                  apiDocs: makeApiDocSnapshot(),
                  planRun: run,
                  phase: "phase-0-refine",
                },
              });
            });

            const lastLayer = Array.isArray(run.layers) && run.layers.length > 0 ? run.layers[run.layers.length - 1] : null;
            const layer = derivePlanLayerFromChatResult(chatResult, {
              goal: run.goal || "",
              fallbackSummary: `Refined layer for: ${run.goal || "plan run"}`,
            });

            const updatedRun = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.addPlanLayer({
                runId,
                layer: {
                  source: "assistant",
                  parentLayer: Number.isInteger(lastLayer?.layer) ? lastLayer.layer : null,
                  summary: layer.summary,
                  plan: layer.plan,
                },
              });
            });

            return res.json({
              ok: true,
              run: updatedRun || null,
              selectedWorkflow: summarizeWorkflowForList(selectedWorkflow),
            });
          } catch (error) {
            return res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiGet("/assistant/workflows", async (_req, res) => {
          try {
            const store = await readIntelligenceWorkflowStore(workflowStorePath);
            res.json({
              ok: true,
              workflows: (store.workflows || []).map(summarizeWorkflowForList),
              workflowConfigs: store.workflows || [],
            });
          } catch (error) {
            res.status(500).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/workflows/save", async (req, res) => {
          try {
            const draft = req.body?.workflow && typeof req.body.workflow === "object" ? req.body.workflow : req.body || {};
            const saved = await upsertIntelligenceWorkflow(workflowStorePath, draft);
            res.json({
              ok: true,
              workflow: saved.workflow || null,
              workflows: (saved.store?.workflows || []).map(summarizeWorkflowForList),
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/workflows/delete", async (req, res) => {
          try {
            const workflowId = normalizeManagerString(req.body?.workflowId, "");
            const saved = await deleteIntelligenceWorkflow(workflowStorePath, workflowId);
            res.json({
              ok: true,
              deletedWorkflowId: workflowId,
              workflows: (saved.workflows || []).map(summarizeWorkflowForList),
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/workflows/generate-config", async (req, res) => {
          try {
            const description = normalizeManagerString(req.body?.description, "");
            if (!description) {
              throw new Error("description is required.");
            }

            const result = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
                workflow: {
                  id: "workflow-config-builder",
                  name: "Workflow Config Builder",
                  type: "workflow-config-builder",
                },
                message: description,
                context: {
                  requestSource: "manager-ui",
                },
              });
            });

            res.json({
              ok: true,
              result: result || {},
              suggestedWorkflow: result?.suggestedWorkflow || null,
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/workflows/chat", async (req, res) => {
          try {
            const workflowId = normalizeManagerString(req.body?.workflowId, "");
            const message = normalizeManagerString(req.body?.message, "");
            const draftWorkflow = req.body?.workflow && typeof req.body.workflow === "object" ? req.body.workflow : null;
            const applyLockdown = parseBooleanLikeBody(req.body?.applyLockdown ?? true);

            const workflowStore = await readIntelligenceWorkflowStore(workflowStorePath);
            const selectedWorkflow =
              draftWorkflow ||
              workflowStore.workflows.find((workflow) => workflow.id === workflowId) ||
              workflowStore.workflows.find((workflow) => workflow.id === "troubleshoot-recommendation") ||
              null;
            if (!selectedWorkflow) {
              throw new Error("No workflow is available to run.");
            }

            const config = await readEnvConfig(envPath);
            const serviceStatus = processState.getStatus();
            const [health, foundryHealth] = await Promise.all([
              checkBlastdoorHealth(config),
              checkFoundryTargetHealth(config),
            ]);
            const environment = detectEnvironmentInfo({ workspaceDir, envPath });
            const diagnosticsReport = {
              generatedAt: new Date().toISOString(),
              serviceStatus,
              health,
              environment,
              config: sanitizeConfigForDiagnostics(config),
            };
            const troubleshootReport = createTroubleshootReport({
              config,
              health,
              foundryHealth,
              environment,
              serviceStatus,
            });
            const installationConfig = await readInstallationConfig(installationConfigPath);

            const debugPath = `${workspaceDir}/${config.DEBUG_LOG_FILE || CONFIG_DEFAULTS.DEBUG_LOG_FILE}`;
            const debugLogLines = await tailFile(debugPath, 400);
            const runtimeLogLines = processState.recentRuntimeLogs(400);
            const logLines = [...runtimeLogLines, ...debugLogLines];
            const blastDoorsClosed = parseBooleanLike(config.BLAST_DOORS_CLOSED, false);

            const chatResult = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
                workflow: selectedWorkflow,
                message,
                context: {
                  diagnosticsReport,
                  troubleshootReport,
                  installationConfig: installationConfig || {},
                  apiDocs: makeApiDocSnapshot(),
                  logLines,
                  blastDoorsClosed,
                  threatScoreThreshold: selectedWorkflow?.threatScoreThreshold || 80,
                },
              });
            });

            let lockdown = {
              applied: false,
              serviceRestarted: false,
              sessionSecretRotated: false,
            };

            const workflowAutoLock = Boolean(selectedWorkflow?.autoLockOnThreat);
            if (workflowAutoLock && applyLockdown && chatResult?.shouldLockdown && !blastDoorsClosed) {
              const lockResult = await applyThreatLockdown(config);
              lockdown = {
                applied: true,
                serviceRestarted: Boolean(lockResult.serviceRestarted),
                sessionSecretRotated: Boolean(lockResult.sessionSecretRotated),
              };
            }

            res.json({
              ok: true,
              workflow: summarizeWorkflowForList(selectedWorkflow),
              result: chatResult || {},
              lockdown,
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      },
    },
  };
}
