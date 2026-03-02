import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const BUILTIN_WORKFLOW_IDS = new Set([
  "config-recommendations",
  "troubleshoot-recommendation",
  "threat-monitor",
  "grimoire",
]);
const WORKFLOW_TYPES = new Set([
  "config-recommendations",
  "troubleshoot-recommendation",
  "threat-monitor",
  "grimoire",
  "custom",
]);

function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeSafeActionTrust(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const source = normalizeObject(entry);
    const actionId = normalizeString(source.actionId, "");
    const hostFingerprint = normalizeString(source.hostFingerprint, "");
    if (!actionId || !hostFingerprint) {
      continue;
    }
    const dedupeKey = `${actionId}::${hostFingerprint}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    out.push({
      actionId,
      hostFingerprint,
      trustedAt: normalizeString(source.trustedAt, new Date().toISOString()),
      trustedBy: normalizeString(source.trustedBy, "operator"),
    });
  }
  return out;
}

function normalizeWorkflowConfig(value) {
  const config = normalizeObject(value);
  return {
    ...config,
    safeActionTrust: normalizeSafeActionTrust(config.safeActionTrust),
  };
}

function slugifyName(name) {
  const normalized = normalizeString(name, "").toLowerCase();
  if (!normalized) {
    return "";
  }
  return normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
}

function defaultBuiltins() {
  const now = new Date().toISOString();
  return [
    {
      id: "config-recommendations",
      name: "Config Recommendations",
      type: "config-recommendations",
      builtIn: true,
      description: "Analyze diagnostics and recommend environment configuration changes.",
      systemPrompt:
        "You are a Blastdoor configuration specialist. Focus on concrete, low-risk operational recommendations.",
      seedPrompt: "Share runtime details or ask for a configuration baseline recommendation.",
      inputPlaceholder: "Ask about environment configuration recommendations.",
      ragEnabled: false,
      allowWebSearch: false,
      autoLockOnThreat: false,
      threatScoreThreshold: 80,
      config: {},
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "troubleshoot-recommendation",
      name: "Troubleshooting Recommendations",
      type: "troubleshoot-recommendation",
      builtIn: true,
      description: "Guide troubleshooting from error logs, diagnostics, and runtime context.",
      systemPrompt:
        "You are a Blastdoor troubleshooting engineer. Prioritize root-cause isolation and safe remediation steps.",
      seedPrompt: "Paste the error and relevant context. I will suggest targeted troubleshooting steps.",
      inputPlaceholder: "Paste error logs, symptoms, or request id details.",
      ragEnabled: false,
      allowWebSearch: false,
      autoLockOnThreat: false,
      threatScoreThreshold: 80,
      config: {},
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "threat-monitor",
      name: "Threat Monitor",
      type: "threat-monitor",
      builtIn: true,
      description: "Analyze runtime and debug logs for potential attack patterns.",
      systemPrompt:
        "You are a Blastdoor threat analyst. Identify suspicious activity and recommend defensive actions.",
      seedPrompt: "Run threat analysis or ask about suspicious login/traffic patterns.",
      inputPlaceholder: "Describe suspicious behavior or ask for a threat scan.",
      ragEnabled: false,
      allowWebSearch: false,
      autoLockOnThreat: false,
      threatScoreThreshold: 80,
      config: {},
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "grimoire",
      name: "Grimoire",
      type: "grimoire",
      builtIn: true,
      description: "Generate API action block chains from intent statements.",
      systemPrompt:
        "You are Grimoire. Translate operator intent into executable Blastdoor API block chains with safety checks.",
      seedPrompt: "Describe what you want to automate and I will generate an API block chain.",
      inputPlaceholder: "Describe the API workflow you want to build.",
      ragEnabled: false,
      allowWebSearch: false,
      autoLockOnThreat: false,
      threatScoreThreshold: 80,
      config: {},
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function normalizeWorkflow(input = {}, { fallbackId = "", fallbackName = "" } = {}) {
  const source = normalizeObject(input);
  const builtIn = BUILTIN_WORKFLOW_IDS.has(normalizeString(source.id, fallbackId));
  const inferredId = normalizeString(source.id, fallbackId) || slugifyName(normalizeString(source.name, fallbackName));
  const id = normalizeString(inferredId, "");
  if (!id) {
    throw new Error("Workflow id is required.");
  }

  const resolvedType = normalizeString(source.type, builtIn ? id : "custom");
  const type = WORKFLOW_TYPES.has(resolvedType) ? resolvedType : "custom";
  const now = new Date().toISOString();
  const createdAt = normalizeString(source.createdAt, now) || now;
  const updatedAt = now;
  const name = normalizeString(source.name, fallbackName || id);
  if (!name) {
    throw new Error("Workflow name is required.");
  }

  return {
    id,
    name,
    type,
    builtIn,
    description: normalizeString(source.description, ""),
    systemPrompt: normalizeString(source.systemPrompt, ""),
    seedPrompt: normalizeString(source.seedPrompt, ""),
    inputPlaceholder: normalizeString(source.inputPlaceholder, ""),
    ragEnabled: normalizeBoolean(source.ragEnabled, false),
    allowWebSearch: normalizeBoolean(source.allowWebSearch, false),
    autoLockOnThreat: normalizeBoolean(source.autoLockOnThreat, false),
    threatScoreThreshold: clampInteger(source.threatScoreThreshold, 80, 20, 100),
    config: normalizeWorkflowConfig(source.config),
    createdAt,
    updatedAt,
  };
}

function mergeWithBuiltins(storedWorkflows = []) {
  const builtinDefaults = defaultBuiltins();
  const byId = new Map();
  for (const workflow of storedWorkflows) {
    const workflowId = normalizeString(workflow?.id, "");
    if (!workflowId) {
      continue;
    }
    byId.set(workflowId, workflow);
  }

  const normalized = [];
  for (const builtin of builtinDefaults) {
    const override = byId.get(builtin.id);
    if (override) {
      normalized.push(
        normalizeWorkflow(
          {
            ...builtin,
            ...override,
            id: builtin.id,
            builtIn: true,
            type: builtin.type,
          },
          { fallbackId: builtin.id, fallbackName: builtin.name },
        ),
      );
      byId.delete(builtin.id);
      continue;
    }
    normalized.push(normalizeWorkflow(builtin, { fallbackId: builtin.id, fallbackName: builtin.name }));
  }

  for (const workflow of byId.values()) {
    normalized.push(normalizeWorkflow(workflow));
  }

  return normalized.sort((a, b) => {
    if (a.builtIn && !b.builtIn) {
      return -1;
    }
    if (!a.builtIn && b.builtIn) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function normalizeStore(input = {}) {
  const source = normalizeObject(input);
  const workflows = mergeWithBuiltins(Array.isArray(source.workflows) ? source.workflows : []);
  return {
    version: STORE_VERSION,
    updatedAt: new Date().toISOString(),
    workflows,
  };
}

export async function readIntelligenceWorkflowStore(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) {
      return normalizeStore({});
    }
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return normalizeStore({});
    }
    throw new Error(
      `Failed to read intelligence workflow store from ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export async function writeIntelligenceWorkflowStore(filePath, store) {
  const normalized = normalizeStore(store);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
  return normalized;
}

export async function upsertIntelligenceWorkflow(filePath, workflowInput) {
  const store = await readIntelligenceWorkflowStore(filePath);
  const source = normalizeObject(workflowInput);
  const requestedId = normalizeString(source.id, "");
  const existing = requestedId ? store.workflows.find((workflow) => workflow.id === requestedId) : null;
  const fallbackName = normalizeString(source.name, existing?.name || "");
  const fallbackId = requestedId || slugifyName(fallbackName);
  if (!fallbackId) {
    throw new Error("Workflow id or name is required.");
  }

  const merged = normalizeWorkflow(
    {
      ...(existing || {}),
      ...source,
      id: fallbackId,
      builtIn: Boolean(existing?.builtIn),
      type: existing?.builtIn ? existing.type : source.type,
    },
    { fallbackId, fallbackName },
  );

  const nextWorkflows = [];
  let replaced = false;
  for (const workflow of store.workflows) {
    if (workflow.id === merged.id) {
      nextWorkflows.push({
        ...merged,
        createdAt: workflow.createdAt || merged.createdAt,
      });
      replaced = true;
      continue;
    }
    nextWorkflows.push(workflow);
  }
  if (!replaced) {
    nextWorkflows.push(merged);
  }

  const savedStore = await writeIntelligenceWorkflowStore(filePath, {
    ...store,
    workflows: nextWorkflows,
  });
  const savedWorkflow = savedStore.workflows.find((workflow) => workflow.id === merged.id) || null;
  return {
    store: savedStore,
    workflow: savedWorkflow,
  };
}

export async function deleteIntelligenceWorkflow(filePath, workflowId) {
  const id = normalizeString(workflowId, "");
  if (!id) {
    throw new Error("workflowId is required.");
  }
  if (BUILTIN_WORKFLOW_IDS.has(id)) {
    throw new Error("Built-in workflows cannot be deleted.");
  }

  const store = await readIntelligenceWorkflowStore(filePath);
  const nextWorkflows = store.workflows.filter((workflow) => workflow.id !== id);
  if (nextWorkflows.length === store.workflows.length) {
    throw new Error("Workflow was not found.");
  }
  const savedStore = await writeIntelligenceWorkflowStore(filePath, {
    ...store,
    workflows: nextWorkflows,
  });
  return savedStore;
}

export function summarizeWorkflowForList(workflow) {
  return {
    id: workflow.id,
    name: workflow.name,
    type: workflow.type,
    builtIn: Boolean(workflow.builtIn),
    description: workflow.description || "",
    ragEnabled: Boolean(workflow.ragEnabled),
    allowWebSearch: Boolean(workflow.allowWebSearch),
    autoLockOnThreat: Boolean(workflow.autoLockOnThreat),
    threatScoreThreshold: workflow.threatScoreThreshold,
    inputPlaceholder: workflow.inputPlaceholder || "",
  };
}
