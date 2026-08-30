import { describe, expect, it } from "vitest";
import type { SnapshotHashes } from "../src/hash";
import {
  DEFAULT_RECOMMENDATION_WEIGHTS,
  validateRecommendationScore,
  validateRecommendationEligibilityAuthoritatively,
  validateRecommendationSet,
  validateWholeBuildRecommendation,
  validateWholeBuildRecommendationAuthoritatively,
  type GovernedRecommendationContext,
  type RecommendationScore,
  type WholeBuildRecommendation,
} from "../src/recommendation/contracts";
import { PURCHASE_ELIGIBILITY_POLICY, type CandidatePromotionRecord, type GovernedPurchaseEligibilityContext, type SolverCandidate } from "../src/solver/contracts";
import { createAuthoritativeResolver } from "../src/contracts/trusted-context";

const digest = "c".repeat(64);
const hashes: SnapshotHashes = { configHash: digest, requirementSpecHash: digest, factSnapshotHash: digest, userObservationSnapshotHash: digest, priceSnapshotHash: digest, ruleSetHash: digest, systemProfileHash: digest, adapterSnapshotHash: digest, engineHash: digest, simulationModelHash: digest, simulationInputHash: digest };
const recommendation = (tier: WholeBuildRecommendation["tier"]): WholeBuildRecommendation => ({
  recommendationId: tier, tier, solution: { candidateId: `candidate-${tier}`, promotionRecordId: `promotion-${tier}`, scoringVersion: "score-v1", objectiveScores: {}, rank: 1, explanationRef: "explanation" }, alternativeCandidateIds: [`alternative-${tier}`], candidateConfigRef: "config", requirementCoverageRef: "coverage", inputHashes: hashes, solverVersion: "solver-v1", scoringVersion: "score-v1", searchCompleteness: "complete", priceConfidence: "medium", optimalityClaim: "bounded_best", totalCny: 10_000, plannedCny: 7_000, orderedCny: 3_000, explanationRef: "explanation",
});
const objectives = { workloadValue: 1, evidencedReliability: 1, maintainability: 1, usableExpandability: 1, replacementFriction: 1, marketAndLifecycleCost: 1 };
const candidate = (): SolverCandidate => ({
  candidateId: "candidate-economy", requirementSpecId: "spec", basePlanVersionId: "v1", baseConfigHash: digest,
  candidateConfigRef: "config", operationsRef: "operations", buildConfigHash: digest, inputHashes: hashes,
  evaluationHash: digest, candidateKind: "feasibility_candidate",
  domainCoverage: PURCHASE_ELIGIBILITY_POLICY.requiredDomains.map((domain) => ({ domain, verdict: "pass", domainHash: digest, evaluationHash: digest, requiredForPurchase: true })),
  residualRequirementIds: [], excludedReasonIds: [],
});
const promotion = (): CandidatePromotionRecord => ({
  promotionRecordId: "promotion-economy", candidateId: "candidate-economy", candidateBuildConfigHash: digest,
  revalidatedInputHashes: hashes, coverageHash: digest, outcome: "purchase_eligible", residualMustRequirementIds: [], createdAt: "2026-08-27T00:00:00.000Z",
});
const eligibility = (): GovernedPurchaseEligibilityContext => ({
  policy: PURCHASE_ELIGIBILITY_POLICY, currentInputHashes: hashes, coverage: candidate().domainCoverage, coverageHash: digest, coverageArtifactRef: "coverage",
  authoritativeEvaluation: { evaluationHash: digest, evaluatorId: "evaluator", evaluatorVersion: "1", evaluatorContractVersion: "build-evaluation-v1", evaluatorArtifactRef: "evaluator", evaluatorArtifactHash: digest },
  hardRequirementClosure: { requirementSpecHash: digest, evaluationHash: digest, closureArtifactRef: "closure", closureArtifactHash: digest, residualMustRequirementIds: [], unsatisfiedHardConstraintIds: [] },
});
const score = (): RecommendationScore => ({
  candidateId: "candidate-economy", promotionRecordId: "promotion-economy", scoringVersion: "score-v1", weights: DEFAULT_RECOMMENDATION_WEIGHTS,
  objectiveScores: objectives, workloadBenchmarkRefs: ["benchmark-for-workload"], penalties: [], weightedScoreBeforePenalties: 1, finalScore: 1, priceConfidence: "high",
});
const authoritativeRecommendation = (): GovernedRecommendationContext => ({
  candidate: candidate(), promotion: promotion(), eligibilityContext: eligibility(), score: score(),
  candidateConfigRef: "config", requirementCoverageRef: "coverage", inputHashes: hashes,
});

describe("U0 recommendation contracts", () => {
  it("keeps objective weights transparent and penalties separately reconcilable", () => {
    const score = {
      candidateId: "candidate", promotionRecordId: "promotion", scoringVersion: "score-v1", weights: DEFAULT_RECOMMENDATION_WEIGHTS,
      objectiveScores: { workloadValue: 1, evidencedReliability: 1, maintainability: 1, usableExpandability: 1, replacementFriction: 1, marketAndLifecycleCost: 1 },
      workloadBenchmarkRefs: ["benchmark-for-workload"], penalties: [{ kind: "unused_capability", amount: 0.1, explanation: "Unused during horizon", evidenceRefs: ["usage-horizon"] }], weightedScoreBeforePenalties: 1, finalScore: 0.9, priceConfidence: "high",
    } as const;
    expect(validateRecommendationScore(score)).toEqual([]);
    expect(validateRecommendationScore({ ...score, objectiveScores: { ...score.objectiveScores, attackerScore: 1 } })).toContain("recommendation objective scores must contain exactly the governed finite objectives");
    const { workloadValue: _omitted, ...missingObjective } = score.objectiveScores;
    expect(validateRecommendationScore({ ...score, objectiveScores: { ...missingObjective, attackerScore: 1 } })).toContain("recommendation objective scores must contain exactly the governed finite objectives");
    expect(validateRecommendationScore({ ...score, objectiveScores: { ...score.objectiveScores, workloadValue: Number.NaN }, weightedScoreBeforePenalties: Number.NaN, finalScore: Number.NaN })).toEqual(expect.arrayContaining([
      "recommendation objective scores must contain exactly the governed finite objectives",
      "recommendation totals must be finite",
    ]));
    expect(validateRecommendationScore({ ...score, weights: { ...score.weights, hidden: 0 } })).toContain("recommendation weights must contain exactly the governed objective keys");
    expect(() => validateRecommendationScore({})).not.toThrow();
  });

  it("forbids an optimality claim for partial search and requires all three complete-build tiers", () => {
    expect(validateWholeBuildRecommendation({ ...recommendation("economy"), searchCompleteness: "partial" })).toContain("partial search cannot claim optimality");
    expect(validateRecommendationSet([recommendation("economy"), recommendation("balanced")])).toContain("recommendation tier missing: long_term");
    expect(validateRecommendationSet([recommendation("economy"), recommendation("balanced"), recommendation("long_term")])).toEqual([]);
    expect(validateWholeBuildRecommendation({ ...recommendation("economy"), inputHashes: { ...hashes, engineHash: "bad" } })).toContain("whole-build recommendation input hashes invalid");
    expect(validateWholeBuildRecommendation({ ...recommendation("economy"), alternativeCandidateIds: ["candidate-economy"] })).toContain("alternatives must be unique and exclude the selected candidate");
  });

  it("resolves eligibility and scores from authoritative artifacts before ranking", async () => {
    const eligibilityResolver = createAuthoritativeResolver("purchase-eligibility-context", (ref) => ref === "eligibility/economy" ? eligibility() : undefined);
    await expect(validateRecommendationEligibilityAuthoritatively(candidate(), promotion(), "eligibility/economy", eligibilityResolver)).resolves.toEqual([]);
    await expect(validateRecommendationEligibilityAuthoritatively(candidate(), promotion(), "eligibility/economy", eligibility() as never)).resolves.toEqual([
      expect.stringContaining("resolver was not issued by the server composition root"),
    ]);

    const value = recommendation("economy");
    value.solution.objectiveScores = objectives;
    const resolver = createAuthoritativeResolver("recommendation-context", (ref) => ref === "recommendation/economy" ? authoritativeRecommendation() : undefined);
    await expect(validateWholeBuildRecommendationAuthoritatively(value, "recommendation/economy", resolver)).resolves.toEqual([]);
    await expect(validateWholeBuildRecommendationAuthoritatively(value, "missing", resolver)).resolves.toEqual([
      expect.stringContaining("recommendation authoritative context resolution failed"),
    ]);
    const tampered = createAuthoritativeResolver("recommendation-context", () => ({
      ...authoritativeRecommendation(), score: { ...score(), objectiveScores: { ...objectives, workloadValue: 0 } },
    }));
    await expect(validateWholeBuildRecommendationAuthoritatively(value, "recommendation/economy", tampered)).resolves.toEqual(expect.arrayContaining([
      "recommendation score: weighted score does not match transparent objectives",
      "recommendation objective scores differ from authoritative score",
    ]));
  });
});
