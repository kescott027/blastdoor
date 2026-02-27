import test from "node:test";
import assert from "node:assert/strict";
import { formatUnexpectedPayload, resolveApiBasePath, resolveApiPath } from "../public/manager/client-utils.js";

test("resolveApiBasePath supports manager route variants", () => {
  assert.equal(resolveApiBasePath("http://127.0.0.1:8090/manager/"), "/manager/api");
  assert.equal(resolveApiBasePath("http://127.0.0.1:8090/manager"), "/manager/api");
  assert.equal(resolveApiBasePath("http://127.0.0.1:8090/manager/index.html"), "/manager/api");
});

test("resolveApiPath normalizes slashes", () => {
  assert.equal(resolveApiPath("/manager/api", "/diagnostics"), "/manager/api/diagnostics");
  assert.equal(resolveApiPath("/manager/api/", "diagnostics"), "/manager/api/diagnostics");
});

test("formatUnexpectedPayload includes status url and trimmed payload snippet", () => {
  const msg = formatUnexpectedPayload(
    { url: "http://127.0.0.1:8080/login", status: 200 },
    "<!DOCTYPE html><html><body>forbidden page</body></html>",
  );

  assert.match(msg, /Unexpected response from http:\/\/127\.0\.0\.1:8080\/login \(200\):/);
  assert.match(msg, /<!DOCTYPE html>/);
});
