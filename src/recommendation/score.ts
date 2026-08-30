import {
  DEFAULT_RECOMMENDATION_WEIGHTS,
  validateRecommendationEligibility,
  validateRecommendationScore,
  type RecommendationPenalty,
  type RecommendationScore,
  type RecommendationWeights,
} from "./contracts";
import type { CandidatePromotionRecord, GovernedPurchaseEligibilityContext, SolverCandidate } from "../solver/contracts";

export type RecommendationObjectiveScores = RecommendationScore["objectiveScores"];

function bounded(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError(`${label} must be between 0 and 1`);
  return value;
}

/** Scores only a currently purchase-eligible whole build; hard gates never become penalties. */
export function scorePurchaseEligibleCandidate(input: {
  readonly candidate: SolverCandidate;
  readonly promotion: CandidatePromotionRecord;
  readonly eligibility: GovernedPurchaseEligibilityContext;
  readonly scoringVersion: string;
  readonly objectiveScores: RecommendationObjectiveScores;
  readonly workloadBenchmarkRefs: readonly string[];
  readonly priceConfidence: RecommendationScore["priceConfidence"];
  readonly penalties?: readonly RecommendationPenalty[];
  readonly weights?: RecommendationWeights;
}): RecommendationScore {
  const eligibilityErrors = validateRecommendationEligibility(input.candidate, input.promotion, input.eligibility);
  if (eligibilityErrors.length > 0) throw new TypeError(`candidate is not rankable: ${eligibilityErrors.join("; ")}`);
  const weights = structuredClone(input.weights ?? DEFAULT_RECOMMENDATION_WEIGHTS);
  const objectives = Object.fromEntries(Object.entries(input.objectiveScores).map(([key, value]) => [key, bounded(value, key)])) as RecommendationObjectiveScores;
  if (input.priceConfidence === "unavailable") objectives.marketAndLifecycleCost = 0;
  const weightedScoreBeforePenalties = Object.entries(weights).reduce((sum, [key, weight]) => sum + weight * objectives[key as keyof RecommendationWeights], 0);
  const penalties = [...(input.penalties ?? [])].map((penalty) => structuredClone(penalty));
  const finalScore = weightedScoreBeforePenalties - penalties.reduce((sum, penalty) => sum + penalty.amount, 0);
  const score: RecommendationScore = {
    candidateId: input.candidate.candidateId,
    promotionRecordId: input.promotion.promotionRecordId,
    scoringVersion: input.scoringVersion,
    weights,
    objectiveScores: objectives,
    workloadBenchmarkRefs: [...input.workloadBenchmarkRefs].sort(),
    penalties,
    weightedScoreBeforePenalties,
    finalScore,
    priceConfidence: input.priceConfidence,
  };
  const errors = validateRecommendationScore(score);
  if (errors.length > 0) throw new TypeError(`recommendation score invalid: ${errors.join("; ")}`);
  return score;
}
