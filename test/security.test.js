import test from "node:test";
import assert from "node:assert/strict";
import {
  createCsrfToken,
  createPasswordHash,
  evaluateSameOrigin,
  escapeHtml,
  isSameOrigin,
  safeEqual,
  safeNextPath,
  verifyPassword,
} from "../src/security.js";

test("createPasswordHash + verifyPassword", () => {
  const password = "correct horse battery staple!";
  const hash = createPasswordHash(password);

  assert.ok(hash.startsWith("scrypt$"));
  assert.equal(verifyPassword(password, hash), true);
  assert.equal(verifyPassword("wrong-password", hash), false);
  assert.equal(verifyPassword(password, "bogus"), false);
});

test("createPasswordHash rejects short passwords", () => {
  assert.throws(() => createPasswordHash("too-short"), /at least 12 characters/);
});

test("createCsrfToken generates url-safe random token", () => {
  const a = createCsrfToken();
  const b = createCsrfToken();

  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.equal(a.length > 20, true);
  assert.notEqual(a, b);
});

test("safeEqual compares values safely", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "ab"), false);
});

test("safeNextPath prevents open redirects", () => {
  assert.equal(safeNextPath("/game"), "/game");
  assert.equal(safeNextPath("//evil.example"), "/");
  assert.equal(safeNextPath("http://evil.example"), "/");
  assert.equal(safeNextPath("/../../etc/passwd"), "/");
  assert.equal(safeNextPath("/\\windows"), "/");
  assert.equal(safeNextPath("/ok\r\nx"), "/");
  assert.equal(safeNextPath("   /trimmed  "), "/trimmed");
  assert.equal(safeNextPath(undefined, "/fallback"), "/fallback");
});

test("isSameOrigin validates request origin", () => {
  const req = {
    protocol: "https",
    get(name) {
      if (name === "origin") {
        return "https://gateway.example";
      }

      if (name === "host") {
        return "gateway.example";
      }

      return undefined;
    },
  };

  assert.equal(isSameOrigin(req), true);

  const badReq = {
    protocol: "https",
    get(name) {
      if (name === "origin") {
        return "https://attacker.example";
      }

      if (name === "host") {
        return "gateway.example";
      }

      return undefined;
    },
  };

  assert.equal(isSameOrigin(badReq), false);
});

test("isSameOrigin allows localhost and 127.0.0.1 loopback aliases", () => {
  const req = {
    protocol: "http",
    get(name) {
      if (name === "origin") {
        return "http://localhost:8080";
      }

      if (name === "host") {
        return "127.0.0.1:8080";
      }

      return undefined;
    },
  };

  assert.equal(isSameOrigin(req), true);
});

test("isSameOrigin accepts forwarded proto when present", () => {
  const req = {
    protocol: "http",
    get(name) {
      if (name === "origin") {
        return "https://gateway.example";
      }

      if (name === "host") {
        return "gateway.example";
      }

      if (name === "x-forwarded-proto") {
        return "https";
      }

      return undefined;
    },
  };

  assert.equal(isSameOrigin(req), true);
});

test("evaluateSameOrigin accepts x-forwarded-host candidate", () => {
  const req = {
    protocol: "http",
    get(name) {
      if (name === "origin") {
        return "https://game.example.com";
      }

      if (name === "host") {
        return "127.0.0.1:8080";
      }

      if (name === "x-forwarded-host") {
        return "game.example.com";
      }

      if (name === "x-forwarded-proto") {
        return "https";
      }

      return undefined;
    },
  };

  const result = evaluateSameOrigin(req);
  assert.equal(result.ok, true);
});

test("evaluateSameOrigin accepts configured allowed origins", () => {
  const req = {
    protocol: "http",
    get(name) {
      if (name === "origin") {
        return "https://portal.example.com";
      }

      if (name === "host") {
        return "internal:8080";
      }

      return undefined;
    },
  };

  const result = evaluateSameOrigin(req, { allowedOrigins: "https://portal.example.com" });
  assert.equal(result.ok, true);
});

test("evaluateSameOrigin rejects null origin by default", () => {
  const req = {
    protocol: "http",
    get(name) {
      if (name === "origin") {
        return "null";
      }

      if (name === "host") {
        return "localhost:8080";
      }

      return undefined;
    },
  };

  const result = evaluateSameOrigin(req);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "null-origin-rejected");
});

test("evaluateSameOrigin accepts null origin when enabled", () => {
  const req = {
    protocol: "http",
    get(name) {
      if (name === "origin") {
        return "null";
      }

      if (name === "host") {
        return "localhost:8080";
      }

      return undefined;
    },
  };

  const result = evaluateSameOrigin(req, { allowNullOrigin: true });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "null-origin-allowed");
});

test("escapeHtml escapes dangerous characters", () => {
  assert.equal(escapeHtml("<tag>\"'&"), "&lt;tag&gt;&quot;&#39;&amp;");
});
