import { RECOMMENDATION_HORIZONS } from "./policy";
import type { RecommendationScore } from "./contracts";
import type { MarketCycleAssessment } from "./market-cycle";

export interface RecommendationExplanation {
  readonly schemaVersion: "recommendation-explanation-v1";
  readonly candidateId: string;
  readonly positiveFactors: readonly string[];
  readonly penalties: readonly string[];
  readonly priceStatement: string;
  readonly factGaps: readonly string[];
  readonly upgradeStatement: string;
  readonly evidenceRefs: readonly string[];
}

export function explainRecommendation(input: {
  readonly score: RecommendationScore;
  readonly marketCycle: MarketCycleAssessment;
  readonly factGaps: readonly string[];
  readonly upgradeImpacts: readonly string[];
}): RecommendationExplanation {
  const positiveFactors = Object.entries(input.score.objectiveScores)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}: ${value.toFixed(3)} × weight ${input.score.weights[key as keyof typeof input.score.weights].toFixed(2)}`);
  return {
    schemaVersion: "recommendation-explanation-v1",
    candidateId: input.score.candidateId,
    positiveFactors,
    penalties: input.score.penalties.map((penalty) => `${penalty.kind}: -${penalty.amount.toFixed(3)} — ${penalty.explanation}`),
    priceStatement: input.score.priceConfidence === "unavailable"
      ? "当前价格不完整；只保留兼容候选，不宣称性价比排序确定。"
      : `${input.marketCycle.explanation} Price confidence: ${input.score.priceConfidence}.`,
    factGaps: [...input.factGaps].sort(),
    upgradeStatement: `骨架件按 ${RECOMMENDATION_HORIZONS.skeletonYears} 年、易替换件按 ${RECOMMENDATION_HORIZONS.replaceableYears.min}-${RECOMMENDATION_HORIZONS.replaceableYears.max} 年评估。${input.upgradeImpacts.join("；")}`,
    evidenceRefs: [...new Set([...input.score.workloadBenchmarkRefs, ...input.score.penalties.flatMap(({ evidenceRefs }) => evidenceRefs), ...input.marketCycle.evidenceRefs])].sort(),
  };
}
