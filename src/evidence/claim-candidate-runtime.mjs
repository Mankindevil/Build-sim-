import { sha256Json } from "../runtime/fs.mjs";
import {
  evidenceIdentityMatchesClaimSubjectRuntime,
  validateEvidenceClaimRuntime,
  verifyEvidenceClaimRuntime,
} from "./claim-runtime.mjs";
import {
  evaluateOfficialDocumentPromotion,
  validateOfficialDocumentIdentityConfirmation,
} from "./ladder.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE_ID = /^claim-candidate-sha256-[a-f0-9]{64}$/;
const PIPELINE_ID = /^evidence-pipeline-sha256-[a-f0-9]{64}$/;
const JOB_ID = /^job-[a-f0-9]{64}$/;
const ARTIFACT_REF = /^sha256:[a-f0-9]{64}$/;
const CAPTURE_ID = /^capture-sha256-[a-f0-9]{64}$/;
const PLAN_ID = /^[-A-Za-z0-9._]{1,160}$/;
const PRODUCT_CATEGORIES = new Set(["case", "motherboard", "cpu", "psu", "cooler", "gpu", "memory", "storage", "hba", "fan", "accessory"]);

function total(operation, fallback) { try { return operation(); } catch { return fallback; } }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function exact(value, allowed, required = allowed) {
  return record(value) && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => own(value, key));
}
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function same(left, right) { return sha256Json(left) === sha256Json(right); }

export function officialClaimCandidateIdRuntime(input) {
  if (!exact(input, ["planId", "pipelineId", "candidateIndex", "claimId", "confirmationId"])) return null;
  if (!PLAN_ID.test(input.planId) || !PIPELINE_ID.test(input.pipelineId)
    || !Number.isSafeInteger(input.candidateIndex) || input.candidateIndex < 0 || input.candidateIndex > 511
    || !/^claim-sha256-[a-f0-9]{64}$/.test(input.claimId)
    || !/^official-confirmation-sha256-[a-f0-9]{64}$/.test(input.confirmationId)) return null;
  return `claim-candidate-sha256-${sha256Json({
    schemaVersion: "official-claim-candidate-identity-v1",
    planId: input.planId,
    pipelineId: input.pipelineId,
    candidateIndex: input.candidateIndex,
    claimId: input.claimId,
    confirmationId: input.confirmationId,
  })}`;
}

function validPromotionInput(value) {
  if (!exact(value, ["registryTrust", "documentSha256", "requiredScope", "expectedIdentity", "confirmation"])) return false;
  if (value.registryTrust !== "trusted" || !SHA256.test(value.documentSha256)
    || !["model", "variant", "revision"].includes(value.requiredScope)
    || validateOfficialDocumentIdentityConfirmation(value.confirmation).length) return false;
  const promotion = evaluateOfficialDocumentPromotion(value);
  return promotion.eligible === true && promotion.identity?.basis === "official-document-explicit";
}

function validPromotion(value, input) {
  if (!exact(value, ["eligible", "authority", "kindBasis", "reason", "confirmationId", "identity", "detail"])) return false;
  const evaluated = evaluateOfficialDocumentPromotion(input);
  return evaluated.eligible === true && same(value, evaluated);
}

/** Total validator shared by the job-fenced repository and production graph. */
export function validateOfficialClaimCandidateRuntime(value) {
  return total(() => {
    const keys = [
      "schemaVersion", "candidateId", "planId", "planConfigHash", "planDraftRevision",
      "catalogIdentity",
      "pipelineId", "jobId", "runtimeGeneration", "resultArtifactRef", "candidateIndex",
      "claim", "promotionInput", "promotion", "originalCaptureId", "createdAt", "contentHash",
    ];
    if (!exact(value, keys)) return ["official claim candidate fields invalid"];
    const errors = [];
    if (value.schemaVersion !== "official-claim-candidate-v1" || !CANDIDATE_ID.test(value.candidateId)
      || !PLAN_ID.test(value.planId) || !PIPELINE_ID.test(value.pipelineId) || !JOB_ID.test(value.jobId)) {
      errors.push("official claim candidate identity invalid");
    }
    if (!SHA256.test(value.planConfigHash) || !Number.isSafeInteger(value.planDraftRevision) || value.planDraftRevision < 0
      || !Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 1
      || !ARTIFACT_REF.test(value.resultArtifactRef) || !Number.isSafeInteger(value.candidateIndex)
      || value.candidateIndex < 0 || value.candidateIndex > 511 || !iso(value.createdAt)) {
      errors.push("official claim candidate provenance invalid");
    }
    if (!exact(value.catalogIdentity, ["skuId", "brand", "category", "model"])
      || value.catalogIdentity.skuId !== value.claim?.subject?.skuId
      || value.catalogIdentity.brand !== value.promotion?.identity?.brand
      || value.catalogIdentity.model !== value.claim?.subject?.modelId
      || !PRODUCT_CATEGORIES.has(value.catalogIdentity.category)) {
      errors.push("official claim candidate active catalog identity invalid");
    }
    if (validateEvidenceClaimRuntime(value.claim).length || !verifyEvidenceClaimRuntime(value.claim)
      || value.claim.authority !== "official" || value.claim.status !== "active") {
      errors.push("official claim candidate claim invalid");
    }
    if (!CAPTURE_ID.test(value.originalCaptureId) || value.claim?.source?.captureId !== value.originalCaptureId) {
      errors.push("official claim candidate original capture invalid");
    }
    if (!validPromotionInput(value.promotionInput) || !validPromotion(value.promotion, value.promotionInput)) {
      errors.push("official claim candidate promotion proof invalid");
    } else if (value.claim?.source?.documentSha256 !== value.promotionInput.documentSha256
      || !evidenceIdentityMatchesClaimSubjectRuntime(value.promotion.identity, value.claim?.subject, value.claim?.scope)) {
      errors.push("official claim candidate promotion/claim closure invalid");
    }
    const expectedId = officialClaimCandidateIdRuntime({
      planId: value.planId,
      pipelineId: value.pipelineId,
      candidateIndex: value.candidateIndex,
      claimId: value.claim?.claimId,
      confirmationId: value.promotion?.confirmationId,
    });
    if (expectedId === null || value.candidateId !== expectedId) errors.push("official claim candidate ID binding invalid");
    const material = { ...value }; delete material.contentHash;
    if (!SHA256.test(value.contentHash) || value.contentHash !== sha256Json(material)) {
      errors.push("official claim candidate content hash invalid");
    }
    return errors;
  }, ["official claim candidate runtime validation failed"]);
}

export function validateOfficialClaimCandidateEnvelopeRuntime(value, expectedCandidateId) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "kind", "checksum", "payload"])) return ["official claim candidate envelope fields invalid"];
    const errors = validateOfficialClaimCandidateRuntime(value.payload);
    if (value.schemaVersion !== "official-claim-candidate-envelope-v1" || value.kind !== "official-claim-candidate"
      || !SHA256.test(value.checksum) || value.checksum !== sha256Json(value.payload)) {
      errors.push("official claim candidate envelope integrity invalid");
    }
    if (expectedCandidateId !== undefined && value.payload?.candidateId !== expectedCandidateId) {
      errors.push("official claim candidate path binding invalid");
    }
    return errors;
  }, ["official claim candidate envelope runtime validation failed"]);
}

export function officialClaimCandidateReferencesRuntime(value) {
  if (validateOfficialClaimCandidateRuntime(value).length) return null;
  return [
    { ref: `plan:${value.planId}`, necessity: "required_for_replay" },
    { ref: `job:${value.jobId}`, necessity: "required_for_replay" },
    { ref: value.resultArtifactRef, necessity: "required_for_replay" },
    { ref: `evidence-document:${value.claim.source.documentId}`, necessity: "required_for_replay" },
    { ref: `evidence-capture:${value.originalCaptureId}`, necessity: "required_for_replay" },
  ];
}
