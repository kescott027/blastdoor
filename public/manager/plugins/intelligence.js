const DEFAULTS = {
  ASSISTANT_ENABLED: "true",
  ASSISTANT_PROVIDER: "heuristic",
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

function toConfigPatch(state) {
  return {
    ASSISTANT_ENABLED: state.assistantEnabled.checked ? "true" : "false",
    ASSISTANT_PROVIDER: asString(state.assistantProvider.value, DEFAULTS.ASSISTANT_PROVIDER).trim() || "heuristic",
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
  state.assistantEnabled.checked = asBooleanString(
    config.ASSISTANT_ENABLED,
    DEFAULTS.ASSISTANT_ENABLED,
  ) === "true";
  state.assistantProvider.value = asString(
    config.ASSISTANT_PROVIDER,
    DEFAULTS.ASSISTANT_PROVIDER,
  );
  state.assistantUrl.value = asString(config.ASSISTANT_URL, DEFAULTS.ASSISTANT_URL);
  state.assistantToken.value = "";
  state.assistantOllamaUrl.value = asString(
    config.ASSISTANT_OLLAMA_URL,
    DEFAULTS.ASSISTANT_OLLAMA_URL,
  );
  state.assistantOllamaModel.value = asString(
    config.ASSISTANT_OLLAMA_MODEL,
    DEFAULTS.ASSISTANT_OLLAMA_MODEL,
  );
  state.assistantTimeoutMs.value = asIntegerString(
    config.ASSISTANT_TIMEOUT_MS,
    DEFAULTS.ASSISTANT_TIMEOUT_MS,
  );
  state.assistantRetryMaxAttempts.value = asIntegerString(
    config.ASSISTANT_RETRY_MAX_ATTEMPTS,
    DEFAULTS.ASSISTANT_RETRY_MAX_ATTEMPTS,
  );
  state.assistantRagEnabled.checked = asBooleanString(
    config.ASSISTANT_RAG_ENABLED,
    DEFAULTS.ASSISTANT_RAG_ENABLED,
  ) === "true";
  state.assistantAllowWebSearch.checked = asBooleanString(
    config.ASSISTANT_ALLOW_WEB_SEARCH,
    DEFAULTS.ASSISTANT_ALLOW_WEB_SEARCH,
  ) === "true";
  state.assistantAutoLockOnThreat.checked = asBooleanString(
    config.ASSISTANT_AUTO_LOCK_ON_THREAT,
    DEFAULTS.ASSISTANT_AUTO_LOCK_ON_THREAT,
  ) === "true";
  state.assistantThreatScoreThreshold.value = asIntegerString(
    config.ASSISTANT_THREAT_SCORE_THRESHOLD,
    DEFAULTS.ASSISTANT_THREAT_SCORE_THRESHOLD,
  );
}

function renderOutput(state, payload) {
  state.output.textContent = JSON.stringify(payload || {}, null, 2);
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
    refreshButton: root.querySelector("[data-intel-action-refresh]"),
    workflowConfigButton: root.querySelector("[data-intel-action-config]"),
    workflowTroubleshootButton: root.querySelector("[data-intel-action-troubleshoot]"),
    workflowThreatButton: root.querySelector("[data-intel-action-threat]"),
    workflowGrimoireButton: root.querySelector("[data-intel-action-grimoire]"),
    errorText: root.querySelector("[data-intel-error-text]"),
    intentText: root.querySelector("[data-intel-intent-text]"),
    applyLockdown: root.querySelector("[data-intel-apply-lockdown]"),
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
    "refreshButton",
    "workflowConfigButton",
    "workflowTroubleshootButton",
    "workflowThreatButton",
    "workflowGrimoireButton",
    "errorText",
    "intentText",
    "applyLockdown",
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
    <form class="intel-config-form" data-intel-form>
      <div class="grid">
        <label class="checkbox-label">
          <input type="checkbox" data-intel-assistant-enabled />
          Enable Intelligence Module
        </label>
        <label>Provider (heuristic|ollama)
          <input type="text" data-intel-assistant-provider />
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
      </div>
    </form>

    <section class="intel-workflows">
      <h3>Workflows</h3>
      <div class="button-row">
        <button type="button" data-intel-action-refresh>Refresh Status</button>
        <button type="button" data-intel-action-config>Config Recommendations</button>
        <button type="button" data-intel-action-troubleshoot>Troubleshoot Recommendation</button>
        <button type="button" data-intel-action-threat>Threat Monitor</button>
        <button type="button" data-intel-action-grimoire>Grimoire</button>
      </div>
      <label>Error Context (for Troubleshoot Recommendation)
        <textarea data-intel-error-text placeholder="Paste recent error logs or symptoms."></textarea>
      </label>
      <label>Intent (for Grimoire)
        <textarea data-intel-intent-text placeholder="Describe desired API workflow, e.g. create user and restart service."></textarea>
      </label>
      <label class="checkbox-label">
        <input type="checkbox" data-intel-apply-lockdown checked />
        Apply Lockdown automatically when threat workflow returns shouldLockdown=true
      </label>
    </section>

    <section class="intel-output-wrap">
      <h3>Output</h3>
      <pre class="log-box" data-intel-output></pre>
    </section>
  `;
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

  let refreshTick = 0;
  let statusLoadedOnce = false;

  async function loadStatus(showMessage = false) {
    const payload = await context.apiGet("/assistant/status");
    renderOutput(state, payload);
    applyConfigValues(state, payload.config || {});
    if (showMessage) {
      panel.setStatus("Assistant status loaded.");
    } else if (!statusLoadedOnce) {
      panel.setStatus("Assistant plugin ready.");
    }
    statusLoadedOnce = true;
  }

  async function runWorkflow(routePath, payload, successMessage) {
    const result = await context.apiPost(routePath, payload || {});
    renderOutput(state, result);
    panel.setStatus(successMessage);
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

  state.refreshButton.addEventListener("click", async () => {
    try {
      await loadStatus(true);
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.workflowConfigButton.addEventListener("click", async () => {
    try {
      await runWorkflow(
        "/assistant/workflow/config-recommendations",
        {},
        "Workflow 1 complete: configuration recommendations generated.",
      );
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.workflowTroubleshootButton.addEventListener("click", async () => {
    try {
      await runWorkflow(
        "/assistant/workflow/troubleshoot-recommendation",
        { errorText: asString(state.errorText.value, "") },
        "Workflow 2 complete: troubleshooting recommendations generated.",
      );
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.workflowThreatButton.addEventListener("click", async () => {
    try {
      await runWorkflow(
        "/assistant/workflow/threat-monitor",
        { applyLockdown: Boolean(state.applyLockdown.checked) },
        "Workflow 3 complete: threat monitoring analysis generated.",
      );
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.workflowGrimoireButton.addEventListener("click", async () => {
    try {
      await runWorkflow(
        "/assistant/workflow/grimoire",
        { intent: asString(state.intentText.value, "") },
        "Workflow 4 complete: Grimoire API blocks generated.",
      );
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  try {
    await loadStatus();
  } catch (error) {
    panel.setStatus(error?.message || String(error), true);
  }

  return {
    async onRefresh() {
      refreshTick += 1;
      if (!statusLoadedOnce) {
        await loadStatus();
        return;
      }
      if (refreshTick % 10 === 0) {
        await loadStatus();
      }
    },
  };
}

export default registerManagerPlugin;
