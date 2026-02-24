import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EnvPasswordStore,
  FilePasswordStore,
  PostgresPasswordStore,
  SqlitePasswordStore,
  createPasswordStore,
} from "../src/password-store.js";
import { createMockPostgresPoolFactory } from "./helpers/mock-postgres.js";

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

test("SqlitePasswordStore loads active users and ignores disabled users", async () => {
  await withTempDir(async (tempDir) => {
    const databaseFile = path.join(tempDir, "blastdoor.sqlite");
    const store = new SqlitePasswordStore({ databaseFile });
    store.database.upsertUser({
      username: "gm",
      passwordHash: "scrypt$a$b",
      totpSecret: "abc123",
      disabled: false,
    });
    store.database.upsertUser({
      username: "player",
      passwordHash: "scrypt$c$d",
      disabled: true,
    });

    const gm = await store.getUserByUsername("gm");
    assert.equal(gm?.username, "gm");
    assert.equal(gm?.passwordHash, "scrypt$a$b");
    assert.equal(gm?.totpSecret, "abc123");

    const disabled = await store.getUserByUsername("player");
    assert.equal(disabled, null);

    store.close();
  });
});

test("createPasswordStore selects sqlite backend", async () => {
  await withTempDir(async (tempDir) => {
    const databaseFile = path.join(tempDir, "blastdoor.sqlite");
    const store = createPasswordStore({
      passwordStoreMode: "sqlite",
      databaseFile,
    });

    assert.ok(store instanceof SqlitePasswordStore);
    store.database.upsertUser({
      username: "gm",
      passwordHash: "scrypt$a$b",
      disabled: false,
    });

    const gm = await store.getUserByUsername("gm");
    assert.equal(gm?.passwordHash, "scrypt$a$b");
    store.close();
  });
});

test("PostgresPasswordStore loads active users and ignores disabled users", async () => {
  const { factory } = createMockPostgresPoolFactory();
  const store = new PostgresPasswordStore({
    postgresUrl: "postgres://blastdoor:test@localhost:5432/blastdoor",
    poolFactory: factory,
  });
  await store.database.upsertUser({
    username: "gm",
    passwordHash: "scrypt$pg$hash",
    disabled: false,
  });
  await store.database.upsertUser({
    username: "blocked",
    passwordHash: "scrypt$blocked$hash",
    disabled: true,
  });

  const gm = await store.getUserByUsername("gm");
  assert.equal(gm?.passwordHash, "scrypt$pg$hash");

  const blocked = await store.getUserByUsername("blocked");
  assert.equal(blocked, null);
  await store.close();
});

test("createPasswordStore selects postgres backend", async () => {
  const { factory } = createMockPostgresPoolFactory();
  const store = createPasswordStore(
    {
      passwordStoreMode: "postgres",
      postgresUrl: "postgres://blastdoor:test@localhost:5432/blastdoor",
      postgresSsl: false,
    },
    { postgresPoolFactory: factory },
  );

  assert.ok(store instanceof PostgresPasswordStore);
  await store.database.upsertUser({
    username: "gm",
    passwordHash: "scrypt$pg$store",
    disabled: false,
  });

  const gm = await store.getUserByUsername("gm");
  assert.equal(gm?.passwordHash, "scrypt$pg$store");
  await store.close();
});
