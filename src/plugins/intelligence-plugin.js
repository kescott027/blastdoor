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
  writeIntelligenceAgentStore,
  upsertIntelligenceAgent,
} from "../intelligence-agent-store.js";
import { createPasswordHash, safeEqual, verifyPassword } from "../security.js";

import {
  normalizeAssistantProvider,
  validateAssistantConfig,
  normalizeExternalAssistantToken,
  parsePositiveInteger,
  nowIso,
  createAgentScopedToken,
  createScopedTokenRecord,
  normalizeAgentExternalAccess,
  isScopedTokenActive,
  createSignedAgentToken,
  verifySignedAgentToken,
  ensureIntelligenceNamespace,
  getIntelligenceEnvFieldDefaults,
  makeApiDocSnapshot,
  derivePlanLayerFromChatResult,
  chooseWorkflowById,
  WIZARD_STEP_SEQUENCE,
  SAFE_WIZARD_ACTIONS,
  clampInteger,
  createWizardHostFingerprint,
  normalizeWizardState,
  createDefaultWizardState,
  getWizardStateForRun,
  setWizardStep,
  buildWizardSummary,
  parseClarificationContract,
  parseSufficiencyContract,
  parseExecutionPlanContract,
  normalizeSafeActionTrustList,
  workflowTrustsAction,
  summarizeAgentForList,
  sanitizeAgentForManager,
} from "./intelligence/helpers.js";

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

        function describeSafeAction(actionId, safeActions = []) {
          const action = (Array.isArray(safeActions) ? safeActions : []).find((entry) => entry?.id === actionId) || null;
          const commandSummaryById = {
            "snapshot.network": "Runs read-only commands: ss, ip addr, ip route, hostname -I, ufw status.",
            "check.gateway-local": "Runs local HTTP health checks against configured Blastdoor endpoints.",
            "detect.wsl-portproxy":
              "Runs read-only Windows checks via PowerShell: netsh portproxy show and firewall rule lookup.",
          };
          return {
            actionId,
            title: action?.title || actionId,
            description: action?.description || "Read-only troubleshooting action.",
            commandSummary: commandSummaryById[actionId] || "Read-only troubleshooting action.",
          };
        }

        function appendWizardExecutionLog(wizard, event, detail) {
          const logs = Array.isArray(wizard?.execution?.logs) ? [...wizard.execution.logs] : [];
          logs.push({
            ts: new Date().toISOString(),
            event: normalizeManagerString(event, "wizard.event"),
            detail: normalizeManagerString(detail, ""),
          });
          return normalizeWizardState({
            ...wizard,
            execution: {
              ...(wizard?.execution || {}),
              logs: logs.slice(-200),
            },
          });
        }

        async function resolveWizardRun({ runId, config }) {
          const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
            return await blastdoorApi.plugins?.intelligence?.getPlanRun({ runId });
          });
          if (!run) {
            throw new Error("Plan run not found.");
          }
          const contextData = await buildAssistantContext(config);
          const hostFingerprint = createWizardHostFingerprint({
            environment: contextData.environment,
            config,
          });
          const wizard = getWizardStateForRun(run, {
            hostFingerprint,
            workflowId: normalizeManagerString(run?.workflowId, DEFAULT_PHASE0_WORKFLOW_ID),
            currentStep: "define_name",
            nextPrompt: "Enter workflow name, then click Next.",
            confidence: {
              current: 0,
              threshold: 80,
            },
            clarification: {
              round: 0,
              questions: [],
              answers: [],
            },
            execution: {
              steps: [],
              logs: [],
            },
          });
          return {
            run,
            wizard,
            contextData,
            hostFingerprint,
          };
        }

        async function saveWizardRun({ run, wizard, status }) {
          const sourceRun = run && typeof run === "object" ? run : {};
          const sourceWizard = wizard && typeof wizard === "object" ? wizard : {};
          const nextRun = {
            ...sourceRun,
            wizard: normalizeWizardState({
              ...sourceWizard,
              lastSavedAt: new Date().toISOString(),
            }),
          };
          if (status) {
            nextRun.status = status;
          }
          return await withBlastdoorApi(async ({ blastdoorApi }) => {
            return await blastdoorApi.plugins?.intelligence?.putPlanRun({
              run: nextRun,
            });
          });
        }

        function unansweredRequiredCount(wizard) {
          const questions = Array.isArray(wizard?.clarification?.questions) ? wizard.clarification.questions : [];
          const answers = Array.isArray(wizard?.clarification?.answers) ? wizard.clarification.answers : [];
          return questions.filter((question) => {
            if (question.required === false) {
              return false;
            }
            return !answers.some(
              (answer) => answer.questionId === question.id && normalizeManagerString(answer.answer, ""),
            );
          }).length;
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
          const enabled = parseBooleanLike(
            envConfig.ASSISTANT_EXTERNAL_API_ENABLED,
            parseBooleanLike(CONFIG_DEFAULTS.ASSISTANT_EXTERNAL_API_ENABLED, false),
          );
          const signedTokensEnabled = parseBooleanLike(
            envConfig.ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED,
            parseBooleanLike(CONFIG_DEFAULTS.ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED, false),
          );
          const signingSecret = normalizeManagerString(
            envConfig.ASSISTANT_EXTERNAL_API_SIGNING_SECRET,
            CONFIG_DEFAULTS.ASSISTANT_EXTERNAL_API_SIGNING_SECRET,
          );
          const signedTokenTtlSeconds = parsePositiveInteger(
            normalizeManagerString(
              envConfig.ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS,
              CONFIG_DEFAULTS.ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS,
            ),
            900,
          );
          const legacySharedToken = normalizeManagerString(
            envConfig.ASSISTANT_EXTERNAL_API_TOKEN,
            CONFIG_DEFAULTS.ASSISTANT_EXTERNAL_API_TOKEN,
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
                ASSISTANT_EXTERNAL_API_ENABLED: normalizeManagerString(
                  config.ASSISTANT_EXTERNAL_API_ENABLED,
                  CONFIG_DEFAULTS.ASSISTANT_EXTERNAL_API_ENABLED,
                ),
                ASSISTANT_EXTERNAL_API_TOKEN: normalizeManagerString(
                  config.ASSISTANT_EXTERNAL_API_TOKEN,
                  CONFIG_DEFAULTS.ASSISTANT_EXTERNAL_API_TOKEN,
                )
                  ? "[REDACTED]"
                  : "",
                ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED: normalizeManagerString(
                  config.ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED,
                  CONFIG_DEFAULTS.ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED,
                ),
                ASSISTANT_EXTERNAL_API_SIGNING_SECRET: normalizeManagerString(
                  config.ASSISTANT_EXTERNAL_API_SIGNING_SECRET,
                  CONFIG_DEFAULTS.ASSISTANT_EXTERNAL_API_SIGNING_SECRET,
                )
                  ? "[REDACTED]"
                  : "",
                ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS: normalizeManagerString(
                  config.ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS,
                  CONFIG_DEFAULTS.ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS,
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

        registerApiGet("/assistant/wizard/runs", async (req, res) => {
          try {
            const limit = Number.parseInt(normalizeManagerString(req.query?.limit, "20"), 10);
            const summaries = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.listPlanRuns({ limit });
            });
            const runs = [];
            for (const summary of Array.isArray(summaries) ? summaries : []) {
              const runId = normalizeManagerString(summary?.runId, "");
              if (!runId) {
                continue;
              }
              const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
                return await blastdoorApi.plugins?.intelligence?.getPlanRun({ runId });
              });
              if (!run) {
                continue;
              }
              runs.push(buildWizardSummary(run));
            }
            res.json({
              ok: true,
              runs,
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/wizard/start", async (req, res) => {
          try {
            const config = await readEnvConfig(envPath);
            const contextData = await buildAssistantContext(config);
            const hostFingerprint = createWizardHostFingerprint({
              environment: contextData.environment,
              config,
            });
            const workflowStore = await readIntelligenceWorkflowStore(workflowStorePath);
            const selectedWorkflow = chooseWorkflowById(
              workflowStore,
              normalizeManagerString(req.body?.workflowId, DEFAULT_PHASE0_WORKFLOW_ID),
            );
            if (!selectedWorkflow) {
              throw new Error("No workflow available for wizard start.");
            }
            const runName = normalizeManagerString(req.body?.runName, "");
            const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
              return await blastdoorApi.plugins?.intelligence?.createPlanRun({
                workflowId: selectedWorkflow.id,
                goal: "",
                createdBy: "manager-ui-wizard",
                initialLayer: {
                  summary: "Wizard initialized.",
                  plan: {
                    summary: "Pending initial plan generation.",
                    steps: [],
                  },
                },
                meta: {
                  wizard: true,
                  runName,
                },
              });
            });
            let wizard = createDefaultWizardState({
              workflowId: selectedWorkflow.id,
              hostFingerprint,
              runName,
            });
            let nextRun = {
              ...run,
              status: "wizard",
              meta: {
                ...(run?.meta && typeof run.meta === "object" ? run.meta : {}),
                wizard: true,
                runName,
              },
            };
            if (runName) {
              wizard = setWizardStep(wizard, "define_goal", "Enter workflow goal, then click Next.");
              wizard = appendWizardExecutionLog(wizard, "wizard.start", `Run created with name '${runName}'.`);
            } else {
              wizard = appendWizardExecutionLog(wizard, "wizard.start", "Run created and waiting for workflow name.");
            }
            const saved = await saveWizardRun({
              run: nextRun,
              wizard,
              status: "wizard",
            });
            res.json({
              ok: true,
              run: saved || null,
              summary: buildWizardSummary(saved),
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiGet("/assistant/wizard/:runId", async (req, res) => {
          try {
            const runId = normalizeManagerString(req.params?.runId, "");
            if (!runId) {
              throw new Error("runId is required.");
            }
            const config = await readEnvConfig(envPath);
            const { run, wizard } = await resolveWizardRun({ runId, config });
            const hydrated = {
              ...run,
              wizard,
            };
            res.json({
              ok: true,
              run: hydrated,
              summary: buildWizardSummary(hydrated),
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/wizard/:runId/save", async (req, res) => {
          try {
            const runId = normalizeManagerString(req.params?.runId, "");
            if (!runId) {
              throw new Error("runId is required.");
            }
            const config = await readEnvConfig(envPath);
            const { run, wizard, hostFingerprint } = await resolveWizardRun({ runId, config });
            const workflowId = normalizeManagerString(req.body?.workflowId, wizard.workflowId || run.workflowId);
            const runName = normalizeManagerString(req.body?.runName, run?.meta?.runName || "");
            const goal = normalizeManagerString(req.body?.goal, run.goal || "");
            let nextWizard = normalizeWizardState(
              req.body?.wizard && typeof req.body.wizard === "object"
                ? {
                    ...wizard,
                    ...req.body.wizard,
                  }
                : wizard,
              {
                hostFingerprint,
                workflowId,
              },
            );
            nextWizard = appendWizardExecutionLog(nextWizard, "wizard.save", "Wizard state saved.");
            const saved = await saveWizardRun({
              run: {
                ...run,
                workflowId,
                goal,
                meta: {
                  ...(run?.meta && typeof run.meta === "object" ? run.meta : {}),
                  runName,
                  wizard: true,
                },
              },
              wizard: nextWizard,
              status: run.status || "wizard",
            });
            res.json({
              ok: true,
              run: saved || null,
              summary: buildWizardSummary(saved),
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/wizard/:runId/answer", async (req, res) => {
          try {
            const runId = normalizeManagerString(req.params?.runId, "");
            const questionId = normalizeManagerString(req.body?.questionId, "");
            const answerText = normalizeManagerString(req.body?.answer, "");
            if (!runId || !questionId) {
              throw new Error("runId and questionId are required.");
            }
            const config = await readEnvConfig(envPath);
            const { run, wizard } = await resolveWizardRun({ runId, config });
            const answers = Array.isArray(wizard?.clarification?.answers) ? [...wizard.clarification.answers] : [];
            const existingIndex = answers.findIndex((entry) => entry.questionId === questionId);
            const nextEntry = {
              questionId,
              answer: answerText,
              answeredAt: new Date().toISOString(),
            };
            if (existingIndex >= 0) {
              answers[existingIndex] = nextEntry;
            } else {
              answers.push(nextEntry);
            }
            let nextWizard = normalizeWizardState({
              ...wizard,
              clarification: {
                ...(wizard?.clarification || {}),
                answers,
              },
            });
            nextWizard = appendWizardExecutionLog(nextWizard, "wizard.answer", `Captured answer for '${questionId}'.`);
            const saved = await saveWizardRun({
              run,
              wizard: nextWizard,
              status: run.status || "wizard",
            });
            res.json({
              ok: true,
              run: saved || null,
              summary: buildWizardSummary(saved),
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/wizard/:runId/back", async (req, res) => {
          try {
            const runId = normalizeManagerString(req.params?.runId, "");
            if (!runId) {
              throw new Error("runId is required.");
            }
            const config = await readEnvConfig(envPath);
            const { run, wizard } = await resolveWizardRun({ runId, config });
            const currentIndex = Math.max(0, WIZARD_STEP_SEQUENCE.indexOf(wizard.currentStep));
            const previousStep = WIZARD_STEP_SEQUENCE[Math.max(0, currentIndex - 1)] || "define_name";
            let nextWizard = setWizardStep(
              wizard,
              previousStep,
              `Moved back to '${previousStep}'. Update inputs, then click Next.`,
            );
            nextWizard = appendWizardExecutionLog(nextWizard, "wizard.back", `Moved back to ${previousStep}.`);
            const saved = await saveWizardRun({
              run,
              wizard: nextWizard,
              status: run.status || "wizard",
            });
            res.json({
              ok: true,
              run: saved || null,
              summary: buildWizardSummary(saved),
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/wizard/:runId/next", async (req, res) => {
          try {
            const runId = normalizeManagerString(req.params?.runId, "");
            if (!runId) {
              throw new Error("runId is required.");
            }
            const config = await readEnvConfig(envPath);
            const { run, wizard, contextData, hostFingerprint } = await resolveWizardRun({ runId, config });
            const workflowStore = await readIntelligenceWorkflowStore(workflowStorePath);
            const selectedWorkflow = chooseWorkflowById(
              workflowStore,
              normalizeManagerString(req.body?.workflowId, wizard.workflowId || run.workflowId || DEFAULT_PHASE0_WORKFLOW_ID),
            );
            if (!selectedWorkflow) {
              throw new Error("No workflow available.");
            }

            let workingRun = {
              ...run,
              workflowId: selectedWorkflow.id,
              status: run.status || "wizard",
              meta: {
                ...(run?.meta && typeof run.meta === "object" ? run.meta : {}),
                wizard: true,
              },
            };
            let nextWizard = normalizeWizardState(
              {
                ...wizard,
                workflowId: selectedWorkflow.id,
                hostFingerprint,
              },
              {
                workflowId: selectedWorkflow.id,
                hostFingerprint,
              },
            );

            if (nextWizard.currentStep === "define_name") {
              const runName = normalizeManagerString(req.body?.runName, workingRun?.meta?.runName || "");
              if (!runName) {
                throw new Error("Workflow name is required.");
              }
              workingRun.meta.runName = runName;
              nextWizard = setWizardStep(nextWizard, "define_goal", "Enter workflow goal, then click Next.");
              nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "define_name complete.");
            } else if (nextWizard.currentStep === "define_goal") {
              const goal = normalizeManagerString(req.body?.goal, workingRun.goal || "");
              if (!goal) {
                throw new Error("Workflow goal is required.");
              }
              workingRun.goal = goal;
              nextWizard = setWizardStep(nextWizard, "create_initial_plan", "Click Next to generate initial plan.");
              nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "define_goal complete.");
            } else if (nextWizard.currentStep === "create_initial_plan") {
              const clarification = await withBlastdoorApi(async ({ blastdoorApi }) => {
                return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
                  workflow: {
                    id: "wizard-clarification",
                    name: "Wizard Clarification",
                    type: "wizard-clarification",
                  },
                  message:
                    normalizeManagerString(req.body?.message, "") ||
                    "Generate clarifying questions and confidence for this workflow run.",
                  context: {
                    runName: normalizeManagerString(workingRun?.meta?.runName, ""),
                    goal: normalizeManagerString(workingRun.goal, ""),
                    round: 1,
                    maxRounds: 3,
                    confidenceThreshold: nextWizard.confidence.threshold,
                    existingQuestions: nextWizard.clarification.questions,
                    answers: nextWizard.clarification.answers,
                    diagnosticsReport: contextData.diagnosticsReport,
                    troubleshootReport: contextData.troubleshootReport,
                  },
                });
              });
              const contract = parseClarificationContract(clarification?.result || clarification);
              nextWizard = normalizeWizardState({
                ...nextWizard,
                confidence: {
                  ...nextWizard.confidence,
                  current: contract.confidence,
                },
                clarification: {
                  ...nextWizard.clarification,
                  round: 1,
                  questions: contract.questions,
                },
              });
              const withLayer = await withBlastdoorApi(async ({ blastdoorApi }) => {
                return await blastdoorApi.plugins?.intelligence?.addPlanLayer({
                  runId,
                  layer: {
                    source: "assistant",
                    summary: contract.summary || "Initial wizard plan generated.",
                    parentLayer: 0,
                    plan: {
                      summary: contract.summary || "Initial wizard plan generated.",
                      steps: [],
                    },
                  },
                });
              });
              workingRun = withLayer || workingRun;
              if (contract.needsMoreInfo) {
                nextWizard = setWizardStep(
                  nextWizard,
                  "clarify_round",
                  "Answer required clarifying questions, then click Next.",
                );
              } else {
                nextWizard = setWizardStep(nextWizard, "sufficiency_gate", "Click Next to evaluate sufficiency.");
              }
              nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "create_initial_plan complete.");
            } else if (nextWizard.currentStep === "clarify_round") {
              const unresolved = unansweredRequiredCount(nextWizard);
              if (unresolved > 0) {
                throw new Error("Answer all required clarifying questions before continuing.");
              }
              const nextRound = Math.min(3, clampInteger(nextWizard?.clarification?.round, 0, 0, 32) + 1);
              const clarification = await withBlastdoorApi(async ({ blastdoorApi }) => {
                return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
                  workflow: {
                    id: "wizard-clarification",
                    name: "Wizard Clarification",
                    type: "wizard-clarification",
                  },
                  message:
                    normalizeManagerString(req.body?.message, "") ||
                    "Re-evaluate clarification and ask additional questions only if needed.",
                  context: {
                    runName: normalizeManagerString(workingRun?.meta?.runName, ""),
                    goal: normalizeManagerString(workingRun.goal, ""),
                    round: nextRound,
                    maxRounds: 3,
                    confidenceThreshold: nextWizard.confidence.threshold,
                    existingQuestions: nextWizard.clarification.questions,
                    answers: nextWizard.clarification.answers,
                    diagnosticsReport: contextData.diagnosticsReport,
                    troubleshootReport: contextData.troubleshootReport,
                  },
                });
              });
              const contract = parseClarificationContract(clarification?.result || clarification);
              nextWizard = normalizeWizardState({
                ...nextWizard,
                confidence: {
                  ...nextWizard.confidence,
                  current: contract.confidence,
                },
                clarification: {
                  ...nextWizard.clarification,
                  round: nextRound,
                  questions: contract.questions,
                },
              });
              if (contract.needsMoreInfo && nextRound < 3) {
                nextWizard = setWizardStep(
                  nextWizard,
                  "clarify_round",
                  "Additional clarification is needed. Answer questions and click Next.",
                );
              } else {
                nextWizard = setWizardStep(nextWizard, "sufficiency_gate", "Click Next to evaluate sufficiency.");
              }
              nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "clarify_round processed.");
            } else if (nextWizard.currentStep === "sufficiency_gate") {
              const unresolved = unansweredRequiredCount(nextWizard);
              const sufficiency = await withBlastdoorApi(async ({ blastdoorApi }) => {
                return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
                  workflow: {
                    id: "wizard-sufficiency",
                    name: "Wizard Sufficiency Gate",
                    type: "wizard-sufficiency",
                  },
                  message:
                    normalizeManagerString(req.body?.message, "") || "Determine if confidence is sufficient for evidence.",
                  context: {
                    confidenceCurrent: nextWizard.confidence.current,
                    confidenceThreshold: nextWizard.confidence.threshold,
                    unansweredRequired: unresolved,
                  },
                });
              });
              const contract = parseSufficiencyContract(sufficiency?.result || sufficiency);
              nextWizard = normalizeWizardState({
                ...nextWizard,
                confidence: {
                  ...nextWizard.confidence,
                  current: contract.confidence,
                },
              });
              if (contract.readyForEvidence) {
                nextWizard = setWizardStep(nextWizard, "collect_evidence", "Click Next to collect evidence.");
              } else if (nextWizard.clarification.round < 3) {
                nextWizard = setWizardStep(
                  nextWizard,
                  "clarify_round",
                  "More clarification is required. Answer pending questions and click Next.",
                );
              } else {
                nextWizard = setWizardStep(
                  nextWizard,
                  "collect_evidence",
                  "Proceeding with current confidence due max clarification rounds reached.",
                );
              }
              nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "sufficiency_gate processed.");
            } else if (nextWizard.currentStep === "collect_evidence") {
              const operatorNote = normalizeManagerString(req.body?.note, "");
              const entries = [
                {
                  type: "diagnostics-report",
                  title: "Diagnostics report snapshot",
                  summary: "Captured current diagnostics report for this wizard run.",
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
                  payload: { note: operatorNote },
                });
              }
              const withEvidence = await withBlastdoorApi(async ({ blastdoorApi }) => {
                return await blastdoorApi.plugins?.intelligence?.addPlanEvidence({
                  runId,
                  entries,
                });
              });
              workingRun = withEvidence || workingRun;
              nextWizard = setWizardStep(nextWizard, "refine_layer", "Click Next to refine the next planning layer.");
              nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "collect_evidence complete.");
            } else if (nextWizard.currentStep === "refine_layer") {
              const chatResult = await withBlastdoorApi(async ({ blastdoorApi }) => {
                return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
                  workflow: selectedWorkflow,
                  message:
                    normalizeManagerString(req.body?.message, "") ||
                    `Refine this plan with a deeper layer. Goal: ${normalizeManagerString(workingRun.goal, "")}`.trim(),
                  context: {
                    diagnosticsReport: contextData.diagnosticsReport,
                    troubleshootReport: contextData.troubleshootReport,
                    installationConfig: contextData.installationConfig || {},
                    apiDocs: makeApiDocSnapshot(),
                    planRun: workingRun,
                    phase: "wizard-refine",
                  },
                });
              });
              const layer = derivePlanLayerFromChatResult(chatResult, {
                goal: workingRun.goal || "",
                fallbackSummary: `Wizard refined layer for: ${workingRun.goal || "plan run"}`,
              });
              const lastLayer = Array.isArray(workingRun.layers) && workingRun.layers.length > 0
                ? workingRun.layers[workingRun.layers.length - 1]
                : null;
              const withLayer = await withBlastdoorApi(async ({ blastdoorApi }) => {
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
              workingRun = withLayer || workingRun;
              const boostedConfidence = clampInteger(nextWizard.confidence.current + 15, nextWizard.confidence.current, 0, 100);
              nextWizard = normalizeWizardState({
                ...nextWizard,
                confidence: {
                  ...nextWizard.confidence,
                  current: boostedConfidence,
                },
              });
              if (boostedConfidence >= nextWizard.confidence.threshold || nextWizard.clarification.round >= 3) {
                nextWizard = setWizardStep(nextWizard, "execution_prep", "Click Next to generate execution steps.");
              } else {
                nextWizard = setWizardStep(nextWizard, "collect_evidence", "Additional evidence needed. Click Next.");
              }
              nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "refine_layer complete.");
            } else if (nextWizard.currentStep === "execution_prep") {
              const executionPlan = await withBlastdoorApi(async ({ blastdoorApi }) => {
                return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
                  workflow: {
                    id: "wizard-execution-plan",
                    name: "Wizard Execution Planner",
                    type: "wizard-execution-plan",
                  },
                  message:
                    normalizeManagerString(req.body?.message, "") || "Generate executable steps for this workflow run.",
                  context: {
                    runName: normalizeManagerString(workingRun?.meta?.runName, ""),
                    goal: normalizeManagerString(workingRun.goal, ""),
                    environment: contextData.environment,
                    diagnosticsReport: contextData.diagnosticsReport,
                    troubleshootReport: contextData.troubleshootReport,
                  },
                });
              });
              const executionContract = parseExecutionPlanContract(executionPlan?.result || executionPlan);
              const steps =
                executionContract.steps.length > 0
                  ? executionContract.steps
                  : [
                      {
                        id: "manual-1",
                        title: "Manual operator execution",
                        instructions: "Follow the refined plan and record outcomes.",
                        mode: "manual",
                        actionId: "",
                        completionCriteria: "Operator confirms step completion.",
                        completed: false,
                        result: "",
                        completedAt: "",
                      },
                    ];
              nextWizard = normalizeWizardState({
                ...nextWizard,
                execution: {
                  ...nextWizard.execution,
                  steps,
                },
              });
              nextWizard = setWizardStep(nextWizard, "execute_steps", "Execute the current step, then click Next.");
              nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "execution_prep complete.");
            } else if (nextWizard.currentStep === "execute_steps") {
              const steps = Array.isArray(nextWizard?.execution?.steps) ? [...nextWizard.execution.steps] : [];
              const firstIncomplete = steps.find((step) => !step.completed) || null;
              if (!firstIncomplete) {
                nextWizard = setWizardStep(nextWizard, "completed", "Workflow run completed.");
                nextWizard = appendWizardExecutionLog(nextWizard, "wizard.complete", "All execution steps completed.");
                workingRun.status = "completed";
              } else {
                const completeStepId = normalizeManagerString(req.body?.completeStepId, "");
                const completionResult = normalizeManagerString(req.body?.result, "");
                if (completeStepId) {
                  const idx = steps.findIndex((step) => step.id === completeStepId);
                  if (idx < 0) {
                    throw new Error("Invalid completeStepId.");
                  }
                  steps[idx] = {
                    ...steps[idx],
                    completed: true,
                    result: completionResult,
                    completedAt: new Date().toISOString(),
                  };
                  nextWizard = normalizeWizardState({
                    ...nextWizard,
                    execution: {
                      ...nextWizard.execution,
                      steps,
                    },
                  });
                  nextWizard = appendWizardExecutionLog(nextWizard, "wizard.execute", `Marked step '${completeStepId}' completed.`);
                } else if (
                  firstIncomplete.mode === "safe-action" &&
                  SAFE_WIZARD_ACTIONS.has(firstIncomplete.actionId) &&
                  workflowTrustsAction({
                    workflow: selectedWorkflow,
                    actionId: firstIncomplete.actionId,
                    hostFingerprint: nextWizard.hostFingerprint,
                  })
                ) {
                  if (typeof runTroubleshootAction !== "function") {
                    throw new Error("Safe troubleshooting runner is unavailable.");
                  }
                  const actionResult = await runTroubleshootAction({
                    actionId: firstIncomplete.actionId,
                    config,
                    environment: contextData.environment,
                    workspaceDir,
                    commandRunner,
                    envPath,
                  });
                  const idx = steps.findIndex((step) => step.id === firstIncomplete.id);
                  if (idx >= 0) {
                    steps[idx] = {
                      ...steps[idx],
                      completed: true,
                      result: JSON.stringify(actionResult || {}, null, 2),
                      completedAt: new Date().toISOString(),
                    };
                  }
                  nextWizard = normalizeWizardState({
                    ...nextWizard,
                    execution: {
                      ...nextWizard.execution,
                      steps,
                    },
                  });
                  nextWizard = appendWizardExecutionLog(
                    nextWizard,
                    "wizard.execute.safe-action",
                    `Auto-ran trusted safe action '${firstIncomplete.actionId}'.`,
                  );
                } else {
                  return res.json({
                    ok: true,
                    awaitingAction: true,
                    requiredStep: firstIncomplete,
                    requiredAction:
                      firstIncomplete.mode === "safe-action" && SAFE_WIZARD_ACTIONS.has(firstIncomplete.actionId)
                        ? describeSafeAction(firstIncomplete.actionId, contextData.troubleshootReport?.safeActions)
                        : null,
                    run: {
                      ...workingRun,
                      wizard: nextWizard,
                    },
                    summary: buildWizardSummary({
                      ...workingRun,
                      wizard: nextWizard,
                    }),
                  });
                }
                const remaining = steps.filter((step) => !step.completed);
                if (remaining.length === 0) {
                  nextWizard = setWizardStep(nextWizard, "completed", "Workflow run completed.");
                  nextWizard = appendWizardExecutionLog(nextWizard, "wizard.complete", "All execution steps completed.");
                  workingRun.status = "completed";
                } else {
                  nextWizard = setWizardStep(nextWizard, "execute_steps", "Continue with next execution step.");
                }
              }
            } else if (nextWizard.currentStep === "completed") {
              nextWizard = appendWizardExecutionLog(nextWizard, "wizard.next", "Workflow already completed.");
            }

            const saved = await saveWizardRun({
              run: workingRun,
              wizard: nextWizard,
              status: workingRun.status || "wizard",
            });
            res.json({
              ok: true,
              run: saved || null,
              summary: buildWizardSummary(saved),
            });
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

        registerApiPost("/assistant/wizard/:runId/run-safe-action", async (req, res) => {
          try {
            const runId = normalizeManagerString(req.params?.runId, "");
            const actionId = normalizeManagerString(req.body?.actionId, "");
            const rememberTrust = parseBooleanLikeBody(req.body?.rememberTrust, false);
            const approved = parseBooleanLikeBody(req.body?.approved, false);
            if (!runId || !actionId) {
              throw new Error("runId and actionId are required.");
            }
            if (!SAFE_WIZARD_ACTIONS.has(actionId)) {
              throw new Error("Unsupported safe action.");
            }
            if (typeof runTroubleshootAction !== "function") {
              throw new Error("Safe troubleshooting runner is unavailable.");
            }

            const config = await readEnvConfig(envPath);
            const { run, wizard, contextData } = await resolveWizardRun({ runId, config });
            if (wizard.currentStep !== "execute_steps") {
              throw new Error("Safe actions can only run during execute_steps.");
            }
            const steps = Array.isArray(wizard?.execution?.steps) ? [...wizard.execution.steps] : [];
            const stepIndex = steps.findIndex((step) => !step.completed && step.mode === "safe-action" && step.actionId === actionId);
            if (stepIndex < 0) {
              throw new Error("No pending execution step matches this safe action.");
            }

            const workflowStore = await readIntelligenceWorkflowStore(workflowStorePath);
            const selectedWorkflow = chooseWorkflowById(workflowStore, wizard.workflowId || run.workflowId || DEFAULT_PHASE0_WORKFLOW_ID);
            const alreadyTrusted = workflowTrustsAction({
              workflow: selectedWorkflow,
              actionId,
              hostFingerprint: wizard.hostFingerprint,
            });
            if (!alreadyTrusted && !approved) {
              return res.json({
                ok: true,
                awaitingApproval: true,
                requiredAction: describeSafeAction(actionId, contextData.troubleshootReport?.safeActions),
                trustScope: "per-workflow-per-host",
              });
            }

            const actionResult = await runTroubleshootAction({
              actionId,
              config,
              environment: contextData.environment,
              workspaceDir,
              commandRunner,
              envPath,
            });
            steps[stepIndex] = {
              ...steps[stepIndex],
              completed: true,
              result: JSON.stringify(actionResult || {}, null, 2),
              completedAt: new Date().toISOString(),
            };

            let nextWizard = normalizeWizardState({
              ...wizard,
              execution: {
                ...wizard.execution,
                steps,
              },
            });
            nextWizard = appendWizardExecutionLog(nextWizard, "wizard.safe-action", `Executed safe action '${actionId}'.`);

            let trustSaved = false;
            if (rememberTrust && selectedWorkflow && !alreadyTrusted) {
              const configObject =
                selectedWorkflow?.config && typeof selectedWorkflow.config === "object" ? { ...selectedWorkflow.config } : {};
              const trustList = normalizeSafeActionTrustList(configObject.safeActionTrust);
              trustList.push({
                actionId,
                hostFingerprint: wizard.hostFingerprint,
                trustedAt: new Date().toISOString(),
                trustedBy: "operator",
              });
              const saveResult = await upsertIntelligenceWorkflow(workflowStorePath, {
                ...selectedWorkflow,
                config: {
                  ...configObject,
                  safeActionTrust: normalizeSafeActionTrustList(trustList),
                },
              });
              trustSaved = Boolean(saveResult?.workflow);
            }

            const remaining = steps.filter((step) => !step.completed);
            if (remaining.length === 0) {
              nextWizard = setWizardStep(nextWizard, "completed", "Workflow run completed.");
              nextWizard = appendWizardExecutionLog(nextWizard, "wizard.complete", "All execution steps completed.");
            } else {
              nextWizard = setWizardStep(nextWizard, "execute_steps", "Continue with next execution step.");
            }

            const saved = await saveWizardRun({
              run: {
                ...run,
                status: remaining.length === 0 ? "completed" : run.status || "wizard",
              },
              wizard: nextWizard,
              status: remaining.length === 0 ? "completed" : run.status || "wizard",
            });

            res.json({
              ok: true,
              run: saved || null,
              summary: buildWizardSummary(saved),
              actionResult,
              trustSaved,
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
