import fs from "node:fs/promises";
import path from "node:path";

const IMAGE_FILE_REGEX = /\.(?:png|jpe?g|webp|gif|svg)$/i;
const ASSET_TYPES = new Set(["logo", "background"]);
const DEFAULT_THEME_ID = "blastdoor-default";
const THEME_LAYOUT_DEFAULTS = {
  loginBoxWidthPercent: 100,
  loginBoxHeightPercent: 100,
  loginBoxPosXPercent: 50,
  loginBoxPosYPercent: 50,
  loginBoxOpacityPercent: 100,
  loginBoxHoverOpacityPercent: 100,
  logoSizePercent: 30,
  logoOffsetXPercent: 2,
  logoOffsetYPercent: 2,
  backgroundZoomPercent: 100,
  loginBoxMode: "dark",
};

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function clampNumeric(value, fallback, min, max) {
  const raw = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(raw)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, raw));
}

export function normalizeThemeLayoutSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const rawMode = String(source.loginBoxMode || "").trim().toLowerCase();
  const loginBoxMode = rawMode === "light" ? "light" : THEME_LAYOUT_DEFAULTS.loginBoxMode;
  return {
    loginBoxWidthPercent: clampNumeric(
      source.loginBoxWidthPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxWidthPercent,
      20,
      100,
    ),
    loginBoxHeightPercent: clampNumeric(
      source.loginBoxHeightPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxHeightPercent,
      20,
      100,
    ),
    loginBoxPosXPercent: clampNumeric(
      source.loginBoxPosXPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxPosXPercent,
      0,
      100,
    ),
    loginBoxPosYPercent: clampNumeric(
      source.loginBoxPosYPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxPosYPercent,
      0,
      100,
    ),
    loginBoxOpacityPercent: clampNumeric(
      source.loginBoxOpacityPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxOpacityPercent,
      10,
      100,
    ),
    loginBoxHoverOpacityPercent: clampNumeric(
      source.loginBoxHoverOpacityPercent,
      THEME_LAYOUT_DEFAULTS.loginBoxHoverOpacityPercent,
      10,
      100,
    ),
    logoSizePercent: clampNumeric(source.logoSizePercent, THEME_LAYOUT_DEFAULTS.logoSizePercent, 30, 100),
    logoOffsetXPercent: clampNumeric(source.logoOffsetXPercent, THEME_LAYOUT_DEFAULTS.logoOffsetXPercent, 0, 100),
    logoOffsetYPercent: clampNumeric(source.logoOffsetYPercent, THEME_LAYOUT_DEFAULTS.logoOffsetYPercent, 0, 100),
    backgroundZoomPercent: clampNumeric(
      source.backgroundZoomPercent,
      THEME_LAYOUT_DEFAULTS.backgroundZoomPercent,
      50,
      200,
    ),
    loginBoxMode,
  };
}

function themeNeedsLayoutDefaults(theme) {
  if (!theme || typeof theme !== "object") {
    return true;
  }

  return (
    !hasOwn(theme, "loginBoxWidthPercent") ||
    !hasOwn(theme, "loginBoxHeightPercent") ||
    !hasOwn(theme, "loginBoxPosXPercent") ||
    !hasOwn(theme, "loginBoxPosYPercent") ||
    !hasOwn(theme, "loginBoxOpacityPercent") ||
    !hasOwn(theme, "loginBoxHoverOpacityPercent") ||
    !hasOwn(theme, "logoSizePercent") ||
    !hasOwn(theme, "logoOffsetXPercent") ||
    !hasOwn(theme, "logoOffsetYPercent") ||
    !hasOwn(theme, "backgroundZoomPercent") ||
    !hasOwn(theme, "loginBoxMode")
  );
}

function storeNeedsLayoutDefaults(store) {
  if (!store || typeof store !== "object") {
    return true;
  }

  if (!Array.isArray(store.themes)) {
    return true;
  }

  for (const theme of store.themes) {
    if (themeNeedsLayoutDefaults(theme)) {
      return true;
    }
  }

  return false;
}

async function persistNormalizedStoreBestEffort(themeStorePath, normalized) {
  try {
    await fs.mkdir(path.dirname(themeStorePath), { recursive: true });
    await fs.writeFile(themeStorePath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort migration only: theme defaults still apply in-memory.
  }
}

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
  const layout = normalizeThemeLayoutSettings(source);

  return {
    id,
    name: normalizeThemeName(source.name, `Theme ${index + 1}`),
    logoPath: normalizeThemeAssetPath(source.logoPath, "logo"),
    closedBackgroundPath: normalizeThemeAssetPath(source.closedBackgroundPath, "background"),
    openBackgroundPath: normalizeThemeAssetPath(source.openBackgroundPath, "background"),
    loginBoxWidthPercent: layout.loginBoxWidthPercent,
    loginBoxHeightPercent: layout.loginBoxHeightPercent,
    loginBoxPosXPercent: layout.loginBoxPosXPercent,
    loginBoxPosYPercent: layout.loginBoxPosYPercent,
    loginBoxOpacityPercent: layout.loginBoxOpacityPercent,
    loginBoxHoverOpacityPercent: layout.loginBoxHoverOpacityPercent,
    logoSizePercent: layout.logoSizePercent,
    logoOffsetXPercent: layout.logoOffsetXPercent,
    logoOffsetYPercent: layout.logoOffsetYPercent,
    backgroundZoomPercent: layout.backgroundZoomPercent,
    loginBoxMode: layout.loginBoxMode,
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
    loginBoxWidthPercent: THEME_LAYOUT_DEFAULTS.loginBoxWidthPercent,
    loginBoxHeightPercent: THEME_LAYOUT_DEFAULTS.loginBoxHeightPercent,
    loginBoxPosXPercent: THEME_LAYOUT_DEFAULTS.loginBoxPosXPercent,
    loginBoxPosYPercent: THEME_LAYOUT_DEFAULTS.loginBoxPosYPercent,
    loginBoxOpacityPercent: THEME_LAYOUT_DEFAULTS.loginBoxOpacityPercent,
    loginBoxHoverOpacityPercent: THEME_LAYOUT_DEFAULTS.loginBoxHoverOpacityPercent,
    logoSizePercent: THEME_LAYOUT_DEFAULTS.logoSizePercent,
    logoOffsetXPercent: THEME_LAYOUT_DEFAULTS.logoOffsetXPercent,
    logoOffsetYPercent: THEME_LAYOUT_DEFAULTS.logoOffsetYPercent,
    backgroundZoomPercent: THEME_LAYOUT_DEFAULTS.backgroundZoomPercent,
    loginBoxMode: THEME_LAYOUT_DEFAULTS.loginBoxMode,
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
    const normalized = normalizeThemeStorePayload(parsed);
    if (storeNeedsLayoutDefaults(parsed)) {
      await persistNormalizedStoreBestEffort(themeStorePath, normalized);
    }
    return normalized;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const normalized = normalizeThemeStorePayload({});
      await persistNormalizedStoreBestEffort(themeStorePath, normalized);
      return normalized;
    }

    if (error && error.name === "SyntaxError") {
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
