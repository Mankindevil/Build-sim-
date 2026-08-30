import { describe, expect, it } from "vitest";
import { rankWholeBuilds, type RankableWholeBuild } from "../src/recommendation/ranking";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { DEFAULT_RECOMMENDATION_WEIGHTS, type RecommendationScore } from "../src/recommendation/contracts";
import { PURCHASE_ELIGIBILITY_POLICY, type CandidatePromotionRecord, type GovernedPurchaseEligibilityContext, type SolverCandidate } from "../src/solver/contracts";
import type { SnapshotHashes } from "../src/hash";

const h = "c".repeat(64);
const hashes: SnapshotHashes = { configHash: h, requirementSpecHash: h, factSnapshotHash: h, userObservationSnapshotHash: h, priceSnapshotHash: h, ruleSetHash: h, systemProfileHash: h, adapterSnapshotHash: h, engineHash: h, simulationModelHash: h, simulationInputHash: h };
function rankable(id: string, finalScore: number, market: number): RankableWholeBuild {
  const base = createEmptyBuildConfigV3("plan", "Plan", "2026-08-29T00:00:00.000Z");
  const coverage = PURCHASE_ELIGIBILITY_POLICY.requiredDomains.map((domain) => ({ domain, verdict: "pass" as const, domainHash: h, evaluationHash: h, requiredForPurchase: true }));
  const candidate: SolverCandidate = { candidateId: id, requirementSpecId: "requirements", basePlanVersionId: "version", baseConfigHash: h, candidateConfigRef: `config-${id}`, operationsRef: `ops-${id}`, buildConfigHash: h, inputHashes: hashes, evaluationHash: h, candidateKind: "feasibility_candidate", domainCoverage: coverage, residualRequirementIds: [], excludedReasonIds: [] };
  const promotion: CandidatePromotionRecord = { promotionRecordId: `promotion-${id}`, candidateId: id, candidateBuildConfigHash: h, revalidatedInputHashes: hashes, coverageHash: h, outcome: "purchase_eligible", residualMustRequirementIds: [], createdAt: "2026-08-29T00:00:00.000Z" };
  const eligibility: GovernedPurchaseEligibilityContext = { policy: PURCHASE_ELIGIBILITY_POLICY, currentInputHashes: hashes, coverage, coverageHash: h, coverageArtifactRef: "coverage", authoritativeEvaluation: { evaluationHash: h, evaluatorId: "evaluator", evaluatorVersion: "1", evaluatorContractVersion: "build-evaluation-v1", evaluatorArtifactRef: "artifact", evaluatorArtifactHash: h }, hardRequirementClosure: { requirementSpecHash: h, evaluationHash: h, closureArtifactRef: "closure", closureArtifactHash: h, residualMustRequirementIds: [], unsatisfiedHardConstraintIds: [] } };
  const objectives = { workloadValue: finalScore, evidencedReliability: finalScore, maintainability: finalScore, usableExpandability: finalScore, replacementFriction: finalScore, marketAndLifecycleCost: market };
  const weighted = Object.entries(DEFAULT_RECOMMENDATION_WEIGHTS).reduce((sum, [key, weight]) => sum + weight * objectives[key as keyof typeof objectives], 0);
  const score: RecommendationScore = { candidateId: id, promotionRecordId: promotion.promotionRecordId, scoringVersion: "score-v1", weights: DEFAULT_RECOMMENDATION_WEIGHTS, objectiveScores: objectives, workloadBenchmarkRefs: ["benchmark"], penalties: [], weightedScoreBeforePenalties: weighted, finalScore: weighted, priceConfidence: "medium" };
  return { candidate, promotion, eligibility, score, baseConfig: base, candidateConfig: structuredClone(base), lockedInstanceIds: [], candidateConfigRef: candidate.candidateConfigRef, requirementCoverageRef: "coverage", solverVersion: "solver-v1", searchCompleteness: "complete", explanationRef: `explanation-${id}`, totalCny: 10_000, plannedCny: 8_000, orderedCny: 2_000 };
}

describe("U10 complete whole-build ranking", () => {
  it("emits economy, balanced and long-term tiers with alternatives and exact promotion records", async () => {
    const result = await rankWholeBuilds([rankable("value", 0.7, 1), rankable("balanced", 0.85, 0.6), rankable("long", 0.9, 0.3)]);
    expect(result.recommendations.map(({ tier }) => tier)).toEqual(["economy", "balanced", "long_term"]);
    expect(result.recommendations.every(({ alternativeCandidateIds }) => alternativeCandidateIds.length >= 1)).toBe(true);
    expect(result.recommendations.every(({ solution, inputHashes }) => solution.promotionRecordId.startsWith("promotion-") && inputHashes.engineHash === h)).toBe(true);
  });

  it("excludes stale coverage and rejects replacement of a locked component", async () => {
    const good = rankable("good", 0.8, 0.8);
    const stale = rankable("stale", 0.9, 0.9);
    stale.eligibility.currentInputHashes = { ...hashes, engineHash: "d".repeat(64) };
    const locked = rankable("locked", 0.9, 0.9);
    locked.baseConfig.components.push({ instanceId: "gpu", kind: "gpu", role: "gpu", state: "ordered", identity: { status: "resolved", skuId: "gpu.a", identityClaimIds: ["fact.gpu"] }, source: "user" });
    locked.candidateConfig.components.push({ instanceId: "gpu", kind: "gpu", role: "gpu", state: "ordered", identity: { status: "resolved", skuId: "gpu.b", identityClaimIds: ["fact.gpu-b"] }, source: "agent" });
    (locked.lockedInstanceIds as string[]).push("gpu");
    const secondGood = rankable("second", 0.7, 0.7);
    const result = await rankWholeBuilds([good, secondGood, stale, locked]);
    expect(result.excluded.map(({ candidateId }) => candidateId)).toEqual(["locked", "stale"]);
    expect(result.excluded.find(({ candidateId }) => candidateId === "locked")?.reasonIds).toContain("locked-instance:gpu:component-changed");
  });
});
