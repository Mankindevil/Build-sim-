import { describe, expect, it } from "vitest";
import { priceFreshness, priceTargetEventIdempotencyKey, scheduleCatchUpBuckets, validateImmutableListingCapture, validatePriceHistoryPoint, validatePriceObservation, validatePriceObservationAuthoritatively, validatePriceTarget, validatePriceTargetEvent, type ImmutableListingCapture, type PriceObservation } from "../src/price/contracts";
import { createAuthoritativeResolver } from "../src/contracts/trusted-context";
import { hashContent } from "../src/hash";

const digest = (letter: string) => letter.repeat(64);
const observation = (): PriceObservation => ({ observationId: "price", skuId: "disk", variantIdentityFactIds: ["variant-12tb"], platform: "jd", sellerId: "seller", sellerTier: "S1", sellerTierEvidenceRefs: ["claim:seller"], condition: "new", stockStatus: "in_stock", priceCny: 1_000, shippingCny: 20, comparableTotalCny: 1_020, invoiceStatus: "yes", warrantyStatus: "mainland", canonicalUrl: "https://item.example/1", listingCaptureId: "capture", capturedAt: "2026-08-27T00:00:00.000Z" });
const capture = (price = observation()): ImmutableListingCapture => ({
  schemaVersion: "listing-capture-v1", listingCaptureId: price.listingCaptureId, skuId: price.skuId, variantIdentityFactIds: [...price.variantIdentityFactIds], platform: price.platform,
  ...(price.sellerId === undefined ? {} : { sellerId: price.sellerId }), ...(price.sellerName === undefined ? {} : { sellerName: price.sellerName }),
  sellerTier: price.sellerTier, condition: price.condition, stockStatus: price.stockStatus,
  priceCny: price.priceCny, ...(price.shippingCny === undefined ? {} : { shippingCny: price.shippingCny }), comparableTotalCny: price.comparableTotalCny,
  ...(price.requiredDiscountConditions === undefined ? {} : { requiredDiscountConditions: price.requiredDiscountConditions }),
  invoiceStatus: price.invoiceStatus, warrantyStatus: price.warrantyStatus, canonicalUrl: price.canonicalUrl, capturedAt: price.capturedAt,
  ...(price.recheckedAt === undefined ? {} : { recheckedAt: price.recheckedAt }), contentHash: digest("f"),
});
const captures = (price = observation()) => new Map([[price.listingCaptureId, capture(price)]]);

describe("U0 price observation/history scheduling contracts", () => {
  it("binds formal prices to captures and comparable delivered total", () => {
    expect(validatePriceObservation(observation(), captures())).toEqual([]);
    expect(validatePriceObservation({ ...observation(), comparableTotalCny: 1_000 }, captures())).toEqual(expect.arrayContaining([
      "price observation fields do not exactly match the immutable listing capture",
      "comparableTotalCny must equal item price plus mandatory shipping after unconditional discounts",
    ]));
    expect(validatePriceObservation(observation(), new Map())).toContain("price observation is not derived from a saved immutable server listing capture");
    expect(validatePriceObservation(observation(), new Set(["capture"]) as never)).toContain("price observation is not derived from a saved immutable server listing capture");
    expect(validatePriceObservation({ ...observation(), skuId: "caller-rebound" }, captures())).toContain("price observation fields do not exactly match the immutable listing capture");
    expect(validatePriceObservation(observation(), new Map([["capture", { ...capture(), contentHash: "caller-id-only" }]]))).toContain("listing capture: listing capture identity/content hash invalid");
    expect(validateImmutableListingCapture({ ...capture(), condition: "used" })).toContain("listing capture governed market fields invalid");
    expect(validateImmutableListingCapture({ ...capture(), platform: "invented-market" })).toContain("listing capture governed market fields invalid");
    expect(validateImmutableListingCapture({ ...capture(), requiredDiscountConditions: [""] })).toContain("listing capture discount conditions invalid");
    expect(validatePriceObservation(observation(), new Map([["capture", { ...capture(), condition: "used" } as never]])))
      .toContain("listing capture: listing capture governed market fields invalid");
    expect(() => validatePriceObservation({})).not.toThrow();
  });

  it("loads and rehashes listing captures through the server resolver", async () => {
    const raw = capture();
    const saved = { ...raw, contentHash: await hashContent(raw, { domain: "listing-capture", schemaVersion: "listing-capture-v1" }) };
    const resolver = createAuthoritativeResolver("listing-capture", (ref) => ref === saved.listingCaptureId ? saved : undefined);
    await expect(validatePriceObservationAuthoritatively(observation(), resolver)).resolves.toEqual([]);
    await expect(validatePriceObservationAuthoritatively({ ...observation(), listingCaptureId: "missing" }, resolver)).resolves.toEqual([
      expect.stringContaining("price observation authoritative capture resolution failed"),
    ]);
    await expect(validatePriceObservationAuthoritatively(observation(), new Map([["capture", saved]]) as never)).resolves.toEqual([
      expect.stringContaining("resolver was not issued by the server composition root"),
    ]);
    const tamperedResolver = createAuthoritativeResolver("listing-capture", () => ({ ...saved, priceCny: 999 }));
    await expect(validatePriceObservationAuthoritatively(observation(), tamperedResolver)).resolves.toEqual(expect.arrayContaining([
      "listing capture contentHash verification failed",
      "price observation fields do not exactly match the immutable listing capture",
    ]));
  });

  it("freezes freshness, event idempotency and at-most-one catch-up bucket", () => {
    expect(priceFreshness("2026-08-24T00:00:00.000Z", "2026-08-27T00:00:00.000Z")).toBe("preferred");
    const base = { targetId: "target", targetRevisionHash: digest("a"), priceSnapshotId: "snapshot", transition: "watching_to_met" as const };
    const event = { eventId: "event", ...base, occurredAt: "2026-08-27T00:00:00.000Z", idempotencyKey: priceTargetEventIdempotencyKey(base) };
    expect(validatePriceTargetEvent(event)).toEqual([]);
    expect(scheduleCatchUpBuckets({ scheduleId: "schedule", jobType: "price_target_recheck", subjectRef: "target", cadenceSeconds: 3600, nextRunAt: "2026-08-20T00:00:00.000Z", enabled: true }, "2026-08-27T00:00:00.000Z")).toBe(1);
    expect(validatePriceTarget({ targetId: "target", planId: "plan", skuId: "disk", variantIdentityFactIds: ["variant-12tb"], targetTotalCny: 900, enabled: true, status: "watching", revisionHash: "bad", updatedAt: "2026-08-27T00:00:00.000Z" })).toContain("price target identity/revision fields missing or invalid");
  });

  it("derives price-history aggregates from exact saved observations", () => {
    const samples = [observation(), { ...observation(), observationId: "price-2", sellerId: "seller-2", priceCny: 1_020, comparableTotalCny: 1_040 }];
    const point = { historyPointId: "history", skuId: "disk", variantIdentityFactIds: ["variant-12tb"], bucketStart: "2026-08-26T00:00:00.000Z", bucketEnd: "2026-08-28T00:00:00.000Z", timeZone: "Asia/Shanghai" as const, policyHash: digest("b"), priceBasis: "comparable_total_cny" as const, condition: "new" as const, region: "CN" as const, currency: "CNY" as const, minCny: 1_020, maxCny: 1_040, medianCny: 1_030, sampleCount: 2, sellerCount: 2, platformCounts: { jd: 2 }, observationIds: ["price", "price-2"], confidence: "medium" as const, snapshotId: "snapshot" };
    expect(validatePriceHistoryPoint(point, samples)).toEqual([]);
    expect(validatePriceHistoryPoint({ ...point, minCny: 1_000 }, samples)).toContain("history aggregates do not match saved observations");
  });
});
