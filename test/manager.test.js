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
      assert.ok(report.safeActions.find((action) => action.id === "detect.wsl-portproxy"));

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
