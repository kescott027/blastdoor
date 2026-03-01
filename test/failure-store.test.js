import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendFailureRecord, clearFailureStore, readFailureStore, summarizeFailureStore } from "../src/failure-store.js";

async function withTempDir(callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-failure-store-test-"));
  try {
    await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("failure store appends, classifies, and summarizes records", async () => {
  await withTempDir(async (workspaceDir) => {
    const filePath = path.join(workspaceDir, "data", "launch-failures.json");
    await appendFailureRecord(filePath, {
      source: "launch-console",
      action: "startup",
      message: "Error: listen EADDRNOTAVAIL: address not available 192.168.1.2:8080",
      isWsl: true,
    });

    const payload = await readFailureStore(filePath);
    assert.equal(payload.entries.length, 1);
    assert.equal(payload.entries[0].nature, "bind-address-unavailable");
    assert.equal(payload.entries[0].severity, "error");
    assert.equal(Array.isArray(payload.entries[0].fixes), true);
    assert.equal(payload.entries[0].fixes.length > 0, true);

    const summary = summarizeFailureStore(payload);
    assert.equal(summary.count, 1);
    assert.equal(summary.latestNature, "bind-address-unavailable");
  });
});

test("failure store clear removes all entries", async () => {
  await withTempDir(async (workspaceDir) => {
    const filePath = path.join(workspaceDir, "data", "launch-failures.json");
    await appendFailureRecord(filePath, {
      source: "launch-wrapper",
      action: "make-launch",
      message: "Request failed (403)",
    });
    await clearFailureStore(filePath);
    const payload = await readFailureStore(filePath);
    assert.equal(payload.entries.length, 0);
  });
});

