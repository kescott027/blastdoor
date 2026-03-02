import { readIntelligenceWorkflowStore, summarizeWorkflowForList } from "../../../intelligence-workflow-store.js";
import { chooseWorkflowById, derivePlanLayerFromChatResult, makeApiDocSnapshot } from "../helpers.js";

export function registerIntelligencePlanRoutes(context) {
  const {
    registerApiGet,
    registerApiPost,
    readEnvConfig,
    withBlastdoorApi,
    normalizeManagerString,
    workflowStorePath,
    DEFAULT_PHASE0_WORKFLOW_ID,
    buildAssistantContext,
  } = context;

  registerApiGet("/assistant/plans", async (req, res) => {
    try {
      const limit = Number.parseInt(normalizeManagerString(req.query?.limit, "20"), 10);
      const runs = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.listPlanRuns({ limit });
      });
      res.json({
        ok: true,
        runs: Array.isArray(runs) ? runs : [],
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/assistant/plans/:runId", async (req, res) => {
    try {
      const runId = normalizeManagerString(req.params?.runId, "");
      if (!runId) {
        throw new Error("runId is required.");
      }
      const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.getPlanRun({ runId });
      });
      if (!run) {
        return res.status(404).json({ error: "Plan run not found." });
      }
      return res.json({
        ok: true,
        run,
      });
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/plans/create", async (req, res) => {
    try {
      const goal = normalizeManagerString(req.body?.goal, "");
      if (!goal) {
        throw new Error("goal is required.");
      }

      const requestedWorkflowId = normalizeManagerString(req.body?.workflowId, DEFAULT_PHASE0_WORKFLOW_ID);
      const workflowStore = await readIntelligenceWorkflowStore(workflowStorePath);
      const selectedWorkflow = chooseWorkflowById(workflowStore, requestedWorkflowId);
      if (!selectedWorkflow) {
        throw new Error("No workflow is available to generate plan scaffolding.");
      }

      const config = await readEnvConfig(context.envPath);
      const contextData = await buildAssistantContext(config);
      const assistantMessage =
        normalizeManagerString(req.body?.message, "") ||
        `Create a phase 0 plan for this goal: ${goal}. Return concise JSON with summary and steps[].`;

      const chatResult = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
          workflow: selectedWorkflow,
          message: assistantMessage,
          context: {
            diagnosticsReport: contextData.diagnosticsReport,
            troubleshootReport: contextData.troubleshootReport,
            installationConfig: contextData.installationConfig || {},
            apiDocs: makeApiDocSnapshot(),
            planGoal: goal,
            phase: "phase-0",
          },
        });
      });

      const initialLayer = derivePlanLayerFromChatResult(chatResult, {
        goal,
        fallbackSummary: `Phase 0 plan created for: ${goal}`,
      });

      const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.createPlanRun({
          workflowId: selectedWorkflow.id,
          goal,
          createdBy: "manager-ui",
          initialLayer: {
            summary: initialLayer.summary,
            plan: {
              ...initialLayer.plan,
              bootstrap: true,
            },
          },
          meta: {
            phase: "phase-0",
            workflowType: selectedWorkflow.type,
          },
        });
      });

      res.json({
        ok: true,
        run: run || null,
        selectedWorkflow: summarizeWorkflowForList(selectedWorkflow),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/plans/:runId/evidence", async (req, res) => {
    try {
      const runId = normalizeManagerString(req.params?.runId, "");
      if (!runId) {
        throw new Error("runId is required.");
      }
      const title = normalizeManagerString(req.body?.title, "Operator note");
      const summary = normalizeManagerString(req.body?.summary, "");
      if (!summary) {
        throw new Error("summary is required.");
      }
      const payload =
        req.body?.payload && typeof req.body.payload === "object"
          ? req.body.payload
          : {
              note: summary,
            };

      const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.addPlanEvidence({
          runId,
          entries: [
            {
              type: "operator-note",
              title,
              summary,
              payload,
            },
          ],
        });
      });
      res.json({
        ok: true,
        run: run || null,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/plans/:runId/collect-evidence", async (req, res) => {
    try {
      const runId = normalizeManagerString(req.params?.runId, "");
      if (!runId) {
        throw new Error("runId is required.");
      }
      const config = await readEnvConfig(context.envPath);
      const contextData = await buildAssistantContext(config);
      const operatorNote = normalizeManagerString(req.body?.note, "");
      const entries = [
        {
          type: "diagnostics-report",
          title: "Diagnostics report snapshot",
          summary: "Captured current diagnostics report for this plan run.",
          payload: contextData.diagnosticsReport,
        },
        {
          type: "troubleshoot-report",
          title: "Troubleshooting report snapshot",
          summary: "Captured troubleshooting report for current runtime state.",
          payload: contextData.troubleshootReport,
        },
      ];
      if (operatorNote) {
        entries.push({
          type: "operator-note",
          title: "Operator note",
          summary: operatorNote,
          payload: {
            note: operatorNote,
          },
        });
      }

      const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.addPlanEvidence({
          runId,
          entries,
        });
      });

      res.json({
        ok: true,
        run: run || null,
        evidenceAdded: entries.length,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/plans/:runId/refine", async (req, res) => {
    try {
      const runId = normalizeManagerString(req.params?.runId, "");
      if (!runId) {
        throw new Error("runId is required.");
      }

      const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.getPlanRun({ runId });
      });
      if (!run) {
        return res.status(404).json({ error: "Plan run not found." });
      }

      const workflowStore = await readIntelligenceWorkflowStore(workflowStorePath);
      const selectedWorkflow = chooseWorkflowById(
        workflowStore,
        normalizeManagerString(req.body?.workflowId, run.workflowId || DEFAULT_PHASE0_WORKFLOW_ID),
      );
      if (!selectedWorkflow) {
        return res.status(400).json({ error: "No workflow is available to refine this plan." });
      }

      const config = await readEnvConfig(context.envPath);
      const contextData = await buildAssistantContext(config);
      const operatorMessage =
        normalizeManagerString(req.body?.message, "") ||
        `Refine this plan with a deeper layer based on evidence and diagnostics. Goal: ${run.goal || ""}`.trim();

      const chatResult = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
          workflow: selectedWorkflow,
          message: operatorMessage,
          context: {
            diagnosticsReport: contextData.diagnosticsReport,
            troubleshootReport: contextData.troubleshootReport,
            installationConfig: contextData.installationConfig || {},
            apiDocs: makeApiDocSnapshot(),
            planRun: run,
            phase: "phase-0-refine",
          },
        });
      });

      const lastLayer = Array.isArray(run.layers) && run.layers.length > 0 ? run.layers[run.layers.length - 1] : null;
      const layer = derivePlanLayerFromChatResult(chatResult, {
        goal: run.goal || "",
        fallbackSummary: `Refined layer for: ${run.goal || "plan run"}`,
      });

      const updatedRun = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.addPlanLayer({
          runId,
          layer: {
            source: "assistant",
            parentLayer: Number.isInteger(lastLayer?.layer) ? lastLayer.layer : null,
            summary: layer.summary,
            plan: layer.plan,
          },
        });
      });

      return res.json({
        ok: true,
        run: updatedRun || null,
        selectedWorkflow: summarizeWorkflowForList(selectedWorkflow),
      });
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
