import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilePlanRepository } from "../src/plans/file-repository";
import { createAgentInitializationScaffold, createDefaultN6Config, createEmptyBuildConfig } from "../src/plans/default-plan";
import { canonicalJson, sha256Hex } from "../src/plans/canonical";
import { PlanProposalService, previewPlanProposal } from "../src/plans/proposals";
import type { PlanChangeProposal } from "../src/plans/contracts";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";

const roots: string[] = [];
const checksum = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "build-sim-r7-")); roots.push(root);
  const repository = new FilePlanRepository({ root, now: () => "2026-08-25T00:00:00.000Z" });
  const plan = await repository.create({ name: "Proposal", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
  const hash = await sha256Hex(plan.draft.config);
  const preview = await previewPlanProposal(plan.draft.config, { id: "proposal-fixture", planId: plan.id, expectedDraftRevision: plan.draftRevision, expectedConfigHash: hash, summary: "改为 2 块盘", rationale: ["用户要求"], operations: [{ op: "replace", path: "/selection/diskCount", value: 2 }], createdAt: "2026-08-25T00:00:00.000Z" });
  return { root, repository, plan, proposal: preview.proposal };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe("R7 human-approved plan proposals", () => {
  it("previews deterministically and cannot mutate before explicit approval", async () => {
    const { repository, plan, proposal } = await fixture();
    const service = new PlanProposalService(repository);
    await expect(service.apply(plan.id, proposal, undefined, { confirmed: false, approvedBy: "" })).rejects.toMatchObject({ code: "human_approval_required" });
    expect((await repository.get(plan.id)).draft.config.selection.diskCount).toBe(1);
    const applied = await service.apply(plan.id, proposal, undefined, { confirmed: true, approvedBy: "human-test" });
    expect(applied.plan.draft.config.selection.diskCount).toBe(2);
    expect(applied.proposal.status).toBe("applied");
    expect(applied.audit).toMatchObject({ approvedBy: "human-test", beforeConfigHash: proposal.expectedConfigHash });
  });

  it("replays an approved proposal idempotently without advancing the draft twice", async () => {
    const { repository, plan, proposal } = await fixture();
    const service = new PlanProposalService(repository, () => "2026-08-25T01:00:00.000Z");
    const first = await service.apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "human-test" });
    const replay = await service.apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "human-test" });
    expect(replay).toEqual(first);
    expect((await repository.get(plan.id)).draftRevision).toBe(plan.draftRevision + 1);
  });

  it("replays from the file authority after service/repository restart and fences request mismatches before stale CAS", async () => {
    const { root, repository, plan, proposal } = await fixture();
    const first = await new PlanProposalService(repository, () => "2026-08-25T01:00:00.000Z")
      .apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "human-test" });
    const restartedRepository = new FilePlanRepository({ root });
    const restarted = new PlanProposalService(restartedRepository, () => "2026-08-25T02:00:00.000Z");

    await expect(restarted.apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "human-test" })).resolves.toEqual(first);
    await expect(restarted.apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "another-human" }))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    await expect(restarted.apply(plan.id, { ...proposal, operations: [{ op: "replace", path: "/selection/diskCount", value: 3 }] }, [0], { confirmed: true, approvedBy: "human-test" }))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect((await restartedRepository.get(plan.id)).draftRevision).toBe(plan.draftRevision + 1);
  });

  it("fails closed instead of drifting a durable approval replay after a later legitimate Plan write", async () => {
    const { root, repository, plan, proposal } = await fixture();
    const first = await new PlanProposalService(repository, () => "2026-08-25T01:00:00.000Z")
      .apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "human-test" });
    await repository.updateInfo(plan.id, {
      expectedRevision: first.plan.draftRevision,
      name: "Legitimate later rename",
      description: "This write must not be returned as the original approval result",
    });

    const restartedRepository = new FilePlanRepository({ root });
    await expect(new PlanProposalService(restartedRepository, () => "2026-08-25T02:00:00.000Z")
      .apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "human-test" }))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409, message: expect.stringMatching(/superseded/) });
    await expect(restartedRepository.get(plan.id)).resolves.toMatchObject({
      name: "Legitimate later rename",
      draftRevision: first.plan.draftRevision + 1,
    });
  });

  it("fails closed on legacy proposal receipts that cannot prove the immutable applied boundary", async () => {
    const { root, repository, plan, proposal } = await fixture();
    await new PlanProposalService(repository).apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "human-test" });
    const [recordName] = await fs.readdir(path.join(root, ".idempotency"));
    const recordFile = path.join(root, ".idempotency", recordName!);
    const envelope = JSON.parse(await fs.readFile(recordFile, "utf8"));
    delete envelope.payload.result.writeReceipt;
    const { resultHash: _oldResultHash, ...resultMaterial } = envelope.payload.result;
    envelope.payload.result.resultHash = checksum(resultMaterial);
    envelope.checksum = checksum(envelope.payload);
    await fs.writeFile(recordFile, JSON.stringify(envelope));

    await expect(new PlanProposalService(new FilePlanRepository({ root }))
      .apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "human-test" }))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409, message: expect.stringMatching(/Legacy/) });
  });

  it("rejects checksum-valid unknown immutable Plan receipt schemas after restart", async () => {
    const { root, repository, plan, proposal } = await fixture();
    await new PlanProposalService(repository).apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "human-test" });
    const [recordName] = await fs.readdir(path.join(root, ".idempotency"));
    const recordFile = path.join(root, ".idempotency", recordName!);
    const envelope = JSON.parse(await fs.readFile(recordFile, "utf8"));
    envelope.payload.result.writeReceipt.schemaVersion = "plan-write-receipt-unknown";
    const { resultHash: _oldResultHash, ...resultMaterial } = envelope.payload.result;
    envelope.payload.result.resultHash = checksum(resultMaterial);
    envelope.checksum = checksum(envelope.payload);
    await fs.writeFile(recordFile, JSON.stringify(envelope));

    await expect(new PlanProposalService(new FilePlanRepository({ root }))
      .apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "human-test" }))
      .rejects.toMatchObject({ code: "corrupt_data", status: 500 });
  });

  it("keeps superseded receipts production-readable but rejects unknown receipt authority", async () => {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "build-sim-plan-receipt-production-")); roots.push(runtimeRoot);
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot });
    const state = await coordinator.initialize("test");
    const repository = new FilePlanRepository({ coordinator, now: () => "2026-08-25T00:00:00.000Z" });
    const plan = await repository.create({ name: "Receipt graph", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
    const proposal = (await previewPlanProposal(plan.draft.config, {
      id: "proposal-production-receipt", planId: plan.id, expectedDraftRevision: plan.draftRevision,
      expectedConfigHash: await sha256Hex(plan.draft.config), summary: "receipt", rationale: ["fixture"],
      operations: [{ op: "replace", path: "/selection/diskCount", value: 2 }], createdAt: "2026-08-25T00:00:00.000Z",
    })).proposal;
    const applied = await new PlanProposalService(repository).apply(plan.id, proposal, undefined, { confirmed: true, approvedBy: "human-test" });
    await repository.updateInfo(plan.id, { expectedRevision: applied.plan.draftRevision, name: "Later authority" });
    await expect(createProductionReferenceGraph({ coordinator, now: () => "2026-08-25T00:00:01.000Z" })).resolves.toMatchObject({ graphHash: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const idempotencyRoot = path.join(coordinator.activeRoot(state), "plans", ".idempotency");
    const [recordName] = await fs.readdir(idempotencyRoot);
    const recordFile = path.join(idempotencyRoot, recordName!);
    const envelope = JSON.parse(await fs.readFile(recordFile, "utf8"));
    envelope.payload.result.writeReceipt.schemaVersion = "plan-write-receipt-unknown";
    const { resultHash: _oldResultHash, ...resultMaterial } = envelope.payload.result;
    envelope.payload.result.resultHash = checksum(resultMaterial);
    envelope.checksum = checksum(envelope.payload);
    await fs.writeFile(recordFile, JSON.stringify(envelope));
    await expect(createProductionReferenceGraph({ coordinator, now: () => "2026-08-25T00:00:02.000Z" })).rejects.toThrow(/plan idempotency record is invalid/);
  });

  it("rejects replay of the same proposal ID with changed content or base", async () => {
    const { repository, plan, proposal } = await fixture();
    const service = new PlanProposalService(repository);
    await service.apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "human-test" });
    const changedOperation = {
      ...proposal,
      operations: [{ op: "replace" as const, path: "/selection/diskCount" as const, value: 3 }],
    };
    await expect(service.apply(plan.id, changedOperation, [0], { confirmed: true, approvedBy: "human-test" }))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    await expect(service.apply(plan.id, { ...proposal, expectedConfigHash: "f".repeat(64) }, [0], { confirmed: true, approvedBy: "human-test" }))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    await expect(service.apply(plan.id, { ...proposal, expectedDraftRevision: proposal.expectedDraftRevision + 1 }, [0], { confirmed: true, approvedBy: "human-test" }))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("rejects replay of the same proposal ID with a different partial approval scope", async () => {
    const { root, repository, plan, proposal } = await fixture();
    const multi = (await previewPlanProposal(plan.draft.config, {
      ...proposal,
      operations: [
        { op: "replace", path: "/selection/diskCount", value: 4 },
        { op: "replace", path: "/selection/boot", value: "m2" },
      ],
    })).proposal;
    const service = new PlanProposalService(repository);
    await service.apply(plan.id, multi, [0], { confirmed: true, approvedBy: "human-test" });
    const restarted = new PlanProposalService(new FilePlanRepository({ root }));
    await expect(restarted.apply(plan.id, multi, [1], { confirmed: true, approvedBy: "human-test" }))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("rejects replay of the same proposal ID by a different approving actor", async () => {
    const { repository, plan, proposal } = await fixture();
    const service = new PlanProposalService(repository);
    await service.apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "human-test" });
    await expect(service.apply(plan.id, proposal, [0], { confirmed: true, approvedBy: "another-human" }))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("rejects stale, non-allowlisted and nonexistent SKU proposals", async () => {
    const { repository, plan, proposal } = await fixture();
    const service = new PlanProposalService(repository);
    await repository.updateDraft(plan.id, { expectedRevision: plan.draftRevision, config: { ...plan.draft.config, name: "Changed" } });
    await expect(service.validate(plan.id, proposal)).rejects.toThrow(/stale_revision/);
    const unsafe = { ...proposal, operations: [{ op: "replace", path: "/metadata/admin", value: true }] } as unknown as PlanChangeProposal;
    await expect(service.validate(plan.id, unsafe)).rejects.toThrow(/allowlisted/);
    const fresh = await repository.get(plan.id); const hash = await sha256Hex(fresh.draft.config);
    await expect(previewPlanProposal(fresh.draft.config, { planId: plan.id, expectedDraftRevision: fresh.draftRevision, expectedConfigHash: hash, summary: "bad sku", rationale: ["test"], operations: [{ op: "replace", path: "/selection/psuId", value: "psu.does-not-exist" }] })).rejects.toThrow(/不存在/);
  });

  it("revalidates a partial selection and applies only approved operations", async () => {
    const { repository, plan, proposal } = await fixture();
    const hash = await sha256Hex(plan.draft.config);
    const multi = (await previewPlanProposal(plan.draft.config, { ...proposal, expectedConfigHash: hash, operations: [{ op: "replace", path: "/selection/diskCount", value: 4 }, { op: "replace", path: "/selection/boot", value: "m2" }] })).proposal;
    const applied = await new PlanProposalService(repository).apply(plan.id, multi, [1], { confirmed: true, approvedBy: "human-test" });
    expect(applied.plan.draft.config.selection.diskCount).toBe(1);
    expect(applied.plan.draft.config.selection.boot).toBe("m2");
    expect(applied.proposal.operations).toHaveLength(1);
  });

  it("lets Agent propose reviewed case fan groups but rejects unknown mounts", async () => {
    const { repository, plan } = await fixture();
    const hash = await sha256Hex(plan.draft.config);
    const fanGroups = [{ mountId: "front", sizeMm: 140 as const, count: 1 }, { mountId: "right", sizeMm: 120 as const, count: 1 }];
    const proposal = (await previewPlanProposal(plan.draft.config, {
      planId: plan.id, expectedDraftRevision: plan.draftRevision, expectedConfigHash: hash,
      summary: "调整机箱风扇", rationale: ["用户要求 review"],
      operations: [{ op: "replace", path: "/selection/fanGroups", value: fanGroups }],
    })).proposal;
    expect((await repository.get(plan.id)).draft.config.selection.fanGroups).not.toEqual(fanGroups);
    const applied = await new PlanProposalService(repository).apply(plan.id, proposal, undefined, { confirmed: true, approvedBy: "human-test" });
    expect(applied.plan.draft.config.selection.fanGroups).toEqual(fanGroups);
    await expect(previewPlanProposal(applied.plan.draft.config, {
      planId: plan.id, expectedDraftRevision: applied.plan.draftRevision, expectedConfigHash: await sha256Hex(applied.plan.draft.config),
      summary: "非法安装位", rationale: ["test"],
      operations: [{ op: "replace", path: "/selection/fanGroups", value: [{ mountId: "top", sizeMm: 120, count: 3 }] }],
    })).rejects.toThrow(/安装位/);
  });

  it("can add one reviewed component to an empty plan without autofilling the rest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "build-sim-empty-proposal-")); roots.push(root);
    const repository = new FilePlanRepository({ root, now: () => "2026-08-27T00:00:00.000Z" });
    const plan = await repository.create({ name: "空白方案", config: createEmptyBuildConfig("draft", "2026-08-27T00:00:00.000Z") });
    const proposal = (await previewPlanProposal(plan.draft.config, {
      planId: plan.id, expectedDraftRevision: plan.draftRevision, expectedConfigHash: await sha256Hex(plan.draft.config),
      summary: "先加入机箱", rationale: ["用户逐件 review"], operations: [{ op: "replace", path: "/caseId", value: "case.jonsbo-n6" }],
    })).proposal;
    expect(proposal.predictedImpact).toBeDefined();
    const applied = await new PlanProposalService(repository).apply(plan.id, proposal, undefined, { confirmed: true, approvedBy: "human-test" });
    expect(applied.plan.draft.config).toMatchObject({
      caseId: "case.jonsbo-n6", boardId: "", cpuId: "",
      selection: { psuId: "", coolerId: "", gpuId: "", memoryId: "", fanGroups: [] },
    });
  });

  it("rejects duplicate, out-of-range and already-consumed proposal selections", async () => {
    const { repository, plan, proposal } = await fixture();
    const service = new PlanProposalService(repository);
    await expect(service.validate(plan.id, proposal, [0, 0])).rejects.toMatchObject({ code: "proposal_indexes_invalid" });
    await expect(service.validate(plan.id, proposal, [1])).rejects.toMatchObject({ code: "proposal_indexes_invalid" });
    await expect(service.validate(plan.id, { ...proposal, status: "applied" })).rejects.toMatchObject({ code: "proposal_status_invalid" });
  });

  it("keeps the workspace apply route behind an explicit approval boundary", async () => {
    const { repository, plan, proposal } = await fixture();
    const proposalService = new PlanProposalService(repository);
    await expect(handleWorkspaceRoute("POST", `/api/workspace/plans/${plan.id}/proposals/validate`, { proposal }, repository, { proposalService })).resolves.toMatchObject({ status: 200, payload: { proposal: { status: "proposed" } } });
    await expect(handleWorkspaceRoute("POST", `/api/workspace/plans/${plan.id}/proposals/apply`, { proposal, approvalConfirmed: false }, repository, { proposalService })).resolves.toMatchObject({ status: 403, payload: { error: "human_approval_required" } });
    await expect(handleWorkspaceRoute("POST", `/api/workspace/plans/${plan.id}/proposals/apply`, { proposal, approvalConfirmed: true, approvedBy: "api-human", confirmedRequirementFieldIds: "not-an-array" }, repository, { proposalService }))
      .resolves.toMatchObject({ status: 400, payload: { error: "invalid_request" } });
    await expect(handleWorkspaceRoute("POST", `/api/workspace/plans/${plan.id}/proposals/validate`, { proposal, approvalConfirmed: true }, repository, { proposalService }))
      .resolves.toMatchObject({ status: 400, payload: { error: "invalid_request" } });
    expect((await repository.get(plan.id)).draft.config.selection.diskCount).toBe(1);
    await expect(handleWorkspaceRoute("POST", `/api/workspace/plans/${plan.id}/proposals/apply`, { proposal, approvalConfirmed: true, approvedBy: "api-human" }, repository, { proposalService })).resolves.toMatchObject({ status: 200, payload: { proposal: { status: "applied" }, audit: { approvedBy: "api-human" } } });
  });

  it("treats legacy pending Agent metadata as incrementally editable and versionable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "build-sim-init-")); roots.push(root);
    const repository = new FilePlanRepository({ root, now: () => "2026-08-25T03:00:00.000Z" });
    const created = await repository.create({
      name: "待 Agent 初始化方案",
      config: createDefaultN6Config("scaffold", "2026-08-25T00:00:00.000Z"),
      metadata: { initialization: { status: "pending", source: "agent" } },
    });
    const hash = await sha256Hex(created.draft.config);
    await expect(repository.saveVersion(created.id, { expectedRevision: created.draftRevision, expectedConfigHash: hash, reason: "manual-save" }))
      .resolves.toMatchObject({ versionNumber: 1 });
    const proposal = (await previewPlanProposal(created.draft.config, {
      id: "proposal-initialize",
      planId: created.id,
      expectedDraftRevision: created.draftRevision,
      expectedConfigHash: hash,
      summary: "初始化游戏方案",
      rationale: ["用户确认 2K 游戏需求"],
      operations: [
        { op: "replace", path: "/name", value: "2K 游戏方案" },
        { op: "replace", path: "/selection/gpuId", value: "gpu.rtx-a2000-12gb" },
      ],
      kind: "initialization",
      intent: { useCase: "游戏", budgetCny: 8000, targetResolution: "1440p", targetFps: 60 },
      createdAt: "2026-08-25T02:00:00.000Z",
    })).proposal;
    const service = new PlanProposalService(repository, () => "2026-08-25T03:00:00.000Z");
    const partial = await service.apply(created.id, proposal, [0], { confirmed: true, approvedBy: "human-test" });
    expect(partial.plan).toMatchObject({
      name: "2K 游戏方案",
      draft: { config: { name: "2K 游戏方案", selection: { gpuId: "gpu.none" } } },
      metadata: { useCase: "游戏", budgetCny: 8000, initialization: { status: "initialized", source: "agent", proposalId: proposal.id } },
    });
    const second = (await previewPlanProposal(partial.plan.draft.config, {
      id: "proposal-second-round", planId: created.id, expectedDraftRevision: partial.plan.draftRevision,
      expectedConfigHash: await sha256Hex(partial.plan.draft.config), summary: "第二轮加入 GPU", rationale: ["逐项 review"],
      operations: [{ op: "replace", path: "/selection/gpuId", value: "gpu.rtx-a2000-12gb" }],
    })).proposal;
    const applied = await service.apply(created.id, second, undefined, { confirmed: true, approvedBy: "human-test" });
    expect(applied.plan.draft.config).toMatchObject({ name: "2K 游戏方案", selection: { gpuId: "gpu.rtx-a2000-12gb" } });
    await expect(repository.saveVersion(applied.plan.id, { expectedRevision: applied.plan.draftRevision, expectedConfigHash: applied.audit.afterConfigHash, reason: "agent-proposal" }))
      .resolves.toMatchObject({ versionNumber: 2 });
  });

  it("creates the same honest blank scaffold for Agent and ordinary plans", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "build-sim-pending-kind-")); roots.push(root);
    const repository = new FilePlanRepository({ root, now: () => "2026-08-27T04:00:00.000Z" });
    const scaffold = createAgentInitializationScaffold("scaffold", "2026-08-27T04:00:00.000Z");
    expect(scaffold).toEqual({ config: createEmptyBuildConfig("scaffold", "2026-08-27T04:00:00.000Z"), metadata: {} });
    const created = await repository.create({ name: scaffold.config.name, config: scaffold.config, metadata: scaffold.metadata });
    await expect(repository.saveVersion(created.id, {
      expectedRevision: created.draftRevision, expectedConfigHash: await sha256Hex(created.draft.config), reason: "initial",
    })).resolves.toMatchObject({ config: { caseId: "", boardId: "", cpuId: "", selection: { diskCount: 0 } } });
  });

  it("persists an incomplete incremental Agent proposal without fabricating unmentioned parts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "build-sim-incomplete-init-")); roots.push(root);
    const repository = new FilePlanRepository({ root, now: () => "2026-08-27T05:00:00.000Z" });
    const created = await repository.create({
      name: "待 Agent 初始化方案",
      config: createDefaultN6Config("scaffold", "2026-08-27T05:00:00.000Z"),
    });
    const beforeHash = await sha256Hex(created.draft.config);
    const incomplete = (await previewPlanProposal(created.draft.config, {
      id: "proposal-incomplete-init", planId: created.id, expectedDraftRevision: created.draftRevision,
      expectedConfigHash: beforeHash, createdAt: "2026-08-27T05:00:00.000Z",
      summary: "保留未完成状态", rationale: ["逐项 review"], operations: [
        { op: "replace", path: "/cpuId", value: "" },
        { op: "remove", path: "/selection/diskSkuId" },
      ],
    })).proposal;
    const applied = await new PlanProposalService(repository).apply(created.id, incomplete, undefined, { confirmed: true, approvedBy: "human-test" });
    expect(applied.plan.draft.config).toMatchObject({ cpuId: "", selection: { diskCount: 1 } });
    expect("diskSkuId" in applied.plan.draft.config.selection).toBe(false);
    await expect(repository.saveVersion(created.id, {
      expectedRevision: applied.plan.draftRevision, expectedConfigHash: applied.audit.afterConfigHash, reason: "agent-proposal",
    })).resolves.toMatchObject({ config: { cpuId: "" } });
  });
});
