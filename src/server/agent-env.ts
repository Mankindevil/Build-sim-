import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDeepSeekConfig } from "../../scripts/deepseek/config.mjs";
import type { DeepSeekAgentConfig } from "../agent/providers/deepseek";
import type { ClaudeAgentConfig } from "../agent/providers/claude";

function boolEnv(value: unknown, fallback = false, name = "BUILD_SIM_AGENT_ENABLED"): boolean {
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function intEnv(value: unknown, fallback: number, name: string, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}

function numberEnv(value: unknown, fallback: number, name: string, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be a number between ${minimum} and ${maximum}`);
  return parsed;
}

function httpUrl(value: string, name: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid HTTP(S) URL`); }
  if (!(["http:", "https:"] as const).includes(url.protocol as "http:" | "https:")) throw new Error(`${name} must use http or https`);
  return url.toString().replace(/\/$/, "");
}

export function parseClaudeAgentConfig(env: Record<string, string | undefined>, agentEnabled = false): ClaudeAgentConfig {
  const requested = boolEnv(env.CLAUDE_ENABLED, false, "CLAUDE_ENABLED");
  const apiKey = env.CLAUDE_API_KEY?.trim() ?? "";
  if (requested && !apiKey) throw new Error("CLAUDE_API_KEY is required when CLAUDE_ENABLED=true");
  return {
    enabled: agentEnabled && requested,
    apiKey,
    apiUrl: httpUrl(env.CLAUDE_API_URL || "https://api.anthropic.com", "CLAUDE_API_URL"),
    model: env.CLAUDE_MODEL?.trim() || "claude-sonnet-4-20250514",
    timeoutMs: intEnv(env.CLAUDE_TIMEOUT_MS, 30_000, "CLAUDE_TIMEOUT_MS", 1_000, 120_000),
    maxTokens: intEnv(env.CLAUDE_MAX_TOKENS, 1_200, "CLAUDE_MAX_TOKENS", 1, 16_384),
    temperature: numberEnv(env.CLAUDE_TEMPERATURE, 0.2, "CLAUDE_TEMPERATURE", 0, 1),
  };
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

export function parseAgentRuntimeConfig(env: Record<string, string | undefined>): { enabled: boolean; port: number; deepseek: DeepSeekAgentConfig; claude: ClaudeAgentConfig } {
  const enabled = boolEnv(env.BUILD_SIM_AGENT_ENABLED, false);
  const deepseek = parseDeepSeekConfig(env) as DeepSeekAgentConfig;
  const claude = parseClaudeAgentConfig(env, enabled);
  const port = Number(env.AGENT_SERVER_PORT ?? 5175);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_SERVER_PORT must be an integer between 1 and 65535");
  return { enabled, port, deepseek: { ...deepseek, enabled: enabled && deepseek.enabled }, claude };
}

export async function loadAgentRuntimeConfig(): Promise<{ enabled: boolean; port: number; deepseek: DeepSeekAgentConfig; claude: ClaudeAgentConfig }> {
  return parseAgentRuntimeConfig(await loadServerEnv());
}
