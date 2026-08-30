import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionPlanPriceService } from "../src/price/production";
import { PriceRepository } from "../src/price/repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U10 price target CAS editing", () => {
  it("pauses and resumes one active target head with its durable schedule, rejecting a concurrent stale edit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-price-target-edit-")); roots.push(root);
    let now = "2026-08-29T00:00:00.000Z";
    const coordinator = new RuntimeCoordinator({ root, now: () => now });
    const prices = new PriceRepository({ coordinator, now: () => now });
    const config = createEmptyBuildConfigV3("plan-a", "Plan", now);
    config.components.push({
      instanceId: "gpu-a", kind: "gpu", role: "gpu", state: "planned", source: "user",
      identity: { status: "resolved", skuId: "gpu.fixture", identityClaimIds: ["variant.gpu"] },
    });
    const service = new ProductionPlanPriceService({
      coordinator, prices, plans: { getAtRoot: async () => ({ draftRevision: 1, draft: { config } }) },
      locks: { currentLockAtRoot: async () => null, hydrateExternalInputsAtRoot: async () => { throw new Error("unused"); } },
      now: () => now,
    });
    const created = await service.createTarget("plan-a", { instanceId: "gpu-a", targetTotalCny: 4_000 });
    const [schedule] = await prices.listSchedules();
    expect(schedule?.schedule).toMatchObject({ jobType: "price_target_recheck", enabled: true, subjectRef: `price-target:${created.target.targetId}` });

    now = "2026-08-29T01:00:00.000Z";
    const paused = await service.reviseTarget("plan-a", {
      targetId: created.target.targetId, expectedRevision: created.revision, expectedRecordHash: created.recordHash,
      expectedTargetRevisionHash: created.target.revisionHash, enabled: false,
    });
    expect(paused.target).toMatchObject({ enabled: false, status: "paused" });
    expect((await prices.listSchedules())[0]?.schedule.enabled).toBe(false);
    await expect(service.reviseTarget("plan-a", {
      targetId: created.target.targetId, expectedRevision: created.revision, expectedRecordHash: created.recordHash,
      expectedTargetRevisionHash: created.target.revisionHash, targetTotalCny: 3_900,
    })).rejects.toThrow(/revision changed|conflict/);

    now = "2026-08-29T02:00:00.000Z";
    const resumed = await service.reviseTarget("plan-a", {
      targetId: paused.target.targetId, expectedRevision: paused.revision, expectedRecordHash: paused.recordHash,
      expectedTargetRevisionHash: paused.target.revisionHash, enabled: true, targetTotalCny: 3_900,
    });
    expect(resumed.target).toMatchObject({ enabled: true, status: "watching", targetTotalCny: 3_900 });
    expect(await prices.listTargets()).toHaveLength(1);
    expect((await prices.listSchedules())).toMatchObject([{ schedule: { enabled: true }, revision: 2 }]);
  });
});
