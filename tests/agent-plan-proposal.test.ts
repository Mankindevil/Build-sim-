import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilePlanRepository } from "../src/plans/file-repository";
import { createDefaultN6Config } from "../src/plans/default-plan";
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
});
