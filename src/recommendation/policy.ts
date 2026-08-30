import { hashContent } from "../hash";
import {
  validateCandidatePromotion,
  type CandidatePromotionRecord,
  type GovernedPurchaseEligibilityContext,
  type SolverCandidate,
} from "../solver/contracts";

export const RECOMMENDATION_HORIZONS = Object.freeze({
  skeletonYears: 5,
  replaceableYears: Object.freeze({ min: 2, max: 3 }),
});

/** Creates an immutable promotion only from the current governed revalidation context. */
export async function createCandidatePromotionRecord(input: {
  readonly candidate: SolverCandidate;
  readonly context: GovernedPurchaseEligibilityContext;
  readonly createdAt: string;
}): Promise<CandidatePromotionRecord> {
  const context = input.context;
  const required = context.policy.requiredDomains;
  const byDomain = new Map(context.coverage.map((coverage) => [coverage.domain, coverage]));
  const residual = [...context.hardRequirementClosure.residualMustRequirementIds].sort();
  const eligible = required.every((domain) => {
    const coverage = byDomain.get(domain);
    return coverage?.requiredForPurchase === true && coverage.verdict === "pass";
  }) && residual.length === 0 && context.hardRequirementClosure.unsatisfiedHardConstraintIds.length === 0;
  const material = {
    candidateId: input.candidate.candidateId,
    candidateBuildConfigHash: input.candidate.buildConfigHash,
    revalidatedInputHashes: structuredClone(context.currentInputHashes),
    coverageHash: context.coverageHash,
    outcome: eligible ? "purchase_eligible" as const : "excluded" as const,
    residualMustRequirementIds: residual,
    createdAt: input.createdAt,
  };
  const idHash = await hashContent(material, { domain: "solver.candidate-promotion-id", schemaVersion: "1.0.0" });
  const promotion: CandidatePromotionRecord = { promotionRecordId: `promotion-${idHash}`, ...material };
  const errors = validateCandidatePromotion(input.candidate, promotion, context);
  if (errors.length > 0) throw new TypeError(`candidate promotion invalid: ${errors.join("; ")}`);
  return promotion;
}
