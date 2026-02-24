import fs from "node:fs";
import path from "node:path";

function toErrorMeta(error) {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

function sanitizeMeta(meta = {}) {
  if (!meta || typeof meta !== "object") {
    return {};
  }

  return meta;
}

export function createLogger({ debugEnabled = false, logFile = "logs/blastdoor-debug.log" } = {}) {
  let stream = null;
  if (debugEnabled) {
    const absoluteLogFile = path.resolve(logFile);
    fs.mkdirSync(path.dirname(absoluteLogFile), { recursive: true });
    stream = fs.createWriteStream(absoluteLogFile, { flags: "a" });
  }

  function write(level, message, meta = {}) {
    const safeMeta = sanitizeMeta(meta);
    const payload = {
      ts: new Date().toISOString(),
      level,
      message,
      ...safeMeta,
    };

    const consoleMethod = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    if (debugEnabled || level !== "debug") {
      console[consoleMethod](`[${payload.ts}] ${level.toUpperCase()} ${message}`);
      if (Object.keys(safeMeta).length > 0) {
        console[consoleMethod](safeMeta);
      }
    }

    if (stream) {
      stream.write(`${JSON.stringify(payload)}\n`);
    }
  }

  return {
    debugEnabled,
    debug(message, meta = {}) {
      write("debug", message, meta);
    },
    info(message, meta = {}) {
      write("info", message, meta);
    },
    warn(message, meta = {}) {
      write("warn", message, meta);
    },
    error(message, errorOrMeta = {}) {
      if (errorOrMeta instanceof Error) {
        write("error", message, { error: toErrorMeta(errorOrMeta) });
        return;
      }

      write("error", message, sanitizeMeta(errorOrMeta));
    },
    close() {
      if (stream) {
        stream.end();
        stream = null;
      }
    },
  };
}
