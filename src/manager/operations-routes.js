import path from "node:path";

export function registerManagerOperationsRoutes(options = {}) {
  const {
    registerApiGet,
    registerApiPost,
    getControlPlaneStatusCached,
    readFailureStore,
    summarizeFailureStore,
    clearFailureStore,
    failureStorePath,
    processState,
    readEnvConfig,
    envPath,
    checkBlastdoorHealth,
    workspaceDir,
    configDefaults,
    tailFile,
  } = options;

  registerApiGet("/control-plane-status", async (_req, res) => {
    try {
      const status = await getControlPlaneStatusCached();
      res.json(status);
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/failures", async (_req, res) => {
    try {
      const store = await readFailureStore(failureStorePath);
      const entries = [...(store.entries || [])].sort((a, b) =>
        String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
      );
      res.json({
        ok: true,
        summary: summarizeFailureStore({ entries }),
        entries,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/failures/clear", async (_req, res) => {
    try {
      await clearFailureStore(failureStorePath);
      res.json({
        ok: true,
        summary: summarizeFailureStore({ entries: [] }),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/monitor", async (_req, res) => {
    try {
      const status = processState.getStatus();
      const config = await readEnvConfig(envPath);
      const health = await checkBlastdoorHealth(config);
      const logPath = path.resolve(workspaceDir, config.DEBUG_LOG_FILE || configDefaults.DEBUG_LOG_FILE);
      const debugLogLines = await tailFile(logPath, 200);
      const runtimeLogLines = processState.recentRuntimeLogs(200);

      res.json({
        ok: true,
        status,
        health,
        debugLogLines,
        runtimeLogLines,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
