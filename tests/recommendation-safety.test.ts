import { describe, expect, it } from "vitest";
import { rankWholeBuilds } from "../src/recommendation/ranking";
import { recommendationFixture } from "./helpers/recommendation-fixture";

describe("U10 recommendation hard gates and price certainty", () => {
  it("excludes failed or blocked purchase domains before scoring", async () => {
    const blocked = recommendationFixture("blocked", { score: 1 });
    blocked.candidate.domainCoverage = blocked.candidate.domainCoverage.map((item) => item.domain === "electrical"
      ? { ...item, verdict: "blocked" as const } : item);
    blocked.candidate.excludedReasonIds = ["domain:electrical:blocked"];
    blocked.eligibility.coverage = blocked.eligibility.coverage.map((item) => item.domain === "electrical"
      ? { ...item, verdict: "blocked" as const } : item);
    const result = await rankWholeBuilds([recommendationFixture("a"), recommendationFixture("b"), blocked]);
    expect(result.excluded.map(({ candidateId }) => candidateId)).toContain("blocked");
    expect(result.recommendations.every(({ solution }) => solution.candidateId !== "blocked")).toBe(true);
  });

  it("keeps low or unavailable price candidates but never states a determined best-value result", async () => {
    for (const priceConfidence of ["low", "unavailable"] as const) {
      const selected = recommendationFixture(`selected-${priceConfidence}`, { score: 0.95, priceConfidence, includePriceSplit: priceConfidence !== "unavailable" });
      const result = await rankWholeBuilds([selected, recommendationFixture(`alternative-${priceConfidence}`, { score: 0.7, priceConfidence })]);
      expect(result.recommendations.every((item) => item.priceConfidence === priceConfidence && item.optimalityClaim === "not_claimed")).toBe(true);
    }
  });
});
