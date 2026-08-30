import { describe, expect, it } from "vitest";
import { buildPriceHistoryPoint } from "../src/price/history";
import { validatePriceHistoryPoint, type PriceObservation } from "../src/price/contracts";

function sample(observationId: string, sellerId: string, comparableTotalCny: number): PriceObservation {
  return { observationId, skuId: "disk.fixture", variantIdentityFactIds: ["fact.variant.12tb"], platform: "jd", sellerId, sellerTier: "S2", sellerTierEvidenceRefs: [`claim:${sellerId}`], condition: "new", stockStatus: "in_stock", priceCny: comparableTotalCny, comparableTotalCny, invoiceStatus: "yes", warrantyStatus: "mainland", canonicalUrl: `https://item.jd.com/${observationId}.html`, listingCaptureId: `capture-${observationId}`, capturedAt: "2026-08-28T00:00:00.000Z" };
}

describe("U10 immutable exact-variant price history", () => {
  it("keeps every unique observation while counting independent sellers separately", async () => {
    const observations = [sample("a", "seller-a", 1_000), sample("b", "seller-a", 1_050), sample("c", "seller-b", 1_100)];
    const point = await buildPriceHistoryPoint({ skuId: "disk.fixture", variantIdentityFactIds: ["fact.variant.12tb"], bucketStart: "2026-08-28T00:00:00.000Z", bucketEnd: "2026-08-29T00:00:00.000Z", snapshotId: "snapshot-day", observations: [...observations, observations[0]!] });
    expect(point).toMatchObject({ minCny: 1_000, maxCny: 1_100, medianCny: 1_050, sampleCount: 3, sellerCount: 2, confidence: "medium" });
    expect(point.observationIds).toEqual(["a", "b", "c"]);
    expect(validatePriceHistoryPoint(point, observations)).toEqual([]);
  });
});
