import { isSha256Hex, isSnapshotHashes, type SnapshotHashes } from "../hash";
import { resolveAuthoritativeContext, type AuthoritativeResolver } from "../contracts/trusted-context";
import type { EvaluationDecision } from "../requirements/contracts";

export interface DomainCoverage {
  domain: EvaluationDecision["domain"];
  verdict: "pass" | "fail" | "blocked";
  domainHash: string;
  evaluationHash: string;
  requiredForPurchase: boolean;
}

export interface SolverCandidate {
  candidateId: string;
  requirementSpecId: string;
  basePlanVersionId: string;
  baseConfigHash: string;
  candidateConfigRef: string;
  operationsRef: string;
  buildConfigHash: string;
  inputHashes: SnapshotHashes;
  evaluationHash: string;
  candidateKind: "feasibility_candidate";
  domainCoverage: DomainCoverage[];
  residualRequirementIds: string[];
  excludedReasonIds: string[];
}

export interface CandidatePromotionRecord {
  promotionRecordId: string;
  candidateId: string;
  candidateBuildConfigHash: string;
  revalidatedInputHashes: SnapshotHashes;
  coverageHash: string;
  outcome: "purchase_eligible" | "excluded";
  residualMustRequirementIds: string[];
  createdAt: string;
}

export const PURCHASE_ELIGIBILITY_POLICY = Object.freeze({
  policyId: "purchase-eligibility-v1" as const,
  policyVersion: "1.0.0" as const,
  evaluatorContractVersion: "build-evaluation-v1" as const,
  requiredDomains: Object.freeze([
    "identity", "mechanical", "electrical", "firmware", "system", "storage",
    "assembly", "commissioning", "routing", "thermal", "acoustic", "procurement",
  ] satisfies EvaluationDecision["domain"][]),
});

/** Supplied by the governed evaluation/requirement repositories, not candidate JSON. */
export interface GovernedPurchaseEligibilityContext {
  policy: typeof PURCHASE_ELIGIBILITY_POLICY;
  currentInputHashes: SnapshotHashes;
  coverage: readonly DomainCoverage[];
  coverageHash: string;
  coverageArtifactRef: string;
  authoritativeEvaluation: {
    evaluationHash: string;
    evaluatorId: string;
    evaluatorVersion: string;
    evaluatorContractVersion: typeof PURCHASE_ELIGIBILITY_POLICY.evaluatorContractVersion;
    evaluatorArtifactRef: string;
    evaluatorArtifactHash: string;
  };
  hardRequirementClosure: {
    requirementSpecHash: string;
    evaluationHash: string;
    closureArtifactRef: string;
    closureArtifactHash: string;
    residualMustRequirementIds: readonly string[];
    unsatisfiedHardConstraintIds: readonly string[];
  };
}

export interface SolveLimits {
  maxEvaluations: number;
  maxDurationMs: number;
  maxCandidatesPerRequirement: number;
}

export interface SolveRequest {
  basePlanVersionId: string;
  baseConfigHash: string;
  baseSnapshotHashes: SnapshotHashes;
  lockedInstanceIds: string[];
  requirementSpecId: string;
  limits: SolveLimits;
}

export interface SolveResult {
  status: "feasible_complete" | "feasible_partial" | "unsat_proven" | "blocked_inputs";
  solverVersion: string;
  seed: string;
  effectiveLimits: SolveLimits;
  explored: number;
  pruned: number;
  candidates: SolverCandidate[];
  unsatisfiedHardConstraintIds: string[];
  irreducibleConflictSets: string[][];
  searchSummaryRef: string;
}

export interface RankedSolution {
  candidateId: string;
  promotionRecordId: string;
  scoringVersion: string;
  objectiveScores: Record<string, number>;
  rank: number;
  explanationRef: string;
}

export type UnsatProof =
  | { kind: "exhaustive"; exploredSearchSpaceHash: string }
  | { kind: "formal"; proofArtifactRef: string; proofSystemVersion: string };

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateSolveRequest(value: unknown): string[] {
  if (!isRecord(value)) return ["solve request must be an object"];
  const request = value as Partial<SolveRequest> & Record<string, unknown>;
  const errors: string[] = [];
  if (!request.basePlanVersionId || !request.requirementSpecId) errors.push("solve request identity fields missing");
  if (!isSha256Hex(request.baseConfigHash)) errors.push("baseConfigHash invalid");
  if (!isSnapshotHashes(request.baseSnapshotHashes)) errors.push("baseSnapshotHashes invalid");
  if (isSnapshotHashes(request.baseSnapshotHashes) && request.baseSnapshotHashes.configHash !== request.baseConfigHash) errors.push("baseSnapshotHashes.configHash must match baseConfigHash");
  if (!isRecord(request.limits)) errors.push("solve limits must be an object");
  else {
    if (!positiveInteger(request.limits.maxEvaluations as number)) errors.push("maxEvaluations must be a positive integer");
    if (!positiveInteger(request.limits.maxDurationMs as number)) errors.push("maxDurationMs must be a positive integer");
    if (!positiveInteger(request.limits.maxCandidatesPerRequirement as number)) errors.push("maxCandidatesPerRequirement must be a positive integer");
  }
  if (!Array.isArray(request.lockedInstanceIds) || request.lockedInstanceIds.some((id) => typeof id !== "string" || !id) || new Set(request.lockedInstanceIds).size !== request.lockedInstanceIds.length) errors.push("lockedInstanceIds must be unique non-empty strings");
  return errors;
}

export function validateSolverCandidate(value: unknown): string[] {
  if (!isRecord(value)) return ["candidate must be an object"];
  const candidate = value as unknown as SolverCandidate;
  const errors: string[] = [];
  if (!candidate.candidateId || !candidate.requirementSpecId || !candidate.basePlanVersionId || !candidate.candidateConfigRef || !candidate.operationsRef) errors.push("candidate identity/reference fields missing");
  if (candidate.candidateKind !== "feasibility_candidate") errors.push("solver may only emit feasibility_candidate records");
  for (const [field, value] of [["baseConfigHash", candidate.baseConfigHash], ["buildConfigHash", candidate.buildConfigHash], ["evaluationHash", candidate.evaluationHash]] as const) {
    if (!isSha256Hex(value)) errors.push(`${field} invalid`);
  }
  if (!isSnapshotHashes(candidate.inputHashes)) errors.push("candidate input hashes invalid");
  if (isSnapshotHashes(candidate.inputHashes) && candidate.inputHashes.configHash !== candidate.buildConfigHash) errors.push("candidate input configHash must match buildConfigHash");
  const domainCoverage = Array.isArray(candidate.domainCoverage) ? candidate.domainCoverage : [];
  if (!Array.isArray(candidate.domainCoverage) || candidate.domainCoverage.length === 0) errors.push("candidate requires authoritative evaluator domain coverage");
  if (domainCoverage.some((coverage) => !isRecord(coverage) || coverage.evaluationHash !== candidate.evaluationHash)) errors.push("domain coverage must come from the candidate evaluation");
  if (domainCoverage.some((coverage) => !isRecord(coverage) || !isSha256Hex(coverage.domainHash) || !isSha256Hex(coverage.evaluationHash))) errors.push("domain coverage hashes invalid");
  const domains = domainCoverage.filter(isRecord).map((coverage) => coverage.domain);
  if (new Set(domains).size !== domains.length) errors.push("candidate contains duplicate domain coverage");
  if (!Array.isArray(candidate.residualRequirementIds) || !Array.isArray(candidate.excludedReasonIds)
    || new Set(candidate.residualRequirementIds).size !== candidate.residualRequirementIds.length || new Set(candidate.excludedReasonIds).size !== candidate.excludedReasonIds.length) errors.push("candidate residual/exclusion IDs must be unique");
  if (domainCoverage.some((coverage) => isRecord(coverage) && coverage.requiredForPurchase && coverage.verdict !== "pass")) {
    if (!Array.isArray(candidate.excludedReasonIds) || candidate.excludedReasonIds.length === 0) errors.push("failed or blocked purchase domain requires an exclusion reason");
  }
  return errors;
}

/** Promotion validation binds current hashes and forbids scoring around hard/blocked gaps. */
export function validateCandidatePromotion(
  candidate: SolverCandidate,
  promotion: CandidatePromotionRecord,
  context: GovernedPurchaseEligibilityContext,
): string[] {
  const errors = validateSolverCandidate(candidate).map((error) => `candidate: ${error}`);
  if (!isRecord(candidate) || !isRecord(promotion)) return [...errors, "promotion and candidate must be objects"];
  if (!promotion.promotionRecordId || !promotion.createdAt || !Number.isFinite(Date.parse(promotion.createdAt))) errors.push("promotion identity/timestamp invalid");
  if (promotion.candidateId !== candidate.candidateId || promotion.candidateBuildConfigHash !== candidate.buildConfigHash) errors.push("promotion does not identify the candidate config");
  if (!context || context.policy !== PURCHASE_ELIGIBILITY_POLICY) return [...errors, "promotion requires the governed purchase eligibility policy context"];
  const currentCoverage = Array.isArray(context.coverage) ? context.coverage : [];
  const currentInputHashes = context.currentInputHashes;
  if (!isSha256Hex(promotion.candidateBuildConfigHash) || !isSha256Hex(promotion.coverageHash) || !isSha256Hex(context.coverageHash)) errors.push("promotion hashes invalid");
  if (!context.coverageArtifactRef || promotion.coverageHash !== context.coverageHash) errors.push("promotion coverage hash is stale or not bound to an authoritative artifact");
  const inputFields = isSnapshotHashes(currentInputHashes) ? Object.keys(currentInputHashes) as Array<keyof SnapshotHashes> : [];
  if (!isSnapshotHashes(currentInputHashes) || !isSnapshotHashes(promotion.revalidatedInputHashes) || inputFields.some((field) => promotion.revalidatedInputHashes[field] !== currentInputHashes[field])) errors.push("promotion input hashes are stale");
  if (isSnapshotHashes(currentInputHashes) && currentInputHashes.configHash !== candidate.buildConfigHash) errors.push("promotion current configHash does not identify candidate config");
  const promotionResidualMustIds = Array.isArray(promotion.residualMustRequirementIds) ? promotion.residualMustRequirementIds : [];
  if (!Array.isArray(promotion.residualMustRequirementIds) || new Set(promotionResidualMustIds).size !== promotionResidualMustIds.length) errors.push("promotion residual must IDs must be unique");
  const coverageDomains = currentCoverage.map((coverage) => coverage.domain);
  if (new Set(coverageDomains).size !== coverageDomains.length) errors.push("promotion coverage contains duplicate domains");
  if (currentCoverage.some((coverage) => !isRecord(coverage) || !isSha256Hex(coverage.domainHash) || !isSha256Hex(coverage.evaluationHash))) errors.push("promotion coverage hashes invalid");
  const authoritative = context.authoritativeEvaluation;
  if (!isRecord(authoritative)
    || !isSha256Hex(authoritative.evaluationHash) || !isSha256Hex(authoritative.evaluatorArtifactHash)
    || !authoritative.evaluatorId || !authoritative.evaluatorVersion || !authoritative.evaluatorArtifactRef
    || authoritative.evaluatorContractVersion !== PURCHASE_ELIGIBILITY_POLICY.evaluatorContractVersion) {
    errors.push("promotion authoritative evaluator artifact/version binding invalid");
  }
  if (isRecord(authoritative) && currentCoverage.some((coverage) => coverage.evaluationHash !== authoritative.evaluationHash)) errors.push("promotion coverage must come from the authoritative revalidation evaluation");
  const closure = context.hardRequirementClosure;
  if (!isRecord(closure)
    || !isSha256Hex(closure.requirementSpecHash) || !isSha256Hex(closure.evaluationHash) || !isSha256Hex(closure.closureArtifactHash)
    || !closure.closureArtifactRef || !Array.isArray(closure.residualMustRequirementIds) || !Array.isArray(closure.unsatisfiedHardConstraintIds)) {
    errors.push("promotion hard RequirementSpec closure binding invalid");
  } else {
    if (isSnapshotHashes(currentInputHashes) && closure.requirementSpecHash !== currentInputHashes.requirementSpecHash) errors.push("promotion hard RequirementSpec closure is stale");
    if (isRecord(authoritative) && closure.evaluationHash !== authoritative.evaluationHash) errors.push("promotion hard RequirementSpec closure comes from a different evaluation");
    if (new Set(closure.residualMustRequirementIds).size !== closure.residualMustRequirementIds.length
      || new Set(closure.unsatisfiedHardConstraintIds).size !== closure.unsatisfiedHardConstraintIds.length) errors.push("promotion hard RequirementSpec closure IDs must be unique");
    if (promotionResidualMustIds.length !== closure.residualMustRequirementIds.length
      || promotionResidualMustIds.some((id) => !closure.residualMustRequirementIds.includes(id))) errors.push("promotion residual must requirements do not match authoritative closure");
  }
  if (promotion.outcome === "purchase_eligible") {
    const expectedDomains = PURCHASE_ELIGIBILITY_POLICY.requiredDomains;
    const currentByDomain = new Map(currentCoverage.map((coverage) => [coverage.domain, coverage]));
    if (currentCoverage.length !== expectedDomains.length || expectedDomains.some((domain) => !currentByDomain.has(domain))) errors.push("purchase eligibility requires the complete governed domain set");
    if (expectedDomains.some((domain) => {
      const item = currentByDomain.get(domain);
      return !item || item.requiredForPurchase !== true || item.verdict !== "pass";
    })) errors.push("purchase eligibility requires every governed purchase domain to pass");
    if (promotionResidualMustIds.length > 0
      || (isRecord(closure) && Array.isArray(closure.residualMustRequirementIds) && closure.residualMustRequirementIds.length > 0)
      || (isRecord(closure) && Array.isArray(closure.unsatisfiedHardConstraintIds) && closure.unsatisfiedHardConstraintIds.length > 0)) errors.push("purchase eligibility requires RequirementSpec hard closure with zero residuals");
  }
  return errors;
}

/**
 * Server-facing promotion gate. Request JSON may provide only `contextRef`;
 * coverage/closure/evaluator state is resolved through a server-issued resolver.
 */
export async function validateCandidatePromotionAuthoritatively(
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
  if (!resolved.ok) return [`promotion authoritative context resolution failed: ${resolved.error}`];
  return validateCandidatePromotion(candidate, promotion, resolved.value);
}

export function validateSolveResult(result: SolveResult, unsatProof?: UnsatProof): string[] {
  const errors: string[] = [];
  if (!result.solverVersion || !result.seed || !result.searchSummaryRef) errors.push("solve result provenance fields missing");
  if (!positiveInteger(result.effectiveLimits.maxEvaluations) || !positiveInteger(result.effectiveLimits.maxDurationMs) || !positiveInteger(result.effectiveLimits.maxCandidatesPerRequirement)) errors.push("solve result effective limits invalid");
  if (!Number.isInteger(result.explored) || result.explored < 0 || !Number.isInteger(result.pruned) || result.pruned < 0) errors.push("search counts must be non-negative integers");
  if (result.status === "unsat_proven" && !unsatProof) errors.push("unsat_proven requires exhaustive or formal proof");
  if (result.status === "unsat_proven" && result.candidates.length > 0) errors.push("unsat_proven cannot contain feasible candidates");
  if (unsatProof?.kind === "exhaustive" && !isSha256Hex(unsatProof.exploredSearchSpaceHash)) errors.push("exhaustive proof search-space hash invalid");
  if (unsatProof?.kind === "formal" && (!unsatProof.proofArtifactRef || !unsatProof.proofSystemVersion)) errors.push("formal proof provenance invalid");
  if (result.status !== "unsat_proven" && unsatProof) errors.push("only unsat_proven may carry an unsat proof");
  if ((result.status === "feasible_complete" || result.status === "feasible_partial") && result.candidates.length === 0) errors.push("feasible result requires at least one candidate");
  if ((result.status === "feasible_complete" || result.status === "feasible_partial") && result.unsatisfiedHardConstraintIds.length > 0) errors.push("feasible result cannot retain unsatisfied hard constraints");
  if (result.status === "blocked_inputs" && result.unsatisfiedHardConstraintIds.length === 0) errors.push("blocked_inputs must identify blocking inputs or constraints");
  if (result.status === "blocked_inputs" && result.candidates.length > 0) errors.push("blocked_inputs cannot contain candidates built from guessed inputs");
  if (result.status !== "unsat_proven" && result.irreducibleConflictSets.length > 0) errors.push("irreducible conflict sets require unsat_proven");
  if (result.status === "unsat_proven" && result.unsatisfiedHardConstraintIds.length === 0) errors.push("unsat_proven must identify unsatisfied hard constraints");
  if (new Set(result.unsatisfiedHardConstraintIds).size !== result.unsatisfiedHardConstraintIds.length) errors.push("unsatisfied hard constraint IDs must be unique");
  if (result.irreducibleConflictSets.some((set) => set.length === 0 || new Set(set).size !== set.length)) errors.push("irreducible conflict sets must be non-empty and internally unique");
  const candidateIds = result.candidates.map((item) => item.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length) errors.push("solve result candidate IDs must be unique");
  if (candidateIds.some((id, index) => index > 0 && candidateIds[index - 1]!.localeCompare(id) > 0)) errors.push("solve result candidates must use deterministic candidateId order");
  for (const candidate of result.candidates) errors.push(...validateSolverCandidate(candidate).map((error) => `${candidate.candidateId}: ${error}`));
  return errors;
}
