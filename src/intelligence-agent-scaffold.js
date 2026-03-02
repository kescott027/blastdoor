function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

function slugify(value) {
  return normalizeString(value, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
}

const SCAFFOLD_CATALOG = Object.freeze([
  {
    id: "gather-diagnostics",
    name: "Gather Diagnostics",
    description: "Collect diagnostics and runtime environment snapshots.",
    category: "observe",
    safeOnly: true,
    requiresApproval: false,
    defaultInput: "Collect diagnostics report and summarize critical signals.",
  },
  {
    id: "collect-network-snapshot",
    name: "Collect Network Snapshot",
    description: "Capture networking context and reachability checks.",
    category: "observe",
    safeOnly: true,
    requiresApproval: false,
    defaultInput: "Gather network snapshot and list probable connectivity blockers.",
  },
  {
    id: "error-triage",
    name: "Error Triage",
    description: "Classify errors and infer likely root causes.",
    category: "analyze",
    safeOnly: true,
    requiresApproval: false,
    defaultInput: "Triage error logs and rank top probable root causes with confidence.",
  },
  {
    id: "recommend-remediation",
    name: "Recommend Remediation",
    description: "Draft ordered remediation steps with validation gates.",
    category: "plan",
    safeOnly: true,
    requiresApproval: false,
    defaultInput: "Generate remediation plan with non-destructive validation checks first.",
  },
  {
    id: "draft-config-patch",
    name: "Draft Config Patch",
    description: "Produce config patch proposal without applying changes.",
    category: "plan",
    safeOnly: true,
    requiresApproval: true,
    defaultInput: "Draft configuration patch and rollback notes; do not apply automatically.",
  },
  {
    id: "request-human-approval",
    name: "Request Human Approval",
    description: "Gate potentially risky actions behind explicit operator confirmation.",
    category: "control",
    safeOnly: true,
    requiresApproval: true,
    defaultInput: "Ask for explicit operator approval before any state-changing actions.",
  },
  {
    id: "trigger-lockdown",
    name: "Trigger Lockdown",
    description: "Recommend blast door lock action on critical threat score.",
    category: "defense",
    safeOnly: false,
    requiresApproval: true,
    defaultInput: "If critical risk is confirmed, request approval to lock blast doors.",
  },
]);

function scaffoldById(scaffoldId) {
  const id = normalizeString(scaffoldId, "");
  return SCAFFOLD_CATALOG.find((entry) => entry.id === id) || null;
}

function normalizeSelectedScaffoldIds(selectedIds = []) {
  const ids = Array.isArray(selectedIds)
    ? selectedIds.map((value) => normalizeString(value, "")).filter(Boolean)
    : [];
  const deduped = [...new Set(ids)];
  const filtered = deduped.filter((id) => scaffoldById(id));
  if (filtered.length > 0) {
    return filtered;
  }
  return ["gather-diagnostics", "error-triage", "recommend-remediation", "request-human-approval"];
}

function normalizeScaffoldsFromIds(scaffoldIds = []) {
  const selectedIds = normalizeSelectedScaffoldIds(scaffoldIds);
  return selectedIds
    .map((id) => scaffoldById(id))
    .filter(Boolean)
    .map((entry) => ({ ...entry }));
}

function buildScaffoldInstructions(scaffolds) {
  return scaffolds
    .map((scaffold, index) => {
      const ordinal = index + 1;
      return `${ordinal}. ${scaffold.name} [${scaffold.id}] safeOnly=${scaffold.safeOnly} requiresApproval=${scaffold.requiresApproval} :: ${scaffold.defaultInput}`;
    })
    .join("\n");
}

function normalizeWorkflowSuggestion(suggestion = {}, fallbackName = "Agent Workflow") {
  const source = suggestion && typeof suggestion === "object" ? suggestion : {};
  const fallback = normalizeString(fallbackName, "Agent Workflow");
  const name = normalizeString(source.name, fallback) || fallback;
  const id = normalizeString(source.id, "") || slugify(name) || "agent-workflow";
  return {
    id,
    name,
    type: "custom",
    description: normalizeString(source.description, "Agent workflow generated from scaffold blocks."),
    systemPrompt: normalizeString(
      source.systemPrompt,
      "You are a Blastdoor agent workflow assistant. Follow scaffold blocks strictly and require human approval for state changes.",
    ),
    seedPrompt: normalizeString(source.seedPrompt, "Provide context and desired outcome for this workflow run."),
    inputPlaceholder: normalizeString(source.inputPlaceholder, "Describe the request and runtime context."),
    ragEnabled: Boolean(source.ragEnabled),
    allowWebSearch: Boolean(source.allowWebSearch),
    autoLockOnThreat: Boolean(source.autoLockOnThreat),
    threatScoreThreshold: Number.isInteger(Number.parseInt(String(source.threatScoreThreshold || ""), 10))
      ? Number.parseInt(String(source.threatScoreThreshold), 10)
      : 80,
    config: source.config && typeof source.config === "object" && !Array.isArray(source.config) ? source.config : {},
  };
}

function toNodeId(index) {
  return `step-${index + 1}`;
}

export function buildExecutionGraphFromScaffolds(scaffolds = []) {
  const selectedScaffolds = Array.isArray(scaffolds) ? scaffolds : [];
  const nodes = [
    {
      id: "start",
      type: "entry",
      label: "Start",
      safeOnly: true,
      requiresApproval: false,
      metadata: {},
    },
  ];
  const edges = [];
  const approvalGates = [];

  for (let index = 0; index < selectedScaffolds.length; index += 1) {
    const scaffold = selectedScaffolds[index];
    const nodeId = toNodeId(index);
    nodes.push({
      id: nodeId,
      type: "scaffold-step",
      label: scaffold.name,
      scaffoldId: scaffold.id,
      safeOnly: scaffold.safeOnly !== false,
      requiresApproval: Boolean(scaffold.requiresApproval),
      metadata: {
        category: scaffold.category,
        defaultInput: scaffold.defaultInput,
      },
    });
    if (scaffold.requiresApproval) {
      approvalGates.push({
        gateId: `gate-${nodeId}`,
        nodeId,
        policy: "explicit-human-approval",
        reason: `${scaffold.name} requires operator approval before execution.`,
      });
    }
  }

  nodes.push({
    id: "end",
    type: "terminal",
    label: "End",
    safeOnly: true,
    requiresApproval: false,
    metadata: {},
  });

  const orderedNodeIds = nodes.map((entry) => entry.id);
  for (let index = 0; index < orderedNodeIds.length - 1; index += 1) {
    edges.push({
      id: `edge-${orderedNodeIds[index]}-to-${orderedNodeIds[index + 1]}`,
      from: orderedNodeIds[index],
      to: orderedNodeIds[index + 1],
      condition: "always",
    });
  }

  return {
    version: 1,
    startNodeId: "start",
    endNodeId: "end",
    nodes,
    edges,
    approvalGates,
    executionPolicy: {
      humanInTheLoop: true,
      autoExecuteStateChanges: false,
    },
  };
}

export function validateExecutionGraph(executionGraph = {}) {
  const graph = executionGraph && typeof executionGraph === "object" ? executionGraph : {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const approvalGates = Array.isArray(graph.approvalGates) ? graph.approvalGates : [];
  const nodeIds = new Set(nodes.map((entry) => normalizeString(entry?.id, "")));
  const issues = [];

  if (!nodeIds.has(normalizeString(graph.startNodeId, ""))) {
    issues.push("startNodeId is missing or does not match a node id.");
  }
  if (!nodeIds.has(normalizeString(graph.endNodeId, ""))) {
    issues.push("endNodeId is missing or does not match a node id.");
  }
  for (const edge of edges) {
    const from = normalizeString(edge?.from, "");
    const to = normalizeString(edge?.to, "");
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      issues.push(`edge '${normalizeString(edge?.id, "unknown")}' references unknown node(s).`);
    }
  }
  for (const gate of approvalGates) {
    const nodeId = normalizeString(gate?.nodeId, "");
    if (!nodeIds.has(nodeId)) {
      issues.push(`approval gate '${normalizeString(gate?.gateId, "unknown")}' references unknown node.`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      approvalGateCount: approvalGates.length,
    },
  };
}

export function hydrateAgentExecutionGraph(draft = {}) {
  const source = draft && typeof draft === "object" ? draft : {};
  const scaffoldIds = Array.isArray(source.scaffoldIds) ? source.scaffoldIds : [];
  const scaffolds = normalizeScaffoldsFromIds(scaffoldIds);
  const executionGraph = buildExecutionGraphFromScaffolds(scaffolds);
  const validation = validateExecutionGraph(executionGraph);
  return {
    ...source,
    scaffoldIds: normalizeSelectedScaffoldIds(scaffoldIds),
    scaffolds,
    executionGraph,
    executionGraphValidation: validation,
  };
}

export function listAgentScaffolds() {
  return SCAFFOLD_CATALOG.map((entry) => ({ ...entry }));
}

export function buildAgentScaffoldPrompt({ name, intent, scaffoldIds }) {
  const normalizedName = normalizeString(name, "Scaffold Agent");
  const normalizedIntent = normalizeString(intent, "");
  const selectedIds = normalizeSelectedScaffoldIds(scaffoldIds);
  const scaffolds = normalizeScaffoldsFromIds(selectedIds);
  const instructions = buildScaffoldInstructions(scaffolds);

  return {
    selectedIds,
    selectedScaffolds: scaffolds,
    prompt: [
      `Build a Blastdoor workflow config for agent '${normalizedName}'.`,
      "Return JSON object fields: name, description, systemPrompt, seedPrompt, inputPlaceholder, ragEnabled, allowWebSearch, autoLockOnThreat, threatScoreThreshold, config.",
      "The workflow must be human-in-the-loop: never execute destructive actions automatically.",
      `Intent: ${normalizedIntent || "(none provided)"}`,
      "Required scaffold blocks (keep intent and order):",
      instructions,
    ].join("\n\n"),
  };
}

export function composeAgentDraft({
  name = "",
  intent = "",
  scaffoldIds = [],
  workflowSuggestion = {},
  workflowResult = {},
} = {}) {
  const agentName = normalizeString(name, "") || normalizeString(workflowSuggestion?.name, "") || "Scaffold Agent";
  const agentId = slugify(agentName) || `agent-${Date.now()}`;
  const selectedIds = normalizeSelectedScaffoldIds(scaffoldIds);
  const selectedScaffolds = normalizeScaffoldsFromIds(selectedIds);
  const workflow = normalizeWorkflowSuggestion(workflowSuggestion, `${agentName} Workflow`);
  const createdAt = new Date().toISOString();

  const approvalBlocks = selectedScaffolds.filter((entry) => entry.requiresApproval).map((entry) => entry.id);
  const executionGraph = buildExecutionGraphFromScaffolds(selectedScaffolds);
  const executionGraphValidation = validateExecutionGraph(executionGraph);
  const workflowConfig = workflow.config && typeof workflow.config === "object" ? workflow.config : {};

  return {
    id: agentId,
    name: agentName,
    intent: normalizeString(intent, ""),
    scaffoldIds: selectedIds,
    scaffolds: selectedScaffolds,
    approvals: {
      required: true,
      requiredScaffoldIds: approvalBlocks,
      policy: "All state-changing actions require explicit human approval.",
    },
    workflow: {
      ...workflow,
      config: {
        ...workflowConfig,
        executionGraph,
        approvalPolicy: {
          required: true,
          requiredScaffoldIds: approvalBlocks,
          autoExecuteStateChanges: false,
        },
      },
    },
    executionGraph,
    executionGraphValidation,
    meta: {
      generatedAt: createdAt,
      workflowResultSummary: normalizeString(
        workflowResult?.summary || workflowResult?.assistantNarrative || workflowResult?.reply,
        "",
      ),
    },
    createdAt,
    updatedAt: createdAt,
  };
}
