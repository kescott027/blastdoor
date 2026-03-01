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
  });

  assert.equal(normalized.layout.darkModePercent, 100);
  assert.equal(normalized.layout.lightModePercent, 0);
  assert.equal(normalized.access.requirePassword, true);
  assert.equal(normalized.access.passwordHash, "scrypt$demo$hash");
  assert.equal(normalized.access.sessionTtlHours, 168);
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
    });
    assert.equal(saved.layout.darkModePercent, 64);
    assert.equal(saved.layout.lightModePercent, 24);
    assert.equal(saved.access.requirePassword, true);
    assert.equal(saved.access.sessionTtlHours, 16);

    const loaded = await readManagerConsoleSettings(settingsPath);
    assert.equal(loaded.layout.darkModePercent, 64);
    assert.equal(loaded.layout.lightModePercent, 24);
    assert.equal(loaded.access.requirePassword, true);
    assert.equal(loaded.access.sessionTtlHours, 16);
  });
});
