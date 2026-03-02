import { readIntelligenceWorkflowStore, upsertIntelligenceWorkflow } from "../../../intelligence-workflow-store.js";
import {
  SAFE_WIZARD_ACTIONS,
  WIZARD_STEP_SEQUENCE,
  buildWizardSummary,
  chooseWorkflowById,
  clampInteger,
  createDefaultWizardState,
  createWizardHostFingerprint,
  derivePlanLayerFromChatResult,
  getWizardStateForRun,
  makeApiDocSnapshot,
  normalizeSafeActionTrustList,
  normalizeWizardState,
  parseClarificationContract,
  parseExecutionPlanContract,
  parseSufficiencyContract,
  setWizardStep,
  workflowTrustsAction,
} from "../helpers.js";

export function registerIntelligenceWizardRoutes(context) {
  const {
    registerApiGet,
    registerApiPost,
    readEnvConfig,
    withBlastdoorApi,
    normalizeManagerString,
    parseBooleanLikeBody,
    runTroubleshootAction,
    commandRunner,
    workspaceDir,
    envPath,
    workflowStorePath,
    DEFAULT_PHASE0_WORKFLOW_ID,
    buildAssistantContext,
  } = context;

  function describeSafeAction(actionId, safeActions = []) {
    const action = (Array.isArray(safeActions) ? safeActions : []).find((entry) => entry?.id === actionId) || null;
    const commandSummaryById = {
      "snapshot.network": "Runs read-only commands: ss, ip addr, ip route, hostname -I, ufw status.",
      "check.gateway-local": "Runs local HTTP health checks against configured Blastdoor endpoints.",
      "detect.wsl-portproxy":
        "Runs read-only Windows checks via PowerShell: netsh portproxy show and firewall rule lookup.",
    };
    return {
      actionId,
      title: action?.title || actionId,
      description: action?.description || "Read-only troubleshooting action.",
      commandSummary: commandSummaryById[actionId] || "Read-only troubleshooting action.",
    };
  }

  function appendWizardExecutionLog(wizard, event, detail) {
    const logs = Array.isArray(wizard?.execution?.logs) ? [...wizard.execution.logs] : [];
    logs.push({
      ts: new Date().toISOString(),
      event: normalizeManagerString(event, "wizard.event"),
      detail: normalizeManagerString(detail, ""),
    });
    return normalizeWizardState({
      ...wizard,
      execution: {
        ...(wizard?.execution || {}),
        logs: logs.slice(-200),
      },
    });
  }

  async function resolveWizardRun({ runId, config }) {
    const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
      return await blastdoorApi.plugins?.intelligence?.getPlanRun({ runId });
    });
    if (!run) {
      throw new Error("Plan run not found.");
    }
    const contextData = await buildAssistantContext(config);
    const hostFingerprint = createWizardHostFingerprint({
      environment: contextData.environment,
      config,
    });
    const wizard = getWizardStateForRun(run, {
      hostFingerprint,
      workflowId: normalizeManagerString(run?.workflowId, DEFAULT_PHASE0_WORKFLOW_ID),
      currentStep: "define_name",
      nextPrompt: "Enter workflow name, then click Next.",
      confidence: {
        current: 0,
        threshold: 80,
      },
      clarification: {
        round: 0,
        questions: [],
        answers: [],
      },
      execution: {
        steps: [],
        logs: [],
      },
    });
    return {
      run,
      wizard,
      contextData,
      hostFingerprint,
    };
  }

  async function saveWizardRun({ run, wizard, status }) {
    const sourceRun = run && typeof run === "object" ? run : {};
    const sourceWizard = wizard && typeof wizard === "object" ? wizard : {};
    const nextRun = {
      ...sourceRun,
      wizard: normalizeWizardState({
        ...sourceWizard,
        lastSavedAt: new Date().toISOString(),
      }),
    };
    if (status) {
      nextRun.status = status;
    }
    return await withBlastdoorApi(async ({ blastdoorApi }) => {
      return await blastdoorApi.plugins?.intelligence?.putPlanRun({
        run: nextRun,
      });
    });
  }

  function unansweredRequiredCount(wizard) {
    const questions = Array.isArray(wizard?.clarification?.questions) ? wizard.clarification.questions : [];
    const answers = Array.isArray(wizard?.clarification?.answers) ? wizard.clarification.answers : [];
    return questions.filter((question) => {
      if (question.required === false) {
        return false;
      }
      return !answers.some(
        (answer) => answer.questionId === question.id && normalizeManagerString(answer.answer, ""),
      );
    }).length;
  }

  registerApiGet("/assistant/wizard/runs", async (req, res) => {
    try {
      const limit = Number.parseInt(normalizeManagerString(req.query?.limit, "20"), 10);
      const summaries = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.listPlanRuns({ limit });
      });
      const runs = [];
      for (const summary of Array.isArray(summaries) ? summaries : []) {
        const runId = normalizeManagerString(summary?.runId, "");
        if (!runId) {
          continue;
        }
        const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
          return await blastdoorApi.plugins?.intelligence?.getPlanRun({ runId });
        });
        if (!run) {
          continue;
        }
        runs.push(buildWizardSummary(run));
      }
      res.json({
        ok: true,
        runs,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/wizard/start", async (req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const contextData = await buildAssistantContext(config);
      const hostFingerprint = createWizardHostFingerprint({
        environment: contextData.environment,
        config,
      });
      const workflowStore = await readIntelligenceWorkflowStore(workflowStorePath);
      const selectedWorkflow = chooseWorkflowById(
        workflowStore,
        normalizeManagerString(req.body?.workflowId, DEFAULT_PHASE0_WORKFLOW_ID),
      );
      if (!selectedWorkflow) {
        throw new Error("No workflow available for wizard start.");
      }
      const runName = normalizeManagerString(req.body?.runName, "");
      const run = await withBlastdoorApi(async ({ blastdoorApi }) => {
        return await blastdoorApi.plugins?.intelligence?.createPlanRun({
          workflowId: selectedWorkflow.id,
          goal: "",
          createdBy: "manager-ui-wizard",
          initialLayer: {
            summary: "Wizard initialized.",
            plan: {
              summary: "Pending initial plan generation.",
              steps: [],
            },
          },
          meta: {
            wizard: true,
            runName,
          },
        });
      });
      let wizard = createDefaultWizardState({
        workflowId: selectedWorkflow.id,
        hostFingerprint,
        runName,
      });
      const nextRun = {
        ...run,
        status: "wizard",
        meta: {
          ...(run?.meta && typeof run.meta === "object" ? run.meta : {}),
          wizard: true,
          runName,
        },
      };
      if (runName) {
        wizard = setWizardStep(wizard, "define_goal", "Enter workflow goal, then click Next.");
        wizard = appendWizardExecutionLog(wizard, "wizard.start", `Run created with name '${runName}'.`);
      } else {
        wizard = appendWizardExecutionLog(wizard, "wizard.start", "Run created and waiting for workflow name.");
      }
      const saved = await saveWizardRun({
        run: nextRun,
        wizard,
        status: "wizard",
      });
      res.json({
        ok: true,
        run: saved || null,
        summary: buildWizardSummary(saved),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/assistant/wizard/:runId", async (req, res) => {
    try {
      const runId = normalizeManagerString(req.params?.runId, "");
      if (!runId) {
        throw new Error("runId is required.");
      }
      const config = await readEnvConfig(envPath);
      const { run, wizard } = await resolveWizardRun({ runId, config });
      const hydrated = {
        ...run,
        wizard,
      };
      res.json({
        ok: true,
        run: hydrated,
        summary: buildWizardSummary(hydrated),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/wizard/:runId/save", async (req, res) => {
    try {
      const runId = normalizeManagerString(req.params?.runId, "");
      if (!runId) {
        throw new Error("runId is required.");
      }
      const config = await readEnvConfig(envPath);
      const { run, wizard, hostFingerprint } = await resolveWizardRun({ runId, config });
      const workflowId = normalizeManagerString(req.body?.workflowId, wizard.workflowId || run.workflowId);
      const runName = normalizeManagerString(req.body?.runName, run?.meta?.runName || "");
      const goal = normalizeManagerString(req.body?.goal, run.goal || "");
      let nextWizard = normalizeWizardState(
        req.body?.wizard && typeof req.body.wizard === "object"
          ? {
              ...wizard,
              ...req.body.wizard,
            }
          : wizard,
        {
          hostFingerprint,
          workflowId,
        },
      );
      nextWizard = appendWizardExecutionLog(nextWizard, "wizard.save", "Wizard state saved.");
      const saved = await saveWizardRun({
        run: {
          ...run,
          workflowId,
          goal,
          meta: {
            ...(run?.meta && typeof run.meta === "object" ? run.meta : {}),
            runName,
            wizard: true,
          },
        },
        wizard: nextWizard,
        status: run.status || "wizard",
      });
      res.json({
        ok: true,
        run: saved || null,
        summary: buildWizardSummary(saved),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/wizard/:runId/answer", async (req, res) => {
    try {
      const runId = normalizeManagerString(req.params?.runId, "");
      const questionId = normalizeManagerString(req.body?.questionId, "");
      const answerText = normalizeManagerString(req.body?.answer, "");
      if (!runId || !questionId) {
        throw new Error("runId and questionId are required.");
      }
      const config = await readEnvConfig(envPath);
      const { run, wizard } = await resolveWizardRun({ runId, config });
      const answers = Array.isArray(wizard?.clarification?.answers) ? [...wizard.clarification.answers] : [];
      const existingIndex = answers.findIndex((entry) => entry.questionId === questionId);
      const nextEntry = {
        questionId,
        answer: answerText,
        answeredAt: new Date().toISOString(),
      };
      if (existingIndex >= 0) {
        answers[existingIndex] = nextEntry;
      } else {
        answers.push(nextEntry);
      }
      let nextWizard = normalizeWizardState({
        ...wizard,
        clarification: {
          ...(wizard?.clarification || {}),
          answers,
        },
      });
      nextWizard = appendWizardExecutionLog(nextWizard, "wizard.answer", `Captured answer for '${questionId}'.`);
      const saved = await saveWizardRun({
        run,
        wizard: nextWizard,
        status: run.status || "wizard",
      });
      res.json({
        ok: true,
        run: saved || null,
        summary: buildWizardSummary(saved),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/wizard/:runId/back", async (req, res) => {
    try {
      const runId = normalizeManagerString(req.params?.runId, "");
      if (!runId) {
        throw new Error("runId is required.");
      }
      const config = await readEnvConfig(envPath);
      const { run, wizard } = await resolveWizardRun({ runId, config });
      const currentIndex = Math.max(0, WIZARD_STEP_SEQUENCE.indexOf(wizard.currentStep));
      const previousStep = WIZARD_STEP_SEQUENCE[Math.max(0, currentIndex - 1)] || "define_name";
      let nextWizard = setWizardStep(
        wizard,
        previousStep,
        `Moved back to '${previousStep}'. Update inputs, then click Next.`,
      );
      nextWizard = appendWizardExecutionLog(nextWizard, "wizard.back", `Moved back to ${previousStep}.`);
      const saved = await saveWizardRun({
        run,
        wizard: nextWizard,
        status: run.status || "wizard",
      });
      res.json({
        ok: true,
        run: saved || null,
        summary: buildWizardSummary(saved),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/wizard/:runId/next", async (req, res) => {
    try {
      const runId = normalizeManagerString(req.params?.runId, "");
      if (!runId) {
        throw new Error("runId is required.");
      }
      const config = await readEnvConfig(envPath);
      const { run, wizard, contextData, hostFingerprint } = await resolveWizardRun({ runId, config });
      const workflowStore = await readIntelligenceWorkflowStore(workflowStorePath);
      const selectedWorkflow = chooseWorkflowById(
        workflowStore,
        normalizeManagerString(req.body?.workflowId, wizard.workflowId || run.workflowId || DEFAULT_PHASE0_WORKFLOW_ID),
      );
      if (!selectedWorkflow) {
        throw new Error("No workflow available.");
      }

      let workingRun = {
        ...run,
        workflowId: selectedWorkflow.id,
        status: run.status || "wizard",
        meta: {
          ...(run?.meta && typeof run.meta === "object" ? run.meta : {}),
          wizard: true,
        },
      };
      let nextWizard = normalizeWizardState(
        {
          ...wizard,
          workflowId: selectedWorkflow.id,
          hostFingerprint,
        },
        {
          workflowId: selectedWorkflow.id,
          hostFingerprint,
        },
      );

      if (nextWizard.currentStep === "define_name") {
        const runName = normalizeManagerString(req.body?.runName, workingRun?.meta?.runName || "");
        if (!runName) {
          throw new Error("Workflow name is required.");
        }
        workingRun.meta.runName = runName;
        nextWizard = setWizardStep(nextWizard, "define_goal", "Enter workflow goal, then click Next.");
        nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "define_name complete.");
      } else if (nextWizard.currentStep === "define_goal") {
        const goal = normalizeManagerString(req.body?.goal, workingRun.goal || "");
        if (!goal) {
          throw new Error("Workflow goal is required.");
        }
        workingRun.goal = goal;
        nextWizard = setWizardStep(nextWizard, "create_initial_plan", "Click Next to generate initial plan.");
        nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "define_goal complete.");
      } else if (nextWizard.currentStep === "create_initial_plan") {
        const clarification = await withBlastdoorApi(async ({ blastdoorApi }) => {
          return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
            workflow: {
              id: "wizard-clarification",
              name: "Wizard Clarification",
              type: "wizard-clarification",
            },
            message:
              normalizeManagerString(req.body?.message, "") ||
              "Generate clarifying questions and confidence for this workflow run.",
            context: {
              runName: normalizeManagerString(workingRun?.meta?.runName, ""),
              goal: normalizeManagerString(workingRun.goal, ""),
              round: 1,
              maxRounds: 3,
              confidenceThreshold: nextWizard.confidence.threshold,
              existingQuestions: nextWizard.clarification.questions,
              answers: nextWizard.clarification.answers,
              diagnosticsReport: contextData.diagnosticsReport,
              troubleshootReport: contextData.troubleshootReport,
            },
          });
        });
        const contract = parseClarificationContract(clarification?.result || clarification);
        nextWizard = normalizeWizardState({
          ...nextWizard,
          confidence: {
            ...nextWizard.confidence,
            current: contract.confidence,
          },
          clarification: {
            ...nextWizard.clarification,
            round: 1,
            questions: contract.questions,
          },
        });
        const withLayer = await withBlastdoorApi(async ({ blastdoorApi }) => {
          return await blastdoorApi.plugins?.intelligence?.addPlanLayer({
            runId,
            layer: {
              source: "assistant",
              summary: contract.summary || "Initial wizard plan generated.",
              parentLayer: 0,
              plan: {
                summary: contract.summary || "Initial wizard plan generated.",
                steps: [],
              },
            },
          });
        });
        workingRun = withLayer || workingRun;
        if (contract.needsMoreInfo) {
          nextWizard = setWizardStep(
            nextWizard,
            "clarify_round",
            "Answer required clarifying questions, then click Next.",
          );
        } else {
          nextWizard = setWizardStep(nextWizard, "sufficiency_gate", "Click Next to evaluate sufficiency.");
        }
        nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "create_initial_plan complete.");
      } else if (nextWizard.currentStep === "clarify_round") {
        const unresolved = unansweredRequiredCount(nextWizard);
        if (unresolved > 0) {
          throw new Error("Answer all required clarifying questions before continuing.");
        }
        const nextRound = Math.min(3, clampInteger(nextWizard?.clarification?.round, 0, 0, 32) + 1);
        const clarification = await withBlastdoorApi(async ({ blastdoorApi }) => {
          return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
            workflow: {
              id: "wizard-clarification",
              name: "Wizard Clarification",
              type: "wizard-clarification",
            },
            message:
              normalizeManagerString(req.body?.message, "") ||
              "Re-evaluate clarification and ask additional questions only if needed.",
            context: {
              runName: normalizeManagerString(workingRun?.meta?.runName, ""),
              goal: normalizeManagerString(workingRun.goal, ""),
              round: nextRound,
              maxRounds: 3,
              confidenceThreshold: nextWizard.confidence.threshold,
              existingQuestions: nextWizard.clarification.questions,
              answers: nextWizard.clarification.answers,
              diagnosticsReport: contextData.diagnosticsReport,
              troubleshootReport: contextData.troubleshootReport,
            },
          });
        });
        const contract = parseClarificationContract(clarification?.result || clarification);
        nextWizard = normalizeWizardState({
          ...nextWizard,
          confidence: {
            ...nextWizard.confidence,
            current: contract.confidence,
          },
          clarification: {
            ...nextWizard.clarification,
            round: nextRound,
            questions: contract.questions,
          },
        });
        if (contract.needsMoreInfo && nextRound < 3) {
          nextWizard = setWizardStep(
            nextWizard,
            "clarify_round",
            "Additional clarification is needed. Answer questions and click Next.",
          );
        } else {
          nextWizard = setWizardStep(nextWizard, "sufficiency_gate", "Click Next to evaluate sufficiency.");
        }
        nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "clarify_round processed.");
      } else if (nextWizard.currentStep === "sufficiency_gate") {
        const unresolved = unansweredRequiredCount(nextWizard);
        const sufficiency = await withBlastdoorApi(async ({ blastdoorApi }) => {
          return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
            workflow: {
              id: "wizard-sufficiency",
              name: "Wizard Sufficiency Gate",
              type: "wizard-sufficiency",
            },
            message:
              normalizeManagerString(req.body?.message, "") || "Determine if confidence is sufficient for evidence.",
            context: {
              confidenceCurrent: nextWizard.confidence.current,
              confidenceThreshold: nextWizard.confidence.threshold,
              unansweredRequired: unresolved,
            },
          });
        });
        const contract = parseSufficiencyContract(sufficiency?.result || sufficiency);
        nextWizard = normalizeWizardState({
          ...nextWizard,
          confidence: {
            ...nextWizard.confidence,
            current: contract.confidence,
          },
        });
        if (contract.readyForEvidence) {
          nextWizard = setWizardStep(nextWizard, "collect_evidence", "Click Next to collect evidence.");
        } else if (nextWizard.clarification.round < 3) {
          nextWizard = setWizardStep(
            nextWizard,
            "clarify_round",
            "More clarification is required. Answer pending questions and click Next.",
          );
        } else {
          nextWizard = setWizardStep(
            nextWizard,
            "collect_evidence",
            "Proceeding with current confidence due max clarification rounds reached.",
          );
        }
        nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "sufficiency_gate processed.");
      } else if (nextWizard.currentStep === "collect_evidence") {
        const operatorNote = normalizeManagerString(req.body?.note, "");
        const entries = [
          {
            type: "diagnostics-report",
            title: "Diagnostics report snapshot",
            summary: "Captured current diagnostics report for this wizard run.",
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
            payload: { note: operatorNote },
          });
        }
        const withEvidence = await withBlastdoorApi(async ({ blastdoorApi }) => {
          return await blastdoorApi.plugins?.intelligence?.addPlanEvidence({
            runId,
            entries,
          });
        });
        workingRun = withEvidence || workingRun;
        nextWizard = setWizardStep(nextWizard, "refine_layer", "Click Next to refine the next planning layer.");
        nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "collect_evidence complete.");
      } else if (nextWizard.currentStep === "refine_layer") {
        const chatResult = await withBlastdoorApi(async ({ blastdoorApi }) => {
          return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
            workflow: selectedWorkflow,
            message:
              normalizeManagerString(req.body?.message, "") ||
              `Refine this plan with a deeper layer. Goal: ${normalizeManagerString(workingRun.goal, "")}`.trim(),
            context: {
              diagnosticsReport: contextData.diagnosticsReport,
              troubleshootReport: contextData.troubleshootReport,
              installationConfig: contextData.installationConfig || {},
              apiDocs: makeApiDocSnapshot(),
              planRun: workingRun,
              phase: "wizard-refine",
            },
          });
        });
        const layer = derivePlanLayerFromChatResult(chatResult, {
          goal: workingRun.goal || "",
          fallbackSummary: `Wizard refined layer for: ${workingRun.goal || "plan run"}`,
        });
        const lastLayer = Array.isArray(workingRun.layers) && workingRun.layers.length > 0
          ? workingRun.layers[workingRun.layers.length - 1]
          : null;
        const withLayer = await withBlastdoorApi(async ({ blastdoorApi }) => {
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
        workingRun = withLayer || workingRun;
        const boostedConfidence = clampInteger(nextWizard.confidence.current + 15, nextWizard.confidence.current, 0, 100);
        nextWizard = normalizeWizardState({
          ...nextWizard,
          confidence: {
            ...nextWizard.confidence,
            current: boostedConfidence,
          },
        });
        if (boostedConfidence >= nextWizard.confidence.threshold || nextWizard.clarification.round >= 3) {
          nextWizard = setWizardStep(nextWizard, "execution_prep", "Click Next to generate execution steps.");
        } else {
          nextWizard = setWizardStep(nextWizard, "collect_evidence", "Additional evidence needed. Click Next.");
        }
        nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "refine_layer complete.");
      } else if (nextWizard.currentStep === "execution_prep") {
        const executionPlan = await withBlastdoorApi(async ({ blastdoorApi }) => {
          return await blastdoorApi.plugins?.intelligence?.runWorkflowChat({
            workflow: {
              id: "wizard-execution-plan",
              name: "Wizard Execution Planner",
              type: "wizard-execution-plan",
            },
            message:
              normalizeManagerString(req.body?.message, "") || "Generate executable steps for this workflow run.",
            context: {
              runName: normalizeManagerString(workingRun?.meta?.runName, ""),
              goal: normalizeManagerString(workingRun.goal, ""),
              environment: contextData.environment,
              diagnosticsReport: contextData.diagnosticsReport,
              troubleshootReport: contextData.troubleshootReport,
            },
          });
        });
        const executionContract = parseExecutionPlanContract(executionPlan?.result || executionPlan);
        const steps =
          executionContract.steps.length > 0
            ? executionContract.steps
            : [
                {
                  id: "manual-1",
                  title: "Manual operator execution",
                  instructions: "Follow the refined plan and record outcomes.",
                  mode: "manual",
                  actionId: "",
                  completionCriteria: "Operator confirms step completion.",
                  completed: false,
                  result: "",
                  completedAt: "",
                },
              ];
        nextWizard = normalizeWizardState({
          ...nextWizard,
          execution: {
            ...nextWizard.execution,
            steps,
          },
        });
        nextWizard = setWizardStep(nextWizard, "execute_steps", "Execute the current step, then click Next.");
        nextWizard = appendWizardExecutionLog(nextWizard, "wizard.step", "execution_prep complete.");
      } else if (nextWizard.currentStep === "execute_steps") {
        const steps = Array.isArray(nextWizard?.execution?.steps) ? [...nextWizard.execution.steps] : [];
        const firstIncomplete = steps.find((step) => !step.completed) || null;
        if (!firstIncomplete) {
          nextWizard = setWizardStep(nextWizard, "completed", "Workflow run completed.");
          nextWizard = appendWizardExecutionLog(nextWizard, "wizard.complete", "All execution steps completed.");
          workingRun.status = "completed";
        } else {
          const completeStepId = normalizeManagerString(req.body?.completeStepId, "");
          const completionResult = normalizeManagerString(req.body?.result, "");
          if (completeStepId) {
            const idx = steps.findIndex((step) => step.id === completeStepId);
            if (idx < 0) {
              throw new Error("Invalid completeStepId.");
            }
            steps[idx] = {
              ...steps[idx],
              completed: true,
              result: completionResult,
              completedAt: new Date().toISOString(),
            };
            nextWizard = normalizeWizardState({
              ...nextWizard,
              execution: {
                ...nextWizard.execution,
                steps,
              },
            });
            nextWizard = appendWizardExecutionLog(nextWizard, "wizard.execute", `Marked step '${completeStepId}' completed.`);
          } else if (
            firstIncomplete.mode === "safe-action" &&
            SAFE_WIZARD_ACTIONS.has(firstIncomplete.actionId) &&
            workflowTrustsAction({
              workflow: selectedWorkflow,
              actionId: firstIncomplete.actionId,
              hostFingerprint: nextWizard.hostFingerprint,
            })
          ) {
            if (typeof runTroubleshootAction !== "function") {
              throw new Error("Safe troubleshooting runner is unavailable.");
            }
            const actionResult = await runTroubleshootAction({
              actionId: firstIncomplete.actionId,
              config,
              environment: contextData.environment,
              workspaceDir,
              commandRunner,
              envPath,
            });
            const idx = steps.findIndex((step) => step.id === firstIncomplete.id);
            if (idx >= 0) {
              steps[idx] = {
                ...steps[idx],
                completed: true,
                result: JSON.stringify(actionResult || {}, null, 2),
                completedAt: new Date().toISOString(),
              };
            }
            nextWizard = normalizeWizardState({
              ...nextWizard,
              execution: {
                ...nextWizard.execution,
                steps,
              },
            });
            nextWizard = appendWizardExecutionLog(
              nextWizard,
              "wizard.execute.safe-action",
              `Auto-ran trusted safe action '${firstIncomplete.actionId}'.`,
            );
          } else {
            return res.json({
              ok: true,
              awaitingAction: true,
              requiredStep: firstIncomplete,
              requiredAction:
                firstIncomplete.mode === "safe-action" && SAFE_WIZARD_ACTIONS.has(firstIncomplete.actionId)
                  ? describeSafeAction(firstIncomplete.actionId, contextData.troubleshootReport?.safeActions)
                  : null,
              run: {
                ...workingRun,
                wizard: nextWizard,
              },
              summary: buildWizardSummary({
                ...workingRun,
                wizard: nextWizard,
              }),
            });
          }
          const remaining = steps.filter((step) => !step.completed);
          if (remaining.length === 0) {
            nextWizard = setWizardStep(nextWizard, "completed", "Workflow run completed.");
            nextWizard = appendWizardExecutionLog(nextWizard, "wizard.complete", "All execution steps completed.");
            workingRun.status = "completed";
          } else {
            nextWizard = setWizardStep(nextWizard, "execute_steps", "Continue with next execution step.");
          }
        }
      } else if (nextWizard.currentStep === "completed") {
        nextWizard = appendWizardExecutionLog(nextWizard, "wizard.next", "Workflow already completed.");
      }

      const saved = await saveWizardRun({
        run: workingRun,
        wizard: nextWizard,
        status: workingRun.status || "wizard",
      });
      res.json({
        ok: true,
        run: saved || null,
        summary: buildWizardSummary(saved),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/assistant/wizard/:runId/run-safe-action", async (req, res) => {
    try {
      const runId = normalizeManagerString(req.params?.runId, "");
      const actionId = normalizeManagerString(req.body?.actionId, "");
      const rememberTrust = parseBooleanLikeBody(req.body?.rememberTrust, false);
      const approved = parseBooleanLikeBody(req.body?.approved, false);
      if (!runId || !actionId) {
        throw new Error("runId and actionId are required.");
      }
      if (!SAFE_WIZARD_ACTIONS.has(actionId)) {
        throw new Error("Unsupported safe action.");
      }
      if (typeof runTroubleshootAction !== "function") {
        throw new Error("Safe troubleshooting runner is unavailable.");
      }

      const config = await readEnvConfig(envPath);
      const { run, wizard, contextData } = await resolveWizardRun({ runId, config });
      if (wizard.currentStep !== "execute_steps") {
        throw new Error("Safe actions can only run during execute_steps.");
      }
      const steps = Array.isArray(wizard?.execution?.steps) ? [...wizard.execution.steps] : [];
      const stepIndex = steps.findIndex((step) => !step.completed && step.mode === "safe-action" && step.actionId === actionId);
      if (stepIndex < 0) {
        throw new Error("No pending execution step matches this safe action.");
      }

      const workflowStore = await readIntelligenceWorkflowStore(workflowStorePath);
      const selectedWorkflow = chooseWorkflowById(workflowStore, wizard.workflowId || run.workflowId || DEFAULT_PHASE0_WORKFLOW_ID);
      const alreadyTrusted = workflowTrustsAction({
        workflow: selectedWorkflow,
        actionId,
        hostFingerprint: wizard.hostFingerprint,
      });
      if (!alreadyTrusted && !approved) {
        return res.json({
          ok: true,
          awaitingApproval: true,
          requiredAction: describeSafeAction(actionId, contextData.troubleshootReport?.safeActions),
          trustScope: "per-workflow-per-host",
        });
      }

      const actionResult = await runTroubleshootAction({
        actionId,
        config,
        environment: contextData.environment,
        workspaceDir,
        commandRunner,
        envPath,
      });
      steps[stepIndex] = {
        ...steps[stepIndex],
        completed: true,
        result: JSON.stringify(actionResult || {}, null, 2),
        completedAt: new Date().toISOString(),
      };

      let nextWizard = normalizeWizardState({
        ...wizard,
        execution: {
          ...wizard.execution,
          steps,
        },
      });
      nextWizard = appendWizardExecutionLog(nextWizard, "wizard.safe-action", `Executed safe action '${actionId}'.`);

      let trustSaved = false;
      if (rememberTrust && selectedWorkflow && !alreadyTrusted) {
        const configObject =
          selectedWorkflow?.config && typeof selectedWorkflow.config === "object" ? { ...selectedWorkflow.config } : {};
        const trustList = normalizeSafeActionTrustList(configObject.safeActionTrust);
        trustList.push({
          actionId,
          hostFingerprint: wizard.hostFingerprint,
          trustedAt: new Date().toISOString(),
          trustedBy: "operator",
        });
        const saveResult = await upsertIntelligenceWorkflow(workflowStorePath, {
          ...selectedWorkflow,
          config: {
            ...configObject,
            safeActionTrust: normalizeSafeActionTrustList(trustList),
          },
        });
        trustSaved = Boolean(saveResult?.workflow);
      }

      const remaining = steps.filter((step) => !step.completed);
      if (remaining.length === 0) {
        nextWizard = setWizardStep(nextWizard, "completed", "Workflow run completed.");
        nextWizard = appendWizardExecutionLog(nextWizard, "wizard.complete", "All execution steps completed.");
      } else {
        nextWizard = setWizardStep(nextWizard, "execute_steps", "Continue with next execution step.");
      }

      const saved = await saveWizardRun({
        run: {
          ...run,
          status: remaining.length === 0 ? "completed" : run.status || "wizard",
        },
        wizard: nextWizard,
        status: remaining.length === 0 ? "completed" : run.status || "wizard",
      });

      res.json({
        ok: true,
        run: saved || null,
        summary: buildWizardSummary(saved),
        actionResult,
        trustSaved,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
