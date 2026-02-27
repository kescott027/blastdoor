import nodemailer from "nodemailer";

function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function normalizeProvider(value) {
  const provider = normalizeString(value, "disabled").toLowerCase();
  if (provider === "smtp" || provider === "console" || provider === "disabled") {
    return provider;
  }
  return "disabled";
}

function withTrailingSlashRemoved(value) {
  return String(value || "").replace(/\/+$/, "");
}

function formatExpiry(expiresAt) {
  const parsed = new Date(expiresAt);
  if (!Number.isFinite(parsed.getTime())) {
    return expiresAt;
  }
  return parsed.toUTCString();
}

export function loadEmailConfigFromEnv(env = process.env) {
  return {
    provider: normalizeProvider(env.EMAIL_PROVIDER || "disabled"),
    from: normalizeString(env.EMAIL_FROM, ""),
    adminTo: normalizeString(env.EMAIL_ADMIN_TO, ""),
    publicBaseUrl: withTrailingSlashRemoved(normalizeString(env.PUBLIC_BASE_URL, "")),
    smtpHost: normalizeString(env.SMTP_HOST, ""),
    smtpPort: toInteger(env.SMTP_PORT, 587),
    smtpSecure: parseBoolean(env.SMTP_SECURE, false),
    smtpUser: normalizeString(env.SMTP_USER, ""),
    smtpPass: normalizeString(env.SMTP_PASS, ""),
    smtpIgnoreTls: parseBoolean(env.SMTP_IGNORE_TLS, false),
  };
}

export function createEmailService(rawConfig = {}, options = {}) {
  const logger = options.logger || null;
  const config = {
    ...loadEmailConfigFromEnv({}),
    ...rawConfig,
  };
  config.provider = normalizeProvider(config.provider);
  config.publicBaseUrl = withTrailingSlashRemoved(config.publicBaseUrl);

  let transport = null;

  function logInfo(event, payload) {
    if (typeof logger?.info === "function") {
      logger.info(event, payload);
    }
  }

  function logWarn(event, payload) {
    if (typeof logger?.warn === "function") {
      logger.warn(event, payload);
    }
  }

  function getTransport() {
    if (transport) {
      return transport;
    }

    transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth:
        config.smtpUser || config.smtpPass
          ? {
              user: config.smtpUser || "",
              pass: config.smtpPass || "",
            }
          : undefined,
      ignoreTLS: config.smtpIgnoreTls,
    });
    return transport;
  }

  async function sendMail({ to, subject, text, html }) {
    const toAddress = normalizeString(to, "");
    if (!toAddress) {
      return {
        ok: false,
        status: "skipped",
        reason: "missing-recipient",
      };
    }

    if (config.provider === "disabled") {
      return {
        ok: false,
        status: "disabled",
        reason: "provider-disabled",
      };
    }

    if (config.provider === "console") {
      logInfo("email.console_dispatch", {
        to: toAddress,
        subject: normalizeString(subject, ""),
      });
      return {
        ok: true,
        status: "sent",
        provider: "console",
        messageId: "console",
      };
    }

    if (config.provider !== "smtp") {
      return {
        ok: false,
        status: "disabled",
        reason: "unsupported-provider",
      };
    }

    if (!config.from || !config.smtpHost) {
      return {
        ok: false,
        status: "disabled",
        reason: "smtp-missing-config",
      };
    }

    try {
      const info = await getTransport().sendMail({
        from: config.from,
        to: toAddress,
        subject: normalizeString(subject, "Blastdoor notification"),
        text: normalizeString(text, ""),
        html: normalizeString(html, "") || undefined,
      });

      return {
        ok: true,
        status: "sent",
        provider: "smtp",
        messageId: normalizeString(info?.messageId, ""),
      };
    } catch (error) {
      logWarn("email.smtp_send_failed", {
        to: toAddress,
        subject: normalizeString(subject, ""),
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return {
        ok: false,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function resolveLoginUrl(loginUrlPath = "/login") {
    if (!config.publicBaseUrl) {
      return loginUrlPath;
    }

    if (String(loginUrlPath).startsWith("http://") || String(loginUrlPath).startsWith("https://")) {
      return String(loginUrlPath);
    }

    const pathValue = String(loginUrlPath || "/login");
    if (pathValue.startsWith("/")) {
      return `${config.publicBaseUrl}${pathValue}`;
    }
    return `${config.publicBaseUrl}/${pathValue}`;
  }

  return {
    async sendTemporaryLoginCode({ to, username, code, expiresAt, loginUrlPath = "/login" }) {
      const subject = "Blastdoor Temporary Login Code";
      const loginUrl = resolveLoginUrl(loginUrlPath);
      const text = [
        `Hello ${normalizeString(username, "player")},`,
        "",
        "A temporary Blastdoor login code was issued for your account.",
        "",
        `Temporary code: ${normalizeString(code, "")}`,
        `Expires: ${formatExpiry(expiresAt)}`,
        `Login: ${loginUrl}`,
        "",
        "After login, update your account password immediately.",
      ].join("\n");

      return sendMail({ to, subject, text });
    },

    async sendAdminMessage({ fromUsername, fromEmail, subject, message }) {
      const adminTo = normalizeString(config.adminTo, "");
      if (!adminTo) {
        return {
          ok: false,
          status: "disabled",
          reason: "missing-admin-recipient",
        };
      }

      const mailSubject = normalizeString(subject, "") || `Blastdoor message from ${normalizeString(fromUsername, "user")}`;
      const text = [
        "Blastdoor user message",
        `From: ${normalizeString(fromUsername, "unknown")}`,
        `Email: ${normalizeString(fromEmail, "not provided") || "not provided"}`,
        "",
        normalizeString(message, ""),
      ].join("\n");

      return sendMail({
        to: adminTo,
        subject: mailSubject,
        text,
      });
    },

    async close() {
      if (transport && typeof transport.close === "function") {
        transport.close();
      }
      transport = null;
    },
  };
}
