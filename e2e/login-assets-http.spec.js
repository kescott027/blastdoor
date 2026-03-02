import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import crypto from "node:crypto";
import { createServer } from "../src/server.js";
import { createPasswordHash } from "../src/security.js";

let tempDir;
let targetServer;
let gatewayServer;
let baseUrl;
let targetUrl;

async function closeServer(server) {
  if (!server || !server.listening) {
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

test.beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-playwright-http-assets-"));
  const graphicsDir = path.join(tempDir, "graphics");
  const themeStorePath = path.join(graphicsDir, "themes", "themes.json");

  await fs.mkdir(path.join(graphicsDir, "logo"), { recursive: true });
  await fs.mkdir(path.join(graphicsDir, "background"), { recursive: true });
  await fs.mkdir(path.join(graphicsDir, "themes"), { recursive: true });

  await fs.writeFile(
    path.join(graphicsDir, "logo", "test-logo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#33ccff"/></svg>',
    "utf8",
  );
  await fs.writeFile(
    path.join(graphicsDir, "background", "test-closed.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#223344"/></svg>',
    "utf8",
  );
  await fs.writeFile(
    path.join(graphicsDir, "background", "test-open.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#446622"/></svg>',
    "utf8",
  );
  await fs.writeFile(
    themeStorePath,
    `${JSON.stringify(
      {
        activeThemeId: "test-theme",
        themes: [
          {
            id: "test-theme",
            name: "Test Theme",
            logoPath: "logo/test-logo.svg",
            closedBackgroundPath: "background/test-closed.svg",
            openBackgroundPath: "background/test-open.svg",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  targetServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  targetServer.listen(0, "127.0.0.1");
  await once(targetServer, "listening");
  targetUrl = `http://127.0.0.1:${targetServer.address().port}`;

  gatewayServer = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      foundryTarget: targetUrl,
      authUsername: "gm",
      authPasswordHash: createPasswordHash("Correct Horse Battery Staple 123!"),
      requireTotp: false,
      totpSecret: "",
      sessionSecret: crypto.randomUUID() + crypto.randomUUID(),
      sessionMaxAgeHours: 12,
      cookieSecure: false,
      trustProxy: false,
      proxyTlsVerify: true,
      loginRateLimitWindowMs: 900_000,
      loginRateLimitMax: 8,
      passwordStoreMode: "env",
      passwordStoreFile: "",
      configStoreMode: "env",
      databaseFile: "",
      postgresUrl: "",
      postgresSsl: false,
      allowedOrigins: "",
      allowNullOrigin: true,
      publicBaseUrl: "",
      blastDoorsClosed: false,
      tlsEnabled: false,
      tlsDomain: "",
      tlsEmail: "",
      tlsChallengeMethod: "webroot",
      tlsWebrootPath: "",
      tlsCertFile: "",
      tlsKeyFile: "",
      tlsCaFile: "",
      tlsPassphrase: "",
      emailProvider: "disabled",
      emailFrom: "",
      emailAdminTo: "",
      smtpHost: "",
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: "",
      smtpPass: "",
      smtpIgnoreTls: false,
      debugMode: false,
      debugLogFile: "",
    },
    {
      silent: true,
      exitOnListenError: false,
      graphicsDir,
      themeStorePath,
    },
  );

  if (!gatewayServer.listening) {
    await once(gatewayServer, "listening");
  }
  baseUrl = `http://127.0.0.1:${gatewayServer.address().port}`;
});

test.afterAll(async () => {
  await closeServer(gatewayServer);
  await closeServer(targetServer);
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("loads themed assets over HTTP without SSL upgrade failures", async ({ page, request }) => {
  const loginResponse = await request.get(`${baseUrl}/login?next=%2F`, {
    headers: { accept: "text/html" },
  });
  expect(loginResponse.ok()).toBeTruthy();

  const csp = loginResponse.headers()["content-security-policy"] || "";
  expect(csp).not.toContain("upgrade-insecure-requests");

  const html = await loginResponse.text();
  expect(html).toContain('/assets/theme.css');
  expect(html).toContain("/graphics/logo/test-logo.svg");
  expect(html).toContain("/graphics/background/test-closed.svg");
  expect(html).toContain("/graphics/background/test-open.svg");

  const failures = [];
  const statuses = new Map();
  const watchPaths = [
    "/assets/theme.css",
    "/graphics/logo/test-logo.svg",
    "/graphics/background/test-closed.svg",
    "/graphics/background/test-open.svg",
  ];
  const shouldTrack = (url) => watchPaths.some((assetPath) => url.includes(assetPath));

  page.on("requestfailed", (requestEvent) => {
    const url = requestEvent.url();
    if (!shouldTrack(url)) {
      return;
    }
    failures.push({
      url,
      errorText: requestEvent.failure()?.errorText || "unknown-request-failure",
    });
  });
  page.on("response", (response) => {
    const url = response.url();
    if (!shouldTrack(url)) {
      return;
    }
    statuses.set(url, response.status());
  });

  await page.goto(`${baseUrl}/login?next=%2F`, { waitUntil: "networkidle" });
  await expect(page.locator(".brand-logo")).toBeVisible();

  expect(failures).toEqual([]);
  for (const assetPath of watchPaths) {
    const assetUrl = new URL(assetPath, baseUrl).toString();
    expect(statuses.get(assetUrl)).toBe(200);
  }
});
