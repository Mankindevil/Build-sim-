import type { SnapshotHashes } from "../../src/hash";
import { DEFAULT_RECOMMENDATION_WEIGHTS, type RecommendationScore } from "../../src/recommendation/contracts";
import type { RankableWholeBuild } from "../../src/recommendation/ranking";
import { PURCHASE_ELIGIBILITY_POLICY, type CandidatePromotionRecord, type GovernedPurchaseEligibilityContext, type SolverCandidate } from "../../src/solver/contracts";
import { createEmptyBuildConfigV3 } from "../../src/topology/contracts";

export const recommendationFixtureHash = "c".repeat(64);
export const recommendationFixtureHashes: SnapshotHashes = {
  configHash: recommendationFixtureHash, requirementSpecHash: recommendationFixtureHash,
  factSnapshotHash: recommendationFixtureHash, userObservationSnapshotHash: recommendationFixtureHash,
  priceSnapshotHash: recommendationFixtureHash, ruleSetHash: recommendationFixtureHash,
  systemProfileHash: recommendationFixtureHash, adapterSnapshotHash: recommendationFixtureHash,
  engineHash: recommendationFixtureHash, simulationModelHash: recommendationFixtureHash,
  simulationInputHash: recommendationFixtureHash,
};

export function recommendationFixture(id: string, options: {
  readonly score?: number;
  readonly marketScore?: number;
  readonly priceConfidence?: RecommendationScore["priceConfidence"];
  readonly searchCompleteness?: "complete" | "partial";
  readonly includePriceSplit?: boolean;
} = {}): RankableWholeBuild {
  const scoreValue = options.score ?? 0.8;
  const marketScore = options.priceConfidence === "unavailable" ? 0 : (options.marketScore ?? scoreValue);
  const base = createEmptyBuildConfigV3("plan", "Plan", "2026-08-29T00:00:00.000Z");
  const coverage = PURCHASE_ELIGIBILITY_POLICY.requiredDomains.map((domain) => ({
    domain, verdict: "pass" as const, domainHash: recommendationFixtureHash,
    evaluationHash: recommendationFixtureHash, requiredForPurchase: true,
  }));
  const candidate: SolverCandidate = {
    candidateId: id, requirementSpecId: "requirements", basePlanVersionId: "version",
    baseConfigHash: recommendationFixtureHash, candidateConfigRef: `config-${id}`,
    operationsRef: `ops-${id}`, buildConfigHash: recommendationFixtureHash,
    inputHashes: structuredClone(recommendationFixtureHashes), evaluationHash: recommendationFixtureHash,
    candidateKind: "feasibility_candidate", domainCoverage: structuredClone(coverage),
    residualRequirementIds: [], excludedReasonIds: [],
  };
  const promotion: CandidatePromotionRecord = {
    promotionRecordId: `promotion-${id}`, candidateId: id,
    candidateBuildConfigHash: recommendationFixtureHash,
    revalidatedInputHashes: structuredClone(recommendationFixtureHashes), coverageHash: recommendationFixtureHash,
    outcome: "purchase_eligible", residualMustRequirementIds: [], createdAt: "2026-08-29T00:00:00.000Z",
  };
  const eligibility: GovernedPurchaseEligibilityContext = {
    policy: PURCHASE_ELIGIBILITY_POLICY, currentInputHashes: structuredClone(recommendationFixtureHashes),
    coverage: structuredClone(coverage), coverageHash: recommendationFixtureHash, coverageArtifactRef: "coverage",
    authoritativeEvaluation: {
      evaluationHash: recommendationFixtureHash, evaluatorId: "evaluator", evaluatorVersion: "1",
      evaluatorContractVersion: "build-evaluation-v1", evaluatorArtifactRef: "artifact",
      evaluatorArtifactHash: recommendationFixtureHash,
    },
    hardRequirementClosure: {
      requirementSpecHash: recommendationFixtureHash, evaluationHash: recommendationFixtureHash,
      closureArtifactRef: "closure", closureArtifactHash: recommendationFixtureHash,
      residualMustRequirementIds: [], unsatisfiedHardConstraintIds: [],
    },
  };
  const objectives = {
    workloadValue: scoreValue, evidencedReliability: scoreValue, maintainability: scoreValue,
    usableExpandability: scoreValue, replacementFriction: scoreValue, marketAndLifecycleCost: marketScore,
  };
  const weighted = Object.entries(DEFAULT_RECOMMENDATION_WEIGHTS)
    .reduce((sum, [key, weight]) => sum + weight * objectives[key as keyof typeof objectives], 0);
  const score: RecommendationScore = {
    candidateId: id, promotionRecordId: promotion.promotionRecordId, scoringVersion: "score-v1",
    weights: DEFAULT_RECOMMENDATION_WEIGHTS, objectiveScores: objectives,
    workloadBenchmarkRefs: ["benchmark"], penalties: [], weightedScoreBeforePenalties: weighted,
    finalScore: weighted, priceConfidence: options.priceConfidence ?? "medium",
  };
  const includePriceSplit = options.includePriceSplit ?? true;
  return {
    candidate, promotion, eligibility, score, baseConfig: base, candidateConfig: structuredClone(base),
    lockedInstanceIds: [], candidateConfigRef: candidate.candidateConfigRef,
    requirementCoverageRef: "coverage", solverVersion: "solver-v1",
    searchCompleteness: options.searchCompleteness ?? "complete", explanationRef: `explanation-${id}`,
    ...(includePriceSplit ? { totalCny: 10_000, plannedCny: 8_000, orderedCny: 2_000 } : {}),
  };
}
