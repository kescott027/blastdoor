import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { createManagerApp, createManagerServer, formatManagerListenError } from "../src/manager.js";

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
        "SESSION_SECRET=super-session-secret",
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

      assert.doesNotMatch(response.body.summary, /super-session-secret/);
      assert.doesNotMatch(response.body.summary, /super-secret/);
      assert.match(response.body.summary, /Redactions:/);

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

    const { app } = createManagerApp({ workspaceDir, envPath });
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

    const { app } = createManagerApp({ workspaceDir, envPath });
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
