import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGrimoireWorkflow,
  generateTroubleshootingRecommendation,
  inferEnvironmentConfigurationRecommendations,
  monitorThreatSignals,
} from "../src/assistant-workflows.js";

test("inferEnvironmentConfigurationRecommendations suggests host + container assistant defaults", () => {
  const result = inferEnvironmentConfigurationRecommendations({
    diagnosticsReport: {
      config: {
        HOST: "127.0.0.1",
        COOKIE_SECURE: "true",
        TLS_ENABLED: "false",
        ASSISTANT_URL: "",
        BLASTDOOR_API_URL: "",
      },
      environment: {
        isWsl: true,
      },
    },
    installationConfig: {
      installType: "container",
    },
  });

  assert.equal(result.workflowId, "environment-inferred-configuration-recommendations");
  assert.equal(Array.isArray(result.recommendations), true);
  assert.equal(result.recommendations.some((entry) => entry.id === "network.host-bind"), true);
  assert.equal(result.suggestedDefaults.ASSISTANT_URL, "http://blastdoor-assistant:8060");
});

test("generateTroubleshootingRecommendation identifies csrf/origin issues", async () => {
  const result = await generateTroubleshootingRecommendation({
    errorText: "Invalid CSRF token and auth.login.origin_rejected invalid-origin-header",
  });

  assert.equal(result.workflowId, "error-troubleshooting-recommendation");
  assert.equal(result.errorFingerprint.length, 16);
  assert.equal(result.recommendedActions.some((entry) => entry.title.includes("origin")), true);
});

test("monitorThreatSignals flags high-risk activity and recommends lockdown", () => {
  const lines = [
    '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.10"}',
    '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.10"}',
    '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.10"}',
    '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.10"}',
    '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.10"}',
    '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.10"}',
    '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.10"}',
    '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.10"}',
    '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.10"}',
    '{"level":"warn","message":"auth.login.failed","ip":"203.0.113.10"}',
    "GET /login?q=%3Cscript%3Ealert(1)%3C/script%3E",
  ];
  const result = monitorThreatSignals({
    logLines: lines,
    threatScoreThreshold: 50,
    blastDoorsClosed: false,
  });

  assert.equal(result.workflowId, "threat-monitoring-and-lockdown");
  assert.equal(result.shouldLockdown, true);
  assert.equal(result.matches.some((entry) => entry.type === "xss-probe"), true);
});

test("buildGrimoireWorkflow maps intent to API blocks", () => {
  const result = buildGrimoireWorkflow({
    intent: "Create user and restart blastdoor",
  });

  assert.equal(result.workflowId, "grimoire-api-intent-block-builder");
  assert.equal(result.matchedCapabilities.includes("users.create"), true);
  assert.equal(result.matchedCapabilities.includes("service.restart"), true);
  assert.equal(result.blockChain.length >= 2, true);
});
