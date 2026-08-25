/** Server-only env loader. Values are merged per key, never shipped to the browser. */

import { readFile } from "node:fs/promises";
import path from "node:path";

const ENV_FILES = [".env.local", ".env", ".env.example"];
let cache = null;

export function resetEnvCache() {
  cache = null;
}

/**
 * Per-key precedence: process.env > .env.local > .env > .env.example.
 * An explicitly empty value is still a value and intentionally blocks fallback.
 */
export async function loadEnv(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const processEnv = options.processEnv ?? process.env;
  const useCache = options.rootDir === undefined && options.processEnv === undefined;
  if (useCache && cache) return cache;
  const resolved = {};
  for (const file of ENV_FILES) {
    try {
      const raw = await readFile(path.join(rootDir, file), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!(key in resolved)) resolved[key] = value;
      }
    } catch {
      /* file absent is normal */
    }
  }
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) resolved[key] = String(value);
  }
  if (useCache) cache = Object.freeze(resolved);
  return useCache ? cache : Object.freeze(resolved);
}

export function boolEnv(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(String(raw).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(String(raw).toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

export function intEnv(env, name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export async function hasKeys(...names) {
  const env = await loadEnv();
  return names.every((n) => Boolean(env[n]));
}
