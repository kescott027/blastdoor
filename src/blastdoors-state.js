import fs from "node:fs/promises";
import path from "node:path";

export function parseBooleanLike(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function normalizePayload(payload, fallback) {
  const source = payload && typeof payload === "object" ? payload : {};
  return {
    blastDoorsClosed: parseBooleanLike(source.blastDoorsClosed, fallback),
    updatedAt: typeof source.updatedAt === "string" && source.updatedAt ? source.updatedAt : new Date().toISOString(),
  };
}

export async function readBlastDoorsState(filePath, fallback = false) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizePayload(parsed, fallback).blastDoorsClosed;
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.name === "SyntaxError")) {
      return fallback;
    }
    throw new Error(`Failed to read blast doors state from ${filePath}: ${error.message}`, { cause: error });
  }
}

export async function writeBlastDoorsState(filePath, blastDoorsClosed) {
  const payload = normalizePayload({ blastDoorsClosed }, false);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return payload.blastDoorsClosed;
}

export function createBlastDoorsStateController({
  filePath,
  fallback = false,
  refreshMs = 250,
  onReadError = () => {},
} = {}) {
  let cachedState = Boolean(fallback);
  let lastRefreshAt = 0;
  let inflight = null;

  async function refreshIfStale() {
    const now = Date.now();
    if (now - lastRefreshAt < refreshMs) {
      return cachedState;
    }

    if (inflight) {
      return inflight;
    }

    inflight = readBlastDoorsState(filePath, cachedState)
      .then((nextState) => {
        cachedState = Boolean(nextState);
        lastRefreshAt = Date.now();
        return cachedState;
      })
      .catch((error) => {
        onReadError(error);
        lastRefreshAt = Date.now();
        return cachedState;
      })
      .finally(() => {
        inflight = null;
      });

    return inflight;
  }

  async function getClosed() {
    return await refreshIfStale();
  }

  async function setClosed(nextState) {
    cachedState = Boolean(nextState);
    lastRefreshAt = Date.now();
    await writeBlastDoorsState(filePath, cachedState);
    return cachedState;
  }

  return {
    getClosed,
    setClosed,
  };
}
