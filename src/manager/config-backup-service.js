import fs from "node:fs/promises";
import path from "node:path";

export function createConfigBackupService(options = {}) {
  const {
    managedConfigFiles = [],
    configBackupDir,
    configBackupIdPattern,
    configBackupViewMaxBytes,
    validateConfigBackupId,
    normalizeString,
    normalizeConfigBackupName,
    createConfigBackupId,
    readEnvConfig,
    envPath,
    parseBooleanLike,
    writeBlastDoorsState,
    runtimeStatePath,
    processState,
    defaultInstallationConfig,
    detectPlatformType,
    normalizeInstallationConfig,
    writeInstallationConfig,
    syncRuntimeEnvFromInstallation,
    installationConfigPath,
    dockerEnvPath,
    scrubConfigForClient,
  } = options;

  function getConfigFileSpecs() {
    return managedConfigFiles.map((entry) => {
      const relativePath = normalizeString(entry.relativePath, "").replaceAll("\\", "/");
      if (!relativePath || relativePath.startsWith("..")) {
        throw new Error(`Invalid managed config file path '${entry.relativePath}'.`);
      }
      return {
        ...entry,
        relativePath,
      };
    });
  }

  function resolveBackupPath(backupId) {
    const validatedId = validateConfigBackupId(backupId);
    const resolvedRoot = path.resolve(configBackupDir);
    const resolvedPath = path.resolve(resolvedRoot, validatedId);
    if (!(resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`))) {
      throw new Error("Invalid backup path.");
    }
    return resolvedPath;
  }

  async function readBackupManifest(backupId) {
    const backupPath = resolveBackupPath(backupId);
    const manifestPath = path.join(backupPath, "manifest.json");
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    return {
      backupPath,
      manifest,
    };
  }

  async function listBackups() {
    try {
      const entries = await fs.readdir(configBackupDir, { withFileTypes: true });
      const backups = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (!configBackupIdPattern.test(entry.name)) {
          continue;
        }

        const backupPath = path.join(configBackupDir, entry.name);
        const manifestPath = path.join(backupPath, "manifest.json");
        let manifest = null;
        try {
          manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        } catch {
          const stat = await fs.stat(backupPath);
          manifest = {
            backupId: entry.name,
            name: entry.name,
            createdAt: stat.mtime.toISOString(),
            files: [],
          };
        }

        backups.push({
          backupId: String(manifest.backupId || entry.name),
          name: String(manifest.name || entry.name),
          createdAt: String(manifest.createdAt || ""),
          fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
          files: Array.isArray(manifest.files) ? manifest.files : [],
        });
      }

      backups.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return backups;
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async function createBackup(backupName = "") {
    const normalizedName = normalizeConfigBackupName(backupName, "config");
    const backupId = createConfigBackupId(normalizedName);
    const backupPath = resolveBackupPath(backupId);
    const files = [];
    const fileSpecs = getConfigFileSpecs();

    await fs.mkdir(backupPath, { recursive: true });
    for (const spec of fileSpecs) {
      const destination = path.join(backupPath, spec.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      try {
        const stat = await fs.stat(spec.absolutePath);
        await fs.copyFile(spec.absolutePath, destination);
        files.push({
          id: spec.id,
          relativePath: spec.relativePath,
          exists: true,
          sizeBytes: stat.size,
        });
      } catch (error) {
        if (error && error.code === "ENOENT") {
          files.push({
            id: spec.id,
            relativePath: spec.relativePath,
            exists: false,
            sizeBytes: 0,
          });
          continue;
        }
        throw error;
      }
    }

    const manifest = {
      backupId,
      name: normalizedName,
      createdAt: new Date().toISOString(),
      files,
    };
    await fs.writeFile(path.join(backupPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  async function viewBackup(backupId) {
    const { backupPath, manifest } = await readBackupManifest(backupId);
    const files = [];
    const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
    for (const file of manifestFiles) {
      const relativePath = normalizeString(file.relativePath, "").replaceAll("\\", "/");
      if (!relativePath || relativePath.startsWith("..")) {
        continue;
      }
      const source = path.join(backupPath, relativePath);
      try {
        const stat = await fs.stat(source);
        if (stat.size > configBackupViewMaxBytes) {
          files.push({
            relativePath,
            exists: true,
            sizeBytes: stat.size,
            content: "[file too large to render in browser view]",
          });
          continue;
        }
        files.push({
          relativePath,
          exists: true,
          sizeBytes: stat.size,
          content: await fs.readFile(source, "utf8"),
        });
      } catch (error) {
        if (error && error.code === "ENOENT") {
          files.push({
            relativePath,
            exists: false,
            sizeBytes: 0,
            content: "",
          });
          continue;
        }
        throw error;
      }
    }

    return {
      backup: {
        backupId: String(manifest.backupId || backupId),
        name: String(manifest.name || backupId),
        createdAt: String(manifest.createdAt || ""),
        files: manifestFiles,
      },
      files,
    };
  }

  async function restoreBackup(backupId) {
    const { backupPath, manifest } = await readBackupManifest(backupId);
    const fileSpecs = getConfigFileSpecs();
    const restored = [];
    const skipped = [];
    for (const spec of fileSpecs) {
      const source = path.join(backupPath, spec.relativePath);
      try {
        await fs.access(source);
      } catch (error) {
        if (error && error.code === "ENOENT") {
          skipped.push(spec.relativePath);
          continue;
        }
        throw error;
      }

      await fs.mkdir(path.dirname(spec.absolutePath), { recursive: true });
      await fs.copyFile(source, spec.absolutePath);
      restored.push(spec.relativePath);
    }

    const restoredConfig = await readEnvConfig(envPath);
    const blastDoorsClosed = parseBooleanLike(restoredConfig.BLAST_DOORS_CLOSED, false);
    await writeBlastDoorsState(runtimeStatePath, blastDoorsClosed);

    let serviceRestarted = false;
    if (processState.getStatus().running) {
      await processState.stop();
      await processState.start();
      serviceRestarted = true;
    }

    return {
      backupId: String(manifest.backupId || backupId),
      restored,
      skipped,
      serviceRestarted,
    };
  }

  async function deleteBackup(backupId) {
    const backupPath = resolveBackupPath(backupId);
    await fs.rm(backupPath, { recursive: true, force: true });
    return { backupId };
  }

  async function cleanInstall() {
    const baseInstallation = normalizeInstallationConfig(
      defaultInstallationConfig({
        platform: detectPlatformType(),
        installType: "local",
      }),
      null,
    );

    await fs.rm(envPath, { force: true });
    await fs.rm(dockerEnvPath, { force: true });
    await writeInstallationConfig(installationConfigPath, baseInstallation);
    await syncRuntimeEnvFromInstallation({
      installationConfig: baseInstallation,
      envPath,
      dockerEnvPath,
    });

    await writeBlastDoorsState(runtimeStatePath, false);
    let serviceRestarted = false;
    if (processState.getStatus().running) {
      await processState.stop();
      await processState.start();
      serviceRestarted = true;
    }

    return {
      installationConfigPath,
      envPath,
      dockerEnvPath,
      serviceRestarted,
      config: scrubConfigForClient(await readEnvConfig(envPath)),
      installationConfig: baseInstallation,
    };
  }

  return {
    listBackups,
    createBackup,
    viewBackup,
    restoreBackup,
    deleteBackup,
    cleanInstall,
  };
}
