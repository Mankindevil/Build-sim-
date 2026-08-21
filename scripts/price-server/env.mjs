/** Minimal .env.local reader — keys stay out of git and out of the bundle. */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let cache = null;

export async function loadEnv() {
  if (cache) return cache;
  cache = {};
  for (const file of [".env.local", ".env"]) {
    try {
      const raw = await readFile(path.join(root, file), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!(key in cache)) cache[key] = value;
      }
    } catch {
      /* file absent is normal */
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !(key in cache)) cache[key] = value;
  }
  return cache;
}

export async function hasKeys(...names) {
  const env = await loadEnv();
  return names.every((n) => Boolean(env[n]));
}
