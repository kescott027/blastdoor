import crypto from "node:crypto";
import { safeEqual } from "../../security.js";

export function normalizeManagerString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

export function normalizeAssistantProvider(value) {
  const normalized = String(value || "ollama").trim().toLowerCase();
  if (normalized === "heuristic") {
    return "ollama";
  }
  return normalized || "ollama";
}

export function validateAssistantConfig(config) {
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

export function normalizeExternalAssistantToken(req) {
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

export function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function nowIso() {
  return new Date().toISOString();
}

export function toBase64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function parseBase64UrlJson(value) {
  try {
    return JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function createAgentScopedToken() {
  return crypto.randomBytes(24).toString("base64url");
}

export function createScopedTokenRecord({ label = "", expiresAt = "" } = {}) {
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

export function normalizeAgentExternalAccess(agent) {
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

export function isScopedTokenActive(tokenMeta) {
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

export function createSignedAgentToken({ signingSecret, agentId, tokenId, ttlSeconds }) {
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

export function verifySignedAgentToken(token, signingSecret) {
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

export function ensureIntelligenceNamespace(api) {
  if (!api.plugins || typeof api.plugins !== "object") {
    api.plugins = {};
  }
  if (!api.plugins.intelligence || typeof api.plugins.intelligence !== "object") {
    api.plugins.intelligence = {};
  }
  return api.plugins.intelligence;
}

export function getIntelligenceEnvFieldDefaults({ forDocker = false, existing = {} } = {}) {
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

export function makeApiDocSnapshot() {
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
    "GET /api/assistant/wizard/runs",
    "POST /api/assistant/wizard/start",
    "GET /api/assistant/wizard/:runId",
    "POST /api/assistant/wizard/:runId/next",
    "POST /api/assistant/wizard/:runId/back",
    "POST /api/assistant/wizard/:runId/save",
    "POST /api/assistant/wizard/:runId/answer",
    "POST /api/assistant/wizard/:runId/run-safe-action",
  ];
}

export function parseEmbeddedJsonObject(rawText) {
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

export function normalizePlanSteps(value) {
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

export function derivePlanLayerFromChatResult(chatResult, { goal = "", fallbackSummary = "" } = {}) {
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

export function chooseWorkflowById(workflowStore, workflowId) {
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

export const WIZARD_STEP_SEQUENCE = [
  "define_name",
  "define_goal",
  "create_initial_plan",
  "clarify_round",
  "sufficiency_gate",
  "collect_evidence",
  "refine_layer",
  "execution_prep",
  "execute_steps",
  "completed",
];

export const SAFE_WIZARD_ACTIONS = new Set(["snapshot.network", "check.gateway-local", "detect.wsl-portproxy"]);

export function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function createWizardHostFingerprint({ environment = {}, config = {} } = {}) {
  const payload = JSON.stringify({
    platform: environment.platform || "",
    arch: environment.arch || "",
    hostname: environment.hostname || "",
    managerHost: environment.managerHost || "",
    managerPort: environment.managerPort || "",
    isWsl: Boolean(environment.isWsl),
    wslDistro: environment.wslDistro || "",
    host: config.HOST || "",
    port: config.PORT || "",
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

export function normalizeWizardQuestionList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry, index) => {
      const source = entry && typeof entry === "object" ? entry : {};
      return {
        id: normalizeManagerString(source.id || source.questionId, `q-${index + 1}`),
        prompt: normalizeManagerString(source.prompt, ""),
        type: normalizeManagerString(source.type, "text"),
        required: source.required !== false,
        options: Array.isArray(source.options)
          ? source.options.map((option) => normalizeManagerString(option, "")).filter(Boolean).slice(0, 20)
          : [],
      };
    })
    .filter((entry) => entry.id && entry.prompt);
}

export function normalizeWizardAnswerList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const source = entry && typeof entry === "object" ? entry : {};
      return {
        questionId: normalizeManagerString(source.questionId, ""),
        answer: normalizeManagerString(source.answer, ""),
        answeredAt: normalizeManagerString(source.answeredAt, new Date().toISOString()),
      };
    })
    .filter((entry) => entry.questionId);
}

export function normalizeWizardExecutionSteps(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry, index) => {
      const source = entry && typeof entry === "object" ? entry : {};
      const mode = normalizeManagerString(source.mode, "manual");
      return {
        id: normalizeManagerString(source.id, `step-${index + 1}`),
        title: normalizeManagerString(source.title, `Step ${index + 1}`),
        instructions: normalizeManagerString(source.instructions, ""),
        mode: ["manual", "safe-action", "manual-risky"].includes(mode) ? mode : "manual",
        actionId: normalizeManagerString(source.actionId, ""),
        completionCriteria: normalizeManagerString(source.completionCriteria, ""),
        completed: source.completed === true,
        result: normalizeManagerString(source.result, ""),
        completedAt: normalizeManagerString(source.completedAt, ""),
      };
    })
    .filter((entry) => entry.id && entry.title);
}

export function normalizeWizardExecutionLogs(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const source = entry && typeof entry === "object" ? entry : {};
      return {
        ts: normalizeManagerString(source.ts, new Date().toISOString()),
        event: normalizeManagerString(source.event, ""),
        detail: normalizeManagerString(source.detail, ""),
      };
    })
    .filter((entry) => entry.event);
}

export function normalizeWizardState(input = {}, defaults = {}) {
  const source = input && typeof input === "object" ? input : {};
  const defaultStep = WIZARD_STEP_SEQUENCE.includes(defaults?.currentStep) ? defaults.currentStep : "define_name";
  const currentStep = normalizeManagerString(source.currentStep || source.state, defaultStep);
  const resolvedStep = WIZARD_STEP_SEQUENCE.includes(currentStep) ? currentStep : defaultStep;
  const completedStepsRaw = Array.isArray(source.completedSteps)
    ? source.completedSteps.map((entry) => normalizeManagerString(entry, "")).filter((entry) => WIZARD_STEP_SEQUENCE.includes(entry))
    : [];
  const completedSteps = [];
  for (const step of completedStepsRaw) {
    if (!completedSteps.includes(step)) {
      completedSteps.push(step);
    }
  }
  return {
    version: 1,
    state: resolvedStep,
    currentStep: resolvedStep,
    completedSteps,
    nextPrompt: normalizeManagerString(source.nextPrompt, defaults?.nextPrompt || ""),
    confidence: {
      current: clampInteger(source?.confidence?.current, defaults?.confidence?.current ?? 0, 0, 100),
      threshold: clampInteger(source?.confidence?.threshold, defaults?.confidence?.threshold ?? 80, 1, 100),
    },
    clarification: {
      round: clampInteger(source?.clarification?.round, defaults?.clarification?.round ?? 0, 0, 32),
      questions: normalizeWizardQuestionList(source?.clarification?.questions ?? defaults?.clarification?.questions),
      answers: normalizeWizardAnswerList(source?.clarification?.answers ?? defaults?.clarification?.answers),
    },
    execution: {
      steps: normalizeWizardExecutionSteps(source?.execution?.steps ?? defaults?.execution?.steps),
      logs: normalizeWizardExecutionLogs(source?.execution?.logs ?? defaults?.execution?.logs),
    },
    lastSavedAt: normalizeManagerString(source.lastSavedAt, defaults?.lastSavedAt || new Date().toISOString()),
    hostFingerprint: normalizeManagerString(source.hostFingerprint, defaults?.hostFingerprint || ""),
    workflowId: normalizeManagerString(source.workflowId, defaults?.workflowId || "troubleshoot-recommendation"),
  };
}

export function createDefaultWizardState({ workflowId, hostFingerprint, runName = "" } = {}) {
  return normalizeWizardState(
    {
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
      hostFingerprint,
      workflowId,
    },
    {
      currentStep: "define_name",
      nextPrompt: runName ? "Review workflow name and click Next." : "Enter workflow name, then click Next.",
      workflowId,
      hostFingerprint,
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
    },
  );
}

export function getWizardStateForRun(run, fallbackDefaults = {}) {
  const sourceRun = run && typeof run === "object" ? run : {};
  return normalizeWizardState(sourceRun.wizard, fallbackDefaults);
}

export function setWizardStep(wizard, step, prompt = "") {
  const nextStep = WIZARD_STEP_SEQUENCE.includes(step) ? step : wizard.currentStep;
  const completedSteps = Array.isArray(wizard.completedSteps) ? [...wizard.completedSteps] : [];
  const currentIndex = WIZARD_STEP_SEQUENCE.indexOf(wizard.currentStep);
  const nextIndex = WIZARD_STEP_SEQUENCE.indexOf(nextStep);
  if (currentIndex >= 0 && nextIndex > currentIndex) {
    for (const candidate of WIZARD_STEP_SEQUENCE.slice(0, nextIndex)) {
      if (!completedSteps.includes(candidate)) {
        completedSteps.push(candidate);
      }
    }
  }
  return normalizeWizardState({
    ...wizard,
    state: nextStep,
    currentStep: nextStep,
    completedSteps,
    nextPrompt: prompt || wizard.nextPrompt,
    lastSavedAt: new Date().toISOString(),
  });
}

export function buildWizardSummary(run) {
  const sourceRun = run && typeof run === "object" ? run : {};
  const wizard = getWizardStateForRun(sourceRun);
  return {
    runId: normalizeManagerString(sourceRun.runId, ""),
    runName: normalizeManagerString(sourceRun?.meta?.runName, ""),
    goal: normalizeManagerString(sourceRun.goal, ""),
    status: normalizeManagerString(sourceRun.status, ""),
    workflowId: normalizeManagerString(sourceRun.workflowId, ""),
    createdAt: normalizeManagerString(sourceRun.createdAt, ""),
    updatedAt: normalizeManagerString(sourceRun.updatedAt, ""),
    wizard: {
      state: wizard.state,
      currentStep: wizard.currentStep,
      completedSteps: wizard.completedSteps,
      nextPrompt: wizard.nextPrompt,
      confidence: wizard.confidence,
      clarificationRound: wizard.clarification.round,
      unresolvedQuestions: wizard.clarification.questions.filter((question) => {
        if (!question.required) {
          return false;
        }
        return !wizard.clarification.answers.some(
          (answer) => answer.questionId === question.id && normalizeManagerString(answer.answer, ""),
        );
      }).length,
    },
  };
}

export function parseClarificationContract(result = {}) {
  const source = result && typeof result === "object" ? result : {};
  const questions = normalizeWizardQuestionList(source.questions);
  const confidence = clampInteger(source.confidence, 0, 0, 100);
  const needsMoreInfo = source.needsMoreInfo === true;
  const summary = normalizeManagerString(source.summary, needsMoreInfo ? "More clarification is required." : "");
  return {
    confidence,
    needsMoreInfo,
    questions: questions.slice(0, 5),
    summary,
  };
}

export function parseSufficiencyContract(result = {}) {
  const source = result && typeof result === "object" ? result : {};
  return {
    confidence: clampInteger(source.confidence, 0, 0, 100),
    readyForEvidence: source.readyForEvidence === true,
    rationale: normalizeManagerString(source.rationale, ""),
  };
}

export function parseExecutionPlanContract(result = {}) {
  const source = result && typeof result === "object" ? result : {};
  const steps = normalizeWizardExecutionSteps(source.steps).map((entry) => {
    if (entry.mode === "safe-action" && !SAFE_WIZARD_ACTIONS.has(entry.actionId)) {
      return {
        ...entry,
        mode: "manual",
        actionId: "",
      };
    }
    return entry;
  });
  return {
    steps,
    completionCriteria: normalizeManagerString(source.completionCriteria, ""),
  };
}

export function normalizeSafeActionTrustList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    const source = entry && typeof entry === "object" ? entry : {};
    const actionId = normalizeManagerString(source.actionId, "");
    const hostFingerprint = normalizeManagerString(source.hostFingerprint, "");
    if (!actionId || !hostFingerprint) {
      continue;
    }
    const key = `${actionId}::${hostFingerprint}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      actionId,
      hostFingerprint,
      trustedAt: normalizeManagerString(source.trustedAt, new Date().toISOString()),
      trustedBy: normalizeManagerString(source.trustedBy, "operator"),
    });
  }
  return out;
}

export function workflowTrustsAction({ workflow, actionId, hostFingerprint }) {
  const config = workflow?.config && typeof workflow.config === "object" ? workflow.config : {};
  const trustList = normalizeSafeActionTrustList(config.safeActionTrust);
  return trustList.some((entry) => entry.actionId === actionId && entry.hostFingerprint === hostFingerprint);
}

export function summarizeAgentForList(agent) {
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

export function sanitizeAgentForManager(agent) {
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

