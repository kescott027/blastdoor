export function createManagerAuthService(options = {}) {
  const {
    readConsoleSettings,
    normalizeString,
    randomBytes,
    managerAuthCookieName = "blastdoor.manager.sid",
  } = options;

  const managerAuthSessions = new Map();

  function parseCookies(headerValue) {
    const raw = String(headerValue || "");
    if (!raw) {
      return {};
    }

    return raw.split(";").reduce((acc, part) => {
      const [key, ...valueParts] = part.trim().split("=");
      if (!key) {
        return acc;
      }
      const rawValue = valueParts.join("=") || "";
      try {
        acc[key] = decodeURIComponent(rawValue);
      } catch {
        acc[key] = rawValue;
      }
      return acc;
    }, {});
  }

  function createCookieHeader(name, value, options = {}) {
    const encodedName = encodeURIComponent(name);
    const encodedValue = encodeURIComponent(value);
    const segments = [`${encodedName}=${encodedValue}`];
    if (options.path) {
      segments.push(`Path=${options.path}`);
    }
    if (options.httpOnly) {
      segments.push("HttpOnly");
    }
    if (options.sameSite) {
      segments.push(`SameSite=${options.sameSite}`);
    }
    if (options.maxAge !== undefined) {
      segments.push(`Max-Age=${options.maxAge}`);
    }
    if (options.expires) {
      segments.push(`Expires=${options.expires.toUTCString()}`);
    }
    if (options.secure) {
      segments.push("Secure");
    }
    return segments.join("; ");
  }

  function normalizeManagerNextPath(value, fallback = "/manager/") {
    const normalized = normalizeString(value, fallback);
    if (!normalized.startsWith("/")) {
      return fallback;
    }
    if (normalized.startsWith("//")) {
      return fallback;
    }
    if (!normalized.startsWith("/manager")) {
      return fallback;
    }
    return normalized;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderManagerLoginPage({ error = "", nextPath = "/manager/" } = {}) {
    const safeNext = normalizeManagerNextPath(nextPath, "/manager/");
    const safeError = normalizeString(error, "");
    const errorBlock = safeError ? `<p class="manager-login-error">${escapeHtml(safeError)}</p>` : "";
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Blastdoor Manager Login</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at 15% 15%, rgba(155, 224, 255, 0.14), transparent 32%),
          radial-gradient(circle at 88% 18%, rgba(182, 255, 172, 0.1), transparent 30%),
          linear-gradient(180deg, #131926, #090b10);
        color: #e7edf6;
      }
      main {
        width: min(420px, 92vw);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 14px;
        padding: 1.1rem 1.1rem 1.2rem;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(10, 14, 24, 0.92));
      }
      h1 {
        margin: 0 0 0.35rem;
        font-size: 1.28rem;
      }
      p {
        margin: 0 0 0.8rem;
        color: #9ca8bd;
        font-size: 0.92rem;
      }
      label {
        display: grid;
        gap: 0.3rem;
        font-size: 0.85rem;
      }
      input {
        width: 100%;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(10, 14, 24, 0.95);
        color: #e7edf6;
        padding: 0.55rem 0.6rem;
        font-size: 0.95rem;
      }
      button {
        margin-top: 0.8rem;
        width: 100%;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: linear-gradient(180deg, #263557, #1b2741);
        color: #e7edf6;
        padding: 0.55rem 0.7rem;
        font-size: 0.95rem;
        cursor: pointer;
      }
      .manager-login-error {
        margin: 0 0 0.8rem;
        color: #ff9a9a;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Blastdoor Manager Login</h1>
      <p>Manager access is password protected.</p>
      ${errorBlock}
      <form method="post" action="/api/manager-auth/login-form">
        <input type="hidden" name="next" value="${escapeHtml(safeNext)}" />
        <label>
          Password
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit">Unlock Manager</button>
      </form>
    </main>
  </body>
</html>`;
  }

  function purgeExpiredManagerAuthSessions(nowMs = Date.now()) {
    for (const [token, session] of managerAuthSessions.entries()) {
      const expiresAtMs = new Date(session?.expiresAt || "").getTime();
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
        managerAuthSessions.delete(token);
      }
    }
  }

  function getManagerAuthSession(req) {
    const cookies = parseCookies(req.headers?.cookie || "");
    const token = String(cookies[managerAuthCookieName] || "");
    if (!token) {
      return null;
    }
    purgeExpiredManagerAuthSessions();
    const session = managerAuthSessions.get(token);
    if (!session) {
      return null;
    }
    return {
      token,
      ...session,
    };
  }

  function createManagerAuthSession({ ttlHours = 12 } = {}) {
    purgeExpiredManagerAuthSessions();
    const token = randomBytes(32).toString("base64url");
    const nowMs = Date.now();
    const expiresAtMs = nowMs + Math.max(1, Number.parseInt(String(ttlHours || "12"), 10)) * 60 * 60 * 1000;
    managerAuthSessions.set(token, {
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    return token;
  }

  function clearManagerAuthSession(req) {
    const existing = getManagerAuthSession(req);
    if (existing?.token) {
      managerAuthSessions.delete(existing.token);
    }
  }

  function isManagerAuthBypassPath(pathname = "") {
    if (
      pathname.startsWith("/api/remote-support/v1/") ||
      pathname === "/api/remote-support/v1" ||
      pathname.startsWith("/manager/api/remote-support/v1/") ||
      pathname === "/manager/api/remote-support/v1"
    ) {
      return true;
    }

    return (
      pathname === "/manager/login" ||
      pathname === "/api/manager-auth/login" ||
      pathname === "/api/manager-auth/login-form" ||
      pathname === "/api/manager-auth/logout" ||
      pathname === "/api/manager-auth/state" ||
      pathname === "/manager/api/manager-auth/login" ||
      pathname === "/manager/api/manager-auth/login-form" ||
      pathname === "/manager/api/manager-auth/logout" ||
      pathname === "/manager/api/manager-auth/state"
    );
  }

  async function enforceManagerAccess(req, res, next) {
    try {
      const settings = await readConsoleSettings();
      if (!settings.access.requirePassword) {
        next();
        return;
      }

      if (isManagerAuthBypassPath(req.path)) {
        next();
        return;
      }

      const session = getManagerAuthSession(req);
      if (session) {
        next();
        return;
      }

      if (req.path.startsWith("/api/") || req.path.startsWith("/manager/api/")) {
        res.status(401).json({
          error: "Manager authentication required.",
          managerAuthRequired: true,
        });
        return;
      }

      if (req.path.startsWith("/manager")) {
        const nextPath = normalizeManagerNextPath(`${req.path}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`);
        res.redirect(`/manager/login?next=${encodeURIComponent(nextPath)}`);
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  }

  return {
    normalizeManagerNextPath,
    renderManagerLoginPage,
    createCookieHeader,
    getManagerAuthSession,
    createManagerAuthSession,
    clearManagerAuthSession,
    enforceManagerAccess,
  };
}
