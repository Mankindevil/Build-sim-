import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULTS = Object.freeze({
  apiUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  timeoutMs: 30_000,
  maxTokens: 1_200,
  temperature: 0.2,
});

function numberEnv(env, name, fallback, { min, max, integer = false } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    throw new Error(`${name} must be a ${integer ? "integer" : "number"} between ${min} and ${max}`);
  }
  return value;
}

function boolEnv(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function httpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DEEPSEEK_API_URL must be a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("DEEPSEEK_API_URL must use http or https");
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * Server-only DeepSeek configuration. The key is intentionally never read by
 * Vite client code and is not included in logs or serialized API responses.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function parseDeepSeekConfig(env) {
  const enabled = boolEnv(env, "DEEPSEEK_ENABLED", false);
  const apiKey = env.DEEPSEEK_API_KEY?.trim() || "";
  if (enabled && !apiKey) {
    throw new Error("DEEPSEEK_API_KEY is required when DEEPSEEK_ENABLED=true");
  }

  return {
    enabled,
    apiKey,
    apiUrl: httpUrl(env.DEEPSEEK_API_URL || DEFAULTS.apiUrl),
    model: env.DEEPSEEK_MODEL?.trim() || DEFAULTS.model,
    timeoutMs: numberEnv(env, "DEEPSEEK_TIMEOUT_MS", DEFAULTS.timeoutMs, {
      min: 1_000,
      max: 120_000,
      integer: true,
    }),
    maxTokens: numberEnv(env, "DEEPSEEK_MAX_TOKENS", DEFAULTS.maxTokens, {
      min: 1,
      max: 16_384,
      integer: true,
    }),
    temperature: numberEnv(env, "DEEPSEEK_TEMPERATURE", DEFAULTS.temperature, {
      min: 0,
      max: 2,
    }),
  };
}

/** DeepSeek values are intentionally isolated from the generic process loader. */
export async function loadDeepSeekConfig() {
  const env = {};
  try {
    const raw = await readFile(path.join(ROOT, ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      env[key] = value;
    }
  } catch {
    /* Missing .env.local means the feature stays disabled. */
  }
  return parseDeepSeekConfig(env);
}
