import express from "express";
import rateLimit from "express-rate-limit";

export function createManagerHttpApp(options = {}) {
  const {
    graphicsDir,
    managerDir,
    managerWriteRateLimitWindowMs,
    managerWriteRateLimitMax,
    enforceManagerAccess,
    readConsoleSettings,
    getManagerAuthSession,
    normalizeManagerNextPath,
    renderManagerLoginPage,
    authenticateRemoteSupportToken,
  } = options;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(
    "/graphics",
    express.static(graphicsDir, {
      etag: true,
      maxAge: "1h",
    }),
  );

  const managerAccessReadLimiter = rateLimit({
    windowMs: managerWriteRateLimitWindowMs,
    max: Math.max(120, Math.min(1200, managerWriteRateLimitMax * 4)),
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many manager requests. Try again shortly.",
  });
  app.use(managerAccessReadLimiter);
  app.use((req, res, next) => {
    void enforceManagerAccess(req, res, next);
  });

  app.get("/manager/login", async (req, res, next) => {
    try {
      const settings = await readConsoleSettings();
      if (!settings.access.requirePassword) {
        res.redirect("/manager/");
        return;
      }
      if (getManagerAuthSession(req)) {
        const nextPath = normalizeManagerNextPath(req.query?.next, "/manager/");
        res.redirect(nextPath);
        return;
      }
      const nextPath = normalizeManagerNextPath(req.query?.next, "/manager/");
      res
        .status(200)
        .set("cache-control", "no-store")
        .send(renderManagerLoginPage({ nextPath }));
    } catch (error) {
      next(error);
    }
  });

  app.use(
    "/manager",
    express.static(managerDir, {
      etag: true,
      maxAge: 0,
      setHeaders(res) {
        res.setHeader("Cache-Control", "no-store");
      },
    }),
  );

  const managerWriteLimiter = rateLimit({
    windowMs: managerWriteRateLimitWindowMs,
    max: managerWriteRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many manager write requests. Try again shortly.",
  });

  const registerApiGet = (routePath, handler) => {
    app.get(`/api${routePath}`, handler);
    app.get(`/manager/api${routePath}`, handler);
  };

  const registerApiPost = (routePath, handler) => {
    app.post(`/api${routePath}`, managerWriteLimiter, handler);
    app.post(`/manager/api${routePath}`, managerWriteLimiter, handler);
  };

  const remoteSupportReadLimiter = rateLimit({
    windowMs: managerWriteRateLimitWindowMs,
    max: Math.max(30, Math.min(300, managerWriteRateLimitMax * 2)),
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many remote support requests. Try again shortly.",
  });

  const remoteSupportWriteLimiter = rateLimit({
    windowMs: managerWriteRateLimitWindowMs,
    max: Math.max(10, Math.min(120, Math.floor(managerWriteRateLimitMax / 2))),
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many remote support write requests. Try again shortly.",
  });

  function registerRemoteSupportGet(routePath, handler) {
    app.get(`/api/remote-support/v1${routePath}`, remoteSupportReadLimiter, async (req, res) => {
      const auth = await authenticateRemoteSupportToken(req);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
      req.remoteSupportToken = auth.token;
      req.remoteSupportSettings = auth.settings;
      await handler(req, res);
    });
  }

  function registerRemoteSupportPost(routePath, handler) {
    app.post(`/api/remote-support/v1${routePath}`, remoteSupportWriteLimiter, async (req, res) => {
      const auth = await authenticateRemoteSupportToken(req);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
      req.remoteSupportToken = auth.token;
      req.remoteSupportSettings = auth.settings;
      await handler(req, res);
    });
  }

  app.get("/", (_req, res) => {
    res.redirect("/manager/");
  });

  return {
    app,
    registerApiGet,
    registerApiPost,
    registerRemoteSupportGet,
    registerRemoteSupportPost,
  };
}
