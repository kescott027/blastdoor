export function registerManagerServiceRoutes(options = {}) {
  const {
    registerApiGet,
    registerApiPost,
    validateGatewayStartConfiguration,
    processState,
    recordFailureEntry,
    readEnvConfig,
    envPath,
    createSessionSecret,
    writeEnvConfig,
    withBlastdoorApi,
    createSessionKey,
    validateManagedUsernameForActions,
    safeEqual,
  } = options;

  registerApiPost("/start", async (_req, res) => {
    try {
      await validateGatewayStartConfiguration();
      const status = await processState.start();
      res.json({ ok: true, status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordFailureEntry({
        action: "gateway-start",
        message,
        details: "Manager failed to start Blastdoor service.",
      });
      res.status(400).json({
        error: message,
      });
    }
  });

  registerApiPost("/stop", async (_req, res) => {
    try {
      const status = await processState.stop();
      res.json({ ok: true, status });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/restart", async (_req, res) => {
    try {
      await validateGatewayStartConfiguration();
      await processState.stop();
      const status = await processState.start();
      res.json({ ok: true, status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordFailureEntry({
        action: "gateway-restart",
        message,
        details: "Manager failed to restart Blastdoor service.",
      });
      res.status(400).json({
        error: message,
      });
    }
  });

  registerApiPost("/sessions/revoke-all", async (_req, res) => {
    try {
      const config = await readEnvConfig(envPath);
      const nextSecret = createSessionSecret();
      const nextConfig = {
        ...config,
        SESSION_SECRET: nextSecret,
      };

      await writeEnvConfig(envPath, nextConfig);

      let serviceRestarted = false;
      if (processState.getStatus().running) {
        await processState.stop();
        await processState.start();
        serviceRestarted = true;
      }

      res.json({
        ok: true,
        serviceRestarted,
        rotatedAt: new Date().toISOString(),
        forceReauthUrl: "/login?reauth=1",
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiGet("/sessions", async (_req, res) => {
    try {
      const payload = await withBlastdoorApi(async ({ configFromEnv, blastdoorApi }) => {
        const sessionMaxAgeHours = Number.parseInt(configFromEnv.SESSION_MAX_AGE_HOURS || "12", 10);
        const profiles = await blastdoorApi.listUserProfiles({
          sessionMaxAgeHours,
        });
        const activeSessions = (profiles || [])
          .filter((entry) => entry.authenticatedNow)
          .map((entry) => ({
            sessionKey: createSessionKey({
              username: entry.username,
              lastLoginAt: entry.lastLoginAt,
              sessionVersion: entry.sessionVersion || 1,
            }),
            username: entry.username,
            friendlyName: entry.friendlyName || "",
            status: entry.status || "active",
            lastLoginAt: entry.lastLoginAt || "",
            lastKnownIp: entry.lastKnownIp || "",
            sessionVersion: entry.sessionVersion || 1,
          }))
          .sort((a, b) => String(a.username || "").localeCompare(String(b.username || "")));

        return {
          activeSessions,
          sessionMaxAgeHours,
        };
      });

      res.json({
        ok: true,
        generatedAt: new Date().toISOString(),
        summary: {
          activeCount: payload.activeSessions.length,
          sessionMaxAgeHours: payload.sessionMaxAgeHours,
        },
        sessions: payload.activeSessions,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/sessions/revoke", async (req, res) => {
    try {
      const username = validateManagedUsernameForActions(req.body?.username);
      const expectedSessionKey = String(req.body?.sessionKey || "").trim();

      const result = await withBlastdoorApi(async ({ configFromEnv, blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        const existingUser = users.find((entry) => entry.username === username);
        if (!existingUser) {
          throw new Error("User not found.");
        }

        const sessionMaxAgeHours = Number.parseInt(configFromEnv.SESSION_MAX_AGE_HOURS || "12", 10);
        const profiles = await blastdoorApi.listUserProfiles({
          sessionMaxAgeHours,
        });
        const target = (profiles || []).find((entry) => entry.authenticatedNow && entry.username === username);
        if (!target) {
          throw new Error("Requested session is no longer active.");
        }

        const sessionKey = createSessionKey({
          username: target.username,
          lastLoginAt: target.lastLoginAt,
          sessionVersion: target.sessionVersion || 1,
        });
        if (expectedSessionKey && !safeEqual(sessionKey, expectedSessionKey)) {
          throw new Error("Requested session no longer matches current active session.");
        }

        const profile = await blastdoorApi.invalidateUserSessions(username);
        return {
          username,
          revokedSessionKey: sessionKey,
          sessionVersion: profile?.sessionVersion || 1,
        };
      });

      res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/sessions/invalidate-user", async (req, res) => {
    try {
      const username = validateManagedUsernameForActions(req.body?.username);
      const profile = await withBlastdoorApi(async ({ blastdoorApi }) => {
        const users = await blastdoorApi.listCredentialUsers();
        const existingUser = users.find((entry) => entry.username === username);
        if (!existingUser) {
          throw new Error("User not found.");
        }
        return await blastdoorApi.invalidateUserSessions(username);
      });

      res.json({
        ok: true,
        username,
        sessionVersion: profile?.sessionVersion || 1,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
