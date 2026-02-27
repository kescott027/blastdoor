import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildDiagnosticRecommendations,
  collectQuickDiagnostics,
  normalizeMissingProfileChoice,
  runLaunchWithInstallCheck,
} from "../scripts/launch-with-install-check.js";

test("normalizeMissingProfileChoice maps valid values", () => {
  assert.equal(normalizeMissingProfileChoice("Y"), "yes");
  assert.equal(normalizeMissingProfileChoice(" no "), "no");
  assert.equal(normalizeMissingProfileChoice("maybe"), "maybe");
  assert.equal(normalizeMissingProfileChoice("unknown"), "invalid");
});

test("buildDiagnosticRecommendations adapts to environment", () => {
  const withDocker = buildDiagnosticRecommendations({
    dockerAvailable: true,
    isWsl: false,
  });
  assert.match(withDocker.join("\n"), /Docker is available/i);

  const withoutDockerOnWsl = buildDiagnosticRecommendations({
    dockerAvailable: false,
    isWsl: true,
  });
  assert.match(withoutDockerOnWsl.join("\n"), /Docker is unavailable/i);
  assert.match(withoutDockerOnWsl.join("\n"), /WSL detected/i);
});

test("collectQuickDiagnostics uses command probes and returns summary", async () => {
  const probe = async (command, args) => {
    if (command === "npm") {
      return { ok: true, stdout: "11.11.0\n", stderr: "", exitCode: 0, error: null };
    }
    if (command === "docker" && args[0] === "--version") {
      return { ok: true, stdout: "Docker version 28\n", stderr: "", exitCode: 0, error: null };
    }
    return { ok: false, stdout: "", stderr: "missing", exitCode: 1, error: new Error("missing") };
  };

  const report = await collectQuickDiagnostics({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
    configPath: "/tmp/not-real-config.json",
    probe,
  });

  assert.equal(report.platform, "linux");
  assert.equal(report.isWsl, true);
  assert.equal(report.npmVersion, "11.11.0");
  assert.equal(report.dockerVersion, "Docker version 28");
  assert.equal(report.dockerComposeVersion, null);
  assert.equal(Array.isArray(report.recommendations), true);
});

test("runLaunchWithInstallCheck exits when install is declined", async () => {
  let installerCalls = 0;
  let launcherCalls = 0;
  const result = await runLaunchWithInstallCheck({
    configPath: "/tmp/never-used.json",
    choicePrompt: async () => "no",
    installerRunner: async () => {
      installerCalls += 1;
    },
    diagnosticsCollector: async () => ({}),
    async profileLoader() {
      throw new Error("No installation profile found at /tmp/never-used.json");
    },
    profileLauncher: async () => {
      launcherCalls += 1;
    },
  });

  assert.deepEqual(result, { launched: false, reason: "declined-install" });
  assert.equal(installerCalls, 0);
  assert.equal(launcherCalls, 0);
});

test("runLaunchWithInstallCheck runs diagnostics + installer + launch for maybe flow", async () => {
  let profileCalls = 0;
  let diagnosticsCalls = 0;
  let installerCalls = 0;
  let launcherPayload = null;

  const result = await runLaunchWithInstallCheck({
    configPath: "/tmp/never-used.json",
    choicePrompt: async () => "maybe",
    installerRunner: async () => {
      installerCalls += 1;
    },
    diagnosticsCollector: async () => {
      diagnosticsCalls += 1;
      return {
        platform: "linux",
        nodeVersion: process.version,
        npmVersion: "11.11.0",
        dockerVersion: null,
        dockerComposeVersion: null,
        isWsl: false,
        configPath: "/tmp/never-used.json",
        configExists: false,
        recommendations: ["test"],
      };
    },
    async profileLoader() {
      profileCalls += 1;
      if (profileCalls === 1) {
        throw new Error("No installation profile found at /tmp/never-used.json");
      }
      return {
        profile: "local",
      };
    },
    profileLauncher: async (payload) => {
      launcherPayload = payload;
    },
  });

  assert.equal(diagnosticsCalls, 1);
  assert.equal(installerCalls, 1);
  assert.equal(profileCalls, 2);
  assert.deepEqual(launcherPayload, { profile: "local" });
  assert.deepEqual(result, { launched: true, profile: "local" });
});

test("runLaunchWithInstallCheck throws when installer exits without profile", async () => {
  await assert.rejects(
    async () =>
      runLaunchWithInstallCheck({
        configPath: "/tmp/never-used.json",
        choicePrompt: async () => "yes",
        installerRunner: async () => {},
        diagnosticsCollector: async () => ({}),
        async profileLoader() {
          throw new Error("No installation profile found at /tmp/never-used.json");
        },
        profileLauncher: async () => {},
      }),
    /Installer exited without a saved installation profile/i,
  );
});

test("runLaunchWithInstallCheck honors installer close action signal", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blastdoor-launch-flow-test-"));
  const signalPath = path.join(tempDir, ".installer-exit-action");
  let profileCalls = 0;
  let launched = false;

  try {
    const result = await runLaunchWithInstallCheck({
      configPath: "/tmp/never-used.json",
      installerExitSignalPath: signalPath,
      choicePrompt: async () => "yes",
      installerRunner: async () => {
        await fs.writeFile(signalPath, "close\n", "utf8");
      },
      diagnosticsCollector: async () => ({}),
      async profileLoader() {
        profileCalls += 1;
        if (profileCalls === 1) {
          throw new Error("No installation profile found at /tmp/never-used.json");
        }
        return { profile: "local" };
      },
      profileLauncher: async () => {
        launched = true;
      },
    });

    assert.deepEqual(result, { launched: false, reason: "installer-closed" });
    assert.equal(launched, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
