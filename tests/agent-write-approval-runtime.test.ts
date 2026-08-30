import { createCanvas } from "@napi-rs/canvas";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentAuditHash } from "../src/agent/audit";
import { AGENT_CONTRACT_VERSION, type AgentToolContext, type ProviderAdapter } from "../src/agent/contracts";
import { AgentRuntime } from "../src/agent/runtime";
import { agentRunIdForIdempotency } from "../src/agent/run-identity";
import { AgentSkillLoader } from "../src/agent/skill-loader";
import { AgentToolRegistry } from "../src/agent/tool-registry";
import {
  AgentWriteApprovalAuthority,
  assertValidatedAgentWriteApprovalProofAtRoot,
  createAgentWriteApprovalBinding,
  type AgentWriteApprovalBinding,
} from "../src/agent/write-approval-authority";
import {
  agentWriteApprovalBindingReferencesRuntime,
  validateAgentWriteApprovalBindingClosureRuntime,
  validateAgentWriteApprovalBindingRuntime,
} from "../src/agent/write-approval-runtime.mjs";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { createProductionGovernedAgentActions } from "../src/attachments/production-actions";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { FilePlanAgentContextAuditStore } from "../src/plans/agent-context-audit";
import { hashPlanConfig } from "../src/plans/canonical";
import { FilePlanRepository } from "../src/plans/file-repository";
import { FileJobRepository } from "../src/jobs/repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { sha256Json } from "../src/runtime/fs.mjs";
import { FileAgentRunAuditStore } from "../src/server/file-audit-store";
import { FileAgentSessionStore } from "../src/server/file-session-store";
import { createAgentServer, stageAgentAttachmentUpload } from "../src/server/agent-server";
import { createBuildSimTools, type GovernedEvidenceFactToolActions } from "../src/server/domain-tools";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function postJson(server: Server, pathname: string, body: unknown): Promise<{
  status: number;
  payload: Record<string, unknown>;
}> {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  const request = Readable.from([bytes]) as unknown as IncomingMessage;
  Object.assign(request, {
    method: "POST",
    url: `/api/agent${pathname}`,
    headers: { "content-type": "application/json", "content-length": String(bytes.byteLength) },
  });
  return new Promise((resolve, reject) => {
    let status = 0;
    const chunks: Buffer[] = [];
    const response = {
      writeHead(nextStatus: number) { status = nextStatus; return response; },
      write(chunk: string | Buffer) { chunks.push(Buffer.from(chunk)); return true; },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk));
        try {
          resolve({ status, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
        } catch (error) { reject(error); }
        return response;
      },
    } as unknown as ServerResponse;
    server.emit("request", request, response);
  });
}

function pngFixture(): Buffer {
  const canvas = createCanvas(96, 64);
  const context = canvas.getContext("2d");
  context.fillStyle = "white"; context.fillRect(0, 0, 96, 64);
  context.fillStyle = "black"; context.fillRect(12, 12, 72, 40);
  return canvas.toBuffer("image/png");
}

function usage() {
  return { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

describe("durable Agent write approval handshake", () => {
  it("rejects a fresh authority constructor over otherwise valid generic artifacts and exact-input drift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-agent-write-forgery-"));
    roots.push(root);
    const artifacts = new FileArtifactRepository({ root });
    await artifacts.initialize();
    const now = () => "2026-08-28T09:00:00.000Z";
    const authority = new AgentWriteApprovalAuthority(artifacts, { now, token: () => "2".repeat(64) });
    const input = { candidateId: "candidate-fixture-0001" };
    const requested = await authority.request({
      runId: "run-forgery-fixture", sessionId: "session-forgery-fixture",
      call: { id: "call-forgery-fixture", name: "archive_official_evidence", input },
      toolTitle: "Archive official evidence", toolDefinitionHash: "a".repeat(64),
    });
    const confirmed = await authority.confirm({
      authorityRef: requested.authorityRef, runId: requested.pending.runId,
      approvalId: requested.pending.approvalId, nonce: requested.pending.nonce, approvedBy: "human-forgery-reviewer",
    });
    const expected = {
      toolName: "archive_official_evidence", toolDefinitionHash: "a".repeat(64),
      sessionId: "session-forgery-fixture", runId: "run-forgery-fixture",
      inputHash: agentAuditHash(input), callId: "call-forgery-fixture",
    };
    await expect(authority.authorize(confirmed.authorityRef, { ...expected, inputHash: "b".repeat(64) }))
      .rejects.toThrow(/exact execution/);
    await expect(new AgentWriteApprovalAuthority(artifacts, { now }).authorize(confirmed.authorityRef, expected))
      .rejects.toThrow(/not issued by this server instance/);
    expect(await authority.authorize(confirmed.authorityRef, expected)).toMatchObject({
      envelope: { approvalId: requested.pending.approvalId, inputHash: expected.inputHash },
    });
    expect(() => createAgentWriteApprovalBinding({
      schemaVersion: "agent-write-approval-durable-material-v1",
      authorityRef: confirmed.authorityRef,
      confirmedAuthorityRef: confirmed.authorityRef,
      pendingRef: requested.authorityRef,
      approvalId: requested.pending.approvalId,
      approvedBy: "human-forgery-reviewer",
      idempotencyKey: requested.pending.idempotencyKey,
      execution: expected,
      issuedAt: requested.pending.requestedAt,
      expiresAt: requested.pending.expiresAt,
      runtimeGeneration: 1,
      jobId: `job-${"a".repeat(64)}`,
      checkpointRef: confirmed.authorityRef,
    }, "c".repeat(64))).toThrow(/durable material/);
  });

  it("runs production attachment plus evidence writes only after two exact server confirmations and survives restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-agent-write-approval-"));
    roots.push(root);
    const now = () => new Date().toISOString();
    const coordinator = new RuntimeCoordinator({ root, now });
    await coordinator.initialize("agent-write-approval-e2e");
    const jobs = new FileJobRepository({ coordinator, now, leaseDurationMs: 60_000 });
    const artifacts = new FileArtifactRepository({ coordinator, now });
    const authority = new AgentWriteApprovalAuthority(artifacts, { jobs, now, token: () => "1".repeat(64) });
    const plans = new FilePlanRepository({ coordinator, now, id: () => "plan-agent-write-approval" });
    const plan = await plans.create({ name: "Agent write approval", config: createDefaultN6Config("draft-agent-write-approval", now()) });
    const governed = createProductionGovernedAgentActions({
      coordinator,
      runtimeRoot: root,
      now,
      environment: { BUILD_SIM_FACT_GRAPH_ENABLED: "true", BUILD_SIM_AGENT_INFERENCE_ENABLED: "true" },
    });
    await governed.initializeInference();

    let binding: AgentWriteApprovalBinding | null = null;
    const evidenceWrite = vi.fn(async (input: unknown, context: AgentToolContext) => {
      if (!context.writeApprovalProof) throw new Error("test evidence writer requires the server proof");
      const audit = await new FilePlanAgentContextAuditStore({ coordinator }).get(context.runId);
      if (!audit) throw new Error("test evidence writer requires plan context");
      const material = (await coordinator.withConsistentSnapshot(({ activeRoot, state }: {
        activeRoot: string; state: { runtimeGeneration: number };
      }) => assertValidatedAgentWriteApprovalProofAtRoot(
        activeRoot,
        context.writeApprovalProof,
        context.writeApprovalProof!.execution,
        { now: now(), runtimeGeneration: state.runtimeGeneration },
      ))).result;
      binding = createAgentWriteApprovalBinding(material, sha256Json(audit));
      return { input, binding };
    });
    const evidenceFactActions: GovernedEvidenceFactToolActions = {
      archiveOfficialEvidence: vi.fn(),
      proposeFactUpdate: vi.fn(),
      bindFactEvidence: evidenceWrite,
      resolveFactConflict: vi.fn(),
    };
    const registry = new AgentToolRegistry(createBuildSimTools({
      attachmentActions: governed.attachmentActions,
      evidenceFactActions,
      inferenceActions: governed.inferenceActions!,
    }));
    let uploadId = "";
    const provider: ProviderAdapter = {
      id: "deepseek",
      models: [{ provider: "deepseek", id: "approval-fixture", label: "approval fixture", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true } }],
      async createTurn(request) {
        const latestUser = request.messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === "user").at(-1);
        const messages = latestUser ? request.messages.slice(latestUser.index + 1) : request.messages;
        const completed = messages.filter((message) => message.role === "tool").length;
        if (completed === 0) return {
          provider: "deepseek", providerRequestId: "approval-turn-1", model: request.model, content: "",
          toolCalls: [{ id: "call-archive-attachment", name: "archive_user_attachment", input: { uploadId, deletionPolicy: "retain_until_user_deletes" } }],
          stopReason: "tool_use", usage: usage(), latencyMs: 1,
        };
        if (completed === 1) return {
          provider: "deepseek", providerRequestId: "approval-turn-2", model: request.model, content: "",
          toolCalls: [{ id: "call-bind-evidence", name: "bind_fact_evidence", input: {
            bindingProposalId: "binding-proposal-fixture", factUpdateProposalId: "fact-proposal-fixture", evidenceClaimId: "claim-fixture-0001",
          } }],
          stopReason: "tool_use", usage: usage(), latencyMs: 1,
        };
        return {
          provider: "deepseek", providerRequestId: "approval-turn-3", model: request.model,
          content: "两次受治理写入均已完成。", toolCalls: [], stopReason: "end_turn", usage: usage(), latencyMs: 1,
        };
      },
    };
    const sessions = new FileAgentSessionStore({ coordinator, now });
    const audits = new FileAgentRunAuditStore({ coordinator, now });
    const runtime = new AgentRuntime([provider], sessions, {
      now,
      toolRegistry: registry,
      skillLoader: new AgentSkillLoader(path.resolve("skills"), registry),
      auditStore: audits,
      writeApprovalAuthority: authority,
      durableJobs: { repository: jobs, artifacts, workerId: "agent-write-approval-e2e" },
    });
    await runtime.initializeDurableRuns();
    const httpServer = createAgentServer({ runtime, stagedUploads: governed.stagedUploads });
    const session = await runtime.createSession({ provider: "deepseek", model: "approval-fixture" });
    const staged = await stageAgentAttachmentUpload({ sessionId: session.id, mediaType: "image/png", bytes: pngFixture() }, runtime, governed.stagedUploads);
    uploadId = String((staged.payload as { uploadId: string }).uploadId);
    const idempotencyKey = "approval-e2e-idempotency";
    const runId = agentRunIdForIdempotency(session.id, idempotencyKey);
    const contextStore = new FilePlanAgentContextAuditStore({ coordinator });
    const contextLease = await coordinator.acquireMaintenanceLease("agent-write-approval-context-fixture");
    await contextStore.putWithMaintenanceLease({
      schemaVersion: "1.0.0", sessionId: session.id, runId, planId: plan.id, planVersionId: plan.activeVersionId,
      draftRevision: plan.draftRevision, configHash: await hashPlanConfig(plan.draft.config), evaluationHash: "d".repeat(64),
      spatialSelection: null, contextHash: "c".repeat(64), recordedAt: now(),
    }, contextLease.token);
    await coordinator.releaseMaintenanceLease(contextLease.token);

    const callerApproval = await postJson(httpServer, `/sessions/${encodeURIComponent(session.id)}/messages`, {
      content: "caller must not mint approval authority",
      approvals: [{ approvalToken: "caller-forged" }],
    });
    expect(callerApproval.status).toBe(400);
    expect(callerApproval.payload).toMatchObject({ error: "caller_approvals_forbidden" });

    await runtime.startRun(session.id, {
      content: "先归档附件，再提出事实证据绑定。", buildConfig: plan.draft.config,
      skillId: "evidence-and-attachments", idempotencyKey,
    });
    await runtime.waitForRun(runId);
    const first = (await runtime.getRunState(runId)).pendingApproval!;
    expect(first.call.name).toBe("archive_user_attachment");
    expect(runtime.getRun(runId).events.some((event) => event.type === "tool_result")).toBe(false);
    expect(evidenceWrite).not.toHaveBeenCalled();
    const wrongNonce = await postJson(httpServer, `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(first.approvalId)}/confirm`, {
      nonce: `nonce-${"0".repeat(64)}`, approvedBy: "human-e2e-reviewer",
    });
    expect(wrongNonce.status).toBe(409);
    expect(wrongNonce.payload).toMatchObject({ error: "approval_confirmation_invalid" });
    const crossRun = await postJson(httpServer, `/runs/${encodeURIComponent(`${runId}-other`)}/approvals/${encodeURIComponent(first.approvalId)}/confirm`, {
      nonce: first.nonce, approvedBy: "human-e2e-reviewer",
    });
    expect(crossRun.status).toBe(404);
    expect(crossRun.payload).toMatchObject({ error: "run_not_found" });

    const firstConfirmation = await postJson(httpServer, `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(first.approvalId)}/confirm`, {
      nonce: first.nonce, approvedBy: "human-e2e-reviewer",
    });
    expect(firstConfirmation.status).toBe(202);
    expect(firstConfirmation.payload).toMatchObject({ runId, approvalId: first.approvalId, status: "queued" });
    await runtime.waitForRun(runId);
    const second = (await runtime.getRunState(runId)).pendingApproval!;
    expect(second.call.name).toBe("bind_fact_evidence");
    expect(runtime.getRun(runId).events.filter((event) => event.type === "tool_result")).toHaveLength(1);
    expect(evidenceWrite).not.toHaveBeenCalled();
    const replay = await postJson(httpServer, `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(first.approvalId)}/confirm`, {
      nonce: first.nonce, approvedBy: "human-e2e-reviewer",
    });
    expect(replay.status).toBe(409);
    expect(replay.payload).toMatchObject({ error: "approval_confirmation_invalid" });

    const secondConfirmation = await postJson(httpServer, `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(second.approvalId)}/confirm`, {
      nonce: second.nonce, approvedBy: "human-e2e-reviewer",
    });
    expect(secondConfirmation.status).toBe(202);
    await runtime.waitForRun(runId);
    expect((await runtime.getRunState(runId)).status).toBe("completed");
    expect(evidenceWrite).toHaveBeenCalledTimes(1);
    expect(binding).not.toBeNull();
    expect(validateAgentWriteApprovalBindingRuntime(binding)).toEqual([]);
    expect(agentWriteApprovalBindingReferencesRuntime(binding)).toEqual(expect.arrayContaining([
      { ref: binding!.confirmedAuthorityRef, necessity: "required_for_replay" },
      { ref: `job:${binding!.jobId}`, necessity: "required_for_replay" },
      { ref: `agent-session:${session.id}`, necessity: "required_for_replay" },
      { ref: `agent-audit:${runId}`, necessity: "required_for_replay" },
    ]));
    const confirmedArtifact = await artifacts.get(binding!.confirmedAuthorityRef);
    const pendingArtifact = await artifacts.get(binding!.pendingRef);
    if (!confirmedArtifact || !pendingArtifact) throw new Error("approval binding artifact closure fixture is missing");
    const confirmedValue = JSON.parse(confirmedArtifact.bytes.toString("utf8"));
    const pendingValue = JSON.parse(pendingArtifact.bytes.toString("utf8"));
    expect(validateAgentWriteApprovalBindingClosureRuntime(binding, confirmedValue, pendingValue)).toEqual([]);
    const { contentHash: _oldHash, ...originalBindingMaterial } = structuredClone(binding!);
    const driftedMaterial = { ...originalBindingMaterial, approvedBy: "human-different-reviewer" };
    const driftedBinding = { ...driftedMaterial, contentHash: sha256Json(driftedMaterial) };
    expect(validateAgentWriteApprovalBindingRuntime(driftedBinding)).toEqual([]);
    expect(validateAgentWriteApprovalBindingClosureRuntime(driftedBinding, confirmedValue, pendingValue))
      .toContain("Agent write approval binding reviewer/lifetime closure invalid");
    expect(await jobs.get(binding!.jobId)).toMatchObject({ status: "succeeded", checkpointRef: expect.stringMatching(/^sha256:/) });
    expect(await runtime.startRun(session.id, {
      content: "先归档附件，再提出事实证据绑定。", buildConfig: plan.draft.config,
      skillId: "evidence-and-attachments", idempotencyKey,
    })).toEqual({ runId, status: "completed" });

    const restarted = new AgentRuntime([provider], new FileAgentSessionStore({ coordinator, now }), {
      now,
      toolRegistry: registry,
      skillLoader: new AgentSkillLoader(path.resolve("skills"), registry),
      auditStore: new FileAgentRunAuditStore({ coordinator, now }),
      writeApprovalAuthority: new AgentWriteApprovalAuthority(new FileArtifactRepository({ coordinator, now }), { jobs: new FileJobRepository({ coordinator, now }), now }),
      durableJobs: { repository: new FileJobRepository({ coordinator, now }), artifacts: new FileArtifactRepository({ coordinator, now }), workerId: "agent-write-approval-restart" },
    });
    await restarted.initializeDurableRuns();
    expect(await restarted.getRunState(runId)).toMatchObject({ status: "completed", durableStatus: "succeeded" });
    expect(evidenceWrite).toHaveBeenCalledTimes(1);
  });

  it("rejects, cancels and expires durable pending approvals with zero writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-agent-write-expiry-"));
    roots.push(root);
    let clock = Date.parse("2026-08-28T09:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    const coordinator = new RuntimeCoordinator({ root, now });
    await coordinator.initialize("agent-write-expiry");
    const jobs = new FileJobRepository({ coordinator, now, leaseDurationMs: 60_000 });
    const artifacts = new FileArtifactRepository({ coordinator, now });
    const writes = vi.fn(async () => ({ ok: true, content: {}, provenance: ["fixture"] }));
    const registry = new AgentToolRegistry([{
      contractVersion: AGENT_CONTRACT_VERSION,
      name: "fixture_write",
      title: "Fixture write",
      description: "A test-only write used to exercise pending approval expiration with no side effects.",
      effect: "write",
      approval: "required",
      timeoutMs: 1_000,
      maxResultBytes: 1_000,
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      execute: writes,
    }]);
    const provider: ProviderAdapter = {
      id: "deepseek",
      models: [{ provider: "deepseek", id: "expiry", label: "expiry", capabilities: { streaming: true, tools: true, parallelTools: false, structuredOutput: true, thinking: false } }],
      async createTurn(request) {
        return { provider: "deepseek", providerRequestId: "expiry-turn", model: request.model, content: "", toolCalls: [{ id: "expiry-call", name: "fixture_write", input: {} }], stopReason: "tool_use", usage: usage(), latencyMs: 1 };
      },
    };
    const runtime = new AgentRuntime([provider], new FileAgentSessionStore({ coordinator, now }), {
      now,
      toolRegistry: registry,
      skillLoader: { async load() { return {
        manifest: { contractVersion: AGENT_CONTRACT_VERSION, id: "expiry-skill", name: "Expiry", version: "1.0.0", description: "Expiry fixture", allowedTools: ["fixture_write"], readOnly: false, contextBudget: 100, triggers: ["expiry"] },
        instructions: "Request the fixture write once.", definitionHash: "e".repeat(64),
      }; } } as unknown as AgentSkillLoader,
      writeApprovalAuthority: new AgentWriteApprovalAuthority(artifacts, { jobs, now }),
      durableJobs: { repository: jobs, artifacts, workerId: "agent-write-expiry" },
    });
    const httpServer = createAgentServer({ runtime });
    const session = await runtime.createSession({ provider: "deepseek", model: "expiry" });

    const rejectedRun = await runtime.startRun(session.id, {
      content: "reject", skillId: "expiry-skill", idempotencyKey: "reject-idempotency",
    });
    await runtime.waitForRun(rejectedRun.runId);
    const rejectedPending = (await runtime.getRunState(rejectedRun.runId)).pendingApproval!;
    const rejected = await postJson(
      httpServer,
      `/runs/${encodeURIComponent(rejectedRun.runId)}/approvals/${encodeURIComponent(rejectedPending.approvalId)}/reject`,
      { nonce: rejectedPending.nonce },
    );
    expect(rejected.status).toBe(202);
    expect(rejected.payload).toMatchObject({ runId: rejectedRun.runId, approvalId: rejectedPending.approvalId, status: "cancelled" });
    expect(await runtime.getRunState(rejectedRun.runId)).toMatchObject({ status: "cancelled", durableStatus: "cancelled" });

    const cancelledRun = await runtime.startRun(session.id, {
      content: "cancel", skillId: "expiry-skill", idempotencyKey: "cancel-idempotency",
    });
    await runtime.waitForRun(cancelledRun.runId);
    expect((await runtime.getRunState(cancelledRun.runId)).status).toBe("waiting_approval");
    const cancelled = await postJson(httpServer, `/runs/${encodeURIComponent(cancelledRun.runId)}/cancel`, {});
    expect(cancelled.status).toBe(202);
    expect(cancelled.payload).toMatchObject({ runId: cancelledRun.runId, status: "cancelled" });
    expect(await runtime.getRunState(cancelledRun.runId)).toMatchObject({ status: "cancelled", durableStatus: "cancelled" });

    const run = await runtime.startRun(session.id, { content: "expire", skillId: "expiry-skill", idempotencyKey: "expiry-idempotency" });
    await runtime.waitForRun(run.runId);
    expect((await runtime.getRunState(run.runId)).status).toBe("waiting_approval");
    clock += 11 * 60_000;
    expect(await runtime.getRunState(run.runId)).toMatchObject({ status: "cancelled", durableStatus: "cancelled" });
    expect(writes).not.toHaveBeenCalled();
  });
});
