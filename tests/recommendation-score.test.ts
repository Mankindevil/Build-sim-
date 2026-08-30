import { describe, expect, it } from "vitest";
import { scorePurchaseEligibleCandidate } from "../src/recommendation/score";
import { DEFAULT_RECOMMENDATION_WEIGHTS } from "../src/recommendation/contracts";
import { PURCHASE_ELIGIBILITY_POLICY, type CandidatePromotionRecord, type GovernedPurchaseEligibilityContext, type SolverCandidate } from "../src/solver/contracts";
import type { SnapshotHashes } from "../src/hash";

const h = "a".repeat(64);
const hashes: SnapshotHashes = { configHash: h, requirementSpecHash: h, factSnapshotHash: h, userObservationSnapshotHash: h, priceSnapshotHash: h, ruleSetHash: h, systemProfileHash: h, adapterSnapshotHash: h, engineHash: h, simulationModelHash: h, simulationInputHash: h };
const candidate = (): SolverCandidate => ({ candidateId: "candidate", requirementSpecId: "requirements", basePlanVersionId: "version", baseConfigHash: h, candidateConfigRef: "config", operationsRef: "ops", buildConfigHash: h, inputHashes: hashes, evaluationHash: h, candidateKind: "feasibility_candidate", domainCoverage: PURCHASE_ELIGIBILITY_POLICY.requiredDomains.map((domain) => ({ domain, verdict: "pass", domainHash: h, evaluationHash: h, requiredForPurchase: true })), residualRequirementIds: [], excludedReasonIds: [] });
const promotion = (): CandidatePromotionRecord => ({ promotionRecordId: "promotion", candidateId: "candidate", candidateBuildConfigHash: h, revalidatedInputHashes: hashes, coverageHash: h, outcome: "purchase_eligible", residualMustRequirementIds: [], createdAt: "2026-08-29T00:00:00.000Z" });
const eligibility = (): GovernedPurchaseEligibilityContext => ({ policy: PURCHASE_ELIGIBILITY_POLICY, currentInputHashes: hashes, coverage: candidate().domainCoverage, coverageHash: h, coverageArtifactRef: "coverage", authoritativeEvaluation: { evaluationHash: h, evaluatorId: "evaluator", evaluatorVersion: "1", evaluatorContractVersion: "build-evaluation-v1", evaluatorArtifactRef: "artifact", evaluatorArtifactHash: h }, hardRequirementClosure: { requirementSpecHash: h, evaluationHash: h, closureArtifactRef: "closure", closureArtifactHash: h, residualMustRequirementIds: [], unsatisfiedHardConstraintIds: [] } });
const objectives = { workloadValue: 0.9, evidencedReliability: 0.8, maintainability: 0.7, usableExpandability: 0.6, replacementFriction: 0.5, marketAndLifecycleCost: 0.4 };

describe("U10 transparent whole-build score", () => {
  it("uses the documented default weights and keeps penalties separate", () => {
    const score = scorePurchaseEligibleCandidate({ candidate: candidate(), promotion: promotion(), eligibility: eligibility(), scoringVersion: "score-v1", objectiveScores: objectives, workloadBenchmarkRefs: ["benchmark:workload"], priceConfidence: "medium", penalties: [{ kind: "unused_capability", amount: 0.05, explanation: "outside the three-year use horizon", evidenceRefs: ["requirements:horizon"] }] });
    expect(score.weights).toEqual(DEFAULT_RECOMMENDATION_WEIGHTS);
    expect(score.weightedScoreBeforePenalties).toBeCloseTo(0.715, 10);
    expect(score.finalScore).toBeCloseTo(0.665, 10);
    expect(score.penalties).toHaveLength(1);
  });

  it("zeros market value when current price is unavailable", () => {
    const score = scorePurchaseEligibleCandidate({ candidate: candidate(), promotion: promotion(), eligibility: eligibility(), scoringVersion: "score-v1", objectiveScores: objectives, workloadBenchmarkRefs: ["benchmark:workload"], priceConfidence: "unavailable" });
    expect(score.objectiveScores.marketAndLifecycleCost).toBe(0);
  });

  it("rejects a late-domain failure instead of converting it to a score penalty", () => {
    const failed = eligibility();
    failed.coverage = failed.coverage.map((coverage) => coverage.domain === "thermal" ? { ...coverage, verdict: "fail" as const } : coverage);
    expect(() => scorePurchaseEligibleCandidate({ candidate: candidate(), promotion: promotion(), eligibility: failed, scoringVersion: "score-v1", objectiveScores: objectives, workloadBenchmarkRefs: ["benchmark:workload"], priceConfidence: "medium" })).toThrow(/not rankable/);
  });
});
