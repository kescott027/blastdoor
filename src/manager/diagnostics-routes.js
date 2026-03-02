export function registerDiagnosticsRoutes(options = {}) {
  const {
    registerApiGet,
    registerApiPost,
    buildDiagnosticsPayload,
    buildTroubleshootPayload,
    normalizeString,
    readEnvConfig,
    detectEnvironmentInfo,
    envPath,
    workspaceDir,
    runTroubleshootAction,
    commandRunner,
    controlPlaneCache,
    operationTimeoutMs = 20_000,
  } = options;

  async function withOperationTimeout(task, label) {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${label} timed out after ${operationTimeoutMs}ms.`));
      }, operationTimeoutMs);
      Promise.resolve()
        .then(task)
        .then((value) => {
          clearTimeout(timeout);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }

  registerApiGet("/diagnostics", async (_req, res) => {
    try {
      res.json(await buildDiagnosticsPayload());
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/troubleshoot", async (_req, res) => {
    try {
      res.json(await buildTroubleshootPayload());
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/troubleshoot/run", async (req, res) => {
    try {
      const actionId = normalizeString(req.body?.actionId, "");
      if (!actionId) {
        throw new Error("actionId is required.");
      }

      if (actionId.startsWith("guide.")) {
        throw new Error(
          "Requested action is potentially destructive and must be reviewed manually. Use diagnostics guidance instead.",
        );
      }

      const config = await readEnvConfig(envPath);
      const environment = detectEnvironmentInfo({ workspaceDir, envPath });
      const result = await withOperationTimeout(
        async () =>
          await runTroubleshootAction({
            actionId,
            config,
            environment,
            workspaceDir,
            commandRunner,
            envPath,
          }),
        "runTroubleshootAction",
      );
      if (result && result.changedConfig) {
        controlPlaneCache.payload = null;
        controlPlaneCache.updatedAtMs = 0;
      }

      res.json({
        ok: true,
        result,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
