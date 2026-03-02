import {
  asString,
  slugifyName,
  toConfigPatch,
  applyConfigValues,
  renderOutput,
  renderPlanOutput,
  renderWizardOutput,
  renderWizardQuestion,
  renderWizardExecutionSteps,
  renderWizardRuns,
  renderWizardStepRail,
  findPendingQuestion,
  showWizardSafeCard,
  setWizardEntryVisibility,
  showSection,
  pushChatMessage,
  normalizeWorkflowDraft,
  draftFromForm,
  populateWorkflowForm,
} from "./intelligence/shared.js";

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
    wizardCreateButton: root.querySelector("[data-intel-open-wizard-create]"),
    wizardModifyButton: root.querySelector("[data-intel-open-wizard-modify]"),
    advancedButton: root.querySelector("[data-intel-open-advanced]"),
    advancedMenu: root.querySelector("[data-intel-advanced-menu]"),
    configureButton: root.querySelector("[data-intel-open-config]"),
    planButton: root.querySelector("[data-intel-open-plan]"),
    workflowsButton: root.querySelector("[data-intel-open-workflows]"),
    openChatPopoutButton: root.querySelector("[data-intel-open-chat-popout]"),
    menuWorkflowSelect: root.querySelector("[data-intel-menu-workflow-select]"),
    wizardSection: root.querySelector("[data-intel-wizard-section]"),
    closeWizardButton: root.querySelector("[data-intel-close-wizard]"),
    wizardPrompt: root.querySelector("[data-intel-wizard-prompt]"),
    wizardSteps: root.querySelector("[data-intel-wizard-steps]"),
    wizardEntry: root.querySelector("[data-intel-wizard-entry]"),
    wizardEntryName: root.querySelector("[data-intel-wizard-entry-name]"),
    wizardEntryGoal: root.querySelector("[data-intel-wizard-entry-goal]"),
    wizardEntryQuestion: root.querySelector("[data-intel-wizard-entry-question]"),
    wizardEntryManual: root.querySelector("[data-intel-wizard-entry-manual]"),
    wizardEntryExec: root.querySelector("[data-intel-wizard-entry-exec]"),
    wizardEntryInfo: root.querySelector("[data-intel-wizard-entry-info]"),
    wizardStepInfo: root.querySelector("[data-intel-wizard-step-info]"),
    wizardRunSelect: root.querySelector("[data-intel-wizard-run-select]"),
    wizardRefresh: root.querySelector("[data-intel-wizard-refresh]"),
    wizardName: root.querySelector("[data-intel-wizard-name]"),
    wizardGoal: root.querySelector("[data-intel-wizard-goal]"),
    wizardQuestion: root.querySelector("[data-intel-wizard-question]"),
    wizardAnswerOptionWrap: root.querySelector("[data-intel-wizard-answer-option-wrap]"),
    wizardAnswerOption: root.querySelector("[data-intel-wizard-answer-option]"),
    wizardAnswer: root.querySelector("[data-intel-wizard-answer]"),
    wizardStepResult: root.querySelector("[data-intel-wizard-step-result]"),
    wizardExecList: root.querySelector("[data-intel-wizard-exec-list]"),
    wizardBack: root.querySelector("[data-intel-wizard-back]"),
    wizardSave: root.querySelector("[data-intel-wizard-save]"),
    wizardNext: root.querySelector("[data-intel-wizard-next]"),
    wizardOutput: root.querySelector("[data-intel-wizard-output]"),
    wizardSafeCard: root.querySelector("[data-intel-wizard-safe-card]"),
    wizardSafeSummary: root.querySelector("[data-intel-wizard-safe-summary]"),
    wizardSafeRemember: root.querySelector("[data-intel-wizard-safe-remember]"),
    wizardSafeApprove: root.querySelector("[data-intel-wizard-safe-approve]"),
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
    "wizardCreateButton",
    "wizardModifyButton",
    "advancedButton",
    "advancedMenu",
    "configureButton",
    "planButton",
    "workflowsButton",
    "openChatPopoutButton",
    "menuWorkflowSelect",
    "wizardSection",
    "closeWizardButton",
    "wizardPrompt",
    "wizardSteps",
    "wizardEntry",
    "wizardEntryName",
    "wizardEntryGoal",
    "wizardEntryQuestion",
    "wizardEntryManual",
    "wizardEntryExec",
    "wizardEntryInfo",
    "wizardStepInfo",
    "wizardRunSelect",
    "wizardRefresh",
    "wizardName",
    "wizardGoal",
    "wizardQuestion",
    "wizardAnswerOptionWrap",
    "wizardAnswerOption",
    "wizardAnswer",
    "wizardStepResult",
    "wizardExecList",
    "wizardBack",
    "wizardSave",
    "wizardNext",
    "wizardOutput",
    "wizardSafeCard",
    "wizardSafeSummary",
    "wizardSafeRemember",
    "wizardSafeApprove",
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
        <button type="button" data-intel-open-wizard-create>Create Agent Workflow</button>
        <button type="button" data-intel-open-wizard-modify>Modify Existing Workflow</button>
        <button type="button" class="secondary" data-intel-open-advanced>Advanced Panels</button>
      </div>
      <div class="grid">
        <label>Workflow to Launch
          <select data-intel-menu-workflow-select></select>
        </label>
      </div>
      <div class="button-row">
        <button type="button" data-intel-open-chat-popout>Launch Workflow</button>
      </div>
      <section class="intel-advanced-menu hidden" data-intel-advanced-menu hidden>
        <div class="button-row">
          <button type="button" class="secondary" data-intel-open-plan>Phase 0 Plan Lab (Advanced)</button>
          <button type="button" class="secondary" data-intel-open-agent>Agent Scaffolding (Advanced)</button>
          <button type="button" class="secondary" data-intel-open-workflows>Create/Manage Workflow Templates</button>
        </div>
      </section>
    </section>

    <section class="intel-wizard-wrap hidden" data-intel-wizard-section hidden>
      <div class="intel-section-header">
        <h3>Guided Agent Workflow Wizard</h3>
        <button type="button" class="secondary" data-intel-close-wizard>Close</button>
      </div>
      <div class="intel-wizard-banner" data-intel-wizard-prompt>
        Select Create Agent Workflow or Modify Existing Workflow to begin.
      </div>
      <div class="intel-wizard-layout">
        <section class="intel-wizard-rail-pane">
          <ol class="intel-step-rail" data-intel-wizard-steps>
            <li data-intel-wizard-step-item="define_name">1. Define Name</li>
            <li data-intel-wizard-step-item="define_goal">2. Define Goal</li>
            <li data-intel-wizard-step-item="create_initial_plan">3. Create Initial Plan</li>
            <li data-intel-wizard-step-item="clarify_round">4. Clarify Round</li>
            <li data-intel-wizard-step-item="sufficiency_gate">5. Sufficiency Gate</li>
            <li data-intel-wizard-step-item="collect_evidence">6. Collect Evidence</li>
            <li data-intel-wizard-step-item="refine_layer">7. Refine Layer</li>
            <li data-intel-wizard-step-item="execution_prep">8. Execution Prep</li>
            <li data-intel-wizard-step-item="execute_steps">9. Execute Steps</li>
            <li data-intel-wizard-step-item="completed">10. Completed</li>
          </ol>
          <div class="grid">
            <label>Saved Workflow Runs
              <select data-intel-wizard-run-select></select>
            </label>
            <div class="intel-workflow-launch-cell">
              <button type="button" class="secondary" data-intel-wizard-refresh>Refresh Runs</button>
            </div>
          </div>
        </section>
        <section class="intel-wizard-entry-pane" data-intel-wizard-entry>
          <div class="intel-wizard-entry-block" data-intel-wizard-entry-name>
            <label>Workflow Name
              <input type="text" data-intel-wizard-name placeholder="TLS rollout workflow" />
            </label>
          </div>
          <div class="intel-wizard-entry-block hidden" data-intel-wizard-entry-goal hidden>
            <label>Workflow Goal
              <textarea data-intel-wizard-goal placeholder="Describe the workflow objective and expected outcome."></textarea>
            </label>
          </div>
          <div class="intel-wizard-entry-block hidden" data-intel-wizard-entry-question hidden>
            <label>Clarifying Question
              <textarea data-intel-wizard-question readonly placeholder="Questions from the assistant will appear here."></textarea>
            </label>
            <label class="hidden" data-intel-wizard-answer-option-wrap hidden>Suggested Answers
              <select data-intel-wizard-answer-option></select>
            </label>
            <label>Answer
              <textarea data-intel-wizard-answer placeholder="Enter answer for the current clarifying question."></textarea>
            </label>
          </div>
          <div class="intel-wizard-entry-block hidden" data-intel-wizard-entry-manual hidden>
            <label>Manual Step Result
              <textarea data-intel-wizard-step-result placeholder="For manual steps, paste results before clicking Next."></textarea>
            </label>
          </div>
          <div class="intel-wizard-entry-block hidden" data-intel-wizard-entry-exec hidden>
            <h4>Execution Steps</h4>
            <div class="intel-wizard-exec-list" data-intel-wizard-exec-list></div>
          </div>
          <div class="intel-wizard-entry-block hidden" data-intel-wizard-entry-info hidden>
            <div class="muted" data-intel-wizard-step-info></div>
          </div>
        </section>
      </div>
      <section class="intel-safe-action-card hidden" data-intel-wizard-safe-card hidden>
        <h4>Safe Action Approval Required</h4>
        <div class="muted" data-intel-wizard-safe-summary></div>
        <label class="checkbox-label">
          <input type="checkbox" data-intel-wizard-safe-remember />
          Do not ask again for this task in this workflow on this host
        </label>
        <div class="button-row">
          <button type="button" data-intel-wizard-safe-approve>Approve and Run Safe Action</button>
        </div>
      </section>
      <div class="button-row">
        <button type="button" class="secondary" data-intel-wizard-back>Back</button>
        <button type="button" class="secondary" data-intel-wizard-save>Save</button>
        <button type="button" data-intel-wizard-next>Next</button>
      </div>
      <pre class="log-box" data-intel-wizard-output></pre>
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
    wizardRuns: [],
    selectedWizardRunId: "",
    currentWizardRun: null,
    wizardMode: "create",
    pendingSafeAction: null,
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

  function showWizardSection(forceVisible = null) {
    const nextVisible = forceVisible === null ? state.wizardSection.hidden : Boolean(forceVisible);
    showSection(state.wizardSection, nextVisible);
  }

  function showAdvancedMenu(forceVisible = null) {
    const nextVisible = forceVisible === null ? state.advancedMenu.hidden : Boolean(forceVisible);
    showSection(state.advancedMenu, nextVisible);
  }

  function hideChatSection() {
    showSection(state.chatSection, false);
    runtime.launchedWorkflowId = "";
  }

  function applyWizardRun(run, payload = {}) {
    runtime.currentWizardRun = run && typeof run === "object" ? run : null;
    runtime.selectedWizardRunId = asString(runtime.currentWizardRun?.runId, "");
    const runName = asString(runtime.currentWizardRun?.meta?.runName, asString(runtime.currentWizardRun?.runName, ""));
    const goal = asString(runtime.currentWizardRun?.goal, "");
    state.wizardName.value = runName;
    state.wizardGoal.value = goal;
    const wizard = runtime.currentWizardRun?.wizard && typeof runtime.currentWizardRun.wizard === "object"
      ? runtime.currentWizardRun.wizard
      : {};
    renderWizardStepRail(state, wizard);
    state.wizardPrompt.textContent = asString(wizard.nextPrompt, "Select the next step to continue.");
    const pendingQuestion = findPendingQuestion(runtime.currentWizardRun);
    renderWizardQuestion(state, pendingQuestion, runtime.currentWizardRun);
    renderWizardExecutionSteps(state, runtime.currentWizardRun);
    setWizardEntryVisibility(state, runtime.currentWizardRun);
    showWizardSafeCard(state, payload.requiredAction || null);
    runtime.pendingSafeAction = payload.requiredAction || null;
    renderWizardOutput(state, payload && Object.keys(payload).length > 0 ? payload : { ok: true, run: runtime.currentWizardRun });
  }

  async function loadWizardRuns(showMessage = false, preferredRunId = "") {
    const payload = await context.apiGet("/assistant/wizard/runs?limit=50");
    const runs = Array.isArray(payload.runs) ? payload.runs : [];
    runtime.wizardRuns = runs;
    renderWizardRuns(state, runs, preferredRunId || runtime.selectedWizardRunId);
    runtime.selectedWizardRunId = asString(state.wizardRunSelect.value, "");
    if (showMessage) {
      panel.setStatus(`Loaded ${runs.length} wizard run(s).`);
    }
  }

  async function loadWizardRun(runId, showMessage = false) {
    const selectedRunId = asString(runId || state.wizardRunSelect.value, "");
    if (!selectedRunId) {
      runtime.currentWizardRun = null;
      renderWizardOutput(state, { ok: true, run: null });
      return;
    }
    const payload = await context.apiGet(`/assistant/wizard/${encodeURIComponent(selectedRunId)}`);
    applyWizardRun(payload.run || null, payload);
    runtime.selectedWizardRunId = selectedRunId;
    if (showMessage) {
      panel.setStatus(`Loaded wizard run '${selectedRunId}'.`);
    }
  }

  async function startWizardRun({ mode = "create" } = {}) {
    const runName = asString(state.wizardName.value, "").trim();
    const payload = await context.apiPost("/assistant/wizard/start", {
      runName,
      workflowId: asString(state.menuWorkflowSelect.value, "").trim(),
    });
    runtime.wizardMode = mode;
    await loadWizardRuns(false, asString(payload?.run?.runId, ""));
    applyWizardRun(payload.run || null, payload);
    panel.setStatus("Wizard run started.");
  }

  async function saveWizardRun() {
    const runId = asString(runtime.currentWizardRun?.runId, "");
    if (!runId) {
      throw new Error("Start or select a workflow run before saving.");
    }
    const payload = await context.apiPost(`/assistant/wizard/${encodeURIComponent(runId)}/save`, {
      runName: asString(state.wizardName.value, "").trim(),
      goal: asString(state.wizardGoal.value, "").trim(),
      workflowId: asString(state.menuWorkflowSelect.value, "").trim(),
    });
    applyWizardRun(payload.run || null, payload);
    await loadWizardRuns(false, asString(payload?.run?.runId, runId));
    panel.setStatus("Wizard state saved.");
  }

  async function submitPendingWizardAnswer(runId) {
    const questionId = asString(state.wizardQuestion.getAttribute("data-intel-wizard-question-id"), "");
    const typedAnswer = asString(state.wizardAnswer.value, "").trim();
    const selectedOption = asString(state.wizardAnswerOption.value, "").trim();
    const answer = typedAnswer || selectedOption;
    if (!questionId || !answer) {
      return;
    }
    const payload = await context.apiPost(`/assistant/wizard/${encodeURIComponent(runId)}/answer`, {
      questionId,
      answer,
    });
    state.wizardAnswer.value = "";
    applyWizardRun(payload.run || null, payload);
  }

  function buildExecutionCompletionPayload(run) {
    const wizard = run?.wizard && typeof run.wizard === "object" ? run.wizard : {};
    if (asString(wizard.currentStep, "") !== "execute_steps") {
      return {};
    }
    const steps = Array.isArray(wizard?.execution?.steps) ? wizard.execution.steps : [];
    const firstIncomplete = steps.find((step) => step && step.completed !== true) || null;
    if (!firstIncomplete) {
      return {};
    }
    const stepResult = asString(state.wizardStepResult.value, "").trim();
    if (firstIncomplete.mode === "manual" || firstIncomplete.mode === "manual-risky") {
      if (!stepResult) {
        return {};
      }
      return {
        completeStepId: asString(firstIncomplete.id, ""),
        result: stepResult,
      };
    }
    return {};
  }

  async function moveWizardNext() {
    if (!runtime.currentWizardRun) {
      await startWizardRun({ mode: runtime.wizardMode || "create" });
    }
    const runId = asString(runtime.currentWizardRun?.runId, "");
    if (!runId) {
      throw new Error("Unable to resolve wizard run.");
    }

    await submitPendingWizardAnswer(runId);
    const completionPatch = buildExecutionCompletionPayload(runtime.currentWizardRun);
    const operatorMessage = asString(state.wizardStepResult.value, "").trim();
    const payload = await context.apiPost(`/assistant/wizard/${encodeURIComponent(runId)}/next`, {
      runName: asString(state.wizardName.value, "").trim(),
      goal: asString(state.wizardGoal.value, "").trim(),
      workflowId: asString(state.menuWorkflowSelect.value, "").trim(),
      message: operatorMessage,
      note: operatorMessage,
      ...completionPatch,
    });
    state.wizardStepResult.value = "";
    if (payload.awaitingAction) {
      if (payload.requiredStep && !payload.requiredAction) {
        panel.setStatus(
          `Manual action required: ${asString(payload.requiredStep.title, "step")}. Paste result, then click Next.`,
          true,
        );
      }
      applyWizardRun(payload.run || runtime.currentWizardRun, payload);
      panel.setStatus("Action required before continuing.", true);
      return;
    }
    applyWizardRun(payload.run || null, payload);
    await loadWizardRuns(false, asString(payload?.run?.runId, runId));
    panel.setStatus("Moved to next wizard step.");
  }

  async function moveWizardBack() {
    const runId = asString(runtime.currentWizardRun?.runId, "");
    if (!runId) {
      throw new Error("Select a wizard run first.");
    }
    const payload = await context.apiPost(`/assistant/wizard/${encodeURIComponent(runId)}/back`, {});
    applyWizardRun(payload.run || null, payload);
    await loadWizardRuns(false, asString(payload?.run?.runId, runId));
    panel.setStatus("Moved back one wizard step.");
  }

  async function approveWizardSafeAction() {
    const runId = asString(runtime.currentWizardRun?.runId, "");
    const actionId = asString(runtime.pendingSafeAction?.actionId, "");
    if (!runId || !actionId) {
      throw new Error("No pending safe action is waiting for approval.");
    }
    const payload = await context.apiPost(`/assistant/wizard/${encodeURIComponent(runId)}/run-safe-action`, {
      actionId,
      approved: true,
      rememberTrust: Boolean(state.wizardSafeRemember.checked),
    });
    applyWizardRun(payload.run || null, payload);
    await loadWizardRuns(false, asString(payload?.run?.runId, runId));
    panel.setStatus("Safe action executed.");
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

  state.wizardCreateButton.addEventListener("click", async () => {
    try {
      runtime.wizardMode = "create";
      showWizardSection(true);
      await startWizardRun({ mode: "create" });
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.wizardModifyButton.addEventListener("click", async () => {
    try {
      runtime.wizardMode = "modify";
      showWizardSection(true);
      await loadWizardRuns(true);
      if (runtime.selectedWizardRunId) {
        await loadWizardRun(runtime.selectedWizardRunId);
      } else {
        renderWizardOutput(state, { ok: true, runs: [] });
      }
      panel.setStatus("Select an existing run and continue the wizard.");
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.closeWizardButton.addEventListener("click", () => {
    showWizardSection(false);
    runtime.pendingSafeAction = null;
    showWizardSafeCard(state, null);
  });

  state.wizardRefresh.addEventListener("click", async () => {
    try {
      await loadWizardRuns(true);
      if (runtime.selectedWizardRunId) {
        await loadWizardRun(runtime.selectedWizardRunId);
      }
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.wizardRunSelect.addEventListener("change", async () => {
    try {
      const runId = asString(state.wizardRunSelect.value, "");
      runtime.selectedWizardRunId = runId;
      await loadWizardRun(runId, true);
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.wizardBack.addEventListener("click", async () => {
    try {
      await moveWizardBack();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.wizardSave.addEventListener("click", async () => {
    try {
      await saveWizardRun();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.wizardNext.addEventListener("click", async () => {
    try {
      await moveWizardNext();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.wizardSafeApprove.addEventListener("click", async () => {
    try {
      await approveWizardSafeAction();
    } catch (error) {
      panel.setStatus(error?.message || String(error), true);
    }
  });

  state.wizardAnswerOption.addEventListener("change", () => {
    const selected = asString(state.wizardAnswerOption.value, "");
    if (selected) {
      state.wizardAnswer.value = selected;
    }
  });

  state.advancedButton.addEventListener("click", () => {
    showAdvancedMenu();
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
      await loadWizardRuns(false);
      if (runtime.selectedWizardRunId) {
        await loadWizardRun(runtime.selectedWizardRunId);
      }
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
  showWizardSection(false);
  showAdvancedMenu(false);
  showPlanSection(false);
  showAgentSection(false);
  showWorkflowSection(false);
  showWizardSafeCard(state, null);

  try {
    await loadStatus();
    await loadWorkflows();
    await loadPlanRuns(false);
    await loadAgentCatalog();
    await loadAgents(false);
    await loadWizardRuns(false);
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
