import { describe, expect, it, vi } from "vitest";
import { agentAuditHash } from "../src/agent/audit";
import { AGENT_CONTRACT_VERSION, type AgentToolContext, type AgentWriteApprovalEnvelope, type ProviderAdapter, type ProviderTurnRequest } from "../src/agent/contracts";
import { AgentRuntime } from "../src/agent/runtime";
import { MemoryAgentSessionStore } from "../src/agent/session-store";
import type { AgentSkillLoader } from "../src/agent/skill-loader";
import { AgentToolRegistry } from "../src/agent/tool-registry";
import { createBuildSimTools } from "../src/server/domain-tools";

function approval(registry: AgentToolRegistry, sessionId: string, input: unknown, overrides: Partial<AgentWriteApprovalEnvelope> = {}): AgentWriteApprovalEnvelope {
  const issuedAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    approvalId: "approval-fixture-0001",
    toolName: "enrich_official_catalog",
    toolDefinitionHash: registry.definitionHash("enrich_official_catalog"),
    sessionId,
    inputHash: agentAuditHash(input),
    idempotencyKey: "catalog-enrich-fixture-0001",
    issuedAt,
    expiresAt,
    approvedBy: "human-fixture-0001",
    approvalToken: "fixture-out-of-band-token-000000000000000000000000",
    backup: { required: true, target: "data/skus/catalog.json" },
    rollback: { required: true, strategy: "catalog rollback manifest" },
    ...overrides,
  };
}

function context(value?: AgentWriteApprovalEnvelope): AgentToolContext {
  return { sessionId: "session-fixture-0001", runId: "run-fixture-0001", buildConfig: null, signal: new AbortController().signal, ...(value ? { approval: value } : {}) };
}

describe("C6 approval-bound catalog write Tool", () => {
  it("requires exact approval binding and replays successful idempotency without another write", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ status: "accepted", changedFields: ["new SKU"], rollbackManifest: "fixture-manifest" }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    try {
      const registry = new AgentToolRegistry(createBuildSimTools({ priceServiceUrl: "http://127.0.0.1:6174" }));
      const input = { candidateId: "catalog-candidate-fixture", expectedHash: "a".repeat(64) };
      expect((await registry.dispatch("enrich_official_catalog", input, context())).result).toMatchObject({ ok: false, errorCode: "approval_required" });
      const valid = approval(registry, "session-fixture-0001", input);
      const mismatched = { ...valid, inputHash: "b".repeat(64) };
      expect((await registry.dispatch("enrich_official_catalog", input, context(mismatched))).result).toMatchObject({ ok: false, errorCode: "approval_mismatch" });
      expect((await registry.dispatch("enrich_official_catalog", input, context(valid))).result).toMatchObject({ ok: true, content: { status: "accepted" } });
      expect((await registry.dispatch("enrich_official_catalog", input, context(valid))).result).toMatchObject({ ok: true, content: { status: "accepted" } });
      expect(calls).toEqual([{ url: "http://127.0.0.1:6174/api/catalog/candidates/catalog-candidate-fixture/enrich", body: { expectedHash: "a".repeat(64) } }]);
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps the approval token out of provider/session messages while orchestrating the Tool", async () => {
    const requests: ProviderTurnRequest[] = [];
    const input = { candidateId: "catalog-candidate-runtime", expectedHash: "c".repeat(64) };
    const provider: ProviderAdapter = {
      id: "deepseek",
      models: [{ provider: "deepseek", id: "deepseek-v4-flash", label: "fixture", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true } }],
      async createTurn(request) {
        requests.push(request);
        if (requests.length === 1) {
          expect(request.tools.map((tool) => tool.name)).toEqual(["enrich_official_catalog"]);
          return { provider: "deepseek", providerRequestId: "p1", model: request.model, content: "", toolCalls: [{ id: "write-1", name: "enrich_official_catalog", input }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, latencyMs: 1 };
        }
        expect(JSON.parse(request.messages.at(-1)?.content ?? "{}")).toMatchObject({ ok: true, content: { status: "draft" } });
        return { provider: "deepseek", providerRequestId: "p2", model: request.model, content: "已生成草稿。", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, latencyMs: 1 };
      },
    };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ status: "draft", draftId: "draft-fixture", changedFields: [], rollbackManifest: "fixture-manifest" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    try {
      const registry = new AgentToolRegistry(createBuildSimTools({ priceServiceUrl: "http://127.0.0.1:6174" }));
      const store = new MemoryAgentSessionStore();
      const skillLoader = {
        async load() {
          return {
            manifest: {
              contractVersion: AGENT_CONTRACT_VERSION,
              id: "catalog-write-fixture",
              name: "Catalog write fixture",
              version: "1.0.0",
              description: "Test-only Skill that explicitly scopes the legacy approval-bound write Tool.",
              allowedTools: ["enrich_official_catalog"],
              readOnly: false,
              contextBudget: 1_000,
              triggers: ["fixture"],
            },
            instructions: "Use only the explicitly approved fixture write Tool.",
            definitionHash: "d".repeat(64),
          };
        },
      } as unknown as AgentSkillLoader;
      const runtime = new AgentRuntime([provider], store, { toolRegistry: registry, skillLoader });
      const session = await runtime.createSession();
      const envelope = approval(registry, session.id, input, { approvalId: "approval-runtime-0001", idempotencyKey: "catalog-enrich-runtime-0001" });
      const run = await runtime.startRun(session.id, { content: "对已检查候选生成目录草稿", skillId: "catalog-write-fixture", approvals: [envelope] });
      await runtime.waitForRun(run.runId);
      expect(runtime.getRun(run.runId).status).toBe("completed");
      expect(JSON.stringify((await runtime.getSession(session.id)).messages)).not.toContain(envelope.approvalToken);
      expect(JSON.stringify(requests)).not.toContain(envelope.approvalToken);
    } finally { vi.unstubAllGlobals(); }
  });
});
