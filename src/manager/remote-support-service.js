export function createRemoteSupportService(options = {}) {
  const {
    normalizeString,
    verifyPassword,
    readConsoleSettings,
    writeConsoleSettings,
    randomUUID,
    configDefaults,
    remoteSupportTokenMinTtlMinutes = 30,
    remoteSupportTokenMaxTtlMinutes = 24 * 60,
    callHomeEventsMax = 200,
    callHomeReportPayloadMaxChars = 32_000,
  } = options;

  function clampRemoteSupportTokenTtlMinutes(value, fallback = 30) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(remoteSupportTokenMinTtlMinutes, Math.min(remoteSupportTokenMaxTtlMinutes, parsed));
  }

  function normalizeRemoteSupportTokenValue(req) {
    const headerToken = normalizeString(
      req.get("x-blastdoor-support-token") || req.get("x-blastdoor-remote-support-token"),
      "",
    );
    if (headerToken) {
      return headerToken;
    }
    const authHeader = normalizeString(req.get("authorization"), "");
    const bearerPrefix = "bearer ";
    if (authHeader.toLowerCase().startsWith(bearerPrefix)) {
      return authHeader.slice(bearerPrefix.length).trim();
    }
    return "";
  }

  function isRemoteSupportTokenActive(token, nowMs = Date.now()) {
    if (!token || typeof token !== "object") {
      return false;
    }
    if (normalizeString(token.revokedAt, "")) {
      return false;
    }
    const expiresAt = normalizeString(token.expiresAt, "");
    if (!expiresAt) {
      return false;
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return false;
    }
    return nowMs < expiresAtMs;
  }

  function summarizeRemoteSupportToken(token) {
    return {
      tokenId: normalizeString(token?.tokenId, ""),
      label: normalizeString(token?.label, ""),
      createdAt: normalizeString(token?.createdAt, ""),
      expiresAt: normalizeString(token?.expiresAt, ""),
      lastUsedAt: normalizeString(token?.lastUsedAt, ""),
      revokedAt: normalizeString(token?.revokedAt, ""),
      active: isRemoteSupportTokenActive(token),
    };
  }

  function trimCallHomeEvents(events, maxEvents = callHomeEventsMax) {
    if (!Array.isArray(events)) {
      return [];
    }
    return events.slice(-Math.max(1, Number.parseInt(String(maxEvents || callHomeEventsMax), 10) || callHomeEventsMax));
  }

  function sanitizeCallHomePayload(payload) {
    if (!payload || typeof payload !== "object") {
      return {};
    }
    let json;
    try {
      json = JSON.stringify(payload);
    } catch {
      return {};
    }
    if (!json) {
      return {};
    }
    if (json.length > callHomeReportPayloadMaxChars) {
      json = json.slice(0, callHomeReportPayloadMaxChars);
    }
    try {
      const parsed = JSON.parse(json);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function summarizeCallHomeEvent(event) {
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
    return {
      eventId: normalizeString(event?.eventId, ""),
      type: normalizeString(event?.type, "report"),
      createdAt: normalizeString(event?.createdAt, ""),
      satelliteId: normalizeString(event?.satelliteId, ""),
      status: normalizeString(event?.status, "unknown"),
      message: normalizeString(event?.message, ""),
      payload,
    };
  }

  function escapeDoubleQuotedLiteral(value) {
    return JSON.stringify(String(value ?? "")).slice(1, -1);
  }

  function buildRemoteSupportApiBasePath(req) {
    const host = normalizeString(req.get("host"), "");
    if (!host) {
      return "/api/remote-support/v1";
    }
    const forwardedProto = normalizeString(req.get("x-forwarded-proto"), "");
    const protocol = forwardedProto || req.protocol || "http";
    return `${protocol}://${host}/api/remote-support/v1`;
  }

  function buildCallHomeApiBasePath(req) {
    return `${buildRemoteSupportApiBasePath(req).replace(/\/+$/, "")}/call-home`;
  }

  function buildRemoteSupportCurlExamples({ req, token }) {
    const base = buildRemoteSupportApiBasePath(req).replace(/\/+$/, "");
    const quotedToken = String(token || "").replace(/'/g, "'\\''");
    return [
      `curl -sS -H 'x-blastdoor-support-token: ${quotedToken}' '${base}/diagnostics'`,
      `curl -sS -H 'x-blastdoor-support-token: ${quotedToken}' '${base}/troubleshoot'`,
      `curl -sS -X POST -H 'content-type: application/json' -H 'x-blastdoor-support-token: ${quotedToken}' '${base}/troubleshoot/run' -d '{"actionId":"snapshot.network"}'`,
      `curl -sS -X POST -H 'content-type: application/json' -H 'x-blastdoor-support-token: ${quotedToken}' '${base}/intelligence/workflow/chat' -d '{"workflowId":"troubleshoot-recommendation","input":"Analyze the latest diagnostics report."}'`,
    ];
  }

  function buildCallHomeCurlExamples({ req, token }) {
    const base = buildCallHomeApiBasePath(req).replace(/\/+$/, "");
    const quotedToken = String(token || "").replace(/'/g, "'\\''");
    return [
      `curl -sS -H 'x-blastdoor-support-token: ${quotedToken}' '${base}/healthz'`,
      `curl -sS -X POST -H 'content-type: application/json' -H 'x-blastdoor-support-token: ${quotedToken}' '${base}/register' -d '{"satelliteId":"diag-sat-01","status":"starting","message":"boot"}'`,
      `curl -sS -X POST -H 'content-type: application/json' -H 'x-blastdoor-support-token: ${quotedToken}' '${base}/report' -d '{"satelliteId":"diag-sat-01","status":"ok","message":"path-check-complete","payload":{"probe":"ok"}}'`,
    ];
  }

  function buildRemoteSupportCommandHints({ req, config, environment }) {
    const base = buildRemoteSupportApiBasePath(req).replace(/\/+$/, "");
    const tokenPlaceholder = "<REMOTE_SUPPORT_TOKEN>";
    const gatewayPort = Number.parseInt(normalizeString(config?.PORT, configDefaults.PORT), 10) || 8080;
    const gatewayHost = normalizeString(config?.HOST, configDefaults.HOST) || "127.0.0.1";
    const foundryTarget = normalizeString(config?.FOUNDRY_TARGET, configDefaults.FOUNDRY_TARGET);
    const hints = [
      `curl -sS -H 'x-blastdoor-support-token: ${tokenPlaceholder}' '${base}/diagnostics'`,
      `curl -sS -H 'x-blastdoor-support-token: ${tokenPlaceholder}' '${base}/troubleshoot'`,
      `curl -sS -X POST -H 'content-type: application/json' -H 'x-blastdoor-support-token: ${tokenPlaceholder}' '${base}/troubleshoot/run' -d '{"actionId":"snapshot.network"}'`,
      `curl -sS -X POST -H 'content-type: application/json' -H 'x-blastdoor-support-token: ${tokenPlaceholder}' '${base}/intelligence/workflow/chat' -d '{"workflowId":"troubleshoot-recommendation","input":"Analyze diagnostics and suggest next checks."}'`,
      `curl -i 'http://${gatewayHost}:${gatewayPort}/healthz'`,
      `curl -i '${foundryTarget.replace(/\/+$/, "")}/api/status'`,
    ];
    if (environment?.isWsl) {
      hints.push("ip route show default");
      hints.push("hostname -I");
    }
    return hints;
  }

  function buildCallHomePodBundle({ req, token, tokenMeta, ttlMinutes = 30, generatedAt = new Date().toISOString() }) {
    const base = buildCallHomeApiBasePath(req).replace(/\/+$/, "");
    const baseEscaped = escapeDoubleQuotedLiteral(base);
    const tokenEscaped = escapeDoubleQuotedLiteral(String(token || ""));
    const satelliteId = `diag-${randomUUID().slice(0, 8)}`;
    const dockerImage = "alpine:3.20";
    const entrypointScript = `#!/bin/sh
set -eu

SATELLITE_ID="\${SATELLITE_ID:-${satelliteId}}"
CALL_HOME_TOKEN="\${CALL_HOME_TOKEN:-${tokenEscaped}}"
CALL_HOME_BASE_URL="\${CALL_HOME_BASE_URL:-${baseEscaped}}"
CALL_HOME_CANDIDATES="\${CALL_HOME_CANDIDATES:-$CALL_HOME_BASE_URL,http://host.docker.internal:8090/api/remote-support/v1/call-home}"

if ! command -v curl >/dev/null 2>&1; then
  apk add --no-cache curl >/dev/null
fi

ACTIVE_BASE=""
IFS=','; for candidate in $CALL_HOME_CANDIDATES; do
  candidate_trim="$(echo "$candidate" | sed 's/[[:space:]]*$//')"
  [ -n "$candidate_trim" ] || continue
  if curl -fsS -m 3 -H "x-blastdoor-support-token: $CALL_HOME_TOKEN" "$candidate_trim/healthz" >/tmp/callhome-healthz.json 2>/tmp/callhome-healthz.err; then
    ACTIVE_BASE="$candidate_trim"
    break
  fi
done
unset IFS

if [ -z "$ACTIVE_BASE" ]; then
  echo "call-home: failed to reach API using candidates: $CALL_HOME_CANDIDATES"
  cat /tmp/callhome-healthz.err 2>/dev/null || true
  exit 12
fi

HOSTNAME_VALUE="$(hostname 2>/dev/null || echo unknown)"
REGISTER_BODY="$(printf '{"satelliteId":"%s","status":"starting","message":"diag pod connected","payload":{"hostname":"%s"}}' "$SATELLITE_ID" "$HOSTNAME_VALUE")"

curl -fsS -m 6 -X POST \
  -H "content-type: application/json" \
  -H "x-blastdoor-support-token: $CALL_HOME_TOKEN" \
  "$ACTIVE_BASE/register" \
  -d "$REGISTER_BODY" >/tmp/callhome-register.json

curl -fsS -m 8 -H "x-blastdoor-support-token: $CALL_HOME_TOKEN" "$ACTIVE_BASE/../diagnostics" >/tmp/callhome-diagnostics.json || true
curl -fsS -m 8 -H "x-blastdoor-support-token: $CALL_HOME_TOKEN" "$ACTIVE_BASE/../troubleshoot" >/tmp/callhome-troubleshoot.json || true

REPORT_BODY="$(printf '{"satelliteId":"%s","status":"ok","message":"diag pod completed connectivity workflow","payload":{"activeBase":"%s","hostname":"%s"}}' "$SATELLITE_ID" "$ACTIVE_BASE" "$HOSTNAME_VALUE")"

curl -fsS -m 8 -X POST \
  -H "content-type: application/json" \
  -H "x-blastdoor-support-token: $CALL_HOME_TOKEN" \
  "$ACTIVE_BASE/report" \
  -d "$REPORT_BODY" >/tmp/callhome-report.json

echo "call-home: success ($ACTIVE_BASE)"
`;

    const launchScript = `#!/usr/bin/env bash
set -euo pipefail
export CALL_HOME_TOKEN='${String(token || "").replace(/'/g, "'\\''")}'
export CALL_HOME_BASE_URL='${base.replace(/'/g, "'\\''")}'
export SATELLITE_ID='${satelliteId}'
docker run --rm --name blastdoor-diag-${satelliteId} -e CALL_HOME_TOKEN -e CALL_HOME_BASE_URL -e SATELLITE_ID ${dockerImage} sh -lc "$(cat <<'EOS'
${entrypointScript}
EOS
)"
`;

    const composeYaml = `services:
  blastdoor-diag:
    image: ${dockerImage}
    container_name: blastdoor-diag-${satelliteId}
    restart: "no"
    environment:
      CALL_HOME_TOKEN: "${escapeDoubleQuotedLiteral(String(token || ""))}"
      CALL_HOME_BASE_URL: "${baseEscaped}"
      SATELLITE_ID: "${satelliteId}"
    command:
      - sh
      - -lc
      - |
${entrypointScript
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
`;

    return {
      generatedAt,
      satelliteId,
      token,
      tokenMeta,
      ttlMinutes,
      callHomeBaseUrl: base,
      dockerImage,
      launchScript,
      composeYaml,
      entrypointScript,
      curlExamples: buildCallHomeCurlExamples({ req, token }),
    };
  }

  async function writeRemoteSupportTokenLastUsed({ settings, tokenId }) {
    const normalizedTokenId = normalizeString(tokenId, "");
    if (!normalizedTokenId) {
      return settings;
    }
    const current = settings || (await readConsoleSettings());
    const remoteSupport = current.remoteSupport || {};
    const tokens = Array.isArray(remoteSupport.tokens) ? remoteSupport.tokens : [];
    let changed = false;
    const nextTokens = tokens.map((entry) => {
      if (normalizeString(entry?.tokenId, "") !== normalizedTokenId) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        lastUsedAt: new Date().toISOString(),
      };
    });
    if (!changed) {
      return current;
    }
    return await writeConsoleSettings({
      ...current,
      remoteSupport: {
        ...remoteSupport,
        tokens: nextTokens,
      },
    });
  }

  async function appendCallHomeEvent({ settings, type, satelliteId, status, message, payload }) {
    const current = settings || (await readConsoleSettings());
    const remoteSupport = current.remoteSupport || {};
    const existing = Array.isArray(remoteSupport.callHomeEvents) ? remoteSupport.callHomeEvents : [];
    const event = summarizeCallHomeEvent({
      eventId: randomUUID(),
      type: normalizeString(type, "report"),
      createdAt: new Date().toISOString(),
      satelliteId: normalizeString(satelliteId, ""),
      status: normalizeString(status, "unknown"),
      message: normalizeString(message, ""),
      payload: sanitizeCallHomePayload(payload),
    });
    const nextEvents = trimCallHomeEvents([...existing, event], callHomeEventsMax);
    return await writeConsoleSettings({
      ...current,
      remoteSupport: {
        ...remoteSupport,
        callHomeEvents: nextEvents,
      },
    });
  }

  async function authenticateRemoteSupportToken(req) {
    const settings = await readConsoleSettings();
    const remoteSupport = settings.remoteSupport || {};
    if (!remoteSupport.enabled) {
      return {
        ok: false,
        status: 404,
        error: "Remote support API is disabled.",
        settings,
      };
    }

    const token = normalizeRemoteSupportTokenValue(req);
    if (!token) {
      return {
        ok: false,
        status: 401,
        error: "Missing remote support token.",
        settings,
      };
    }

    const tokens = Array.isArray(remoteSupport.tokens) ? remoteSupport.tokens : [];
    for (const entry of tokens) {
      if (!isRemoteSupportTokenActive(entry)) {
        continue;
      }
      if (!verifyPassword(token, normalizeString(entry.tokenHash, ""))) {
        continue;
      }

      const updated = await writeRemoteSupportTokenLastUsed({
        settings,
        tokenId: normalizeString(entry.tokenId, ""),
      });

      return {
        ok: true,
        settings: updated,
        token: summarizeRemoteSupportToken(entry),
        rawToken: token,
      };
    }

    return {
      ok: false,
      status: 401,
      error: "Unauthorized remote support API request.",
      settings,
    };
  }

  return {
    clampRemoteSupportTokenTtlMinutes,
    summarizeRemoteSupportToken,
    trimCallHomeEvents,
    buildRemoteSupportApiBasePath,
    buildRemoteSupportCurlExamples,
    buildRemoteSupportCommandHints,
    buildCallHomePodBundle,
    appendCallHomeEvent,
    authenticateRemoteSupportToken,
  };
}
