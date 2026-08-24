import { loadEnv } from "../price-server/env.mjs";

function boolEnv(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(String(raw).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(String(raw).toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

/** Server-side rollout switches. Safe defaults keep the existing app read-only. */
export async function loadRuntimeFlags(envOverride) {
  const env = envOverride ?? await loadEnv();
  return Object.freeze({
    catalogWriteEnabled: boolEnv(env, "BUILD_SIM_CATALOG_WRITE_ENABLED", false),
    adviceEnabled: boolEnv(env, "BUILD_SIM_ADVICE_ENABLED", false),
  });
}
