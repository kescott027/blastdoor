import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import {
  buildFoundryTarget,
  defaultInstallationConfig,
  normalizeInstallationConfig,
  syncRuntimeEnvFromInstallation,
} from "../src/installation-config.js";

async function withTempDir(callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-install-config-test-"));
  try {
    await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("normalizeInstallationConfig enforces required external Foundry host", () => {
  assert.throws(
    () =>
      normalizeInstallationConfig({
        foundryMode: "external",
        foundryExternalIp: "",
      }),
    /requires foundryExternalIp/i,
  );
});

test("normalizeInstallationConfig enforces external API URL when enabled", () => {
  assert.throws(
    () =>
      normalizeInstallationConfig({
        useExternalBlastdoorApi: true,
        blastdoorApiUrl: "",
      }),
    /requires blastdoorApiUrl/i,
  );
});

test("buildFoundryTarget resolves local and external endpoints", () => {
  const local = buildFoundryTarget(
    normalizeInstallationConfig({
      foundryMode: "local",
      foundryLocalHost: "127.0.0.1",
      foundryLocalPort: 30000,
    }),
  );
  assert.equal(local, "http://127.0.0.1:30000");

  const external = buildFoundryTarget(
    normalizeInstallationConfig({
      foundryMode: "external",
      foundryExternalIp: "203.0.113.10",
      foundryExternalPort: 34444,
    }),
  );
  assert.equal(external, "http://203.0.113.10:34444");
});

test("syncRuntimeEnvFromInstallation writes profile-aligned local and docker env files", async () => {
  await withTempDir(async (workspace) => {
    const envPath = path.join(workspace, ".env");
    const dockerEnvPath = path.join(workspace, "docker", "blastdoor.env");

    const installationConfig = normalizeInstallationConfig(
      {
        ...defaultInstallationConfig(),
        installType: "container",
        database: "postgres",
        objectStorage: "s3",
        foundryMode: "local",
        foundryLocalHost: "127.0.0.1",
        foundryLocalPort: 30000,
        gatewayHost: "0.0.0.0",
        gatewayPort: 8080,
        managerHost: "127.0.0.1",
        managerPort: 8090,
        apiHost: "0.0.0.0",
        apiPort: 8070,
      },
      null,
    );

    await syncRuntimeEnvFromInstallation({
      installationConfig,
      envPath,
      dockerEnvPath,
    });

    const localEnv = dotenv.parse(await fs.readFile(envPath, "utf8"));
    const dockerEnv = dotenv.parse(await fs.readFile(dockerEnvPath, "utf8"));

    assert.equal(localEnv.INSTALL_PROFILE, "container");
    assert.equal(localEnv.OBJECT_STORAGE_MODE, "s3");
    assert.equal(localEnv.PASSWORD_STORE_MODE, "postgres");
    assert.equal(localEnv.CONFIG_STORE_MODE, "postgres");
    assert.equal(localEnv.FOUNDRY_TARGET, "http://127.0.0.1:30000");

    assert.equal(dockerEnv.INSTALL_PROFILE, "container");
    assert.equal(dockerEnv.OBJECT_STORAGE_MODE, "s3");
    assert.equal(dockerEnv.PASSWORD_STORE_MODE, "postgres");
    assert.equal(dockerEnv.CONFIG_STORE_MODE, "postgres");
    assert.equal(dockerEnv.FOUNDRY_TARGET, "http://host.docker.internal:30000");

    assert.ok(localEnv.SESSION_SECRET);
    assert.ok(dockerEnv.SESSION_SECRET);
  });
});
