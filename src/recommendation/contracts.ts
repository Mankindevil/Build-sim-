import { isSnapshotHashes, type SnapshotHashes } from "../hash";
import type { CandidatePromotionRecord, GovernedPurchaseEligibilityContext, RankedSolution, SolverCandidate } from "../solver/contracts";
import { validateCandidatePromotion } from "../solver/contracts";
import { resolveAuthoritativeContext, type AuthoritativeResolver } from "../contracts/trusted-context";

export interface RecommendationWeights {
  workloadValue: number;
  evidencedReliability: number;
  maintainability: number;
  usableExpandability: number;
  replacementFriction: number;
  marketAndLifecycleCost: number;
}

export const DEFAULT_RECOMMENDATION_WEIGHTS = Object.freeze({
  workloadValue: 0.30,
  evidencedReliability: 0.20,
  maintainability: 0.15,
  usableExpandability: 0.15,
  replacementFriction: 0.10,
  marketAndLifecycleCost: 0.10,
} satisfies RecommendationWeights);

export interface RecommendationPenalty {
  kind: "unused_capability" | "unsupported_brand_premium" | "abnormal_price_cycle" | "easy_expansion_depreciation";
  amount: number;
  explanation: string;
  evidenceRefs: string[];
}

export interface RecommendationScore {
  candidateId: string;
  promotionRecordId: string;
  scoringVersion: string;
  weights: RecommendationWeights;
  objectiveScores: Record<keyof RecommendationWeights, number>;
  workloadBenchmarkRefs: string[];
  penalties: RecommendationPenalty[];
  weightedScoreBeforePenalties: number;
  finalScore: number;
  priceConfidence: "unavailable" | "low" | "medium" | "high";
}

export interface WholeBuildRecommendation {
  recommendationId: string;
  tier: "economy" | "balanced" | "long_term";
  solution: RankedSolution;
  alternativeCandidateIds: string[];
  candidateConfigRef: string;
  requirementCoverageRef: string;
  inputHashes: SnapshotHashes;
  solverVersion: string;
  scoringVersion: string;
  searchCompleteness: "complete" | "partial";
  optimalityClaim: "bounded_best" | "not_claimed";
  totalCny?: number;
  plannedCny?: number;
  orderedCny?: number;
  explanationRef: string;
}

/** Repository-owned material required to prove one recommendation and score. */
export interface GovernedRecommendationContext {
  candidate: SolverCandidate;
  promotion: CandidatePromotionRecord;
  eligibilityContext: GovernedPurchaseEligibilityContext;
  score: RecommendationScore;
  candidateConfigRef: string;
  requirementCoverageRef: string;
  inputHashes: SnapshotHashes;
}

const RECOMMENDATION_OBJECTIVE_KEYS = Object.freeze([
  "workloadValue",
  "evidencedReliability",
  "maintainability",
  "usableExpandability",
  "replacementFriction",
  "marketAndLifecycleCost",
] satisfies Array<keyof RecommendationWeights>);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactObjectiveKeys(value: unknown): value is Record<keyof RecommendationWeights, number> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === RECOMMENDATION_OBJECTIVE_KEYS.length
    && RECOMMENDATION_OBJECTIVE_KEYS.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => (RECOMMENDATION_OBJECTIVE_KEYS as readonly string[]).includes(key));
}

export function validateRecommendationWeights(weights: unknown): string[] {
  if (!hasExactObjectiveKeys(weights)) return ["recommendation weights must contain exactly the governed objective keys"];
  const values = RECOMMENDATION_OBJECTIVE_KEYS.map((key) => weights[key]);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return ["recommendation weights must be finite and non-negative"];
  return Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 1e-9 ? [] : ["recommendation weights must sum to 1"];
}

export function validateRecommendationScore(value: unknown): string[] {
  if (!isRecord(value)) return ["recommendation score must be an object"];
  const score = value as unknown as RecommendationScore;
  const errors = validateRecommendationWeights(score.weights);
  if (!score.candidateId || !score.promotionRecordId || !score.scoringVersion) errors.push("recommendation score identity fields missing");
  if (!Array.isArray(score.workloadBenchmarkRefs) || score.workloadBenchmarkRefs.length === 0 || score.workloadBenchmarkRefs.some((ref) => typeof ref !== "string" || !ref)) errors.push("workload score requires purpose-specific benchmark evidence");
  const objectivesValid = hasExactObjectiveKeys(score.objectiveScores)
    && RECOMMENDATION_OBJECTIVE_KEYS.every((key) => Number.isFinite(score.objectiveScores[key]));
  if (!objectivesValid) errors.push("recommendation objective scores must contain exactly the governed finite objectives");
  if (!Array.isArray(score.penalties) || score.penalties.some((penalty) => !isRecord(penalty) || !Number.isFinite(penalty.amount) || penalty.amount < 0 || !penalty.explanation || !Array.isArray(penalty.evidenceRefs) || penalty.evidenceRefs.length === 0)) errors.push("recommendation penalties must be evidenced, separately explained and non-negative");
  if (![score.weightedScoreBeforePenalties, score.finalScore].every(Number.isFinite)) errors.push("recommendation totals must be finite");
  if (score.priceConfidence === "unavailable" && objectivesValid && score.objectiveScores.marketAndLifecycleCost > 0) errors.push("missing prices cannot claim positive market value");
  if (hasExactObjectiveKeys(score.weights) && objectivesValid && Array.isArray(score.penalties)
    && score.penalties.every((penalty) => isRecord(penalty) && Number.isFinite(penalty.amount))) {
    const weighted = RECOMMENDATION_OBJECTIVE_KEYS.reduce((total, key) => total + score.weights[key] * score.objectiveScores[key], 0);
    const penaltyTotal = score.penalties.reduce((total, penalty) => total + penalty.amount, 0);
    if (!Number.isFinite(weighted) || !Number.isFinite(score.weightedScoreBeforePenalties) || Math.abs(score.weightedScoreBeforePenalties - weighted) > 1e-9) errors.push("weighted score does not match transparent objectives");
    if (!Number.isFinite(penaltyTotal) || !Number.isFinite(score.finalScore) || Math.abs(score.finalScore - (score.weightedScoreBeforePenalties - penaltyTotal)) > 1e-9) errors.push("penalties must remain separate and reconcile to finalScore");
  }
  return errors;
}

export function validateRecommendationEligibility(
  candidate: SolverCandidate,
  promotion: CandidatePromotionRecord,
  context: GovernedPurchaseEligibilityContext,
): string[] {
  const errors = validateCandidatePromotion(candidate, promotion, context);
  if (promotion.outcome !== "purchase_eligible") errors.push("only purchase_eligible candidates may be ranked");
  return errors;
}

export async function validateRecommendationEligibilityAuthoritatively(
  candidate: SolverCandidate,
  promotion: CandidatePromotionRecord,
  contextRef: string,
  resolver: AuthoritativeResolver<GovernedPurchaseEligibilityContext, "purchase-eligibility-context">,
): Promise<string[]> {
  const resolved = await resolveAuthoritativeContext<GovernedPurchaseEligibilityContext, "purchase-eligibility-context">(
    resolver,
    "purchase-eligibility-context",
    contextRef,
  );
  if (!resolved.ok) return [`recommendation eligibility context resolution failed: ${resolved.error}`];
  return validateRecommendationEligibility(candidate, promotion, resolved.value);
}

export function validateWholeBuildRecommendation(recommendation: WholeBuildRecommendation): string[] {
  const errors: string[] = [];
  if (!recommendation.recommendationId || !recommendation.candidateConfigRef || !recommendation.requirementCoverageRef || !recommendation.solverVersion || !recommendation.scoringVersion || !recommendation.explanationRef) errors.push("whole-build recommendation provenance fields missing");
  if (!isSnapshotHashes(recommendation.inputHashes)) errors.push("whole-build recommendation input hashes invalid");
  if (recommendation.alternativeCandidateIds.length === 0) errors.push("each recommendation tier requires at least one alternative");
  if (new Set(recommendation.alternativeCandidateIds).size !== recommendation.alternativeCandidateIds.length || recommendation.alternativeCandidateIds.includes(recommendation.solution.candidateId)) errors.push("alternatives must be unique and exclude the selected candidate");
  if (recommendation.solution.scoringVersion !== recommendation.scoringVersion) errors.push("solution scoringVersion mismatch");
  if (!Number.isInteger(recommendation.solution.rank) || recommendation.solution.rank < 1) errors.push("solution rank must be a positive integer");
  if (recommendation.searchCompleteness === "partial" && recommendation.optimalityClaim !== "not_claimed") errors.push("partial search cannot claim optimality");
  if (recommendation.totalCny !== undefined) {
    if (![recommendation.totalCny, recommendation.plannedCny, recommendation.orderedCny].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) || Math.abs(recommendation.totalCny - (recommendation.plannedCny ?? 0) - (recommendation.orderedCny ?? 0)) > Number.EPSILON) errors.push("whole-build price split must be finite, non-negative and conserved");
  } else if (recommendation.plannedCny !== undefined || recommendation.orderedCny !== undefined) {
    errors.push("whole-build price split requires totalCny");
  }
  return errors;
}

function sameSnapshotHashes(left: unknown, right: unknown): boolean {
  if (!isSnapshotHashes(left) || !isSnapshotHashes(right)) return false;
  return (Object.keys(left) as Array<keyof SnapshotHashes>).every((field) => left[field] === right[field]);
}

/** Server-facing ranking gate; authoritative score/eligibility never arrive in request JSON. */
export async function validateWholeBuildRecommendationAuthoritatively(
  recommendation: WholeBuildRecommendation,
  contextRef: string,
  resolver: AuthoritativeResolver<GovernedRecommendationContext, "recommendation-context">,
): Promise<string[]> {
  const resolved = await resolveAuthoritativeContext<GovernedRecommendationContext, "recommendation-context">(
    resolver,
    "recommendation-context",
    contextRef,
  );
  if (!resolved.ok) return [`recommendation authoritative context resolution failed: ${resolved.error}`];
  const context = resolved.value;
  const errors = validateWholeBuildRecommendation(recommendation);
  errors.push(...validateRecommendationEligibility(context.candidate, context.promotion, context.eligibilityContext)
    .map((error) => `recommendation eligibility: ${error}`));
  errors.push(...validateRecommendationScore(context.score).map((error) => `recommendation score: ${error}`));
  if (recommendation.solution.candidateId !== context.candidate.candidateId
    || recommendation.solution.promotionRecordId !== context.promotion.promotionRecordId
    || context.score.candidateId !== context.candidate.candidateId
    || context.score.promotionRecordId !== context.promotion.promotionRecordId) errors.push("recommendation candidate/promotion binding differs from authoritative context");
  if (recommendation.scoringVersion !== context.score.scoringVersion
    || recommendation.solution.scoringVersion !== context.score.scoringVersion) errors.push("recommendation scoringVersion differs from authoritative score");
  if (JSON.stringify(recommendation.solution.objectiveScores) !== JSON.stringify(context.score.objectiveScores)) errors.push("recommendation objective scores differ from authoritative score");
  if (recommendation.candidateConfigRef !== context.candidateConfigRef
    || recommendation.requirementCoverageRef !== context.requirementCoverageRef) errors.push("recommendation artifact refs differ from authoritative context");
  if (!sameSnapshotHashes(recommendation.inputHashes, context.inputHashes)) errors.push("recommendation input hashes differ from authoritative context");
  return errors;
}

export function validateRecommendationSet(recommendations: readonly WholeBuildRecommendation[]): string[] {
  const errors: string[] = [];
  const tiers = recommendations.map((recommendation) => recommendation.tier);
  for (const tier of ["economy", "balanced", "long_term"] as const) if (!tiers.includes(tier)) errors.push(`recommendation tier missing: ${tier}`);
  if (new Set(tiers).size !== tiers.length) errors.push("recommendation tiers must be unique");
  for (const recommendation of recommendations) errors.push(...validateWholeBuildRecommendation(recommendation).map((error) => `${recommendation.tier}: ${error}`));
  return errors;
}
