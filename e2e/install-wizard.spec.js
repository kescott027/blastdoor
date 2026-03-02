import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import dotenv from "dotenv";
import { createInstallerApp } from "../scripts/install-gui.js";

let tempDir;
let server;
let baseUrl;
let configPath;
let envPath;
let dockerEnvPath;

test.beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-playwright-install-"));
  configPath = path.join(tempDir, "data", "installation_config.json");
  envPath = path.join(tempDir, ".env");
  dockerEnvPath = path.join(tempDir, "docker", "blastdoor.env");

  const app = createInstallerApp({
    configPath,
    envPath,
    dockerEnvPath,
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

test("walks through installer wizard and persists expected outputs", async ({ page, request: apiRequest }) => {
  await page.goto(baseUrl);

  await expect(page.getByRole("heading", { name: "Blastdoor First-Time Installer" })).toBeVisible();

  await page.locator("#installType").selectOption("container");
  await page.locator("#nextBtn").click();

  await page.locator("#platform").selectOption("linux");
  await page.locator("#nextBtn").click();

  await page.locator("#database").selectOption("postgres");
  await page.locator("#nextBtn").click();

  await page.locator("#objectStorage").selectOption("s3");
  await page.locator("#nextBtn").click();

  await page.locator("#foundryMode").selectOption("external");
  await page.locator("#foundryExternalIp").fill("203.0.113.99");
  await page.locator("#foundryExternalPort").fill("30400");
  await page.locator("#nextBtn").click();

  await page.locator("#gatewayHost").fill("0.0.0.0");
  await page.locator("#gatewayPort").fill("8181");
  await page.locator("#managerHost").fill("127.0.0.1");
  await page.locator("#managerPort").fill("8190");
  await page.locator("#apiHost").fill("127.0.0.1");
  await page.locator("#apiPort").fill("8071");
  await page.locator("#useExternalBlastdoorApi").check();
  await page.locator("#blastdoorApiUrl").fill("https://api.example.test");
  await page.locator("#blastdoorApiToken").fill("token-123");
  await page.locator("#publicDomain").fill("blastdoor.example.test");
  await page.locator("#letsEncryptEmail").fill("ops@example.test");
  await page.locator("#nextBtn").click();

  await expect(page.locator("#review")).toContainText("\"installType\": \"container\"");

  const saveResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/config") && response.request().method() === "POST",
  );
  await page.locator("#saveBtn").click();
  const saveResponse = await saveResponsePromise;
  expect(saveResponse.ok()).toBeTruthy();

  await expect(page.locator("#status")).toContainText("Configuration saved");

  const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  expect(persistedConfig.installType).toBe("container");
  expect(persistedConfig.database).toBe("postgres");
  expect(persistedConfig.objectStorage).toBe("s3");
  expect(persistedConfig.foundryExternalIp).toBe("203.0.113.99");
  expect(persistedConfig.gatewayPort).toBe(8181);

  const localEnv = dotenv.parse(await fs.readFile(envPath, "utf8"));
  expect(localEnv.INSTALL_PROFILE).toBe("container");
  expect(localEnv.OBJECT_STORAGE_MODE).toBe("s3");
  expect(localEnv.FOUNDRY_TARGET).toBe("http://203.0.113.99:30400");
  expect(localEnv.BLASTDOOR_API_URL).toBe("https://api.example.test");
  expect(localEnv.BLASTDOOR_API_TOKEN).toBe("token-123");

  const dockerEnv = dotenv.parse(await fs.readFile(dockerEnvPath, "utf8"));
  expect(dockerEnv.INSTALL_PROFILE).toBe("container");
  expect(dockerEnv.PASSWORD_STORE_MODE).toBe("postgres");
  expect(dockerEnv.CONFIG_STORE_MODE).toBe("postgres");
  expect(dockerEnv.BLASTDOOR_DOMAIN).toBe("blastdoor.example.test");
  expect(dockerEnv.LETSENCRYPT_EMAIL).toBe("ops@example.test");

  const configResponse = await apiRequest.get(`${baseUrl}/api/config`);
  expect(configResponse.ok()).toBeTruthy();
  const configPayload = await configResponse.json();
  expect(configPayload.exists).toBeTruthy();
  expect(configPayload.config.installType).toBe("container");
});
