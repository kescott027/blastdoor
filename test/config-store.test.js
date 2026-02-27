import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConfigStore } from "../src/config-store.js";
import { createMockPostgresPoolFactory } from "./helpers/mock-postgres.js";

async function withTempDir(callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-config-store-test-"));
  try {
    await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("createConfigStore returns no-op env store", async () => {
  const store = createConfigStore({ configStoreMode: "env" });
  await store.setValue("A", "B");
  assert.equal(await store.getValue("A"), null);
  assert.deepEqual(await store.getAllValues(), {});
  assert.equal(await store.getFile(".env"), null);
  store.close();
});

test("createConfigStore returns sqlite-backed store", async () => {
  await withTempDir(async (tempDir) => {
    const databaseFile = path.join(tempDir, "blastdoor.sqlite");
    const store = createConfigStore({
      configStoreMode: "sqlite",
      databaseFile,
    });

    await store.setValue("FOUNDRY_TARGET", "http://127.0.0.1:30000");
    assert.equal(await store.getValue("FOUNDRY_TARGET"), "http://127.0.0.1:30000");

    await store.putFile(".env", "FOUNDRY_TARGET=http://127.0.0.1:30000\n");
    const envFile = await store.getFile(".env");
    assert.match(envFile?.content || "", /FOUNDRY_TARGET/);
    store.close();
  });
});

test("createConfigStore returns postgres-backed store", async () => {
  const { factory } = createMockPostgresPoolFactory();
  const store = createConfigStore(
    {
      configStoreMode: "postgres",
      postgresUrl: "postgres://blastdoor:test@localhost:5432/blastdoor",
      postgresSsl: false,
    },
    { postgresPoolFactory: factory },
  );

  await store.setValue("FOUNDRY_TARGET", "http://127.0.0.1:30000");
  assert.equal(await store.getValue("FOUNDRY_TARGET"), "http://127.0.0.1:30000");

  await store.putFile(".env", "FOUNDRY_TARGET=http://127.0.0.1:30000\n");
  const envFile = await store.getFile(".env");
  assert.match(envFile?.content || "", /FOUNDRY_TARGET/);
  await store.close();
});

test("postgres config store preserves values across new instances", async () => {
  const { factory, state } = createMockPostgresPoolFactory();
  const storeOne = createConfigStore(
    {
      configStoreMode: "postgres",
      postgresUrl: "postgres://blastdoor:test@localhost:5432/blastdoor",
      postgresSsl: false,
    },
    { postgresPoolFactory: factory },
  );

  await storeOne.setValue("ALLOW_NULL_ORIGIN", "true");
  await storeOne.putFile(".env", "ALLOW_NULL_ORIGIN=true\n");
  await storeOne.close();

  const { factory: secondFactory } = createMockPostgresPoolFactory(state);
  const storeTwo = createConfigStore(
    {
      configStoreMode: "postgres",
      postgresUrl: "postgres://blastdoor:test@localhost:5432/blastdoor",
      postgresSsl: false,
    },
    { postgresPoolFactory: secondFactory },
  );

  assert.equal(await storeTwo.getValue("ALLOW_NULL_ORIGIN"), "true");
  const envFile = await storeTwo.getFile(".env");
  assert.match(envFile?.content || "", /ALLOW_NULL_ORIGIN=true/);
  await storeTwo.close();
});
