export function registerManagerAuthRoutes(options = {}) {
  const {
    registerApiGet,
    registerApiPost,
    readConsoleSettings,
    getManagerAuthSession,
    normalizeManagerNextPath,
    normalizeString,
    verifyPassword,
    createManagerAuthSession,
    createCookieHeader,
    managerAuthCookieName,
    clearManagerAuthSession,
    renderManagerLoginPage,
  } = options;

  registerApiGet("/manager-auth/state", async (req, res) => {
    try {
      const settings = await readConsoleSettings();
      const session = settings.access.requirePassword ? getManagerAuthSession(req) : { createdAt: null, expiresAt: null };
      res.json({
        ok: true,
        requirePassword: settings.access.requirePassword,
        authenticated: Boolean(session),
        passwordConfigured: Boolean(settings.access.passwordHash),
        session: session
          ? {
              createdAt: session.createdAt || null,
              expiresAt: session.expiresAt || null,
            }
          : null,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/manager-auth/login", async (req, res) => {
    try {
      const settings = await readConsoleSettings();
      const nextPath = normalizeManagerNextPath(req.body?.next, "/manager/");
      if (!settings.access.requirePassword) {
        res.json({
          ok: true,
          authenticated: true,
          requirePassword: false,
          nextPath,
        });
        return;
      }

      if (!settings.access.passwordHash) {
        throw new Error("Manager password is required but not configured.");
      }

      const password = normalizeString(req.body?.password, "");
      if (!verifyPassword(password, settings.access.passwordHash)) {
        res.status(401).json({
          error: "Invalid manager password.",
          managerAuthRequired: true,
        });
        return;
      }

      const token = createManagerAuthSession({ ttlHours: settings.access.sessionTtlHours });
      const forwardedProto = normalizeString(req.get("x-forwarded-proto"), "").split(",")[0].trim().toLowerCase();
      const secure = req.secure || forwardedProto === "https";
      res.setHeader(
        "Set-Cookie",
        createCookieHeader(managerAuthCookieName, token, {
          path: "/",
          maxAge: Math.max(1, settings.access.sessionTtlHours) * 60 * 60,
          sameSite: "Lax",
          secure,
          httpOnly: true,
        }),
      );
      res.json({
        ok: true,
        authenticated: true,
        requirePassword: true,
        nextPath,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerApiPost("/manager-auth/login-form", async (req, res) => {
    try {
      const settings = await readConsoleSettings();
      if (!settings.access.requirePassword) {
        res.redirect("/manager/");
        return;
      }

      if (!settings.access.passwordHash) {
        res
          .status(400)
          .set("cache-control", "no-store")
          .send(renderManagerLoginPage({ error: "Manager password is required but not configured." }));
        return;
      }

      const password = normalizeString(req.body?.password, "");
      const nextPath = normalizeManagerNextPath(req.body?.next, "/manager/");
      if (!verifyPassword(password, settings.access.passwordHash)) {
        res
          .status(401)
          .set("cache-control", "no-store")
          .send(renderManagerLoginPage({ error: "Invalid password.", nextPath }));
        return;
      }

      const token = createManagerAuthSession({ ttlHours: settings.access.sessionTtlHours });
      const forwardedProto = normalizeString(req.get("x-forwarded-proto"), "").split(",")[0].trim().toLowerCase();
      const secure = req.secure || forwardedProto === "https";
      res.setHeader(
        "Set-Cookie",
        createCookieHeader(managerAuthCookieName, token, {
          path: "/",
          maxAge: Math.max(1, settings.access.sessionTtlHours) * 60 * 60,
          sameSite: "Lax",
          secure,
          httpOnly: true,
        }),
      );
      res.redirect(nextPath);
    } catch (error) {
      res
        .status(400)
        .set("cache-control", "no-store")
        .send(renderManagerLoginPage({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  registerApiPost("/manager-auth/logout", async (req, res) => {
    try {
      clearManagerAuthSession(req);
      const forwardedProto = normalizeString(req.get("x-forwarded-proto"), "").split(",")[0].trim().toLowerCase();
      const secure = req.secure || forwardedProto === "https";
      res.setHeader(
        "Set-Cookie",
        createCookieHeader(managerAuthCookieName, "", {
          path: "/",
          maxAge: 0,
          sameSite: "Lax",
          secure,
          httpOnly: true,
        }),
      );
      res.json({
        ok: true,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
