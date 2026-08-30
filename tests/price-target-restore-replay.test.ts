import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashContent } from "../src/hash";
import type { ImmutableListingCapture, PriceObservation } from "../src/price/contracts";
import { ProductionPlanPriceService } from "../src/price/production";
import { PriceRepository } from "../src/price/repository";
import { PriceTargetEvaluationService } from "../src/price/target-worker";
import { createPriceTarget } from "../src/price/targets";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const h = (character: string) => character.repeat(64);

describe("U10 price target restart replay", () => {
  it("replays an event-first interruption without losing or duplicating the crossing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-price-target-replay-")); roots.push(root);
    let now = "2026-08-29T00:00:00.000Z";
    const coordinator = new RuntimeCoordinator({ root, now: () => now });
    const prices = new PriceRepository({ coordinator, now: () => now });
    await prices.initialize("target-replay-test");
    const add = async (id: string, amount: number): Promise<PriceObservation> => {
      const raw: Omit<ImmutableListingCapture, "contentHash"> = {
        schemaVersion: "listing-capture-v1", listingCaptureId: `capture-${id}`, skuId: "gpu.fixture", variantIdentityFactIds: ["claim.variant.gpu"],
        platform: "jd", sellerId: "seller-a", sellerTier: "unknown", condition: "new", stockStatus: "in_stock", priceCny: amount,
        comparableTotalCny: amount, invoiceStatus: "unknown", warrantyStatus: "mainland", canonicalUrl: `https://item.jd.com/${id}.html`, capturedAt: "2026-08-28T00:00:00.000Z",
      };
      const capture: ImmutableListingCapture = { ...raw, contentHash: await hashContent(raw, { domain: "listing-capture", schemaVersion: "listing-capture-v1" }) };
      const observation: PriceObservation = {
        observationId: `observation-${id}`, skuId: raw.skuId, variantIdentityFactIds: raw.variantIdentityFactIds, platform: "jd", sellerId: "seller-a",
        sellerTier: "unknown", sellerTierEvidenceRefs: [], condition: "new", stockStatus: "in_stock", priceCny: amount, comparableTotalCny: amount,
        invoiceStatus: "unknown", warrantyStatus: "mainland", canonicalUrl: raw.canonicalUrl, listingCaptureId: capture.listingCaptureId, capturedAt: raw.capturedAt,
      };
      await prices.putListingCapture(capture); await prices.putObservation(observation); return observation;
    };
    const high = await add("high", 1_000);
    const low = await add("low", 850);
    const config = createEmptyBuildConfigV3("plan-a", "Plan", now);
    config.components.push({
      instanceId: "gpu-a", kind: "gpu", role: "gpu", state: "planned", source: "user",
      identity: { status: "resolved", skuId: "gpu.fixture", identityClaimIds: ["claim.variant.gpu"] },
    });
    let snapshot = { schemaVersion: "1.1.0", snapshotId: "price-snapshot-high", asOf: "2026-08-29", contentHash: h("a"), quotes: [{ provenanceId: high.observationId }] };
    let priceSnapshotHash = h("a");
    const planPrices = (runtimeCoordinator: RuntimeCoordinator, repository: PriceRepository) => new ProductionPlanPriceService({
      coordinator: runtimeCoordinator,
      prices: repository,
      plans: { getAtRoot: async () => ({ draftRevision: 1, draft: { config } }) },
      locks: {
        currentLockAtRoot: async () => ({ contentHash: h("f"), snapshotHashes: { configHash: h("c"), priceSnapshotHash } }),
        hydrateExternalInputsAtRoot: async () => ({ priceSnapshot: { ref: { contentHash: priceSnapshotHash }, payload: { payload: snapshot } } }),
      },
      now: () => now,
    });
    const target = await createPriceTarget({
      targetId: "target-gpu", planId: "plan-a", instanceId: "gpu-a", skuId: "gpu.fixture",
      variantIdentityFactIds: ["claim.variant.gpu"], targetTotalCny: 900, enabled: true,
    }, now);
    await prices.putTarget(target);
    await prices.putSchedule({ scheduleId: "target-gpu-hourly", jobType: "price_target_recheck", subjectRef: "price-target:target-gpu", cadenceSeconds: 3_600, nextRunAt: "2026-08-29T01:00:00.000Z", enabled: true });
    const first = new PriceTargetEvaluationService({ coordinator, prices, planPrices: planPrices(coordinator, prices), now: () => now });
    await first.evaluateSchedule("target-gpu-hourly");
    expect((await prices.getTarget("target-gpu")).target.status).toBe("watching");
    expect(await prices.listTargetEvents()).toEqual([]);

    now = "2026-08-29T01:00:00.000Z";
    snapshot = { schemaVersion: "1.1.0", snapshotId: "price-snapshot-low", asOf: "2026-08-29", contentHash: h("b"), quotes: [{ provenanceId: low.observationId }] };
    priceSnapshotHash = h("b");
    const interrupted = new PriceTargetEvaluationService({
      coordinator, prices, planPrices: planPrices(coordinator, prices), now: () => now,
      faultAfterEventWrite: () => { throw new Error("fixture interruption after event"); },
    });
    await expect(interrupted.evaluateSchedule("target-gpu-hourly")).rejects.toThrow(/fixture interruption/);
    expect((await prices.getTarget("target-gpu")).target.status).toBe("watching");
    expect(await prices.listTargetEvents()).toHaveLength(1);

    const restartedCoordinator = new RuntimeCoordinator({ root, now: () => now });
    const restartedPrices = new PriceRepository({ coordinator: restartedCoordinator, now: () => now });
    const restarted = new PriceTargetEvaluationService({
      coordinator: restartedCoordinator, prices: restartedPrices, planPrices: planPrices(restartedCoordinator, restartedPrices), now: () => now,
    });
    const commit = await restarted.evaluateSchedule("target-gpu-hourly");
    expect(commit).toMatchObject({ eventCreated: false, eventId: expect.stringMatching(/^price-target-event-/) });
    expect((await restartedPrices.getTarget("target-gpu")).target.status).toBe("met");
    expect(await restartedPrices.listTargetEvents()).toHaveLength(1);
    await restarted.evaluateSchedule("target-gpu-hourly");
    expect(await restartedPrices.listTargetEvents()).toHaveLength(1);
  });
});
