import { describe, expect, it } from "vitest";
import { projectCurrentChinaPrice } from "../src/price/policy";
import type { ImmutableListingCapture, PriceObservation } from "../src/price/contracts";
import { canonicalizeListingUrl, derivePriceObservationFromCapture } from "../scripts/price-server/price-observations.mjs";

const variant = ["fact.variant.32gb"];
function observation(id: string, overrides: Partial<PriceObservation> = {}): PriceObservation {
  return {
    observationId: id, skuId: "memory.fixture", variantIdentityFactIds: variant, platform: "jd", sellerId: id,
    sellerTier: "S1", sellerTierEvidenceRefs: [`claim:${id}`], condition: "new", stockStatus: "in_stock", priceCny: 1_000, comparableTotalCny: 1_000,
    invoiceStatus: "yes", warrantyStatus: "mainland", canonicalUrl: `https://item.jd.com/${id}.html`, listingCaptureId: `capture-${id}`,
    capturedAt: "2026-08-28T00:00:00.000Z", ...overrides,
  };
}

describe("U10 server-derived current China price observations", () => {
  it("derives exact fields from a capture, strips tracking parameters and requires seller-tier evidence", () => {
    const capture: ImmutableListingCapture = {
      schemaVersion: "listing-capture-v1", listingCaptureId: "capture-a", skuId: "memory.fixture", variantIdentityFactIds: variant,
      platform: "jd", sellerId: "seller-a", sellerTier: "S1", condition: "new", stockStatus: "in_stock", priceCny: 999,
      shippingCny: 1, comparableTotalCny: 1_000, invoiceStatus: "yes", warrantyStatus: "mainland",
      canonicalUrl: "https://item.jd.com/1.html?sku=32gb&utm_source=tracker#fragment", capturedAt: "2026-08-28T00:00:00.000Z",
      contentHash: "a".repeat(64),
    };
    expect(() => derivePriceObservationFromCapture(capture)).toThrow(/tier requires/);
    const result = derivePriceObservationFromCapture(capture, { sellerTierEvidenceRefs: ["claim:seller-a"] });
    expect(result).toMatchObject({ skuId: "memory.fixture", listingCaptureId: "capture-a", canonicalUrl: "https://item.jd.com/1.html?sku=32gb" });
    expect(result.sellerTierEvidenceRefs).toEqual(["claim:seller-a"]);
    expect(canonicalizeListingUrl("https://item.jd.com/1.html?utm_source=x&id=1&spm=y")).toBe("https://item.jd.com/1.html?id=1");
  });

  it("shows one fresh point as low confidence and two independent sellers as a range", () => {
    const evidence = ["a", "b"].map((sellerId) => ({ sellerId, sellerTier: "S1" as const, evidenceRefs: [`claim:${sellerId}`], verifiedAt: "2026-08-28T00:00:00.000Z" }));
    const single = projectCurrentChinaPrice({ skuId: "memory.fixture", variantIdentityFactIds: variant, observations: [observation("a", { sellerId: "a" })], sellerTierEvidence: evidence, now: "2026-08-29T00:00:00.000Z" });
    expect(single).toMatchObject({ status: "single", confidence: "low", minCny: 1_000, maxCny: 1_000, sellerCount: 1 });
    const range = projectCurrentChinaPrice({ skuId: "memory.fixture", variantIdentityFactIds: variant, observations: [observation("a", { sellerId: "a" }), observation("b", { sellerId: "b", priceCny: 1_100, comparableTotalCny: 1_100, platform: "tmall", canonicalUrl: "https://detail.tmall.com/item.htm?id=2" })], sellerTierEvidence: evidence, now: "2026-08-29T00:00:00.000Z" });
    expect(range).toMatchObject({ status: "range", confidence: "medium", minCny: 1_000, maxCny: 1_100, sellerCount: 2, platformCounts: { jd: 1, tmall: 1 } });
  });

  it("keeps a large seller spread as a visible conflict and expires current budget after day seven", () => {
    const evidence = ["a", "b"].map((sellerId) => ({ sellerId, sellerTier: "S1" as const, evidenceRefs: [`claim:${sellerId}`], verifiedAt: "2026-08-28T00:00:00.000Z" }));
    const observations = [observation("a", { sellerId: "a" }), observation("b", { sellerId: "b", priceCny: 1_600, comparableTotalCny: 1_600 })];
    expect(projectCurrentChinaPrice({ skuId: "memory.fixture", variantIdentityFactIds: variant, observations, sellerTierEvidence: evidence, now: "2026-08-29T00:00:00.000Z" })).toMatchObject({ status: "conflict", sampleCount: 2, conflict: { minObservationId: "a", maxObservationId: "b", ratio: 1.6 } });
    expect(projectCurrentChinaPrice({ skuId: "memory.fixture", variantIdentityFactIds: variant, observations, sellerTierEvidence: evidence, now: "2026-09-05T00:00:00.001Z" })).toMatchObject({ status: "unavailable", confidence: "unavailable", alternativesRequired: true, sampleCount: 0 });
  });
});
