import { describe, expect, it } from "vitest";
import { validateRecommendationEligibility } from "../src/recommendation/contracts";
import { createCandidatePromotionRecord } from "../src/recommendation/policy";
import { recommendationFixture, recommendationFixtureHashes } from "./helpers/recommendation-fixture";

describe("U10 current late-domain revalidation", () => {
  it("revokes a prior purchase promotion when any current input hash advances", async () => {
    const value = recommendationFixture("candidate");
    const promotion = await createCandidatePromotionRecord({ candidate: value.candidate, context: value.eligibility, createdAt: "2026-08-29T00:00:00.000Z" });
    expect(promotion.outcome).toBe("purchase_eligible");
    value.eligibility.currentInputHashes = { ...recommendationFixtureHashes, simulationModelHash: "d".repeat(64) };
    expect(validateRecommendationEligibility(value.candidate, promotion, value.eligibility)).toContain("promotion input hashes are stale");
  });

  it("returns the candidate to excluded when a late required domain stops passing", async () => {
    const value = recommendationFixture("candidate");
    value.eligibility.coverage = value.eligibility.coverage.map((item) => item.domain === "thermal"
      ? { ...item, verdict: "fail" as const } : item);
    await expect(createCandidatePromotionRecord({ candidate: value.candidate, context: value.eligibility, createdAt: "2026-08-29T00:00:00.000Z" }))
      .resolves.toMatchObject({ outcome: "excluded" });
  });
});
