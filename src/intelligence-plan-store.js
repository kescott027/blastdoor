import { randomUUID } from "node:crypto";
import { createConfigStore } from "./config-store.js";

const PLAN_INDEX_KEY = "assistant.plan.index.v1";
const PLAN_PREFIX = "assistant.plan.run.v1.";

function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

function parseJson(value, fallback) {
  const raw = normalizeString(value, "");
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function toPlanKey(runId) {
  return `${PLAN_PREFIX}${runId}`;
}

function summarizeRun(run) {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    goal: run.goal,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    layerCount: Array.isArray(run.layers) ? run.layers.length : 0,
    evidenceCount: Array.isArray(run.evidence) ? run.evidence.length : 0,
  };
}

function normalizeRun(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const layers = Array.isArray(source.layers) ? source.layers : [];
  const evidence = Array.isArray(source.evidence) ? source.evidence : [];
  return {
    runId: normalizeString(source.runId, ""),
    workflowId: normalizeString(source.workflowId, "custom"),
    goal: normalizeString(source.goal, ""),
    status: normalizeString(source.status, "draft"),
    createdBy: normalizeString(source.createdBy, "operator"),
    createdAt: normalizeString(source.createdAt, nowIso()),
    updatedAt: normalizeString(source.updatedAt, nowIso()),
    layers,
    evidence,
    links: Array.isArray(source.links) ? source.links : [],
    meta: source.meta && typeof source.meta === "object" ? source.meta : {},
  };
}

export async function createIntelligencePlanStore(config, options = {}) {
  const configStore = createConfigStore(config, {
    postgresPoolFactory: options.postgresPoolFactory,
  });

  async function readIndex() {
    const raw = await configStore.getValue(PLAN_INDEX_KEY);
    const parsed = parseJson(raw, []);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => normalizeString(entry, ""))
      .filter((entry) => entry.length > 0);
  }

  async function writeIndex(ids) {
    await configStore.setValue(PLAN_INDEX_KEY, JSON.stringify(ids, null, 0));
  }

  async function getRun(runId) {
    const id = normalizeString(runId, "");
    if (!id) {
      return null;
    }
    const raw = await configStore.getValue(toPlanKey(id));
    if (!raw) {
      return null;
    }
    return normalizeRun(parseJson(raw, {}));
  }

  async function saveRun(run) {
    const normalized = normalizeRun(run);
    if (!normalized.runId) {
      throw new Error("runId is required.");
    }
    normalized.updatedAt = nowIso();
    await configStore.setValue(toPlanKey(normalized.runId), JSON.stringify(normalized));

    const index = await readIndex();
    if (!index.includes(normalized.runId)) {
      index.unshift(normalized.runId);
    } else {
      const next = [normalized.runId, ...index.filter((entry) => entry !== normalized.runId)];
      await writeIndex(next);
      return normalized;
    }
    await writeIndex(index);
    return normalized;
  }

  async function listRuns({ limit = 20 } = {}) {
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20;
    const index = await readIndex();
    const runs = [];
    for (const runId of index.slice(0, max)) {
      const run = await getRun(runId);
      if (run) {
        runs.push(summarizeRun(run));
      }
    }
    return runs;
  }

  async function createRun({
    workflowId = "custom",
    goal = "",
    createdBy = "operator",
    initialLayer = {},
    meta = {},
  } = {}) {
    const runId = randomUUID();
    const createdAt = nowIso();
    const run = normalizeRun({
      runId,
      workflowId,
      goal,
      status: "draft",
      createdBy,
      createdAt,
      updatedAt: createdAt,
      layers: [
        {
          layer: 0,
          createdAt,
          source: "assistant",
          summary: normalizeString(initialLayer.summary, ""),
          plan: initialLayer.plan && typeof initialLayer.plan === "object" ? initialLayer.plan : { raw: initialLayer },
        },
      ],
      evidence: [],
      links: [],
      meta: meta && typeof meta === "object" ? meta : {},
    });
    return await saveRun(run);
  }

  async function addEvidence(runId, entries = []) {
    const run = await getRun(runId);
    if (!run) {
      throw new Error("Plan run not found.");
    }
    const now = nowIso();
    const normalizedEntries = (Array.isArray(entries) ? entries : [])
      .map((entry) => {
        const source = entry && typeof entry === "object" ? entry : {};
        return {
          evidenceId: normalizeString(source.evidenceId, "") || randomUUID(),
          type: normalizeString(source.type, "snapshot"),
          title: normalizeString(source.title, "Evidence"),
          collectedAt: normalizeString(source.collectedAt, now) || now,
          summary: normalizeString(source.summary, ""),
          payload: source.payload,
        };
      })
      .filter((entry) => entry.evidenceId);

    run.evidence = [...(Array.isArray(run.evidence) ? run.evidence : []), ...normalizedEntries];
    return await saveRun(run);
  }

  async function addLayer(runId, layerInput = {}) {
    const run = await getRun(runId);
    if (!run) {
      throw new Error("Plan run not found.");
    }
    const layers = Array.isArray(run.layers) ? run.layers : [];
    const nextLayer = layers.length > 0 ? Math.max(...layers.map((entry) => Number(entry.layer) || 0)) + 1 : 0;
    const createdAt = nowIso();
    const entry = {
      layer: nextLayer,
      createdAt,
      source: normalizeString(layerInput.source, "assistant"),
      summary: normalizeString(layerInput.summary, ""),
      parentLayer: Number.isInteger(layerInput.parentLayer) ? layerInput.parentLayer : nextLayer - 1,
      plan: layerInput.plan && typeof layerInput.plan === "object" ? layerInput.plan : { raw: layerInput.plan || {} },
    };
    run.layers = [...layers, entry];
    return await saveRun(run);
  }

  return {
    getRun,
    listRuns,
    createRun,
    addEvidence,
    addLayer,
    close: async () => {
      if (typeof configStore.close === "function") {
        await configStore.close();
      }
    },
  };
}
