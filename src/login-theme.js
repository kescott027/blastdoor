import fs from "node:fs/promises";
import path from "node:path";

const IMAGE_FILE_REGEX = /\.(?:png|jpe?g|webp|gif|svg)$/i;
const ASSET_TYPES = new Set(["logo", "background"]);
const DEFAULT_THEME_ID = "blastdoor-default";

function normalizePathLike(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim().replaceAll("\\", "/").replace(/^\/+/, "");
}

function encodePathSegments(relativePath) {
  return relativePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function buildThemeAssetUrl(relativePath) {
  const normalized = normalizePathLike(relativePath);
  if (!normalized) {
    return "";
  }

  return `/graphics/${encodePathSegments(normalized)}`;
}

export function normalizeThemeAssetPath(value, type) {
  const normalized = normalizePathLike(value);
  if (!normalized) {
    return "";
  }

  if (normalized.includes("..")) {
    return "";
  }

  if (!ASSET_TYPES.has(type)) {
    return "";
  }

  const prefix = `${type}/`;
  if (!normalized.startsWith(prefix)) {
    return "";
  }

  if (!IMAGE_FILE_REGEX.test(normalized)) {
    return "";
  }

  return normalized;
}

function sanitizeThemeId(value) {
  const raw = normalizePathLike(value).toLowerCase();
  const collapsed = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return collapsed || "";
}

function normalizeThemeName(value, fallback = "Untitled Theme") {
  const raw = String(value || "").trim();
  return raw || fallback;
}

function normalizeTimestamp(value) {
  const raw = String(value || "").trim();
  return raw || new Date().toISOString();
}

function normalizeThemeDefinition(value, index) {
  const source = value && typeof value === "object" ? value : {};
  const id = sanitizeThemeId(source.id) || `theme-${index + 1}`;

  return {
    id,
    name: normalizeThemeName(source.name, `Theme ${index + 1}`),
    logoPath: normalizeThemeAssetPath(source.logoPath, "logo"),
    closedBackgroundPath: normalizeThemeAssetPath(source.closedBackgroundPath, "background"),
    openBackgroundPath: normalizeThemeAssetPath(source.openBackgroundPath, "background"),
    createdAt: normalizeTimestamp(source.createdAt),
    updatedAt: normalizeTimestamp(source.updatedAt),
  };
}

function dedupeThemes(themes) {
  const usedIds = new Set();
  const output = [];
  for (const theme of themes) {
    if (!theme.id || usedIds.has(theme.id)) {
      continue;
    }
    usedIds.add(theme.id);
    output.push(theme);
  }
  return output;
}

function createDefaultTheme() {
  const now = new Date().toISOString();
  return {
    id: DEFAULT_THEME_ID,
    name: DEFAULT_THEME_ID,
    logoPath: "",
    closedBackgroundPath: "",
    openBackgroundPath: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeThemeStorePayload(value) {
  const source = value && typeof value === "object" ? value : {};
  const rawThemes = Array.isArray(source.themes) ? source.themes : [];
  const themes = dedupeThemes(rawThemes.map((theme, index) => normalizeThemeDefinition(theme, index)));
  if (!themes.some((theme) => theme.id === DEFAULT_THEME_ID)) {
    themes.unshift(createDefaultTheme());
  }

  const activeThemeId = sanitizeThemeId(source.activeThemeId);
  const activeExists = themes.some((theme) => theme.id === activeThemeId);

  return {
    activeThemeId: activeExists ? activeThemeId : DEFAULT_THEME_ID,
    themes,
  };
}

export async function readThemeStore(themeStorePath) {
  try {
    const raw = await fs.readFile(themeStorePath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeThemeStorePayload(parsed);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.name === "SyntaxError")) {
      return normalizeThemeStorePayload({});
    }

    throw new Error(`Failed to read theme store ${themeStorePath}: ${error.message}`, { cause: error });
  }
}

export async function writeThemeStore(themeStorePath, store) {
  const normalized = normalizeThemeStorePayload(store);
  await fs.mkdir(path.dirname(themeStorePath), { recursive: true });
  await fs.writeFile(themeStorePath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  return normalized;
}

export function resolveActiveTheme(store) {
  const normalized = normalizeThemeStorePayload(store);
  return normalized.themes.find((theme) => theme.id === normalized.activeThemeId) || null;
}

function sanitizeThemeCollection(themes) {
  return themes.map((theme, index) => normalizeThemeDefinition(theme, index));
}

export function createThemeId(name, existingIds = new Set()) {
  const preferred = sanitizeThemeId(name) || "theme";
  if (!existingIds.has(preferred)) {
    return preferred;
  }

  let suffix = 2;
  while (existingIds.has(`${preferred}-${suffix}`)) {
    suffix += 1;
  }

  return `${preferred}-${suffix}`;
}

export function mapThemeForClient(theme) {
  const normalized = sanitizeThemeCollection([theme])[0];
  return {
    ...normalized,
    logoUrl: buildThemeAssetUrl(normalized.logoPath),
    closedBackgroundUrl: buildThemeAssetUrl(normalized.closedBackgroundPath),
    openBackgroundUrl: buildThemeAssetUrl(normalized.openBackgroundPath),
  };
}

async function listImageAssetsInDir(directoryPath, typePrefix) {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const assets = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      if (!IMAGE_FILE_REGEX.test(entry.name)) {
        continue;
      }

      const relativePath = `${typePrefix}/${entry.name}`;
      assets.push({
        path: relativePath,
        name: entry.name,
        url: buildThemeAssetUrl(relativePath),
      });
    }
    assets.sort((a, b) => a.name.localeCompare(b.name));
    return assets;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }

    throw new Error(`Failed to list theme assets in ${directoryPath}: ${error.message}`, { cause: error });
  }
}

export async function listThemeAssets(graphicsDir) {
  const logoDir = path.join(graphicsDir, "logo");
  const backgroundDir = path.join(graphicsDir, "background");

  const [logos, backgrounds] = await Promise.all([
    listImageAssetsInDir(logoDir, "logo"),
    listImageAssetsInDir(backgroundDir, "background"),
  ]);

  return { logos, backgrounds };
}
