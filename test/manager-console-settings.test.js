import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MANAGER_CONSOLE_SETTINGS,
  normalizeManagerConsoleSettings,
  readManagerConsoleSettings,
  sanitizeManagerConsoleSettingsForClient,
  writeManagerConsoleSettings,
} from "../src/manager-console-settings.js";

async function withTempDir(callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-manager-settings-test-"));
  try {
    await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("normalizeManagerConsoleSettings applies defaults and clamps values", () => {
  const normalized = normalizeManagerConsoleSettings({
    layout: {
      darkModePercent: 140,
      lightModePercent: -12,
    },
    access: {
      requirePassword: "true",
      passwordHash: "scrypt$demo$hash",
      sessionTtlHours: 999,
    },
    remoteSupport: {
      enabled: "true",
      callHomeEnabled: "true",
      defaultTokenTtlMinutes: 99999,
      tokens: [
        {
          tokenId: "tok-1",
          label: "Token 1",
          tokenHash: "scrypt$demo$hash",
          createdAt: "2026-03-02T00:00:00.000Z",
          expiresAt: "2120-01-01T00:00:00.000Z",
        },
        {
          tokenId: "tok-2",
          label: "Missing hash",
          tokenHash: "",
        },
      ],
      callHomeEvents: [
        {
          eventId: "evt-1",
          type: "register",
          createdAt: "2026-03-02T00:00:00.000Z",
          satelliteId: "diag-1",
          status: "ok",
          message: "connected",
          payload: { hostname: "diag-1" },
        },
      ],
    },
  });

  assert.equal(normalized.layout.darkModePercent, 100);
  assert.equal(normalized.layout.lightModePercent, 0);
  assert.equal(normalized.access.requirePassword, true);
  assert.equal(normalized.access.passwordHash, "scrypt$demo$hash");
  assert.equal(normalized.access.sessionTtlHours, 168);
  assert.equal(normalized.remoteSupport.enabled, true);
  assert.equal(normalized.remoteSupport.callHomeEnabled, true);
  assert.equal(normalized.remoteSupport.defaultTokenTtlMinutes, 1440);
  assert.equal(normalized.remoteSupport.tokens.length, 1);
  assert.equal(normalized.remoteSupport.tokens[0].tokenId, "tok-1");
  assert.equal(normalized.remoteSupport.callHomeEvents.length, 1);
  assert.equal(normalized.remoteSupport.callHomeEvents[0].eventId, "evt-1");
});

test("sanitizeManagerConsoleSettingsForClient redacts hash while preserving flags", () => {
  const payload = sanitizeManagerConsoleSettingsForClient({
    ...DEFAULT_MANAGER_CONSOLE_SETTINGS,
    access: {
      requirePassword: true,
      passwordHash: "scrypt$demo$hash",
      sessionTtlHours: 12,
    },
  });

  assert.equal(payload.access.requirePassword, true);
  assert.equal(payload.access.passwordConfigured, true);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.access, "passwordHash"), false);
  assert.equal(payload.remoteSupport.enabled, false);
  assert.equal(payload.remoteSupport.callHomeEnabled, false);
  assert.equal(payload.remoteSupport.defaultTokenTtlMinutes, 30);
  assert.equal(payload.remoteSupport.tokenCount, 0);
  assert.equal(payload.remoteSupport.activeTokenCount, 0);
  assert.equal(payload.remoteSupport.callHomeEventCount, 0);
});

test("manager console settings read/write persists normalized data", async () => {
  await withTempDir(async (tempDir) => {
    const settingsPath = path.join(tempDir, "data", "manager-console-settings.json");
    const initial = await readManagerConsoleSettings(settingsPath);
    assert.equal(initial.layout.darkModePercent, 100);
    assert.equal(initial.access.requirePassword, false);

    const saved = await writeManagerConsoleSettings(settingsPath, {
      layout: {
        darkModePercent: 64,
        lightModePercent: 24,
      },
      access: {
        requirePassword: true,
        passwordHash: "scrypt$demo$hash",
        sessionTtlHours: 16,
      },
      remoteSupport: {
        enabled: true,
        callHomeEnabled: true,
        defaultTokenTtlMinutes: 45,
      },
    });
    assert.equal(saved.layout.darkModePercent, 64);
    assert.equal(saved.layout.lightModePercent, 24);
    assert.equal(saved.access.requirePassword, true);
    assert.equal(saved.access.sessionTtlHours, 16);
    assert.equal(saved.remoteSupport.enabled, true);
    assert.equal(saved.remoteSupport.callHomeEnabled, true);
    assert.equal(saved.remoteSupport.defaultTokenTtlMinutes, 45);

    const loaded = await readManagerConsoleSettings(settingsPath);
    assert.equal(loaded.layout.darkModePercent, 64);
    assert.equal(loaded.layout.lightModePercent, 24);
    assert.equal(loaded.access.requirePassword, true);
    assert.equal(loaded.access.sessionTtlHours, 16);
    assert.equal(loaded.remoteSupport.enabled, true);
    assert.equal(loaded.remoteSupport.callHomeEnabled, true);
    assert.equal(loaded.remoteSupport.defaultTokenTtlMinutes, 45);
  });
});
