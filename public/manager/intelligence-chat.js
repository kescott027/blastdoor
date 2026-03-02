import {
  formatUnexpectedPayload,
  getApiBaseCandidates,
  resolveApiBasePath,
  resolveApiPath,
} from "./client-utils.js";

const workflowSelect = document.getElementById("workflowSelect");
const statusMessage = document.getElementById("statusMessage");
const chatLog = document.getElementById("chatLog");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");

const API_BASE = resolveApiBasePath(window.location.href);
const API_BASE_CANDIDATES = getApiBaseCandidates(API_BASE);

const runtime = {
  workflows: [],
  workflowMap: new Map(),
  selectedWorkflowId: "",
  launchedWorkflowId: "",
};

function setStatus(text, isError = false) {
  statusMessage.textContent = String(text || "");
  statusMessage.style.color = isError ? "#ff8a8a" : "#9be0ff";
}

function pushChatMessage(role, text) {
  const safeRole = role === "user" ? "user" : "assistant";
  const line = document.createElement("div");
  line.className = `chat-line chat-line-${safeRole}`;

  const roleLabel = document.createElement("span");
  roleLabel.className = "chat-role";
  roleLabel.textContent = safeRole === "user" ? "You" : "Assistant";

  const messageText = document.createElement("span");
  messageText.className = "chat-text";
  messageText.textContent = String(text || "");

  line.append(roleLabel);
  line.append(messageText);
  chatLog.append(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function clearChat() {
  chatLog.textContent = "";
}

function getWorkflowById(workflowId) {
  return runtime.workflowMap.get(String(workflowId || "")) || null;
}

async function api(method, routePath, body) {
  let lastError = null;
  for (let index = 0; index < API_BASE_CANDIDATES.length; index += 1) {
    const candidate = API_BASE_CANDIDATES[index];
    const hasFallback = index < API_BASE_CANDIDATES.length - 1;
    try {
      const response = await fetch(resolveApiPath(candidate, routePath), {
        method,
        headers: {
          "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const rawBody = await response.text();
      let payload = {};
      if (rawBody) {
        try {
          payload = JSON.parse(rawBody);
        } catch {
          const parseError = new Error(formatUnexpectedPayload(response, rawBody));
          if (hasFallback && response.status === 404) {
            lastError = parseError;
            continue;
          }
          throw parseError;
        }
      }

      if (!response.ok) {
        const requestError = new Error(payload.error || `Request failed (${response.status})`);
        if (hasFallback && response.status === 404) {
          lastError = requestError;
          continue;
        }
        throw requestError;
      }

      return payload;
    } catch (error) {
      if (hasFallback && error instanceof TypeError) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Request failed");
}

function renderWorkflowSelect(preferredWorkflowId = "") {
  workflowSelect.textContent = "";
  for (const workflow of runtime.workflows) {
    const option = document.createElement("option");
    option.value = workflow.id;
    option.textContent = `${workflow.name} (${workflow.type})`;
    workflowSelect.append(option);
  }

  const selected = preferredWorkflowId || runtime.selectedWorkflowId;
  if (selected && runtime.workflowMap.has(selected)) {
    workflowSelect.value = selected;
  } else if (runtime.workflows[0]) {
    workflowSelect.value = runtime.workflows[0].id;
  }
  runtime.selectedWorkflowId = String(workflowSelect.value || "");
}

function launchSelectedWorkflow() {
  const workflowId = String(workflowSelect.value || "");
  const workflow = getWorkflowById(workflowId);
  if (!workflow) {
    throw new Error("Select a workflow to launch.");
  }

  runtime.launchedWorkflowId = workflow.id;
  clearChat();
  const seedPrompt =
    String(workflow.seedPrompt || "").trim() ||
    `Workflow '${workflow.name}' launched. Provide message/context and I will execute this workflow.`;
  pushChatMessage("assistant", seedPrompt);
  setStatus(`Workflow '${workflow.name}' launched.`);
  chatInput.focus();
}

async function loadWorkflows(preferredWorkflowId = "", autoLaunch = false) {
  const payload = await api("GET", "/assistant/workflows");
  const workflows = Array.isArray(payload.workflowConfigs) ? payload.workflowConfigs : [];
  runtime.workflows = workflows;
  runtime.workflowMap = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  renderWorkflowSelect(preferredWorkflowId);
  setStatus(`Loaded ${workflows.length} workflow(s).`);

  if (autoLaunch && workflowSelect.value) {
    launchSelectedWorkflow();
  }
}

async function sendMessage() {
  const message = String(chatInput.value || "").trim();
  if (!message) {
    return;
  }

  const selectedWorkflowId = String(workflowSelect.value || "");
  const workflow = getWorkflowById(selectedWorkflowId);
  if (!workflow) {
    throw new Error("Select a workflow first.");
  }
  if (runtime.launchedWorkflowId !== selectedWorkflowId) {
    launchSelectedWorkflow();
  }

  pushChatMessage("user", message);
  chatInput.value = "";
  chatSendBtn.disabled = true;
  try {
    const payload = await api("POST", "/assistant/workflows/chat", {
      workflowId: workflow.id,
      workflow,
      message,
      applyLockdown: true,
    });
    const reply =
      payload?.result?.reply ||
      payload?.result?.summary ||
      payload?.result?.assistantNarrative ||
      "Workflow completed.";
    pushChatMessage("assistant", reply);
    setStatus(`Workflow '${workflow.name}' responded.`);
  } finally {
    chatSendBtn.disabled = false;
  }
}

workflowSelect.addEventListener("change", () => {
  runtime.selectedWorkflowId = String(workflowSelect.value || "");
  const workflow = getWorkflowById(runtime.selectedWorkflowId);
  if (workflow) {
    launchSelectedWorkflow();
  }
});

chatSendBtn.addEventListener("click", async () => {
  try {
    await sendMessage();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
    pushChatMessage("assistant", `Error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

chatInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  try {
    await sendMessage();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
    pushChatMessage("assistant", `Error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

async function main() {
  const params = new URLSearchParams(window.location.search || "");
  const preferredWorkflowId = String(params.get("workflowId") || "").trim();
  const autoLaunch = params.get("launch") === "1" || params.get("launch") === "true";
  try {
    await loadWorkflows(preferredWorkflowId, autoLaunch);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

main();
