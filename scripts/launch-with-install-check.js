#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { loadInstallationProfile } from "./install-profile-dispatch.js";
import { appendFailureRecord } from "../src/failure-store.js";
import { syncRuntimeEnvFromInstallation } from "../src/installation-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceDir = path.resolve(__dirname, "..");

const DEFAULT_CONFIG_PATH = path.join(workspaceDir, "data", "installation_config.json");
const DOCKER_ENV_PATH = path.join(workspaceDir, "docker", "blastdoor.env");
const DOCKER_ENV_TEMPLATE_PATH = path.join(workspaceDir, "docker", "blastdoor.env.example");
const INSTALLER_EXIT_SIGNAL_PATH = path.join(workspaceDir, "data", ".installer-exit-action");
const FAILURE_STORE_PATH = path.join(workspaceDir, "data", "launch-failures.json");

function line(message = "") {
  process.stdout.write(`${message}\n`);
}

function warn(message) {
  process.stderr.write(`[launch] WARN: ${message}\n`);
}

function normalizeDomain(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return "";
  }
  return raw.replace(/^https?:\/\//, "").split("/")[0]?.split(":")[0]?.trim() || "";
}

function isLikelyDomain(value) {
  const domain = normalizeDomain(value);
  if (!domain) {
    return false;
  }
  if (domain === "localhost") {
    return false;
  }
  if (!domain.includes(".")) {
    return false;
  }
  if (!/^[a-z0-9.-]+$/i.test(domain)) {
    return false;
  }
  if (domain.includes("..")) {
    return false;
  }
  return true;
}

function isLikelyEmail(value) {
  const email = String(value || "").trim();
  if (!email) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isLikelyHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function isPlaceholderSecret(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized.includes("change-this")) {
    return true;
  }
  if (normalized.includes("example")) {
    return true;
  }
  return false;
}

export function validateDockerLaunchEnv(envValues = {}) {
  const issues = [];
  const domain = normalizeDomain(envValues.BLASTDOOR_DOMAIN || "");
  const email = String(envValues.LETSENCRYPT_EMAIL || "").trim();
  const postgresPassword = String(envValues.POSTGRES_PASSWORD || "").trim();
  const sessionSecret = String(envValues.SESSION_SECRET || "").trim();
  const foundryTarget = String(envValues.FOUNDRY_TARGET || "").trim();

  if (!domain) {
    issues.push("BLASTDOOR_DOMAIN is missing.");
  } else if (!isLikelyDomain(domain) || domain === "blastdoor.example.com" || domain.endsWith(".example.com")) {
    issues.push("BLASTDOOR_DOMAIN must be your real public DNS name (not example.com).");
  }

  if (!email) {
    issues.push("LETSENCRYPT_EMAIL is missing.");
  } else if (!isLikelyEmail(email) || email.endsWith("@example.com")) {
    issues.push("LETSENCRYPT_EMAIL must be a valid real email address.");
  }

  if (isPlaceholderSecret(postgresPassword)) {
    issues.push("POSTGRES_PASSWORD is missing or still using a placeholder value.");
  }

  if (isPlaceholderSecret(sessionSecret) || sessionSecret.length < 24) {
    issues.push("SESSION_SECRET must be set to a strong secret (minimum 24 chars).");
  }

  if (!isLikelyHttpUrl(foundryTarget)) {
    issues.push("FOUNDRY_TARGET must be a valid http/https URL reachable from the blastdoor container.");
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

async function parseDockerEnvFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return dotenv.parse(raw);
}

export function normalizeMissingProfileChoice(rawValue) {
  const normalized = String(rawValue || "")
    .trim()
    .toLowerCase();

  if (normalized === "y" || normalized === "yes") {
    return "yes";
  }
  if (normalized === "n" || normalized === "no") {
    return "no";
  }
  if (normalized === "m" || normalized === "maybe") {
    return "maybe";
  }
  return "invalid";
}

function printMissingInstallPrompt() {
  line("No installation profile was found. You must configure your install first before launching.");
  line("Would you like to proceed to install?");
  line("|| [Y]es | [N]o | [M]aybe? I have no idea, can you just do stuff for me? ||");
}

export async function promptMissingProfileChoice({
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const answer = await rl.question("Select Y/N/M: ");
      const choice = normalizeMissingProfileChoice(answer);
      if (choice !== "invalid") {
        return choice;
      }
      output.write("Please enter Y, N, or M.\n");
    }
  } finally {
    rl.close();
  }
}

function spawnWithCapturedOutput(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: workspaceDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.once("error", (error) => {
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr,
        error,
      });
    });

    child.once("close", (code) => {
      resolve({
        ok: code === 0,
        exitCode: typeof code === "number" ? code : null,
        stdout,
        stderr,
        error: null,
      });
    });
  });
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceDir,
      env: { ...process.env },
      stdio: "inherit",
      ...options,
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${command} ${args.join(" ")}) with exit code ${code ?? "null"}.`));
    });
  });
}

export async function collectQuickDiagnostics({
  platform = process.platform,
  env = process.env,
  configPath = DEFAULT_CONFIG_PATH,
  probe = spawnWithCapturedOutput,
} = {}) {
  const [npmVersion, dockerVersion, dockerComposeVersion] = await Promise.all([
    probe("npm", ["--version"]),
    probe("docker", ["--version"]),
    probe("docker", ["compose", "version"]),
  ]);

  const configExists = await fs
    .access(configPath)
    .then(() => true)
    .catch(() => false);

  const isWsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);

  return {
    platform,
    nodeVersion: process.version,
    npmVersion: npmVersion.ok ? npmVersion.stdout.trim() : null,
    dockerVersion: dockerVersion.ok ? dockerVersion.stdout.trim() : null,
    dockerComposeVersion: dockerComposeVersion.ok ? dockerComposeVersion.stdout.trim() : null,
    isWsl,
    wslDistro: env.WSL_DISTRO_NAME || null,
    configPath,
    configExists,
    recommendations: buildDiagnosticRecommendations({
      dockerAvailable: dockerVersion.ok && dockerComposeVersion.ok,
      isWsl,
    }),
  };
}

export function buildDiagnosticRecommendations({ dockerAvailable, isWsl }) {
  const recommendations = [];

  if (!dockerAvailable) {
    recommendations.push("Docker is unavailable. Prefer Basic-Standalone local install mode.");
  } else {
    recommendations.push("Docker is available. Standard-Resilient container install mode is supported.");
  }

  if (isWsl) {
    recommendations.push(
      "WSL detected. If using container mode, ensure Docker Desktop integration is enabled for this distro.",
    );
  }

  recommendations.push(
    "Backlog story: expand the Maybe path with a lightweight guided assistant and deeper automated recommendations.",
  );

  return recommendations;
}

function printDiagnostics(report) {
  line("");
  line("Quick environment diagnostics:");
  line(`- Platform: ${report.platform}${report.isWsl ? " (WSL)" : ""}`);
  line(`- Node.js: ${report.nodeVersion}`);
  line(`- npm: ${report.npmVersion || "not available"}`);
  line(`- Docker: ${report.dockerVersion || "not available"}`);
  line(`- Docker Compose: ${report.dockerComposeVersion || "not available"}`);
  line(`- Installation profile path: ${report.configPath}`);
  line(`- Installation profile exists: ${report.configExists ? "yes" : "no"}`);
  line("");
  line("Recommendations:");
  for (const recommendation of report.recommendations) {
    line(`- ${recommendation}`);
  }
  line("");
}

async function runInstaller({ deferLaunch = false, exitSignalPath = INSTALLER_EXIT_SIGNAL_PATH } = {}) {
  await runCommand(process.execPath, ["scripts/install-gui.js"], {
    env: {
      ...process.env,
      INSTALLER_DEFER_LAUNCH: deferLaunch ? "true" : "false",
      INSTALLER_EXIT_SIGNAL_PATH: exitSignalPath,
    },
  });
}

async function readInstallerExitSignal(signalPath) {
  try {
    const raw = await fs.readFile(signalPath, "utf8");
    const action = String(raw || "")
      .trim()
      .toLowerCase();
    if (action === "close" || action === "launch") {
      return action;
    }
  } catch {
    // no signal or unreadable
  } finally {
    try {
      await fs.rm(signalPath, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }

  return null;
}

async function ensureDockerEnvFile() {
  try {
    await fs.access(DOCKER_ENV_PATH);
    return;
  } catch {
    // continue
  }

  try {
    await fs.copyFile(DOCKER_ENV_TEMPLATE_PATH, DOCKER_ENV_PATH);
  } catch (error) {
    throw new Error(`Failed to initialize ${path.relative(workspaceDir, DOCKER_ENV_PATH)}.`, {
      cause: error,
    });
  }
  warn(`Created ${path.relative(workspaceDir, DOCKER_ENV_PATH)} from template.`);
  throw new Error(
    `Edit ${path.relative(workspaceDir, DOCKER_ENV_PATH)} (domain, secrets, postgres password), then rerun make launch.`,
  );
}

async function ensureContainerLaunchPrerequisites(installationConfig = {}) {
  await ensureDockerEnvFile();
  await syncRuntimeEnvFromInstallation({
    installationConfig,
    envPath: path.join(workspaceDir, ".env"),
    dockerEnvPath: DOCKER_ENV_PATH,
  });
  const envValues = await parseDockerEnvFile(DOCKER_ENV_PATH);
  const validation = validateDockerLaunchEnv(envValues);
  if (validation.ok) {
    return;
  }

  const relativeDockerEnvPath = path.relative(workspaceDir, DOCKER_ENV_PATH);
  throw new Error(
    [
      "Container launch blocked: docker TLS/runtime configuration is incomplete.",
      ...validation.issues.map((issue) => `- ${issue}`),
      `Update ${relativeDockerEnvPath} or run 'make configure' and save container settings, then rerun make launch.`,
    ].join("\n"),
  );
}

async function launchProfile(payload) {
  if (payload.profile === "container") {
    line("Install profile: container");
    await ensureContainerLaunchPrerequisites(payload.config || {});
    await runCommand("docker", ["compose", "up", "-d", "--build"]);
    return;
  }

  line("Install profile: local");
  await runCommand(process.execPath, ["scripts/launch-control.js"]);
}

function isMissingProfileError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /No installation profile found/i.test(message);
}

export async function runLaunchWithInstallCheck({
  configPath = DEFAULT_CONFIG_PATH,
  installerExitSignalPath = INSTALLER_EXIT_SIGNAL_PATH,
  choicePrompt = promptMissingProfileChoice,
  installerRunner = runInstaller,
  diagnosticsCollector = collectQuickDiagnostics,
  profileLoader = loadInstallationProfile,
  profileLauncher = launchProfile,
} = {}) {
  let profilePayload;

  try {
    profilePayload = await profileLoader(configPath);
  } catch (error) {
    if (!isMissingProfileError(error)) {
      throw error;
    }

    printMissingInstallPrompt();
    const choice = await choicePrompt();

    if (choice === "no") {
      line("Launch canceled.");
      return { launched: false, reason: "declined-install" };
    }

    if (choice === "maybe") {
      const diagnostics = await diagnosticsCollector({ configPath });
      printDiagnostics(diagnostics);
    }

    await fs.rm(installerExitSignalPath, { force: true }).catch(() => {});
    await installerRunner({ deferLaunch: true, exitSignalPath: installerExitSignalPath });
    const installerAction = await readInstallerExitSignal(installerExitSignalPath);

    if (installerAction === "close") {
      line("Installer closed without launch request. Launch canceled.");
      return { launched: false, reason: "installer-closed" };
    }

    try {
      profilePayload = await profileLoader(configPath);
    } catch {
      throw new Error(
        "Installer exited without a saved installation profile. Run 'make install' or re-run 'make launch' and complete setup.",
      );
    }
  }

  await profileLauncher(profilePayload);
  return {
    launched: true,
    profile: profilePayload.profile,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const configPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CONFIG_PATH;
  runLaunchWithInstallCheck({ configPath }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await appendFailureRecord(FAILURE_STORE_PATH, {
        source: "launch-wrapper",
        action: "make-launch",
        message,
        details: "Launch wrapper failed before interactive console completed startup.",
        isWsl: Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP),
      });
    } catch {
      // ignore failure recorder errors
    }
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
