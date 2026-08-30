import { FileArtifactRepository } from "../artifacts/repository.mjs";
import { canonicalJson, confined } from "../runtime/fs.mjs";
import {
  isRecommendationArtifactKindRuntime,
  recommendationArtifactReferencesRuntime,
  validateRecommendationArtifactRuntime,
} from "./runtime.mjs";

const MEDIA_TYPE = "application/vnd.buildsim.recommendation+json";
function invariant(condition, message) { if (!condition) throw new Error(message); }
function same(left, right) { try { return canonicalJson(left) === canonicalJson(right); } catch { return false; } }
function parse(bytes, label) { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is not valid JSON`); } }
function refs(values) {
  return [...new Set(values)].sort().map((ref) => ({ ref, necessity: "required_for_replay" }));
}

/** Recommendation-specific closure shared by graph, Doctor, backup and restore. */
export async function validateRecommendationProductionClosureAtRoot({ activeRoot, runtimeGeneration }) {
  const repositoryRoot = confined(activeRoot, "artifacts");
  const repository = new FileArtifactRepository({ root: repositoryRoot });
  const listing = await repository.listAt(repositoryRoot, { initialize: false });
  const values = new Map();
  for (const record of listing.records) {
    if (!isRecommendationArtifactKindRuntime(record.kind)) continue;
    const artifact = await repository.getAt(repositoryRoot, record.ref, { initialize: false });
    invariant(artifact && record.mediaType === MEDIA_TYPE && record.privacyClass === "runtime_internal",
      `recommendation ${record.kind} metadata is invalid`);
    const value = parse(artifact.bytes, `recommendation ${record.kind}`);
    const errors = validateRecommendationArtifactRuntime(record.kind, value);
    invariant(errors.length === 0, `recommendation ${record.kind} artifact is invalid: ${errors.join("; ")}`);
    invariant(same(record.references, refs(recommendationArtifactReferencesRuntime(record.kind, value))),
      `recommendation ${record.kind} references are incomplete`);
    values.set(record.ref, { record, value });
  }
  const open = (ref, kind) => {
    const item = values.get(ref);
    invariant(item?.record.kind === kind, `recommendation ${kind} referenced artifact is missing`);
    return item.value;
  };
  for (const { record, value } of values.values()) {
    if (record.kind === "recommendation-eligibility-context") {
      const coverage = open(value.coverageRef, "recommendation-eligibility-coverage");
      const closure = open(value.closureRef, "recommendation-hard-requirement-closure");
      invariant(coverage.candidateArtifactRef === value.candidateArtifactRef
        && coverage.candidateId === closure.candidateId
        && coverage.evaluationHash === closure.evaluationHash
        && coverage.inputHashes.requirementSpecHash === closure.requirementSpecHash
        && value.context.coverageHash === value.coverageRef.slice("sha256:".length)
        && value.context.hardRequirementClosure.closureArtifactHash === value.closureRef.slice("sha256:".length)
        && same(value.context.coverage, coverage.coverage)
        && same(value.context.currentInputHashes, coverage.inputHashes)
        && same(value.context.hardRequirementClosure.residualMustRequirementIds, closure.residualMustRequirementIds)
        && same(value.context.hardRequirementClosure.unsatisfiedHardConstraintIds, closure.unsatisfiedHardConstraintIds),
      "recommendation eligibility coverage/requirement closure is inconsistent");
    }
    if (record.kind === "recommendation-candidate-promotion") {
      const eligibility = open(value.eligibilityContextRef, "recommendation-eligibility-context");
      const coverage = open(eligibility.coverageRef, "recommendation-eligibility-coverage");
      invariant(eligibility.candidateArtifactRef === value.candidateArtifactRef
        && value.promotion.candidateId === coverage.candidateId,
      "recommendation promotion identity is invalid");
      const eligible = eligibility.context.coverage.every((item) => item.requiredForPurchase === true && item.verdict === "pass")
        && eligibility.context.hardRequirementClosure.residualMustRequirementIds.length === 0
        && eligibility.context.hardRequirementClosure.unsatisfiedHardConstraintIds.length === 0;
      invariant(value.promotion.coverageHash === eligibility.context.coverageHash
        && same(value.promotion.revalidatedInputHashes, eligibility.context.currentInputHashes)
        && value.promotion.outcome === (eligible ? "purchase_eligible" : "excluded"),
      "recommendation promotion outcome/input closure is invalid");
    }
    if (record.kind === "recommendation-score") {
      const promotion = open(value.promotionRef, "recommendation-candidate-promotion");
      const coverage = open(value.coverageRef, "recommendation-eligibility-coverage");
      invariant(promotion.promotion.outcome === "purchase_eligible"
        && value.score.candidateId === promotion.promotion.candidateId
        && value.score.promotionRecordId === promotion.promotion.promotionRecordId
        && coverage.candidateId === value.score.candidateId,
      "recommendation score candidate/promotion closure is invalid");
    }
    if (record.kind === "recommendation-explanation") {
      const score = open(value.scoreRef, "recommendation-score");
      invariant(value.explanation.candidateId === score.score.candidateId,
        "recommendation explanation score closure is invalid");
    }
    if (record.kind === "recommendation-context") {
      const eligibility = open(value.eligibilityContextRef, "recommendation-eligibility-context");
      const promotion = open(value.promotionRef, "recommendation-candidate-promotion");
      const score = open(value.scoreRef, "recommendation-score");
      const explanation = open(value.explanationRef, "recommendation-explanation");
      invariant(value.candidateArtifactRef === eligibility.candidateArtifactRef
        && value.context.candidate.candidateId === promotion.promotion.candidateId
        && same(value.context.eligibilityContext, eligibility.context)
        && same(value.context.promotion, promotion.promotion)
        && same(value.context.score, score.score)
        && explanation.explanation.candidateId === value.context.candidate.candidateId,
      "recommendation governed context closure is invalid");
    }
    if (record.kind === "recommendation-set") {
      invariant(value.runtimeGeneration <= runtimeGeneration, "recommendation set belongs to a future runtime generation");
      for (const index of value.candidates) {
        const promotion = open(index.promotionRef, "recommendation-candidate-promotion");
        const eligibility = open(index.eligibilityContextRef, "recommendation-eligibility-context");
        invariant(promotion.promotion.candidateId === index.candidateId
          && promotion.candidateArtifactRef === index.candidateArtifactRef
          && eligibility.candidateArtifactRef === index.candidateArtifactRef,
        "recommendation set candidate index closure is invalid");
        if (index.contextRef) {
          const context = open(index.contextRef, "recommendation-context");
          invariant(context.context.candidate.candidateId === index.candidateId
            && context.promotionRef === index.promotionRef && context.scoreRef === index.scoreRef
            && context.explanationRef === index.explanationRef,
          "recommendation set governed context index is invalid");
        }
      }
      for (const recommendation of value.recommendations) {
        const index = value.candidates.find((item) => item.candidateId === recommendation.solution.candidateId);
        invariant(index?.contextRef && index.scoreRef && index.explanationRef,
          "recommendation set ranked candidate lacks its governed context");
        const context = open(index.contextRef, "recommendation-context");
        invariant(recommendation.solution.promotionRecordId === context.context.promotion.promotionRecordId
          && recommendation.scoringVersion === context.context.score.scoringVersion
          && same(recommendation.inputHashes, context.context.inputHashes),
        "recommendation set ranked solution differs from its governed context");
      }
    }
  }
  return {
    nodes: [...values.keys()].sort(),
    edges: [...values].flatMap(([fromRef, { record }]) => record.references.map((reference) => ({ fromRef, toRef: reference.ref, necessity: reference.necessity }))),
    pointers: [...values].filter(([, { record }]) => record.kind === "recommendation-set").map(([ref]) => ref).sort(),
  };
}
