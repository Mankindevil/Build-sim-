import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashContent } from "../src/hash";
import type { ImmutableListingCapture, PriceObservation } from "../src/price/contracts";
import { ProductionPlanPriceService } from "../src/price/production";
import { ProductionPriceRuntime } from "../src/price/production-runtime";
import { PriceRepository } from "../src/price/repository";
import { CurrentPriceSnapshotService } from "../src/price/snapshot";
import { createPriceTarget } from "../src/price/targets";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const h = (character: string) => character.repeat(64);

describe("U10 scheduled second price crossing", () => {
  it("runs durable target jobs and emits each downward crossing once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-price-crossing-")); roots.push(root);
    let now = "2026-08-29T00:00:00.000Z";
    const coordinator = new RuntimeCoordinator({ root, now: () => now });
    const prices = new PriceRepository({ coordinator, now: () => now }); await prices.initialize("target-crossing-test");
    const observations = new Map<string, PriceObservation>();
    for (const [id, amount] of [["high", 1_000], ["low", 850]] as const) {
      const raw: Omit<ImmutableListingCapture, "contentHash"> = {
        schemaVersion: "listing-capture-v1", listingCaptureId: `capture-${id}`, skuId: "gpu.fixture", variantIdentityFactIds: ["claim.variant.gpu"],
        platform: "jd", sellerId: "seller-a", sellerTier: "unknown", condition: "new", stockStatus: "in_stock", priceCny: amount,
        comparableTotalCny: amount, invoiceStatus: "unknown", warrantyStatus: "mainland", canonicalUrl: `https://item.jd.com/${id}.html`, capturedAt: "2026-08-28T00:00:00.000Z",
      };
      const capture = { ...raw, contentHash: await hashContent(raw, { domain: "listing-capture", schemaVersion: "listing-capture-v1" }) };
      const observation: PriceObservation = {
        observationId: `observation-${id}`, skuId: raw.skuId, variantIdentityFactIds: raw.variantIdentityFactIds, platform: raw.platform, sellerId: "seller-a",
        sellerTier: "unknown", sellerTierEvidenceRefs: [], condition: "new", stockStatus: "in_stock", priceCny: amount, comparableTotalCny: amount,
        invoiceStatus: "unknown", warrantyStatus: "mainland", canonicalUrl: raw.canonicalUrl, listingCaptureId: capture.listingCaptureId, capturedAt: raw.capturedAt,
      };
      await prices.putListingCapture(capture); await prices.putObservation(observation); observations.set(id, observation);
    }
    const config = createEmptyBuildConfigV3("plan-a", "Plan", now);
    config.components.push({ instanceId: "gpu-a", kind: "gpu", role: "gpu", state: "planned", source: "user", identity: { status: "resolved", skuId: "gpu.fixture", identityClaimIds: ["claim.variant.gpu"] } });
    let snapshotId = "price-snapshot-initial"; let priceSnapshotHash = h("a"); let observationId = observations.get("high")!.observationId;
    const planPrices = new ProductionPlanPriceService({
      coordinator, prices,
      plans: { getAtRoot: async () => ({ draftRevision: 1, draft: { config } }) },
      locks: {
        currentLockAtRoot: async () => ({ contentHash: h("f"), snapshotHashes: { configHash: h("c"), priceSnapshotHash } }),
        hydrateExternalInputsAtRoot: async () => ({ priceSnapshot: { ref: { contentHash: priceSnapshotHash }, payload: { payload: { schemaVersion: "1.1.0", snapshotId, asOf: "2026-08-29", contentHash: priceSnapshotHash, quotes: [{ provenanceId: observationId }] } } } }),
      }, now: () => now,
    });
    const target = await createPriceTarget({ targetId: "target-gpu", planId: "plan-a", instanceId: "gpu-a", skuId: "gpu.fixture", variantIdentityFactIds: ["claim.variant.gpu"], targetTotalCny: 900, enabled: true }, now);
    await prices.putTarget(target);
    await prices.putSchedule({ scheduleId: "target-gpu-hourly", jobType: "price_target_recheck", subjectRef: "price-target:target-gpu", cadenceSeconds: 3_600, nextRunAt: now, enabled: true });
    const snapshots = new CurrentPriceSnapshotService({ coordinator, prices, catalog: () => ({ schemaVersion: "2.0.0", skus: [] }), now: () => now });
    const runtime = new ProductionPriceRuntime({
      coordinator, prices, planPrices, snapshots,
      currentSnapshotAtRoot: () => ({ schemaVersion: "1.1.0", snapshotId, asOf: "2026-08-29", contentHash: priceSnapshotHash, quotes: [] }),
      online: () => true, now: () => now, schedulerIntervalMs: 100,
    });
    expect((await runtime.tick()).worker.worker.outcome).toBe("succeeded");
    expect(await prices.listTargetEvents()).toHaveLength(0);

    const step = async (hour: number, id: "high" | "low", hash: string) => {
      now = `2026-08-29T${String(hour).padStart(2, "0")}:00:00.000Z`;
      snapshotId = `price-snapshot-${id}-${hour}`; priceSnapshotHash = h(hash); observationId = observations.get(id)!.observationId;
      const result = await runtime.tick(); expect(result.worker.worker.outcome).toBe("succeeded");
    };
    await step(1, "low", "b");
    expect((await prices.getTarget("target-gpu")).target.status).toBe("met");
    expect(await prices.listTargetEvents()).toHaveLength(1);
    const duplicate = await runtime.tick();
    expect(duplicate.schedules.every(({ due }) => !due)).toBe(true);
    expect(await prices.listTargetEvents()).toHaveLength(1);
    await step(2, "high", "d");
    await step(3, "low", "e");
    expect((await prices.listTargetEvents()).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)).map(({ transition }) => transition))
      .toEqual(["watching_to_met", "met_to_watching", "watching_to_met"]);
    expect(new Set((await prices.listTargetEvents()).map(({ eventId }) => eventId)).size).toBe(3);
  });
});
