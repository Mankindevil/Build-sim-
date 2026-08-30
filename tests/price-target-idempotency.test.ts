import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PriceRepository } from "../src/price/repository";
import { createPriceTarget, evaluatePriceTarget } from "../src/price/targets";
import { projectCurrentChinaPrice } from "../src/price/policy";
import type { PriceObservation } from "../src/price/contracts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const now = "2026-08-29T00:00:00.000Z";
const evidence = [{ sellerId: "seller", sellerTier: "S1" as const, evidenceRefs: ["claim:seller"], verifiedAt: now }];
function observation(price: number, id: string): PriceObservation {
  return { observationId: id, skuId: "gpu", variantIdentityFactIds: ["variant"], platform: "jd", sellerId: "seller", sellerTier: "S1", sellerTierEvidenceRefs: ["claim:seller"], condition: "new", stockStatus: "in_stock", priceCny: price, comparableTotalCny: price, invoiceStatus: "yes", warrantyStatus: "mainland", canonicalUrl: "https://item.jd.com/gpu.html", listingCaptureId: `capture-${id}`, capturedAt: "2026-08-28T00:00:00.000Z" };
}

describe("U10 durable target crossing idempotency", () => {
  it("survives restart and records first and second crossings once each", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-u10-target-")); roots.push(root);
    const repo = new PriceRepository({ runtimeRoot: root, now: () => now }); await repo.initialize("test");
    const target = await createPriceTarget({ targetId: "target", planId: "plan", skuId: "gpu", variantIdentityFactIds: ["variant"], targetTotalCny: 900, enabled: true }, now);
    let stored = await repo.putTarget(target);
    const evaluate = async (current: typeof stored, quote: PriceObservation, snapshotId: string, at: string) => {
      const projection = projectCurrentChinaPrice({ skuId: "gpu", variantIdentityFactIds: ["variant"], observations: [quote], sellerTierEvidence: evidence, now: at });
      const result = await evaluatePriceTarget({ target: current.target, projection, observations: [quote], priceSnapshotId: snapshotId, now: at });
      const updated = await repo.updateTargetEvaluation(result.target, { expectedRevision: current.revision, expectedHash: current.recordHash });
      if (result.event) await repo.recordTargetEvent(result.event);
      return updated;
    };
    stored = await evaluate(stored, observation(1_000, "high-1"), "snapshot-high-1", now);
    expect(await repo.listTargetEvents()).toEqual([]);
    stored = await evaluate(stored, observation(850, "low-1"), "snapshot-low-1", "2026-08-29T01:00:00.000Z");
    expect(await repo.listTargetEvents()).toHaveLength(1);

    const restarted = new PriceRepository({ runtimeRoot: root, now: () => "2026-08-29T02:00:00.000Z" });
    stored = await restarted.getTarget("target");
    const sameLow = observation(850, "low-retry");
    const projection = projectCurrentChinaPrice({ skuId: "gpu", variantIdentityFactIds: ["variant"], observations: [sameLow], sellerTierEvidence: evidence, now: "2026-08-29T02:00:00.000Z" });
    const noCrossing = await evaluatePriceTarget({ target: stored.target, projection, observations: [sameLow], priceSnapshotId: "snapshot-low-1", now: "2026-08-29T02:00:00.000Z" });
    expect(noCrossing.event).toBeNull();

    stored = await restarted.updateTargetEvaluation(noCrossing.target, { expectedRevision: stored.revision, expectedHash: stored.recordHash });
    stored = await (async () => {
      const high = observation(1_100, "high-2");
      const nextProjection = projectCurrentChinaPrice({ skuId: "gpu", variantIdentityFactIds: ["variant"], observations: [high], sellerTierEvidence: evidence, now: "2026-08-29T03:00:00.000Z" });
      const crossing = await evaluatePriceTarget({ target: stored.target, projection: nextProjection, observations: [high], priceSnapshotId: "snapshot-high-2", now: "2026-08-29T03:00:00.000Z" });
      expect(crossing.event?.transition).toBe("met_to_watching");
      const updated = await restarted.updateTargetEvaluation(crossing.target, { expectedRevision: stored.revision, expectedHash: stored.recordHash });
      await restarted.recordTargetEvent(crossing.event!);
      await restarted.recordTargetEvent({ ...crossing.event!, eventId: "retry-event", occurredAt: "2026-08-29T03:01:00.000Z" });
      return updated;
    })();
    expect(stored.target.status).toBe("watching");
    expect(await restarted.listTargetEvents()).toHaveLength(2);
  });
});
