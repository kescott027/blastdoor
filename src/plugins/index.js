import { createIntelligencePlugin } from "./intelligence-plugin.js";

const BUILTIN_PLUGINS = [createIntelligencePlugin()];

function normalizePluginId(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function resolveEnabledPluginIds(env, plugins) {
  const configured = String(env?.BLASTDOOR_PLUGINS || "").trim();
  const availableIds = plugins.map((plugin) => normalizePluginId(plugin.id)).filter(Boolean);
  if (!configured) {
    return new Set(availableIds);
  }

  const normalizedConfigured = configured.toLowerCase();
  if (["none", "off", "false", "0"].includes(normalizedConfigured)) {
    return new Set();
  }

  const requested = configured
    .split(",")
    .map((entry) => normalizePluginId(entry))
    .filter(Boolean);
  return new Set(requested.filter((id) => availableIds.includes(id)));
}

function dedupeList(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function createPluginManager({ env = process.env, plugins = BUILTIN_PLUGINS } = {}) {
  const enabledIds = resolveEnabledPluginIds(env, plugins);
  const enabledPlugins = plugins.filter((plugin) => enabledIds.has(normalizePluginId(plugin.id)));

  return {
    getEnabledPlugins() {
      return [...enabledPlugins];
    },

    getManagerConfigExtensions() {
      const fields = [];
      const sensitiveKeys = [];
      let defaults = {};

      for (const plugin of enabledPlugins) {
        const config = plugin.managerConfig;
        if (!config) {
          continue;
        }
        if (Array.isArray(config.fields)) {
          fields.push(...config.fields);
        }
        if (Array.isArray(config.sensitiveKeys)) {
          sensitiveKeys.push(...config.sensitiveKeys);
        }
        if (config.defaults && typeof config.defaults === "object") {
          defaults = { ...defaults, ...config.defaults };
        }
      }

      return {
        fields: dedupeList(fields),
        defaults,
        sensitiveKeys: dedupeList(sensitiveKeys),
      };
    },

    getInstallationEnvContribution({ forDocker = false, installationConfig = {}, existing = {} } = {}) {
      const order = [];
      let values = {};
      for (const plugin of enabledPlugins) {
        const contribution = plugin.installationEnv;
        if (!contribution) {
          continue;
        }
        if (Array.isArray(contribution.order)) {
          order.push(...contribution.order);
        }
        if (typeof contribution.values === "function") {
          values = {
            ...values,
            ...contribution.values({ forDocker, installationConfig, existing }),
          };
        }
      }
      return {
        order: dedupeList(order),
        values,
      };
    },

    loadServerConfigFromEnv(envArg) {
      let result = {};
      for (const plugin of enabledPlugins) {
        const serverConfig = plugin.serverConfig;
        if (!serverConfig || typeof serverConfig.loadFromEnv !== "function") {
          continue;
        }
        result = {
          ...result,
          ...serverConfig.loadFromEnv(envArg),
        };
      }
      return result;
    },

    validateServerConfig(config) {
      for (const plugin of enabledPlugins) {
        const serverConfig = plugin.serverConfig;
        if (!serverConfig || typeof serverConfig.validate !== "function") {
          continue;
        }
        serverConfig.validate(config);
      }
    },

    getPersistedServerValues(config) {
      let result = {};
      for (const plugin of enabledPlugins) {
        const serverConfig = plugin.serverConfig;
        if (!serverConfig || typeof serverConfig.persistValues !== "function") {
          continue;
        }
        result = {
          ...result,
          ...serverConfig.persistValues(config),
        };
      }
      return result;
    },

    decorateLocalBlastdoorApi(api, context = {}) {
      for (const plugin of enabledPlugins) {
        const apiLayer = plugin.api;
        if (!apiLayer || typeof apiLayer.decorateLocalApi !== "function") {
          continue;
        }
        apiLayer.decorateLocalApi(api, context);
      }
      return api;
    },

    decorateRemoteBlastdoorApi(api, context = {}) {
      for (const plugin of enabledPlugins) {
        const apiLayer = plugin.api;
        if (!apiLayer || typeof apiLayer.decorateRemoteApi !== "function") {
          continue;
        }
        apiLayer.decorateRemoteApi(api, context);
      }
      return api;
    },

    registerApiServerRoutes(context = {}) {
      for (const plugin of enabledPlugins) {
        const apiLayer = plugin.api;
        if (!apiLayer || typeof apiLayer.registerApiServerRoutes !== "function") {
          continue;
        }
        apiLayer.registerApiServerRoutes(context);
      }
    },

    registerManagerRoutes(context = {}) {
      for (const plugin of enabledPlugins) {
        const managerLayer = plugin.manager;
        if (!managerLayer || typeof managerLayer.registerRoutes !== "function") {
          continue;
        }
        managerLayer.registerRoutes(context);
      }
    },

    getManagerDiagnosticsSummaryLines(config = {}) {
      const lines = [];
      for (const plugin of enabledPlugins) {
        const managerConfig = plugin.managerConfig;
        if (!managerConfig || typeof managerConfig.diagnosticsSummaryLines !== "function") {
          continue;
        }
        const pluginLines = managerConfig.diagnosticsSummaryLines(config);
        if (Array.isArray(pluginLines)) {
          lines.push(...pluginLines);
        }
      }
      return lines;
    },

    getManagerUiAssets() {
      const assets = [];
      for (const plugin of enabledPlugins) {
        const managerConfig = plugin.managerConfig;
        if (!managerConfig || typeof managerConfig.uiAssets !== "function") {
          continue;
        }
        const pluginAssets = managerConfig.uiAssets();
        if (Array.isArray(pluginAssets)) {
          assets.push(...pluginAssets);
        }
      }
      return assets;
    },
  };
}
