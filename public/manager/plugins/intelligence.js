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
}

function renderOutput(state, payload) {
  state.output.textContent = JSON.stringify(payload || {}, null, 2);
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
    assistantOllamaModel: root.querySelector("[data-intel-assistant-ollama-model]"),
    assistantTimeoutMs: root.querySelector("[data-intel-assistant-timeout-ms]"),
    assistantRetryMaxAttempts: root.querySelector("[data-intel-assistant-retry-max-attempts]"),
    assistantRagEnabled: root.querySelector("[data-intel-assistant-rag-enabled]"),
    assistantAllowWebSearch: root.querySelector("[data-intel-assistant-web-search]"),
    assistantAutoLockOnThreat: root.querySelector("[data-intel-assistant-auto-lock]"),
    assistantThreatScoreThreshold: root.querySelector("[data-intel-assistant-threat-threshold]"),
    configureButton: root.querySelector("[data-intel-open-config]"),
    workflowsButton: root.querySelector("[data-intel-open-workflows]"),
    openChatPopoutButton: root.querySelector("[data-intel-open-chat-popout]"),
    menuWorkflowSelect: root.querySelector("[data-intel-menu-workflow-select]"),
    configSection: root.querySelector("[data-intel-config-section]"),
    workflowsSection: root.querySelector("[data-intel-workflow-section]"),
    closeConfigButton: root.querySelector("[data-intel-close-config]"),
    closeWorkflowButton: root.querySelector("[data-intel-close-workflow]"),
    refreshButton: root.querySelector("[data-intel-action-refresh]"),
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
    "assistantOllamaModel",
    "assistantTimeoutMs",
    "assistantRetryMaxAttempts",
    "assistantRagEnabled",
    "assistantAllowWebSearch",
    "assistantAutoLockOnThreat",
    "assistantThreatScoreThreshold",
    "configureButton",
    "workflowsButton",
    "openChatPopoutButton",
    "menuWorkflowSelect",
    "configSection",
    "workflowsSection",
    "closeConfigButton",
    "closeWorkflowButton",
    "refreshButton",
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
            <input type="text" data-intel-assistant-ollama-url />
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
  for (const workflow of workflows) {
    const menuOption = document.createElement("option");
    menuOption.value = workflow.id;
    menuOption.textContent = `${workflow.name} (${workflow.type})`;
    state.menuWorkflowSelect.append(menuOption);

    const option = document.createElement("option");
    option.value = workflow.id;
    option.textContent = `${workflow.name} (${workflow.type})`;
    state.workflowSelect.append(option);
  }
  if (selectedId && workflows.some((workflow) => workflow.id === selectedId)) {
    state.menuWorkflowSelect.value = selectedId;
    state.workflowSelect.value = selectedId;
  } else if (workflows[0]) {
    state.menuWorkflowSelect.value = workflows[0].id;
    state.workflowSelect.value = workflows[0].id;
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
  state.closeWorkflowButton.addEventListener("click", () => {
    showWorkflowSection(false);
    hideChatSection();
  });

  state.refreshButton.addEventListener("click", async () => {
    try {
      await loadStatus(true);
      await loadWorkflows(false);
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
  showWorkflowSection(false);

  try {
    await loadStatus();
    await loadWorkflows();
  } catch (error) {
    panel.setStatus(error?.message || String(error), true);
  }

  return {
    async onRefresh() {
      runtime.refreshTick += 1;
      if (!runtime.statusLoadedOnce) {
        await loadStatus();
        await loadWorkflows();
        return;
      }
      if (runtime.refreshTick % 10 === 0) {
        await loadStatus();
      }
    },
  };
}

export default registerManagerPlugin;
