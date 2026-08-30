import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import { agentAuditHash, redactAgentAuditValue } from "../src/agent/audit";
import { approvalMatchesExecution, validateWriteApprovalEnvelope } from "../src/agent/approval-contract";
import { AGENT_CONTRACT_VERSION, type AgentToolSpec, type AgentWriteApprovalEnvelope, type ProviderAdapter, type ProviderTurnRequest } from "../src/agent/contracts";
import { AgentRuntime } from "../src/agent/runtime";
import { MemoryAgentSessionStore } from "../src/agent/session-store";
import { AgentToolRegistry } from "../src/agent/tool-registry";
import { createBuildSimTools } from "../src/server/domain-tools";
import { FileAgentRunAuditStore } from "../src/server/file-audit-store";

function approval(overrides: Partial<AgentWriteApprovalEnvelope> = {}): AgentWriteApprovalEnvelope {
  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    approvalId: "approval-fixture-001",
    toolName: "apply_build_patch",
    toolDefinitionHash: "a".repeat(64),
    sessionId: "session-fixture-001",
    runId: "run-fixture-001",
    inputHash: "b".repeat(64),
    idempotencyKey: "idempotency-fixture-001",
    issuedAt: "2026-08-24T00:00:00.000Z",
    expiresAt: "2026-08-24T00:10:00.000Z",
    approvedBy: "human-reviewer-001",
    approvalToken: "signed-out-of-band-token-fixture-0001",
    backup: { required: true, target: "data/agent/rollback/fixture.json" },
    rollback: { required: true, strategy: "Restore the exact pre-write hash and backup." },
    ...overrides,
  };
}

describe("A6 write approval contract", () => {
  it("requires a short-lived, execution-bound, idempotent approval with backup and rollback", () => {
    const valid = approval();
    expect(validateWriteApprovalEnvelope(valid, new Date("2026-08-24T00:05:00.000Z"))).toEqual([]);
    expect(approvalMatchesExecution(valid, { toolName: valid.toolName, toolDefinitionHash: valid.toolDefinitionHash, sessionId: valid.sessionId, runId: valid.runId, inputHash: valid.inputHash })).toBe(true);
    expect(approvalMatchesExecution(valid, { toolName: valid.toolName, toolDefinitionHash: valid.toolDefinitionHash, sessionId: valid.sessionId, runId: valid.runId, inputHash: "c".repeat(64) })).toBe(false);
    expect(validateWriteApprovalEnvelope(approval({ expiresAt: "2026-08-24T01:00:00.000Z", backup: undefined as never }), new Date("2026-08-24T00:05:00.000Z"))).toEqual(expect.arrayContaining(["approval lifetime exceeds 15 minutes", "approval backup plan required"]));
    expect(validateWriteApprovalEnvelope(valid, new Date("2026-08-24T00:11:00.000Z"))).toContain("approval expired");
  });

  it("keeps write Tool execution blocked until an exact approval envelope is supplied", async () => {
    const execute = vi.fn(async () => ({ ok: true, content: {}, provenance: [] }));
    const writeTool: AgentToolSpec = {
      contractVersion: AGENT_CONTRACT_VERSION,
      name: "apply_build_patch",
      title: "Apply build patch",
      description: "A future write Tool fixture that must never execute in the initial Agent release.",
      effect: "write",
      approval: "required",
      timeoutMs: 1_000,
      maxResultBytes: 1_000,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute,
    };
    const registry = new AgentToolRegistry([writeTool]);
    const dispatched = await registry.dispatch(writeTool.name, {}, { sessionId: "session-fixture", runId: "run-fixture", buildConfig: null, signal: new AbortController().signal });
    expect(dispatched.result).toMatchObject({ ok: false, errorCode: "approval_required" });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("A6 durable redacted audit", () => {
  it("redacts credential-shaped values without erasing usage token counts", () => {
    expect(redactAgentAuditValue({ apiKey: "top-secret", approvalToken: "signed-secret", inputTokens: 12, message: "Authorization: Bearer abcdefghijklmnop" })).toEqual({ apiKey: "[REDACTED]", approvalToken: "[REDACTED]", inputTokens: 12, message: "Authorization: Bearer [REDACTED]" });
  });

  it("persists hashes, provider turns and Tool outcomes without prompts or raw Tool results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-agent-audit-"));
    const auditStore = new FileAgentRunAuditStore(root);
    const requests: ProviderTurnRequest[] = [];
    const provider: ProviderAdapter = {
      id: "deepseek",
      models: [{ provider: "deepseek", id: "deepseek-v4-flash", label: "fixture", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true } }],
      async createTurn(request) {
        requests.push(request);
        const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 1, cacheWriteTokens: 9, reasoningTokens: 0 };
        if (requests.length === 1) return { provider: "deepseek", providerRequestId: "Bearer provider-secret-fixture", model: request.model, content: "", toolCalls: [{ id: "call-audit", name: "get_build_evaluation", input: { sections: ["findings"] } }], stopReason: "tool_use", usage, latencyMs: 4 };
        return { provider: "deepseek", providerRequestId: "provider-turn-2", model: request.model, content: "审计完成", toolCalls: [], stopReason: "end_turn", usage, latencyMs: 5 };
      },
    };
    let sequence = 0;
    const runtime = new AgentRuntime([provider], new MemoryAgentSessionStore(), {
      id: () => `fixture-${String(++sequence).padStart(4, "0")}`,
      now: () => "2026-08-24T00:00:00.000Z",
      toolRegistry: new AgentToolRegistry(createBuildSimTools()),
      auditStore,
    });
    const session = await runtime.createSession();
    const run = await runtime.startRun(session.id, { content: "prompt must not enter audit; apiKey=prompt-secret", buildConfig: baseline as never });
    await runtime.waitForRun(run.runId);
    const audit = await runtime.getRunAudit(run.runId);
    expect(audit).toMatchObject({ status: "completed", buildConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/), providerTurns: [{ providerRequestId: "Bearer [REDACTED]" }, { providerRequestId: "provider-turn-2" }], toolCalls: [{ name: "get_build_evaluation", ok: true, errorCode: null }] });
    expect(audit.toolCalls[0]).toMatchObject({ definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/), inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), resultHash: expect.stringMatching(/^[a-f0-9]{64}$/), provenanceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const { recordHash, ...unsigned } = audit;
    expect(recordHash).toBe(agentAuditHash(unsigned));
    const file = path.join(root, `${run.runId}.json`);
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("prompt must not enter audit");
    expect(raw).not.toContain("prompt-secret");
    expect(raw).not.toContain("provider-secret-fixture");
    expect(raw).not.toContain("sections\"");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await writeFile(file, raw.replace('"status": "completed"', '"status": "failed"'));
    await expect(auditStore.get(run.runId)).rejects.toThrow("integrity check failed");
  });
});
