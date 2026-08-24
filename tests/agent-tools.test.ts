import { describe, expect, it, vi } from "vitest";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import { AGENT_CONTRACT_VERSION, type AgentToolContext, type AgentToolSpec, type ProviderAdapter } from "../src/agent/contracts";
import { AgentRuntime } from "../src/agent/runtime";
import { MemoryAgentSessionStore } from "../src/agent/session-store";
import { AgentToolRegistry } from "../src/agent/tool-registry";
import { createBuildSimTools } from "../src/server/domain-tools";

function context(): AgentToolContext {
  return { sessionId: "session-fixture", runId: "run-fixture", buildConfig: baseline as never, signal: new AbortController().signal };
}

describe("A3 Build Sim Tool registry", () => {
  it("registers governed read/external-read tools and one approval-bound write tool", () => {
    const registry = new AgentToolRegistry(createBuildSimTools());
    expect(registry.names()).toEqual([
      "compare_builds", "enrich_official_catalog", "get_build_evaluation", "get_price_snapshot", "get_sku_facts", "inspect_catalog_candidate", "list_official_domain_proposals", "search_official_catalog", "search_price_candidates",
    ]);
    expect(registry.catalog()).toHaveLength(9);
    expect(registry.catalog().every((tool) => /^[a-f0-9]{64}$/.test(tool.definitionHash))).toBe(true);
    expect(registry.catalog().filter((tool) => tool.effect === "write")).toEqual([expect.objectContaining({ name: "enrich_official_catalog", approval: "required" })]);
  });

  it("returns bounded authoritative evaluation projections and rejects schema drift", async () => {
    const registry = new AgentToolRegistry(createBuildSimTools());
    const valid = await registry.dispatch("get_build_evaluation", { sections: ["findings", "calibration"] }, context());
    expect(valid.result.ok).toBe(true);
    expect(valid.result.content).toMatchObject({ verdict: "bad", sections: { calibration: { hash: expect.stringMatching(/^fnv1a-/) } } });
    const invalid = await registry.dispatch("get_build_evaluation", { sections: ["findings"], invented: true }, context());
    expect(invalid.result).toMatchObject({ ok: false, errorCode: "tool_input_invalid" });
  });

  it("compares a candidate copy without mutating the active BuildConfig", async () => {
    const registry = new AgentToolRegistry(createBuildSimTools());
    const before = structuredClone(baseline);
    const compared = await registry.dispatch("compare_builds", { selectionPatch: { diskCount: 4 } }, context());
    expect(compared.result.ok).toBe(true);
    expect(compared.result.content).toMatchObject({ selectionPatch: { diskCount: 4 }, baseline: { evaluationHash: expect.stringMatching(/^[a-f0-9]{64}$/) }, candidate: { evaluationHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(baseline).toEqual(before);
  });

  it("keeps SKU facts and audited snapshots distinct from external candidates", async () => {
    const registry = new AgentToolRegistry(createBuildSimTools());
    const facts = await registry.dispatch("get_sku_facts", { skuIds: ["case.jonsbo-n6", "sku.unknown"], fields: ["identity", "price", "provenance"] }, context());
    expect(facts.result.content).toMatchObject({ records: [{ skuId: "case.jonsbo-n6", status: "found" }, { skuId: "sku.unknown", status: "unknown-sku" }] });
    const prices = await registry.dispatch("get_price_snapshot", { skuIds: ["case.jonsbo-n6"] }, context());
    expect(prices.result.content).toMatchObject({ asOf: "2026-08-21", quotes: [{ skuId: "case.jonsbo-n6", evidence: "audited" }] });
  });

  it("routes external reads only through the fixed local service", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ status: "queued", candidates: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const registry = new AgentToolRegistry(createBuildSimTools());
    expect((await registry.dispatch("search_official_catalog", { query: "ASUS W680M", limit: 3 }, context())).result.ok).toBe(true);
    expect((await registry.dispatch("list_official_domain_proposals", {}, context())).result.ok).toBe(true);
    expect((await registry.dispatch("inspect_catalog_candidate", { url: "http://127.0.0.1/private" }, context())).result).toMatchObject({ ok: false, errorCode: "tool_input_invalid" });
    expect((await registry.dispatch("search_price_candidates", { skuIds: ["case.jonsbo-n6"], channels: ["official"], limit: 1 }, context())).result.ok).toBe(true);
    expect(calls).toEqual([
      { url: "http://127.0.0.1:5174/api/catalog/search", body: { query: "ASUS W680M", limit: 3, officialOnly: true } },
      { url: "http://127.0.0.1:5174/api/catalog/domain-proposals", body: null },
      { url: "http://127.0.0.1:5174/api/price/collect", body: { skuIds: ["case.jonsbo-n6"], channels: ["official"], limit: 1 } },
    ]);
    vi.unstubAllGlobals();
  });

  it("bounds timeout and oversized results in the dispatcher", async () => {
    const spec = (name: string, execute: AgentToolSpec["execute"], timeoutMs = 1_000): AgentToolSpec => ({
      contractVersion: AGENT_CONTRACT_VERSION, name, title: name, description: "A sufficiently detailed fixture Tool description for dispatcher boundary tests.", effect: "read", approval: "never", timeoutMs, maxResultBytes: 256,
      inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute,
    });
    const registry = new AgentToolRegistry([
      spec("slow_tool", async (_input, toolContext) => { await new Promise<void>((resolve) => toolContext.signal.addEventListener("abort", () => resolve(), { once: true })); return { ok: true, content: {}, provenance: [] }; }, 100),
      spec("large_tool", async () => ({ ok: true, content: { text: "x".repeat(1_000) }, provenance: ["fixture"] })),
    ]);
    expect((await registry.dispatch("slow_tool", {}, context())).result).toMatchObject({ ok: false, errorCode: "tool_timeout" });
    expect((await registry.dispatch("large_tool", {}, context())).result).toMatchObject({ ok: false, errorCode: "tool_result_too_large", truncated: true });
  });
});

describe("A3 Agent Tool loop", () => {
  it("executes a model-selected Tool and returns its result for a final turn", async () => {
    const requests: Parameters<ProviderAdapter["createTurn"]>[0][] = [];
    const provider: ProviderAdapter = {
      id: "deepseek",
      models: [{ provider: "deepseek", id: "deepseek-v4-flash", label: "fixture", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true } }],
      async createTurn(request) {
        requests.push(request);
        if (requests.length === 1) return { provider: "deepseek", providerRequestId: "p1", model: request.model, content: "", toolCalls: [{ id: "call-1", name: "get_build_evaluation", input: { sections: ["findings"] } }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 1, reasoningTokens: 0 }, latencyMs: 1 };
        const toolMessage = request.messages.at(-1);
        expect(toolMessage).toMatchObject({ role: "tool", toolCallId: "call-1", toolName: "get_build_evaluation" });
        expect(JSON.parse(toolMessage?.content ?? "{}")).toMatchObject({ ok: true, content: { verdict: "bad" } });
        request.onTextDelta?.("当前存在阻断。");
        return { provider: "deepseek", providerRequestId: "p2", model: request.model, content: "当前存在阻断。", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 0 }, latencyMs: 1 };
      },
    };
    const runtime = new AgentRuntime([provider], new MemoryAgentSessionStore(), { toolRegistry: new AgentToolRegistry(createBuildSimTools()) });
    const session = await runtime.createSession();
    const run = await runtime.startRun(session.id, { content: "诊断当前配置", buildConfig: baseline as never });
    await runtime.waitForRun(run.runId);
    expect(runtime.getRun(run.runId).status).toBe("completed");
    expect(runtime.getRun(run.runId).events.map((event) => event.type)).toContain("tool_call");
    expect(runtime.getRun(run.runId).events.map((event) => event.type)).toContain("tool_result");
    expect((await runtime.getSession(session.id)).messages.at(-1)).toMatchObject({ role: "assistant", content: "当前存在阻断。" });
  });

  it("stops repeated identical Tool calls at the configured run limit", async () => {
    const provider: ProviderAdapter = {
      id: "deepseek",
      models: [{ provider: "deepseek", id: "deepseek-v4-flash", label: "fixture", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true } }],
      async createTurn(request) { return { provider: "deepseek", providerRequestId: null, model: request.model, content: "", toolCalls: [{ id: `call-${request.messages.length}`, name: "get_price_snapshot", input: {} }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 1, reasoningTokens: 0 }, latencyMs: 1 }; },
    };
    const runtime = new AgentRuntime([provider], new MemoryAgentSessionStore(), { toolRegistry: new AgentToolRegistry(createBuildSimTools()), limits: { maxRepeatedToolCalls: 1 } });
    const session = await runtime.createSession();
    const run = await runtime.startRun(session.id, { content: "循环", buildConfig: baseline as never });
    await runtime.waitForRun(run.runId);
    expect(runtime.getRun(run.runId).status).toBe("limit_exceeded");
    expect(runtime.getRun(run.runId).events.at(-2)).toMatchObject({ type: "error", code: "run_limit_exceeded" });
  });
});
