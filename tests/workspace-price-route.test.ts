import { describe, expect, it, vi } from "vitest";
import type { PlanRepository } from "../src/plans/contracts";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";

describe("U10 workspace price routes", () => {
  const repository = {} as PlanRepository;
  const view = {
    schemaVersion: "plan-current-price-view-v1" as const, planId: "plan-a", draftRevision: 1,
    configHash: "a".repeat(64), evaluationLockHash: "b".repeat(64), priceSnapshotHash: "c".repeat(64),
    priceSnapshotId: "price-snapshot-a", asOf: "2026-08-29", components: [], unresolvedInstanceIds: [],
  };

  it("returns the same server-owned snapshot view and accepts only bounded target inputs", async () => {
    const target = {
      targetId: "target-a", planId: "plan-a", instanceId: "gpu-a", skuId: "gpu.fixture", variantIdentityFactIds: ["claim.variant"],
      targetTotalCny: 4_000, enabled: true, status: "watching" as const, revisionHash: "f".repeat(64), updatedAt: "2026-08-29T00:00:00.000Z",
    };
    const service = {
      forPlan: vi.fn(async () => view),
      createTarget: vi.fn(async () => ({ revision: 0, recordHash: "d".repeat(64), target })),
      reviseTarget: vi.fn(async () => ({ revision: 1, recordHash: "e".repeat(64), target: { ...target, targetTotalCny: 3_900 } })),
    };
    const options = { planPrices: service, priceHistoryEnabled: true, priceTargetsEnabled: true };
    expect(await handleWorkspaceRoute("GET", "/api/workspace/plans/plan-a/prices", {}, repository, options)).toEqual({ status: 200, payload: view });
    expect((await handleWorkspaceRoute("POST", "/api/workspace/plans/plan-a/price-targets", {
      instanceId: "gpu-a", targetTotalCny: 4_000, planId: "forged",
    }, repository, options)).status).toBe(400);
    expect((await handleWorkspaceRoute("POST", "/api/workspace/plans/plan-a/price-targets", {
      instanceId: "gpu-a", targetTotalCny: 4_000,
    }, repository, options)).status).toBe(201);
    expect(service.createTarget).toHaveBeenCalledWith("plan-a", { instanceId: "gpu-a", targetTotalCny: 4_000 });
    expect((await handleWorkspaceRoute("PATCH", "/api/workspace/plans/plan-a/price-targets/target-a", {
      expectedRevision: 0, expectedRecordHash: "d".repeat(64), expectedTargetRevisionHash: "f".repeat(64), targetTotalCny: 3_900,
    }, repository, options)).status).toBe(200);
    expect(service.reviseTarget).toHaveBeenCalledWith("plan-a", expect.objectContaining({ targetId: "target-a", expectedRevision: 0 }));
  });

  it("keeps both routes physically unavailable while their rollout switches are off", async () => {
    expect(await handleWorkspaceRoute("GET", "/api/workspace/plans/plan-a/prices", {}, repository, {})).toEqual({ status: 404, payload: { error: "price_history_disabled" } });
    expect(await handleWorkspaceRoute("GET", "/api/workspace/plans/plan-a/price-targets", {}, repository, { priceHistoryEnabled: true })).toEqual({ status: 503, payload: { error: "plan_price_authority_unavailable" } });
  });
});
