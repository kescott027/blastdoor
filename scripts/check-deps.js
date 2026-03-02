#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  return {
    includeDev: argv.includes("--dev"),
  };
}

function readPackageJson(cwd) {
  const packagePath = path.resolve(cwd, "package.json");
  const raw = fs.readFileSync(packagePath, "utf8");
  return JSON.parse(raw);
}

function moduleExists(cwd, moduleName) {
  const modulePath = path.resolve(cwd, "node_modules", moduleName, "package.json");
  return fs.existsSync(modulePath);
}

function findMissingModules(cwd, packageJson, includeDev) {
  const required = {
    ...(packageJson.dependencies || {}),
    ...(includeDev ? packageJson.devDependencies || {} : {}),
  };

  const missing = [];
  for (const moduleName of Object.keys(required)) {
    if (!moduleExists(cwd, moduleName)) {
      missing.push(moduleName);
    }
  }
  return missing.sort((a, b) => a.localeCompare(b));
}

function main() {
  const cwd = process.cwd();
  const options = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(path.resolve(cwd, "node_modules"))) {
    process.stderr.write("node_modules missing\n");
    process.exit(1);
  }

  const pkg = readPackageJson(cwd);
  const missing = findMissingModules(cwd, pkg, options.includeDev);
  if (missing.length > 0) {
    process.stderr.write(`missing modules: ${missing.join(", ")}\n`);
    process.exit(1);
  }

  process.exit(0);
}

main();
