import path from "node:path";
import { parseDeepSeekConfig } from "../../scripts/deepseek/config.mjs";
import { loadEnv } from "../../scripts/price-server/env.mjs";
import type { AgentRunLimits } from "../agent/contracts";
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

function modelList(value: string | undefined, fallback: string[]): string[] {
  const models = (value === undefined || value.trim() === "" ? fallback : value.split(","))
    .map((model) => model.trim())
    .filter(Boolean);
  const unique = [...new Set(models)];
  if (!unique.length || unique.length > 16 || unique.some((model) => !/^[A-Za-z0-9._:/-]{1,200}$/.test(model))) {
    throw new Error("DEEPSEEK_AGENT_MODELS must contain 1 to 16 comma-separated model ids");
  }
  return unique;
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

export interface AgentRuntimeConfig {
  enabled: boolean;
  port: number;
  priceServiceUrl: string;
  requestBodyMaxBytes: number;
  maxMessageChars: number;
  limits: AgentRunLimits;
  sessionRoot: string;
  auditRoot: string;
  skillsRoot: string;
  deepseek: DeepSeekAgentConfig;
  claude: ClaudeAgentConfig;
}

export function parseAgentRuntimeConfig(env: Record<string, string | undefined>): AgentRuntimeConfig {
  const enabled = boolEnv(env.BUILD_SIM_AGENT_ENABLED, false);
  const parsedDeepSeek = parseDeepSeekConfig(env) as DeepSeekAgentConfig;
  const deepseek = {
    ...parsedDeepSeek,
    maxTokens: intEnv(env.DEEPSEEK_AGENT_MAX_TOKENS, 8_192, "DEEPSEEK_AGENT_MAX_TOKENS", 1, 16_384),
    models: modelList(env.DEEPSEEK_AGENT_MODELS, [...new Set([
      parsedDeepSeek.model,
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp",
    ])]),
  };
  const claude = parseClaudeAgentConfig(env, enabled);
  const port = intEnv(env.AGENT_SERVER_PORT, 5175, "AGENT_SERVER_PORT", 1, 65_535);
  const pricePort = intEnv(env.PRICE_SERVER_PORT, 5174, "PRICE_SERVER_PORT", 1, 65_535);
  return {
    enabled,
    port,
    priceServiceUrl: `http://127.0.0.1:${pricePort}`,
    requestBodyMaxBytes: intEnv(env.AGENT_REQUEST_BODY_MAX_BYTES, 1_000_000, "AGENT_REQUEST_BODY_MAX_BYTES", 1_024, 5_000_000),
    maxMessageChars: intEnv(env.AGENT_MAX_MESSAGE_CHARS, 20_000, "AGENT_MAX_MESSAGE_CHARS", 1, 100_000),
    limits: {
      maxModelTurns: intEnv(env.AGENT_MAX_MODEL_TURNS, 8, "AGENT_MAX_MODEL_TURNS", 1, 32),
      maxToolCalls: intEnv(env.AGENT_MAX_TOOL_CALLS, 12, "AGENT_MAX_TOOL_CALLS", 0, 64),
      maxRepeatedToolCalls: intEnv(env.AGENT_MAX_REPEATED_TOOL_CALLS, 2, "AGENT_MAX_REPEATED_TOOL_CALLS", 1, 8),
      maxToolResultBytes: intEnv(env.AGENT_MAX_TOOL_RESULT_BYTES, 160_000, "AGENT_MAX_TOOL_RESULT_BYTES", 1_024, 1_000_000),
    },
    sessionRoot: path.resolve(env.AGENT_SESSION_ROOT || "data/agent/sessions"),
    auditRoot: path.resolve(env.AGENT_AUDIT_ROOT || "data/agent/audit"),
    skillsRoot: path.resolve(env.BUILD_SIM_SKILLS_ROOT || "skills"),
    deepseek: { ...deepseek, enabled: enabled && deepseek.enabled },
    claude,
  };
}

export async function loadAgentRuntimeConfig(): Promise<AgentRuntimeConfig> {
  return parseAgentRuntimeConfig(await loadEnv() as Record<string, string | undefined>);
}
