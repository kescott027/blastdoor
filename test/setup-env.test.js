import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDockerPostgresRunCommand,
  formatPostgresSetupError,
  normalizeDbBackendChoice,
  normalizePostgresInstallChoice,
  normalizePostgresRecoveryChoice,
} from "../scripts/setup-env.js";

test("normalizeDbBackendChoice accepts A/B shortcuts", () => {
  assert.equal(normalizeDbBackendChoice("A"), "sqlite");
  assert.equal(normalizeDbBackendChoice("b"), "postgres");
  assert.equal(normalizeDbBackendChoice("none"), "none");
  assert.equal(normalizeDbBackendChoice("unexpected", "sqlite"), "sqlite");
});

test("normalizePostgresRecoveryChoice maps supported values", () => {
  assert.equal(normalizePostgresRecoveryChoice("1"), "1");
  assert.equal(normalizePostgresRecoveryChoice("url"), "1");
  assert.equal(normalizePostgresRecoveryChoice("2"), "2");
  assert.equal(normalizePostgresRecoveryChoice("install"), "2");
  assert.equal(normalizePostgresRecoveryChoice("other", "1"), "1");
});

test("normalizePostgresInstallChoice maps supported values", () => {
  assert.equal(normalizePostgresInstallChoice("1"), "1");
  assert.equal(normalizePostgresInstallChoice("docker"), "1");
  assert.equal(normalizePostgresInstallChoice("2"), "2");
  assert.equal(normalizePostgresInstallChoice("local"), "2");
  assert.equal(normalizePostgresInstallChoice("other", "2"), "2");
});

test("formatPostgresSetupError includes actionable ECONNREFUSED guidance", () => {
  const error = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
    code: "ECONNREFUSED",
  });
  const message = formatPostgresSetupError(error, "postgres://blastdoor:blastdoor@127.0.0.1:5432/blastdoor");
  assert.match(message, /Unable to connect to PostgreSQL/);
  assert.match(message, /ECONNREFUSED/);
  assert.match(message, /verify host\/port\/database\/user/);
});

test("buildDockerPostgresRunCommand configures persistent storage", () => {
  const command = buildDockerPostgresRunCommand();
  assert.match(command, /--restart unless-stopped/);
  assert.match(command, /-v blastdoor-postgres-data:\/var\/lib\/postgresql\/data/);
  assert.match(command, /--name blastdoor-postgres/);
});
