import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import dotenv from "dotenv";
import { createManagerApp, createManagerServer, formatManagerListenError } from "../src/manager.js";

function request(port, { method = "GET", pathname = "/", body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const isObjectBody = body && typeof body === "object" && !Buffer.isBuffer(body);
    const payload =
      body === null || body === undefined
        ? ""
        : isObjectBody
          ? JSON.stringify(body)
          : String(body);
    const requestHeaders = {
      ...headers,
    };
    if (payload.length > 0 && !requestHeaders["content-type"]) {
      requestHeaders["content-type"] = isObjectBody ? "application/json" : "text/plain; charset=utf-8";
    }
    if (payload.length > 0 && !requestHeaders["content-length"]) {
      requestHeaders["content-length"] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: requestHeaders,
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
            headers: res.headers,
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-manager-test-"));
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

function createFakeProcessFactory() {
  const created = [];

  function factory() {
    const child = new EventEmitter();
    child.pid = 4242;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("exit", 0, null));
      return true;
    };
    created.push(child);
    return child;
  }

  return { factory, created };
}

test("manager saves config and hashes password", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const { app } = createManagerApp({
      workspaceDir,
      envPath,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const initial = await request(port, { pathname: "/api/config" });
      assert.equal(initial.status, 200);

      const payload = {
        HOST: "127.0.0.1",
        PORT: "8080",
        FOUNDRY_TARGET: "http://127.0.0.1:30000",
        PASSWORD_STORE_MODE: "env",
        PASSWORD_STORE_FILE: "mock/password-store.json",
        CONFIG_STORE_MODE: "env",
        DATABASE_FILE: "data/blastdoor.sqlite",
        POSTGRES_URL: "",
        POSTGRES_SSL: "false",
        AUTH_USERNAME: "gm",
        AUTH_PASSWORD: "Correct-Horse-Battery-123",
        SESSION_SECRET: "x".repeat(48),
        COOKIE_SECURE: "false",
        TRUST_PROXY: "false",
        SESSION_MAX_AGE_HOURS: "12",
        LOGIN_RATE_LIMIT_WINDOW_MS: "900000",
        LOGIN_RATE_LIMIT_MAX: "8",
        REQUIRE_TOTP: "false",
        TOTP_SECRET: "",
        PROXY_TLS_VERIFY: "true",
        ALLOWED_ORIGINS: "",
        ALLOW_NULL_ORIGIN: "true",
        DEBUG_MODE: "true",
        DEBUG_LOG_FILE: "logs/blastdoor-debug.log",
      };

      const saved = await request(port, {
        method: "POST",
        pathname: "/api/config",
        body: payload,
      });

      assert.equal(saved.status, 200);
      assert.equal(saved.body.ok, true);

      const envContent = await fs.readFile(envPath, "utf8");
      assert.match(envContent, /AUTH_PASSWORD_HASH="?scrypt\$/);
      assert.doesNotMatch(envContent, /Correct-Horse-Battery-123/);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager config backup endpoints create/view/restore/delete backups", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const dockerEnvPath = path.join(workspaceDir, "docker", "blastdoor.env");
    const installationConfigPath = path.join(workspaceDir, "data", "installation_config.json");

    await fs.mkdir(path.dirname(dockerEnvPath), { recursive: true });
    await fs.mkdir(path.dirname(installationConfigPath), { recursive: true });
    await fs.writeFile(
      envPath,
      ["HOST=127.0.0.1", "PORT=8080", "FOUNDRY_TARGET=http://127.0.0.1:30000", "SESSION_SECRET=test-secret", ""].join("\n"),
      "utf8",
    );
    await fs.writeFile(dockerEnvPath, ["HOST=0.0.0.0", "PORT=8080", ""].join("\n"), "utf8");
    await fs.writeFile(
      installationConfigPath,
      `${JSON.stringify({ installType: "local", gatewayPort: 8080, managerPort: 8090 }, null, 2)}\n`,
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      dockerEnvPath,
      installationConfigPath,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const created = await request(port, {
        method: "POST",
        pathname: "/api/config-backups/create",
        body: { name: "before-change" },
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.ok, true);
      assert.ok(created.body.backup.backupId);

      const backupId = String(created.body.backup.backupId || "");
      const listed = await request(port, { pathname: "/api/config-backups" });
      assert.equal(listed.status, 200);
      assert.equal(listed.body.ok, true);
      assert.equal(Array.isArray(listed.body.backups), true);
      assert.equal(listed.body.backups.length >= 1, true);

      await request(port, {
        method: "POST",
        pathname: "/api/config",
        body: {
          HOST: "0.0.0.0",
        },
      });

      const restored = await request(port, {
        method: "POST",
        pathname: "/api/config-backups/restore",
        body: { backupId },
      });
      assert.equal(restored.status, 200);
      assert.equal(restored.body.ok, true);
      assert.equal(Array.isArray(restored.body.result.restored), true);
      assert.equal(restored.body.result.restored.includes(".env"), true);

      const config = await request(port, { pathname: "/api/config" });
      assert.equal(config.status, 200);
      assert.equal(config.body.config.HOST, "127.0.0.1");

      const viewed = await request(port, {
        pathname: `/api/config-backups/view?backupId=${encodeURIComponent(backupId)}`,
      });
      assert.equal(viewed.status, 200);
      assert.equal(viewed.body.ok, true);
      assert.equal(Array.isArray(viewed.body.files), true);
      assert.equal(viewed.body.files.some((entry) => entry.relativePath === ".env"), true);

      const deleted = await request(port, {
        method: "POST",
        pathname: "/api/config-backups/delete",
        body: { backupId },
      });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.ok, true);
      assert.equal(deleted.body.result.backupId, backupId);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager clean install config resets installation/env files to defaults", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const dockerEnvPath = path.join(workspaceDir, "docker", "blastdoor.env");
    const installationConfigPath = path.join(workspaceDir, "data", "installation_config.json");
    await fs.mkdir(path.dirname(dockerEnvPath), { recursive: true });
    await fs.mkdir(path.dirname(installationConfigPath), { recursive: true });

    await fs.writeFile(
      envPath,
      [
        "HOST=10.10.10.10",
        "PORT=9999",
        "FOUNDRY_TARGET=http://10.1.1.1:3333",
        "BLAST_DOORS_CLOSED=true",
        "EXTRA_CUSTOM_VALUE=keep-me-if-bugged",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(dockerEnvPath, ["HOST=10.10.10.10", "PORT=9999", "EXTRA_DOCKER_KEY=bug", ""].join("\n"), "utf8");
    await fs.writeFile(
      installationConfigPath,
      `${JSON.stringify({ installType: "container", gatewayPort: 9999 }, null, 2)}\n`,
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      dockerEnvPath,
      installationConfigPath,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const cleaned = await request(port, {
        method: "POST",
        pathname: "/api/config-backups/clean-install",
        body: {},
      });
      assert.equal(cleaned.status, 200);
      assert.equal(cleaned.body.ok, true);

      const nextEnv = dotenv.parse(await fs.readFile(envPath, "utf8"));
      assert.equal(nextEnv.HOST, "0.0.0.0");
      assert.equal(nextEnv.PORT, "8080");
      assert.equal(nextEnv.INSTALL_PROFILE, "local");
      assert.equal(Object.prototype.hasOwnProperty.call(nextEnv, "EXTRA_CUSTOM_VALUE"), false);

      const nextDockerEnv = dotenv.parse(await fs.readFile(dockerEnvPath, "utf8"));
      assert.equal(nextDockerEnv.PORT, "8080");
      assert.equal(Object.prototype.hasOwnProperty.call(nextDockerEnv, "EXTRA_DOCKER_KEY"), false);

      const installationRaw = JSON.parse(await fs.readFile(installationConfigPath, "utf8"));
      assert.equal(installationRaw.installType, "local");
      assert.equal(installationRaw.gatewayPort, 8080);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager control-plane endpoint returns local status summary", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const graphicsDir = path.join(workspaceDir, "graphics");
    const foundryServer = http.createServer((req, res) => {
      if (req.url === "/api/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", mode: "mock" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not-found" }));
    });
    foundryServer.listen(0, "127.0.0.1");
    await once(foundryServer, "listening");
    const foundryPort = foundryServer.address().port;

    await fs.mkdir(graphicsDir, { recursive: true });
    await fs.writeFile(
      envPath,
      [
        "HOST=127.0.0.1",
        "PORT=8080",
        `FOUNDRY_TARGET=http://127.0.0.1:${foundryPort}`,
        "PASSWORD_STORE_MODE=env",
        "CONFIG_STORE_MODE=env",
        "OBJECT_STORAGE_MODE=local",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      graphicsDir,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const result = await request(port, { pathname: "/api/control-plane-status" });
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      assert.equal(typeof result.body.environment, "object");
      assert.equal(typeof result.body.environment.isWsl, "boolean");
      assert.equal(result.body.admin.running, true);
      assert.equal(typeof result.body.admin.pid, "number");
      assert.equal(typeof result.body.portal.running, "boolean");
      assert.equal(typeof result.body.foundry, "object");
      assert.equal(result.body.foundry.reachable, true);
      assert.equal(result.body.foundry.apiStatus.statusCode, 200);
      assert.match(String(result.body.foundry.apiStatus.url || ""), /\/api\/status$/);
      assert.equal(typeof result.body.api.running, "boolean");
      assert.equal(typeof result.body.postgres.running, "boolean");
      assert.equal(result.body.objectStore.type, "local");
      assert.equal(result.body.objectStore.reachable, true);
      assert.equal(Array.isArray(result.body.plugins), true);
    } finally {
      await closeServer(server);
      await closeServer(foundryServer);
    }
  });
});

test("manager config foundry target autodetect suggests WSL gateway target", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const foundryServer = http.createServer((req, res) => {
      if (req.url === "/api/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
    });
    foundryServer.listen(0, "127.0.0.1");
    await once(foundryServer, "listening");
    const foundryPort = foundryServer.address().port;

    await fs.writeFile(
      envPath,
      [
        "HOST=0.0.0.0",
        "PORT=8080",
        `FOUNDRY_TARGET=http://127.0.0.1:${foundryPort}`,
        "PASSWORD_STORE_MODE=env",
        "CONFIG_STORE_MODE=env",
        "",
      ].join("\n"),
      "utf8",
    );

    const commandRunner = async ({ command, args }) => {
      if (command === "ip" && Array.isArray(args) && args.join(" ") === "route show default") {
        return {
          ok: true,
          command,
          args,
          exitCode: 0,
          stdout: "default via 127.0.0.1 dev eth0 proto kernel\n",
          stderr: "",
        };
      }
      return {
        ok: false,
        command,
        args,
        exitCode: 1,
        stdout: "",
        stderr: "unexpected command",
        error: "unexpected command",
      };
    };

    const previousDistro = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = "Ubuntu-24.04";

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      commandRunner,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const result = await request(port, {
        method: "POST",
        pathname: "/api/config/foundry-target-autodetect",
        body: {},
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      assert.equal(result.body.gatewayIp, "127.0.0.1");
      assert.equal(result.body.foundryTarget, `http://127.0.0.1:${foundryPort}`);
      assert.equal(typeof result.body.health, "object");
      assert.equal(typeof result.body.apiStatus, "object");
      assert.equal(result.body.apiStatus.statusCode, 200);
    } finally {
      if (previousDistro === undefined) {
        delete process.env.WSL_DISTRO_NAME;
      } else {
        process.env.WSL_DISTRO_NAME = previousDistro;
      }
      await closeServer(server);
      await closeServer(foundryServer);
    }
  });
});

test("manager config foundry target autodetect rejects non-WSL runtime", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    await fs.writeFile(
      envPath,
      ["HOST=0.0.0.0", "PORT=8080", "FOUNDRY_TARGET=http://127.0.0.1:30000", "PASSWORD_STORE_MODE=env", ""].join("\n"),
      "utf8",
    );

    const previousDistro = process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_DISTRO_NAME;

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const result = await request(port, {
        method: "POST",
        pathname: "/api/config/foundry-target-autodetect",
        body: {},
      });
      assert.equal(result.status, 400);
      assert.match(String(result.body.error || ""), /only in WSL/i);
    } finally {
      if (previousDistro !== undefined) {
        process.env.WSL_DISTRO_NAME = previousDistro;
      }
      await closeServer(server);
    }
  });
});

test("manager config assistant ollama autodetect suggests WSL gateway URL", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const ollamaServer = http.createServer((req, res) => {
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    });
    ollamaServer.listen(0, "127.0.0.1");
    await once(ollamaServer, "listening");
    const ollamaPort = ollamaServer.address().port;

    await fs.writeFile(
      envPath,
      [
        "HOST=0.0.0.0",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "CONFIG_STORE_MODE=env",
        `ASSISTANT_OLLAMA_URL=http://127.0.0.1:${ollamaPort}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const commandRunner = async ({ command, args }) => {
      if (command === "ip" && Array.isArray(args) && args.join(" ") === "route show default") {
        return {
          ok: true,
          command,
          args,
          exitCode: 0,
          stdout: "default via 127.0.0.1 dev eth0 proto kernel\n",
          stderr: "",
        };
      }
      return {
        ok: false,
        command,
        args,
        exitCode: 1,
        stdout: "",
        stderr: "unexpected command",
        error: "unexpected command",
      };
    };

    const previousDistro = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = "Ubuntu-24.04";

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      commandRunner,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const result = await request(port, {
        method: "POST",
        pathname: "/api/config/assistant-ollama-url-autodetect",
        body: {},
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      assert.equal(result.body.gatewayIp, "127.0.0.1");
      assert.equal(result.body.assistantOllamaUrl, `http://127.0.0.1:${ollamaPort}`);
      assert.equal(result.body.health?.statusCode, 200);
    } finally {
      if (previousDistro === undefined) {
        delete process.env.WSL_DISTRO_NAME;
      } else {
        process.env.WSL_DISTRO_NAME = previousDistro;
      }
      await closeServer(server);
      await closeServer(ollamaServer);
    }
  });
});

test("manager config assistant ollama autodetect rejects non-WSL runtime", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    await fs.writeFile(
      envPath,
      [
        "HOST=0.0.0.0",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "ASSISTANT_OLLAMA_URL=http://127.0.0.1:11434",
        "",
      ].join("\n"),
      "utf8",
    );

    const previousDistro = process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_DISTRO_NAME;

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const result = await request(port, {
        method: "POST",
        pathname: "/api/config/assistant-ollama-url-autodetect",
        body: {},
      });
      assert.equal(result.status, 400);
      assert.match(String(result.body.error || ""), /only in WSL/i);
    } finally {
      if (previousDistro !== undefined) {
        process.env.WSL_DISTRO_NAME = previousDistro;
      }
      await closeServer(server);
    }
  });
});

test("manager control-plane endpoint maps container service states", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const installationConfigPath = path.join(workspaceDir, "data", "installation_config.json");
    await fs.mkdir(path.dirname(installationConfigPath), { recursive: true });
    await fs.writeFile(
      envPath,
      [
        "HOST=0.0.0.0",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=postgres",
        "CONFIG_STORE_MODE=postgres",
        "POSTGRES_URL=postgres://blastdoor:blastdoor@127.0.0.1:5432/blastdoor",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      installationConfigPath,
      `${JSON.stringify({ installType: "container", gatewayPort: 8080, managerPort: 8090 }, null, 2)}\n`,
      "utf8",
    );

    const startedAt = new Date(Date.now() - 120_000).toISOString();
    const dockerStates = new Map([
      ["portal-id", { Running: true, Pid: 1111, StartedAt: startedAt, Health: { Status: "healthy" } }],
      ["api-id", { Running: true, Pid: 2222, StartedAt: startedAt, Health: { Status: "healthy" } }],
      ["pg-id", { Running: true, Pid: 3333, StartedAt: startedAt, Health: { Status: "healthy" } }],
      ["assistant-id", { Running: true, Pid: 4444, StartedAt: startedAt, Health: { Status: "unhealthy" } }],
    ]);

    const commandRunner = async ({ command, args = [] }) => {
      if (command !== "docker") {
        return { ok: false, error: "unexpected command", stdout: "", stderr: "", exitCode: 1 };
      }

      if (args.includes("compose") && args.includes("ps")) {
        return {
          ok: true,
          stdout: JSON.stringify([
            { Service: "blastdoor", ID: "portal-id" },
            { Service: "blastdoor-api", ID: "api-id" },
            { Service: "postgres", ID: "pg-id" },
            { Service: "blastdoor-assistant", ID: "assistant-id" },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }

      if (args[0] === "inspect") {
        const containerId = String(args[args.length - 1] || "");
        const state = dockerStates.get(containerId);
        if (!state) {
          return { ok: false, error: "missing container", stdout: "", stderr: "", exitCode: 1 };
        }
        return {
          ok: true,
          stdout: JSON.stringify(state),
          stderr: "",
          exitCode: 0,
        };
      }

      return { ok: false, error: "unsupported args", stdout: "", stderr: "", exitCode: 1 };
    };

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      installationConfigPath,
      commandRunner,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const result = await request(port, { pathname: "/api/control-plane-status" });
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      assert.equal(result.body.installation.profile, "container");
      assert.equal(result.body.portal.running, true);
      assert.equal(result.body.portal.pid, 1111);
      assert.equal(typeof result.body.foundry, "object");
      assert.equal(typeof result.body.foundry.reachable, "boolean");
      assert.equal(result.body.api.running, true);
      assert.equal(result.body.api.pid, 2222);
      assert.equal(result.body.postgres.running, true);
      assert.equal(result.body.postgres.pid, 3333);
      const intelligence = (result.body.plugins || []).find((entry) => entry.id === "intelligence");
      assert.ok(intelligence);
      assert.equal(intelligence.pid, 4444);
      assert.equal(intelligence.health.ok, false);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager failures endpoints list and clear recorded failures", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const failureStorePath = path.join(workspaceDir, "data", "launch-failures.json");
    await fs.mkdir(path.dirname(failureStorePath), { recursive: true });
    await fs.writeFile(
      envPath,
      [
        "HOST=127.0.0.1",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "AUTH_USERNAME=gamemaster",
        "AUTH_PASSWORD_HASH=scrypt$demo$demo",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "REQUIRE_TOTP=false",
        "",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      failureStorePath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          entries: [
            {
              id: "failure-1",
              createdAt: new Date().toISOString(),
              source: "launch-console",
              action: "startup",
              nature: "bind-address-unavailable",
              severity: "error",
              message: "Configured HOST=192.168.1.2 is not available on this runtime host.",
              fixes: ["Set HOST=0.0.0.0."],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      failureStorePath,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const listed = await request(port, { pathname: "/api/failures" });
      assert.equal(listed.status, 200);
      assert.equal(listed.body.ok, true);
      assert.equal(listed.body.summary.count, 1);
      assert.equal(Array.isArray(listed.body.entries), true);
      assert.equal(listed.body.entries.length, 1);

      const controlPlane = await request(port, { pathname: "/api/control-plane-status" });
      assert.equal(controlPlane.status, 200);
      assert.equal(controlPlane.body.ok, true);
      assert.equal(controlPlane.body.failures.count, 1);

      const cleared = await request(port, { method: "POST", pathname: "/api/failures/clear", body: {} });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.ok, true);
      assert.equal(cleared.body.summary.count, 0);

      const listedAfterClear = await request(port, { pathname: "/api/failures" });
      assert.equal(listedAfterClear.status, 200);
      assert.equal(listedAfterClear.body.summary.count, 0);
      assert.equal(listedAfterClear.body.entries.length, 0);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager session endpoints list active sessions and invalidate selected user", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const profileStorePath = path.join(workspaceDir, "data", "user-profiles.json");
    await fs.mkdir(path.dirname(profileStorePath), { recursive: true });
    await fs.writeFile(
      envPath,
      [
        "HOST=127.0.0.1",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "AUTH_USERNAME=gamemaster",
        "AUTH_PASSWORD_HASH=scrypt$demo$demo",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "REQUIRE_TOTP=false",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      profileStorePath,
      `${JSON.stringify(
        {
          users: {
            gamemaster: {
              username: "gamemaster",
              status: "active",
              friendlyName: "Game Master",
              email: "gm@example.test",
              lastKnownIp: "192.168.1.40",
              lastLoginAt: new Date().toISOString(),
              sessionVersion: 1,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      userProfileStorePath: profileStorePath,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const listed = await request(port, { pathname: "/api/sessions" });
      assert.equal(listed.status, 200);
      assert.equal(listed.body.ok, true);
      assert.equal(listed.body.summary.activeCount, 1);
      assert.equal(Array.isArray(listed.body.sessions), true);
      assert.equal(listed.body.sessions[0].username, "gamemaster");
      assert.match(String(listed.body.sessions[0].sessionKey || ""), /^[a-f0-9]{24}$/);

      const targetUsername = String(listed.body.sessions[0].username || "");
      assert.equal(targetUsername, "gamemaster");

      const invalidated = await request(port, {
        method: "POST",
        pathname: "/api/sessions/revoke",
        body: {
          username: targetUsername,
          sessionKey: listed.body.sessions[0].sessionKey,
        },
      });
      assert.equal(invalidated.status, 200, JSON.stringify(invalidated.body));
      assert.equal(invalidated.body.ok, true);
      assert.equal(invalidated.body.username, targetUsername);
      assert.equal(invalidated.body.revokedSessionKey, listed.body.sessions[0].sessionKey);
      assert.equal(invalidated.body.sessionVersion, 2);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager optional password protection gates manager APIs when enabled", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const managerConsoleSettingsPath = path.join(workspaceDir, "data", "manager-console-settings.json");
    await fs.writeFile(
      envPath,
      [
        "HOST=127.0.0.1",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=scrypt$demo$demo",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "REQUIRE_TOTP=false",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      managerConsoleSettingsPath,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const enabled = await request(port, {
        method: "POST",
        pathname: "/api/manager-settings/access",
        body: {
          requirePassword: "true",
          password: "Manager-Password-123",
          sessionTtlHours: "12",
        },
      });
      assert.equal(enabled.status, 200);
      assert.equal(enabled.body.ok, true);
      assert.equal(enabled.body.settings.access.requirePassword, true);
      assert.equal(enabled.body.settings.access.passwordConfigured, true);

      const blocked = await request(port, { pathname: "/api/config" });
      assert.equal(blocked.status, 401);
      assert.equal(blocked.body.managerAuthRequired, true);

      const badLogin = await request(port, {
        method: "POST",
        pathname: "/api/manager-auth/login",
        body: {
          password: "incorrect-password",
        },
      });
      assert.equal(badLogin.status, 401);
      assert.equal(badLogin.body.managerAuthRequired, true);

      const goodLogin = await request(port, {
        method: "POST",
        pathname: "/api/manager-auth/login",
        body: {
          password: "Manager-Password-123",
        },
      });
      assert.equal(goodLogin.status, 200);
      assert.equal(goodLogin.body.ok, true);
      const setCookie = Array.isArray(goodLogin.headers["set-cookie"])
        ? goodLogin.headers["set-cookie"][0]
        : goodLogin.headers["set-cookie"];
      assert.match(String(setCookie || ""), /blastdoor\.manager\.sid=/);
      const cookieHeader = String(setCookie || "").split(";")[0];

      const allowed = await request(port, {
        pathname: "/api/config",
        headers: {
          cookie: cookieHeader,
        },
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.body.config.HOST, "127.0.0.1");
    } finally {
      await closeServer(server);
    }
  });
});

test("manager auth login page and settings routes behave across enable/disable flow", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const managerConsoleSettingsPath = path.join(workspaceDir, "data", "manager-console-settings.json");
    await fs.writeFile(
      envPath,
      [
        "HOST=127.0.0.1",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=scrypt$demo$demo",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "REQUIRE_TOTP=false",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      managerConsoleSettingsPath,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const settingsDefault = await request(port, { pathname: "/api/manager-settings" });
      assert.equal(settingsDefault.status, 200);
      assert.equal(settingsDefault.body.ok, true);
      assert.equal(settingsDefault.body.settings.access.requirePassword, false);
      assert.equal(settingsDefault.body.settings.access.passwordConfigured, false);

      const layoutSaved = await request(port, {
        method: "POST",
        pathname: "/api/manager-settings/layout",
        body: {
          darkModePercent: 72,
          lightModePercent: 28,
        },
      });
      assert.equal(layoutSaved.status, 200);
      assert.equal(layoutSaved.body.ok, true);
      assert.equal(layoutSaved.body.settings.layout.darkModePercent, 72);
      assert.equal(layoutSaved.body.settings.layout.lightModePercent, 28);

      const enabled = await request(port, {
        method: "POST",
        pathname: "/api/manager-settings/access",
        body: {
          requirePassword: "true",
          password: "Manager-Password-123",
          sessionTtlHours: "12",
        },
      });
      assert.equal(enabled.status, 200);
      assert.equal(enabled.body.ok, true);
      assert.equal(enabled.body.settings.access.requirePassword, true);
      assert.equal(enabled.body.settings.access.passwordConfigured, true);

      const managerBlockedRedirect = await request(port, { pathname: "/manager/" });
      assert.equal(managerBlockedRedirect.status, 302);
      assert.match(String(managerBlockedRedirect.headers.location || ""), /^\/manager\/login\?next=/);

      const loginPage = await request(port, { pathname: "/manager/login?next=%2Fmanager%2F" });
      assert.equal(loginPage.status, 200);
      assert.match(String(loginPage.body.raw || ""), /Blastdoor Manager Login/);

      const badLoginForm = await request(port, {
        method: "POST",
        pathname: "/api/manager-auth/login-form",
        body: "password=bad-pass&next=%2Fmanager%2F",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
      });
      assert.equal(badLoginForm.status, 401);
      assert.match(String(badLoginForm.body.raw || ""), /Invalid password/);

      const goodLoginForm = await request(port, {
        method: "POST",
        pathname: "/api/manager-auth/login-form",
        body: "password=Manager-Password-123&next=%2Fmanager%2Fapi%2Fconfig",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
      });
      assert.equal(goodLoginForm.status, 302);
      assert.equal(goodLoginForm.headers.location, "/manager/api/config");
      const setCookie = Array.isArray(goodLoginForm.headers["set-cookie"])
        ? goodLoginForm.headers["set-cookie"][0]
        : goodLoginForm.headers["set-cookie"];
      assert.match(String(setCookie || ""), /blastdoor\.manager\.sid=/);
      const cookieHeader = String(setCookie || "").split(";")[0];

      const authState = await request(port, {
        pathname: "/api/manager-auth/state",
        headers: {
          cookie: cookieHeader,
        },
      });
      assert.equal(authState.status, 200);
      assert.equal(authState.body.ok, true);
      assert.equal(authState.body.authenticated, true);

      const disabled = await request(port, {
        method: "POST",
        pathname: "/api/manager-settings/access",
        headers: {
          cookie: cookieHeader,
        },
        body: {
          requirePassword: "false",
          clearPassword: "true",
          sessionTtlHours: "12",
        },
      });
      assert.equal(disabled.status, 200);
      assert.equal(disabled.body.ok, true);
      assert.equal(disabled.body.settings.access.requirePassword, false);
      assert.equal(disabled.body.settings.access.passwordConfigured, false);

      const logout = await request(port, {
        method: "POST",
        pathname: "/api/manager-auth/logout",
        headers: {
          cookie: cookieHeader,
        },
        body: {},
      });
      assert.equal(logout.status, 200);
      assert.equal(logout.body.ok, true);
      assert.match(String(logout.headers["set-cookie"] || ""), /Max-Age=0/);

      const configWithoutCookie = await request(port, { pathname: "/api/config" });
      assert.equal(configWithoutCookie.status, 200);
      assert.equal(configWithoutCookie.body.config.HOST, "127.0.0.1");
    } finally {
      await closeServer(server);
    }
  });
});

test("manager start rejects bind host that is not available on runtime host", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    await fs.writeFile(
      envPath,
      [
        "HOST=203.0.113.10",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=scrypt$demo$demo",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "REQUIRE_TOTP=false",
        "",
      ].join("\n"),
      "utf8",
    );

    let processFactoryCalls = 0;
    const processFactory = () => {
      processFactoryCalls += 1;
      throw new Error("processFactory should not be called when HOST preflight fails.");
    };

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      processFactory,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const result = await request(port, { method: "POST", pathname: "/api/start" });
      assert.equal(result.status, 400);
      assert.match(
        String(result.body.error || ""),
        /EADDRNOTAVAIL|not available on this runtime host/i,
      );
      assert.equal(processFactoryCalls, 0);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager can start stop and monitor gateway process", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
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
        "",
      ].join("\n"),
      "utf8",
    );

    const { factory, created } = createFakeProcessFactory();
    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      processFactory: factory,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const started = await request(port, { method: "POST", pathname: "/api/start" });
      assert.equal(started.status, 200);
      assert.equal(started.body.ok, true);
      assert.equal(started.body.status.running, true);

      created[0].stdout.emit("data", "server.started\n");
      const monitorRunning = await request(port, { pathname: "/api/monitor" });
      assert.equal(monitorRunning.status, 200);
      assert.equal(monitorRunning.body.status.running, true);
      assert.match((monitorRunning.body.runtimeLogLines || []).join("\n"), /server\.started/);

      const stopped = await request(port, { method: "POST", pathname: "/api/stop" });
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.status.running, false);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager can revoke all sessions by rotating session secret", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const initialSecret = "y".repeat(48);
    await fs.writeFile(
      envPath,
      [
        "HOST=127.0.0.1",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=scrypt$a$b",
        `SESSION_SECRET=${initialSecret}`,
        "REQUIRE_TOTP=false",
        "",
      ].join("\n"),
      "utf8",
    );

    const { factory, created } = createFakeProcessFactory();
    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      processFactory: factory,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const started = await request(port, { method: "POST", pathname: "/api/start" });
      assert.equal(started.status, 200);
      assert.equal(started.body.status.running, true);
      assert.equal(created.length, 1);

      const revoke = await request(port, { method: "POST", pathname: "/api/sessions/revoke-all" });
      assert.equal(revoke.status, 200);
      assert.equal(revoke.body.ok, true);
      assert.equal(revoke.body.serviceRestarted, true);
      assert.equal(revoke.body.forceReauthUrl, "/login?reauth=1");
      assert.equal(created.length, 2);
      assert.equal(created[0].killed, true);

      const envContent = await fs.readFile(envPath, "utf8");
      const secretLine = envContent
        .split(/\r?\n/)
        .find((line) => line.startsWith("SESSION_SECRET="));
      assert.ok(secretLine);
      assert.notEqual(secretLine, `SESSION_SECRET=${initialSecret}`);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager lock toggle restarts a running managed gateway immediately", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const initialSecret = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    await fs.writeFile(
      envPath,
      [
        "HOST=127.0.0.1",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=scrypt$a$b",
        `SESSION_SECRET=${initialSecret}`,
        "REQUIRE_TOTP=false",
        "BLAST_DOORS_CLOSED=false",
        "",
      ].join("\n"),
      "utf8",
    );

    const { factory, created } = createFakeProcessFactory();
    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      processFactory: factory,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const started = await request(port, { method: "POST", pathname: "/api/start" });
      assert.equal(started.status, 200);
      assert.equal(started.body.status.running, true);
      assert.equal(created.length, 1);
      assert.equal(created[0].killed, false);

      const configBefore = await request(port, { pathname: "/api/config" });
      assert.equal(configBefore.status, 200);
      assert.equal(configBefore.body.config.BLAST_DOORS_CLOSED, "false");

      const saved = await request(port, {
        method: "POST",
        pathname: "/api/config",
        body: {
          ...configBefore.body.config,
          BLAST_DOORS_CLOSED: "true",
          AUTH_PASSWORD: "",
        },
      });

      assert.equal(saved.status, 200);
      assert.equal(saved.body.ok, true);
      assert.equal(saved.body.config.BLAST_DOORS_CLOSED, "true");
      assert.equal(saved.body.runtime.blastDoorsChanged, true);
      assert.equal(saved.body.runtime.serviceRestarted, true);
      assert.equal(saved.body.runtime.sessionSecretRotated, true);

      assert.equal(created[0].killed, true);
      assert.equal(created.length, 2);

      const runtimeStatePath = path.join(workspaceDir, "data", "runtime-state.json");
      const runtimeStateRaw = await fs.readFile(runtimeStatePath, "utf8");
      assert.match(runtimeStateRaw, /"blastDoorsClosed": true/);

      const envContent = await fs.readFile(envPath, "utf8");
      const secretLine = envContent
        .split(/\r?\n/)
        .find((line) => line.startsWith("SESSION_SECRET="));
      assert.ok(secretLine);
      assert.notEqual(secretLine, `SESSION_SECRET=${initialSecret}`);

      const monitor = await request(port, { pathname: "/api/monitor" });
      assert.equal(monitor.status, 200);
      assert.equal(monitor.body.status.running, true);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager creates and applies login themes from graphics assets", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const graphicsDir = path.join(workspaceDir, "graphics");
    const themeStorePath = path.join(graphicsDir, "themes", "themes.json");

    await fs.mkdir(path.join(graphicsDir, "logo"), { recursive: true });
    await fs.mkdir(path.join(graphicsDir, "background"), { recursive: true });
    await fs.writeFile(path.join(graphicsDir, "logo", "crest.png"), "logo", "utf8");
    await fs.writeFile(path.join(graphicsDir, "background", "closed.png"), "closed", "utf8");
    await fs.writeFile(path.join(graphicsDir, "background", "open.png"), "open", "utf8");
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
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      graphicsDir,
      themeStorePath,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const logoAsset = await request(port, { pathname: "/graphics/logo/crest.png" });
      assert.equal(logoAsset.status, 200);
      assert.equal(logoAsset.body.raw, "logo");

      const before = await request(port, { pathname: "/api/themes" });
      assert.equal(before.status, 200);
      assert.equal(before.body.ok, true);
      assert.equal(Array.isArray(before.body.assets.logos), true);
      assert.equal(Array.isArray(before.body.assets.backgrounds), true);
      assert.equal(before.body.themes.length, 1);
      assert.equal(before.body.activeThemeId, "blastdoor-default");
      assert.equal(before.body.themes[0].id, "blastdoor-default");
      assert.equal(before.body.themes[0].logoUrl, "");
      assert.equal(before.body.themes[0].closedBackgroundUrl, "");
      assert.equal(before.body.themes[0].openBackgroundUrl, "");
      assert.equal(before.body.themes[0].loginBoxWidthPercent, 100);
      assert.equal(before.body.themes[0].loginBoxHeightPercent, 100);
      assert.equal(before.body.themes[0].loginBoxOpacityPercent, 100);
      assert.equal(before.body.themes[0].loginBoxHoverOpacityPercent, 100);
      assert.equal(before.body.themes[0].loginBoxPosXPercent, 50);
      assert.equal(before.body.themes[0].loginBoxPosYPercent, 50);
      assert.equal(before.body.themes[0].logoSizePercent, 30);
      assert.equal(before.body.themes[0].logoOffsetXPercent, 2);
      assert.equal(before.body.themes[0].logoOffsetYPercent, 2);
      assert.equal(before.body.themes[0].backgroundZoomPercent, 100);
      assert.equal(before.body.themes[0].loginBoxMode, "dark");

      const created = await request(port, {
        method: "POST",
        pathname: "/api/themes/create",
        body: {
          name: "Crystal Watch",
          logoPath: "logo/crest.png",
          closedBackgroundPath: "background/closed.png",
          openBackgroundPath: "background/open.png",
          loginBoxWidthPercent: 76,
          loginBoxHeightPercent: 84,
          loginBoxOpacityPercent: 72,
          loginBoxHoverOpacityPercent: 95,
          loginBoxPosXPercent: 60,
          loginBoxPosYPercent: 40,
          logoSizePercent: 55,
          logoOffsetXPercent: 12,
          logoOffsetYPercent: 9,
          backgroundZoomPercent: 130,
          loginBoxMode: "light",
          makeActive: "true",
        },
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.ok, true);
      assert.equal(created.body.activeThemeId, created.body.createdTheme.id);
      assert.equal(created.body.themes.length, 2);
      assert.equal(created.body.createdTheme.logoUrl, "/graphics/logo/crest.png");
      assert.equal(created.body.createdTheme.loginBoxWidthPercent, 76);
      assert.equal(created.body.createdTheme.loginBoxHeightPercent, 84);
      assert.equal(created.body.createdTheme.loginBoxOpacityPercent, 72);
      assert.equal(created.body.createdTheme.loginBoxHoverOpacityPercent, 95);
      assert.equal(created.body.createdTheme.loginBoxPosXPercent, 60);
      assert.equal(created.body.createdTheme.loginBoxPosYPercent, 40);
      assert.equal(created.body.createdTheme.logoSizePercent, 55);
      assert.equal(created.body.createdTheme.logoOffsetXPercent, 12);
      assert.equal(created.body.createdTheme.logoOffsetYPercent, 9);
      assert.equal(created.body.createdTheme.backgroundZoomPercent, 130);
      assert.equal(created.body.createdTheme.loginBoxMode, "light");

      const updated = await request(port, {
        method: "POST",
        pathname: "/api/themes/update",
        body: {
          themeId: created.body.createdTheme.id,
          name: "Crystal Watch Prime",
          logoPath: "",
          closedBackgroundPath: "background/open.png",
          openBackgroundPath: "background/closed.png",
          loginBoxWidthPercent: 20,
          loginBoxHeightPercent: 100,
          loginBoxOpacityPercent: 10,
          loginBoxHoverOpacityPercent: 100,
          loginBoxPosXPercent: 0,
          loginBoxPosYPercent: 100,
          logoSizePercent: 100,
          logoOffsetXPercent: 0,
          logoOffsetYPercent: 100,
          backgroundZoomPercent: 50,
          loginBoxMode: "dark",
          makeActive: "true",
        },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.ok, true);
      assert.equal(updated.body.updatedTheme.id, created.body.createdTheme.id);
      assert.equal(updated.body.updatedTheme.name, "Crystal Watch Prime");
      assert.equal(updated.body.updatedTheme.logoPath, "");
      assert.equal(updated.body.updatedTheme.closedBackgroundPath, "background/open.png");
      assert.equal(updated.body.updatedTheme.openBackgroundPath, "background/closed.png");
      assert.equal(updated.body.updatedTheme.loginBoxWidthPercent, 20);
      assert.equal(updated.body.updatedTheme.loginBoxHeightPercent, 100);
      assert.equal(updated.body.updatedTheme.loginBoxOpacityPercent, 10);
      assert.equal(updated.body.updatedTheme.loginBoxHoverOpacityPercent, 100);
      assert.equal(updated.body.updatedTheme.loginBoxPosXPercent, 0);
      assert.equal(updated.body.updatedTheme.loginBoxPosYPercent, 100);
      assert.equal(updated.body.updatedTheme.logoSizePercent, 100);
      assert.equal(updated.body.updatedTheme.logoOffsetXPercent, 0);
      assert.equal(updated.body.updatedTheme.logoOffsetYPercent, 100);
      assert.equal(updated.body.updatedTheme.backgroundZoomPercent, 50);
      assert.equal(updated.body.updatedTheme.loginBoxMode, "dark");

      const renamed = await request(port, {
        method: "POST",
        pathname: "/api/themes/rename",
        body: {
          themeId: created.body.createdTheme.id,
          name: "Crystal Watch Final",
        },
      });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.ok, true);
      assert.equal(renamed.body.updatedTheme.id, created.body.createdTheme.id);
      assert.equal(renamed.body.updatedTheme.name, "Crystal Watch Final");

      const applied = await request(port, {
        method: "POST",
        pathname: "/api/themes/apply",
        body: { themeId: renamed.body.updatedTheme.id },
      });
      assert.equal(applied.status, 200);
      assert.equal(applied.body.ok, true);
      assert.equal(applied.body.activeThemeId, renamed.body.updatedTheme.id);

      const deleted = await request(port, {
        method: "POST",
        pathname: "/api/themes/delete",
        body: { themeId: renamed.body.updatedTheme.id },
      });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.ok, true);
      assert.equal(deleted.body.deletedThemeId, renamed.body.updatedTheme.id);
      assert.equal(deleted.body.activeThemeId, "blastdoor-default");
      assert.equal(deleted.body.themes.length, 1);

      const rawThemeStore = await fs.readFile(themeStorePath, "utf8");
      assert.match(rawThemeStore, /"activeThemeId"/);
      assert.doesNotMatch(rawThemeStore, /Crystal Watch Final/);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager write endpoints are rate limited", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
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
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      managerWriteRateLimitWindowMs: 60_000,
      managerWriteRateLimitMax: 2,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const first = await request(port, { method: "POST", pathname: "/api/themes/apply", body: {} });
      const second = await request(port, { method: "POST", pathname: "/api/themes/apply", body: {} });
      const third = await request(port, { method: "POST", pathname: "/api/themes/apply", body: {} });

      assert.equal(first.status, 400);
      assert.equal(second.status, 400);
      assert.equal(third.status, 429);
      const limiterMessage = String(third.body.error || third.body.raw || "");
      assert.match(limiterMessage, /Too many manager write requests/i);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager adds missing theme layout defaults and persists migrated schema", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const graphicsDir = path.join(workspaceDir, "graphics");
    const themeStorePath = path.join(graphicsDir, "themes", "themes.json");

    await fs.mkdir(path.join(graphicsDir, "themes"), { recursive: true });
    await fs.writeFile(
      themeStorePath,
      JSON.stringify(
        {
          activeThemeId: "legacy-theme",
          themes: [
            {
              id: "legacy-theme",
              name: "Legacy Theme",
              logoPath: "",
              closedBackgroundPath: "",
              openBackgroundPath: "",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
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
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      graphicsDir,
      themeStorePath,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, { pathname: "/api/themes" });
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);

      const legacy = response.body.themes.find((theme) => theme.id === "legacy-theme");
      assert.ok(legacy);
      assert.equal(legacy.loginBoxWidthPercent, 100);
      assert.equal(legacy.loginBoxHeightPercent, 100);
      assert.equal(legacy.loginBoxOpacityPercent, 100);
      assert.equal(legacy.loginBoxHoverOpacityPercent, 100);
      assert.equal(legacy.loginBoxPosXPercent, 50);
      assert.equal(legacy.loginBoxPosYPercent, 50);
      assert.equal(legacy.logoSizePercent, 30);
      assert.equal(legacy.logoOffsetXPercent, 2);
      assert.equal(legacy.logoOffsetYPercent, 2);
      assert.equal(legacy.backgroundZoomPercent, 100);
      assert.equal(legacy.loginBoxMode, "dark");

      const raw = await fs.readFile(themeStorePath, "utf8");
      assert.match(raw, /"loginBoxWidthPercent": 100/);
      assert.match(raw, /"loginBoxHeightPercent": 100/);
      assert.match(raw, /"loginBoxOpacityPercent": 100/);
      assert.match(raw, /"loginBoxHoverOpacityPercent": 100/);
      assert.match(raw, /"loginBoxPosXPercent": 50/);
      assert.match(raw, /"loginBoxPosYPercent": 50/);
      assert.match(raw, /"logoSizePercent": 30/);
      assert.match(raw, /"logoOffsetXPercent": 2/);
      assert.match(raw, /"logoOffsetYPercent": 2/);
      assert.match(raw, /"backgroundZoomPercent": 100/);
      assert.match(raw, /"loginBoxMode": "dark"/);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager diagnostics endpoint returns sanitized report", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    await fs.writeFile(
      envPath,
      [
        "HOST=0.0.0.0",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=postgres",
        "CONFIG_STORE_MODE=postgres",
        "POSTGRES_URL=postgres://blastdoor:super-secret@127.0.0.1:5432/blastdoor",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=scrypt$param$hashvalue",
        "SESSION_SECRET=super-session-secret-super-session-secret",
        "REQUIRE_TOTP=true",
        "TOTP_SECRET=totp-shared-secret",
        "DEBUG_MODE=true",
        "DEBUG_LOG_FILE=logs/blastdoor-debug.log",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, { pathname: "/api/diagnostics" });
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);

      const config = response.body.report.config;
      assert.equal(config.AUTH_PASSWORD_HASH, "[REDACTED]");
      assert.equal(config.AUTH_PASSWORD_HASH_PRESENT, true);
      assert.equal(config.SESSION_SECRET, "[REDACTED]");
      assert.equal(config.TOTP_SECRET, "[REDACTED]");
      assert.match(config.POSTGRES_URL, /postgres:\/\/REDACTED:REDACTED@127\.0\.0\.1:5432\/blastdoor/);
      assert.equal(typeof response.body.report.foundryHealth, "object");
      assert.equal(typeof response.body.report.loginAppearance, "object");
      assert.equal(typeof response.body.report.loginAppearance.copyPasteText, "string");
      assert.equal(response.body.report.loginAppearance.activeThemeId, "blastdoor-default");

      assert.doesNotMatch(response.body.summary, /super-session-secret/);
      assert.doesNotMatch(response.body.summary, /super-secret/);
      assert.match(response.body.summary, /Redactions:/);
      assert.match(response.body.summary, /Login Theme:/);

      const aliasResponse = await request(port, { pathname: "/manager/api/diagnostics" });
      assert.equal(aliasResponse.status, 200);
      assert.equal(aliasResponse.body.ok, true);
      assert.equal(aliasResponse.body.report.config.SESSION_SECRET, "[REDACTED]");
    } finally {
      await closeServer(server);
    }
  });
});

test("manager diagnostics preserves empty secret fields", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    await fs.writeFile(
      envPath,
      [
        "HOST=127.0.0.1",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "CONFIG_STORE_MODE=env",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=",
        "SESSION_SECRET=",
        "REQUIRE_TOTP=false",
        "TOTP_SECRET=",
        "DEBUG_MODE=false",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      managerDir: path.resolve(process.cwd(), "public", "manager"),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, { pathname: "/api/diagnostics" });
      assert.equal(response.status, 200);
      const config = response.body.report.config;
      assert.equal(config.AUTH_PASSWORD_HASH, "");
      assert.equal(config.AUTH_PASSWORD_HASH_PRESENT, false);
      assert.equal(config.SESSION_SECRET, "");
      assert.equal(config.TOTP_SECRET, "");
    } finally {
      await closeServer(server);
    }
  });
});

test("manager diagnostics masks postgres URL credentials with fallback parser", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    await fs.writeFile(
      envPath,
      [
        "HOST=127.0.0.1",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=postgres",
        "CONFIG_STORE_MODE=postgres",
        "POSTGRES_URL=//blastdoor:super-secret@127.0.0.1:5432/blastdoor",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=scrypt$a$b",
        "SESSION_SECRET=xxx",
        "REQUIRE_TOTP=false",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      managerDir: path.resolve(process.cwd(), "public", "manager"),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, { pathname: "/api/diagnostics" });
      assert.equal(response.status, 200);
      assert.equal(response.body.report.config.POSTGRES_URL, "//REDACTED:REDACTED@127.0.0.1:5432/blastdoor");
    } finally {
      await closeServer(server);
    }
  });
});

test("manager diagnostics returns JSON error when .env cannot be read", async () => {
  await withTempDir(async (workspaceDir) => {
    const { app } = createManagerApp({
      workspaceDir,
      envPath: workspaceDir,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, { pathname: "/api/diagnostics" });
      assert.equal(response.status, 500);
      assert.equal(typeof response.body.error, "string");
      assert.match(response.body.error, /Failed to read config/);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager troubleshooting report includes WSL guidance when running in WSL", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    await fs.writeFile(
      envPath,
      [
        "HOST=0.0.0.0",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=scrypt$x$y",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "COOKIE_SECURE=true",
        "",
      ].join("\n"),
      "utf8",
    );

    const previousDistro = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = "Ubuntu-24.04";

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      managerDir: path.resolve(process.cwd(), "public", "manager"),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, { pathname: "/api/troubleshoot" });
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);

      const report = response.body.report;
      assert.equal(report.environment.isWsl, true);
      assert.equal(Array.isArray(report.checks), true);
      assert.ok(report.checks.find((check) => check.id === "network.wsl2-portproxy"));
      assert.ok(report.checks.find((check) => check.id === "proxy.foundry-dns"));
      assert.ok(report.checks.find((check) => check.id === "proxy.foundry-tcp"));
      assert.ok(report.checks.find((check) => check.id === "proxy.foundry-loopback-runtime"));
      assert.ok(report.checks.find((check) => String(check.id || "").startsWith("login-theme.")));
      assert.ok(report.safeActions.find((action) => action.id === "detect.wsl-portproxy"));
      assert.ok(report.safeActions.find((action) => action.id === "fix.wsl-foundry-target"));
      assert.equal(typeof report.loginAppearance, "object");
      assert.equal(typeof report.loginAppearance.copyPasteText, "string");

      const guided = report.guidedActions.find((entry) => entry.id === "guide.wsl2-portproxy-fix");
      assert.ok(guided);
      assert.equal(guided.destructive, true);
      assert.match(guided.script, /netsh interface portproxy add/);
    } finally {
      if (previousDistro === undefined) {
        delete process.env.WSL_DISTRO_NAME;
      } else {
        process.env.WSL_DISTRO_NAME = previousDistro;
      }
      await closeServer(server);
    }
  });
});

test("manager troubleshooting flags proxy self-target misconfiguration", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    await fs.writeFile(
      envPath,
      [
        "HOST=127.0.0.1",
        "PORT=8080",
        "FOUNDRY_TARGET=http://localhost:8080",
        "PASSWORD_STORE_MODE=env",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=scrypt$x$y",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      managerDir: path.resolve(process.cwd(), "public", "manager"),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, { pathname: "/api/troubleshoot" });
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);

      const issue = response.body.report.checks.find((entry) => entry.id === "proxy.self-target");
      assert.ok(issue);
      assert.equal(issue.status, "error");
      assert.match(issue.detail, /FOUNDRY_TARGET resolves to the Blastdoor gateway/i);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager troubleshooting runs non-destructive action with injected runner", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    await fs.writeFile(
      envPath,
      [
        "HOST=0.0.0.0",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=scrypt$x$y",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "",
      ].join("\n"),
      "utf8",
    );

    const calls = [];
    const commandRunner = async ({ command, args }) => {
      calls.push({ command, args });
      return {
        ok: true,
        command,
        args,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      };
    };

    const { app } = createManagerApp({ workspaceDir, envPath, commandRunner });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, {
        method: "POST",
        pathname: "/api/troubleshoot/run",
        body: { actionId: "snapshot.network" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.result.actionId, "snapshot.network");
      assert.ok((response.body.result.outputs || []).length >= 4);
      assert.ok(calls.find((entry) => entry.command === "ss"));
      assert.ok(calls.find((entry) => entry.command === "ip"));
    } finally {
      await closeServer(server);
    }
  });
});

test("manager troubleshooting can auto-fix WSL Foundry target", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    await fs.writeFile(
      envPath,
      [
        "HOST=0.0.0.0",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=scrypt$x$y",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "",
      ].join("\n"),
      "utf8",
    );

    const commandRunner = async ({ command, args }) => {
      if (command === "ip" && Array.isArray(args) && args.join(" ") === "route show default") {
        return {
          ok: true,
          command,
          args,
          exitCode: 0,
          stdout: "default via 172.30.240.1 dev eth0 proto kernel\n",
          stderr: "",
        };
      }
      return {
        ok: true,
        command,
        args,
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    };

    const previousDistro = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = "Ubuntu-24.04";

    const { app } = createManagerApp({ workspaceDir, envPath, commandRunner });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, {
        method: "POST",
        pathname: "/api/troubleshoot/run",
        body: { actionId: "fix.wsl-foundry-target" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.result.actionId, "fix.wsl-foundry-target");
      assert.equal(response.body.result.changedConfig, true);
      assert.equal(response.body.result.requiresRestart, true);
      assert.equal(response.body.result.newFoundryTarget, "http://172.30.240.1:30000");

      const saved = dotenv.parse(await fs.readFile(envPath, "utf8"));
      assert.equal(saved.FOUNDRY_TARGET, "http://172.30.240.1:30000");
    } finally {
      if (previousDistro === undefined) {
        delete process.env.WSL_DISTRO_NAME;
      } else {
        process.env.WSL_DISTRO_NAME = previousDistro;
      }
      await closeServer(server);
    }
  });
});

test("manager troubleshooting rejects guided potentially-destructive actions", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    await fs.writeFile(
      envPath,
      [
        "HOST=0.0.0.0",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=scrypt$x$y",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      managerDir: path.resolve(process.cwd(), "public", "manager"),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, {
        method: "POST",
        pathname: "/api/troubleshoot/run",
        body: { actionId: "guide.wsl2-portproxy-fix" },
      });
      assert.equal(response.status, 400);
      assert.match(response.body.error, /potentially destructive/i);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager remains accessible when blast doors are closed", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    await fs.writeFile(
      envPath,
      [
        "HOST=0.0.0.0",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=env",
        "AUTH_USERNAME=gm",
        "AUTH_PASSWORD_HASH=scrypt$x$y",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "BLAST_DOORS_CLOSED=true",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      managerDir: path.resolve(process.cwd(), "public", "manager"),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const ui = await request(port, { pathname: "/manager/" });
      assert.equal(ui.status, 200);
      assert.match(ui.body.raw || "", /Blastdoor Control Console/);

      const config = await request(port, { pathname: "/api/config" });
      assert.equal(config.status, 200);
      assert.equal(config.body.config.BLAST_DOORS_CLOSED, "true");

      const trouble = await request(port, { pathname: "/api/troubleshoot" });
      assert.equal(trouble.status, 200);
      assert.equal(trouble.body.ok, true);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager user management supports create update filters and token actions", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const passwordStoreFile = path.join(workspaceDir, "mock", "password-store.json");
    await fs.mkdir(path.dirname(passwordStoreFile), { recursive: true });
    await fs.writeFile(
      passwordStoreFile,
      JSON.stringify(
        {
          users: [{ username: "gm", passwordHash: "scrypt$seed$hash", disabled: false }],
        },
        null,
        2,
      ),
      "utf8",
    );

    await fs.writeFile(
      envPath,
      [
        "HOST=127.0.0.1",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=file",
        `PASSWORD_STORE_FILE=${passwordStoreFile}`,
        "AUTH_USERNAME=",
        "AUTH_PASSWORD_HASH=",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "SESSION_MAX_AGE_HOURS=12",
        "REQUIRE_TOTP=false",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      managerDir: path.resolve(process.cwd(), "public", "manager"),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const initial = await request(port, { pathname: "/api/users?view=all" });
      assert.equal(initial.status, 200);
      assert.equal(initial.body.users.length, 1);
      assert.equal(initial.body.users[0].username, "gm");

      const created = await request(port, {
        method: "POST",
        pathname: "/api/users/create",
        body: {
          username: "pilot-1",
          password: "Correct Horse Battery Staple 123!",
          friendlyName: "Pilot One",
          email: "pilot@example.test",
          status: "active",
          displayInfo: "Frontline scout",
          notes: "Created from manager integration test",
        },
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.ok, true);
      assert.equal(created.body.user.username, "pilot-1");
      assert.equal(created.body.user.status, "active");

      const updated = await request(port, {
        method: "POST",
        pathname: "/api/users/update",
        body: {
          username: "pilot-1",
          password: "",
          friendlyName: "Pilot Prime",
          email: "pilot-prime@example.test",
          status: "deactivated",
          displayInfo: "Grounded",
          notes: "Temporarily disabled",
        },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.user.status, "deactivated");
      assert.equal(updated.body.user.friendlyName, "Pilot Prime");

      const inactive = await request(port, { pathname: "/api/users?view=inactive" });
      assert.equal(inactive.status, 200);
      assert.equal(inactive.body.users.some((entry) => entry.username === "pilot-1"), true);

      const reinstated = await request(port, {
        method: "POST",
        pathname: "/api/users/set-status",
        body: {
          username: "pilot-1",
          status: "active",
        },
      });
      assert.equal(reinstated.status, 200);
      assert.equal(reinstated.body.user.status, "active");

      const tempCode = await request(port, {
        method: "POST",
        pathname: "/api/users/reset-login-code",
        body: {
          username: "pilot-1",
          delivery: "email",
          ttlMinutes: 15,
        },
      });
      assert.equal(tempCode.status, 200);
      assert.match(String(tempCode.body.code || ""), /[A-Za-z0-9_-]{8,}/);
      assert.match(String(tempCode.body.warning || ""), /email dispatch unavailable/i);

      const invalidated = await request(port, {
        method: "POST",
        pathname: "/api/users/invalidate-token",
        body: {
          username: "pilot-1",
        },
      });
      assert.equal(invalidated.status, 200);
      assert.ok(Number.parseInt(String(invalidated.body.sessionVersion || "0"), 10) >= 2);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager user management rejects malformed email input", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const passwordStoreFile = path.join(workspaceDir, "mock", "password-store.json");
    await fs.mkdir(path.dirname(passwordStoreFile), { recursive: true });
    await fs.writeFile(
      passwordStoreFile,
      JSON.stringify(
        {
          users: [{ username: "gm", passwordHash: "scrypt$seed$hash", disabled: false }],
        },
        null,
        2,
      ),
      "utf8",
    );

    await fs.writeFile(
      envPath,
      [
        "HOST=127.0.0.1",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=file",
        `PASSWORD_STORE_FILE=${passwordStoreFile}`,
        "AUTH_USERNAME=",
        "AUTH_PASSWORD_HASH=",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "SESSION_MAX_AGE_HOURS=12",
        "REQUIRE_TOTP=false",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      managerDir: path.resolve(process.cwd(), "public", "manager"),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const created = await request(port, {
        method: "POST",
        pathname: "/api/users/create",
        body: {
          username: "pilot-2",
          password: "Correct Horse Battery Staple 123!",
          friendlyName: "Pilot Two",
          email: "pilot@!.",
          status: "active",
          displayInfo: "",
          notes: "",
        },
      });
      assert.equal(created.status, 400);
      assert.match(String(created.body.error || ""), /email must be valid/i);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager reset login code reports sent email when provider is configured", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const passwordStoreFile = path.join(workspaceDir, "mock", "password-store.json");
    await fs.mkdir(path.dirname(passwordStoreFile), { recursive: true });
    await fs.writeFile(
      passwordStoreFile,
      JSON.stringify(
        {
          users: [{ username: "gm", passwordHash: "scrypt$seed$hash", disabled: false }],
        },
        null,
        2,
      ),
      "utf8",
    );

    await fs.writeFile(
      envPath,
      [
        "HOST=127.0.0.1",
        "PORT=8080",
        "FOUNDRY_TARGET=http://127.0.0.1:30000",
        "PASSWORD_STORE_MODE=file",
        `PASSWORD_STORE_FILE=${passwordStoreFile}`,
        "AUTH_USERNAME=",
        "AUTH_PASSWORD_HASH=",
        "SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "SESSION_MAX_AGE_HOURS=12",
        "REQUIRE_TOTP=false",
        "EMAIL_PROVIDER=console",
        "EMAIL_FROM=blastdoor@example.test",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      managerDir: path.resolve(process.cwd(), "public", "manager"),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const created = await request(port, {
        method: "POST",
        pathname: "/api/users/create",
        body: {
          username: "pilot-mail",
          password: "Correct Horse Battery Staple 123!",
          friendlyName: "Pilot Mail",
          email: "pilot-mail@example.test",
          status: "active",
          displayInfo: "",
          notes: "",
        },
      });
      assert.equal(created.status, 200);

      const tempCode = await request(port, {
        method: "POST",
        pathname: "/api/users/reset-login-code",
        body: {
          username: "pilot-mail",
          delivery: "email",
        },
      });
      assert.equal(tempCode.status, 200);
      assert.equal(tempCode.body.emailSent, true);
      assert.equal(tempCode.body.emailTo, "pilot-mail@example.test");
      assert.equal(String(tempCode.body.warning || ""), "");
    } finally {
      await closeServer(server);
    }
  });
});

test("manager TLS endpoints detect environment, generate plan, and save config", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
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
        "",
      ].join("\n"),
      "utf8",
    );

    const certFile = path.join(workspaceDir, "tls", "fullchain.pem");
    const keyFile = path.join(workspaceDir, "tls", "privkey.pem");
    await fs.mkdir(path.dirname(certFile), { recursive: true });
    await fs.writeFile(certFile, "dummy-cert", "utf8");
    await fs.writeFile(keyFile, "dummy-key", "utf8");

    const commandRunner = async ({ command }) => {
      if (command === "certbot") {
        return { ok: true, stdout: "certbot 2.10.0", stderr: "", exitCode: 0 };
      }
      if (command === "docker") {
        return { ok: false, stdout: "", stderr: "command not found", exitCode: 127, error: "not found" };
      }
      if (command === "openssl") {
        return { ok: true, stdout: "OpenSSL 3.0.0", stderr: "", exitCode: 0 };
      }
      return { ok: false, stdout: "", stderr: "unsupported", exitCode: 1, error: "unsupported" };
    };

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      commandRunner,
      managerDir: path.resolve(process.cwd(), "public", "manager"),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const tlsStatus = await request(port, { pathname: "/api/tls" });
      assert.equal(tlsStatus.status, 200);
      assert.equal(tlsStatus.body.detection.certbotAvailable, true);
      assert.equal(tlsStatus.body.detection.opensslAvailable, true);

      const plan = await request(port, {
        method: "POST",
        pathname: "/api/tls/letsencrypt-plan",
        body: {
          tlsDomain: "vtt.example.test",
          tlsEmail: "admin@example.test",
          tlsChallengeMethod: "webroot",
          tlsWebrootPath: "/var/www/html",
        },
      });
      assert.equal(plan.status, 200);
      assert.equal(Array.isArray(plan.body.plan.commands), true);
      assert.equal(plan.body.plan.commands.some((entry) => entry.includes("certbot certonly --webroot")), true);

      const save = await request(port, {
        method: "POST",
        pathname: "/api/tls/save",
        body: {
          tlsEnabled: true,
          tlsDomain: "vtt.example.test",
          tlsEmail: "admin@example.test",
          tlsChallengeMethod: "webroot",
          tlsWebrootPath: "/var/www/html",
          tlsCertFile: certFile,
          tlsKeyFile: keyFile,
        },
      });
      assert.equal(save.status, 200);
      assert.equal(save.body.tls.tlsEnabled, true);
      assert.equal(save.body.tls.tlsDomain, "vtt.example.test");

      const envContent = await fs.readFile(envPath, "utf8");
      assert.match(envContent, /TLS_ENABLED=true/);
      assert.match(envContent, /TLS_DOMAIN=vtt\.example\.test/);
      assert.match(envContent, /TLS_CERT_FILE=/);
      assert.match(envContent, /TLS_KEY_FILE=/);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager TLS endpoints reject malformed email input", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
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
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({
      workspaceDir,
      envPath,
      managerDir: path.resolve(process.cwd(), "public", "manager"),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const plan = await request(port, {
        method: "POST",
        pathname: "/api/tls/letsencrypt-plan",
        body: {
          tlsDomain: "vtt.example.test",
          tlsEmail: "admin@!.",
          tlsChallengeMethod: "webroot",
          tlsWebrootPath: "/var/www/html",
        },
      });
      assert.equal(plan.status, 400);
      assert.match(String(plan.body.error || ""), /email must be valid/i);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager assistant workflows return status and grimoire blocks", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
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
        "ASSISTANT_PROVIDER=ollama",
        "ASSISTANT_URL=",
        "ASSISTANT_OLLAMA_URL=http://172.30.240.1:11434",
        "ASSISTANT_OLLAMA_MODEL=llama3.1:latest",
        "ASSISTANT_TIMEOUT_MS=20000",
        "ASSISTANT_RETRY_MAX_ATTEMPTS=3",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({ workspaceDir, envPath });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const status = await request(port, { pathname: "/api/assistant/status" });
      assert.equal(status.status, 200);
      assert.equal(status.body.ok, true);
      assert.equal(status.body.status.mode, "local");
      assert.equal(status.body.config.ASSISTANT_OLLAMA_URL, "http://172.30.240.1:11434");
      assert.equal(status.body.config.ASSISTANT_OLLAMA_MODEL, "llama3.1:latest");
      assert.equal(status.body.config.ASSISTANT_TIMEOUT_MS, "20000");
      assert.equal(status.body.config.ASSISTANT_RETRY_MAX_ATTEMPTS, "3");

      const grimoire = await request(port, {
        method: "POST",
        pathname: "/api/assistant/workflow/grimoire",
        body: {
          intent: "create user and restart blastdoor service",
        },
      });
      assert.equal(grimoire.status, 200);
      assert.equal(grimoire.body.ok, true);
      assert.equal(grimoire.body.result.workflowId, "grimoire-api-intent-block-builder");
      assert.equal(grimoire.body.result.blockChain.length >= 1, true);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager intelligence workflow endpoints support list, generate, save, chat, and delete", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
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
        "ASSISTANT_PROVIDER=ollama",
        "ASSISTANT_URL=",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({ workspaceDir, envPath });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const listInitial = await request(port, {
        pathname: "/api/assistant/workflows",
      });
      assert.equal(listInitial.status, 200);
      assert.equal(listInitial.body.ok, true);
      const initialWorkflows = Array.isArray(listInitial.body.workflows) ? listInitial.body.workflows : [];
      assert.equal(initialWorkflows.length >= 4, true);
      assert.equal(initialWorkflows.some((entry) => entry.id === "grimoire"), true);

      const generated = await request(port, {
        method: "POST",
        pathname: "/api/assistant/workflows/generate-config",
        body: {
          description: "Create a workflow that checks auth errors and suggests remediation.",
        },
      });
      assert.equal(generated.status, 200);
      assert.equal(generated.body.ok, true);
      assert.equal(Boolean(generated.body.suggestedWorkflow), true);

      const save = await request(port, {
        method: "POST",
        pathname: "/api/assistant/workflows/save",
        body: {
          workflow: {
            ...generated.body.suggestedWorkflow,
            id: "custom-auth-remediation",
            name: "Custom Auth Remediation",
            type: "custom",
          },
        },
      });
      assert.equal(save.status, 200);
      assert.equal(save.body.ok, true);
      assert.equal(save.body.workflow.id, "custom-auth-remediation");

      const chat = await request(port, {
        method: "POST",
        pathname: "/api/assistant/workflows/chat",
        body: {
          workflowId: "custom-auth-remediation",
          message: "403 invalid origin during login from browser.",
        },
      });
      assert.equal(chat.status, 200);
      assert.equal(chat.body.ok, true);
      assert.equal(chat.body.workflow.id, "custom-auth-remediation");
      assert.equal(Boolean(chat.body.result.reply), true);

      const deleted = await request(port, {
        method: "POST",
        pathname: "/api/assistant/workflows/delete",
        body: {
          workflowId: "custom-auth-remediation",
        },
      });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.ok, true);
      assert.equal(deleted.body.deletedWorkflowId, "custom-auth-remediation");
    } finally {
      await closeServer(server);
    }
  });
});

test("manager intelligence agent scaffold endpoints support catalog, generate, save, and delete", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
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
        "ASSISTANT_PROVIDER=ollama",
        "ASSISTANT_URL=",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({ workspaceDir, envPath });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const catalog = await request(port, {
        pathname: "/api/assistant/agents/scaffolds",
      });
      assert.equal(catalog.status, 200);
      assert.equal(catalog.body.ok, true);
      assert.equal(Array.isArray(catalog.body.scaffolds), true);
      assert.equal(catalog.body.scaffolds.some((entry) => entry.id === "gather-diagnostics"), true);

      const generated = await request(port, {
        method: "POST",
        pathname: "/api/assistant/agents/generate",
        body: {
          name: "TLS Setup Agent",
          intent: "Guide TLS setup with diagnostics and explicit approvals.",
          scaffoldIds: ["gather-diagnostics", "recommend-remediation", "request-human-approval"],
        },
      });
      assert.equal(generated.status, 200);
      assert.equal(generated.body.ok, true);
      assert.equal(generated.body.draft.name, "TLS Setup Agent");
      assert.equal(Array.isArray(generated.body.draft.scaffoldIds), true);
      assert.equal(generated.body.draft.scaffoldIds.includes("request-human-approval"), true);
      assert.equal(generated.body.draft.approvals.required, true);
      assert.equal(Array.isArray(generated.body.draft.executionGraph?.nodes), true);
      assert.equal(Array.isArray(generated.body.draft.executionGraph?.edges), true);
      assert.equal(Array.isArray(generated.body.draft.executionGraph?.approvalGates), true);

      const validated = await request(port, {
        method: "POST",
        pathname: "/api/assistant/agents/validate",
        body: {
          agent: generated.body.draft,
        },
      });
      assert.equal(validated.status, 200);
      assert.equal(validated.body.ok, true);
      assert.equal(validated.body.validation?.ok, true);
      assert.equal(Array.isArray(validated.body.agent?.executionGraph?.nodes), true);

      const saved = await request(port, {
        method: "POST",
        pathname: "/api/assistant/agents/save",
        body: {
          agent: generated.body.draft,
        },
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.ok, true);
      assert.equal(saved.body.agent.id, generated.body.draft.id);
      assert.equal(Array.isArray(saved.body.agent.executionGraph?.nodes), true);
      assert.equal(saved.body.agent.executionGraphValidation?.ok, true);

      const listed = await request(port, {
        pathname: "/api/assistant/agents",
      });
      assert.equal(listed.status, 200);
      assert.equal(listed.body.ok, true);
      assert.equal(Array.isArray(listed.body.agents), true);
      assert.equal(listed.body.agents.some((entry) => entry.id === generated.body.draft.id), true);

      const deleted = await request(port, {
        method: "POST",
        pathname: "/api/assistant/agents/delete",
        body: {
          agentId: generated.body.draft.id,
        },
      });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.ok, true);
      assert.equal(deleted.body.deletedAgentId, generated.body.draft.id);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager assistant external agent API is gated and returns agent runtime report", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const databaseFile = path.join(workspaceDir, "data", "blastdoor.sqlite");
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
        "ASSISTANT_PROVIDER=ollama",
        "ASSISTANT_URL=",
        "ASSISTANT_EXTERNAL_API_ENABLED=true",
        "ASSISTANT_EXTERNAL_API_SIGNED_TOKENS_ENABLED=true",
        "ASSISTANT_EXTERNAL_API_SIGNING_SECRET=signing-secret-value-1234567890",
        "ASSISTANT_EXTERNAL_API_SIGNED_TOKEN_TTL_SECONDS=900",
        "CONFIG_STORE_MODE=sqlite",
        `DATABASE_FILE=${databaseFile}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({ workspaceDir, envPath });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const workflowSaved = await request(port, {
        method: "POST",
        pathname: "/api/assistant/workflows/save",
        body: {
          workflow: {
            id: "tls-setup-agent-workflow",
            name: "TLS Setup Agent Workflow",
            type: "custom",
            description: "Custom workflow for TLS setup agent reporting.",
            systemPrompt: "Return concise operational guidance.",
            seedPrompt: "Provide TLS setup guidance.",
            inputPlaceholder: "Describe TLS request.",
            ragEnabled: false,
            allowWebSearch: false,
            autoLockOnThreat: false,
            threatScoreThreshold: 80,
            config: {},
          },
        },
      });
      assert.equal(workflowSaved.status, 200);
      assert.equal(workflowSaved.body.ok, true);

      const agentSaved = await request(port, {
        method: "POST",
        pathname: "/api/assistant/agents/save",
        body: {
          agent: {
            id: "tls-setup-agent",
            name: "TLS Setup Agent",
            intent: "Collect diagnostics and track TLS rollout plan state.",
            scaffoldIds: ["gather-diagnostics", "recommend-remediation", "request-human-approval"],
            approvals: {
              required: true,
            },
            workflow: {
              id: "tls-setup-agent-workflow",
              name: "TLS Setup Agent Workflow",
              type: "custom",
              config: {},
            },
            meta: {},
          },
        },
      });
      assert.equal(agentSaved.status, 200);
      assert.equal(agentSaved.body.ok, true);

      const scopedTokenCreate = await request(port, {
        method: "POST",
        pathname: "/api/assistant/agents/tokens/create",
        body: {
          agentId: "tls-setup-agent",
          label: "integration-token",
          expiresInHours: 24,
        },
      });
      assert.equal(scopedTokenCreate.status, 200);
      assert.equal(scopedTokenCreate.body.ok, true);
      const scopedToken = String(scopedTokenCreate.body.token || "");
      assert.ok(scopedToken.length > 20);
      const createdTokenId = String(scopedTokenCreate.body.tokenMeta?.tokenId || "");
      assert.ok(createdTokenId.length > 5);

      const created = await request(port, {
        method: "POST",
        pathname: "/api/assistant/plans/create",
        body: {
          goal: "Prepare TLS rollout with verification checkpoints.",
          workflowId: "tls-setup-agent-workflow",
        },
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.ok, true);
      const runId = String(created.body.run?.runId || "");
      assert.ok(runId);

      const collected = await request(port, {
        method: "POST",
        pathname: `/api/assistant/plans/${encodeURIComponent(runId)}/collect-evidence`,
        body: {
          note: "Operator confirmed cert path and DNS propagation checks.",
        },
      });
      assert.equal(collected.status, 200);
      assert.equal(collected.body.ok, true);

      const unauthorized = await request(port, {
        pathname: "/api/assistant/v1/agents/TLS%20Setup%20Agent/report",
      });
      assert.equal(unauthorized.status, 401);

      const list = await request(port, {
        pathname: "/api/assistant/v1/agents",
        headers: {
          "x-blastdoor-assistant-token": scopedToken,
        },
      });
      assert.equal(list.status, 200);
      assert.equal(list.body.ok, true);
      assert.equal(Array.isArray(list.body.agents), true);
      assert.equal(list.body.agents.some((entry) => entry.name === "TLS Setup Agent"), true);

      const openapi = await request(port, {
        pathname: "/api/assistant/v1/openapi.json",
      });
      assert.equal(openapi.status, 200);
      assert.equal(openapi.body.openapi, "3.0.3");
      assert.equal(Boolean(openapi.body.paths["/api/assistant/v1/agents/{agentName}/report"]), true);

      const exchange = await request(port, {
        method: "POST",
        pathname: "/api/assistant/v1/auth/exchange",
        headers: {
          "x-blastdoor-assistant-token": scopedToken,
        },
      });
      assert.equal(exchange.status, 200);
      assert.equal(exchange.body.ok, true);
      const signedToken = String(exchange.body.accessToken || "");
      assert.match(signedToken, /^bdas1\./);

      const report = await request(port, {
        pathname: "/api/assistant/v1/agents/TLS%20Setup%20Agent/report",
        headers: {
          authorization: `Bearer ${signedToken}`,
        },
      });
      assert.equal(report.status, 200);
      assert.equal(report.body.ok, true);
      assert.equal(report.body.report.agent.name, "TLS Setup Agent");
      assert.equal(report.body.report.summary.runCount >= 1, true);
      assert.equal(Array.isArray(report.body.report.diagnostics), true);
      assert.equal(Array.isArray(report.body.report.troubleshoot), true);
      assert.equal(Array.isArray(report.body.report.humanInteractions), true);
      assert.equal(Boolean(report.body.report.progress), true);

      const legacyReport = await request(port, {
        pathname: "/api/assistant/agents/external/TLS%20Setup%20Agent",
        headers: {
          "x-blastdoor-assistant-token": scopedToken,
        },
      });
      assert.equal(legacyReport.status, 200);
      assert.equal(legacyReport.body.ok, true);

      const revoke = await request(port, {
        method: "POST",
        pathname: "/api/assistant/agents/tokens/revoke",
        body: {
          agentId: "tls-setup-agent",
          tokenId: createdTokenId,
        },
      });
      assert.equal(revoke.status, 200);
      assert.equal(revoke.body.ok, true);

      const revokedAccess = await request(port, {
        pathname: "/api/assistant/v1/agents",
        headers: {
          "x-blastdoor-assistant-token": scopedToken,
        },
      });
      assert.equal(revokedAccess.status, 401);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager assistant external agent API returns 404 when disabled", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
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
        "ASSISTANT_PROVIDER=ollama",
        "ASSISTANT_URL=",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({ workspaceDir, envPath });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const result = await request(port, {
        pathname: "/api/assistant/agents/external",
      });
      assert.equal(result.status, 404);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager assistant phase0 plan endpoints create, collect evidence, and refine", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const databaseFile = path.join(workspaceDir, "data", "blastdoor.sqlite");
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
        "ASSISTANT_PROVIDER=ollama",
        "ASSISTANT_URL=",
        "ASSISTANT_RAG_ENABLED=false",
        "ASSISTANT_ALLOW_WEB_SEARCH=false",
        "CONFIG_STORE_MODE=sqlite",
        `DATABASE_FILE=${databaseFile}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({ workspaceDir, envPath });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const initial = await request(port, { pathname: "/api/assistant/plans" });
      assert.equal(initial.status, 200);
      assert.equal(initial.body.ok, true);
      assert.equal(Array.isArray(initial.body.runs), true);

      const created = await request(port, {
        method: "POST",
        pathname: "/api/assistant/plans/create",
        body: {
          goal: "Prepare TLS rollout with clear diagnostics-first checks.",
          workflowId: "troubleshoot-recommendation",
        },
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.ok, true);
      assert.equal(typeof created.body.run?.runId, "string");
      assert.equal(Array.isArray(created.body.run?.layers), true);
      assert.equal(created.body.run.layers.length >= 1, true);

      const runId = created.body.run.runId;

      const collected = await request(port, {
        method: "POST",
        pathname: `/api/assistant/plans/${encodeURIComponent(runId)}/collect-evidence`,
        body: {
          note: "Operator captured baseline before TLS migration.",
        },
      });
      assert.equal(collected.status, 200);
      assert.equal(collected.body.ok, true);
      assert.equal(collected.body.evidenceAdded >= 2, true);
      assert.equal(Array.isArray(collected.body.run?.evidence), true);
      assert.equal(collected.body.run.evidence.length >= 2, true);

      const refined = await request(port, {
        method: "POST",
        pathname: `/api/assistant/plans/${encodeURIComponent(runId)}/refine`,
        body: {
          message: "Use collected evidence to produce a deeper layer with verification gates.",
        },
      });
      assert.equal(refined.status, 200);
      assert.equal(refined.body.ok, true);
      assert.equal(Array.isArray(refined.body.run?.layers), true);
      assert.equal(refined.body.run.layers.length >= 2, true);

      const fetched = await request(port, {
        pathname: `/api/assistant/plans/${encodeURIComponent(runId)}`,
      });
      assert.equal(fetched.status, 200);
      assert.equal(fetched.body.ok, true);
      assert.equal(fetched.body.run?.runId, runId);
      assert.equal(Array.isArray(fetched.body.run?.layers), true);
      assert.equal(fetched.body.run.layers.length >= 2, true);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager assistant wizard endpoints support step flow, save/resume, and safe-action trust", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const databaseFile = path.join(workspaceDir, "data", "blastdoor.sqlite");
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
        "ASSISTANT_PROVIDER=ollama",
        "ASSISTANT_URL=",
        "ASSISTANT_RAG_ENABLED=false",
        "ASSISTANT_ALLOW_WEB_SEARCH=false",
        "CONFIG_STORE_MODE=sqlite",
        `DATABASE_FILE=${databaseFile}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const commandRunner = async ({ command, args = [] }) => {
      const key = `${command} ${(Array.isArray(args) ? args : []).join(" ")}`.trim();
      if (key.startsWith("ss ")) {
        return { ok: true, command, args, stdout: "LISTEN 0 511 0.0.0.0:8080 0.0.0.0:*", stderr: "" };
      }
      if (key.startsWith("ip -4 addr show")) {
        return { ok: true, command, args, stdout: "inet 127.0.0.1/8 scope host lo", stderr: "" };
      }
      if (key.startsWith("ip route")) {
        return { ok: true, command, args, stdout: "default via 172.24.0.1 dev eth0", stderr: "" };
      }
      if (key.startsWith("hostname -I")) {
        return { ok: true, command, args, stdout: "127.0.0.1", stderr: "" };
      }
      if (key.startsWith("ufw status")) {
        return { ok: false, command, args, error: "not-installed", stdout: "", stderr: "ufw: not found" };
      }
      return { ok: true, command, args, stdout: "", stderr: "" };
    };

    const { app } = createManagerApp({ workspaceDir, envPath, commandRunner });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const started = await request(port, {
        method: "POST",
        pathname: "/api/assistant/wizard/start",
        body: {
          runName: "TLS Wizard Run",
          workflowId: "troubleshoot-recommendation",
        },
      });
      assert.equal(started.status, 200);
      assert.equal(started.body.ok, true);
      const runId = String(started.body.run?.runId || "");
      assert.ok(runId.length > 8);
      assert.equal(started.body.run?.wizard?.currentStep, "define_goal");

      const stepGoal = await request(port, {
        method: "POST",
        pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/next`,
        body: {
          runName: "TLS Wizard Run",
          goal: "Set up TLS with diagnostics-first checkpoints.",
          workflowId: "troubleshoot-recommendation",
        },
      });
      assert.equal(stepGoal.status, 200);
      assert.equal(stepGoal.body.ok, true);
      assert.equal(stepGoal.body.run?.wizard?.currentStep, "create_initial_plan");

      const stepInitial = await request(port, {
        method: "POST",
        pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/next`,
        body: {
          workflowId: "troubleshoot-recommendation",
        },
      });
      assert.equal(stepInitial.status, 200);
      assert.equal(stepInitial.body.ok, true);
      assert.equal(stepInitial.body.run?.wizard?.currentStep, "clarify_round");
      const questions = Array.isArray(stepInitial.body.run?.wizard?.clarification?.questions)
        ? stepInitial.body.run.wizard.clarification.questions
        : [];
      assert.equal(questions.length > 0, true);

      for (const question of questions) {
        if (question.required === false) {
          continue;
        }
        const answered = await request(port, {
          method: "POST",
          pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/answer`,
          body: {
            questionId: question.id,
            answer: `answer for ${question.id}`,
          },
        });
        assert.equal(answered.status, 200);
        assert.equal(answered.body.ok, true);
      }

      let stepClarify = await request(port, {
        method: "POST",
        pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/next`,
        body: {},
      });
      assert.equal(stepClarify.status, 200);
      assert.equal(stepClarify.body.ok, true);
      let clarifyStep = String(stepClarify.body.run?.wizard?.currentStep || "");
      let clarifyAttempts = 0;
      while (clarifyStep === "clarify_round" && clarifyAttempts < 3) {
        const nextQuestions = Array.isArray(stepClarify.body.run?.wizard?.clarification?.questions)
          ? stepClarify.body.run.wizard.clarification.questions
          : [];
        for (const question of nextQuestions) {
          if (question.required === false) {
            continue;
          }
          const answered = await request(port, {
            method: "POST",
            pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/answer`,
            body: {
              questionId: question.id,
              answer: `answer for ${question.id}`,
            },
          });
          assert.equal(answered.status, 200);
          assert.equal(answered.body.ok, true);
        }
        stepClarify = await request(port, {
          method: "POST",
          pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/next`,
          body: {},
        });
        assert.equal(stepClarify.status, 200);
        assert.equal(stepClarify.body.ok, true);
        clarifyStep = String(stepClarify.body.run?.wizard?.currentStep || "");
        clarifyAttempts += 1;
      }
      assert.equal(clarifyStep, "sufficiency_gate");

      const stepSufficiency = await request(port, {
        method: "POST",
        pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/next`,
        body: {},
      });
      assert.equal(stepSufficiency.status, 200);
      assert.equal(stepSufficiency.body.ok, true);
      assert.equal(stepSufficiency.body.run?.wizard?.currentStep, "collect_evidence");

      const stepEvidence = await request(port, {
        method: "POST",
        pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/next`,
        body: {
          note: "Operator note for evidence.",
        },
      });
      assert.equal(stepEvidence.status, 200);
      assert.equal(stepEvidence.body.ok, true);
      assert.equal(stepEvidence.body.run?.wizard?.currentStep, "refine_layer");

      const stepRefine = await request(port, {
        method: "POST",
        pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/next`,
        body: {},
      });
      assert.equal(stepRefine.status, 200);
      assert.equal(stepRefine.body.ok, true);
      assert.equal(stepRefine.body.run?.wizard?.currentStep, "execution_prep");

      const stepPrep = await request(port, {
        method: "POST",
        pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/next`,
        body: {},
      });
      assert.equal(stepPrep.status, 200);
      assert.equal(stepPrep.body.ok, true);
      assert.equal(stepPrep.body.run?.wizard?.currentStep, "execute_steps");
      const executionSteps = Array.isArray(stepPrep.body.run?.wizard?.execution?.steps)
        ? stepPrep.body.run.wizard.execution.steps
        : [];
      assert.equal(executionSteps.length >= 2, true);

      const manualStep = executionSteps.find((step) => step.mode === "manual" || step.mode === "manual-risky");
      assert.ok(manualStep);
      const stepManualComplete = await request(port, {
        method: "POST",
        pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/next`,
        body: {
          completeStepId: manualStep.id,
          result: "Manual verification complete.",
        },
      });
      assert.equal(stepManualComplete.status, 200);
      assert.equal(stepManualComplete.body.ok, true);
      assert.equal(stepManualComplete.body.run?.wizard?.currentStep, "execute_steps");

      const awaitingSafe = await request(port, {
        method: "POST",
        pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/next`,
        body: {},
      });
      assert.equal(awaitingSafe.status, 200);
      assert.equal(awaitingSafe.body.ok, true);
      assert.equal(awaitingSafe.body.awaitingAction, true);
      const requiredAction = awaitingSafe.body.requiredAction || {};
      assert.equal(Boolean(requiredAction.actionId), true);

      const runSafe = await request(port, {
        method: "POST",
        pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/run-safe-action`,
        body: {
          actionId: requiredAction.actionId,
          approved: true,
          rememberTrust: true,
        },
      });
      assert.equal(runSafe.status, 200);
      assert.equal(runSafe.body.ok, true);
      assert.equal(runSafe.body.trustSaved, true);

      const workflowList = await request(port, {
        pathname: "/api/assistant/workflows",
      });
      assert.equal(workflowList.status, 200);
      assert.equal(workflowList.body.ok, true);
      const troubleshootWorkflow = (workflowList.body.workflowConfigs || []).find(
        (entry) => entry.id === "troubleshoot-recommendation",
      );
      assert.ok(troubleshootWorkflow);
      const trustEntries = Array.isArray(troubleshootWorkflow?.config?.safeActionTrust)
        ? troubleshootWorkflow.config.safeActionTrust
        : [];
      assert.equal(trustEntries.some((entry) => entry.actionId === requiredAction.actionId), true);

      const saved = await request(port, {
        method: "POST",
        pathname: `/api/assistant/wizard/${encodeURIComponent(runId)}/save`,
        body: {
          runName: "TLS Wizard Run",
          goal: "Set up TLS with diagnostics-first checkpoints.",
        },
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.ok, true);
      assert.equal(saved.body.run?.wizard?.lastSavedAt ? true : false, true);

      const listedRuns = await request(port, {
        pathname: "/api/assistant/wizard/runs?limit=10",
      });
      assert.equal(listedRuns.status, 200);
      assert.equal(listedRuns.body.ok, true);
      assert.equal(Array.isArray(listedRuns.body.runs), true);
      assert.equal(listedRuns.body.runs.some((entry) => entry.runId === runId), true);
    } finally {
      await closeServer(server);
    }
  });
});

test("manager exposes plugin UI manifest for enabled plugins", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
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
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({ workspaceDir, envPath });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const response = await request(port, { pathname: "/api/plugins/ui" });
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(Array.isArray(response.body.plugins), true);

      const intelligence = response.body.plugins.find((entry) => entry.pluginId === "intelligence");
      assert.ok(intelligence);
      assert.equal(intelligence.jsPath, "/manager/plugins/intelligence.js");
      assert.equal(intelligence.cssPath, "/manager/plugins/intelligence.css");
    } finally {
      await closeServer(server);
    }
  });
});

test("manager assistant threat workflow can auto-lock blast doors", async () => {
  await withTempDir(async (workspaceDir) => {
    const envPath = path.join(workspaceDir, ".env");
    const logsDir = path.join(workspaceDir, "logs");
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(
      path.join(logsDir, "blastdoor-debug.log"),
      [
        '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.88"}',
        '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.88"}',
        '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.88"}',
        '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.88"}',
        '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.88"}',
        '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.88"}',
        '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.88"}',
        '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.88"}',
        '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.88"}',
        '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.88"}',
        "GET /?q=%3Cscript%3Ealert(1)%3C/script%3E",
        "",
      ].join("\n"),
      "utf8",
    );
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
        "BLAST_DOORS_CLOSED=false",
        "ASSISTANT_ENABLED=true",
        "ASSISTANT_PROVIDER=ollama",
        "ASSISTANT_URL=",
        "ASSISTANT_AUTO_LOCK_ON_THREAT=true",
        "ASSISTANT_THREAT_SCORE_THRESHOLD=20",
        "DEBUG_LOG_FILE=logs/blastdoor-debug.log",
        "",
      ].join("\n"),
      "utf8",
    );

    const { app } = createManagerApp({ workspaceDir, envPath });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const result = await request(port, {
        method: "POST",
        pathname: "/api/assistant/workflow/threat-monitor",
        body: {
          applyLockdown: true,
        },
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      assert.equal(result.body.result.shouldLockdown, true);
      assert.equal(result.body.lockdown.applied, true);

      const config = await request(port, { pathname: "/api/config" });
      assert.equal(config.status, 200);
      assert.equal(config.body.config.BLAST_DOORS_CLOSED, "true");
    } finally {
      await closeServer(server);
    }
  });
});

test("formatManagerListenError explains when manager port is already in use", () => {
  const message = formatManagerListenError({ code: "EADDRINUSE" }, { host: "127.0.0.1", port: 8090 });
  assert.match(message, /already in use/);
  assert.match(message, /another manager instance/i);
  assert.match(message, /MANAGER_PORT/);
});

test("createManagerServer routes listen errors to onListenError handler", async () => {
  await withTempDir(async (workspaceDir) => {
    const blocker = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end("busy");
    });
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");
    const busyPort = blocker.address().port;

    let listenError = null;
    let listenContext = null;
    const listenErrorPromise = new Promise((resolve) => {
      const server = createManagerServer({
        workspaceDir,
        envPath: path.join(workspaceDir, ".env"),
        host: "127.0.0.1",
        port: busyPort,
        silent: true,
        exitOnError: false,
        onListenError: (error, context) => {
          listenError = error;
          listenContext = context;
          if (server.listening) {
            server.close(() => resolve());
            return;
          }
          resolve();
        },
      });
    });

    try {
      await listenErrorPromise;
      assert.equal(listenError?.code, "EADDRINUSE");
      assert.equal(listenContext?.host, "127.0.0.1");
      assert.equal(listenContext?.port, busyPort);
      assert.equal(listenContext?.exitOnError, false);
    } finally {
      await closeServer(blocker);
    }
  });
});
