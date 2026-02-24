import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BlastdoorDatabase, BlastdoorPostgresDatabase } from "../src/database-store.js";
import { createMockPostgresPoolFactory } from "./helpers/mock-postgres.js";

async function withTempDir(callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-db-test-"));
  try {
    await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("BlastdoorDatabase stores and updates users", async () => {
  await withTempDir(async (tempDir) => {
    const databaseFile = path.join(tempDir, "blastdoor.sqlite");
    const db = new BlastdoorDatabase({ filePath: databaseFile });

    db.upsertUser({
      username: "gm",
      passwordHash: "scrypt$old$hash",
      totpSecret: "ABCDEF",
      disabled: false,
    });

    const initial = db.getUser("gm");
    assert.equal(initial?.username, "gm");
    assert.equal(initial?.passwordHash, "scrypt$old$hash");
    assert.equal(initial?.totpSecret, "ABCDEF");
    assert.equal(initial?.disabled, false);

    db.upsertUser({
      username: "gm",
      passwordHash: "scrypt$new$hash",
      totpSecret: null,
      disabled: true,
    });

    const updated = db.getUser("gm");
    assert.equal(updated?.passwordHash, "scrypt$new$hash");
    assert.equal(updated?.totpSecret, null);
    assert.equal(updated?.disabled, true);
    db.close();
  });
});

test("BlastdoorDatabase stores config values and file snapshots", async () => {
  await withTempDir(async (tempDir) => {
    const databaseFile = path.join(tempDir, "blastdoor.sqlite");
    const db = new BlastdoorDatabase({ filePath: databaseFile });

    db.setConfigValue("FOUNDRY_TARGET", "http://127.0.0.1:30000");
    db.setConfigValue("COOKIE_SECURE", "false");
    assert.equal(db.getConfigValue("FOUNDRY_TARGET"), "http://127.0.0.1:30000");

    const allConfig = db.getAllConfigValues();
    assert.equal(allConfig.FOUNDRY_TARGET, "http://127.0.0.1:30000");
    assert.equal(allConfig.COOKIE_SECURE, "false");

    db.upsertConfigFile(".env", "FOUNDRY_TARGET=http://127.0.0.1:30000\n");
    const envFile = db.getConfigFile(".env");
    assert.equal(envFile?.fileName, ".env");
    assert.match(envFile?.content || "", /FOUNDRY_TARGET/);

    db.close();
  });
});

test("BlastdoorPostgresDatabase stores and retrieves records", async () => {
  const { factory } = createMockPostgresPoolFactory();
  const db = new BlastdoorPostgresDatabase({
    connectionString: "postgres://blastdoor:test@localhost:5432/blastdoor",
    poolFactory: factory,
  });

  await db.upsertUser({
    username: "gm",
    passwordHash: "scrypt$one$two",
    totpSecret: "AAAAAA",
    disabled: false,
  });
  const user = await db.getUser("gm");
  assert.equal(user?.username, "gm");
  assert.equal(user?.passwordHash, "scrypt$one$two");
  assert.equal(user?.totpSecret, "AAAAAA");

  await db.setConfigValue("FOUNDRY_TARGET", "http://127.0.0.1:30000");
  assert.equal(await db.getConfigValue("FOUNDRY_TARGET"), "http://127.0.0.1:30000");

  await db.upsertConfigFile(".env", "FOUNDRY_TARGET=http://127.0.0.1:30000\n");
  const envFile = await db.getConfigFile(".env");
  assert.match(envFile?.content || "", /FOUNDRY_TARGET/);

  await db.close();
});

test("BlastdoorPostgresDatabase persistence survives new instances", async () => {
  const { factory, state } = createMockPostgresPoolFactory();
  const dbOne = new BlastdoorPostgresDatabase({
    connectionString: "postgres://blastdoor:test@localhost:5432/blastdoor",
    poolFactory: factory,
  });

  await dbOne.upsertUser({
    username: "gm",
    passwordHash: "scrypt$persisted$hash",
    disabled: false,
  });
  await dbOne.setConfigValue("COOKIE_SECURE", "false");
  await dbOne.upsertConfigFile(".env", "COOKIE_SECURE=false\n");
  await dbOne.close();

  const { factory: secondFactory } = createMockPostgresPoolFactory(state);
  const dbTwo = new BlastdoorPostgresDatabase({
    connectionString: "postgres://blastdoor:test@localhost:5432/blastdoor",
    poolFactory: secondFactory,
  });

  const user = await dbTwo.getUser("gm");
  assert.equal(user?.passwordHash, "scrypt$persisted$hash");
  assert.equal(await dbTwo.getConfigValue("COOKIE_SECURE"), "false");
  const envFile = await dbTwo.getConfigFile(".env");
  assert.match(envFile?.content || "", /COOKIE_SECURE=false/);
  await dbTwo.close();
});
