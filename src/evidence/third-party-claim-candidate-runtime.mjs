import { sha256Json } from "../runtime/fs.mjs";
import {
  evidenceIdentityMatchesClaimSubjectRuntime,
  validateEvidenceClaimRuntime,
  verifyEvidenceClaimRuntime,
} from "./claim-runtime.mjs";
import {
  validateThirdPartyEvidenceSource,
  validateThirdPartyIndependenceAssessment,
} from "./ladder.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE_ID = /^third-party-claim-candidate-sha256-[a-f0-9]{64}$/;
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
function iso(value) {
  return total(() => typeof value === "string" && new Date(value).toISOString() === value, false);
}

export function thirdPartyClaimCandidateIdRuntime(input) {
  if (!exact(input, ["planId", "pipelineId", "candidateIndex", "claimId", "sourceId", "assessmentId"])) return null;
  if (!PLAN_ID.test(input.planId) || !PIPELINE_ID.test(input.pipelineId)
    || !Number.isSafeInteger(input.candidateIndex) || input.candidateIndex < 0 || input.candidateIndex > 511
    || !/^claim-sha256-[a-f0-9]{64}$/.test(input.claimId)
    || !/^third-party-source-sha256-[a-f0-9]{64}$/.test(input.sourceId)
    || !/^third-party-assessment-sha256-[a-f0-9]{64}$/.test(input.assessmentId)) return null;
  return `third-party-claim-candidate-sha256-${sha256Json({
    schemaVersion: "third-party-claim-candidate-identity-v1",
    planId: input.planId,
    pipelineId: input.pipelineId,
    candidateIndex: input.candidateIndex,
    claimId: input.claimId,
    sourceId: input.sourceId,
    assessmentId: input.assessmentId,
  })}`;
}

/** Total validator shared by the job-fenced repository and production graph. */
export function validateThirdPartyClaimCandidateRuntime(value) {
  return total(() => {
    const keys = [
      "schemaVersion", "candidateId", "planId", "planConfigHash", "planDraftRevision", "catalogIdentity",
      "pipelineId", "jobId", "runtimeGeneration", "resultArtifactRef", "candidateIndex",
      "claim", "source", "assessment", "originalCaptureId", "createdAt", "contentHash",
    ];
    if (!exact(value, keys)) return ["third-party claim candidate fields invalid"];
    const errors = [];
    if (value.schemaVersion !== "third-party-claim-candidate-v1" || !CANDIDATE_ID.test(value.candidateId)
      || !PLAN_ID.test(value.planId) || !PIPELINE_ID.test(value.pipelineId) || !JOB_ID.test(value.jobId)) {
      errors.push("third-party claim candidate identity invalid");
    }
    if (!SHA256.test(value.planConfigHash) || !Number.isSafeInteger(value.planDraftRevision) || value.planDraftRevision < 0
      || !Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 1
      || !ARTIFACT_REF.test(value.resultArtifactRef) || !Number.isSafeInteger(value.candidateIndex)
      || value.candidateIndex < 0 || value.candidateIndex > 511 || !iso(value.createdAt)) {
      errors.push("third-party claim candidate provenance invalid");
    }
    if (!exact(value.catalogIdentity, ["skuId", "brand", "category", "model"])
      || value.catalogIdentity.skuId !== value.claim?.subject?.skuId
      || value.catalogIdentity.model !== value.claim?.subject?.modelId
      || !PRODUCT_CATEGORIES.has(value.catalogIdentity.category)) {
      errors.push("third-party claim candidate active catalog identity invalid");
    }
    if (validateEvidenceClaimRuntime(value.claim).length || !verifyEvidenceClaimRuntime(value.claim)
      || value.claim.authority !== "third_party" || value.claim.status !== "active") {
      errors.push("third-party claim candidate claim invalid");
    }
    if (validateThirdPartyEvidenceSource(value.source).length
      || validateThirdPartyIndependenceAssessment(value.assessment).length
      || !iso(value.source?.retrievedAt) || !iso(value.assessment?.assessedAt)
      || value.source.authority !== "third_party" || value.assessment.authority !== "third_party"
      || value.assessment.conflicted || value.assessment.confidence === "none" || value.assessment.ladderLevel === null
      || !value.assessment.sourceIds.includes(value.source.sourceId)) {
      errors.push("third-party claim candidate source/independence proof invalid");
    }
    if (value.source?.sourceContentHash !== value.claim?.source?.documentSha256
      || !evidenceIdentityMatchesClaimSubjectRuntime(value.source?.subject, value.claim?.subject, value.claim?.scope)) {
      errors.push("third-party claim candidate source/claim closure invalid");
    }
    if (!CAPTURE_ID.test(value.originalCaptureId) || value.claim?.source?.captureId !== value.originalCaptureId) {
      errors.push("third-party claim candidate original capture invalid");
    }
    const expectedId = thirdPartyClaimCandidateIdRuntime({
      planId: value.planId,
      pipelineId: value.pipelineId,
      candidateIndex: value.candidateIndex,
      claimId: value.claim?.claimId,
      sourceId: value.source?.sourceId,
      assessmentId: value.assessment?.assessmentId,
    });
    if (expectedId === null || value.candidateId !== expectedId) errors.push("third-party claim candidate ID binding invalid");
    const material = { ...value }; delete material.contentHash;
    if (!SHA256.test(value.contentHash) || value.contentHash !== sha256Json(material)) {
      errors.push("third-party claim candidate content hash invalid");
    }
    return errors;
  }, ["third-party claim candidate runtime validation failed"]);
}

export function validateThirdPartyClaimCandidateEnvelopeRuntime(value, expectedCandidateId) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "kind", "checksum", "payload"])) return ["third-party claim candidate envelope fields invalid"];
    const errors = validateThirdPartyClaimCandidateRuntime(value.payload);
    if (value.schemaVersion !== "third-party-claim-candidate-envelope-v1" || value.kind !== "third-party-claim-candidate"
      || !SHA256.test(value.checksum) || value.checksum !== sha256Json(value.payload)) {
      errors.push("third-party claim candidate envelope integrity invalid");
    }
    if (expectedCandidateId !== undefined && value.payload?.candidateId !== expectedCandidateId) {
      errors.push("third-party claim candidate path binding invalid");
    }
    return errors;
  }, ["third-party claim candidate envelope runtime validation failed"]);
}

export function thirdPartyClaimCandidateReferencesRuntime(value) {
  if (validateThirdPartyClaimCandidateRuntime(value).length) return null;
  return [
    { ref: `plan:${value.planId}`, necessity: "required_for_replay" },
    { ref: `job:${value.jobId}`, necessity: "required_for_replay" },
    { ref: value.resultArtifactRef, necessity: "required_for_replay" },
    { ref: `evidence-document:${value.claim.source.documentId}`, necessity: "required_for_replay" },
    { ref: `evidence-capture:${value.originalCaptureId}`, necessity: "required_for_replay" },
  ];
}
