import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "../src/server.js";
import { BlastdoorDatabase, BlastdoorPostgresDatabase } from "../src/database-store.js";
import { writeBlastDoorsState } from "../src/blastdoors-state.js";
import { createPasswordHash } from "../src/security.js";
import { createUserAdminStore } from "../src/user-admin-store.js";
import { authenticator } from "../src/otp.js";
import { createMockPostgresPoolFactory } from "./helpers/mock-postgres.js";

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  absorb(setCookieHeaders = []) {
    for (const header of setCookieHeaders) {
      const pair = header.split(";")[0];
      const idx = pair.indexOf("=");
      if (idx < 1) {
        continue;
      }

      const key = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!value) {
        this.cookies.delete(key);
        continue;
      }

      this.cookies.set(key, value);
    }
  }

  header() {
    if (this.cookies.size === 0) {
      return "";
    }

    return Array.from(this.cookies.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
}

function parseCsrf(html) {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(match, "csrf token should be present in login HTML");
  return match[1];
}

function parseSetCookie(headers) {
  const value = headers["set-cookie"];
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function request(port, { method = "GET", path = "/", headers = {}, body = "" }, jar) {
  return new Promise((resolve, reject) => {
    const mergedHeaders = { ...headers };
    const cookie = jar?.header();
    if (cookie) {
      mergedHeaders.cookie = cookie;
    }

    if (body && mergedHeaders["content-length"] === undefined) {
      mergedHeaders["content-length"] = Buffer.byteLength(body);
    }

    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: mergedHeaders,
      },
      (res) => {
        let payload = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          payload += chunk;
        });
        res.on("end", () => {
          jar?.absorb(parseSetCookie(res.headers));
          resolve({ status: res.statusCode, headers: res.headers, body: payload });
        });
      },
    );

    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function startTargetServer() {
  const requests = [];

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url, method: req.method }));
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    socket.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  return {
    server,
    requests,
    targetUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function startGateway({
  foundryTarget,
  requireTotp = false,
  totpSecret = "",
  loginRateLimitMax = 8,
  loginRateLimitWindowMs = 15 * 60 * 1000,
  passwordStoreMode = "env",
  passwordStoreFile = "",
  configStoreMode = "env",
  databaseFile = "",
  postgresUrl = "",
  postgresSsl = false,
  postgresPoolFactory = null,
  allowedOrigins = "",
  allowNullOrigin = false,
  blastDoorsClosed = false,
  graphicsDir = "",
  themeStorePath = "",
  runtimeStatePath = "",
  userProfileStorePath = "",
  emailProvider = "disabled",
  emailFrom = "",
  emailAdminTo = "",
  publicBaseUrl = "",
}) {
  const password = "Correct Horse Battery Staple 123!";
  const authUsername = "gm";
  const authPasswordHash = createPasswordHash(password);
  const effectiveUserProfileStorePath =
    userProfileStorePath || path.join(os.tmpdir(), `blastdoor-user-profiles-${crypto.randomUUID()}.json`);

  const server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      foundryTarget,
      authUsername,
      authPasswordHash,
      requireTotp,
      totpSecret,
      sessionSecret: "x".repeat(48),
      sessionMaxAgeHours: 12,
      cookieSecure: false,
      trustProxy: false,
      proxyTlsVerify: true,
      loginRateLimitWindowMs,
      loginRateLimitMax,
      passwordStoreMode,
      passwordStoreFile,
      configStoreMode,
      databaseFile,
      postgresUrl,
      postgresSsl,
      allowedOrigins,
      allowNullOrigin,
      emailProvider,
      emailFrom,
      emailAdminTo,
      smtpHost: "",
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: "",
      smtpPass: "",
      smtpIgnoreTls: false,
      publicBaseUrl,
      blastDoorsClosed,
    },
    {
      silent: true,
      postgresPoolFactory,
      graphicsDir: graphicsDir || undefined,
      themeStorePath: themeStorePath || undefined,
      runtimeStatePath: runtimeStatePath || undefined,
      userProfileStorePath: effectiveUserProfileStorePath,
    },
  );

  if (!server.listening) {
    await once(server, "listening");
  }

  const address = server.address();
  return { server, port: address.port, username: authUsername, password, authPasswordHash };
}

function assertTransitionResponse(loginResponse, expectedNextPath) {
  assert.equal(loginResponse.status, 200);
  assert.match(loginResponse.body, /Access Granted/);
  assert.equal(loginResponse.body.includes(`href="${expectedNextPath}"`), true);
}

async function withTempDir(callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-server-test-"));
  try {
    await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function waitForCondition(predicate, timeoutMs = 2000, intervalMs = 25) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timed out waiting for condition");
}

function wsHandshake(port, path = "/socket", cookie = "") {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout waiting for websocket handshake"));
    }, 3000);

    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      const key = crypto.randomBytes(16).toString("base64");
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${key}`,
      ];

      if (cookie) {
        lines.push(`Cookie: ${cookie}`);
      }

      lines.push("", "");
      socket.write(lines.join("\r\n"));
    });

    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (!data.includes("\r\n\r\n")) {
        return;
      }

      clearTimeout(timeout);
      const [head] = data.split("\r\n\r\n");
      const [statusLine] = head.split("\r\n");
      socket.destroy();
      resolve({ statusLine, head });
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function getLoginCsrf(port, jar, next = "/") {
  const response = await request(
    port,
    {
      method: "GET",
      path: `/login?next=${encodeURIComponent(next)}`,
      headers: { accept: "text/html" },
    },
    jar,
  );

  assert.equal(response.status, 200);
  return parseCsrf(response.body);
}

async function postLogin(port, jar, { csrf, username, password, totp = "", next = "/" }, originOverride = "") {
  const body = new URLSearchParams({ csrf, username, password, totp, next }).toString();
  return request(
    port,
    {
      method: "POST",
      path: "/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
        origin: originOverride || `http://127.0.0.1:${port}`,
      },
      body,
    },
    jar,
  );
}

async function postForm(port, jar, routePath, fields, originOverride = "") {
  const body = new URLSearchParams(
    Object.entries(fields).map(([key, value]) => [key, String(value ?? "")]),
  ).toString();
  return request(
    port,
    {
      method: "POST",
      path: routePath,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
        origin: originOverride || `http://127.0.0.1:${port}`,
      },
      body,
    },
    jar,
  );
}

test("gateway behavior without TOTP", async (t) => {
  const target = await startTargetServer();
  const gateway = await startGateway({
    foundryTarget: target.targetUrl,
    requireTotp: false,
    loginRateLimitMax: 100,
    loginRateLimitWindowMs: 60_000,
  });

  t.after(async () => {
    await closeServer(gateway.server);
    await closeServer(target.server);
  });

  await t.test("health + public assets are reachable", async () => {
    const health = await request(gateway.port, { path: "/healthz" });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });

    const css = await request(gateway.port, { path: "/assets/theme.css" });
    assert.equal(css.status, 200);
    assert.match(css.body, /--bg-deep/);
  });

  await t.test("auth guard redirects HTML and returns JSON 401 for API-style requests", async () => {
    const html = await request(gateway.port, {
      path: "/campaign",
      headers: { accept: "text/html" },
    });
    assert.equal(html.status, 302);
    assert.equal(html.headers.location, "/login?next=%2Fcampaign");

    const json = await request(gateway.port, {
      path: "/campaign",
      headers: { accept: "application/json" },
    });
    assert.equal(json.status, 401);
    assert.deepEqual(JSON.parse(json.body), { error: "Authentication required" });
  });

  await t.test("login page renders without TOTP field", async () => {
    const jar = new CookieJar();
    const response = await request(
      gateway.port,
      { path: "/login", headers: { accept: "text/html" } },
      jar,
    );

    assert.equal(response.status, 200);
    assert.match(response.body, /Blastdoor/);
    assert.doesNotMatch(response.body, /Authenticator Code/);
    assert.ok(parseCsrf(response.body));
  });

  await t.test("login rejects wrong origin and bad csrf", async () => {
    const jar = new CookieJar();
    const csrf = await getLoginCsrf(gateway.port, jar, "/");

    const wrongOrigin = await postLogin(
      gateway.port,
      jar,
      {
        csrf,
        username: gateway.username,
        password: gateway.password,
        next: "/",
      },
      "http://evil.example",
    );

    assert.equal(wrongOrigin.status, 403);
    assert.match(wrongOrigin.body, /Forbidden/);

    const badCsrf = await postLogin(gateway.port, jar, {
      csrf: "bad-token",
      username: gateway.username,
      password: gateway.password,
      next: "/",
    });

    assert.equal(badCsrf.status, 403);
    assert.match(badCsrf.body, /Invalid CSRF token/);
  });

  await t.test("login rejects literal null origin when not enabled", async () => {
    const jar = new CookieJar();
    const csrf = await getLoginCsrf(gateway.port, jar, "/");
    const response = await postLogin(
      gateway.port,
      jar,
      {
        csrf,
        username: gateway.username,
        password: gateway.password,
        next: "/",
      },
      "null",
    );

    assert.equal(response.status, 403);
  });

  await t.test("login accepts localhost origin while accessed on 127.0.0.1", async () => {
    const jar = new CookieJar();
    const csrf = await getLoginCsrf(gateway.port, jar, "/");
    const response = await postLogin(
      gateway.port,
      jar,
      {
        csrf,
        username: gateway.username,
        password: gateway.password,
        next: "/",
      },
      `http://localhost:${gateway.port}`,
    );

    assertTransitionResponse(response, "/");
  });

  await t.test("login accepts configured allowed origin override", async () => {
    const targetOverride = await startTargetServer();
    const gatewayOverride = await startGateway({
      foundryTarget: targetOverride.targetUrl,
      requireTotp: false,
      allowedOrigins: "https://portal.example.test",
    });

    try {
      const jar = new CookieJar();
      const csrf = await getLoginCsrf(gatewayOverride.port, jar, "/");
      const response = await postLogin(
        gatewayOverride.port,
        jar,
        {
          csrf,
          username: gatewayOverride.username,
          password: gatewayOverride.password,
          next: "/",
        },
        "https://portal.example.test",
      );

      assertTransitionResponse(response, "/");
    } finally {
      await closeServer(gatewayOverride.server);
      await closeServer(targetOverride.server);
    }
  });

  await t.test("login accepts literal null origin when enabled", async () => {
    const targetOverride = await startTargetServer();
    const gatewayOverride = await startGateway({
      foundryTarget: targetOverride.targetUrl,
      requireTotp: false,
      allowNullOrigin: true,
    });

    try {
      const jar = new CookieJar();
      const csrf = await getLoginCsrf(gatewayOverride.port, jar, "/");
      const response = await postLogin(
        gatewayOverride.port,
        jar,
        {
          csrf,
          username: gatewayOverride.username,
          password: gatewayOverride.password,
          next: "/",
        },
        "null",
      );

      assertTransitionResponse(response, "/");
    } finally {
      await closeServer(gatewayOverride.server);
      await closeServer(targetOverride.server);
    }
  });

  await t.test("login rejects invalid credentials", async () => {
    const jar = new CookieJar();
    const csrf = await getLoginCsrf(gateway.port, jar, "/");

    const response = await postLogin(gateway.port, jar, {
      csrf,
      username: gateway.username,
      password: "wrong-password",
      next: "/",
    });

    assert.equal(response.status, 401);
    assert.match(response.body, /Access denied/);
  });

  await t.test("successful login proxies requests and supports safe next fallback", async () => {
    const jar = new CookieJar();
    const csrf = await getLoginCsrf(gateway.port, jar, "//evil.example");

    const login = await postLogin(gateway.port, jar, {
      csrf,
      username: gateway.username,
      password: gateway.password,
      next: "//evil.example",
    });

    assertTransitionResponse(login, "/");

    const proxied = await request(
      gateway.port,
      { path: "/my-world", headers: { accept: "application/json" } },
      jar,
    );

    assert.equal(proxied.status, 200);
    const parsed = JSON.parse(proxied.body);
    assert.equal(parsed.path, "/my-world");

    assert.equal(target.requests.at(-1).path, "/my-world");
  });

  await t.test("logout clears session", async () => {
    const jar = new CookieJar();
    const csrf = await getLoginCsrf(gateway.port, jar, "/");

    const login = await postLogin(gateway.port, jar, {
      csrf,
      username: gateway.username,
      password: gateway.password,
      next: "/",
    });
    assert.equal(login.status, 200);
    assert.match(login.body, /Access Granted/);

    const logout = await request(gateway.port, { method: "POST", path: "/logout" }, jar);
    assert.equal(logout.status, 302);
    assert.equal(logout.headers.location, "/login");

    const after = await request(
      gateway.port,
      { path: "/after-logout", headers: { accept: "application/json" } },
      jar,
    );
    assert.equal(after.status, 401);
  });

  await t.test("login reauth query clears active session and returns login screen", async () => {
    const jar = new CookieJar();
    const csrf = await getLoginCsrf(gateway.port, jar, "/reauth-check");

    const login = await postLogin(gateway.port, jar, {
      csrf,
      username: gateway.username,
      password: gateway.password,
      next: "/reauth-check",
    });
    assertTransitionResponse(login, "/reauth-check");

    const forceReauth = await request(
      gateway.port,
      {
        path: "/login?reauth=1&next=%2Freauth-check",
        headers: { accept: "text/html" },
      },
      jar,
    );
    assert.equal(forceReauth.status, 302);
    assert.equal(forceReauth.headers.location, "/login?next=%2Freauth-check");

    const loginPage = await request(
      gateway.port,
      {
        path: "/login?next=%2Freauth-check",
        headers: { accept: "text/html" },
      },
      jar,
    );
    assert.equal(loginPage.status, 200);
    assert.match(loginPage.body, /<form method="post" action="\/login"/);

    const protectedAfterReauth = await request(
      gateway.port,
      { path: "/reauth-check", headers: { accept: "application/json" } },
      jar,
    );
    assert.equal(protectedAfterReauth.status, 401);
  });

  await t.test("websocket upgrades require auth", async () => {
    const unauth = await wsHandshake(gateway.port, "/socket");
    assert.match(unauth.statusLine, /^HTTP\/1\.1 401/);

    const jar = new CookieJar();
    const csrf = await getLoginCsrf(gateway.port, jar, "/");
    const login = await postLogin(gateway.port, jar, {
      csrf,
      username: gateway.username,
      password: gateway.password,
      next: "/",
    });
    assertTransitionResponse(login, "/");

    const auth = await wsHandshake(gateway.port, "/socket", jar.header());
    assert.match(auth.statusLine, /^HTTP\/1\.1 101/);
  });

});

test("gateway behavior with TOTP enabled", async (t) => {
  const target = await startTargetServer();
  const totpSecret = authenticator.generateSecret();
  const gateway = await startGateway({
    foundryTarget: target.targetUrl,
    requireTotp: true,
    totpSecret,
    loginRateLimitMax: 10,
  });

  t.after(async () => {
    await closeServer(gateway.server);
    await closeServer(target.server);
  });

  const jar = new CookieJar();
  const loginPage = await request(gateway.port, { path: "/login", headers: { accept: "text/html" } }, jar);
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.body, /Authenticator Code/);

  const badTokenCsrf = parseCsrf(loginPage.body);
  const badToken = await postLogin(gateway.port, jar, {
    csrf: badTokenCsrf,
    username: gateway.username,
    password: gateway.password,
    next: "/",
    totp: "000000",
  });

  assert.equal(badToken.status, 401);

  const csrf = await getLoginCsrf(gateway.port, jar, "/session");
  const goodToken = authenticator.generate(totpSecret);
  const login = await postLogin(gateway.port, jar, {
    csrf,
    username: gateway.username,
    password: gateway.password,
    next: "/session",
    totp: goodToken,
  });

  assertTransitionResponse(login, "/session");

  const proxied = await request(gateway.port, { path: "/session", headers: { accept: "application/json" } }, jar);
  assert.equal(proxied.status, 200);
});

test("login page renders active theme assets and success transition uses open background", async (t) => {
  await withTempDir(async (tempDir) => {
    const target = await startTargetServer();
    const graphicsDir = path.join(tempDir, "graphics");
    const logoDir = path.join(graphicsDir, "logo");
    const backgroundDir = path.join(graphicsDir, "background");
    const themeStorePath = path.join(graphicsDir, "themes", "themes.json");

    await fs.mkdir(logoDir, { recursive: true });
    await fs.mkdir(backgroundDir, { recursive: true });
    await fs.mkdir(path.dirname(themeStorePath), { recursive: true });
    await fs.writeFile(path.join(logoDir, "test-logo.png"), "logo", "utf8");
    await fs.writeFile(path.join(backgroundDir, "test-closed.png"), "closed", "utf8");
    await fs.writeFile(path.join(backgroundDir, "test-open.png"), "open", "utf8");
    await fs.writeFile(
      themeStorePath,
      JSON.stringify(
        {
          activeThemeId: "theme-one",
          themes: [
            {
              id: "theme-one",
              name: "Theme One",
              logoPath: "logo/test-logo.png",
              closedBackgroundPath: "background/test-closed.png",
              openBackgroundPath: "background/test-open.png",
              loginBoxWidthPercent: 80,
              loginBoxHeightPercent: 70,
              loginBoxOpacityPercent: 62,
              loginBoxHoverOpacityPercent: 90,
              loginBoxPosXPercent: 65,
              loginBoxPosYPercent: 35,
              logoSizePercent: 90,
              logoOffsetXPercent: 15,
              logoOffsetYPercent: 12,
              backgroundZoomPercent: 140,
              loginBoxMode: "light",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const gateway = await startGateway({
      foundryTarget: target.targetUrl,
      requireTotp: false,
      graphicsDir,
      themeStorePath,
    });

    t.after(async () => {
      await closeServer(gateway.server);
      await closeServer(target.server);
    });

    const jar = new CookieJar();
    const loginPage = await request(gateway.port, { path: "/login", headers: { accept: "text/html" } }, jar);
    assert.equal(loginPage.status, 200);
    assert.match(loginPage.body, /\/graphics\/logo\/test-logo\.png/);
    assert.match(loginPage.body, /\/graphics\/background\/test-closed\.png/);
    assert.match(loginPage.body, /\/graphics\/background\/test-open\.png/);
    assert.match(loginPage.body, /--login-box-width-scale:0\.8000/);
    assert.match(loginPage.body, /--login-box-height-scale:0\.7000/);
    assert.match(loginPage.body, /--login-box-opacity-scale:0\.6200/);
    assert.match(loginPage.body, /--login-box-hover-opacity-scale:0\.9000/);
    assert.match(loginPage.body, /--login-box-shift-x:15\.00vw/);
    assert.match(loginPage.body, /--login-box-shift-y:-15\.00vh/);
    assert.match(loginPage.body, /--logo-size-scale:3\.0000/);
    assert.match(loginPage.body, /--logo-offset-x:15\.00vw/);
    assert.match(loginPage.body, /--logo-offset-y:12\.00vh/);
    assert.match(loginPage.body, /--background-zoom-scale:1\.4000/);
    assert.match(loginPage.body, /data-login-box-mode="light"/);

    const csrf = parseCsrf(loginPage.body);
    const login = await postLogin(gateway.port, jar, {
      csrf,
      username: gateway.username,
      password: gateway.password,
      next: "/theme-world",
    });
    assertTransitionResponse(login, "/theme-world");
    assert.match(login.body, /auth-success-active/);
    assert.match(login.body, /\/graphics\/background\/test-open\.png/);
    assert.match(login.body, /--login-box-width-scale:0\.8000/);
    assert.match(login.body, /--login-box-height-scale:0\.7000/);
    assert.match(login.body, /--login-box-opacity-scale:0\.6200/);
    assert.match(login.body, /--login-box-hover-opacity-scale:0\.9000/);
    assert.match(login.body, /--login-box-shift-x:15\.00vw/);
    assert.match(login.body, /--login-box-shift-y:-15\.00vh/);
    assert.match(login.body, /--background-zoom-scale:1\.4000/);
    assert.match(login.body, /data-login-box-mode="light"/);
  });
});

test("login page falls back when theme image assets are missing", async (t) => {
  await withTempDir(async (tempDir) => {
    const target = await startTargetServer();
    const graphicsDir = path.join(tempDir, "graphics");
    const themeStorePath = path.join(graphicsDir, "themes", "themes.json");

    await fs.mkdir(path.dirname(themeStorePath), { recursive: true });
    await fs.writeFile(
      themeStorePath,
      JSON.stringify(
        {
          activeThemeId: "theme-missing",
          themes: [
            {
              id: "theme-missing",
              name: "Missing Theme",
              logoPath: "logo/missing-logo.png",
              closedBackgroundPath: "background/missing-closed.png",
              openBackgroundPath: "background/missing-open.png",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const gateway = await startGateway({
      foundryTarget: target.targetUrl,
      requireTotp: false,
      graphicsDir,
      themeStorePath,
    });

    t.after(async () => {
      await closeServer(gateway.server);
      await closeServer(target.server);
    });

    const loginPage = await request(gateway.port, { path: "/login", headers: { accept: "text/html" } });
    assert.equal(loginPage.status, 200);
    assert.equal(loginPage.body.includes('class="brand-logo"'), false);
    assert.match(loginPage.body, /brand-logo-fallback/);
    assert.equal(loginPage.body.includes("/graphics/logo/missing-logo.png"), false);
    assert.equal(loginPage.body.includes("/graphics/background/missing-closed.png"), false);
    assert.equal(loginPage.body.includes("/graphics/background/missing-open.png"), false);
  });
});

test("runtime blast doors state file toggles lock mode without service restart", async (t) => {
  await withTempDir(async (tempDir) => {
    const target = await startTargetServer();
    const runtimeStatePath = path.join(tempDir, "runtime-state.json");
    const gateway = await startGateway({
      foundryTarget: target.targetUrl,
      requireTotp: false,
      blastDoorsClosed: false,
      runtimeStatePath,
    });

    t.after(async () => {
      await closeServer(gateway.server);
      await closeServer(target.server);
    });

    const initial = await request(gateway.port, { path: "/login", headers: { accept: "text/html" } });
    assert.equal(initial.status, 200);

    await writeBlastDoorsState(runtimeStatePath, true);
    await new Promise((resolve) => setTimeout(resolve, 320));

    const locked = await request(gateway.port, { path: "/login", headers: { accept: "text/html" } });
    assert.equal(locked.status, 503);
    assert.equal(locked.headers["x-blastdoors-state"], "locked");

    await writeBlastDoorsState(runtimeStatePath, false);
    await new Promise((resolve) => setTimeout(resolve, 320));

    const unlocked = await request(gateway.port, { path: "/login", headers: { accept: "text/html" } });
    assert.equal(unlocked.status, 200);
  });
});

test("blast doors closed mode blocks all routes and websocket upgrades", async (t) => {
  const target = await startTargetServer();
  const gateway = await startGateway({
    foundryTarget: target.targetUrl,
    requireTotp: false,
    blastDoorsClosed: true,
  });

  t.after(async () => {
    await closeServer(gateway.server);
    await closeServer(target.server);
  });

  const blockedPaths = ["/healthz", "/assets/theme.css", "/login", "/world", "/logout"];
  for (const blockedPath of blockedPaths) {
    const response = await request(gateway.port, {
      path: blockedPath,
      headers: { accept: "text/html" },
    });

    assert.equal(response.status, 503);
    assert.equal(response.headers["x-blastdoors-state"], "locked");
    assert.match(response.body, /Blast Doors Are Locked/);
  }

  const postLoginBlocked = await request(gateway.port, {
    method: "POST",
    path: "/login",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
    },
    body: "username=gm&password=abc",
  });
  assert.equal(postLoginBlocked.status, 503);
  assert.match(postLoginBlocked.body, /Gateway lockout is active/);

  const websocketBlocked = await wsHandshake(gateway.port, "/socket");
  assert.match(websocketBlocked.statusLine, /^HTTP\/1\.1 503/);

  assert.equal(target.requests.length, 0);
});

test("gateway authenticates using file password store", async (t) => {
  await withTempDir(async (tempDir) => {
    const target = await startTargetServer();
    const password = "Correct Horse Battery Staple 123!";
    const authPasswordHash = createPasswordHash(password);
    const storeFile = path.join(tempDir, "password-store.json");
    await fs.writeFile(
      storeFile,
      JSON.stringify({
        users: [{ username: "gm", passwordHash: authPasswordHash }],
      }),
      "utf8",
    );

    const gateway = await startGateway({
      foundryTarget: target.targetUrl,
      requireTotp: false,
      passwordStoreMode: "file",
      passwordStoreFile: storeFile,
    });

    t.after(async () => {
      await closeServer(gateway.server);
      await closeServer(target.server);
    });

    const jar = new CookieJar();
    const csrf = await getLoginCsrf(gateway.port, jar, "/file-mode");
    const login = await postLogin(gateway.port, jar, {
      csrf,
      username: "gm",
      password,
      next: "/file-mode",
    });

    assertTransitionResponse(login, "/file-mode");

    const proxied = await request(
      gateway.port,
      { path: "/file-mode", headers: { accept: "application/json" } },
      jar,
    );
    assert.equal(proxied.status, 200);
  });
});

test("gateway authenticates using sqlite password store", async (t) => {
  await withTempDir(async (tempDir) => {
    const target = await startTargetServer();
    const password = "Correct Horse Battery Staple 123!";
    const authPasswordHash = createPasswordHash(password);
    const databaseFile = path.join(tempDir, "blastdoor.sqlite");
    const sqliteGateway = await startGateway({
      foundryTarget: target.targetUrl,
      requireTotp: false,
      passwordStoreMode: "sqlite",
      databaseFile,
    });

    const database = new BlastdoorDatabase({ filePath: databaseFile });
    database.upsertUser({
      username: "gm",
      passwordHash: authPasswordHash,
      disabled: false,
    });
    database.close();

    t.after(async () => {
      await closeServer(sqliteGateway.server);
      await closeServer(target.server);
    });

    const jar = new CookieJar();
    const csrf = await getLoginCsrf(sqliteGateway.port, jar, "/sqlite-mode");
    const login = await postLogin(sqliteGateway.port, jar, {
      csrf,
      username: "gm",
      password,
      next: "/sqlite-mode",
    });

    assertTransitionResponse(login, "/sqlite-mode");

    const proxied = await request(
      sqliteGateway.port,
      { path: "/sqlite-mode", headers: { accept: "application/json" } },
      jar,
    );
    assert.equal(proxied.status, 200);
  });
});

test("gateway authenticates using postgres password store", async (t) => {
  const { factory, state } = createMockPostgresPoolFactory();
  const target = await startTargetServer();
  const password = "Correct Horse Battery Staple 123!";
  const authPasswordHash = createPasswordHash(password);

  const seededDb = new BlastdoorPostgresDatabase({
    connectionString: "postgres://blastdoor:test@localhost:5432/blastdoor",
    poolFactory: factory,
  });
  await seededDb.upsertUser({
    username: "gm",
    passwordHash: authPasswordHash,
    disabled: false,
  });
  await seededDb.close();

  const { factory: gatewayFactory } = createMockPostgresPoolFactory(state);
  const gateway = await startGateway({
    foundryTarget: target.targetUrl,
    requireTotp: false,
    passwordStoreMode: "postgres",
    postgresUrl: "postgres://blastdoor:test@localhost:5432/blastdoor",
    postgresSsl: false,
    postgresPoolFactory: gatewayFactory,
  });

  t.after(async () => {
    await closeServer(gateway.server);
    await closeServer(target.server);
  });

  const jar = new CookieJar();
  const csrf = await getLoginCsrf(gateway.port, jar, "/postgres-mode");
  const login = await postLogin(gateway.port, jar, {
    csrf,
    username: "gm",
    password,
    next: "/postgres-mode",
  });

  assertTransitionResponse(login, "/postgres-mode");

  const proxied = await request(
    gateway.port,
    { path: "/postgres-mode", headers: { accept: "application/json" } },
    jar,
  );
  assert.equal(proxied.status, 200);
});

test("postgres config snapshot persists across gateway restarts", async (t) => {
  const { factory, state } = createMockPostgresPoolFactory();
  const target = await startTargetServer();

  const gatewayOne = await startGateway({
    foundryTarget: target.targetUrl,
    requireTotp: false,
    configStoreMode: "postgres",
    postgresUrl: "postgres://blastdoor:test@localhost:5432/blastdoor",
    postgresSsl: false,
    postgresPoolFactory: factory,
  });

  const { factory: verifyFactory } = createMockPostgresPoolFactory(state);
  const verifyDb = new BlastdoorPostgresDatabase({
    connectionString: "postgres://blastdoor:test@localhost:5432/blastdoor",
    poolFactory: verifyFactory,
  });
  await waitForCondition(async () => Boolean(await verifyDb.getConfigValue("FOUNDRY_TARGET")));
  assert.equal(await verifyDb.getConfigValue("FOUNDRY_TARGET"), target.targetUrl);
  await verifyDb.close();
  await closeServer(gatewayOne.server);

  const { factory: gatewayTwoFactory } = createMockPostgresPoolFactory(state);
  const gatewayTwo = await startGateway({
    foundryTarget: target.targetUrl,
    requireTotp: false,
    configStoreMode: "postgres",
    postgresUrl: "postgres://blastdoor:test@localhost:5432/blastdoor",
    postgresSsl: false,
    postgresPoolFactory: gatewayTwoFactory,
  });

  t.after(async () => {
    await closeServer(gatewayTwo.server);
    await closeServer(target.server);
  });

  const { factory: verifyAfterRestartFactory } = createMockPostgresPoolFactory(state);
  const verifyAfterRestart = new BlastdoorPostgresDatabase({
    connectionString: "postgres://blastdoor:test@localhost:5432/blastdoor",
    poolFactory: verifyAfterRestartFactory,
  });
  assert.equal(await verifyAfterRestart.getConfigValue("FOUNDRY_TARGET"), target.targetUrl);
  await verifyAfterRestart.close();
});

test("proxy returns 502 when target is unreachable", async (t) => {
  const deadTarget = http.createServer();
  deadTarget.listen(0, "127.0.0.1");
  await once(deadTarget, "listening");
  const deadPort = deadTarget.address().port;
  await closeServer(deadTarget);

  const gateway = await startGateway({
    foundryTarget: `http://127.0.0.1:${deadPort}`,
    requireTotp: false,
  });

  t.after(async () => {
    await closeServer(gateway.server);
  });

  const jar = new CookieJar();
  const csrf = await getLoginCsrf(gateway.port, jar, "/");
  const login = await postLogin(gateway.port, jar, {
    csrf,
    username: gateway.username,
    password: gateway.password,
    next: "/",
  });

  assertTransitionResponse(login, "/");

  const proxied = await request(gateway.port, { path: "/world", headers: { accept: "application/json" } }, jar);
  assert.ok([502, 504].includes(proxied.status));
  assert.match(proxied.body, /Gateway error/i);
  assert.match(proxied.body, /Foundry target refused the connection|Verify FOUNDRY_TARGET/i);
});

test("login rate limiting blocks excessive attempts", async (t) => {
  const target = await startTargetServer();
  const gateway = await startGateway({
    foundryTarget: target.targetUrl,
    requireTotp: false,
    loginRateLimitMax: 2,
    loginRateLimitWindowMs: 60_000,
  });

  t.after(async () => {
    await closeServer(gateway.server);
    await closeServer(target.server);
  });

  const jar = new CookieJar();

  for (let i = 0; i < 2; i += 1) {
    const csrf = await getLoginCsrf(gateway.port, jar, "/");
    const response = await postLogin(gateway.port, jar, {
      csrf,
      username: gateway.username,
      password: "not-the-password",
      next: "/",
    });
    assert.equal(response.status, 401);
  }

  const csrf = await getLoginCsrf(gateway.port, jar, "/");
  const blocked = await postLogin(gateway.port, jar, {
    csrf,
    username: gateway.username,
    password: "not-the-password",
    next: "/",
  });

  assert.equal(blocked.status, 429);
  assert.match(blocked.body, /Too many login attempts/);
});

test("user profile store supports temp code login and per-user token invalidation", async (t) => {
  await withTempDir(async (tempDir) => {
    const target = await startTargetServer();
    const userProfileStorePath = path.join(tempDir, "user-profiles.json");
    const passwordStoreFile = path.join(tempDir, "password-store.json");
    const password = "Correct Horse Battery Staple 123!";
    await fs.writeFile(
      passwordStoreFile,
      JSON.stringify(
        {
          users: [{ username: "gm", passwordHash: createPasswordHash(password), disabled: false }],
        },
        null,
        2,
      ),
      "utf8",
    );
    const gateway = await startGateway({
      foundryTarget: target.targetUrl,
      requireTotp: false,
      userProfileStorePath,
      passwordStoreMode: "file",
      passwordStoreFile,
    });

    t.after(async () => {
      await closeServer(gateway.server);
      await closeServer(target.server);
    });

    const profileStore = createUserAdminStore({ filePath: userProfileStorePath });
    await profileStore.upsertProfile({
      username: gateway.username,
      status: "active",
      firstLoginCompletedAt: new Date().toISOString(),
    });
    const issuedCode = await profileStore.issueTemporaryLoginCode(gateway.username, {
      ttlMinutes: 30,
      delivery: "manual",
    });

    const jar = new CookieJar();
    const csrf = await getLoginCsrf(gateway.port, jar, "/");
    const loginWithTempCode = await postLogin(gateway.port, jar, {
      csrf,
      username: gateway.username,
      password: issuedCode.code,
      next: "/",
    });
    assertTransitionResponse(loginWithTempCode, "/account?next=%2F");

    const accountPage = await request(gateway.port, { path: "/account?next=%2F", headers: { accept: "text/html" } }, jar);
    assert.equal(accountPage.status, 200);
    const accountCsrf = parseCsrf(accountPage.body);

    const newPassword = "Temp Flow Replacement Password 123!";
    const passwordUpdated = await postForm(gateway.port, jar, "/account/password", {
      csrf: accountCsrf,
      next: "/",
      currentPassword: "",
      newPassword,
      confirmPassword: newPassword,
    });
    assert.equal(passwordUpdated.status, 200);
    assert.match(passwordUpdated.body, /Password updated/);

    const proxiedBeforeInvalidate = await request(
      gateway.port,
      { path: "/world", headers: { accept: "application/json" } },
      jar,
    );
    assert.equal(proxiedBeforeInvalidate.status, 200);

    await profileStore.invalidateUserSessions(gateway.username);
    const proxiedAfterInvalidate = await request(
      gateway.port,
      { path: "/world", headers: { accept: "application/json" } },
      jar,
    );
    assert.equal(proxiedAfterInvalidate.status, 401);

    await profileStore.upsertProfile({
      username: gateway.username,
      status: "banned",
    });
    const bannedJar = new CookieJar();
    const bannedCsrf = await getLoginCsrf(gateway.port, bannedJar, "/");
    const bannedLogin = await postLogin(gateway.port, bannedJar, {
      csrf: bannedCsrf,
      username: gateway.username,
      password: gateway.password,
      next: "/",
    });
    assert.equal(bannedLogin.status, 401);
    assert.match(bannedLogin.body, /Access denied/i);
  });
});

test("temporary login code forces account password update before proxy access", async (t) => {
  await withTempDir(async (tempDir) => {
    const target = await startTargetServer();
    const userProfileStorePath = path.join(tempDir, "user-profiles.json");
    const passwordStoreFile = path.join(tempDir, "password-store.json");
    const password = "Correct Horse Battery Staple 123!";
    await fs.writeFile(
      passwordStoreFile,
      JSON.stringify(
        {
          users: [{ username: "gm", passwordHash: createPasswordHash(password), disabled: false }],
        },
        null,
        2,
      ),
      "utf8",
    );
    const gateway = await startGateway({
      foundryTarget: target.targetUrl,
      requireTotp: false,
      userProfileStorePath,
      passwordStoreMode: "file",
      passwordStoreFile,
    });

    t.after(async () => {
      await closeServer(gateway.server);
      await closeServer(target.server);
    });

    const profileStore = createUserAdminStore({ filePath: userProfileStorePath });
    await profileStore.upsertProfile({
      username: gateway.username,
      status: "active",
      firstLoginCompletedAt: new Date().toISOString(),
    });
    const issuedCode = await profileStore.issueTemporaryLoginCode(gateway.username, {
      ttlMinutes: 30,
      delivery: "manual",
    });

    const jar = new CookieJar();
    const csrf = await getLoginCsrf(gateway.port, jar, "/world");
    const loginWithTempCode = await postLogin(gateway.port, jar, {
      csrf,
      username: gateway.username,
      password: issuedCode.code,
      next: "/world",
    });
    assertTransitionResponse(loginWithTempCode, "/account?next=%2Fworld");
    assert.match(loginWithTempCode.body, /My Account/);

    const blockedProxy = await request(
      gateway.port,
      { path: "/world", headers: { accept: "application/json" } },
      jar,
    );
    assert.equal(blockedProxy.status, 428);
    assert.equal(JSON.parse(blockedProxy.body).accountPath, "/account?next=%2Fworld");

    const accountPage = await request(
      gateway.port,
      { path: "/account?next=%2Fworld", headers: { accept: "text/html" } },
      jar,
    );
    assert.equal(accountPage.status, 200);
    assert.match(accountPage.body, /Password change is required/);
    const accountCsrf = parseCsrf(accountPage.body);

    const newPassword = "New Correct Horse Battery Staple 456!";
    const passwordUpdated = await postForm(gateway.port, jar, "/account/password", {
      csrf: accountCsrf,
      next: "/world",
      currentPassword: "",
      newPassword,
      confirmPassword: newPassword,
    });
    assert.equal(passwordUpdated.status, 200);
    assert.match(passwordUpdated.body, /Password updated/);

    const proxied = await request(
      gateway.port,
      { path: "/world", headers: { accept: "application/json" } },
      jar,
    );
    assert.equal(proxied.status, 200);

    const logout = await request(gateway.port, { path: "/logout", headers: { accept: "text/html" } }, jar);
    assert.equal(logout.status, 302);

    const csrf2 = await getLoginCsrf(gateway.port, jar, "/world");
    const loginWithNewPassword = await postLogin(gateway.port, jar, {
      csrf: csrf2,
      username: gateway.username,
      password: newPassword,
      next: "/world",
    });
    assertTransitionResponse(loginWithNewPassword, "/world");
  });
});

test("account self-service updates profile and supports message-admin action", async (t) => {
  await withTempDir(async (tempDir) => {
    const target = await startTargetServer();
    const userProfileStorePath = path.join(tempDir, "user-profiles.json");
    const gateway = await startGateway({
      foundryTarget: target.targetUrl,
      requireTotp: false,
      userProfileStorePath,
      emailProvider: "console",
      emailFrom: "blastdoor@example.test",
      emailAdminTo: "admin@example.test",
      publicBaseUrl: "http://127.0.0.1",
    });

    t.after(async () => {
      await closeServer(gateway.server);
      await closeServer(target.server);
    });

    const profileStore = createUserAdminStore({ filePath: userProfileStorePath });
    await profileStore.upsertProfile({
      username: gateway.username,
      status: "active",
    });

    const jar = new CookieJar();
    const csrf = await getLoginCsrf(gateway.port, jar, "/");
    const login = await postLogin(gateway.port, jar, {
      csrf,
      username: gateway.username,
      password: gateway.password,
      next: "/",
    });
    assert.equal(login.status, 200);
    assert.match(login.body, /Access Granted/);

    const accountPage = await request(gateway.port, { path: "/account?next=%2F", headers: { accept: "text/html" } }, jar);
    assert.equal(accountPage.status, 200);
    const accountCsrf = parseCsrf(accountPage.body);

    const profileUpdate = await postForm(gateway.port, jar, "/account/profile", {
      csrf: accountCsrf,
      next: "/",
      friendlyName: "Gate Keeper",
      email: "gatekeeper@example.test",
      contactInfo: "Discord: gatekeeper#1234",
      avatarUrl: "https://example.test/avatar.png",
      displayInfo: "Campaign host",
    });
    assert.equal(profileUpdate.status, 200);
    assert.match(profileUpdate.body, /Profile updated/);

    const profileAfterUpdate = await profileStore.getRawProfile(gateway.username);
    assert.equal(profileAfterUpdate?.friendlyName, "Gate Keeper");
    assert.equal(profileAfterUpdate?.email, "gatekeeper@example.test");
    assert.equal(profileAfterUpdate?.contactInfo, "Discord: gatekeeper#1234");
    assert.equal(profileAfterUpdate?.avatarUrl, "https://example.test/avatar.png");
    assert.equal(profileAfterUpdate?.displayInfo, "Campaign host");

    const messageCsrf = parseCsrf(profileUpdate.body);
    const adminMessage = await postForm(gateway.port, jar, "/account/message-admin", {
      csrf: messageCsrf,
      next: "/",
      subject: "Need help",
      message: "Please review my account profile settings.",
    });
    assert.equal(adminMessage.status, 200);
    assert.match(adminMessage.body, /Message sent to admin/);
  });
});
