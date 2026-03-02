export const DEFAULTS = {
  ASSISTANT_ENABLED: "true",
  ASSISTANT_PROVIDER: "ollama",
  ASSISTANT_URL: "",
  ASSISTANT_TOKEN: "",
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
};

export const WIZARD_STEPS = [
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

export function normalizeAssistantProvider(value) {
  const normalized = asString(value, DEFAULTS.ASSISTANT_PROVIDER).trim().toLowerCase();
  return normalized === "ollama" ? "ollama" : "ollama";
}

export function asString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
}

export function asBooleanString(value, fallback = "false") {
  const normalized = asString(value, fallback).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized) ? "true" : "false";
}

export function asIntegerString(value, fallback) {
  const parsed = Number.parseInt(asString(value, ""), 10);
  if (!Number.isInteger(parsed)) {
    return String(fallback);
  }
  return String(parsed);
}

export function slugifyName(name) {
  return asString(name, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
}

export function toConfigPatch(state) {
  return {
    ASSISTANT_ENABLED: state.assistantEnabled.checked ? "true" : "false",
    ASSISTANT_PROVIDER: normalizeAssistantProvider(state.assistantProvider.value),
    ASSISTANT_URL: asString(state.assistantUrl.value, "").trim(),
    ASSISTANT_TOKEN: asString(state.assistantToken.value, ""),
    ASSISTANT_OLLAMA_URL: asString(state.assistantOllamaUrl.value, DEFAULTS.ASSISTANT_OLLAMA_URL).trim(),
    ASSISTANT_OLLAMA_MODEL: asString(state.assistantOllamaModel.value, DEFAULTS.ASSISTANT_OLLAMA_MODEL).trim(),
    ASSISTANT_TIMEOUT_MS: asIntegerString(state.assistantTimeoutMs.value, 6000),
    ASSISTANT_RETRY_MAX_ATTEMPTS: asIntegerString(state.assistantRetryMaxAttempts.value, 2),
    ASSISTANT_RAG_ENABLED: state.assistantRagEnabled.checked ? "true" : "false",
    ASSISTANT_ALLOW_WEB_SEARCH: state.assistantAllowWebSearch.checked ? "true" : "false",
    ASSISTANT_AUTO_LOCK_ON_THREAT: state.assistantAutoLockOnThreat.checked ? "true" : "false",
    ASSISTANT_THREAT_SCORE_THRESHOLD: asIntegerString(state.assistantThreatScoreThreshold.value, 80),
    ASSISTANT_EXTERNAL_API_ENABLED: state.assistantExternalApiEnabled.checked ? "true" : "false",
    ASSISTANT_EXTERNAL_API_TOKEN: asString(state.assistantExternalApiToken.value, ""),
    ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED: state.assistantExternalApiSignedTokensEnabled.checked ? "true" : "false",
    ASSISTANT_EXTERNAL_API_SIGNING_SECRET: asString(state.assistantExternalApiSigningSecret.value, ""),
    ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS: asIntegerString(
      state.assistantExternalApiSignedTokenTtlSeconds.value,
      900,
    ),
  };
}

export function applyConfigValues(state, config = {}) {
  state.assistantEnabled.checked = asBooleanString(config.ASSISTANT_ENABLED, DEFAULTS.ASSISTANT_ENABLED) === "true";
  state.assistantProvider.value = normalizeAssistantProvider(config.ASSISTANT_PROVIDER);
  state.assistantUrl.value = asString(config.ASSISTANT_URL, DEFAULTS.ASSISTANT_URL);
  state.assistantToken.value = "";
  state.assistantOllamaUrl.value = asString(config.ASSISTANT_OLLAMA_URL, DEFAULTS.ASSISTANT_OLLAMA_URL);
  state.assistantOllamaModel.value = asString(config.ASSISTANT_OLLAMA_MODEL, DEFAULTS.ASSISTANT_OLLAMA_MODEL);
  state.assistantTimeoutMs.value = asIntegerString(config.ASSISTANT_TIMEOUT_MS, DEFAULTS.ASSISTANT_TIMEOUT_MS);
  state.assistantRetryMaxAttempts.value = asIntegerString(
    config.ASSISTANT_RETRY_MAX_ATTEMPTS,
    DEFAULTS.ASSISTANT_RETRY_MAX_ATTEMPTS,
  );
  state.assistantRagEnabled.checked =
    asBooleanString(config.ASSISTANT_RAG_ENABLED, DEFAULTS.ASSISTANT_RAG_ENABLED) === "true";
  state.assistantAllowWebSearch.checked =
    asBooleanString(config.ASSISTANT_ALLOW_WEB_SEARCH, DEFAULTS.ASSISTANT_ALLOW_WEB_SEARCH) === "true";
  state.assistantAutoLockOnThreat.checked =
    asBooleanString(config.ASSISTANT_AUTO_LOCK_ON_THREAT, DEFAULTS.ASSISTANT_AUTO_LOCK_ON_THREAT) === "true";
  state.assistantThreatScoreThreshold.value = asIntegerString(
    config.ASSISTANT_THREAT_SCORE_THRESHOLD,
    DEFAULTS.ASSISTANT_THREAT_SCORE_THRESHOLD,
  );
  state.assistantExternalApiEnabled.checked =
    asBooleanString(config.ASSISTANT_EXTERNAL_API_ENABLED, DEFAULTS.ASSISTANT_EXTERNAL_API_ENABLED) === "true";
  state.assistantExternalApiToken.value = "";
  state.assistantExternalApiSignedTokensEnabled.checked =
    asBooleanString(
      config.ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED,
      DEFAULTS.ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED,
    ) === "true";
  state.assistantExternalApiSigningSecret.value = "";
  state.assistantExternalApiSignedTokenTtlSeconds.value = asIntegerString(
    config.ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS,
    DEFAULTS.ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS,
  );
}

export function renderOutput(state, payload) {
  state.output.textContent = JSON.stringify(payload || {}, null, 2);
}

export function renderPlanOutput(state, payload) {
  state.planOutput.textContent = JSON.stringify(payload || {}, null, 2);
}

export function renderWizardOutput(state, payload) {
  state.wizardOutput.textContent = JSON.stringify(payload || {}, null, 2);
}

export function renderWizardQuestion(state, question = null, run = null) {
  const current = question && typeof question === "object" ? question : null;
  const answers = Array.isArray(run?.wizard?.clarification?.answers) ? run.wizard.clarification.answers : [];
  if (!current) {
    state.wizardQuestion.value = "";
    state.wizardQuestion.setAttribute("data-intel-wizard-question-id", "");
    state.wizardAnswerOption.textContent = "";
    state.wizardAnswerOptionWrap.hidden = true;
    state.wizardAnswerOptionWrap.classList.add("hidden");
    return;
  }
  const options = Array.isArray(current.options) ? current.options.filter(Boolean) : [];
  const promptText = options.length > 0 ? `${asString(current.prompt, "")}\nOptions: ${options.join(" | ")}` : asString(current.prompt, "");
  state.wizardQuestion.value = promptText;
  state.wizardQuestion.setAttribute("data-intel-wizard-question-id", asString(current.id, ""));

  const priorAnswer =
    answers.find((entry) => asString(entry?.questionId, "") === asString(current.id, ""))?.answer || "";
  state.wizardAnswer.value = priorAnswer;

  if (options.length > 0) {
    state.wizardAnswerOption.textContent = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Select an option...";
    state.wizardAnswerOption.append(blank);
    for (const optionValue of options) {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionValue;
      state.wizardAnswerOption.append(option);
    }
    state.wizardAnswerOption.value = options.includes(priorAnswer) ? priorAnswer : "";
    state.wizardAnswerOptionWrap.hidden = false;
    state.wizardAnswerOptionWrap.classList.remove("hidden");
  } else {
    state.wizardAnswerOption.textContent = "";
    state.wizardAnswerOptionWrap.hidden = true;
    state.wizardAnswerOptionWrap.classList.add("hidden");
  }
}

export function renderWizardExecutionSteps(state, run = null) {
  state.wizardExecList.textContent = "";
  const steps = Array.isArray(run?.wizard?.execution?.steps) ? run.wizard.execution.steps : [];
  if (steps.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "Execution steps will appear after Execution Prep.";
    state.wizardExecList.append(empty);
    return;
  }

  const firstIncomplete = steps.find((entry) => entry && entry.completed !== true) || null;
  for (const step of steps) {
    const card = document.createElement("div");
    card.className = "intel-wizard-exec-card";
    if (step.completed) {
      card.classList.add("wizard-exec-complete");
    } else if (firstIncomplete && asString(firstIncomplete.id, "") === asString(step.id, "")) {
      card.classList.add("wizard-exec-current");
    } else {
      card.classList.add("wizard-exec-pending");
    }

    const title = document.createElement("div");
    title.className = "intel-wizard-exec-title";
    title.textContent = `${asString(step.title, step.id)} [${asString(step.mode, "manual")}]`;
    card.append(title);

    const instructions = document.createElement("div");
    instructions.className = "intel-wizard-exec-instructions";
    instructions.textContent = asString(step.instructions, "");
    card.append(instructions);

    if (asString(step.completionCriteria, "")) {
      const criteria = document.createElement("div");
      criteria.className = "muted";
      criteria.textContent = `Completion: ${asString(step.completionCriteria, "")}`;
      card.append(criteria);
    }

    if (asString(step.actionId, "")) {
      const action = document.createElement("div");
      action.className = "muted";
      action.textContent = `Action: ${asString(step.actionId, "")}`;
      card.append(action);
    }

    if (step.completed && asString(step.result, "")) {
      const result = document.createElement("pre");
      result.className = "intel-wizard-exec-result";
      result.textContent = asString(step.result, "");
      card.append(result);
    }

    state.wizardExecList.append(card);
  }
}

export function renderWizardRuns(state, runs, selectedRunId = "") {
  state.wizardRunSelect.textContent = "";
  for (const run of runs) {
    const option = document.createElement("option");
    option.value = asString(run.runId, "");
    const runName = asString(run.runName, "").trim();
    const goal = asString(run.goal, "").trim();
    const labelBase = runName || goal || asString(run.runId, "");
    const step = asString(run?.wizard?.currentStep, "");
    option.textContent = step ? `${labelBase} [${step}]` : labelBase;
    state.wizardRunSelect.append(option);
  }
  if (selectedRunId && runs.some((run) => asString(run.runId, "") === selectedRunId)) {
    state.wizardRunSelect.value = selectedRunId;
  } else if (runs[0]) {
    state.wizardRunSelect.value = asString(runs[0].runId, "");
  }
}

export function renderWizardStepRail(state, wizard = {}) {
  const currentStep = asString(wizard.currentStep, "define_name");
  const completed = Array.isArray(wizard.completedSteps) ? wizard.completedSteps : [];
  const currentIndex = Math.max(0, WIZARD_STEPS.indexOf(currentStep));
  const items = state.wizardSteps.querySelectorAll("[data-intel-wizard-step-item]");
  for (const item of items) {
    const step = asString(item.getAttribute("data-intel-wizard-step-item"), "");
    item.classList.remove("wizard-step-current", "wizard-step-complete", "wizard-step-future");
    if (step === currentStep) {
      item.classList.add("wizard-step-current");
      continue;
    }
    if (completed.includes(step) || WIZARD_STEPS.indexOf(step) < currentIndex) {
      item.classList.add("wizard-step-complete");
      continue;
    }
    item.classList.add("wizard-step-future");
  }
}

export function findPendingQuestion(run = {}) {
  const wizard = run?.wizard && typeof run.wizard === "object" ? run.wizard : {};
  const questions = Array.isArray(wizard?.clarification?.questions) ? wizard.clarification.questions : [];
  const answers = Array.isArray(wizard?.clarification?.answers) ? wizard.clarification.answers : [];
  for (const question of questions) {
    if (!question?.required) {
      continue;
    }
    const answered = answers.some(
      (entry) => asString(entry?.questionId, "") === asString(question.id, "") && asString(entry?.answer, ""),
    );
    if (!answered) {
      return question;
    }
  }
  return questions[0] || null;
}

export function showWizardSafeCard(state, requiredAction = null) {
  const show = Boolean(requiredAction && typeof requiredAction === "object");
  state.wizardSafeCard.hidden = !show;
  state.wizardSafeCard.classList.toggle("hidden", !show);
  if (!show) {
    state.wizardSafeSummary.textContent = "";
    state.wizardSafeRemember.checked = false;
    return;
  }
  const title = asString(requiredAction.title, asString(requiredAction.actionId, "Safe action"));
  const description = asString(requiredAction.description, "");
  const commandSummary = asString(requiredAction.commandSummary, "");
  state.wizardSafeSummary.textContent = [title, description, commandSummary].filter(Boolean).join(" ");
}

export function setWizardEntryVisibility(state, run = null) {
  const step = asString(run?.wizard?.currentStep, "define_name");
  const steps = Array.isArray(run?.wizard?.execution?.steps) ? run.wizard.execution.steps : [];
  const firstIncomplete = steps.find((entry) => entry && entry.completed !== true) || null;

  const showName = step === "define_name";
  const showGoal = step === "define_goal";
  const showQuestion = step === "clarify_round";
  const showManual =
    step === "execute_steps" &&
    firstIncomplete &&
    ["manual", "manual-risky"].includes(asString(firstIncomplete.mode, "manual"));
  const showExec = step === "execute_steps" || step === "execution_prep" || step === "completed";

  showSection(state.wizardEntryName, showName);
  showSection(state.wizardEntryGoal, showGoal);
  showSection(state.wizardEntryQuestion, showQuestion);
  showSection(state.wizardEntryManual, Boolean(showManual));
  showSection(state.wizardEntryExec, Boolean(showExec));

  const infoByStep = {
    create_initial_plan: "Next will generate the initial plan and first clarification round.",
    sufficiency_gate: "Next evaluates whether confidence is sufficient to proceed.",
    collect_evidence: "Next captures diagnostics/troubleshooting evidence for this run.",
    refine_layer: "Next asks the assistant to refine the next planning layer.",
    execution_prep: "Next generates explicit execution steps.",
    completed: "Workflow run is completed.",
  };
  const infoText = infoByStep[step] || "";
  showSection(state.wizardEntryInfo, Boolean(infoText));
  state.wizardStepInfo.textContent = infoText;
}

export function showSection(section, show) {
  if (!section) {
    return;
  }
  section.hidden = !show;
  section.classList.toggle("hidden", !show);
}

export function pushChatMessage(state, role, text) {
  const safeRole = role === "user" ? "user" : "assistant";
  const line = document.createElement("div");
  line.className = `intel-chat-line intel-chat-line-${safeRole}`;
  const label = document.createElement("span");
  label.className = "intel-chat-role";
  label.textContent = safeRole === "user" ? "You" : "Assistant";
  const content = document.createElement("span");
  content.className = "intel-chat-text";
  content.textContent = asString(text, "");
  line.append(label);
  line.append(content);
  state.chatLog.append(line);
  state.chatLog.scrollTop = state.chatLog.scrollHeight;
}

export function normalizeWorkflowDraft(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const id = asString(source.id, "").trim();
  const name = asString(source.name, "").trim();
  return {
    id,
    name,
    type: asString(source.type, "custom").trim() || "custom",
    description: asString(source.description, "").trim(),
    systemPrompt: asString(source.systemPrompt, "").trim(),
    seedPrompt: asString(source.seedPrompt, "").trim(),
    inputPlaceholder: asString(source.inputPlaceholder, "").trim(),
    ragEnabled: Boolean(source.ragEnabled),
    allowWebSearch: Boolean(source.allowWebSearch),
    autoLockOnThreat: Boolean(source.autoLockOnThreat),
    threatScoreThreshold: Number.parseInt(asString(source.threatScoreThreshold, "80"), 10) || 80,
    config: source.config && typeof source.config === "object" && !Array.isArray(source.config) ? source.config : {},
    builtIn: Boolean(source.builtIn),
  };
}

export function draftFromForm(state) {
  const id = asString(state.workflowId.value, "").trim();
  const name = asString(state.workflowName.value, "").trim();
  const configRaw = asString(state.workflowConfigJson.value, "").trim();
  let config = {};
  if (configRaw) {
    config = JSON.parse(configRaw);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("Workflow config JSON must be an object.");
    }
  }

  return {
    id,
    name,
    type: asString(state.workflowType.value, "custom").trim() || "custom",
    description: asString(state.workflowDescription.value, "").trim(),
    systemPrompt: asString(state.workflowSystemPrompt.value, "").trim(),
    seedPrompt: asString(state.workflowSeedPrompt.value, "").trim(),
    inputPlaceholder: asString(state.workflowInputPlaceholder.value, "").trim(),
    ragEnabled: Boolean(state.workflowRagEnabled.checked),
    allowWebSearch: Boolean(state.workflowAllowWebSearch.checked),
    autoLockOnThreat: Boolean(state.workflowAutoLock.checked),
    threatScoreThreshold: Number.parseInt(asString(state.workflowThreatThreshold.value, "80"), 10) || 80,
    config,
  };
}

export function populateWorkflowForm(state, workflow = null) {
  const current = normalizeWorkflowDraft(workflow || {});
  state.workflowId.value = current.id || "";
  state.workflowName.value = current.name || "";
  state.workflowType.value = current.type || "custom";
  state.workflowDescription.value = current.description || "";
  state.workflowSystemPrompt.value = current.systemPrompt || "";
  state.workflowSeedPrompt.value = current.seedPrompt || "";
  state.workflowInputPlaceholder.value = current.inputPlaceholder || "";
  state.workflowRagEnabled.checked = Boolean(current.ragEnabled);
  state.workflowAllowWebSearch.checked = Boolean(current.allowWebSearch);
  state.workflowAutoLock.checked = Boolean(current.autoLockOnThreat);
  state.workflowThreatThreshold.value = String(current.threatScoreThreshold || 80);
  state.workflowConfigJson.value = JSON.stringify(current.config || {}, null, 2);
  state.workflowType.disabled = Boolean(current.builtIn);
  state.workflowDelete.disabled = !current.id || Boolean(current.builtIn);
}

