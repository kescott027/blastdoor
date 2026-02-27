export function resolveApiBasePath(currentHref) {
  const url = new URL(currentHref, "http://localhost");
  let basePath = url.pathname || "/";

  if (!basePath.endsWith("/")) {
    const lastSlash = basePath.lastIndexOf("/");
    const tail = basePath.slice(lastSlash + 1);
    if (tail.includes(".")) {
      basePath = basePath.slice(0, lastSlash + 1);
    } else {
      basePath = `${basePath}/`;
    }
  }

  return `${basePath.replace(/\/+$/, "")}/api`;
}

export function resolveApiPath(apiBasePath, routePath) {
  const base = String(apiBasePath || "/api").replace(/\/+$/, "");
  const route = String(routePath || "").replace(/^\/+/, "");
  return `${base}/${route}`;
}

export function getApiBaseCandidates(primaryApiBase, legacyApiBase = "/api") {
  const primary = String(primaryApiBase || "/api").replace(/\/+$/, "");
  const legacy = String(legacyApiBase || "/api").replace(/\/+$/, "");

  if (primary === legacy) {
    return [primary];
  }

  return [primary, legacy];
}

export function formatUnexpectedPayload(response, rawBody) {
  const snippet = String(rawBody || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

  return `Unexpected response from ${response.url || "API"} (${response.status}): ${snippet || "empty body"}`;
}
