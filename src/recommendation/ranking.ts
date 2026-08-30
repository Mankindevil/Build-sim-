import { canonicalize, hashContent } from "../hash";
import type { BuildConfigV3 } from "../topology/contracts";
import type { CandidatePromotionRecord, GovernedPurchaseEligibilityContext, SolverCandidate } from "../solver/contracts";
import {
  validateRecommendationEligibility,
  validateRecommendationScore,
  validateRecommendationSet,
  type RecommendationScore,
  type WholeBuildRecommendation,
} from "./contracts";

export interface RankableWholeBuild {
  readonly candidate: SolverCandidate;
  readonly promotion: CandidatePromotionRecord;
  readonly eligibility: GovernedPurchaseEligibilityContext;
  readonly score: RecommendationScore;
  readonly baseConfig: BuildConfigV3;
  readonly candidateConfig: BuildConfigV3;
  readonly lockedInstanceIds: readonly string[];
  readonly candidateConfigRef: string;
  readonly requirementCoverageRef: string;
  readonly solverVersion: string;
  readonly searchCompleteness: "complete" | "partial";
  readonly explanationRef: string;
  readonly totalCny?: number;
  readonly plannedCny?: number;
  readonly orderedCny?: number;
}

export interface ExcludedWholeBuild {
  readonly candidateId: string;
  readonly reasonIds: readonly string[];
}

function collectionEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
  return canonicalize(left) === canonicalize(right);
}

/** Locked instance identity, placement, connection and storage membership are immutable during ranking. */
export function validateLockedInstancesPreserved(base: BuildConfigV3, candidate: BuildConfigV3, lockedInstanceIds: readonly string[]): string[] {
  const errors: string[] = [];
  const locked = new Set([
    ...lockedInstanceIds,
    ...base.components.filter(({ state, source }) => state === "ordered" || source === "user").map(({ instanceId }) => instanceId),
  ]);
  for (const instanceId of [...locked].sort()) {
    const before = base.components.find((component) => component.instanceId === instanceId);
    const after = candidate.components.find((component) => component.instanceId === instanceId);
    if (!before || !after || canonicalize(before) !== canonicalize(after)) errors.push(`locked-instance:${instanceId}:component-changed`);
    const beforePlacements = base.placements.filter((placement) => placement.componentInstanceId === instanceId).sort((a, b) => a.placementId.localeCompare(b.placementId));
    const afterPlacements = candidate.placements.filter((placement) => placement.componentInstanceId === instanceId).sort((a, b) => a.placementId.localeCompare(b.placementId));
    if (!collectionEqual(beforePlacements, afterPlacements)) errors.push(`locked-instance:${instanceId}:placement-changed`);
    const beforeConnections = base.connections.filter((edge) => edge.from.instanceId === instanceId || edge.to.instanceId === instanceId).sort((a, b) => a.connectionId.localeCompare(b.connectionId));
    const afterConnections = candidate.connections.filter((edge) => edge.from.instanceId === instanceId || edge.to.instanceId === instanceId).sort((a, b) => a.connectionId.localeCompare(b.connectionId));
    if (!collectionEqual(beforeConnections, afterConnections)) errors.push(`locked-instance:${instanceId}:connection-changed`);
    const memberships = (config: BuildConfigV3) => config.logicalLayouts.flatMap((layout) => {
      const members = [...layout.bootPoolDiskIds, ...layout.vdevs.flatMap(({ diskInstanceIds }) => diskInstanceIds), ...layout.spareDiskIds];
      return members.includes(instanceId) ? [{ layoutId: layout.layoutId, layout }] : [];
    }).sort((a, b) => a.layoutId.localeCompare(b.layoutId));
    if (!collectionEqual(memberships(base), memberships(candidate))) errors.push(`locked-instance:${instanceId}:logical-layout-changed`);
  }
  return errors;
}

function tierMetric(value: RankableWholeBuild, tier: WholeBuildRecommendation["tier"]): number {
  const objectives = value.score.objectiveScores;
  if (tier === "economy") return objectives.workloadValue * 0.5 + objectives.marketAndLifecycleCost * 0.5;
  if (tier === "long_term") return (objectives.evidencedReliability + objectives.maintainability + objectives.usableExpandability + objectives.replacementFriction) / 4;
  return value.score.finalScore;
}

function exclusionReasons(value: RankableWholeBuild): string[] {
  return [
    ...validateRecommendationEligibility(value.candidate, value.promotion, value.eligibility).map((error) => `eligibility:${error}`),
    ...validateRecommendationScore(value.score).map((error) => `score:${error}`),
    ...validateLockedInstancesPreserved(value.baseConfig, value.candidateConfig, value.lockedInstanceIds),
    ...(value.score.candidateId !== value.candidate.candidateId || value.score.promotionRecordId !== value.promotion.promotionRecordId
      ? ["score:candidate-promotion-binding"] : []),
  ];
}

export async function rankWholeBuilds(input: readonly RankableWholeBuild[]): Promise<{
  readonly recommendations: readonly WholeBuildRecommendation[];
  readonly excluded: readonly ExcludedWholeBuild[];
}> {
  const excluded: ExcludedWholeBuild[] = [];
  const eligible = input.filter((value) => {
    const reasons = exclusionReasons(value);
    if (reasons.length > 0) excluded.push({ candidateId: value.candidate.candidateId, reasonIds: [...new Set(reasons)].sort() });
    return reasons.length === 0;
  });
  if (eligible.length < 2) throw new TypeError("whole-build ranking requires at least two current purchase-eligible candidates");
  const recommendations: WholeBuildRecommendation[] = [];
  for (const tier of ["economy", "balanced", "long_term"] as const) {
    const ranked = [...eligible].sort((left, right) => tierMetric(right, tier) - tierMetric(left, tier)
      || right.score.finalScore - left.score.finalScore || left.candidate.candidateId.localeCompare(right.candidate.candidateId));
    const selected = ranked[0]!;
    const alternatives = ranked.slice(1).map(({ candidate }) => candidate.candidateId);
    const material = { tier, candidateId: selected.candidate.candidateId, promotionRecordId: selected.promotion.promotionRecordId, inputHashes: selected.eligibility.currentInputHashes, scoringVersion: selected.score.scoringVersion, priceConfidence: selected.score.priceConfidence };
    const recordHash = await hashContent(material, { domain: "recommendation.record-id", schemaVersion: "1.0.0" });
    const priceComplete = selected.totalCny !== undefined && selected.plannedCny !== undefined && selected.orderedCny !== undefined;
    recommendations.push({
      recommendationId: `recommendation-${recordHash}`,
      tier,
      solution: {
        candidateId: selected.candidate.candidateId,
        promotionRecordId: selected.promotion.promotionRecordId,
        scoringVersion: selected.score.scoringVersion,
        objectiveScores: structuredClone(selected.score.objectiveScores),
        rank: 1,
        explanationRef: selected.explanationRef,
      },
      alternativeCandidateIds: alternatives,
      candidateConfigRef: selected.candidateConfigRef,
      requirementCoverageRef: selected.requirementCoverageRef,
      inputHashes: structuredClone(selected.eligibility.currentInputHashes),
      solverVersion: selected.solverVersion,
      scoringVersion: selected.score.scoringVersion,
      searchCompleteness: selected.searchCompleteness,
      priceConfidence: selected.score.priceConfidence,
      optimalityClaim: selected.searchCompleteness === "complete" && priceComplete
        && (selected.score.priceConfidence === "medium" || selected.score.priceConfidence === "high")
        ? "bounded_best" : "not_claimed",
      ...(priceComplete ? { totalCny: selected.totalCny!, plannedCny: selected.plannedCny!, orderedCny: selected.orderedCny! } : {}),
      explanationRef: selected.explanationRef,
    });
  }
  const errors = validateRecommendationSet(recommendations);
  if (errors.length > 0) throw new TypeError(`whole-build recommendation set invalid: ${errors.join("; ")}`);
  return { recommendations, excluded: excluded.sort((left, right) => left.candidateId.localeCompare(right.candidateId)) };
}
