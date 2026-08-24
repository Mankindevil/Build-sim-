import {
  AGENT_CONTRACT_VERSION,
  type AgentSkillManifest,
  type AgentToolSpec,
  type ProviderModel,
} from "./contracts";

const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

export function validateProviderModel(model: ProviderModel): string[] {
  const errors: string[] = [];
  if (!ID.test(model.id)) errors.push("model.id invalid");
  if (!model.label.trim()) errors.push("model.label missing");
  if (model.provider !== "deepseek" && model.provider !== "claude") errors.push("model.provider invalid");
  if (!model.capabilities || typeof model.capabilities !== "object") errors.push("model.capabilities missing");
  return errors;
}

export function validateToolSpec(tool: AgentToolSpec): string[] {
  const errors: string[] = [];
  if (tool.contractVersion !== AGENT_CONTRACT_VERSION) errors.push("tool.contractVersion invalid");
  if (!TOOL_NAME.test(tool.name)) errors.push("tool.name invalid");
  if (!tool.title.trim()) errors.push("tool.title missing");
  if (tool.description.trim().length < 20) errors.push("tool.description too short");
  if (!(["read", "external-read", "write"] as const).includes(tool.effect)) errors.push("tool.effect invalid");
  if (tool.effect === "write" && tool.approval !== "required") errors.push("write tool requires approval");
  if (tool.effect !== "write" && tool.approval !== "never") errors.push("read tool cannot require approval");
  if (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 100 || tool.timeoutMs > 120_000) errors.push("tool.timeoutMs invalid");
  if (!Number.isInteger(tool.maxResultBytes) || tool.maxResultBytes < 256 || tool.maxResultBytes > 1_000_000) errors.push("tool.maxResultBytes invalid");
  if (tool.inputSchema?.type !== "object") errors.push("tool.inputSchema must be an object schema");
  if (tool.inputSchema?.additionalProperties !== false) errors.push("tool.inputSchema must reject additional properties");
  if (typeof tool.execute !== "function") errors.push("tool.execute missing");
  return [...new Set(errors)];
}

export function validateSkillManifest(skill: AgentSkillManifest, registeredTools: Set<string>): string[] {
  const errors: string[] = [];
  if (skill.contractVersion !== AGENT_CONTRACT_VERSION) errors.push("skill.contractVersion invalid");
  if (!ID.test(skill.id)) errors.push("skill.id invalid");
  if (!SEMVER.test(skill.version)) errors.push("skill.version invalid");
  if (!skill.name.trim()) errors.push("skill.name missing");
  if (skill.description.trim().length < 20) errors.push("skill.description too short");
  if (!Number.isInteger(skill.contextBudget) || skill.contextBudget < 1_000 || skill.contextBudget > 100_000) errors.push("skill.contextBudget invalid");
  if (!Array.isArray(skill.allowedTools) || new Set(skill.allowedTools).size !== skill.allowedTools.length) errors.push("skill.allowedTools invalid");
  for (const name of skill.allowedTools ?? []) {
    if (!registeredTools.has(name)) errors.push(`skill references unknown tool: ${name}`);
  }
  if (skill.readOnly && skill.allowedTools.some((name) => name.startsWith("apply_") || name.startsWith("accept_") || name.startsWith("confirm_") || name.startsWith("record_"))) {
    errors.push("read-only skill declares a write-like tool");
  }
  return [...new Set(errors)];
}

export function stableDefinition(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableDefinition).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && typeof item !== "function")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableDefinition(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

