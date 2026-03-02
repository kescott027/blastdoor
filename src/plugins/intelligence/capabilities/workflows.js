import {
  deleteIntelligenceWorkflow,
  readIntelligenceWorkflowStore,
  summarizeWorkflowForList,
  upsertIntelligenceWorkflow,
} from "../../../intelligence-workflow-store.js";
import { makeApiDocSnapshot, normalizeAssistantProvider } from "../helpers.js";

export function registerIntelligenceWorkflowRoutes(context) {
  const {
    registerApiGet,
    registerApiPost,
    readEnvConfig,
    withBlastdoorApi,
    processState,
    workspaceDir,
    envPath,
    tailFile,
    parseBooleanLike,
    parseBooleanLikeBody,
    normalizeManagerString,
    applyThreatLockdown,
    CONFIG_DEFAULTS,
    workflowStorePath,
    DEFAULT_PHASE0_WORKFLOW_ID,
    buildAssistantContext,
  } = context;

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
      const contextData = await buildAssistantContext(config);
      const result = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.runConfigRecommendations({
          diagnosticsReport: contextData.diagnosticsReport,
          installationConfig: contextData.installationConfig || {},
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
      const contextData = await buildAssistantContext(config);

      const result = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.runTroubleshootRecommendation({
          errorText: normalizeManagerString(req.body?.errorText, ""),
          diagnosticsReport: contextData.diagnosticsReport,
          troubleshootReport: contextData.troubleshootReport,
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
      const debugPath = `${workspaceDir}/${config.DEBUG_LOG_FILE || CONFIG_DEFAULTS.DEBUG_LOG_FILE}`;
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
        workflowStore.workflows.find((workflow) => workflow.id === DEFAULT_PHASE0_WORKFLOW_ID) ||
        null;
      if (!selectedWorkflow) {
        throw new Error("No workflow is available to run.");
      }

      const config = await readEnvConfig(envPath);
      const contextData = await buildAssistantContext(config);
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
            diagnosticsReport: contextData.diagnosticsReport,
            troubleshootReport: contextData.troubleshootReport,
            installationConfig: contextData.installationConfig || {},
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
}
