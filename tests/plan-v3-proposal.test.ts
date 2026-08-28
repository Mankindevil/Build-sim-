import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildConfigDocument } from "../src/config/types";
import type { TopologyV3PatchOperation } from "../src/contracts/registries";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";
import { hashPlanConfig } from "../src/plans/canonical";
import { createDefaultN6Config } from "../src/plans/default-plan";
import type { PlanChangeProposal } from "../src/plans/contracts";
import { FilePlanRepository } from "../src/plans/file-repository";
import { createBuildConfigV3MigrationCatalogBinding } from "../src/plans/migration";
import { PlanProposalService, previewPlanProposal, previewPlanV3ProposalFromV2, requirementConfirmationFieldId } from "../src/plans/proposals";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";
import { loadBundledCatalog } from "../src/sku/catalog";

const roots: string[] = [];
let sequence = 0;
const now = () => "2026-08-27T14:00:00.000Z";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-plan-v3-proposal-"));
  roots.push(root);
  const repository = new FilePlanRepository<BuildConfigDocument>({
    root, topologyV3Enabled: true, now,
    id: (prefix) => `${prefix}-${String(++sequence).padStart(8, "0")}`,
  });
  const plan = await repository.create({ name: "V3 proposal", config: createEmptyBuildConfigV3("draft", "V3 proposal", now()) });
  return { root, repository, plan, service: new PlanProposalService<BuildConfigDocument>(repository, now) };
}

function proposalInput(plan: Awaited<ReturnType<typeof fixture>>["plan"], id: string, operations: TopologyV3PatchOperation[]) {
  return {
    id,
    planId: plan.id,
    expectedDraftRevision: plan.draftRevision,
    expectedConfigHash: "",
    summary: id,
    rationale: ["fixture"],
    operations,
    createdAt: now(),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  sequence = 0;
});

describe("U2 Plan V3 stable proposals", () => {
  it("atomically migrates and applies the first stable-selector edit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-plan-v3-first-edit-"));
    roots.push(root);
    const previewCatalog = structuredClone(loadBundledCatalog());
    const previewCooler = previewCatalog.skus.find((sku) => sku.id === createDefaultN6Config("probe", now()).selection.coolerId)!;
    previewCooler.attrs = { ...previewCooler.attrs, type: "unrecognized-preview-cooler-kind" };
    // Formal persistence intentionally sees catalog B; the reviewed binding from
    // catalog A must still drive migration, while active V3 safety remains strict.
    const repository = new FilePlanRepository<BuildConfigDocument>({
      root, topologyV3Enabled: true, now, id: (prefix) => `${prefix}-${String(++sequence).padStart(8, "0")}`,
      getCatalog: loadBundledCatalog,
    });
    const plan = await repository.create({ name: "First V3 edit", config: createDefaultN6Config("draft", now()) });
    if (plan.draft.config.schemaVersion !== "2.0.0") throw new Error("fixture must begin as V2");
    const operation: TopologyV3PatchOperation = {
      op: "add", selector: { collection: "components", id: "fan-unresolved" },
      value: { instanceId: "fan-unresolved", kind: "case_fan", role: "rear_fan", state: "planned", identity: { status: "unresolved", userText: "rear fan to review" }, source: "agent" },
    };
    const preview = await previewPlanV3ProposalFromV2(plan.draft.config, {
      id: "proposal-first-v3-edit", planId: plan.id, expectedDraftRevision: plan.draftRevision,
      expectedConfigHash: await hashPlanConfig(plan.draft.config), summary: "First stable edit", rationale: ["reviewed"], operations: [operation], createdAt: now(),
    }, previewCatalog);
    const applied = await new PlanProposalService<BuildConfigDocument>(repository, now)
      .apply(plan.id, preview.proposal, undefined, { confirmed: true, approvedBy: "human" });

    expect(applied.plan.draftRevision).toBe(1);
    expect(applied.plan.draft.config).toEqual(preview.candidate);
    expect(applied.plan.draft.configMigration?.catalogBinding).toEqual(
      await createBuildConfigV3MigrationCatalogBinding(previewCatalog, plan.draft.config.selection.coolerId),
    );
    expect((applied.plan.draft.config as BuildConfigV3).components.some((component) => component.role === "cpu_cooler")).toBe(false);
    expect(applied.plan.draft).toMatchObject({ config: { schemaVersion: "3.0.0", components: expect.arrayContaining([expect.objectContaining({ instanceId: "fan-unresolved" })]) }, configMigration: { sourceVersionId: expect.stringMatching(/^version-/) } });
    expect(await repository.listVersions(plan.id)).toMatchObject([{ reason: "migration-source", config: { schemaVersion: "2.0.0" } }]);
  });

  it("applies two incremental proposals without overwriting the first and permits duplicate SKUs as distinct instances", async () => {
    const { repository, plan, service } = await fixture();
    const firstOperation: TopologyV3PatchOperation = {
      op: "add", selector: { collection: "components", id: "gpu-instance-a" },
      value: {
        instanceId: "gpu-instance-a", kind: "gpu", role: "render_gpu_a", state: "planned",
        identity: { status: "resolved", skuId: "gpu.rtx-a2000-12gb", identityClaimIds: ["claim-a"] }, source: "agent",
      },
    };
    const first = await previewPlanProposal(plan.draft.config as BuildConfigV3, {
      ...proposalInput(plan, "proposal-first", [firstOperation]),
      expectedConfigHash: await hashPlanConfig(plan.draft.config),
    });
    const appliedFirst = await service.apply(plan.id, first.proposal, undefined, { confirmed: true, approvedBy: "human" });

    const secondOperation: TopologyV3PatchOperation = {
      op: "add", selector: { collection: "components", id: "gpu-instance-b" },
      value: {
        instanceId: "gpu-instance-b", kind: "gpu", role: "render_gpu_b", state: "planned",
        identity: { status: "resolved", skuId: "gpu.rtx-a2000-12gb", identityClaimIds: ["claim-b"] }, source: "agent",
      },
    };
    const second = await previewPlanProposal(appliedFirst.plan.draft.config as BuildConfigV3, {
      ...proposalInput(appliedFirst.plan, "proposal-second", [secondOperation]),
      expectedConfigHash: await hashPlanConfig(appliedFirst.plan.draft.config),
    });
    const appliedSecond = await service.apply(plan.id, second.proposal, undefined, { confirmed: true, approvedBy: "human" });
    expect((appliedSecond.plan.draft.config as BuildConfigV3).components).toMatchObject([
      { instanceId: "gpu-instance-a", identity: { skuId: "gpu.rtx-a2000-12gb" } },
      { instanceId: "gpu-instance-b", identity: { skuId: "gpu.rtx-a2000-12gb" } },
    ]);
    await expect(repository.saveVersion(plan.id, {
      expectedRevision: appliedSecond.plan.draftRevision,
      expectedConfigHash: await hashPlanConfig(appliedSecond.plan.draft.config),
      reason: "agent-proposal",
    })).resolves.toMatchObject({ config: { components: [{ instanceId: "gpu-instance-a" }, { instanceId: "gpu-instance-b" }] } });
    await expect(service.validate(plan.id, first.proposal)).rejects.toThrow(/stale_revision/);
  });

  it("keeps unresolved identities versionable and rejects stale V3 base hashes", async () => {
    const { repository, plan, service } = await fixture();
    const preview = await previewPlanProposal(plan.draft.config as BuildConfigV3, {
      ...proposalInput(plan, "proposal-unresolved", [{
        op: "add", selector: { collection: "components", id: "storage-unresolved" },
        value: { instanceId: "storage-unresolved", kind: "storage_drive", role: "data_disk", state: "planned", identity: { status: "unresolved", userText: "用户说的那块 8TB 盘" }, source: "agent" },
      }]),
      expectedConfigHash: await hashPlanConfig(plan.draft.config),
    });
    await repository.updateDraft(plan.id, { expectedRevision: 0, config: { ...plan.draft.config, name: "Concurrent edit" } as BuildConfigV3 });
    await expect(service.apply(plan.id, preview.proposal, undefined, { confirmed: true, approvedBy: "human" }))
      .rejects.toThrow(/stale_revision/);
  });

  it("rejects Agent attempts to spoof trusted component or requirement provenance before apply/audit", async () => {
    const { repository, plan, service } = await fixture();
    const preview = await previewPlanProposal(plan.draft.config as BuildConfigV3, {
      ...proposalInput(plan, "proposal-provenance", [{
        op: "add", selector: { collection: "components", id: "spoofed-component" },
        value: { instanceId: "spoofed-component", kind: "case_fan", role: "fan", state: "planned", identity: { status: "unresolved", userText: "fan" }, source: "agent" },
      }]),
      expectedConfigHash: await hashPlanConfig(plan.draft.config),
    });
    const spoofed = structuredClone(preview.proposal);
    (spoofed.operations[0] as any).value.source = "migration";
    await expect(service.validate(plan.id, spoofed)).rejects.toThrow(/cannot assert trusted/i);
    await expect(service.apply(plan.id, spoofed, undefined, { confirmed: true, approvedBy: "human" })).rejects.toThrow(/cannot assert trusted/i);
    expect((await repository.get(plan.id)).draftRevision).toBe(plan.draftRevision);

    const requirementOperation: TopologyV3PatchOperation = {
      op: "replace", selector: { collection: "config", field: "requirementSpec" },
      value: {
        requirementSpecId: "spoofed-requirements", schemaVersion: "1.0.0",
        workloads: [{ workloadId: "spoofed-workload", state: "answered", name: "work", metrics: [], source: "agent_proposed", confirmedByUser: false }], constraints: [],
      },
    };
    const requirementPreview = await previewPlanProposal(plan.draft.config as BuildConfigV3, {
      ...proposalInput(plan, "proposal-provenance-requirement", [requirementOperation]),
      expectedConfigHash: await hashPlanConfig(plan.draft.config),
    });
    const defaulted = structuredClone(requirementPreview.proposal);
    ((defaulted.operations[0] as any).value.workloads[0]).source = "defaulted";
    await expect(service.validate(plan.id, defaulted)).rejects.toThrow(/cannot assert trusted/i);
  });

  it("server-stamps not-needed decisions only after approval and never accepts forged user authority", async () => {
    const { repository, plan, service } = await fixture();
    const operation = {
      op: "add" as const,
      selector: { collection: "roleDecisions" as const, id: "role-no-gpu" },
      value: { roleDecisionId: "role-no-gpu", role: "discrete_gpu", decision: "not_needed" },
    };
    const preview = await previewPlanProposal(plan.draft.config as BuildConfigV3, {
      ...proposalInput(plan, "proposal-no-gpu", [operation as TopologyV3PatchOperation]),
      expectedConfigHash: await hashPlanConfig(plan.draft.config),
    });
    expect(preview.proposal.operations[0]).toEqual(operation);
    await expect(service.apply(plan.id, preview.proposal, undefined, { confirmed: false, approvedBy: "" }))
      .rejects.toMatchObject({ code: "human_approval_required" });
    expect((await repository.get(plan.id)).draft.config).toMatchObject({ roleDecisions: [] });
    const applied = await service.apply(plan.id, preview.proposal, undefined, { confirmed: true, approvedBy: "human" });
    expect((applied.plan.draft.config as BuildConfigV3).roleDecisions).toEqual([{
      roleDecisionId: "role-no-gpu", role: "discrete_gpu", decision: "not_needed", source: "user", confirmedAt: now(),
    }]);

    const fresh = await fixture();
    const freshPreview = await previewPlanProposal(fresh.plan.draft.config as BuildConfigV3, {
      ...proposalInput(fresh.plan, "proposal-forged-no-gpu", [operation as TopologyV3PatchOperation]),
      expectedConfigHash: await hashPlanConfig(fresh.plan.draft.config),
    });
    const forged = structuredClone(freshPreview.proposal) as PlanChangeProposal<BuildConfigV3>;
    (forged.operations[0] as any).value.source = "user";
    (forged.operations[0] as any).value.confirmedAt = now();
    await expect(fresh.service.validate(fresh.plan.id, forged)).rejects.toThrow(/cannot assert user authority/);
  });

  it("does not turn Agent requirement proposals into solver authority unless approval explicitly confirms fields", async () => {
    const { plan, service } = await fixture();
    const requirementSpec = {
      requirementSpecId: "agent-requirements", schemaVersion: "1.0.0" as const,
      budget: { state: "answered" as const, value: { hardCapCny: 10_000 }, source: "agent_proposed" as const, confirmedByUser: false },
      workloads: [{
        workloadId: "agent-workload", state: "answered" as const, name: "Agent proposal", metrics: [],
        source: "agent_proposed" as const, confirmedByUser: false,
      }],
      constraints: [{
        constraintId: "agent-soft", state: "answered" as const,
        predicate: { facetId: "case.side_panel" as const, operator: "eq" as const, value: "solid" },
        strength: "soft" as const, source: "agent_proposed" as const, confirmedByUser: false,
      }],
    };
    const operation: TopologyV3PatchOperation = {
      op: "replace", selector: { collection: "config", field: "requirementSpec" }, value: requirementSpec,
    };
    const preview = await previewPlanProposal(plan.draft.config as BuildConfigV3, {
      ...proposalInput(plan, "proposal-requirements", [operation]),
      expectedConfigHash: await hashPlanConfig(plan.draft.config),
    });
    const ordinaryApproval = await service.apply(plan.id, preview.proposal, undefined, { confirmed: true, approvedBy: "human" });
    expect((ordinaryApproval.plan.draft.config as BuildConfigV3).requirementSpec).toMatchObject({
      budget: { confirmedByUser: false }, workloads: [{ confirmedByUser: false }], constraints: [{ confirmedByUser: false }],
    });

    const current = ordinaryApproval.plan;
    const confirmBudgetOperation: TopologyV3PatchOperation = {
      op: "replace", selector: { collection: "config", field: "requirementBudget" }, value: requirementSpec.budget,
    };
    const confirmPreview = await previewPlanProposal(current.draft.config as BuildConfigV3, {
      ...proposalInput(current, "proposal-confirm-requirements", [confirmBudgetOperation]),
      expectedConfigHash: await hashPlanConfig(current.draft.config),
    });
    const confirmedBudgetId = requirementConfirmationFieldId("budget");
    const explicit = await service.apply(plan.id, confirmPreview.proposal, undefined, {
      confirmed: true, approvedBy: "human", confirmedRequirementFieldIds: [confirmedBudgetId],
    });
    expect((explicit.plan.draft.config as BuildConfigV3).requirementSpec).toMatchObject({
      budget: { confirmedByUser: true }, workloads: [{ confirmedByUser: false }], constraints: [{ confirmedByUser: false }],
    });
    expect(explicit.audit.confirmedRequirementFieldIds).toEqual([confirmedBudgetId]);

    const scopeFresh = await fixture();
    const scopePreview = await previewPlanProposal(scopeFresh.plan.draft.config as BuildConfigV3, {
      ...proposalInput(scopeFresh.plan, "proposal-invalid-confirm-scope", [operation]),
      expectedConfigHash: await hashPlanConfig(scopeFresh.plan.draft.config),
    });
    await expect(scopeFresh.service.apply(scopeFresh.plan.id, scopePreview.proposal, undefined, {
      confirmed: true, approvedBy: "human", confirmedRequirementFieldIds: ["requirement:constraint:\"not-reviewed\""],
    })).rejects.toMatchObject({ code: "requirement_confirmation_scope_invalid" });

    const fresh = await fixture();
    const freshPreview = await previewPlanProposal(fresh.plan.draft.config as BuildConfigV3, {
      ...proposalInput(fresh.plan, "proposal-forged-requirements", [operation]),
      expectedConfigHash: await hashPlanConfig(fresh.plan.draft.config),
    });
    const forged = structuredClone(freshPreview.proposal);
    ((forged.operations[0] as any).value.constraints[0]).confirmedByUser = true;
    await expect(fresh.service.validate(fresh.plan.id, forged)).rejects.toThrow(/cannot assert user confirmation/);
  });

  it("forwards explicit requirement confirmations through the strict workspace route", async () => {
    const { root, repository, plan, service } = await fixture();
    const budget = { state: "answered" as const, value: { hardCapCny: 9_000 }, source: "agent_proposed" as const, confirmedByUser: false };
    const proposal = (await previewPlanProposal(plan.draft.config as BuildConfigV3, {
      ...proposalInput(plan, "proposal-route-confirmation", [{
        op: "replace", selector: { collection: "config", field: "requirementSpec" },
        value: { requirementSpecId: "route-requirements", schemaVersion: "1.0.0", budget, workloads: [], constraints: [] },
      }]),
      expectedConfigHash: await hashPlanConfig(plan.draft.config),
    })).proposal;
    const budgetId = requirementConfirmationFieldId("budget");
    const response = await handleWorkspaceRoute("POST", `/api/workspace/plans/${plan.id}/proposals/apply`, {
      proposal,
      operationIndexes: [0],
      approvalConfirmed: true,
      approvedBy: "route-human",
      confirmedRequirementFieldIds: [budgetId],
    }, repository, { proposalService: service });

    expect(response).toMatchObject({ status: 200, payload: { audit: { confirmedRequirementFieldIds: [budgetId] } } });
    expect(((response.payload as { plan: { draft: { config: BuildConfigV3 } } }).plan.draft.config).requirementSpec?.budget)
      .toMatchObject({ source: "agent_proposed", confirmedByUser: true });
    const restartedRepository = new FilePlanRepository<BuildConfigDocument>({ root, topologyV3Enabled: true });
    await expect(handleWorkspaceRoute("POST", `/api/workspace/plans/${plan.id}/proposals/apply`, {
      proposal, operationIndexes: [0], approvalConfirmed: true, approvedBy: "route-human", confirmedRequirementFieldIds: [],
    }, restartedRepository, { proposalService: new PlanProposalService(restartedRepository) }))
      .resolves.toMatchObject({ status: 409, payload: { error: "idempotency_conflict" } });
  });

  it("uses granular budget/horizon edits without deleting prior user or Agent requirement facts", async () => {
    const { repository, plan, service } = await fixture();
    const base = structuredClone(plan.draft.config) as BuildConfigV3;
    base.requirementSpec = {
      requirementSpecId: "existing-requirements", schemaVersion: "1.0.0",
      workloads: [
        { workloadId: "user-workload", state: "answered", name: "用户确认工作负载", metrics: [], source: "user", confirmedByUser: true },
        { workloadId: "agent-existing-workload", state: "answered", name: "上一轮 Agent 草案", metrics: [], source: "agent_proposed", confirmedByUser: false },
      ],
      constraints: [{
        constraintId: "user-case-constraint", state: "answered",
        predicate: { facetId: "case.side_panel", operator: "eq", value: "solid" },
        strength: "hard", source: "user", confirmedByUser: true,
      }],
    };
    const existing = await repository.updateDraft(plan.id, { expectedRevision: plan.draftRevision, config: base });
    const budget = { state: "answered" as const, value: { hardCapCny: 12_000 }, source: "agent_proposed" as const, confirmedByUser: false };
    const horizon = { state: "answered" as const, value: 5, source: "agent_proposed" as const, confirmedByUser: false };
    const granularOperations: TopologyV3PatchOperation[] = [
      { op: "replace", selector: { collection: "config", field: "requirementBudget" }, value: budget },
      { op: "replace", selector: { collection: "config", field: "requirementHorizonYears" }, value: horizon },
    ];
    const preview = await previewPlanProposal(existing.draft.config as BuildConfigV3, {
      ...proposalInput(existing, "proposal-granular-requirements", granularOperations),
      expectedConfigHash: await hashPlanConfig(existing.draft.config),
    });
    expect(preview.proposal.confirmableRequirementFieldIds).toEqual([
      requirementConfirmationFieldId("budget"), requirementConfirmationFieldId("horizonYears"),
    ]);
    const applied = await service.apply(plan.id, preview.proposal, undefined, {
      confirmed: true, approvedBy: "human", confirmedRequirementFieldIds: [requirementConfirmationFieldId("budget")],
    });
    const persistedSpec = (applied.plan.draft.config as BuildConfigV3).requirementSpec!;
    expect(persistedSpec).toMatchObject({
      requirementSpecId: "existing-requirements",
      budget: { ...budget, confirmedByUser: true }, horizonYears: horizon,
      workloads: expect.arrayContaining(base.requirementSpec.workloads),
      constraints: base.requirementSpec.constraints,
    });
    expect(persistedSpec.workloads).toHaveLength(base.requirementSpec.workloads.length);
    expect(applied.audit.confirmedRequirementFieldIds).toEqual([requirementConfirmationFieldId("budget")]);

    const destructiveWholeReplace: TopologyV3PatchOperation = {
      op: "replace", selector: { collection: "config", field: "requirementSpec" },
      value: { requirementSpecId: "replacement", schemaVersion: "1.0.0", workloads: [], constraints: [] },
    };
    const destructivePreview = await previewPlanProposal(applied.plan.draft.config as BuildConfigV3, {
      ...proposalInput(applied.plan, "proposal-destructive-whole-replace", [destructiveWholeReplace]),
      expectedConfigHash: await hashPlanConfig(applied.plan.draft.config),
    });
    await expect(service.validate(plan.id, destructivePreview.proposal)).rejects.toMatchObject({
      code: "requirement_spec_replace_forbidden", status: 409,
    });

    const forged = structuredClone(preview.proposal);
    ((forged.operations[0] as any).value).source = "migration";
    const freshService = new PlanProposalService<BuildConfigDocument>(repository, now);
    await expect(freshService.validate(plan.id, forged)).rejects.toThrow(/cannot assert trusted/i);
  });

  it("requires canonical Agent provenance for added requirement entities and confirms only reviewed IDs", async () => {
    const { repository, plan, service } = await fixture();
    const base = structuredClone(plan.draft.config) as BuildConfigV3;
    base.requirementSpec = {
      requirementSpecId: "entity-requirements", schemaVersion: "1.0.0",
      workloads: [{ workloadId: "existing-user-workload", state: "answered", name: "用户字段", metrics: [], source: "user", confirmedByUser: true }],
      constraints: [],
    };
    const existing = await repository.updateDraft(plan.id, { expectedRevision: plan.draftRevision, config: base });
    const operations: TopologyV3PatchOperation[] = [
      {
        op: "add", selector: { collection: "workloads", id: "agent-new-workload" },
        value: { workloadId: "agent-new-workload", state: "answered", name: "Agent 新工作负载", metrics: [], source: "agent_proposed", confirmedByUser: false },
      },
      {
        op: "add", selector: { collection: "metrics", parentId: "existing-user-workload", id: "memory.capacity" },
        value: { metricId: "memory.capacity", state: "answered", operator: "gte", value: 64, unitId: "gib", priority: "must", source: "agent_proposed", confirmedByUser: false },
      },
      {
        op: "add", selector: { collection: "constraints", id: "agent-case-volume" },
        value: { constraintId: "agent-case-volume", state: "answered", predicate: { facetId: "case.side_panel", operator: "eq", value: "solid" }, strength: "soft", source: "agent_proposed", confirmedByUser: false },
      },
    ];
    const preview = await previewPlanProposal(existing.draft.config as BuildConfigV3, {
      ...proposalInput(existing, "proposal-add-requirement-entities", operations),
      expectedConfigHash: await hashPlanConfig(existing.draft.config),
    });
    const confirmationIds = [
      requirementConfirmationFieldId("constraint", "agent-case-volume"),
      requirementConfirmationFieldId("metric", "memory.capacity", "existing-user-workload"),
      requirementConfirmationFieldId("workload", "agent-new-workload"),
    ].sort();
    expect(preview.proposal.confirmableRequirementFieldIds).toEqual(confirmationIds);

    for (const index of [0, 1, 2]) {
      for (const missing of ["state", "source", "confirmedByUser"] as const) {
        const forged = structuredClone(preview.proposal);
        delete (forged.operations[index] as any).value[missing];
        await expect(service.validate(plan.id, forged)).rejects.toThrow(/explicit state.*agent_proposed.*confirmedByUser=false/i);
      }
    }

    const selectedConfirmationIds = confirmationIds.filter((id) => !id.includes("constraint"));
    const applied = await service.apply(plan.id, preview.proposal, undefined, {
      confirmed: true, approvedBy: "human", confirmedRequirementFieldIds: selectedConfirmationIds,
    });
    const spec = (applied.plan.draft.config as BuildConfigV3).requirementSpec!;
    expect(spec.workloads.find((workload) => workload.workloadId === "existing-user-workload")).toMatchObject({
      confirmedByUser: true, metrics: [{ metricId: "memory.capacity", confirmedByUser: true }],
    });
    expect(spec.workloads.find((workload) => workload.workloadId === "agent-new-workload")).toMatchObject({ confirmedByUser: true });
    expect(spec.constraints).toEqual([expect.objectContaining({ constraintId: "agent-case-volume", confirmedByUser: false })]);
    expect(applied.audit.confirmedRequirementFieldIds).toEqual(selectedConfirmationIds);
  });
});
