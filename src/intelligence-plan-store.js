import { randomUUID } from "node:crypto";
import { createConfigStore } from "./config-store.js";

const PLAN_INDEX_KEY = "assistant.plan.index.v1";
const PLAN_PREFIX = "assistant.plan.run.v1.";
const WIZARD_STEPS = [
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
  const wizard = run?.wizard && typeof run.wizard === "object" ? run.wizard : null;
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    goal: run.goal,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    layerCount: Array.isArray(run.layers) ? run.layers.length : 0,
    evidenceCount: Array.isArray(run.evidence) ? run.evidence.length : 0,
    runName: normalizeString(run?.meta?.runName, ""),
    wizardState: normalizeString(wizard?.state, ""),
    wizardStep: normalizeString(wizard?.currentStep, ""),
    wizardWorkflowId: normalizeString(wizard?.workflowId, ""),
    wizardLastSavedAt: normalizeString(wizard?.lastSavedAt, ""),
  };
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeWizardQuestions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry, index) => {
      const source = entry && typeof entry === "object" ? entry : {};
      const questionId = normalizeString(source.id || source.questionId, `q-${index + 1}`);
      const prompt = normalizeString(source.prompt, "");
      const type = normalizeString(source.type, "text");
      const required = source.required !== false;
      const options = Array.isArray(source.options)
        ? source.options.map((option) => normalizeString(option, "")).filter(Boolean).slice(0, 20)
        : [];
      return {
        id: questionId,
        prompt,
        type,
        required,
        options,
      };
    })
    .filter((entry) => entry.id && entry.prompt);
}

function normalizeWizardAnswers(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const source = entry && typeof entry === "object" ? entry : {};
      return {
        questionId: normalizeString(source.questionId, ""),
        answer: normalizeString(source.answer, ""),
        answeredAt: normalizeString(source.answeredAt, nowIso()),
      };
    })
    .filter((entry) => entry.questionId);
}

function normalizeWizardExecutionSteps(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry, index) => {
      const source = entry && typeof entry === "object" ? entry : {};
      const mode = normalizeString(source.mode, "manual");
      return {
        id: normalizeString(source.id, `step-${index + 1}`),
        title: normalizeString(source.title, `Step ${index + 1}`),
        instructions: normalizeString(source.instructions, ""),
        mode: ["manual", "safe-action", "manual-risky"].includes(mode) ? mode : "manual",
        actionId: normalizeString(source.actionId, ""),
        completionCriteria: normalizeString(source.completionCriteria, ""),
        completed: source.completed === true,
        result: normalizeString(source.result, ""),
        completedAt: normalizeString(source.completedAt, ""),
      };
    })
    .filter((entry) => entry.id && entry.title);
}

function normalizeWizardExecutionLogs(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const source = entry && typeof entry === "object" ? entry : {};
      return {
        ts: normalizeString(source.ts, nowIso()),
        event: normalizeString(source.event, ""),
        detail: normalizeString(source.detail, ""),
      };
    })
    .filter((entry) => entry.event);
}

function normalizeWizard(source = {}) {
  const input = source && typeof source === "object" ? source : {};
  const state = normalizeString(input.state, "define_name");
  const currentStep = normalizeString(input.currentStep, state || "define_name");
  const resolvedState = WIZARD_STEPS.includes(state) ? state : "define_name";
  const resolvedStep = WIZARD_STEPS.includes(currentStep) ? currentStep : resolvedState;
  const completedSteps = Array.isArray(input.completedSteps)
    ? input.completedSteps.map((entry) => normalizeString(entry, "")).filter((entry) => WIZARD_STEPS.includes(entry))
    : [];
  const dedupedCompletedSteps = [];
  for (const step of completedSteps) {
    if (!dedupedCompletedSteps.includes(step)) {
      dedupedCompletedSteps.push(step);
    }
  }
  return {
    version: 1,
    state: resolvedState,
    currentStep: resolvedStep,
    completedSteps: dedupedCompletedSteps,
    nextPrompt: normalizeString(input.nextPrompt, ""),
    confidence: {
      current: clampInteger(input?.confidence?.current, 0, 0, 100),
      threshold: clampInteger(input?.confidence?.threshold, 80, 1, 100),
    },
    clarification: {
      round: clampInteger(input?.clarification?.round, 0, 0, 32),
      questions: normalizeWizardQuestions(input?.clarification?.questions),
      answers: normalizeWizardAnswers(input?.clarification?.answers),
    },
    execution: {
      steps: normalizeWizardExecutionSteps(input?.execution?.steps),
      logs: normalizeWizardExecutionLogs(input?.execution?.logs),
    },
    lastSavedAt: normalizeString(input.lastSavedAt, nowIso()),
    hostFingerprint: normalizeString(input.hostFingerprint, ""),
    workflowId: normalizeString(input.workflowId, "troubleshoot-recommendation"),
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
    wizard: normalizeWizard(source.wizard),
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
      wizard: normalizeWizard({
        state: "define_name",
        currentStep: "define_name",
        workflowId,
      }),
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

  async function putRun(runInput = {}) {
    return await saveRun(runInput);
  }

  return {
    getRun,
    listRuns,
    createRun,
    addEvidence,
    addLayer,
    putRun,
    close: async () => {
      if (typeof configStore.close === "function") {
        await configStore.close();
      }
    },
  };
}
