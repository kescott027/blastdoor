import crypto from "node:crypto";

const SCRYPT_PREFIX = "scrypt";

export function createPasswordHash(password) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("Password must be at least 12 characters.");
  }

  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, 64);

  return `${SCRYPT_PREFIX}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export function verifyPassword(password, passwordHash) {
  if (typeof password !== "string" || typeof passwordHash !== "string") {
    return false;
  }

  const pieces = passwordHash.split("$");
  if (pieces.length !== 3 || pieces[0] !== SCRYPT_PREFIX) {
    return false;
  }

  try {
    const salt = Buffer.from(pieces[1], "base64url");
    const expected = Buffer.from(pieces[2], "base64url");
    const actual = crypto.scryptSync(password, salt, expected.length);

    return safeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function createCsrfToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function safeEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

export function safeNextPath(candidate, fallback = "/") {
  if (typeof candidate !== "string") {
    return fallback;
  }

  const trimmed = candidate.trim();

  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return fallback;
  }

  if (trimmed.includes("..") || trimmed.includes("\\") || hasControlCharacters(trimmed)) {
    return fallback;
  }

  return trimmed;
}

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0 && code <= 31) || code === 127) {
      return true;
    }
  }

  return false;
}

export function isSameOrigin(req) {
  return evaluateSameOrigin(req).ok;
}

export function evaluateSameOrigin(req, options = {}) {
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins || []);
  const allowNullOrigin = options.allowNullOrigin === true;
  const origin = req.get("origin");
  if (!origin) {
    return { ok: true, reason: "no-origin-header" };
  }

  if (String(origin).toLowerCase() === "null") {
    if (allowNullOrigin) {
      return { ok: true, reason: "null-origin-allowed" };
    }

    return { ok: false, reason: "null-origin-rejected" };
  }

  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return { ok: false, reason: "invalid-origin-header" };
  }

  const normalizedOrigin = `${originUrl.protocol}//${originUrl.host}`.toLowerCase();
  if (allowedOrigins.has(normalizedOrigin)) {
    return { ok: true, reason: "allowed-origin-match" };
  }

  const host = req.get("host");
  const forwardedHost = req.get("x-forwarded-host");
  const hostCandidates = buildHostCandidates(host, forwardedHost);
  if (hostCandidates.length === 0) {
    return { ok: false, reason: "missing-host-header" };
  }

  const forwardedProto = req.get("x-forwarded-proto");
  const protocolCandidates = new Set([String(req.protocol || "").toLowerCase()]);
  if (forwardedProto) {
    for (const proto of String(forwardedProto).split(",")) {
      const normalized = proto.trim().toLowerCase();
      if (normalized) {
        protocolCandidates.add(normalized);
      }
    }
  }

  const originProtocol = originUrl.protocol.replace(":", "").toLowerCase();
  if (!protocolCandidates.has(originProtocol)) {
    return {
      ok: false,
      reason: "protocol-mismatch",
      details: {
        origin: normalizedOrigin,
        originProtocol,
        expectedProtocols: Array.from(protocolCandidates.values()),
        allowedOrigins: Array.from(allowedOrigins.values()),
      },
    };
  }

  const originHost = originUrl.host.toLowerCase();
  for (const requestHost of hostCandidates) {
    if (safeEqual(originHost, requestHost)) {
      return { ok: true, reason: "exact-host-match" };
    }
  }

  const parsedOriginAuthority = parseAuthority(originHost);
  if (!parsedOriginAuthority) {
    return { ok: false, reason: "invalid-host-authority" };
  }

  for (const requestHost of hostCandidates) {
    const parsedRequestAuthority = parseAuthority(requestHost);
    if (!parsedRequestAuthority) {
      continue;
    }

    const samePort = parsedOriginAuthority.port === parsedRequestAuthority.port;
    const bothLoopback =
      isLoopbackHost(parsedOriginAuthority.hostname) && isLoopbackHost(parsedRequestAuthority.hostname);

    if (samePort && bothLoopback) {
      return { ok: true, reason: "loopback-alias-match" };
    }
  }

  return {
    ok: false,
    reason: "host-mismatch",
    details: {
      origin: normalizedOrigin,
      originHost,
      requestHostCandidates: hostCandidates,
      originHostname: parsedOriginAuthority.hostname,
      originPort: parsedOriginAuthority.port,
      allowedOrigins: Array.from(allowedOrigins.values()),
    },
  };
}

function parseAuthority(authority) {
  try {
    const parsed = new URL(`http://${authority}`);
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port || "80";
    return { hostname, port };
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function buildHostCandidates(host, forwardedHost) {
  const candidates = [];

  if (typeof host === "string" && host.trim().length > 0) {
    candidates.push(host.trim().toLowerCase());
  }

  if (typeof forwardedHost === "string" && forwardedHost.trim().length > 0) {
    for (const value of forwardedHost.split(",")) {
      const normalized = value.trim().toLowerCase();
      if (normalized.length > 0) {
        candidates.push(normalized);
      }
    }
  }

  return Array.from(new Set(candidates));
}

function normalizeAllowedOrigins(input) {
  const values = Array.isArray(input) ? input : [input];
  const normalized = new Set();

  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    for (const candidate of value.split(",")) {
      const trimmed = candidate.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const url = new URL(trimmed);
        normalized.add(`${url.protocol}//${url.host}`.toLowerCase());
      } catch {
        // Ignore malformed entries.
      }
    }
  }

  return normalized;
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
