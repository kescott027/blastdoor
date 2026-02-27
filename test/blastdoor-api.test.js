import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createBlastdoorApi } from "../src/blastdoor-api.js";
import { createBlastdoorApiApp } from "../src/api-server.js";

function request(port, { method = "GET", pathname = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const requestHeaders = { ...headers };
    if (body) {
      requestHeaders["content-type"] = "application/json";
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
          resolve({ status: res.statusCode, body: parsed });
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

async function withTempDir(callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-api-test-"));
  try {
    await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("createBlastdoorApi remote adapter calls API with token", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      path: req.url,
      token: req.headers["x-blastdoor-api-token"] || "",
    });

    if (req.method === "POST" && req.url === "/internal/users/credential/get") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, user: { username: "gm", passwordHash: "scrypt$a$b", disabled: false } }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  try {
    const api = createBlastdoorApi({
      config: {
        blastdoorApiUrl: `http://127.0.0.1:${port}`,
        blastdoorApiToken: "test-token",
        blastdoorApiTimeoutMs: 1000,
      },
    });

    const user = await api.getUserCredential("gm");
    assert.equal(user.username, "gm");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].token, "test-token");
  } finally {
    await closeServer(server);
  }
});

test("createBlastdoorApi remote adapter retries transient failures for retryable calls", async () => {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount += 1;
    if (req.url === "/internal/users/credentials" && requestCount < 3) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Temporarily unavailable" }));
      return;
    }

    if (req.url === "/internal/users/credentials") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, users: [{ username: "gm", passwordHash: "scrypt$a$b", disabled: false }] }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  try {
    const api = createBlastdoorApi({
      config: {
        blastdoorApiUrl: `http://127.0.0.1:${port}`,
        blastdoorApiTimeoutMs: 800,
        blastdoorApiRetryMaxAttempts: 3,
        blastdoorApiRetryBaseDelayMs: 10,
        blastdoorApiRetryMaxDelayMs: 20,
      },
    });

    const users = await api.listCredentialUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].username, "gm");
    assert.equal(requestCount, 3);
  } finally {
    await closeServer(server);
  }
});

test("createBlastdoorApi remote adapter opens circuit after repeated failures", async () => {
  let requestCount = 0;
  const server = http.createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Upstream unavailable" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  try {
    const api = createBlastdoorApi({
      config: {
        blastdoorApiUrl: `http://127.0.0.1:${port}`,
        blastdoorApiTimeoutMs: 500,
        blastdoorApiRetryMaxAttempts: 1,
        blastdoorApiCircuitFailureThreshold: 2,
        blastdoorApiCircuitResetMs: 60000,
      },
    });

    await assert.rejects(() => api.getUserCredential("gm"), /Upstream unavailable/);
    await assert.rejects(() => api.getUserCredential("gm"), /Upstream unavailable/);
    await assert.rejects(() => api.getUserCredential("gm"), /circuit is open/i);
    assert.equal(requestCount, 2);
  } finally {
    await closeServer(server);
  }
});

test("blastdoor-api server enforces token and serves credential list", async () => {
  await withTempDir(async (workspaceDir) => {
    const graphicsDir = path.join(workspaceDir, "graphics");
    const themeStorePath = path.join(graphicsDir, "themes", "themes.json");
    const userProfileStorePath = path.join(workspaceDir, "data", "user-profiles.json");
    await fs.mkdir(path.dirname(themeStorePath), { recursive: true });
    await fs.mkdir(path.dirname(userProfileStorePath), { recursive: true });

    const { app } = createBlastdoorApiApp({
      workspaceDir,
      graphicsDir,
      themeStorePath,
      userProfileStorePath,
      token: "secure-token",
      config: {
        passwordStoreMode: "env",
        authUsername: "gm",
        authPasswordHash: "scrypt$a$b",
        totpSecret: "",
        passwordStoreFile: "mock/password-store.json",
        configStoreMode: "env",
        databaseFile: "",
        postgresUrl: "",
        postgresSsl: false,
        sessionMaxAgeHours: 12,
      },
    });

    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    try {
      const unauthorized = await request(port, { pathname: "/internal/users/credentials" });
      assert.equal(unauthorized.status, 401);

      const authorized = await request(port, {
        pathname: "/internal/users/credentials",
        headers: { "x-blastdoor-api-token": "secure-token" },
      });
      assert.equal(authorized.status, 200);
      assert.equal(authorized.body.ok, true);
      assert.equal(Array.isArray(authorized.body.users), true);
      assert.equal(authorized.body.users[0].username, "gm");
    } finally {
      await closeServer(server);
    }
  });
});
