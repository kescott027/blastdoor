import {
  buildGrimoireWorkflow,
  generateTroubleshootingRecommendation,
  inferEnvironmentConfigurationRecommendations,
  monitorThreatSignals,
} from "./assistant-workflows.js";

function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

function normalizeAssistantProvider(value) {
  const normalized = normalizeString(value, "ollama").toLowerCase();
  if (normalized === "heuristic") {
    return "ollama";
  }
  return normalized || "ollama";
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function computeRetryDelayMs(baseDelayMs, attemptIndex) {
  return Math.min(5000, baseDelayMs * 2 ** Math.max(0, attemptIndex - 1));
}

function normalizeWorkflowType(value) {
  const normalized = normalizeString(value, "").toLowerCase();
  if (
    [
      "config-recommendations",
      "troubleshoot-recommendation",
      "threat-monitor",
      "grimoire",
      "custom",
      "workflow-config-builder",
      "wizard-clarification",
      "wizard-sufficiency",
      "wizard-execution-plan",
    ].includes(normalized)
  ) {
    return normalized;
  }
  return "custom";
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeWizardClarificationQuestions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry, index) => {
      const source = entry && typeof entry === "object" ? entry : {};
      const id = normalizeString(source.id || source.questionId, `q-${index + 1}`);
      const prompt = normalizeString(source.prompt, "");
      const type = normalizeString(source.type, "text");
      const required = source.required !== false;
      const options = Array.isArray(source.options)
        ? source.options.map((option) => normalizeString(option, "")).filter(Boolean).slice(0, 12)
        : [];
      return { id, prompt, type, required, options };
    })
    .filter((entry) => entry.id && entry.prompt);
}

function normalizeWizardClarificationAnswers(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const source = entry && typeof entry === "object" ? entry : {};
      return {
        questionId: normalizeString(source.questionId, ""),
        answer: normalizeString(source.answer, ""),
      };
    })
    .filter((entry) => entry.questionId && entry.answer);
}

function buildWizardClarificationResult({ context = {} } = {}) {
  const threshold = clampInteger(context?.confidenceThreshold, 80, 1, 100);
  const maxRounds = clampInteger(context?.maxRounds, 3, 1, 10);
  const round = clampInteger(context?.round, 1, 1, maxRounds);
  const goal = normalizeString(context?.goal, "");
  const runName = normalizeString(context?.runName, "");
  const existingQuestions = normalizeWizardClarificationQuestions(context?.existingQuestions);
  const answers = normalizeWizardClarificationAnswers(context?.answers);
  const diagnostics = context?.diagnosticsReport && typeof context.diagnosticsReport === "object" ? context.diagnosticsReport : {};
  const envInfo = diagnostics?.environment && typeof diagnostics.environment === "object" ? diagnostics.environment : {};
  const envConfig = diagnostics?.config && typeof diagnostics.config === "object" ? diagnostics.config : {};
  const foundryTarget = normalizeString(envConfig.FOUNDRY_TARGET, "").toLowerCase();
  const isLocalFoundry = foundryTarget.includes("127.0.0.1") || foundryTarget.includes("localhost");
  const tlsEnabled = normalizeString(envConfig.TLS_ENABLED, "false") === "true";
  const hasTlsCert = Boolean(normalizeString(envConfig.TLS_CERT_FILE, ""));
  const hasDomain = Boolean(normalizeString(envConfig.TLS_DOMAIN, "") || normalizeString(envConfig.PUBLIC_BASE_URL, ""));
  const answeredCount = answers.length;
  const answerMap = new Map();
  for (const entry of answers) {
    answerMap.set(entry.questionId, normalizeString(entry.answer, ""));
  }

  function maybePushQuestion(list, question) {
    const id = normalizeString(question?.id, "");
    if (!id) {
      return;
    }
    if (list.some((entry) => entry.id === id)) {
      return;
    }
    list.push({
      id,
      prompt: normalizeString(question?.prompt, ""),
      type: normalizeString(question?.type, "single-choice"),
      required: question?.required !== false,
      options: Array.isArray(question?.options) ? question.options.map((entry) => normalizeString(entry, "")).filter(Boolean) : [],
    });
  }

  let confidence = 35;
  if (runName) {
    confidence += 15;
  }
  if (goal) {
    confidence += 20;
  }
  confidence += Math.min(35, answeredCount * 10);
  confidence = clampInteger(confidence, 35, 0, 100);

  let questions = [];
  if (existingQuestions.length > 0 && round > 1) {
    questions = existingQuestions;
  } else {
    maybePushQuestion(questions, {
      id: "deployment-scope",
      prompt: "Which access scope should this workflow optimize for?",
      type: "single-choice",
      required: true,
      options: ["Local machine only", "Internal LAN users", "Public internet users"],
    });

    maybePushQuestion(questions, {
      id: "tls-objective",
      prompt: "What TLS outcome do you want this workflow to reach?",
      type: "single-choice",
      required: true,
      options: [
        "Set up new Let's Encrypt certificate",
        "Use existing certificate files",
        "TLS is terminated upstream (Caddy/Nginx)",
      ],
    });

    if (envInfo.isWsl) {
      maybePushQuestion(questions, {
        id: "wsl-routing",
        prompt: "Because WSL is detected, should this workflow include Windows portproxy/firewall validation?",
        type: "single-choice",
        required: true,
        options: ["Yes include WSL routing checks", "No skip WSL routing checks"],
      });
      confidence += 5;
    }

    maybePushQuestion(questions, {
      id: "domain-ready",
      prompt: "Is a domain already pointed to this Blastdoor host?",
      type: "single-choice",
      required: true,
      options: hasDomain ? ["Yes", "No", "Not sure"] : ["No", "Yes", "Not sure"],
    });

    maybePushQuestion(questions, {
      id: "foundry-reachability",
      prompt: "How should this workflow validate Foundry target reachability?",
      type: "single-choice",
      required: true,
      options: isLocalFoundry
        ? [
            "Use runtime-local checks only",
            "Validate host/WSL/container network path too",
          ]
        : ["Validate remote endpoint only", "Validate remote endpoint + DNS/TCP checks"],
    });
  }

  if (round >= 2) {
    if (!answerMap.has("rollback-plan")) {
      maybePushQuestion(questions, {
        id: "rollback-plan",
        prompt: "If a step fails, what rollback behavior should the workflow prioritize?",
        type: "single-choice",
        required: true,
        options: [
          "Stop and report only",
          "Revert changed config values",
          "Revert and restart managed services",
        ],
      });
    }
    if (!answerMap.has("maintenance-window")) {
      maybePushQuestion(questions, {
        id: "maintenance-window",
        prompt: "Can this workflow perform restart-required actions now?",
        type: "single-choice",
        required: true,
        options: ["Yes, restarts allowed now", "No, report restart-required steps only"],
      });
    }
  }

  if (tlsEnabled || hasTlsCert) {
    confidence += 10;
  }

  if (answerMap.has("domain-ready")) {
    confidence += 10;
  }

  if (answerMap.has("tls-objective")) {
    confidence += 10;
  }

  const hasOutstandingQuestions = questions.some(
    (question) =>
      question.required &&
      !answers.some((answer) => answer.questionId === question.id && normalizeString(answer.answer, "")),
  );
  const needsMoreInfo = (confidence < threshold || hasOutstandingQuestions) && round < maxRounds;

  return {
    confidence,
    needsMoreInfo,
    questions: questions.slice(0, 5),
    summary: needsMoreInfo
      ? "Specific clarifications are still needed before proceeding."
      : "Clarification appears sufficient for the 80/20 threshold.",
  };
}

function buildWizardSufficiencyResult({ context = {} } = {}) {
  const threshold = clampInteger(context?.confidenceThreshold, 80, 1, 100);
  const current = clampInteger(context?.confidenceCurrent, 0, 0, 100);
  const unansweredRequired = clampInteger(context?.unansweredRequired, 0, 0, 100);
  const readyForEvidence = current >= threshold && unansweredRequired === 0;
  return {
    confidence: current,
    readyForEvidence,
    rationale: readyForEvidence
      ? "Confidence reached threshold and required questions are answered."
      : "More clarification is required before evidence collection.",
  };
}

function buildWizardExecutionPlanResult({ context = {} } = {}) {
  const isWsl = Boolean(context?.environment?.isWsl);
  const steps = [
    {
      id: "review-plan",
      title: "Review scoped objective and guardrails",
      instructions: "Confirm the workflow objective, constraints, and rollback criteria before running commands.",
      mode: "manual",
      completionCriteria: "Operator confirms objective and constraints are correct.",
    },
    {
      id: "collect-runtime",
      title: "Collect runtime network and health snapshot",
      instructions: "Run the safe diagnostic action and attach results to this workflow run.",
      mode: "safe-action",
      actionId: isWsl ? "detect.wsl-portproxy" : "snapshot.network",
      completionCriteria: "Diagnostic output is collected and attached.",
    },
    {
      id: "validate-gateway",
      title: "Validate gateway reachability and summarize findings",
      instructions:
        "Run gateway checks, compare against expected state, and capture any deviations with recommended next actions.",
      mode: "safe-action",
      actionId: "check.gateway-local",
      completionCriteria: "Gateway check results are captured and interpreted.",
    },
  ];
  return {
    steps,
    completionCriteria: "All execution steps are completed and findings are logged.",
  };
}

function inferWorkflowTypeFromDescription(description = "") {
  const text = normalizeString(description, "").toLowerCase();
  if (!text) {
    return "custom";
  }
  if (text.includes("troubleshoot") || text.includes("error") || text.includes("diagnostic")) {
    return "troubleshoot-recommendation";
  }
  if (text.includes("threat") || text.includes("attack") || text.includes("lockdown")) {
    return "threat-monitor";
  }
  if (text.includes("api") || text.includes("automation") || text.includes("workflow chain")) {
    return "grimoire";
  }
  if (text.includes("config") || text.includes("configure") || text.includes("environment")) {
    return "config-recommendations";
  }
  return "custom";
}

function buildWorkflowConfigSuggestionFromDescription(description = "") {
  const normalizedDescription = normalizeString(description, "");
  const type = inferWorkflowTypeFromDescription(normalizedDescription);
  const suggestedName = normalizedDescription
    ? normalizedDescription
        .replace(/\s+/g, " ")
        .split(" ")
        .slice(0, 5)
        .join(" ")
    : "Custom Workflow";

  const seedByType = {
    "config-recommendations":
      "Ask for environment recommendations or describe deployment constraints for suggested defaults.",
    "troubleshoot-recommendation":
      "Paste error logs, request IDs, and symptoms. I will return prioritized troubleshooting steps.",
    "threat-monitor":
      "Ask for a threat scan of logs or suspicious behavior; I will return risk and mitigation steps.",
    grimoire: "Describe the API workflow intent and I will produce execution blocks with safety checks.",
    custom: "Describe the task and include any constraints, data sources, and desired output format.",
  };

  return {
    name: suggestedName || "Custom Workflow",
    type,
    description:
      normalizedDescription ||
      "Custom Blastdoor workflow generated from operator intent. Review and tune prompts before production use.",
    systemPrompt: `You are Blastdoor workflow assistant for '${suggestedName || "Custom Workflow"}'. Keep responses concise and operationally safe.`,
    seedPrompt: seedByType[type] || seedByType.custom,
    inputPlaceholder: "Provide request details, context, and constraints.",
    ragEnabled: type === "troubleshoot-recommendation",
    allowWebSearch: false,
    autoLockOnThreat: type === "threat-monitor",
    threatScoreThreshold: type === "threat-monitor" ? 80 : 80,
    config: {},
  };
}

function withTimeoutController(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timeout);
    },
  };
}

async function parseJsonBody(response) {
  const raw = await response.text();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { error: raw.slice(0, 500) };
  }
}

async function maybeGenerateOllamaNarrative(config, prompt) {
  if (normalizeAssistantProvider(config.assistantProvider) !== "ollama") {
    return "";
  }

  const ollamaUrl = normalizeString(config.assistantOllamaUrl, "http://127.0.0.1:11434").replace(/\/+$/, "");
  const ollamaModel = normalizeString(config.assistantOllamaModel, "llama3.1:8b");
  if (!ollamaUrl || !ollamaModel || !prompt) {
    return "";
  }

  const timeoutMs = toPositiveInteger(config.assistantTimeoutMs, 6000);
  const { signal, clear } = withTimeoutController(timeoutMs);
  try {
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        stream: false,
      }),
      signal,
    });

    if (!response.ok) {
      return "";
    }
    const payload = await parseJsonBody(response);
    return normalizeString(payload?.response, "");
  } catch {
    return "";
  } finally {
    clear();
  }
}

export function loadAssistantRuntimeConfig(env = process.env) {
  return {
    assistantEnabled: parseBoolean(env.ASSISTANT_ENABLED, true),
    assistantUrl: normalizeString(env.ASSISTANT_URL, ""),
    assistantToken: normalizeString(env.ASSISTANT_TOKEN, ""),
    assistantProvider: normalizeAssistantProvider(env.ASSISTANT_PROVIDER),
    assistantOllamaUrl: normalizeString(env.ASSISTANT_OLLAMA_URL, "http://127.0.0.1:11434"),
    assistantOllamaModel: normalizeString(env.ASSISTANT_OLLAMA_MODEL, "llama3.1:8b"),
    assistantTimeoutMs: toPositiveInteger(env.ASSISTANT_TIMEOUT_MS, 6000),
    assistantRetryMaxAttempts: toPositiveInteger(env.ASSISTANT_RETRY_MAX_ATTEMPTS, 2),
    assistantRagEnabled: parseBoolean(env.ASSISTANT_RAG_ENABLED, false),
    assistantAllowWebSearch: parseBoolean(env.ASSISTANT_ALLOW_WEB_SEARCH, false),
    assistantAutoLockOnThreat: parseBoolean(env.ASSISTANT_AUTO_LOCK_ON_THREAT, false),
    assistantThreatScoreThreshold: toPositiveInteger(env.ASSISTANT_THREAT_SCORE_THRESHOLD, 80),
    assistantExternalApiEnabled: parseBoolean(env.ASSISTANT_EXTERNAL_API_ENABLED, false),
    assistantExternalApiToken: normalizeString(env.ASSISTANT_EXTERNAL_API_TOKEN, ""),
    assistantExternalApiSignedTokensEnabled: parseBoolean(env.ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED, false),
    assistantExternalApiSigningSecret: normalizeString(env.ASSISTANT_EXTERNAL_API_SIGNING_SECRET, ""),
    assistantExternalApiSignedTokenTtlSeconds: toPositiveInteger(env.ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS, 900),
  };
}

function createDisabledAssistantClient() {
  const disabledResponse = (workflowId) => ({
    workflowId,
    generatedAt: new Date().toISOString(),
    disabled: true,
    message: "Assistant is disabled (ASSISTANT_ENABLED=false).",
  });

  return {
    async getStatus() {
      return {
        enabled: false,
        mode: "disabled",
      };
    },
    async runConfigRecommendations() {
      return disabledResponse("environment-inferred-configuration-recommendations");
    },
    async runTroubleshootRecommendation() {
      return disabledResponse("error-troubleshooting-recommendation");
    },
    async runThreatMonitor() {
      return disabledResponse("threat-monitoring-and-lockdown");
    },
    async runGrimoireWorkflow() {
      return disabledResponse("grimoire-api-intent-block-builder");
    },
    async runWorkflowChat(payload = {}) {
      const workflow = payload?.workflow && typeof payload.workflow === "object" ? payload.workflow : {};
      const workflowType = normalizeWorkflowType(workflow?.type || "");
      return {
        ...disabledResponse("workflow-chat"),
        workflowId: normalizeString(workflow.id, "workflow-chat"),
        workflowType,
        reply: "Assistant is disabled (ASSISTANT_ENABLED=false).",
      };
    },
    async close() {},
  };
}

function createLocalAssistantClient(config) {
  async function runWorkflowChat(payload = {}) {
    const workflow = payload?.workflow && typeof payload.workflow === "object" ? payload.workflow : {};
    const message = normalizeString(payload?.message, "");
    const workflowType = normalizeWorkflowType(workflow?.type || "");
    const workflowId = normalizeString(workflow?.id, workflowType || "workflow-chat");
    const context = payload?.context && typeof payload.context === "object" ? payload.context : {};

    if (workflowType === "workflow-config-builder") {
      const suggestion = buildWorkflowConfigSuggestionFromDescription(message);
      const result = {
        workflowId,
        workflowType,
        generatedAt: new Date().toISOString(),
        summary: "Generated workflow configuration suggestion from intent.",
        suggestedWorkflow: suggestion,
      };
      const narrative = await maybeGenerateOllamaNarrative(
        config,
        [
          "You are Blastdoor assistant.",
          "Refine this generated workflow configuration suggestion into operator-ready guidance.",
          JSON.stringify(result, null, 2),
        ].join("\n"),
      );
      if (narrative) {
        result.assistantNarrative = narrative;
      }
      return {
        ...result,
        reply:
          narrative ||
          `Suggested workflow '${suggestion.name}' (${suggestion.type}). Review prompts and save to activate this workflow.`,
      };
    }

    if (workflowType === "config-recommendations") {
      const result = inferEnvironmentConfigurationRecommendations({
        diagnosticsReport: context.diagnosticsReport || payload?.diagnosticsReport || {},
        installationConfig: context.installationConfig || payload?.installationConfig || {},
      });
      return {
        workflowId,
        workflowType,
        generatedAt: new Date().toISOString(),
        result,
        reply:
          result.assistantNarrative ||
          result.summary ||
          "Configuration recommendations generated. Review the structured recommendations.",
      };
    }

    if (workflowType === "troubleshoot-recommendation") {
      const result = await generateTroubleshootingRecommendation(
        {
          errorText: message || normalizeString(context.errorText, ""),
          diagnosticsReport: context.diagnosticsReport || payload?.diagnosticsReport || {},
          troubleshootReport: context.troubleshootReport || payload?.troubleshootReport || {},
        },
        {
          ragEnabled: Boolean(workflow?.ragEnabled ?? config.assistantRagEnabled),
          allowWebSearch: Boolean(workflow?.allowWebSearch ?? config.assistantAllowWebSearch),
        },
      );
      return {
        workflowId,
        workflowType,
        generatedAt: new Date().toISOString(),
        result,
        reply:
          result.assistantNarrative ||
          result.summary ||
          "Troubleshooting recommendations generated. Follow actions in priority order.",
      };
    }

    if (workflowType === "threat-monitor") {
      const threshold =
        payload?.threatScoreThreshold ??
        workflow?.threatScoreThreshold ??
        context?.threatScoreThreshold ??
        config.assistantThreatScoreThreshold;
      const result = monitorThreatSignals({
        logLines: Array.isArray(context.logLines) ? context.logLines : Array.isArray(payload?.logLines) ? payload.logLines : [],
        blastDoorsClosed: Boolean(context.blastDoorsClosed ?? payload?.blastDoorsClosed ?? false),
        threatScoreThreshold: threshold,
      });
      return {
        workflowId,
        workflowType,
        generatedAt: new Date().toISOString(),
        result,
        shouldLockdown: Boolean(result?.shouldLockdown),
        reply:
          result.summary ||
          `Threat score ${result.threatScore || 0} analyzed${result.shouldLockdown ? "; lockdown recommended." : "."}`,
      };
    }

    if (workflowType === "grimoire") {
      const result = buildGrimoireWorkflow({
        intent: message,
        apiDocs: Array.isArray(context.apiDocs) ? context.apiDocs : Array.isArray(payload?.apiDocs) ? payload.apiDocs : [],
      });
      return {
        workflowId,
        workflowType,
        generatedAt: new Date().toISOString(),
        result,
        reply:
          result.assistantNarrative ||
          result.summary ||
          "Grimoire generated an API block chain for the provided intent.",
      };
    }

    if (workflowType === "wizard-clarification") {
      const result = buildWizardClarificationResult({ context });
      return {
        workflowId,
        workflowType,
        generatedAt: new Date().toISOString(),
        result,
        reply: result.summary,
      };
    }

    if (workflowType === "wizard-sufficiency") {
      const result = buildWizardSufficiencyResult({ context });
      return {
        workflowId,
        workflowType,
        generatedAt: new Date().toISOString(),
        result,
        reply: result.rationale,
      };
    }

    if (workflowType === "wizard-execution-plan") {
      const result = buildWizardExecutionPlanResult({ context });
      return {
        workflowId,
        workflowType,
        generatedAt: new Date().toISOString(),
        result,
        reply: "Execution plan generated.",
      };
    }

    const customPrompt = [
      normalizeString(workflow?.systemPrompt, ""),
      normalizeString(workflow?.seedPrompt, ""),
      `Workflow Name: ${normalizeString(workflow?.name, workflowId || "Custom Workflow")}`,
      `Operator Message: ${message || "(none)"}`,
      Object.keys(context || {}).length > 0 ? `Context:\n${JSON.stringify(context, null, 2)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const narrative = await maybeGenerateOllamaNarrative(config, customPrompt);

    return {
      workflowId,
      workflowType,
      generatedAt: new Date().toISOString(),
      reply:
        narrative ||
        "Custom workflow received your request. Ensure Ollama is reachable and tune system/seed prompts for richer responses.",
      result: {
        workflowId,
        workflowType,
        message,
      },
    };
  }

  return {
    async getStatus() {
      return {
        enabled: true,
        mode: "local",
        provider: normalizeAssistantProvider(config.assistantProvider),
        ragEnabled: Boolean(config.assistantRagEnabled),
        allowWebSearch: Boolean(config.assistantAllowWebSearch),
      };
    },

    async runConfigRecommendations(payload = {}) {
      const result = inferEnvironmentConfigurationRecommendations(payload);
      const narrative = await maybeGenerateOllamaNarrative(
        config,
        [
          "You are Blastdoor assistant.",
          "Summarize the following config recommendations into concise operator instructions:",
          JSON.stringify(result, null, 2),
        ].join("\n"),
      );
      if (narrative) {
        result.assistantNarrative = narrative;
      }
      return result;
    },

    async runTroubleshootRecommendation(payload = {}) {
      const result = await generateTroubleshootingRecommendation(payload, {
        ragEnabled: config.assistantRagEnabled,
        allowWebSearch: config.assistantAllowWebSearch,
      });
      const narrative = await maybeGenerateOllamaNarrative(
        config,
        [
          "You are Blastdoor assistant.",
          "Summarize this troubleshooting plan into ordered remediation steps.",
          JSON.stringify(result, null, 2),
        ].join("\n"),
      );
      if (narrative) {
        result.assistantNarrative = narrative;
      }
      return result;
    },

    async runThreatMonitor(payload = {}) {
      return monitorThreatSignals({
        ...payload,
        threatScoreThreshold:
          payload?.threatScoreThreshold !== undefined
            ? payload.threatScoreThreshold
            : config.assistantThreatScoreThreshold,
      });
    },

    async runGrimoireWorkflow(payload = {}) {
      const result = buildGrimoireWorkflow(payload);
      const narrative = await maybeGenerateOllamaNarrative(
        config,
        [
          "You are Blastdoor assistant.",
          "Explain this API block chain in plain language with operator checks.",
          JSON.stringify(result, null, 2),
        ].join("\n"),
      );
      if (narrative) {
        result.assistantNarrative = narrative;
      }
      return result;
    },

    async runWorkflowChat(payload = {}) {
      return await runWorkflowChat(payload);
    },

    async close() {},
  };
}

function createRemoteAssistantClient(config) {
  const baseUrl = normalizeString(config.assistantUrl, "").replace(/\/+$/, "");
  const token = normalizeString(config.assistantToken, "");
  const timeoutMs = toPositiveInteger(config.assistantTimeoutMs, 6000);
  const retryMaxAttempts = toPositiveInteger(config.assistantRetryMaxAttempts, 2);
  const retryBaseDelayMs = 150;

  async function request(pathname, payload = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= retryMaxAttempts; attempt += 1) {
      const { signal, clear } = withTimeoutController(timeoutMs);
      try {
        const response = await fetch(`${baseUrl}${pathname}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { "x-assistant-token": token } : {}),
          },
          body: JSON.stringify(payload || {}),
          signal,
        });

        const body = await parseJsonBody(response);
        if (!response.ok) {
          lastError = new Error(body?.error || `Assistant request failed with HTTP ${response.status}.`);
          if (attempt < retryMaxAttempts && [408, 429, 500, 502, 503, 504].includes(response.status)) {
            await new Promise((resolve) => {
              setTimeout(resolve, computeRetryDelayMs(retryBaseDelayMs, attempt));
            });
            continue;
          }
          throw lastError;
        }

        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < retryMaxAttempts) {
          await new Promise((resolve) => {
            setTimeout(resolve, computeRetryDelayMs(retryBaseDelayMs, attempt));
          });
          continue;
        }
        throw lastError;
      } finally {
        clear();
      }
    }

    throw lastError || new Error("Assistant request failed.");
  }

  return {
    async getStatus() {
      const response = await request("/v1/status", {});
      return response.status || {};
    },
    async runConfigRecommendations(payload = {}) {
      const response = await request("/v1/workflows/config-recommendations", payload);
      return response.result || {};
    },
    async runTroubleshootRecommendation(payload = {}) {
      const response = await request("/v1/workflows/troubleshoot-recommendation", payload);
      return response.result || {};
    },
    async runThreatMonitor(payload = {}) {
      const response = await request("/v1/workflows/threat-monitor", payload);
      return response.result || {};
    },
    async runGrimoireWorkflow(payload = {}) {
      const response = await request("/v1/workflows/grimoire", payload);
      return response.result || {};
    },
    async runWorkflowChat(payload = {}) {
      const response = await request("/v1/workflows/chat", payload);
      return response.result || {};
    },
    async close() {},
  };
}

export function createAssistantClient(options = {}) {
  const rawConfig = {
    ...loadAssistantRuntimeConfig(options.env || process.env),
    ...(options.config && typeof options.config === "object" ? options.config : {}),
  };
  const config = {
    ...rawConfig,
    assistantProvider: normalizeAssistantProvider(rawConfig.assistantProvider),
  };

  if (!config.assistantEnabled) {
    return createDisabledAssistantClient();
  }

  const forceLocal = options.forceLocal === true;
  if (!forceLocal && normalizeString(config.assistantUrl, "")) {
    return createRemoteAssistantClient(config);
  }
  return createLocalAssistantClient(config);
}
