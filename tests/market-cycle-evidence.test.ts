import { describe, expect, it } from "vitest";
import { adviseBuyOrWait } from "../src/price/buy-wait";
import type { CurrentPriceProjection } from "../src/price/policy";
import type { PriceHistoryPoint } from "../src/price/contracts";
import { assessMarketCycle } from "../src/recommendation/market-cycle";

const projection: CurrentPriceProjection = {
  schemaVersion: "current-price-projection-v1", skuId: "gpu", variantIdentityFactIds: ["variant"], status: "single", confidence: "low",
  minCny: 1_000, maxCny: 1_000, sampleCount: 1, sellerCount: 1, preferredObservationIds: ["now"], usableObservationIds: [],
  expiredObservationIds: [], selectedObservationIds: ["now"], platformCounts: { jd: 1 }, riskTags: [], conflict: null,
  alternativesRequired: false, validUntil: "2026-09-04T00:00:00.000Z",
};
const history = (id: string, start: string, end: string, price: number, sampleCount = 2): PriceHistoryPoint => ({
  historyPointId: id, skuId: "gpu", variantIdentityFactIds: ["variant"], bucketStart: start, bucketEnd: end, timeZone: "Asia/Shanghai",
  policyHash: "a".repeat(64), priceBasis: "comparable_total_cny", condition: "new", region: "CN", currency: "CNY",
  minCny: price, maxCny: price + 100, medianCny: price + 50, sampleCount, sellerCount: sampleCount,
  platformCounts: { jd: sampleCount }, observationIds: Array.from({ length: sampleCount }, (_, index) => `${id}-${index}`), confidence: "medium", snapshotId: id,
});

describe("U10 evidence-bounded buy/wait advice", () => {
  it("does not claim a historical low or market cycle from sparse coverage", () => {
    const result = adviseBuyOrWait({ projection, history: [history("one", "2026-08-28T00:00:00.000Z", "2026-08-29T00:00:00.000Z", 900, 1)], replacementFriction: "low" });
    expect(result).toMatchObject({ recommendation: "buy_if_needed", confidence: "low", historicalPosition: null });
    expect(result.uncertainty).toContain("no historical-low or abnormal-cycle claim");
  });

  it("reports position only for a sufficiently covered exact-variant window", () => {
    const result = adviseBuyOrWait({ projection, history: [
      history("old", "2026-07-01T00:00:00.000Z", "2026-07-15T00:00:00.000Z", 900),
      history("new", "2026-08-01T00:00:00.000Z", "2026-08-15T00:00:00.000Z", 1_300),
    ], replacementFriction: "low" });
    expect(result.recommendation).toBe("buy");
    expect(result.historicalPosition).toBeCloseTo(0.2, 6);
    expect(result.historyWindow?.sampleCount).toBe(4);
  });

  it("labels sparse market-cycle language as explicit inference rather than a fact", () => {
    expect(assessMarketCycle({ history: [], currentPriceCny: 1_000, agentInferenceRef: "inference:cycle" })).toMatchObject({
      basis: "agent_inference", confidence: "low", status: "unknown", evidenceRefs: ["inference:cycle"],
    });
  });
});
