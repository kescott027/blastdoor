import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createManagerApp } from "../src/manager.js";

let tempDir;
let envPath;
let server;
let baseUrl;

test.beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-playwright-manager-call-home-"));
  envPath = path.join(tempDir, ".env");
  await fs.writeFile(
    envPath,
    [
      "HOST=127.0.0.1",
      "PORT=8080",
      "FOUNDRY_TARGET=http://127.0.0.1:30000",
      "PASSWORD_STORE_MODE=env",
      "AUTH_USERNAME=gm",
      "AUTH_PASSWORD_HASH=scrypt$a$b",
      "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "REQUIRE_TOTP=false",
      "ASSISTANT_ENABLED=true",
      "",
    ].join("\n"),
    "utf8",
  );

  const { app } = createManagerApp({
    workspaceDir: tempDir,
    envPath,
    managerDir: path.join(process.cwd(), "public", "manager"),
  });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) {
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
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("admin call-home controls can generate pod bundle and ingest remote events", async ({ page, request }) => {
  await page.goto(`${baseUrl}/manager/`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Blastdoor Control Console" })).toBeVisible();

  await page.locator("#navDiagBtn").click();
  await expect(page.locator("#diagnosticsSection")).toBeVisible();

  await page.locator("#remoteSupportEnabled").selectOption("true");
  await page.locator("#remoteSupportDefaultTtlMinutes").fill("30");
  await page.locator("#remoteSupportSaveConfigBtn").click();
  await expect(page.locator("#remoteSupportStatusMessage")).toContainText(/enabled/i);
  await expect(page.locator("#callHomeEnabled")).toBeEnabled();

  await page.locator("#callHomeEnabled").selectOption("true");
  await page.locator("#remoteSupportSaveConfigBtn").click();
  await expect(page.locator("#remoteSupportStatusMessage")).toContainText(/enabled/i);

  await page.locator("#remoteSupportTokenLabel").fill("playwright token");
  await page.locator("#remoteSupportTokenTtlMinutes").fill("60");
  await page.locator("#remoteSupportGenerateTokenBtn").click();
  await expect(page.locator("#remoteSupportOutput")).toContainText("Token (displayed once):");

  const tokenOutput = (await page.locator("#remoteSupportOutput").textContent()) || "";
  const tokenMatch = tokenOutput.match(/Token \(displayed once\):\s*([A-Za-z0-9_-]+)/);
  expect(tokenMatch).toBeTruthy();
  const token = tokenMatch[1];

  await page.locator("#callHomePodTtlMinutes").fill("45");
  await page.locator("#callHomeGeneratePodBtn").click();
  await expect(page.locator("#callHomePodOutput")).toContainText("docker-compose.yml:");
  await expect(page.locator("#callHomePodOutput")).toContainText("Entrypoint script:");

  const registerResponse = await request.post(`${baseUrl}/api/remote-support/v1/call-home/register`, {
    headers: {
      "x-blastdoor-support-token": token,
      "content-type": "application/json",
    },
    data: {
      satelliteId: "pw-sat-01",
      status: "starting",
      message: "playwright register",
      payload: {
        source: "playwright",
      },
    },
  });
  expect(registerResponse.ok()).toBeTruthy();

  const reportResponse = await request.post(`${baseUrl}/api/remote-support/v1/call-home/report`, {
    headers: {
      "x-blastdoor-support-token": token,
      "content-type": "application/json",
    },
    data: {
      satelliteId: "pw-sat-01",
      status: "ok",
      message: "playwright report",
      payload: {
        probe: "ok",
      },
    },
  });
  expect(reportResponse.ok()).toBeTruthy();

  await page.locator("#callHomeRefreshEventsBtn").click();
  await expect(page.locator("#callHomeEventsOutput")).toContainText("pw-sat-01");
  await expect(page.locator("#callHomeEventsOutput")).toContainText("playwright report");
});
