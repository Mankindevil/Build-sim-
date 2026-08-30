import { describe, expect, it } from "vitest";
import { createPriceTarget, evaluatePriceTarget, revisePriceTarget } from "../src/price/targets";
import { projectCurrentChinaPrice } from "../src/price/policy";
import type { PriceObservation } from "../src/price/contracts";

const now = "2026-08-29T00:00:00.000Z";
const observation = (price: number, snapshot = "a"): PriceObservation => ({
  observationId: `observation-${snapshot}`, skuId: "gpu.fixture", variantIdentityFactIds: ["fact.variant"], platform: "jd", sellerId: "seller-a", sellerTier: "S1", sellerTierEvidenceRefs: ["claim:seller-a"],
  condition: "new", stockStatus: "in_stock", priceCny: price, comparableTotalCny: price, invoiceStatus: "yes", warrantyStatus: "mainland",
  canonicalUrl: "https://item.jd.com/gpu.html", listingCaptureId: `capture-${snapshot}`, capturedAt: "2026-08-28T00:00:00.000Z",
});
const evidence = [{ sellerId: "seller-a", sellerTier: "S1" as const, evidenceRefs: ["claim:seller-a"], verifiedAt: now }];

describe("U10 plan-scoped price target state machine", () => {
  it("uses content-addressed CAS revisions and clears old evaluation state on edit", async () => {
    const created = await createPriceTarget({ targetId: "target-gpu", planId: "plan", instanceId: "gpu", skuId: "gpu.fixture", variantIdentityFactIds: ["fact.variant"], targetTotalCny: 900, enabled: true }, now);
    await expect(revisePriceTarget(created, { targetTotalCny: 800 }, "0".repeat(64), now)).rejects.toThrow(/revision conflict/);
    const revised = await revisePriceTarget({ ...created, lastEvaluatedSnapshotId: "old", lastTriggeredAt: now }, { targetTotalCny: 800 }, created.revisionHash, "2026-08-30T00:00:00.000Z");
    expect(revised.revisionHash).not.toBe(created.revisionHash);
    expect(revised).not.toHaveProperty("lastEvaluatedSnapshotId");
    expect(revised).not.toHaveProperty("lastTriggeredAt");
  });

  it("does not alert on first evaluation, then emits each real crossing exactly once by semantic key", async () => {
    const target = await createPriceTarget({ targetId: "target-gpu", planId: "plan", skuId: "gpu.fixture", variantIdentityFactIds: ["fact.variant"], targetTotalCny: 900, enabled: true }, now);
    const high = observation(1_000, "high");
    const highProjection = projectCurrentChinaPrice({ skuId: target.skuId, variantIdentityFactIds: target.variantIdentityFactIds, observations: [high], sellerTierEvidence: evidence, now });
    const first = await evaluatePriceTarget({ target, projection: highProjection, observations: [high], priceSnapshotId: "snapshot-high", now });
    expect(first.event).toBeNull();
    expect(first.target.status).toBe("watching");

    const low = observation(850, "low");
    const lowProjection = projectCurrentChinaPrice({ skuId: target.skuId, variantIdentityFactIds: target.variantIdentityFactIds, observations: [low], sellerTierEvidence: evidence, now });
    const crossing = await evaluatePriceTarget({ target: first.target, projection: lowProjection, observations: [low], priceSnapshotId: "snapshot-low", now: "2026-08-29T01:00:00.000Z" });
    expect(crossing).toMatchObject({ target: { status: "met" }, event: { transition: "watching_to_met" } });
    const retry = await evaluatePriceTarget({ target: first.target, projection: lowProjection, observations: [low], priceSnapshotId: "snapshot-low", now: "2026-08-29T01:01:00.000Z" });
    expect(retry.event?.idempotencyKey).toBe(crossing.event?.idempotencyKey);
    expect(retry.event?.eventId).toBe(crossing.event?.eventId);
  });
});
