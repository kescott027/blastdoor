import { createAssistantClient, loadAssistantRuntimeConfig } from "../assistant-client.js";
import path from "node:path";
import { readInstallationConfig } from "../installation-config.js";
import {
  deleteIntelligenceWorkflow,
  readIntelligenceWorkflowStore,
  summarizeWorkflowForList,
  upsertIntelligenceWorkflow,
} from "../intelligence-workflow-store.js";

function validateAssistantConfig(config) {
  const assistantProvider = String(config.assistantProvider || "heuristic").toLowerCase();
  if (!["heuristic", "ollama"].includes(assistantProvider)) {
    throw new Error("ASSISTANT_PROVIDER must be one of: heuristic, ollama.");
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
    ASSISTANT_PROVIDER: String(existing.ASSISTANT_PROVIDER || "heuristic"),
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
        ASSISTANT_PROVIDER: "heuristic",
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
          `Assistant: ${config.ASSISTANT_ENABLED === "true" ? "enabled" : "disabled"} (${config.ASSISTANT_PROVIDER || "heuristic"})`,
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
          ASSISTANT_PROVIDER: String(config.assistantProvider || "heuristic"),
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

        const previousClose = api.close;
        api.close = async () => {
          if (typeof previousClose === "function") {
            await previousClose();
          }
          if (typeof assistantClient?.close === "function") {
            await assistantClient.close();
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
                  config.ASSISTANT_PROVIDER,
                  CONFIG_DEFAULTS.ASSISTANT_PROVIDER,
                ),
                ASSISTANT_URL: normalizeManagerString(config.ASSISTANT_URL, CONFIG_DEFAULTS.ASSISTANT_URL),
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
