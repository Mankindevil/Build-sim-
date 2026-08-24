import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDeepSeekConfig } from "../../scripts/deepseek/config.mjs";
import type { DeepSeekAgentConfig } from "../agent/providers/deepseek";

function boolEnv(value: unknown, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) return false;
  throw new Error("BUILD_SIM_AGENT_ENABLED must be true or false");
}

async function loadServerEnv(): Promise<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = {};
  for (const file of [".env.local", ".env"]) {
    try {
      const raw = await readFile(path.resolve(process.cwd(), file), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const value = line.trim();
        if (!value || value.startsWith("#")) continue;
        const separator = value.indexOf("=");
        if (separator < 0) continue;
        const key = value.slice(0, separator).trim();
        if (env[key] !== undefined) continue;
        env[key] = value.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
      }
    } catch {
      // Local env files are optional; safe defaults keep the Agent disabled.
    }
  }
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return env;
}

export function parseAgentRuntimeConfig(env: Record<string, string | undefined>): { enabled: boolean; port: number; deepseek: DeepSeekAgentConfig } {
  const enabled = boolEnv(env.BUILD_SIM_AGENT_ENABLED, false);
  const deepseek = parseDeepSeekConfig(env) as DeepSeekAgentConfig;
  const port = Number(env.AGENT_SERVER_PORT ?? 5175);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_SERVER_PORT must be an integer between 1 and 65535");
  return { enabled, port, deepseek: { ...deepseek, enabled: enabled && deepseek.enabled } };
}

export async function loadAgentRuntimeConfig(): Promise<{ enabled: boolean; port: number; deepseek: DeepSeekAgentConfig }> {
  return parseAgentRuntimeConfig(await loadServerEnv());
}
