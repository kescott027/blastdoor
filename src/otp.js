import * as otplib from "otplib";

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveAuthenticatorV13Adapter() {
  if (typeof otplib.generateSecret !== "function") {
    return null;
  }
  if (typeof otplib.generateSync !== "function") {
    return null;
  }
  if (typeof otplib.verifySync !== "function") {
    return null;
  }

  const optionsState = {
    window: 1,
    step: 30,
  };

  return {
    get options() {
      return { ...optionsState };
    },

    set options(value) {
      if (!value || typeof value !== "object") {
        return;
      }

      optionsState.window = normalizePositiveInteger(value.window, optionsState.window);
      optionsState.step = normalizePositiveInteger(value.step ?? value.period, optionsState.step);
    },

    generateSecret(length) {
      const safeLength = normalizePositiveInteger(length, 20);
      return otplib.generateSecret({ length: safeLength });
    },

    generate(secret) {
      return otplib.generateSync({
        secret,
        period: optionsState.step,
      });
    },

    check(token, secret) {
      const result = otplib.verifySync({
        secret,
        token,
        period: optionsState.step,
        epochTolerance: optionsState.window * optionsState.step,
      });
      return Boolean(result?.valid ?? result);
    },
  };
}

const resolvedAuthenticator =
  otplib?.authenticator ??
  otplib?.default?.authenticator ??
  resolveAuthenticatorV13Adapter();

if (!resolvedAuthenticator) {
  throw new Error("Failed to load otplib authenticator export. Check installed otplib version.");
}

export const authenticator = resolvedAuthenticator;
