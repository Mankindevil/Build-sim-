import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import type { ProviderAdapter, ProviderTurnRequest } from "../src/agent/contracts";
import { AgentRuntime } from "../src/agent/runtime";
import { MemoryAgentSessionStore } from "../src/agent/session-store";
import { AgentSkillLoader } from "../src/agent/skill-loader";
import { AgentToolRegistry } from "../src/agent/tool-registry";
import { createBuildSimTools } from "../src/server/domain-tools";

function registry(): AgentToolRegistry {
  return new AgentToolRegistry(createBuildSimTools());
}

describe("A4 Agent Skill loader", () => {
  it("discovers six metadata-only catalog entries and loads instructions on activation", async () => {
    const loader = new AgentSkillLoader(path.resolve("skills"), registry());
    const catalog = await loader.catalog();
    expect(catalog.map((entry) => entry.manifest.id)).toEqual([
      "assembly-and-wiring", "build-diagnosis", "geometry-evidence-audit", "plan-initializer", "shopping-research", "upgrade-advisor",
    ]);
    expect(catalog.every((entry) => /^[a-f0-9]{64}$/.test(entry.definitionHash))).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain("装机诊断工作流");

    const loaded = await loader.load("build-diagnosis");
    expect(loaded.instructions).toContain("装机诊断工作流");
    expect(loaded.definitionHash).toBe(catalog.find((entry) => entry.manifest.id === "build-diagnosis")?.definitionHash);
    const shopping = await loader.load("shopping-research");
    expect(shopping.manifest).toMatchObject({ version: "1.3.0", readOnly: true });
    expect(shopping.manifest.allowedTools).toEqual(expect.arrayContaining(["search_catalog_skus", "propose_catalog_review", "propose_plan_change"]));
    expect(shopping.manifest.allowedTools).not.toContain("enrich_official_catalog");
    const initializer = await loader.load("plan-initializer");
    expect(initializer.manifest).toMatchObject({ version: "1.1.0", readOnly: true });
    expect(initializer.manifest.allowedTools).toContain("propose_catalog_review");
    const audit = await loader.load("geometry-evidence-audit");
    expect(audit.manifest).toMatchObject({ version: "1.3.0", readOnly: true });
    expect(audit.manifest.allowedTools).toEqual(["get_build_evaluation", "get_sku_facts", "get_evidence_document", "get_evidence_excerpt", "discover_official_documents", "search_official_catalog"]);
    expect(audit.instructions).toContain("c.z + d/2");
    expect(audit.instructions).toContain("contentTrust=untrusted-evidence-text");
    expect(audit.instructions).toContain("发现结果还不是已归档证据");
  });

  it("rejects unknown Tools before a Skill can enter the catalog", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-invalid-skill-"));
    await mkdir(path.join(root, "invalid"));
    await writeFile(path.join(root, "invalid", "SKILL.md"), `---\ncontractVersion: "1.0.0"\nid: invalid\nname: Invalid\nversion: "1.0.0"\ndescription: This manifest intentionally references a Tool that is not registered.\nallowedTools:\n  - missing_tool\nreadOnly: true\ncontextBudget: 2000\ntriggers:\n  - invalid\n---\n\nDo not load.\n`);
    await expect(new AgentSkillLoader(root, registry()).catalog()).rejects.toThrow("unknown tool: missing_tool");
  });

  it("detects Skill body changes between discovery and activation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-changing-skill-"));
    const folder = path.join(root, "changing");
    const file = path.join(folder, "SKILL.md");
    await mkdir(folder);
    const manifest = `---\ncontractVersion: "1.0.0"\nid: changing\nname: Changing\nversion: "1.0.0"\ndescription: This fixture verifies definition integrity across lazy Skill activation.\nallowedTools:\n  - get_build_evaluation\nreadOnly: true\ncontextBudget: 2000\ntriggers:\n  - change\n---\n\n`;
    await writeFile(file, `${manifest}Original instructions.`);
    const loader = new AgentSkillLoader(root, registry());
    await loader.catalog();
    await writeFile(file, `${manifest}Changed instructions.`);
    await expect(loader.load("changing")).rejects.toThrow("changed after discovery");
  });
});

describe("A4 Skill-scoped Tool runtime", () => {
  it("injects one activated Skill and enforces allowedTools in definitions and dispatch", async () => {
    const requests: ProviderTurnRequest[] = [];
    const provider: ProviderAdapter = {
      id: "deepseek",
      models: [{ provider: "deepseek", id: "deepseek-v4-flash", label: "fixture", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true } }],
      async createTurn(request) {
        requests.push(request);
        if (requests.length === 1) {
          expect(request.system).toContain("Active Skill (build-diagnosis@1.0.0)");
          expect(request.tools.map((tool) => tool.name).sort()).toEqual(["get_build_evaluation", "get_sku_facts", "propose_plan_change"]);
          return { provider: "deepseek", providerRequestId: "p1", model: request.model, content: "", toolCalls: [{ id: "forbidden", name: "search_price_candidates", input: { skuIds: ["case.jonsbo-n6"] } }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, latencyMs: 1 };
        }
        expect(JSON.parse(request.messages.at(-1)?.content ?? "{}")).toMatchObject({ ok: false, errorCode: "tool_not_allowed" });
        return { provider: "deepseek", providerRequestId: "p2", model: request.model, content: "已阻止越权 Tool。", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, latencyMs: 1 };
      },
    };
    const tools = registry();
    const runtime = new AgentRuntime([provider], new MemoryAgentSessionStore(), {
      toolRegistry: tools,
      skillLoader: new AgentSkillLoader(path.resolve("skills"), tools),
    });
    const session = await runtime.createSession();
    const run = await runtime.startRun(session.id, { content: "诊断当前配置", buildConfig: baseline as never, skillId: "build-diagnosis" });
    await runtime.waitForRun(run.runId);
    expect(runtime.getRun(run.runId).status).toBe("completed");
    expect(runtime.getRun(run.runId).events).toContainEqual(expect.objectContaining({ type: "skill_activated", skillId: "build-diagnosis", definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(runtime.getRun(run.runId).events).toContainEqual(expect.objectContaining({ type: "tool_result", result: expect.objectContaining({ errorCode: "tool_not_allowed" }) }));
  });

  it("rejects an unknown requested Skill before persisting the user message", async () => {
    const tools = registry();
    const provider: ProviderAdapter = {
      id: "deepseek",
      models: [{ provider: "deepseek", id: "deepseek-v4-flash", label: "fixture", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true } }],
      async createTurn() { throw new Error("must not run"); },
    };
    const runtime = new AgentRuntime([provider], new MemoryAgentSessionStore(), { toolRegistry: tools, skillLoader: new AgentSkillLoader(path.resolve("skills"), tools) });
    const session = await runtime.createSession();
    await expect(runtime.startRun(session.id, { content: "test", skillId: "missing" })).rejects.toMatchObject({ code: "skill_not_found", status: 404 });
    expect((await runtime.getSession(session.id)).messages).toEqual([]);
  });

  it("gives shopping research the completed deterministic identity verdict", async () => {
    const requests: ProviderTurnRequest[] = [];
    const provider: ProviderAdapter = {
      id: "deepseek",
      models: [{ provider: "deepseek", id: "deepseek-v4-flash", label: "fixture", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true } }],
      async createTurn(request) {
        requests.push(request);
        if (requests.length === 1) {
          expect(request.system).toContain("`conflict` 不得被模型推翻");
          expect(request.tools.map((tool) => tool.name)).toContain("get_catalog_search_job");
          return { provider: "deepseek", providerRequestId: "identity-1", model: request.model, content: "", toolCalls: [{ id: "identity-search", name: "search_official_catalog", input: { query: "WD Red Plus 8TB", brand: "Western Digital", category: "storage" } }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, latencyMs: 1 };
        }
        const result = JSON.parse(request.messages.at(-1)?.content ?? "{}");
        expect(result.content.candidates[0].identity).toMatchObject({ verdict: "conflict", criticalConflicts: [{ field: "storageTier", input: "plus", candidate: "pro" }] });
        return { provider: "deepseek", providerRequestId: "identity-2", model: request.model, content: "候选是 Red Pro，与 Red Plus 冲突，不能视为同型号。", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, latencyMs: 1 };
      },
    };
    const fetchMock = async (url: string) => new Response(JSON.stringify(url.endsWith("/api/catalog/search")
      ? { jobId: "catalog-search-identity", status: "queued", candidates: [] }
      : { jobId: "catalog-search-identity", status: "completed", candidates: [{ identity: { verdict: "conflict", criticalConflicts: [{ field: "storageTier", input: "plus", candidate: "pro" }] } }], summary: { conflicts: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    const tools = registry();
    const runtime = new AgentRuntime([provider], new MemoryAgentSessionStore(), { toolRegistry: tools, skillLoader: new AgentSkillLoader(path.resolve("skills"), tools) });
    const session = await runtime.createSession();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const run = await runtime.startRun(session.id, { content: "查找 WD Red Plus 8TB", buildConfig: baseline as never, skillId: "shopping-research" });
      await runtime.waitForRun(run.runId);
      expect((await runtime.getSession(session.id)).messages.at(-1)?.content).toContain("不能视为同型号");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
