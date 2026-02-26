import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { createManagerApp } from "../src/manager.js";

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
          resolve({
            status: res.statusCode,
            body: raw ? JSON.parse(raw) : {},
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
