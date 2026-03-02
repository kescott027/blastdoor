import { createAssistantClient, loadAssistantRuntimeConfig } from "../assistant-client.js";
import path from "node:path";
import { readInstallationConfig } from "../installation-config.js";
import { createIntelligencePlanStore } from "../intelligence-plan-store.js";

import {
  normalizeAssistantProvider,
  validateAssistantConfig,
  ensureIntelligenceNamespace,
  getIntelligenceEnvFieldDefaults,
} from "./intelligence/helpers.js";
import { registerIntelligenceWorkflowRoutes } from "./intelligence/capabilities/workflows.js";
import { registerIntelligenceAgentRoutes } from "./intelligence/capabilities/agents.js";
import { registerIntelligenceWizardRoutes } from "./intelligence/capabilities/wizard.js";
import { registerIntelligencePlanRoutes } from "./intelligence/capabilities/plans.js";

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
        "ASSISTANT_EXTERNAL_API_ENABLED",
        "ASSISTANT_EXTERNAL_API_TOKEN",
        "ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED",
        "ASSISTANT_EXTERNAL_API_SIGNING_SECRET",
        "ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS",
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
        ASSISTANT_EXTERNAL_API_ENABLED: "false",
        ASSISTANT_EXTERNAL_API_TOKEN: "",
        ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED: "false",
        ASSISTANT_EXTERNAL_API_SIGNING_SECRET: "",
        ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS: "900",
      },
      sensitiveKeys: [
        "ASSISTANT_TOKEN",
        "ASSISTANT_EXTERNAL_API_TOKEN",
        "ASSISTANT_EXTERNAL_API_SIGNING_SECRET",
      ],
      diagnosticsSummaryLines(config) {
        return [
          `Assistant: ${config.ASSISTANT_ENABLED === "true" ? "enabled" : "disabled"} (${normalizeAssistantProvider(config.ASSISTANT_PROVIDER)})`,
          `Assistant RAG/Web: ${config.ASSISTANT_RAG_ENABLED || "false"} / ${config.ASSISTANT_ALLOW_WEB_SEARCH || "false"}`,
          `Assistant Auto-Lock: ${config.ASSISTANT_AUTO_LOCK_ON_THREAT || "false"} (threshold: ${config.ASSISTANT_THREAT_SCORE_THRESHOLD || "80"})`,
          `Assistant External API: ${config.ASSISTANT_EXTERNAL_API_ENABLED || "false"}`,
          `Assistant Signed Tokens: ${config.ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED || "false"} (ttl: ${config.ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS || "900"}s)`,
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
        "ASSISTANT_EXTERNAL_API_ENABLED",
        "ASSISTANT_EXTERNAL_API_TOKEN",
        "ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED",
        "ASSISTANT_EXTERNAL_API_SIGNING_SECRET",
        "ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS",
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
          ASSISTANT_EXTERNAL_API_ENABLED: String(Boolean(config.assistantExternalApiEnabled)),
          ASSISTANT_EXTERNAL_API_TOKEN: String(config.assistantExternalApiToken || ""),
          ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED: String(Boolean(config.assistantExternalApiSignedTokensEnabled)),
          ASSISTANT_EXTERNAL_API_SIGNING_SECRET: String(config.assistantExternalApiSigningSecret || ""),
          ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS: String(config.assistantExternalApiSignedTokenTtlSeconds || 900),
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
        intelligence.putPlanRun = async (payload = {}) => {
          const run = payload && typeof payload.run === "object" ? payload.run : payload;
          if (!run || typeof run !== "object") {
            throw new Error("run payload is required.");
          }
          const planStore = await getPlanStore();
          return await planStore.putRun(run);
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
        intelligence.putPlanRun = async (payload = {}) => {
          const run = payload && typeof payload.run === "object" ? payload.run : payload;
          const runId = String(run?.runId || "").trim();
          if (!runId) {
            throw new Error("runId is required.");
          }
          const body = await request(`/internal/plugins/intelligence/plans/${encodeURIComponent(runId)}/save`, {
            method: "POST",
            payload: {
              run,
            },
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
        registerWrite("/internal/plugins/intelligence/plans/:runId/save", async (req, res) => {
          const sourceRun = req.body?.run && typeof req.body.run === "object" ? req.body.run : req.body || {};
          const run = await api.plugins?.intelligence?.putPlanRun({
            run: {
              ...sourceRun,
              runId: req.params?.runId || sourceRun.runId,
            },
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
        runTroubleshootAction,
        commandRunner,
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

        const routeContext = {
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
          normalizeManagerString,
          applyThreatLockdown,
          runTroubleshootAction,
          commandRunner,
          CONFIG_DEFAULTS,
          installationConfigPath,
          workflowStorePath,
          agentStorePath,
          DEFAULT_PHASE0_WORKFLOW_ID,
          buildAssistantContext,
        };

        registerIntelligenceWorkflowRoutes(routeContext);
        registerIntelligenceAgentRoutes(routeContext);
        registerIntelligenceWizardRoutes(routeContext);
        registerIntelligencePlanRoutes(routeContext);
      },
    },
  };
}
