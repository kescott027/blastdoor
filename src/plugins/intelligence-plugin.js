import { createAssistantClient, loadAssistantRuntimeConfig } from "../assistant-client.js";
import path from "node:path";
import crypto from "node:crypto";
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

  const signedTokensEnabled = config.assistantExternalApiSignedTokensEnabled === true;
  const signingSecret = String(config.assistantExternalApiSigningSecret || "").trim();
  if (signedTokensEnabled && !signingSecret) {
    throw new Error("ASSISTANT_EXTERNAL_API_SIGNING_SECRET is required when signed tokens are enabled.");
  }

  const signedTokenTtlSeconds = Number.parseInt(String(config.assistantExternalApiSignedTokenTtlSeconds ?? "900"), 10);
  if (!Number.isInteger(signedTokenTtlSeconds) || signedTokenTtlSeconds < 60 || signedTokenTtlSeconds > 86400) {
    throw new Error("ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS must be between 60 and 86400.");
  }
}

function normalizeExternalAssistantToken(req) {
  const headerToken = String(req.get("x-blastdoor-assistant-token") || req.get("x-assistant-token") || "").trim();
  if (headerToken) {
    return headerToken;
  }
  const authHeader = String(req.get("authorization") || "").trim();
  const bearerPrefix = "bearer ";
  if (authHeader.toLowerCase().startsWith(bearerPrefix)) {
    return authHeader.slice(bearerPrefix.length).trim();
  }
  return "";
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function nowIso() {
  return new Date().toISOString();
}

function toBase64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseBase64UrlJson(value) {
  try {
    return JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function createAgentScopedToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function createScopedTokenRecord({ label = "", expiresAt = "" } = {}) {
  return {
    tokenId: crypto.randomUUID(),
    label: String(label || "").trim() || "Scoped token",
    tokenHash: "",
    createdAt: nowIso(),
    expiresAt: String(expiresAt || "").trim(),
    lastUsedAt: "",
    revokedAt: "",
  };
}

function normalizeAgentExternalAccess(agent) {
  const source = agent && typeof agent === "object" ? agent : {};
  const external = source.externalAccess && typeof source.externalAccess === "object" ? source.externalAccess : {};
  const tokens = Array.isArray(external.tokens)
    ? external.tokens
        .map((entry) => ({
          tokenId: String(entry?.tokenId || "").trim(),
          label: String(entry?.label || "").trim(),
          tokenHash: String(entry?.tokenHash || "").trim(),
          createdAt: String(entry?.createdAt || "").trim(),
          expiresAt: String(entry?.expiresAt || "").trim(),
          lastUsedAt: String(entry?.lastUsedAt || "").trim(),
          revokedAt: String(entry?.revokedAt || "").trim(),
        }))
        .filter((entry) => entry.tokenId && entry.tokenHash)
    : [];
  return {
    enabled: external.enabled !== false,
    tokens,
  };
}

function isScopedTokenActive(tokenMeta) {
  if (!tokenMeta || typeof tokenMeta !== "object") {
    return false;
  }
  if (String(tokenMeta.revokedAt || "").trim()) {
    return false;
  }
  const expiresAt = String(tokenMeta.expiresAt || "").trim();
  if (expiresAt) {
    const expiresEpoch = Date.parse(expiresAt);
    if (Number.isFinite(expiresEpoch) && Date.now() >= expiresEpoch) {
      return false;
    }
  }
  return true;
}

function createSignedAgentToken({ signingSecret, agentId, tokenId, ttlSeconds }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    typ: "blastdoor-assistant-agent",
    aid: String(agentId || "").trim(),
    tid: String(tokenId || "").trim(),
    iat: issuedAt,
    exp: issuedAt + parsePositiveInteger(ttlSeconds, 900),
  };
  const encodedPayload = toBase64UrlJson(payload);
  const signature = crypto.createHmac("sha256", signingSecret).update(encodedPayload).digest("base64url");
  return {
    token: `bdas1.${encodedPayload}.${signature}`,
    payload,
  };
}

function verifySignedAgentToken(token, signingSecret) {
  const raw = String(token || "").trim();
  const match = raw.match(/^bdas1\.([A-Za-z0-9\-_]+)\.([A-Za-z0-9\-_]+)$/);
  if (!match) {
    return { ok: false, reason: "invalid-format" };
  }
  const encodedPayload = match[1];
  const providedSignature = match[2];
  const expectedSignature = crypto.createHmac("sha256", signingSecret).update(encodedPayload).digest("base64url");
  if (!safeEqual(providedSignature, expectedSignature)) {
    return { ok: false, reason: "invalid-signature" };
  }
  const payload = parseBase64UrlJson(encodedPayload);
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "invalid-payload" };
  }
  if (payload.typ !== "blastdoor-assistant-agent" || payload.v !== 1) {
    return { ok: false, reason: "invalid-type" };
  }
  const nowEpoch = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(payload.exp) || nowEpoch >= payload.exp) {
    return { ok: false, reason: "token-expired" };
  }
  return {
    ok: true,
    payload,
  };
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
    ASSISTANT_EXTERNAL_API_ENABLED: String(existing.ASSISTANT_EXTERNAL_API_ENABLED || "false"),
    ASSISTANT_EXTERNAL_API_TOKEN: String(existing.ASSISTANT_EXTERNAL_API_TOKEN || ""),
    ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED: String(existing.ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED || "false"),
    ASSISTANT_EXTERNAL_API_SIGNING_SECRET: String(existing.ASSISTANT_EXTERNAL_API_SIGNING_SECRET || ""),
    ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS: String(existing.ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS || "900"),
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
  const externalAccess = normalizeAgentExternalAccess(source);
  return {
    id: String(source.id || "").trim(),
    name: String(source.name || "").trim(),
    intent: String(source.intent || "").trim(),
    scaffoldCount: Array.isArray(source.scaffoldIds) ? source.scaffoldIds.length : 0,
    approvalRequired: Boolean(source.approvals?.required),
    graphNodes,
    graphEdges,
    graphGates,
    externalApiEnabled: externalAccess.enabled,
    externalTokenCount: externalAccess.tokens.filter((token) => isScopedTokenActive(token)).length,
    updatedAt: String(source.updatedAt || "").trim(),
  };
}

function sanitizeAgentForManager(agent) {
  const source = agent && typeof agent === "object" ? agent : {};
  const externalAccess = normalizeAgentExternalAccess(source);
  return {
    ...source,
    externalAccess: {
      enabled: externalAccess.enabled,
      tokens: externalAccess.tokens.map((token) => ({
        tokenId: token.tokenId,
        label: token.label,
        createdAt: token.createdAt || null,
        expiresAt: token.expiresAt || null,
        lastUsedAt: token.lastUsedAt || null,
        revokedAt: token.revokedAt || null,
        active: isScopedTokenActive(token),
      })),
    },
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
