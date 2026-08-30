import { canonicalJson } from "../runtime/fs.mjs";

const REF = /^sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const DOMAINS = ["identity", "mechanical", "electrical", "firmware", "system", "storage", "assembly", "commissioning", "routing", "thermal", "acoustic", "procurement"];
const OBJECTIVES = ["workloadValue", "evidencedReliability", "maintainability", "usableExpandability", "replacementFriction", "marketAndLifecycleCost"];
const KINDS = new Set([
  "recommendation-eligibility-coverage", "recommendation-hard-requirement-closure", "recommendation-eligibility-context",
  "recommendation-candidate-promotion", "recommendation-score", "recommendation-explanation", "recommendation-context", "recommendation-set",
]);

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) { return object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function strings(value) { return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0); }
function unique(value) { return strings(value) && new Set(value).size === value.length; }
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function snapshots(value) {
  const keys = ["configHash", "requirementSpecHash", "factSnapshotHash", "userObservationSnapshotHash", "priceSnapshotHash", "ruleSetHash", "systemProfileHash", "adapterSnapshotHash", "engineHash", "simulationModelHash", "simulationInputHash"];
  return exact(value, keys) && keys.every((key) => HASH.test(value[key]));
}
function same(left, right) { try { return canonicalJson(left) === canonicalJson(right); } catch { return false; } }

function validateCoverage(value) {
  const errors = [];
  if (!exact(value, ["schemaVersion", "candidateId", "candidateArtifactRef", "engineArtifactRef", "requirementSpecRef", "evaluationHash", "inputHashes", "coverage"])
    || value.schemaVersion !== "purchase-eligibility-coverage-v1" || typeof value.candidateId !== "string" || !value.candidateId
    || ![value.candidateArtifactRef, value.engineArtifactRef, value.requirementSpecRef].every((ref) => REF.test(ref))
    || !HASH.test(value.evaluationHash) || !snapshots(value.inputHashes) || !Array.isArray(value.coverage)) return ["recommendation coverage fields invalid"];
  if (value.coverage.length !== DOMAINS.length || value.coverage.some((item) => !exact(item, ["domain", "verdict", "domainHash", "evaluationHash", "requiredForPurchase"])
    || !DOMAINS.includes(item.domain) || !["pass", "fail", "blocked"].includes(item.verdict) || !HASH.test(item.domainHash)
    || item.evaluationHash !== value.evaluationHash || item.requiredForPurchase !== true)
    || new Set(value.coverage.map(({ domain }) => domain)).size !== DOMAINS.length) errors.push("recommendation coverage domain partition invalid");
  return errors;
}

function validateClosure(value) {
  if (!exact(value, ["schemaVersion", "candidateId", "coverageRef", "requirementSpecRef", "requirementSpecHash", "evaluationHash", "residualMustRequirementIds", "unsatisfiedHardConstraintIds", "requirementClosure", "requirementAllocationHash"])
    || value.schemaVersion !== "purchase-hard-requirement-closure-v1" || typeof value.candidateId !== "string" || !value.candidateId
    || !REF.test(value.coverageRef) || !REF.test(value.requirementSpecRef) || !HASH.test(value.requirementSpecHash)
    || !HASH.test(value.evaluationHash) || !HASH.test(value.requirementAllocationHash)
    || !unique(value.residualMustRequirementIds) || !unique(value.unsatisfiedHardConstraintIds) || !object(value.requirementClosure)) return ["recommendation requirement closure invalid"];
  return [];
}

function validateEligibility(value) {
  if (!exact(value, ["schemaVersion", "candidateArtifactRef", "coverageRef", "closureRef", "context"])
    || value.schemaVersion !== "recommendation-eligibility-context-v1" || ![value.candidateArtifactRef, value.coverageRef, value.closureRef].every((ref) => REF.test(ref))
    || !object(value.context) || !snapshots(value.context.currentInputHashes) || value.context.coverageArtifactRef !== value.coverageRef
    || !object(value.context.hardRequirementClosure) || value.context.hardRequirementClosure.closureArtifactRef !== value.closureRef
    || !object(value.context.policy) || value.context.policy.policyId !== "purchase-eligibility-v1"
    || !same(value.context.policy.requiredDomains, DOMAINS)) return ["recommendation eligibility context invalid"];
  return validateCoverage({
    schemaVersion: "purchase-eligibility-coverage-v1", candidateId: "embedded", candidateArtifactRef: value.candidateArtifactRef,
    engineArtifactRef: value.context.authoritativeEvaluation?.evaluatorArtifactRef,
    requirementSpecRef: value.context.hardRequirementClosure?.closureArtifactRef,
    evaluationHash: value.context.authoritativeEvaluation?.evaluationHash,
    inputHashes: value.context.currentInputHashes, coverage: value.context.coverage,
  }).filter((error) => error.includes("domain"));
}

function validatePromotion(value) {
  if (!exact(value, ["schemaVersion", "candidateArtifactRef", "eligibilityContextRef", "promotion"])
    || value.schemaVersion !== "recommendation-candidate-promotion-v1" || !REF.test(value.candidateArtifactRef) || !REF.test(value.eligibilityContextRef)
    || !object(value.promotion) || typeof value.promotion.promotionRecordId !== "string" || typeof value.promotion.candidateId !== "string"
    || !HASH.test(value.promotion.candidateBuildConfigHash) || !snapshots(value.promotion.revalidatedInputHashes)
    || !HASH.test(value.promotion.coverageHash) || !["purchase_eligible", "excluded"].includes(value.promotion.outcome)
    || !unique(value.promotion.residualMustRequirementIds) || !iso(value.promotion.createdAt)) return ["recommendation promotion artifact invalid"];
  return [];
}

function validateScore(value) {
  const score = value?.score;
  if (!exact(value, ["schemaVersion", "promotionRef", "coverageRef", "score"]) || value.schemaVersion !== "recommendation-score-artifact-v1"
    || !REF.test(value.promotionRef) || !REF.test(value.coverageRef) || !object(score)
    || typeof score.candidateId !== "string" || typeof score.promotionRecordId !== "string" || typeof score.scoringVersion !== "string"
    || !exact(score.weights, OBJECTIVES) || !exact(score.objectiveScores, OBJECTIVES)
    || OBJECTIVES.some((key) => !Number.isFinite(score.weights[key]) || score.weights[key] < 0 || !Number.isFinite(score.objectiveScores[key]) || score.objectiveScores[key] < 0 || score.objectiveScores[key] > 1)
    || Math.abs(OBJECTIVES.reduce((sum, key) => sum + score.weights[key], 0) - 1) > 1e-9
    || !strings(score.workloadBenchmarkRefs) || score.workloadBenchmarkRefs.length === 0 || !Array.isArray(score.penalties)
    || !Number.isFinite(score.weightedScoreBeforePenalties) || !Number.isFinite(score.finalScore)
    || !["unavailable", "low", "medium", "high"].includes(score.priceConfidence)) return ["recommendation score artifact invalid"];
  return [];
}

function validateExplanation(value) {
  const item = value?.explanation;
  if (!exact(value, ["schemaVersion", "scoreRef", "explanation"]) || value.schemaVersion !== "recommendation-explanation-artifact-v1"
    || !REF.test(value.scoreRef) || !object(item) || item.schemaVersion !== "recommendation-explanation-v1"
    || typeof item.candidateId !== "string" || !strings(item.positiveFactors) || !strings(item.penalties)
    || typeof item.priceStatement !== "string" || !strings(item.factGaps) || typeof item.upgradeStatement !== "string" || !strings(item.evidenceRefs)) return ["recommendation explanation artifact invalid"];
  return [];
}

function validateContext(value) {
  if (!exact(value, ["schemaVersion", "candidateArtifactRef", "eligibilityContextRef", "promotionRef", "scoreRef", "explanationRef", "context"])
    || value.schemaVersion !== "recommendation-context-artifact-v1"
    || ![value.candidateArtifactRef, value.eligibilityContextRef, value.promotionRef, value.scoreRef, value.explanationRef].every((ref) => REF.test(ref))
    || !object(value.context) || !object(value.context.candidate) || !object(value.context.promotion)
    || !object(value.context.eligibilityContext) || !object(value.context.score) || !snapshots(value.context.inputHashes)
    || typeof value.context.candidateConfigRef !== "string" || typeof value.context.requirementCoverageRef !== "string") return ["recommendation governed context artifact invalid"];
  return [];
}

function validateSet(value) {
  if (!exact(value, ["schemaVersion", "planId", "solverJobId", "solverRequestRef", "solverResultRef", "runtimeGeneration", "generatedAt", "weights", "status", "recommendations", "excluded", "candidates", "searchCompleteness"])
    || value.schemaVersion !== "production-recommendation-set-v1" || typeof value.planId !== "string" || !value.planId
    || !/^job-[a-f0-9]{64}$/.test(value.solverJobId) || !REF.test(value.solverRequestRef) || !REF.test(value.solverResultRef)
    || !Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 1 || !iso(value.generatedAt)
    || !exact(value.weights, OBJECTIVES) || !["ranked", "insufficient_eligible_candidates"].includes(value.status)
    || !Array.isArray(value.recommendations) || !Array.isArray(value.excluded) || !Array.isArray(value.candidates)
    || !["complete", "partial"].includes(value.searchCompleteness)) return ["recommendation set artifact invalid"];
  if (value.candidates.some((item) => !exact(item, ["candidateId", "candidateArtifactRef", "eligibilityContextRef", "promotionRef", "scoreRef", "explanationRef", "contextRef"])
    || typeof item.candidateId !== "string" || !REF.test(item.candidateArtifactRef) || !REF.test(item.eligibilityContextRef)
    || !REF.test(item.promotionRef) || ![item.scoreRef, item.explanationRef, item.contextRef].every((ref) => ref === null || REF.test(ref)))) return ["recommendation set candidate index invalid"];
  if (value.status === "ranked" && value.recommendations.length !== 3) return ["ranked recommendation set requires three tiers"];
  return [];
}

export function isRecommendationArtifactKindRuntime(kind) { return KINDS.has(kind); }

export function validateRecommendationArtifactRuntime(kind, value) {
  if (!KINDS.has(kind)) return ["recommendation artifact kind invalid"];
  if (kind === "recommendation-eligibility-coverage") return validateCoverage(value);
  if (kind === "recommendation-hard-requirement-closure") return validateClosure(value);
  if (kind === "recommendation-eligibility-context") return validateEligibility(value);
  if (kind === "recommendation-candidate-promotion") return validatePromotion(value);
  if (kind === "recommendation-score") return validateScore(value);
  if (kind === "recommendation-explanation") return validateExplanation(value);
  if (kind === "recommendation-context") return validateContext(value);
  return validateSet(value);
}

export function recommendationArtifactReferencesRuntime(kind, value) {
  if (validateRecommendationArtifactRuntime(kind, value).length) return [];
  if (kind === "recommendation-eligibility-coverage") return [value.candidateArtifactRef, value.engineArtifactRef, value.requirementSpecRef];
  if (kind === "recommendation-hard-requirement-closure") return [value.coverageRef, value.requirementSpecRef];
  if (kind === "recommendation-eligibility-context") return [value.candidateArtifactRef, value.coverageRef, value.closureRef];
  if (kind === "recommendation-candidate-promotion") return [value.candidateArtifactRef, value.eligibilityContextRef];
  if (kind === "recommendation-score") return [value.promotionRef, value.coverageRef];
  if (kind === "recommendation-explanation") return [value.scoreRef];
  if (kind === "recommendation-context") return [value.candidateArtifactRef, value.eligibilityContextRef, value.promotionRef, value.scoreRef, value.explanationRef];
  return [value.solverRequestRef, value.solverResultRef, ...value.candidates.flatMap((item) => [
    item.candidateArtifactRef, item.eligibilityContextRef, item.promotionRef, item.scoreRef, item.explanationRef, item.contextRef,
  ].filter(Boolean))];
}
