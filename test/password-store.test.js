import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EnvPasswordStore, FilePasswordStore } from "../src/password-store.js";

async function withTempDir(callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-store-"));
  try {
    await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("EnvPasswordStore returns matching user only", async () => {
  const store = new EnvPasswordStore({
    authUsername: "gm",
    authPasswordHash: "scrypt$abc$def",
  });

  const match = await store.getUserByUsername("gm");
  assert.equal(match?.username, "gm");
  assert.equal(match?.passwordHash, "scrypt$abc$def");

  const miss = await store.getUserByUsername("player");
  assert.equal(miss, null);
});

test("FilePasswordStore loads users array format", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "store.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        users: [
          { username: "gm", passwordHash: "scrypt$a$b" },
          { username: "player", passwordHash: "scrypt$c$d", disabled: true },
        ],
      }),
      "utf8",
    );

    const store = new FilePasswordStore({ filePath });
    const gm = await store.getUserByUsername("gm");
    assert.equal(gm?.passwordHash, "scrypt$a$b");

    const disabled = await store.getUserByUsername("player");
    assert.equal(disabled, null);
  });
});

test("FilePasswordStore loads object-map format", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "store.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        gm: "scrypt$x$y",
      }),
      "utf8",
    );

    const store = new FilePasswordStore({ filePath });
    const gm = await store.getUserByUsername("gm");
    assert.equal(gm?.passwordHash, "scrypt$x$y");
  });
});

test("FilePasswordStore throws for invalid payload", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "store.json");
    await fs.writeFile(filePath, JSON.stringify({ users: [] }), "utf8");

    const store = new FilePasswordStore({ filePath });
    await assert.rejects(
      () => store.getUserByUsername("gm"),
      /contains no valid users/,
    );
  });
});
