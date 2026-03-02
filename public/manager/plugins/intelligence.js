const DEFAULTS = {
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

function normalizeAssistantProvider(value) {
  const normalized = asString(value, DEFAULTS.ASSISTANT_PROVIDER).trim().toLowerCase();
  return normalized === "ollama" ? "ollama" : "ollama";
}

function asString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
}

function asBooleanString(value, fallback = "false") {
  const normalized = asString(value, fallback).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized) ? "true" : "false";
}

function asIntegerString(value, fallback) {
  const parsed = Number.parseInt(asString(value, ""), 10);
  if (!Number.isInteger(parsed)) {
    return String(fallback);
  }
  return String(parsed);
}

function slugifyName(name) {
  return asString(name, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
}

function toConfigPatch(state) {
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

function applyConfigValues(state, config = {}) {
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

function renderOutput(state, payload) {
  state.output.textContent = JSON.stringify(payload || {}, null, 2);
}

function renderPlanOutput(state, payload) {
  state.planOutput.textContent = JSON.stringify(payload || {}, null, 2);
}

function showSection(section, show) {
  if (!section) {
    return;
  }
  section.hidden = !show;
  section.classList.toggle("hidden", !show);
}

function pushChatMessage(state, role, text) {
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

function normalizeWorkflowDraft(input = {}) {
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

function draftFromForm(state) {
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

function populateWorkflowForm(state, workflow = null) {
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

function createState(root) {
  return {
    form: root.querySelector("[data-intel-form]"),
    assistantEnabled: root.querySelector("[data-intel-assistant-enabled]"),
    assistantProvider: root.querySelector("[data-intel-assistant-provider]"),
    assistantUrl: root.querySelector("[data-intel-assistant-url]"),
    assistantToken: root.querySelector("[data-intel-assistant-token]"),
    assistantOllamaUrl: root.querySelector("[data-intel-assistant-ollama-url]"),
    assistantOllamaAutodetectBtn: root.querySelector("[data-intel-assistant-ollama-autodetect]"),
    assistantOllamaModel: root.querySelector("[data-intel-assistant-ollama-model]"),
    assistantTimeoutMs: root.querySelector("[data-intel-assistant-timeout-ms]"),
    assistantRetryMaxAttempts: root.querySelector("[data-intel-assistant-retry-max-attempts]"),
    assistantRagEnabled: root.querySelector("[data-intel-assistant-rag-enabled]"),
    assistantAllowWebSearch: root.querySelector("[data-intel-assistant-web-search]"),
    assistantAutoLockOnThreat: root.querySelector("[data-intel-assistant-auto-lock]"),
    assistantThreatScoreThreshold: root.querySelector("[data-intel-assistant-threat-threshold]"),
    assistantExternalApiEnabled: root.querySelector("[data-intel-assistant-external-enabled]"),
    assistantExternalApiToken: root.querySelector("[data-intel-assistant-external-token]"),
    assistantExternalApiSignedTokensEnabled: root.querySelector("[data-intel-assistant-external-signed-enabled]"),
    assistantExternalApiSigningSecret: root.querySelector("[data-intel-assistant-external-signing-secret]"),
    assistantExternalApiSignedTokenTtlSeconds: root.querySelector("[data-intel-assistant-external-signed-ttl]"),
    configureButton: root.querySelector("[data-intel-open-config]"),
    planButton: root.querySelector("[data-intel-open-plan]"),
    workflowsButton: root.querySelector("[data-intel-open-workflows]"),
    openChatPopoutButton: root.querySelector("[data-intel-open-chat-popout]"),
    menuWorkflowSelect: root.querySelector("[data-intel-menu-workflow-select]"),
    configSection: root.querySelector("[data-intel-config-section]"),
    planSection: root.querySelector("[data-intel-plan-section]"),
    workflowsSection: root.querySelector("[data-intel-workflow-section]"),
    closeConfigButton: root.querySelector("[data-intel-close-config]"),
    closePlanButton: root.querySelector("[data-intel-close-plan]"),
    closeWorkflowButton: root.querySelector("[data-intel-close-workflow]"),
    refreshButton: root.querySelector("[data-intel-action-refresh]"),
    planGoal: root.querySelector("[data-intel-plan-goal]"),
    planWorkflowSelect: root.querySelector("[data-intel-plan-workflow]"),
    planRunSelect: root.querySelector("[data-intel-plan-run]"),
    planNote: root.querySelector("[data-intel-plan-note]"),
    planCreate: root.querySelector("[data-intel-plan-create]"),
    planCollect: root.querySelector("[data-intel-plan-collect]"),
    planRefine: root.querySelector("[data-intel-plan-refine]"),
    planRefresh: root.querySelector("[data-intel-plan-refresh]"),
    planOutput: root.querySelector("[data-intel-plan-output]"),
    agentButton: root.querySelector("[data-intel-open-agent]"),
    agentSection: root.querySelector("[data-intel-agent-section]"),
    closeAgentButton: root.querySelector("[data-intel-close-agent]"),
    agentRefresh: root.querySelector("[data-intel-agent-refresh]"),
    agentSelect: root.querySelector("[data-intel-agent-select]"),
    agentName: root.querySelector("[data-intel-agent-name]"),
    agentIntent: root.querySelector("[data-intel-agent-intent]"),
    agentScaffoldList: root.querySelector("[data-intel-agent-scaffolds]"),
    agentTokenLabel: root.querySelector("[data-intel-agent-token-label]"),
    agentTokenExpiryHours: root.querySelector("[data-intel-agent-token-expiry-hours]"),
    agentTokenCreate: root.querySelector("[data-intel-agent-token-create]"),
    agentTokenSelect: root.querySelector("[data-intel-agent-token-select]"),
    agentTokenRevoke: root.querySelector("[data-intel-agent-token-revoke]"),
    agentGenerate: root.querySelector("[data-intel-agent-generate]"),
    agentValidate: root.querySelector("[data-intel-agent-validate]"),
    agentSave: root.querySelector("[data-intel-agent-save]"),
    agentDelete: root.querySelector("[data-intel-agent-delete]"),
    agentOutput: root.querySelector("[data-intel-agent-output]"),
    workflowSelect: root.querySelector("[data-intel-workflow-select]"),
    workflowLaunch: root.querySelector("[data-intel-workflow-launch]"),
    workflowNew: root.querySelector("[data-intel-workflow-new]"),
    workflowSave: root.querySelector("[data-intel-workflow-save]"),
    workflowDelete: root.querySelector("[data-intel-workflow-delete]"),
    workflowGenerate: root.querySelector("[data-intel-workflow-generate]"),
    workflowId: root.querySelector("[data-intel-workflow-id]"),
    workflowName: root.querySelector("[data-intel-workflow-name]"),
    workflowType: root.querySelector("[data-intel-workflow-type]"),
    workflowDescription: root.querySelector("[data-intel-workflow-description]"),
    workflowSystemPrompt: root.querySelector("[data-intel-workflow-system-prompt]"),
    workflowSeedPrompt: root.querySelector("[data-intel-workflow-seed-prompt]"),
    workflowInputPlaceholder: root.querySelector("[data-intel-workflow-input-placeholder]"),
    workflowRagEnabled: root.querySelector("[data-intel-workflow-rag-enabled]"),
    workflowAllowWebSearch: root.querySelector("[data-intel-workflow-web-search]"),
    workflowAutoLock: root.querySelector("[data-intel-workflow-auto-lock]"),
    workflowThreatThreshold: root.querySelector("[data-intel-workflow-threat-threshold]"),
    workflowConfigJson: root.querySelector("[data-intel-workflow-config-json]"),
    chatSection: root.querySelector("[data-intel-chat-wrap]"),
    chatLog: root.querySelector("[data-intel-chat-log]"),
    chatInput: root.querySelector("[data-intel-chat-input]"),
    chatSend: root.querySelector("[data-intel-chat-send]"),
    output: root.querySelector("[data-intel-output]"),
  };
}

function validateState(state) {
  const required = [
    "form",
    "assistantEnabled",
    "assistantProvider",
    "assistantUrl",
    "assistantToken",
    "assistantOllamaUrl",
    "assistantOllamaAutodetectBtn",
    "assistantOllamaModel",
    "assistantTimeoutMs",
    "assistantRetryMaxAttempts",
    "assistantRagEnabled",
    "assistantAllowWebSearch",
    "assistantAutoLockOnThreat",
    "assistantThreatScoreThreshold",
    "assistantExternalApiEnabled",
    "assistantExternalApiToken",
    "assistantExternalApiSignedTokensEnabled",
    "assistantExternalApiSigningSecret",
    "assistantExternalApiSignedTokenTtlSeconds",
    "configureButton",
    "planButton",
    "workflowsButton",
    "openChatPopoutButton",
    "menuWorkflowSelect",
    "configSection",
    "planSection",
    "workflowsSection",
    "closeConfigButton",
    "closePlanButton",
    "closeWorkflowButton",
    "refreshButton",
    "planGoal",
    "planWorkflowSelect",
    "planRunSelect",
    "planNote",
    "planCreate",
    "planCollect",
    "planRefine",
    "planRefresh",
    "planOutput",
    "agentButton",
    "agentSection",
    "closeAgentButton",
    "agentRefresh",
    "agentSelect",
    "agentName",
    "agentIntent",
    "agentScaffoldList",
    "agentTokenLabel",
    "agentTokenExpiryHours",
    "agentTokenCreate",
    "agentTokenSelect",
    "agentTokenRevoke",
    "agentGenerate",
    "agentValidate",
    "agentSave",
    "agentDelete",
    "agentOutput",
    "workflowSelect",
    "workflowLaunch",
    "workflowNew",
    "workflowSave",
    "workflowDelete",
    "workflowGenerate",
    "workflowId",
    "workflowName",
    "workflowType",
    "workflowDescription",
    "workflowSystemPrompt",
    "workflowSeedPrompt",
    "workflowInputPlaceholder",
    "workflowRagEnabled",
    "workflowAllowWebSearch",
    "workflowAutoLock",
    "workflowThreatThreshold",
    "workflowConfigJson",
    "chatSection",
    "chatLog",
    "chatInput",
    "chatSend",
    "output",
  ];

  for (const key of required) {
    if (!state[key]) {
      throw new Error(`intelligence plugin is missing required UI element: ${key}`);
    }
  }
}

function createPanelMarkup() {
  return `
    <section class="intel-menu">
      <div class="button-row">
        <button type="button" data-intel-open-config>Configure Intelligence Module</button>
        <button type="button" data-intel-open-plan>Phase 0 Plan Lab</button>
        <button type="button" data-intel-open-agent>Agent Scaffolding (Phase 1)</button>
        <button type="button" data-intel-open-workflows>Create Workflow</button>
      </div>
      <div class="grid">
        <label>Workflow to Launch
          <select data-intel-menu-workflow-select></select>
        </label>
      </div>
      <div class="button-row">
        <button type="button" data-intel-open-chat-popout>Launch Workflow</button>
      </div>
    </section>

    <section class="intel-config-wrap hidden" data-intel-config-section hidden>
      <div class="intel-section-header">
        <h3>Configure Intelligence Module</h3>
        <button type="button" class="secondary" data-intel-close-config>Close</button>
      </div>
      <form class="intel-config-form" data-intel-form>
        <div class="grid">
          <label class="checkbox-label">
            <input type="checkbox" data-intel-assistant-enabled />
            Enable Intelligence Module
          </label>
          <label>Provider
            <select data-intel-assistant-provider>
              <option value="ollama">ollama</option>
            </select>
          </label>
          <label>Assistant URL (empty = local workflow engine)
            <input type="text" data-intel-assistant-url />
          </label>
          <label>Assistant Token (leave blank to keep current)
            <input type="password" data-intel-assistant-token />
          </label>
          <label>Ollama URL
            <div class="input-action-row">
              <input type="text" data-intel-assistant-ollama-url />
              <button type="button" class="secondary" data-intel-assistant-ollama-autodetect>Autodetect</button>
            </div>
          </label>
          <label>Ollama Model
            <input type="text" data-intel-assistant-ollama-model />
          </label>
          <label>Timeout (ms)
            <input type="number" min="100" step="100" data-intel-assistant-timeout-ms />
          </label>
          <label>Retry Attempts
            <input type="number" min="1" step="1" data-intel-assistant-retry-max-attempts />
          </label>
          <label>Threat Score Threshold
            <input type="number" min="20" max="100" step="1" data-intel-assistant-threat-threshold />
          </label>
          <label class="checkbox-label">
            <input type="checkbox" data-intel-assistant-rag-enabled />
            Enable RAG
          </label>
          <label class="checkbox-label">
            <input type="checkbox" data-intel-assistant-web-search />
            Allow Web Search
          </label>
          <label class="checkbox-label">
            <input type="checkbox" data-intel-assistant-auto-lock />
            Auto-lock Blastdoors on Threat
          </label>
          <label class="checkbox-label">
            <input type="checkbox" data-intel-assistant-external-enabled />
            Enable External Agent API (read-only)
          </label>
          <label>Legacy Shared API Token (optional compatibility)
            <input type="password" data-intel-assistant-external-token />
          </label>
          <label class="checkbox-label">
            <input type="checkbox" data-intel-assistant-external-signed-enabled />
            Enable Signed Short-lived Tokens
          </label>
          <label>Signed Token Signing Secret
            <input type="password" data-intel-assistant-external-signing-secret />
          </label>
          <label>Signed Token TTL (seconds)
            <input type="number" min="60" step="60" data-intel-assistant-external-signed-ttl />
          </label>
        </div>
        <div class="button-row">
          <button type="submit">Save Intelligence Config</button>
          <button type="button" class="secondary" data-intel-action-refresh>Refresh Status</button>
        </div>
      </form>

      <section class="intel-output-wrap">
        <h3>Output</h3>
        <pre class="log-box" data-intel-output></pre>
      </section>
    </section>

    <section class="intel-plan-wrap hidden" data-intel-plan-section hidden>
      <div class="intel-section-header">
        <h3>Phase 0 Plan Lab (Human-in-the-loop)</h3>
        <button type="button" class="secondary" data-intel-close-plan>Close</button>
      </div>

      <div class="grid">
        <label>Goal
          <textarea data-intel-plan-goal placeholder="Describe the outcome you want and constraints to honor."></textarea>
        </label>
        <label>Workflow
          <select data-intel-plan-workflow></select>
        </label>
      </div>

      <div class="button-row">
        <button type="button" data-intel-plan-create>Create Plan Run</button>
        <button type="button" class="secondary" data-intel-plan-refresh>Refresh Runs</button>
      </div>

      <div class="grid">
        <label>Plan Runs
          <select data-intel-plan-run></select>
        </label>
        <label>Operator Note / Refine Prompt
          <input type="text" data-intel-plan-note placeholder="Optional note for evidence collection or refine prompt." />
        </label>
      </div>

      <div class="button-row">
        <button type="button" data-intel-plan-collect>Collect Evidence</button>
        <button type="button" data-intel-plan-refine>Refine Next Layer</button>
      </div>

      <pre class="log-box" data-intel-plan-output></pre>
    </section>

    <section class="intel-agent-wrap hidden" data-intel-agent-section hidden>
      <div class="intel-section-header">
        <h3>Agent Scaffolding (Phase 1)</h3>
        <button type="button" class="secondary" data-intel-close-agent>Close</button>
      </div>
      <p class="muted">Human-in-the-loop enforced. Generated drafts cannot auto-apply destructive actions.</p>
      <div class="grid">
        <label>Saved Agents
          <select data-intel-agent-select></select>
        </label>
        <div class="intel-workflow-launch-cell">
          <button type="button" class="secondary" data-intel-agent-refresh>Refresh</button>
        </div>
      </div>
      <div class="grid">
        <label>Agent Name
          <input type="text" data-intel-agent-name placeholder="TLS Setup Agent" />
        </label>
      </div>
      <label>Agent Intent
        <textarea data-intel-agent-intent placeholder="Describe what this agent should accomplish, constraints, and expected outputs."></textarea>
      </label>
      <label>Scaffold Blocks
        <div class="intel-agent-scaffold-list" data-intel-agent-scaffolds></div>
      </label>
      <div class="grid">
        <label>New Scoped Token Label
          <input type="text" data-intel-agent-token-label placeholder="Codex integration token" />
        </label>
        <label>Expires In Hours (optional)
          <input type="number" min="1" step="1" data-intel-agent-token-expiry-hours placeholder="24" />
        </label>
      </div>
      <div class="button-row">
        <button type="button" class="secondary" data-intel-agent-token-create>Create Scoped Token</button>
      </div>
      <div class="grid">
        <label>Scoped Tokens
          <select data-intel-agent-token-select></select>
        </label>
        <div class="intel-workflow-launch-cell">
          <button type="button" class="secondary" data-intel-agent-token-revoke>Revoke Selected Token</button>
        </div>
      </div>
      <div class="button-row">
        <button type="button" data-intel-agent-generate>Generate Draft From Scaffolds</button>
        <button type="button" class="secondary" data-intel-agent-validate>Validate Graph</button>
        <button type="button" data-intel-agent-save>Save Draft</button>
        <button type="button" class="secondary" data-intel-agent-delete>Delete</button>
      </div>
      <pre class="log-box" data-intel-agent-output></pre>
    </section>

    <section class="intel-workflow-wrap hidden" data-intel-workflow-section hidden>
      <div class="intel-section-header">
        <h3>Create / Manage Workflows</h3>
        <button type="button" class="secondary" data-intel-close-workflow>Close</button>
      </div>

      <div class="grid">
        <label>Workflow
          <select data-intel-workflow-select></select>
        </label>
        <div class="intel-workflow-launch-cell">
          <button type="button" data-intel-workflow-launch>Launch Workflow (Pop-out)</button>
        </div>
      </div>

      <div class="grid">
        <label>Workflow ID
          <input type="text" data-intel-workflow-id readonly />
        </label>
      </div>

      <div class="button-row">
        <button type="button" data-intel-workflow-new>New Workflow</button>
        <button type="button" data-intel-workflow-save>Save / Modify</button>
        <button type="button" class="secondary" data-intel-workflow-delete>Delete</button>
      </div>

      <div class="grid">
        <label>Workflow Name
          <input type="text" data-intel-workflow-name />
        </label>
        <label>Workflow Type
          <select data-intel-workflow-type>
            <option value="config-recommendations">Config Recommendations</option>
            <option value="troubleshoot-recommendation">Troubleshooting Recommendations</option>
            <option value="threat-monitor">Threat Monitor</option>
            <option value="grimoire">Grimoire</option>
            <option value="custom">Custom</option>
          </select>
        </label>
      </div>

      <label>Describe what this workflow should do
        <textarea data-intel-workflow-description placeholder="Describe workflow behavior, context needed, and expected output."></textarea>
      </label>
      <div class="button-row">
        <button type="button" data-intel-workflow-generate>Generate Config With AI</button>
      </div>

      <label>System Prompt
        <textarea data-intel-workflow-system-prompt></textarea>
      </label>
      <label>Seed Prompt
        <textarea data-intel-workflow-seed-prompt></textarea>
      </label>
      <label>Input Placeholder
        <input type="text" data-intel-workflow-input-placeholder />
      </label>

      <div class="grid">
        <label class="checkbox-label">
          <input type="checkbox" data-intel-workflow-rag-enabled />
          Enable RAG
        </label>
        <label class="checkbox-label">
          <input type="checkbox" data-intel-workflow-web-search />
          Enable Web Search
        </label>
        <label class="checkbox-label">
          <input type="checkbox" data-intel-workflow-auto-lock />
          Auto-lock on threat
        </label>
        <label>Threat Score Threshold
          <input type="number" min="20" max="100" step="1" data-intel-workflow-threat-threshold />
        </label>
      </div>

      <label>Workflow Specific Config (JSON object)
        <textarea data-intel-workflow-config-json>{}</textarea>
      </label>

      <section class="intel-chat-wrap hidden" data-intel-chat-wrap hidden>
        <h3>Workflow Chat</h3>
        <div class="intel-chat-log log-box" data-intel-chat-log></div>
        <div class="button-row">
          <input type="text" data-intel-chat-input placeholder="Send message to workflow assistant" />
          <button type="button" data-intel-chat-send>Send</button>
        </div>
      </section>
    </section>
  `;
}

function renderWorkflowSelects(state, workflows, selectedId = "") {
  state.menuWorkflowSelect.textContent = "";
  state.workflowSelect.textContent = "";
  state.planWorkflowSelect.textContent = "";
  for (const workflow of workflows) {
    const menuOption = document.createElement("option");
    menuOption.value = workflow.id;
    menuOption.textContent = `${workflow.name} (${workflow.type})`;
    state.menuWorkflowSelect.append(menuOption);

    const option = document.createElement("option");
    option.value = workflow.id;
    option.textContent = `${workflow.name} (${workflow.type})`;
    state.workflowSelect.append(option);

    const planOption = document.createElement("option");
    planOption.value = workflow.id;
    planOption.textContent = `${workflow.name} (${workflow.type})`;
    state.planWorkflowSelect.append(planOption);
  }
  if (selectedId && workflows.some((workflow) => workflow.id === selectedId)) {
    state.menuWorkflowSelect.value = selectedId;
    state.workflowSelect.value = selectedId;
    state.planWorkflowSelect.value = selectedId;
  } else if (workflows[0]) {
    state.menuWorkflowSelect.value = workflows[0].id;
    state.workflowSelect.value = workflows[0].id;
    state.planWorkflowSelect.value = workflows[0].id;
  }
}

function renderPlanRunSelect(state, runs, selectedRunId = "") {
  state.planRunSelect.textContent = "";
  for (const run of runs) {
    const option = document.createElement("option");
    option.value = run.runId;
    option.textContent = `${run.goal || run.runId} [layers:${run.layerCount || 0} evidence:${run.evidenceCount || 0}]`;
    state.planRunSelect.append(option);
  }
  if (selectedRunId && runs.some((run) => run.runId === selectedRunId)) {
    state.planRunSelect.value = selectedRunId;
  } else if (runs[0]) {
    state.planRunSelect.value = runs[0].runId;
  }
}

function renderAgentSelect(state, agents, selectedAgentId = "") {
  state.agentSelect.textContent = "";
  for (const agent of agents) {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = `${agent.name} (${agent.id})`;
    state.agentSelect.append(option);
  }
  if (selectedAgentId && agents.some((entry) => entry.id === selectedAgentId)) {
    state.agentSelect.value = selectedAgentId;
  } else if (agents[0]) {
    state.agentSelect.value = agents[0].id;
  }
}

function renderAgentTokenSelect(state, tokens, selectedTokenId = "") {
  state.agentTokenSelect.textContent = "";
  const list = Array.isArray(tokens) ? tokens : [];
  for (const token of list) {
    const option = document.createElement("option");
    option.value = asString(token.tokenId, "");
    const active = token.active === false ? "revoked/expired" : "active";
    const label = asString(token.label, "token");
    const expires = asString(token.expiresAt, "");
    option.textContent = expires ? `${label} [${active}] exp:${expires}` : `${label} [${active}]`;
    state.agentTokenSelect.append(option);
  }
  if (selectedTokenId && list.some((entry) => asString(entry.tokenId, "") === selectedTokenId)) {
    state.agentTokenSelect.value = selectedTokenId;
  } else if (list[0]) {
    state.agentTokenSelect.value = asString(list[0].tokenId, "");
  }
}

function renderScaffoldChecklist(state, scaffolds, selectedIds = []) {
  state.agentScaffoldList.textContent = "";
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  for (const scaffold of scaffolds) {
    const wrapper = document.createElement("label");
    wrapper.className = "checkbox-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = scaffold.id;
    checkbox.checked = selected.has(scaffold.id);
    checkbox.setAttribute("data-intel-agent-scaffold-checkbox", scaffold.id);
    const text = document.createElement("span");
    text.textContent = `${scaffold.name} (${scaffold.id})`;
    wrapper.append(checkbox);
    wrapper.append(text);
    state.agentScaffoldList.append(wrapper);
  }
}

export async function registerManagerPlugin(context) {
  const panel = context.createPanel({
    pluginId: context.pluginId || "intelligence",
    title: "Intelligence Module",
    note: "Plugin-powered AI workflows and assistant settings. All requests are executed server-side.",
    className: "intelligence-plugin-panel",
  });
  panel.body.innerHTML = createPanelMarkup();

  const state = createState(panel.root);
  validateState(state);

  const runtime = {
    workflows: [],
    workflowMap: new Map(),
    selectedWorkflowId: "",
    planRuns: [],
    selectedPlanRunId: "",
    agentScaffolds: [],
    agents: [],
    selectedAgentId: "",
    currentAgentDraft: null,
    launchedWorkflowId: "",
    refreshTick: 0,
    statusLoadedOnce: false,
  };

  function getWorkflowById(workflowId) {
    return runtime.workflowMap.get(asString(workflowId, "")) || null;
  }

  function activeWorkflowFromForm() {
    const draft = draftFromForm(state);
    if (!draft.id && draft.name) {
      draft.id = slugifyName(draft.name);
    }
    const existing = getWorkflowById(draft.id);
    if (existing?.builtIn) {
      draft.builtIn = true;
      draft.type = existing.type;
      draft.id = existing.id;
    }
    return draft;
  }

  function showConfigSection(forceVisible = null) {
    const nextVisible = forceVisible === null ? state.configSection.hidden : Boolean(forceVisible);
    showSection(state.configSection, nextVisible);
  }

  function showWorkflowSection(forceVisible = null) {
    const nextVisible = forceVisible === null ? state.workflowsSection.hidden : Boolean(forceVisible);
    showSection(state.workflowsSection, nextVisible);
  }

  function showPlanSection(forceVisible = null) {
    const nextVisible = forceVisible === null ? state.planSection.hidden : Boolean(forceVisible);
    showSection(state.planSection, nextVisible);
  }

  function showAgentSection(forceVisible = null) {
    const nextVisible = forceVisible === null ? state.agentSection.hidden : Boolean(forceVisible);
    showSection(state.agentSection, nextVisible);
  }

  function hideChatSection() {
    showSection(state.chatSection, false);
    runtime.launchedWorkflowId = "";
  }

  function openWorkflowChatPopup(preferredWorkflowId = "") {
    const selectedId = asString(preferredWorkflowId || state.workflowSelect.value || runtime.selectedWorkflowId, "");
    const popupUrl = new URL(context.resolveAssetUrl("/manager/intelligence-chat.html"));
    if (selectedId) {
      popupUrl.searchParams.set("workflowId", selectedId);
      popupUrl.searchParams.set("launch", "1");
    }

    const popup = window.open(
      popupUrl.toString(),
      "blastdoor-intelligence-chat",
      "popup=yes,width=860,height=920,resizable=yes,scrollbars=yes",
    );
    if (!popup) {
      throw new Error("Browser blocked the workflow chat popup. Allow popups for this site and retry.");
    }
    popup.focus();
    panel.setStatus("Workflow chat opened in a separate window.");
  }

  function syncWorkflowSelection(selectedId = "") {
    runtime.workflowMap = new Map(runtime.workflows.map((workflow) => [workflow.id, workflow]));
    renderWorkflowSelects(state, runtime.workflows, selectedId || runtime.selectedWorkflowId);
    runtime.selectedWorkflowId = asString(state.workflowSelect.value, "");
    const selected = getWorkflowById(runtime.selectedWorkflowId);
    if (selected) {
      populateWorkflowForm(state, selected);
    }
    hideChatSection();
  }

  async function loadStatus(showMessage = false) {
    const payload = await context.apiGet("/assistant/status");
    renderOutput(state, payload);
    applyConfigValues(state, payload.config || {});
    if (showMessage) {
      panel.setStatus("Assistant status loaded.");
    } else if (!runtime.statusLoadedOnce) {
      panel.setStatus("Assistant plugin ready.");
    }
    runtime.statusLoadedOnce = true;
  }

  async function loadWorkflows(showMessage = false, preferredWorkflowId = "") {
    const payload = await context.apiGet("/assistant/workflows");
    const workflows = Array.isArray(payload.workflowConfigs) ? payload.workflowConfigs : [];
    runtime.workflows = workflows;
    syncWorkflowSelection(preferredWorkflowId);
    if (showMessage) {
      panel.setStatus(`Loaded ${workflows.length} workflows.`);
    }
  }

  async function loadPlanRun(runId) {
    if (!runId) {
      renderPlanOutput(state, { ok: true, run: null });
      return;
    }
    const payload = await context.apiGet(`/assistant/plans/${encodeURIComponent(runId)}`);
    renderPlanOutput(state, payload);
    runtime.selectedPlanRunId = asString(payload?.run?.runId || runId, "");
  }

  async function loadPlanRuns(showMessage = false, preferredRunId = "") {
    const payload = await context.apiGet("/assistant/plans?limit=50");
    const runs = Array.isArray(payload.runs) ? payload.runs : [];
    runtime.planRuns = runs;
    renderPlanRunSelect(state, runs, preferredRunId || runtime.selectedPlanRunId);
    runtime.selectedPlanRunId = asString(state.planRunSelect.value, "");
    if (runtime.selectedPlanRunId) {
      await loadPlanRun(runtime.selectedPlanRunId);
    } else {
      renderPlanOutput(state, payload);
    }
    if (showMessage) {
      panel.setStatus(`Loaded ${runs.length} phase 0 plan runs.`);
    }
  }

  async function createPlanRun() {
    const goal = asString(state.planGoal.value, "").trim();
    if (!goal) {
      throw new Error("Goal is required to create a plan run.");
    }
    const workflowId = asString(state.planWorkflowSelect.value, "").trim() || "troubleshoot-recommendation";
    const payload = await context.apiPost("/assistant/plans/create", {
      goal,
      workflowId,
    });
    renderPlanOutput(state, payload);
    const runId = asString(payload?.run?.runId, "");
    await loadPlanRuns(false, runId);
    panel.setStatus(`Created phase 0 plan run ${runId || ""}`.trim());
  }

  async function collectPlanEvidence() {
    const runId = asString(state.planRunSelect.value, "").trim();
    if (!runId) {
      throw new Error("Select a plan run first.");
    }
    const note = asString(state.planNote.value, "").trim();
    const payload = await context.apiPost(`/assistant/plans/${encodeURIComponent(runId)}/collect-evidence`, {
      note,
    });
    renderPlanOutput(state, payload);
    await loadPlanRuns(false, runId);
    panel.setStatus("Collected diagnostics evidence into selected plan run.");
  }

  async function refinePlanRun() {
    const runId = asString(state.planRunSelect.value, "").trim();
    if (!runId) {
      throw new Error("Select a plan run first.");
    }
    const message = asString(state.planNote.value, "").trim();
    const workflowId = asString(state.planWorkflowSelect.value, "").trim() || undefined;
    const payload = await context.apiPost(`/assistant/plans/${encodeURIComponent(runId)}/refine`, {
      message,
      workflowId,
    });
    renderPlanOutput(state, payload);
    await loadPlanRuns(false, runId);
    panel.setStatus("Generated next plan layer from collected evidence.");
  }

  function getSelectedAgentScaffoldIds() {
    const checkboxes = state.agentScaffoldList.querySelectorAll("input[data-intel-agent-scaffold-checkbox]");
    return [...checkboxes]
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => asString(checkbox.value, "").trim())
      .filter(Boolean);
  }

  function buildAgentDraftFromForm() {
    const sourceDraft = runtime.currentAgentDraft && typeof runtime.currentAgentDraft === "object" ? runtime.currentAgentDraft : {};
    return {
      ...sourceDraft,
      name: asString(state.agentName.value, "").trim() || asString(sourceDraft.name, "").trim() || "Scaffold Agent",
      intent: asString(state.agentIntent.value, "").trim() || asString(sourceDraft.intent, "").trim(),
      scaffoldIds: getSelectedAgentScaffoldIds(),
    };
  }

  function applyAgentDraftToForm(agent = null) {
    const current = agent && typeof agent === "object" ? agent : null;
    if (!current) {
      state.agentName.value = "";
      state.agentIntent.value = "";
      renderScaffoldChecklist(state, runtime.agentScaffolds, []);
      renderAgentTokenSelect(state, []);
      state.agentOutput.textContent = JSON.stringify({ ok: true, draft: null }, null, 2);
      runtime.currentAgentDraft = null;
      return;
    }
    state.agentName.value = asString(current.name, "");
    state.agentIntent.value = asString(current.intent, "");
    renderScaffoldChecklist(state, runtime.agentScaffolds, Array.isArray(current.scaffoldIds) ? current.scaffoldIds : []);
    const tokenList = Array.isArray(current?.externalAccess?.tokens) ? current.externalAccess.tokens : [];
    renderAgentTokenSelect(state, tokenList);
    state.agentOutput.textContent = JSON.stringify({ ok: true, draft: current }, null, 2);
    runtime.currentAgentDraft = current;
  }

  async function loadAgentCatalog() {
    const payload = await context.apiGet("/assistant/agents/scaffolds");
    runtime.agentScaffolds = Array.isArray(payload.scaffolds) ? payload.scaffolds : [];
    if (!runtime.currentAgentDraft) {
      renderScaffoldChecklist(state, runtime.agentScaffolds, []);
    } else {
      renderScaffoldChecklist(
        state,
        runtime.agentScaffolds,
        Array.isArray(runtime.currentAgentDraft.scaffoldIds) ? runtime.currentAgentDraft.scaffoldIds : [],
      );
    }
  }

  async function loadAgents(showMessage = false, preferredAgentId = "") {
    const payload = await context.apiGet("/assistant/agents");
    const agents = Array.isArray(payload.agentConfigs) ? payload.agentConfigs : [];
    runtime.agents = agents;
    renderAgentSelect(state, agents, preferredAgentId || runtime.selectedAgentId);
    runtime.selectedAgentId = asString(state.agentSelect.value, "");
    const selectedAgent =
      agents.find((entry) => entry.id === runtime.selectedAgentId) ||
      agents.find((entry) => entry.id === preferredAgentId) ||
      null;
    applyAgentDraftToForm(selectedAgent);
    if (showMessage) {
      panel.setStatus(`Loaded ${agents.length} scaffold agents.`);
    }
  }

  async function generateAgentDraft() {
    const name = asString(state.agentName.value, "").trim() || "Scaffold Agent";
    const intent = asString(state.agentIntent.value, "").trim();
    if (!intent) {
      throw new Error("Agent intent is required.");
    }
    const scaffoldIds = getSelectedAgentScaffoldIds();
    const payload = await context.apiPost("/assistant/agents/generate", {
      name,
      intent,
      scaffoldIds,
    });
    state.agentOutput.textContent = JSON.stringify(payload || {}, null, 2);
    runtime.currentAgentDraft = payload?.draft || null;
    if (runtime.currentAgentDraft) {
      applyAgentDraftToForm(runtime.currentAgentDraft);
      panel.setStatus("Generated scaffold-based agent draft. Review before saving.");
    }
  }

  async function saveAgentDraft() {
    const draft = buildAgentDraftFromForm();
    if (!draft.intent) {
      throw new Error("Agent intent is required before saving.");
    }
    if (!draft.id) {
      throw new Error("Generate a draft first so it has an id.");
    }
    const payload = await context.apiPost("/assistant/agents/save", {
      agent: draft,
    });
    state.agentOutput.textContent = JSON.stringify(payload || {}, null, 2);
    await loadAgents(false, payload?.agent?.id || draft.id);
    panel.setStatus(`Saved scaffold agent '${payload?.agent?.name || draft.name}'.`);
  }

  async function validateAgentDraft() {
    const draft = buildAgentDraftFromForm();
    if (!draft.intent) {
      throw new Error("Agent intent is required before validation.");
    }
    const payload = await context.apiPost("/assistant/agents/validate", {
      agent: draft,
    });
    state.agentOutput.textContent = JSON.stringify(payload || {}, null, 2);
    runtime.currentAgentDraft = payload?.agent || draft;
    if (runtime.currentAgentDraft) {
      applyAgentDraftToForm(runtime.currentAgentDraft);
    }
    if (payload?.validation?.ok) {
      panel.setStatus("Execution graph is valid.");
    } else {
      panel.setStatus("Execution graph has issues. Review output.", true);
    }
  }

  async function deleteAgentDraft() {
    const agentId = asString(state.agentSelect.value, "").trim() || asString(runtime.currentAgentDraft?.id, "").trim();
    if (!agentId) {
      throw new Error("Select an agent to delete.");
    }
    const payload = await context.apiPost("/assistant/agents/delete", {
      agentId,
    });
    state.agentOutput.textContent = JSON.stringify(payload || {}, null, 2);
    runtime.currentAgentDraft = null;
    await loadAgents(false);
    panel.setStatus(`Deleted scaffold agent '${agentId}'.`);
  }

  async function createAgentScopedToken() {
    const agentId = asString(state.agentSelect.value, "").trim() || asString(runtime.currentAgentDraft?.id, "").trim();
    if (!agentId) {
      throw new Error("Select an agent before creating a scoped token.");
    }
    const label = asString(state.agentTokenLabel.value, "").trim() || "Scoped token";
    const expiresInHoursRaw = asString(state.agentTokenExpiryHours.value, "").trim();
    const expiresInHours = expiresInHoursRaw ? Number.parseInt(expiresInHoursRaw, 10) : null;
    const payload = await context.apiPost("/assistant/agents/tokens/create", {
      agentId,
      label,
      expiresInHours: Number.isInteger(expiresInHours) ? expiresInHours : undefined,
    });
    state.agentOutput.textContent = JSON.stringify(payload || {}, null, 2);
    state.agentTokenLabel.value = "";
    state.agentTokenExpiryHours.value = "";
    await loadAgents(false, agentId);
    panel.setStatus("Created scoped token. Copy it now; it is shown only once.");
  }

  async function revokeAgentScopedToken() {
    const agentId = asString(state.agentSelect.value, "").trim() || asString(runtime.currentAgentDraft?.id, "").trim();
    const tokenId = asString(state.agentTokenSelect.value, "").trim();
    if (!agentId || !tokenId) {
      throw new Error("Select an agent and token to revoke.");
    }
    const payload = await context.apiPost("/assistant/agents/tokens/revoke", {
      agentId,
      tokenId,
    });
    state.agentOutput.textContent = JSON.stringify(payload || {}, null, 2);
    await loadAgents(false, agentId);
    panel.setStatus("Scoped token revoked.");
  }

  async function saveWorkflow() {
    const draft = activeWorkflowFromForm();
    if (!draft.name) {
      throw new Error("Workflow name is required.");
    }
    const payload = await context.apiPost("/assistant/workflows/save", {
      workflow: draft,
    });
    const savedWorkflow = payload.workflow || null;
    renderOutput(state, payload);
    await loadWorkflows(false, savedWorkflow?.id || draft.id);
    panel.setStatus(`Workflow '${savedWorkflow?.name || draft.name}' saved.`);
  }

  async function deleteWorkflow() {
    const workflowId = asString(state.workflowId.value, "").trim();
    const workflow = getWorkflowById(workflowId);
    if (!workflowId) {
      throw new Error("Select a workflow first.");
    }
    if (workflow?.builtIn) {
      throw new Error("Built-in workflows cannot be deleted.");
    }
    const payload = await context.apiPost("/assistant/workflows/delete", {
      workflowId,
    });
    renderOutput(state, payload);
    await loadWorkflows(false);
    panel.setStatus(`Workflow '${workflow?.name || workflowId}' deleted.`);
  }

  async function generateWorkflowConfig() {
    const description = asString(state.workflowDescription.value, "").trim();
    if (!description) {
      throw new Error("Describe what the workflow should do before generating.");
    }
    const currentDraft = draftFromForm(state);
    const payload = await context.apiPost("/assistant/workflows/generate-config", {
      description,
    });
    renderOutput(state, payload);
    const suggested = payload.suggestedWorkflow || payload.result?.suggestedWorkflow || null;
    if (!suggested) {
      throw new Error("Assistant did not return a suggested workflow config.");
    }
    const normalized = normalizeWorkflowDraft(suggested);

    // Preserve identity fields selected by the operator.
    state.workflowDescription.value = normalized.description || currentDraft.description || "";
    state.workflowSystemPrompt.value = normalized.systemPrompt || currentDraft.systemPrompt || "";
    state.workflowSeedPrompt.value = normalized.seedPrompt || currentDraft.seedPrompt || "";
    state.workflowInputPlaceholder.value = normalized.inputPlaceholder || currentDraft.inputPlaceholder || "";
    state.workflowRagEnabled.checked = Boolean(normalized.ragEnabled);
    state.workflowAllowWebSearch.checked = Boolean(normalized.allowWebSearch);
    state.workflowAutoLock.checked = Boolean(normalized.autoLockOnThreat);
    state.workflowThreatThreshold.value = String(normalized.threatScoreThreshold || currentDraft.threatScoreThreshold || 80);
    state.workflowConfigJson.value = JSON.stringify(normalized.config || currentDraft.config || {}, null, 2);

    panel.setStatus("Generated workflow configuration suggestion (name and type unchanged).");
  }

  async function sendChatMessage() {
    const message = asString(state.chatInput.value, "").trim();
    if (!message) {
      return;
    }
    if (state.chatSection.hidden) {
      throw new Error("Launch workflow before sending chat messages.");
    }
    const workflow = activeWorkflowFromForm();
    if (!workflow.name) {
      throw new Error("Set workflow name before running chat.");
    }

    pushChatMessage(state, "user", message);
    state.chatInput.value = "";

    const payload = await context.apiPost("/assistant/workflows/chat", {
      workflowId: workflow.id,
      workflow,
      message,
      applyLockdown: true,
    });
    renderOutput(state, payload);
    const replyText =
      payload.result?.reply ||
      payload.result?.summary ||
      payload.result?.assistantNarrative ||
      "Workflow completed. Check output for details.";
    pushChatMessage(state, "assistant", replyText);
    panel.setStatus("Workflow chat response received.");
    await context.refreshManager();
  }

  state.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await context.saveConfigPatch(toConfigPatch(state), "Intelligence configuration saved.");
      panel.setStatus("Intelligence configuration saved.");
      await loadStatus();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.configureButton.addEventListener("click", () => {
    showConfigSection();
  });
  state.planButton.addEventListener("click", () => {
    showPlanSection();
  });
  state.agentButton.addEventListener("click", () => {
    showAgentSection();
  });
  state.workflowsButton.addEventListener("click", () => {
    showWorkflowSection();
    hideChatSection();
  });
  state.openChatPopoutButton.addEventListener("click", () => {
    try {
      const selected = asString(state.menuWorkflowSelect.value, "") || asString(state.workflowSelect.value, "");
      openWorkflowChatPopup(selected);
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });
  state.closeConfigButton.addEventListener("click", () => {
    showConfigSection(false);
  });
  state.closePlanButton.addEventListener("click", () => {
    showPlanSection(false);
  });
  state.closeAgentButton.addEventListener("click", () => {
    showAgentSection(false);
  });
  state.closeWorkflowButton.addEventListener("click", () => {
    showWorkflowSection(false);
    hideChatSection();
  });

  state.refreshButton.addEventListener("click", async () => {
    try {
      await loadStatus(true);
      await loadWorkflows(false);
      await loadPlanRuns(false);
      await loadAgentCatalog();
      await loadAgents(false);
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.planRefresh.addEventListener("click", async () => {
    try {
      await loadPlanRuns(true);
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.planCreate.addEventListener("click", async () => {
    try {
      await createPlanRun();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.planCollect.addEventListener("click", async () => {
    try {
      await collectPlanEvidence();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.planRefine.addEventListener("click", async () => {
    try {
      await refinePlanRun();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.planRunSelect.addEventListener("change", async () => {
    try {
      const runId = asString(state.planRunSelect.value, "");
      runtime.selectedPlanRunId = runId;
      await loadPlanRun(runId);
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.agentRefresh.addEventListener("click", async () => {
    try {
      await loadAgentCatalog();
      await loadAgents(true);
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.agentTokenCreate.addEventListener("click", async () => {
    try {
      await createAgentScopedToken();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.agentTokenRevoke.addEventListener("click", async () => {
    try {
      await revokeAgentScopedToken();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.agentGenerate.addEventListener("click", async () => {
    try {
      await generateAgentDraft();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.agentValidate.addEventListener("click", async () => {
    try {
      await validateAgentDraft();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.agentSave.addEventListener("click", async () => {
    try {
      await saveAgentDraft();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.agentDelete.addEventListener("click", async () => {
    try {
      await deleteAgentDraft();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.agentSelect.addEventListener("change", () => {
    const selectedAgentId = asString(state.agentSelect.value, "");
    runtime.selectedAgentId = selectedAgentId;
    const selectedAgent = runtime.agents.find((entry) => entry.id === selectedAgentId) || null;
    applyAgentDraftToForm(selectedAgent);
    if (selectedAgent) {
      panel.setStatus(`Selected scaffold agent '${selectedAgent.name}'.`);
    }
  });

  state.assistantOllamaAutodetectBtn.addEventListener("click", async () => {
    try {
      const payload = await context.apiPost("/config/assistant-ollama-url-autodetect", {});
      const detectedUrl = asString(payload?.assistantOllamaUrl, "").trim();
      if (!detectedUrl) {
        throw new Error("Autodetect did not return an Ollama URL.");
      }
      state.assistantOllamaUrl.value = detectedUrl;

      const health = payload?.health || {};
      const checkState = health.statusCode
        ? `HTTP ${health.statusCode}`
        : health.error
          ? `unreachable (${health.error})`
          : "unknown";
      panel.setStatus(
        `Autodetected ASSISTANT_OLLAMA_URL=${detectedUrl} (${checkState}). Save Intelligence Config to persist.`,
      );
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.menuWorkflowSelect.addEventListener("change", () => {
    const selected = asString(state.menuWorkflowSelect.value, "");
    if (!selected) {
      return;
    }
    state.workflowSelect.value = selected;
    runtime.selectedWorkflowId = selected;
    const selectedWorkflow = getWorkflowById(selected);
    if (selectedWorkflow) {
      populateWorkflowForm(state, selectedWorkflow);
      hideChatSection();
      panel.setStatus(`Selected workflow '${selectedWorkflow.name}'. Click Launch Workflow to open chat.`);
    }
  });

  state.workflowSelect.addEventListener("change", () => {
    runtime.selectedWorkflowId = asString(state.workflowSelect.value, "");
    state.menuWorkflowSelect.value = runtime.selectedWorkflowId;
    const selected = getWorkflowById(runtime.selectedWorkflowId);
    if (!selected) {
      return;
    }
    populateWorkflowForm(state, selected);
    hideChatSection();
    panel.setStatus(`Selected workflow '${selected.name}'. Click Launch Workflow to start chat.`);
  });

  state.workflowLaunch.addEventListener("click", () => {
    try {
      openWorkflowChatPopup(asString(state.workflowSelect.value, ""));
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.workflowNew.addEventListener("click", () => {
    populateWorkflowForm(state, {
      id: "",
      name: "",
      type: "custom",
      description: "",
      systemPrompt:
        "You are a Blastdoor workflow assistant. Return concise, secure, operationally-safe guidance.",
      seedPrompt: "Describe what you need this workflow to do.",
      inputPlaceholder: "Enter workflow request details.",
      ragEnabled: false,
      allowWebSearch: false,
      autoLockOnThreat: false,
      threatScoreThreshold: 80,
      config: {},
      builtIn: false,
    });
    hideChatSection();
    panel.setStatus("Creating new workflow.");
  });

  state.workflowSave.addEventListener("click", async () => {
    try {
      await saveWorkflow();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.workflowDelete.addEventListener("click", async () => {
    try {
      await deleteWorkflow();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.workflowGenerate.addEventListener("click", async () => {
    try {
      await generateWorkflowConfig();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.chatSend.addEventListener("click", async () => {
    try {
      await sendChatMessage();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
      pushChatMessage(state, "assistant", `Error: ${error?.message || String(error)}`);
    }
  });

  state.chatInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    try {
      await sendChatMessage();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
      pushChatMessage(state, "assistant", `Error: ${error?.message || String(error)}`);
    }
  });

  showConfigSection(false);
  showPlanSection(false);
  showAgentSection(false);
  showWorkflowSection(false);

  try {
    await loadStatus();
    await loadWorkflows();
    await loadPlanRuns(false);
    await loadAgentCatalog();
    await loadAgents(false);
  } catch (error) {
    panel.setStatus(error?.message || String(error), true);
  }

  return {
    async onRefresh() {
      runtime.refreshTick += 1;
      if (!runtime.statusLoadedOnce) {
        await loadStatus();
        await loadWorkflows();
        await loadPlanRuns(false);
        await loadAgentCatalog();
        await loadAgents(false);
        return;
      }
      if (runtime.refreshTick % 10 === 0) {
        await loadStatus();
      }
    },
  };
}

export default registerManagerPlugin;
