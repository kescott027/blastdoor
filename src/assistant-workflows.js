import { createHash } from "node:crypto";

function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return parsed;
}

function clampInteger(value, fallback, min, max) {
  const parsed = toInteger(value, fallback);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function computeErrorFingerprint(errorText) {
  const normalized = normalizeString(errorText, "").toLowerCase();
  if (!normalized) {
    return "";
  }
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function normalizeLogLines(logLines) {
  if (!Array.isArray(logLines)) {
    return [];
  }
  return logLines
    .map((line) => normalizeString(line, ""))
    .filter((line) => line.length > 0)
    .slice(-2000);
}

function countMatches(text, pattern) {
  if (!text) {
    return 0;
  }
  const matches = text.match(pattern);
  return Array.isArray(matches) ? matches.length : 0;
}

function extractIpCounts(logLines) {
  const counts = new Map();
  for (const line of logLines) {
    const match = line.match(/"ip":"([^"]+)"/i);
    if (!match || !match[1]) {
      continue;
    }
    const ip = match[1];
    counts.set(ip, (counts.get(ip) || 0) + 1);
  }
  return counts;
}

function buildWorkflowEnvelope(workflowId) {
  return {
    workflowId,
    generatedAt: new Date().toISOString(),
  };
}

function createRecommendation({
  id,
  priority = "medium",
  title,
  reason,
  currentValue = "",
  suggestedValue = "",
  source = "",
}) {
  return {
    id,
    priority,
    title,
    reason,
    currentValue,
    suggestedValue,
    source,
  };
}

export function inferEnvironmentConfigurationRecommendations(input = {}) {
  const diagnostics = input.diagnosticsReport && typeof input.diagnosticsReport === "object" ? input.diagnosticsReport : {};
  const installationConfig =
    input.installationConfig && typeof input.installationConfig === "object" ? input.installationConfig : {};
  const currentConfig = diagnostics.config && typeof diagnostics.config === "object" ? diagnostics.config : {};
  const environment = diagnostics.environment && typeof diagnostics.environment === "object" ? diagnostics.environment : {};
  const installType = normalizeString(installationConfig.installType, normalizeString(currentConfig.INSTALL_PROFILE, "local"));

  const recommendations = [];
  const suggestedDefaults = {
    HOST: normalizeString(currentConfig.HOST, "0.0.0.0"),
    COOKIE_SECURE: normalizeString(currentConfig.COOKIE_SECURE, "false"),
    TRUST_PROXY: normalizeString(currentConfig.TRUST_PROXY, "false"),
    ASSISTANT_ENABLED: "true",
    ASSISTANT_PROVIDER: normalizeString(currentConfig.ASSISTANT_PROVIDER, "ollama"),
    ASSISTANT_RAG_ENABLED: normalizeString(currentConfig.ASSISTANT_RAG_ENABLED, "false"),
    ASSISTANT_ALLOW_WEB_SEARCH: normalizeString(currentConfig.ASSISTANT_ALLOW_WEB_SEARCH, "false"),
    ASSISTANT_AUTO_LOCK_ON_THREAT: normalizeString(currentConfig.ASSISTANT_AUTO_LOCK_ON_THREAT, "false"),
    ASSISTANT_THREAT_SCORE_THRESHOLD: normalizeString(currentConfig.ASSISTANT_THREAT_SCORE_THRESHOLD, "80"),
  };

  if (normalizeString(currentConfig.HOST, "") !== "0.0.0.0") {
    recommendations.push(
      createRecommendation({
        id: "network.host-bind",
        priority: "high",
        title: "Expose gateway on all interfaces for LAN access",
        reason: "HOST is not set to 0.0.0.0, which can block internal/LAN access.",
        currentValue: normalizeString(currentConfig.HOST, ""),
        suggestedValue: "0.0.0.0",
        source: "diagnostics.config.HOST",
      }),
    );
    suggestedDefaults.HOST = "0.0.0.0";
  }

  const cookieSecure = toBoolean(currentConfig.COOKIE_SECURE, false);
  const hasTls = toBoolean(currentConfig.TLS_ENABLED, false);
  if (!hasTls && cookieSecure) {
    recommendations.push(
      createRecommendation({
        id: "auth.cookie-secure-local",
        priority: "medium",
        title: "Disable secure cookie for local HTTP-only setups",
        reason: "COOKIE_SECURE=true blocks auth cookies over plain HTTP during local testing.",
        currentValue: normalizeString(currentConfig.COOKIE_SECURE, ""),
        suggestedValue: "false",
        source: "diagnostics.config.COOKIE_SECURE",
      }),
    );
    suggestedDefaults.COOKIE_SECURE = "false";
    suggestedDefaults.TRUST_PROXY = "false";
  }

  if (installType === "container") {
    if (!normalizeString(currentConfig.BLASTDOOR_API_URL, "")) {
      recommendations.push(
        createRecommendation({
          id: "api.internal-url",
          priority: "high",
          title: "Set internal API URL for container model",
          reason: "Container deployments should route portal/admin calls through blastdoor-api.",
          currentValue: normalizeString(currentConfig.BLASTDOOR_API_URL, ""),
          suggestedValue: "http://blastdoor-api:8070",
          source: "installationConfig.installType",
        }),
      );
      suggestedDefaults.BLASTDOOR_API_URL = "http://blastdoor-api:8070";
    }

    if (!normalizeString(currentConfig.ASSISTANT_URL, "")) {
      recommendations.push(
        createRecommendation({
          id: "assistant.internal-url",
          priority: "high",
          title: "Use dedicated assistant service URL in container mode",
          reason: "Standard-Resilient should run assistant as a separate service for isolation and stability.",
          currentValue: normalizeString(currentConfig.ASSISTANT_URL, ""),
          suggestedValue: "http://blastdoor-assistant:8060",
          source: "installationConfig.installType",
        }),
      );
      suggestedDefaults.ASSISTANT_URL = "http://blastdoor-assistant:8060";
    }
  } else if (!normalizeString(currentConfig.ASSISTANT_URL, "")) {
    suggestedDefaults.ASSISTANT_URL = "";
  }

  if (environment.isWsl && normalizeString(currentConfig.HOST, "0.0.0.0") === "0.0.0.0") {
    recommendations.push(
      createRecommendation({
        id: "wsl.portproxy",
        priority: "medium",
        title: "Validate Windows portproxy for WSL2 LAN routing",
        reason: "WSL2 requires host-side portproxy/firewall rules for other LAN clients.",
        currentValue: "not validated",
        suggestedValue: "Run Troubleshooting -> Detect WSL Portproxy",
        source: "diagnostics.environment.isWsl",
      }),
    );
  }

  if (!normalizeString(currentConfig.SESSION_SECRET, "") || normalizeString(currentConfig.SESSION_SECRET, "") === "********") {
    recommendations.push(
      createRecommendation({
        id: "session.secret",
        priority: "high",
        title: "Set/rotate strong SESSION_SECRET",
        reason: "Session security requires a long random secret. Rotating invalidates active sessions.",
        currentValue: normalizeString(currentConfig.SESSION_SECRET, ""),
        suggestedValue: "Generate random 48+ byte value",
        source: "diagnostics.config.SESSION_SECRET",
      }),
    );
  }

  return {
    ...buildWorkflowEnvelope("environment-inferred-configuration-recommendations"),
    recommendations,
    suggestedDefaults,
    summary:
      recommendations.length === 0
        ? "Current configuration already aligns with default assistant recommendations."
        : `Generated ${recommendations.length} configuration recommendation(s).`,
  };
}

async function duckDuckGoSearch(query, { maxResults = 3, timeoutMs = 3500, fetchImpl = fetch } = {}) {
  const trimmed = normalizeString(query, "");
  if (!trimmed) {
    return [];
  }

  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    const out = [];
    if (payload?.AbstractURL) {
      out.push({
        title: normalizeString(payload.Heading, "Reference"),
        url: normalizeString(payload.AbstractURL, ""),
        snippet: normalizeString(payload.AbstractText, ""),
      });
    }

    const related = Array.isArray(payload?.RelatedTopics) ? payload.RelatedTopics : [];
    for (const entry of related) {
      if (out.length >= maxResults) {
        break;
      }
      if (entry && typeof entry === "object" && entry.FirstURL && entry.Text) {
        out.push({
          title: normalizeString(entry.Text, "Reference"),
          url: normalizeString(entry.FirstURL, ""),
          snippet: normalizeString(entry.Text, ""),
        });
      } else if (entry && Array.isArray(entry.Topics)) {
        for (const subEntry of entry.Topics) {
          if (out.length >= maxResults) {
            break;
          }
          if (subEntry && typeof subEntry === "object" && subEntry.FirstURL && subEntry.Text) {
            out.push({
              title: normalizeString(subEntry.Text, "Reference"),
              url: normalizeString(subEntry.FirstURL, ""),
              snippet: normalizeString(subEntry.Text, ""),
            });
          }
        }
      }
    }

    return out.slice(0, maxResults);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function createTroubleshootAction(order, title, details, risk = "low") {
  return {
    order,
    title,
    details,
    risk,
  };
}

export async function generateTroubleshootingRecommendation(input = {}, options = {}) {
  const errorText = normalizeString(input.errorText, "");
  const diagnostics = input.diagnosticsReport && typeof input.diagnosticsReport === "object" ? input.diagnosticsReport : {};
  const troubleshooting =
    input.troubleshootReport && typeof input.troubleshootReport === "object" ? input.troubleshootReport : {};
  const config = diagnostics.config && typeof diagnostics.config === "object" ? diagnostics.config : {};
  const observations = [];
  const recommendedActions = [];
  const normalizedError = errorText.toLowerCase();
  const fingerprint = computeErrorFingerprint(errorText);

  if (normalizedError.includes("invalid csrf token")) {
    observations.push("Login POST is failing CSRF validation.");
    recommendedActions.push(
      createTroubleshootAction(
        1,
        "Refresh login page and retry once",
        "A stale page can hold an expired CSRF token. Reload /login and submit again.",
        "low",
      ),
      createTroubleshootAction(
        2,
        "Verify origin policy settings",
        "Check ALLOWED_ORIGINS and ALLOW_NULL_ORIGIN for your browser/runtime context. WSL/browser integrations can emit Origin: null.",
        "low",
      ),
    );
  }

  if (normalizedError.includes("invalid-origin-header") || normalizedError.includes("origin_rejected")) {
    observations.push("Origin header check rejected the login request.");
    recommendedActions.push(
      createTroubleshootAction(
        3,
        "Adjust origin allow-list",
        "Set ALLOWED_ORIGINS to include your exact access origin (scheme + host + port) or enable ALLOW_NULL_ORIGIN for trusted local testing only.",
        "medium",
      ),
    );
  }

  if (normalizedError.includes("econnrefused")) {
    observations.push("Network connection was refused by the target endpoint.");
    recommendedActions.push(
      createTroubleshootAction(
        4,
        "Confirm target service availability",
        "Validate Foundry and Blastdoor listener ports, then run troubleshooting gateway checks.",
        "low",
      ),
    );
  }

  if (normalizedError.includes("eaddrinuse")) {
    observations.push("Port binding conflict detected.");
    recommendedActions.push(
      createTroubleshootAction(
        5,
        "Resolve port collision",
        "Stop the existing process on the conflicted port or choose a different service port.",
        "low",
      ),
    );
  }

  if (normalizedError.includes("cannot find module") || normalizedError.includes("err_module_not_found")) {
    observations.push("Dependency or module resolution failure detected.");
    recommendedActions.push(
      createTroubleshootAction(
        6,
        "Reinstall dependencies",
        "Run npm install in the repository root and re-run setup/launch.",
        "low",
      ),
    );
  }

  if (normalizedError.includes("forbidden")) {
    observations.push("Request was denied by an authorization or policy guard.");
    recommendedActions.push(
      createTroubleshootAction(
        7,
        "Check auth + lock state",
        "Confirm credentials, Blast Doors lock state, and origin/CSRF protections.",
        "low",
      ),
    );
  }

  const checks = Array.isArray(troubleshooting.checks) ? troubleshooting.checks : [];
  const failingChecks = checks.filter((entry) => String(entry.status || "").toLowerCase() === "error");
  if (failingChecks.length > 0) {
    observations.push(`Troubleshooting report has ${failingChecks.length} failing check(s).`);
    recommendedActions.push(
      createTroubleshootAction(
        8,
        "Address failed troubleshoot checks first",
        failingChecks.map((entry) => `${entry.title}: ${entry.detail}`).join(" | "),
        "low",
      ),
    );
  }

  if (normalizeString(config.HOST, "") && normalizeString(config.HOST, "") !== "0.0.0.0") {
    recommendedActions.push(
      createTroubleshootAction(
        9,
        "Consider HOST=0.0.0.0 for LAN access",
        `Current HOST is ${config.HOST}. This can block access from other hosts.`,
        "low",
      ),
    );
  }

  const allowWebSearch = toBoolean(options.allowWebSearch ?? input.allowWebSearch, false);
  const ragEnabled = toBoolean(options.ragEnabled ?? input.ragEnabled, false);
  const webSearchFn = typeof options.webSearchFn === "function" ? options.webSearchFn : duckDuckGoSearch;
  let externalReferences = [];
  if (ragEnabled && allowWebSearch && errorText) {
    const references = await webSearchFn(`Blastdoor ${errorText}`);
    externalReferences = Array.isArray(references) ? references.slice(0, 3) : [];
  }

  if (recommendedActions.length === 0) {
    recommendedActions.push(
      createTroubleshootAction(
        1,
        "Collect fresh diagnostics and troubleshooting report",
        "No direct signature matched. Re-run diagnostics, then submit the exact error text/log line for targeted guidance.",
        "low",
      ),
    );
  }

  recommendedActions.sort((a, b) => a.order - b.order);
  return {
    ...buildWorkflowEnvelope("error-troubleshooting-recommendation"),
    errorFingerprint: fingerprint,
    errorText,
    observations,
    recommendedActions,
    externalReferences,
    ragUsed: ragEnabled && allowWebSearch,
  };
}

function determineThreatLevel(score) {
  if (score >= 90) {
    return "critical";
  }
  if (score >= 70) {
    return "high";
  }
  if (score >= 40) {
    return "medium";
  }
  return "low";
}

function createThreatMatch(type, scoreImpact, detail) {
  return { type, scoreImpact, detail };
}

export function monitorThreatSignals(input = {}) {
  const logLines = normalizeLogLines(input.logLines);
  const combined = logLines.join("\n");
  const lower = combined.toLowerCase();
  const threshold = clampInteger(input.threatScoreThreshold, 80, 20, 100);
  const blastDoorsClosed = toBoolean(input.blastDoorsClosed, false);
  let riskScore = 0;
  const matches = [];

  const unauthorizedAttempts = countMatches(lower, /auth\.login\.failed|invalid credentials|statuscode":401| 401 /g);
  if (unauthorizedAttempts >= 10) {
    const impact = unauthorizedAttempts >= 30 ? 35 : 20;
    riskScore += impact;
    matches.push(
      createThreatMatch(
        "brute-force-auth",
        impact,
        `${unauthorizedAttempts} unauthorized/auth-failed events detected in recent logs.`,
      ),
    );
  }

  const originRejects = countMatches(lower, /origin_rejected|invalid-origin-header|forbidden/g);
  if (originRejects >= 8) {
    riskScore += 15;
    matches.push(
      createThreatMatch(
        "origin-abuse",
        15,
        `${originRejects} forbidden/origin-rejected events detected.`,
      ),
    );
  }

  if (/(union select|or 1=1|information_schema|sqlmap|drop table|sleep\()/i.test(combined)) {
    riskScore += 45;
    matches.push(createThreatMatch("sql-injection-probe", 45, "SQL injection probe signature detected."));
  }

  if (/(<script|%3cscript|javascript:|onerror=|onload=)/i.test(combined)) {
    riskScore += 35;
    matches.push(createThreatMatch("xss-probe", 35, "Possible XSS payload signature detected."));
  }

  if (/(?:\.\.\/|%2e%2e%2f)/i.test(combined)) {
    riskScore += 25;
    matches.push(createThreatMatch("path-traversal-probe", 25, "Path traversal signature detected."));
  }

  if (/(sqlmap|nikto|nmap|acunetix|masscan|dirbuster|owasp zap|zaproxy)/i.test(combined)) {
    riskScore += 35;
    matches.push(createThreatMatch("scanner-ua", 35, "Known scanner user-agent marker detected."));
  }

  const ipCounts = extractIpCounts(logLines);
  let maxIpCount = 0;
  let busiestIp = "";
  for (const [ip, count] of ipCounts.entries()) {
    if (count > maxIpCount) {
      maxIpCount = count;
      busiestIp = ip;
    }
  }
  if (maxIpCount >= 20) {
    riskScore += 30;
    matches.push(
      createThreatMatch(
        "single-source-flood",
        30,
        `High request concentration from ${busiestIp} (${maxIpCount} events).`,
      ),
    );
  }

  const threatLevel = determineThreatLevel(riskScore);
  const shouldLockdown = !blastDoorsClosed && riskScore >= threshold;
  const recommendedActions = [
    {
      order: 1,
      title: "Capture diagnostics snapshot",
      details: "Generate diagnostics/troubleshoot reports before making changes.",
    },
    {
      order: 2,
      title: shouldLockdown ? "Lock blast doors immediately" : "Continue active monitoring",
      details: shouldLockdown
        ? "Threat score exceeded threshold. Temporarily lock blast doors and rotate session secret."
        : "Threat score below lock threshold. Keep monitoring and tighten rate limits/origin policy as needed.",
    },
    {
      order: 3,
      title: "Review high-volume IP activity",
      details: busiestIp ? `Inspect requests from ${busiestIp}.` : "No dominant source IP found.",
    },
  ];

  return {
    ...buildWorkflowEnvelope("threat-monitoring-and-lockdown"),
    logWindowSize: logLines.length,
    threatScoreThreshold: threshold,
    riskScore,
    threatLevel,
    shouldLockdown,
    blastDoorsClosed,
    matches,
    recommendedActions,
  };
}

const GRIMOIRE_CAPABILITIES = [
  {
    id: "users.create",
    title: "Create User",
    keywords: ["create user", "new user", "add user"],
    steps: [
      {
        method: "POST",
        path: "/api/users/create",
        payloadTemplate: {
          username: "{{username}}",
          password: "{{password}}",
          friendlyName: "{{friendlyName}}",
          email: "{{email}}",
          status: "active",
        },
      },
    ],
  },
  {
    id: "users.disable",
    title: "Disable/Ban User",
    keywords: ["ban user", "disable user", "deactivate user"],
    steps: [
      {
        method: "POST",
        path: "/api/users/set-status",
        payloadTemplate: {
          username: "{{username}}",
          status: "banned",
        },
      },
    ],
  },
  {
    id: "blastdoors.lock",
    title: "Lock Blast Doors",
    keywords: ["lock blast doors", "close blast doors", "lockdown"],
    steps: [
      {
        method: "POST",
        path: "/api/config",
        payloadTemplate: {
          BLAST_DOORS_CLOSED: "true",
        },
      },
    ],
  },
  {
    id: "themes.apply",
    title: "Apply Login Theme",
    keywords: ["apply theme", "switch theme", "change login theme"],
    steps: [
      {
        method: "POST",
        path: "/api/themes/apply",
        payloadTemplate: {
          themeId: "{{themeId}}",
        },
      },
    ],
  },
  {
    id: "service.restart",
    title: "Restart Service",
    keywords: ["restart service", "restart blastdoor", "reload gateway"],
    steps: [
      {
        method: "POST",
        path: "/api/restart",
        payloadTemplate: {},
      },
    ],
  },
];

export function buildGrimoireWorkflow(input = {}) {
  const intent = normalizeString(input.intent, "");
  const lowerIntent = intent.toLowerCase();
  const matched = [];

  for (const capability of GRIMOIRE_CAPABILITIES) {
    if (capability.keywords.some((keyword) => lowerIntent.includes(keyword))) {
      matched.push(capability);
    }
  }

  const blockChain = matched.map((capability, index) => ({
    blockId: `${capability.id}-${index + 1}`,
    title: capability.title,
    capabilityId: capability.id,
    steps: capability.steps,
  }));

  return {
    ...buildWorkflowEnvelope("grimoire-api-intent-block-builder"),
    intent,
    matchedCapabilities: matched.map((capability) => capability.id),
    blockChain,
    notes:
      blockChain.length > 0
        ? [
            "Review payload templates before execution.",
            "Persist finalized scripts in your scripting self-serve store.",
          ]
        : [
            "No direct capability match found for this intent.",
            "Refine intent with explicit action and target resource (for example: 'create user', 'lock blast doors').",
          ],
  };
}
