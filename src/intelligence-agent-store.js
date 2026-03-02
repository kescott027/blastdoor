import fs from "node:fs/promises";
import path from "node:path";
import { hydrateAgentExecutionGraph } from "./intelligence-agent-scaffold.js";

function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeAgent(input = {}) {
  const source = normalizeObject(input);
  const now = new Date().toISOString();
  const id = normalizeString(source.id, "");
  const name = normalizeString(source.name, "");
  if (!id) {
    throw new Error("agent.id is required.");
  }
  if (!name) {
    throw new Error("agent.name is required.");
  }
  return {
    ...hydrateAgentExecutionGraph({
      id,
      name,
      intent: normalizeString(source.intent, ""),
      scaffoldIds: normalizeArray(source.scaffoldIds).map((entry) => normalizeString(entry, "")).filter(Boolean),
      scaffolds: normalizeArray(source.scaffolds),
      approvals: normalizeObject(source.approvals),
      workflow: normalizeObject(source.workflow),
      meta: normalizeObject(source.meta),
      createdAt: normalizeString(source.createdAt, now),
      updatedAt: now,
    }),
    createdAt: normalizeString(source.createdAt, now),
    updatedAt: now,
  };
}

function normalizeStore(input = {}) {
  const source = normalizeObject(input);
  const agents = normalizeArray(source.agents)
    .map((agent) => {
      try {
        return normalizeAgent(agent);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    agents,
  };
}

export async function readIntelligenceAgentStore(filePath) {
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
      `Failed to read intelligence agent store from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function writeIntelligenceAgentStore(filePath, store) {
  const normalized = normalizeStore(store);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
  return normalized;
}

export async function upsertIntelligenceAgent(filePath, draft) {
  const store = await readIntelligenceAgentStore(filePath);
  const normalized = normalizeAgent(draft);
  const nextAgents = store.agents.filter((entry) => entry.id !== normalized.id);
  if (!normalized.createdAt) {
    normalized.createdAt = new Date().toISOString();
  }
  nextAgents.push(normalized);
  const saved = await writeIntelligenceAgentStore(filePath, {
    ...store,
    agents: nextAgents,
  });
  return {
    store: saved,
    agent: saved.agents.find((entry) => entry.id === normalized.id) || normalized,
  };
}

export async function deleteIntelligenceAgent(filePath, agentId) {
  const id = normalizeString(agentId, "");
  if (!id) {
    throw new Error("agentId is required.");
  }
  const store = await readIntelligenceAgentStore(filePath);
  const nextAgents = store.agents.filter((entry) => entry.id !== id);
  const saved = await writeIntelligenceAgentStore(filePath, {
    ...store,
    agents: nextAgents,
  });
  return saved;
}
