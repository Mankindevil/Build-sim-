import { describe, expect, it } from "vitest";
import { AGENT_CONTRACT_VERSION, type AgentSkillManifest, type AgentToolSpec, type ProviderModel } from "../src/agent/contracts";
import { stableDefinition, validateProviderModel, validateSkillManifest, validateToolSpec } from "../src/agent/contract-validation";

const execute: AgentToolSpec["execute"] = async () => ({ ok: true, content: {}, provenance: [] });

function tool(overrides: Partial<AgentToolSpec> = {}): AgentToolSpec {
  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    name: "get_build_evaluation",
    title: "读取当前装机评估",
    description: "从服务端确定性引擎读取当前装机配置的权威评估，不生成或修改任何事实。",
    effect: "read",
    approval: "never",
    timeoutMs: 5_000,
    maxResultBytes: 20_000,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute,
    ...overrides,
  };
}

function skill(overrides: Partial<AgentSkillManifest> = {}): AgentSkillManifest {
  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    id: "build-diagnosis",
    name: "装机诊断",
    version: "1.0.0",
    description: "使用确定性装机评估和 SKU 证据解释当前配置的阻断、风险和未知项。",
    allowedTools: ["get_build_evaluation"],
    readOnly: true,
    contextBudget: 12_000,
    triggers: ["诊断", "为什么"],
    ...overrides,
  };
}

describe("A0 agent contracts", () => {
  it("accepts the provider-neutral DeepSeek model contract", () => {
    const model: ProviderModel = {
      provider: "deepseek",
      id: "deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true },
    };
    expect(validateProviderModel(model)).toEqual([]);
  });

  it("requires strict schemas and approval for every write tool", () => {
    expect(validateToolSpec(tool())).toEqual([]);
    expect(validateToolSpec(tool({ effect: "write", name: "apply_build_patch" }))).toContain("write tool requires approval");
    expect(validateToolSpec(tool({ inputSchema: { type: "object" } }))).toContain("tool.inputSchema must reject additional properties");
  });

  it("rejects unknown tools and write-like tools from a read-only skill", () => {
    expect(validateSkillManifest(skill(), new Set(["get_build_evaluation"]))).toEqual([]);
    expect(validateSkillManifest(skill({ allowedTools: ["unknown_tool"] }), new Set())).toContain("skill references unknown tool: unknown_tool");
    expect(validateSkillManifest(skill({ allowedTools: ["apply_build_patch"] }), new Set(["apply_build_patch"]))).toContain("read-only skill declares a write-like tool");
  });

  it("canonicalizes definitions without executable functions or key-order drift", () => {
    expect(stableDefinition(tool())).toBe(stableDefinition({ ...tool(), inputSchema: { additionalProperties: false, properties: {}, type: "object" } }));
    expect(stableDefinition(tool())).not.toContain("execute");
  });
});

