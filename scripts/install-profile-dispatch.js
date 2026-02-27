#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultInstallationConfig, readInstallationConfig } from "../src/installation-config.js";

const DEFAULT_INSTALL_CONFIG_PATH = "data/installation_config.json";

function normalizeHost(value, fallback) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizePort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

export function normalizeInstallType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "container") {
    return "container";
  }
  return "local";
}

export function deriveLocalRuntimeTargets(config = {}) {
  return {
    gatewayPort: normalizePort(config.gatewayPort, 8080),
    managerHost: normalizeHost(config.managerHost, "127.0.0.1"),
    managerPort: normalizePort(config.managerPort, 8090),
  };
}

export async function loadInstallationProfile(configPath = DEFAULT_INSTALL_CONFIG_PATH) {
  const absolutePath = path.resolve(configPath);
  const loaded = await readInstallationConfig(absolutePath);
  if (!loaded) {
    throw new Error(`No installation profile found at ${absolutePath}. Run 'make install' first.`);
  }

  const config = {
    ...defaultInstallationConfig(),
    ...loaded,
  };

  return {
    config,
    profile: normalizeInstallType(config.installType),
    localRuntime: deriveLocalRuntimeTargets(config),
    configPath: absolutePath,
  };
}

function printUsage() {
  process.stderr.write(
    [
      "Usage: node scripts/install-profile-dispatch.js <action> [configPath]",
      "Actions:",
      "  profile         Print install profile: local|container",
      "  manager-host    Print manager host",
      "  manager-port    Print manager port",
      "  gateway-port    Print gateway port",
      "  dump            Print resolved profile payload as JSON",
      "",
    ].join("\n"),
  );
}

async function main() {
  const action = String(process.argv[2] || "profile").trim().toLowerCase();
  const configPathArg = process.argv[3] || DEFAULT_INSTALL_CONFIG_PATH;
  const payload = await loadInstallationProfile(configPathArg);

  if (action === "profile") {
    process.stdout.write(payload.profile);
    return;
  }

  if (action === "manager-host") {
    process.stdout.write(payload.localRuntime.managerHost);
    return;
  }

  if (action === "manager-port") {
    process.stdout.write(String(payload.localRuntime.managerPort));
    return;
  }

  if (action === "gateway-port") {
    process.stdout.write(String(payload.localRuntime.gatewayPort));
    return;
  }

  if (action === "dump") {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  printUsage();
  throw new Error(`Unknown action '${action}'.`);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exit(1);
  });
}
