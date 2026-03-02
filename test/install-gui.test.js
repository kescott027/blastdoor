import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import dotenv from "dotenv";
import { createInstallerApp, startInstallerServer } from "../scripts/install-gui.js";

function request(port, { method = "GET", pathname = "/", body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: body
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let parsed = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = { raw };
            }
          }

          resolve({
            status: res.statusCode,
            body: parsed,
          });
        });
      },
    );

    req.on("error", reject);
    if (body) {
      req.write(payload);
    }
    req.end();
  });
}

async function withTempDir(callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-install-gui-test-"));
  try {
    await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function closeServer(server) {
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

test("installer API returns defaults when no installation profile exists", async () => {
  await withTempDir(async (workspaceDir) => {
    const configPath = path.join(workspaceDir, "data", "installation_config.json");
    const envPath = path.join(workspaceDir, ".env");
    const dockerEnvPath = path.join(workspaceDir, "docker", "blastdoor.env");

    const app = createInstallerApp({ configPath, envPath, dockerEnvPath });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, { pathname: "/api/config" });
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.exists, false);
      assert.equal(response.body.config.installType, "local");
      assert.equal(response.body.config.installGuidance, "standard");
      assert.equal(response.body.config.database, "sqlite");
      assert.equal(response.body.config.objectStorage, "local");
    } finally {
      await closeServer(server);
    }
  });
});

test("installer API saves profile and generates local/docker env files", async () => {
  await withTempDir(async (workspaceDir) => {
    const configPath = path.join(workspaceDir, "data", "installation_config.json");
    const envPath = path.join(workspaceDir, ".env");
    const dockerEnvPath = path.join(workspaceDir, "docker", "blastdoor.env");

    const app = createInstallerApp({ configPath, envPath, dockerEnvPath });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const payload = {
        installType: "container",
        installGuidance: "ai-guided",
        platform: "linux",
        database: "postgres",
        objectStorage: "s3",
        foundryMode: "external",
        foundryExternalIp: "203.0.113.77",
        foundryExternalPort: 30400,
        gatewayHost: "0.0.0.0",
        gatewayPort: 8181,
        managerHost: "127.0.0.1",
        managerPort: 8190,
        apiHost: "127.0.0.1",
        apiPort: 8071,
        useExternalBlastdoorApi: true,
        blastdoorApiUrl: "https://api.example.test",
        blastdoorApiToken: "token-abc",
        publicDomain: "games.example.test",
        letsEncryptEmail: "ops@example.test",
      };

      const saveResponse = await request(port, {
        method: "POST",
        pathname: "/api/config",
        body: payload,
      });

      assert.equal(saveResponse.status, 200);
      assert.equal(saveResponse.body.ok, true);
      assert.equal(saveResponse.body.config.installType, "container");
      assert.equal(saveResponse.body.config.installGuidance, "ai-guided");
      assert.equal(saveResponse.body.config.database, "postgres");
      assert.equal(saveResponse.body.config.objectStorage, "s3");
      assert.equal(saveResponse.body.config.useExternalBlastdoorApi, true);

      const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
      assert.equal(persistedConfig.installType, "container");
      assert.equal(persistedConfig.installGuidance, "ai-guided");
      assert.equal(persistedConfig.gatewayPort, 8181);
      assert.equal(persistedConfig.foundryExternalIp, "203.0.113.77");
      assert.equal(persistedConfig.publicDomain, "games.example.test");
      assert.equal(persistedConfig.letsEncryptEmail, "ops@example.test");

      const localEnv = dotenv.parse(await fs.readFile(envPath, "utf8"));
      assert.equal(localEnv.INSTALL_PROFILE, "container");
      assert.equal(localEnv.OBJECT_STORAGE_MODE, "s3");
      assert.equal(localEnv.FOUNDRY_TARGET, "http://203.0.113.77:30400");
      assert.equal(localEnv.BLASTDOOR_API_URL, "https://api.example.test");
      assert.equal(localEnv.BLASTDOOR_API_TOKEN, "token-abc");

      const dockerEnv = dotenv.parse(await fs.readFile(dockerEnvPath, "utf8"));
      assert.equal(dockerEnv.INSTALL_PROFILE, "container");
      assert.equal(dockerEnv.OBJECT_STORAGE_MODE, "s3");
      assert.equal(dockerEnv.FOUNDRY_TARGET, "http://203.0.113.77:30400");
      assert.equal(dockerEnv.PASSWORD_STORE_MODE, "postgres");
      assert.equal(dockerEnv.CONFIG_STORE_MODE, "postgres");
      assert.equal(dockerEnv.BLASTDOOR_DOMAIN, "games.example.test");
      assert.equal(dockerEnv.LETSENCRYPT_EMAIL, "ops@example.test");
      assert.equal(dockerEnv.PUBLIC_BASE_URL, "https://games.example.test");

      const fetchResponse = await request(port, { pathname: "/api/config" });
      assert.equal(fetchResponse.status, 200);
      assert.equal(fetchResponse.body.exists, true);
      assert.equal(fetchResponse.body.config.installType, "container");
      assert.equal(fetchResponse.body.config.installGuidance, "ai-guided");
    } finally {
      await closeServer(server);
    }
  });
});

test("installer core workflow endpoints provide analysis, step prompts, and validation", async () => {
  await withTempDir(async (workspaceDir) => {
    const configPath = path.join(workspaceDir, "data", "installation_config.json");
    const envPath = path.join(workspaceDir, ".env");
    const dockerEnvPath = path.join(workspaceDir, "docker", "blastdoor.env");

    const app = createInstallerApp({ configPath, envPath, dockerEnvPath });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const baseConfig = {
        installGuidance: "ai-guided",
        installType: "local",
        platform: "linux",
        database: "sqlite",
        objectStorage: "local",
        foundryMode: "local",
        foundryLocalHost: "127.0.0.1",
        foundryLocalPort: 30000,
        gatewayHost: "0.0.0.0",
        gatewayPort: 8080,
        managerHost: "127.0.0.1",
        managerPort: 8090,
        apiHost: "127.0.0.1",
        apiPort: 8070,
        useExternalBlastdoorApi: false,
      };

      const analyze = await request(port, {
        method: "POST",
        pathname: "/api/core-workflow/analyze",
        body: {
          config: baseConfig,
          stepIndex: 0,
        },
      });
      assert.equal(analyze.status, 200);
      assert.equal(analyze.body.ok, true);
      assert.equal(typeof analyze.body.analysis?.environment?.platform, "string");
      assert.equal(Array.isArray(analyze.body.analysis?.checklist), true);

      const step = await request(port, {
        method: "POST",
        pathname: "/api/core-workflow/step",
        body: {
          config: baseConfig,
          stepIndex: 2,
        },
      });
      assert.equal(step.status, 200);
      assert.equal(step.body.ok, true);
      assert.match(String(step.body.prompt || ""), /Step 3\/7/i);

      const chat = await request(port, {
        method: "POST",
        pathname: "/api/core-workflow/chat",
        body: {
          config: baseConfig,
          stepIndex: 2,
          question: "What install mode should I use?",
        },
      });
      assert.equal(chat.status, 200);
      assert.equal(chat.body.ok, true);
      assert.equal(typeof chat.body.reply, "string");
      assert.equal(chat.body.reply.length > 0, true);

      const validate = await request(port, {
        method: "POST",
        pathname: "/api/core-workflow/validate",
        body: {
          config: baseConfig,
        },
      });
      assert.equal(validate.status, 200);
      assert.equal(validate.body.ok, true);
      assert.equal(Array.isArray(validate.body.checks), true);
      assert.equal(typeof validate.body.ready, "boolean");
    } finally {
      await closeServer(server);
    }
  });
});

test("installer API validates external API configuration requirements", async () => {
  await withTempDir(async (workspaceDir) => {
    const app = createInstallerApp({
      configPath: path.join(workspaceDir, "data", "installation_config.json"),
      envPath: path.join(workspaceDir, ".env"),
      dockerEnvPath: path.join(workspaceDir, "docker", "blastdoor.env"),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, {
        method: "POST",
        pathname: "/api/config",
        body: {
          useExternalBlastdoorApi: true,
          blastdoorApiUrl: "",
        },
      });

      assert.equal(response.status, 400);
      assert.match(String(response.body.error || ""), /requires blastdoorApiUrl/i);
    } finally {
      await closeServer(server);
    }
  });
});

test("installer API supports close action and invokes exit callback", async () => {
  await withTempDir(async (workspaceDir) => {
    let exitAction = null;
    const app = createInstallerApp({
      configPath: path.join(workspaceDir, "data", "installation_config.json"),
      envPath: path.join(workspaceDir, ".env"),
      dockerEnvPath: path.join(workspaceDir, "docker", "blastdoor.env"),
      requestExit(action) {
        exitAction = action;
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, {
        method: "POST",
        pathname: "/api/exit",
        body: { action: "close" },
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.action, "close");

      await delay(200);
      assert.equal(exitAction, "close");
    } finally {
      await closeServer(server);
    }
  });
});

test("installer API launch action supports defer mode and validates saved profile", async () => {
  await withTempDir(async (workspaceDir) => {
    const configPath = path.join(workspaceDir, "data", "installation_config.json");
    const envPath = path.join(workspaceDir, ".env");
    const dockerEnvPath = path.join(workspaceDir, "docker", "blastdoor.env");
    let launchCalls = 0;

    const app = createInstallerApp({
      configPath,
      envPath,
      dockerEnvPath,
      deferLaunch: true,
      async launchDispatcher() {
        launchCalls += 1;
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const missingProfileResponse = await request(port, {
        method: "POST",
        pathname: "/api/exit",
        body: { action: "launch" },
      });
      assert.equal(missingProfileResponse.status, 400);
      assert.match(String(missingProfileResponse.body.error || ""), /save configuration before launching/i);

      const saveResponse = await request(port, {
        method: "POST",
        pathname: "/api/config",
        body: {
          installType: "local",
          foundryMode: "local",
        },
      });
      assert.equal(saveResponse.status, 200);

      const launchResponse = await request(port, {
        method: "POST",
        pathname: "/api/exit",
        body: { action: "launch" },
      });
      assert.equal(launchResponse.status, 200);
      assert.equal(launchResponse.body.ok, true);
      assert.equal(launchResponse.body.action, "launch");
      assert.equal(launchResponse.body.deferred, true);
      assert.equal(launchCalls, 0);
    } finally {
      await closeServer(server);
    }
  });
});

test("startInstallerServer auto-open uses browser launcher callback", async () => {
  let openedUrl = "";
  const server = startInstallerServer({
    installerHost: "127.0.0.1",
    installerPort: 0,
    autoOpen: true,
    openBrowserFn(url) {
      openedUrl = String(url || "");
      return true;
    },
  });

  try {
    await once(server, "listening");
    await delay(50);
    assert.match(openedUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await closeServer(server);
  }
});
