import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  deriveLocalRuntimeTargets,
  loadInstallationProfile,
  normalizeInstallType,
} from "../scripts/install-profile-dispatch.js";

const execFileAsync = promisify(execFile);

async function withTempDir(callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-install-dispatch-test-"));
  try {
    await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("normalizeInstallType supports local and container with sane fallback", () => {
  assert.equal(normalizeInstallType("local"), "local");
  assert.equal(normalizeInstallType("container"), "container");
  assert.equal(normalizeInstallType("CONTAINER"), "container");
  assert.equal(normalizeInstallType("unknown"), "local");
});

test("deriveLocalRuntimeTargets normalizes host and ports", () => {
  const resolved = deriveLocalRuntimeTargets({
    gatewayPort: "8181",
    managerHost: "",
    managerPort: "99999",
  });

  assert.equal(resolved.gatewayPort, 8181);
  assert.equal(resolved.managerHost, "127.0.0.1");
  assert.equal(resolved.managerPort, 8090);
});

test("loadInstallationProfile reads config and resolves profile + runtime", async () => {
  await withTempDir(async (workspaceDir) => {
    const configPath = path.join(workspaceDir, "data", "installation_config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          installType: "container",
          gatewayPort: 8123,
          managerHost: "10.0.0.5",
          managerPort: 8199,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const payload = await loadInstallationProfile(configPath);
    assert.equal(payload.profile, "container");
    assert.equal(payload.localRuntime.gatewayPort, 8123);
    assert.equal(payload.localRuntime.managerHost, "10.0.0.5");
    assert.equal(payload.localRuntime.managerPort, 8199);
  });
});

test("loadInstallationProfile throws when profile file is missing", async () => {
  await withTempDir(async (workspaceDir) => {
    const configPath = path.join(workspaceDir, "data", "installation_config.json");
    await assert.rejects(async () => loadInstallationProfile(configPath), /No installation profile found/);
  });
});

test("dispatch CLI returns profile and runtime fields", async () => {
  await withTempDir(async (workspaceDir) => {
    const configPath = path.join(workspaceDir, "data", "installation_config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          installType: "container",
          gatewayPort: 8999,
          managerHost: "192.168.1.50",
          managerPort: 8191,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const profile = await execFileAsync(process.execPath, [
      "scripts/install-profile-dispatch.js",
      "profile",
      configPath,
    ]);
    assert.equal(profile.stdout.trim(), "container");

    const managerHost = await execFileAsync(process.execPath, [
      "scripts/install-profile-dispatch.js",
      "manager-host",
      configPath,
    ]);
    assert.equal(managerHost.stdout.trim(), "192.168.1.50");

    const managerPort = await execFileAsync(process.execPath, [
      "scripts/install-profile-dispatch.js",
      "manager-port",
      configPath,
    ]);
    assert.equal(managerPort.stdout.trim(), "8191");

    const gatewayPort = await execFileAsync(process.execPath, [
      "scripts/install-profile-dispatch.js",
      "gateway-port",
      configPath,
    ]);
    assert.equal(gatewayPort.stdout.trim(), "8999");
  });
});
