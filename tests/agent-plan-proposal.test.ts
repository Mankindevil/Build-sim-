import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilePlanRepository } from "../src/plans/file-repository";
import { createDefaultN6Config, createEmptyBuildConfig } from "../src/plans/default-plan";
import { sha256Hex } from "../src/plans/canonical";
import { PlanProposalService, previewPlanProposal } from "../src/plans/proposals";
import type { PlanChangeProposal } from "../src/plans/contracts";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "build-sim-r7-")); roots.push(root);
  const repository = new FilePlanRepository({ root, now: () => "2026-08-25T00:00:00.000Z" });
  const plan = await repository.create({ name: "Proposal", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
  const hash = await sha256Hex(plan.draft.config);
  const preview = await previewPlanProposal(plan.draft.config, { id: "proposal-fixture", planId: plan.id, expectedDraftRevision: plan.draftRevision, expectedConfigHash: hash, summary: "改为 2 块盘", rationale: ["用户要求"], operations: [{ op: "replace", path: "/selection/diskCount", value: 2 }], createdAt: "2026-08-25T00:00:00.000Z" });
  return { repository, plan, proposal: preview.proposal };
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
    expect((await repository.get(plan.id)).draft.config.selection.diskCount).toBe(1);
    await expect(handleWorkspaceRoute("POST", `/api/workspace/plans/${plan.id}/proposals/apply`, { proposal, approvalConfirmed: true, approvedBy: "api-human" }, repository, { proposalService })).resolves.toMatchObject({ status: 200, payload: { proposal: { status: "applied" }, audit: { approvedBy: "api-human" } } });
  });

  it("applies a pending Agent initialization atomically and records its structured intent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "build-sim-init-")); roots.push(root);
    const repository = new FilePlanRepository({ root, now: () => "2026-08-25T03:00:00.000Z" });
    const created = await repository.create({
      name: "待 Agent 初始化方案",
      config: createDefaultN6Config("scaffold", "2026-08-25T00:00:00.000Z"),
      metadata: { initialization: { status: "pending", source: "agent" } },
    });
    const hash = await sha256Hex(created.draft.config);
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
    await expect(repository.saveVersion(created.id, { expectedRevision: created.draftRevision, expectedConfigHash: hash, reason: "manual-save" })).rejects.toMatchObject({ code: "initialization_pending" });
    await expect(repository.duplicate(created.id, { name: "待初始化副本" })).resolves.toMatchObject({ activeVersionId: null, metadata: { initialization: { status: "pending" } } });
    await expect(service.apply(created.id, proposal, [0], { confirmed: true, approvedBy: "human-test" })).rejects.toMatchObject({ code: "initialization_atomic_required" });
    expect((await repository.get(created.id)).metadata.initialization?.status).toBe("pending");
    const applied = await service.apply(created.id, proposal, undefined, { confirmed: true, approvedBy: "human-test" });
    expect(applied.plan).toMatchObject({
      name: "2K 游戏方案",
      draft: { config: { name: "2K 游戏方案", selection: { gpuId: "gpu.rtx-a2000-12gb" } } },
      metadata: { useCase: "游戏", budgetCny: 8000, initialization: { status: "initialized", source: "agent", proposalId: proposal.id, intent: { targetResolution: "1440p" } } },
    });
    expect(applied.audit.afterConfigHash).toBe(await sha256Hex(applied.plan.draft.config));
    await expect(repository.saveVersion(applied.plan.id, { expectedRevision: applied.plan.draftRevision, expectedConfigHash: applied.audit.afterConfigHash, reason: "agent-proposal" })).resolves.toMatchObject({ versionNumber: 1 });
    await expect(service.validate(created.id, proposal)).rejects.toMatchObject({ code: "initialization_status_invalid" });
  });

  it("allows only initialization proposals while Agent initialization is pending", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "build-sim-pending-kind-")); roots.push(root);
    const repository = new FilePlanRepository({ root, now: () => "2026-08-27T04:00:00.000Z" });
    const created = await repository.create({
      name: "待 Agent 初始化方案",
      config: createEmptyBuildConfig("scaffold", "2026-08-27T04:00:00.000Z"),
      metadata: { initialization: { status: "pending", source: "agent" } },
    });
    const beforeHash = await sha256Hex(created.draft.config);
    const change = (await previewPlanProposal(created.draft.config, {
      id: "proposal-wrong-kind",
      planId: created.id,
      expectedDraftRevision: created.draftRevision,
      expectedConfigHash: beforeHash,
      summary: "先改一项",
      rationale: ["不应绕过原子初始化"],
      operations: [{ op: "replace", path: "/caseId", value: "case.jonsbo-n6" }],
      createdAt: "2026-08-27T04:00:00.000Z",
    })).proposal;

    await expect(new PlanProposalService(repository).apply(created.id, change, undefined, { confirmed: true, approvedBy: "human-test" }))
      .rejects.toMatchObject({ code: "initialization_kind_required" });
    const after = await repository.get(created.id);
    expect(after.draftRevision).toBe(created.draftRevision);
    expect(after.metadata.initialization?.status).toBe("pending");
    expect(await sha256Hex(after.draft.config)).toBe(beforeHash);
  });

  it("keeps initialization pending when the post-proposal build is incomplete", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "build-sim-incomplete-init-")); roots.push(root);
    const repository = new FilePlanRepository({ root, now: () => "2026-08-27T05:00:00.000Z" });
    const created = await repository.create({
      name: "待 Agent 初始化方案",
      config: createDefaultN6Config("scaffold", "2026-08-27T05:00:00.000Z"),
      metadata: { initialization: { status: "pending", source: "agent" } },
    });
    const beforeHash = await sha256Hex(created.draft.config);
    const incomplete: PlanChangeProposal = {
      schemaVersion: "1.0.0",
      id: "proposal-incomplete-init",
      planId: created.id,
      expectedDraftRevision: created.draftRevision,
      expectedConfigHash: beforeHash,
      createdAt: "2026-08-27T05:00:00.000Z",
      summary: "缺少必要选择的初始化",
      rationale: ["验证完整性边界"],
      operations: [
        { op: "replace", path: "/cpuId", value: "" },
        { op: "remove", path: "/selection/diskSkuId" },
      ],
      predictedImpact: { resolvedFindingIds: [], introducedFindingIds: [], budgetDeltaCny: null },
      status: "proposed",
      kind: "initialization",
      intent: { useCase: "游戏" },
    };

    await expect(new PlanProposalService(repository).apply(created.id, incomplete, undefined, { confirmed: true, approvedBy: "human-test" }))
      .rejects.toMatchObject({ code: "initialization_incomplete", message: expect.stringContaining("selection.diskSkuId") });
    const after = await repository.get(created.id);
    expect(after.draftRevision).toBe(created.draftRevision);
    expect(after.metadata.initialization?.status).toBe("pending");
    expect(await sha256Hex(after.draft.config)).toBe(beforeHash);
  });
});
