import { sha256Json } from "../runtime/fs.mjs";
import {
  agentWriteApprovalBindingReferencesRuntime,
  validateAgentWriteApprovalBindingRuntime,
} from "../agent/write-approval-runtime.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const PROMOTION_ID = /^third-party-promotion-sha256-[a-f0-9]{64}$/;
const CANDIDATE_ID = /^third-party-claim-candidate-sha256-[a-f0-9]{64}$/;
const ASSESSMENT_ID = /^third-party-assessment-sha256-[a-f0-9]{64}$/;
const CAPTURE_ID = /^capture-sha256-[a-f0-9]{64}$/;
const CLAIM_ID = /^claim-sha256-([a-f0-9]{64})$/;
const PLAN_ID = /^[-A-Za-z0-9._]{1,160}$/;

function total(operation, fallback) { try { return operation(); } catch { return fallback; } }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) { return record(value) && Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key)); }
function iso(value) { return total(() => typeof value === "string" && new Date(value).toISOString() === value, false); }

function material(value) {
  return {
    schemaVersion: "third-party-claim-promotion-v1",
    candidateId: value.candidateId,
    candidateHash: value.candidateHash,
    planId: value.planId,
    assessmentId: value.assessmentId,
    assessmentHash: value.assessmentHash,
    originalCaptureId: value.originalCaptureId,
    promotedCaptureId: value.promotedCaptureId,
    activeClaimId: value.activeClaimId,
    activeClaimHash: value.activeClaimHash,
    approval: value.approval,
    promotedAt: value.promotedAt,
  };
}

export function createThirdPartyClaimPromotionRuntime(input) {
  return total(() => {
    const contentHash = sha256Json(material(input));
    const value = Object.freeze({
      ...material(input),
      promotionId: `third-party-promotion-sha256-${contentHash}`,
      contentHash,
    });
    return validateThirdPartyClaimPromotionRuntime(value).length ? null : value;
  }, null);
}

export function validateThirdPartyClaimPromotionRuntime(value) {
  return total(() => {
    const keys = [
      "schemaVersion", "promotionId", "candidateId", "candidateHash", "planId", "assessmentId", "assessmentHash",
      "originalCaptureId", "promotedCaptureId", "activeClaimId", "activeClaimHash", "promotedAt", "contentHash",
      "approval",
    ];
    if (!exact(value, keys)) return ["third-party claim promotion fields invalid"];
    const errors = [];
    const claimMatch = typeof value.activeClaimId === "string" ? CLAIM_ID.exec(value.activeClaimId) : null;
    if (value.schemaVersion !== "third-party-claim-promotion-v1" || !PROMOTION_ID.test(value.promotionId)
      || !CANDIDATE_ID.test(value.candidateId) || !PLAN_ID.test(value.planId) || !ASSESSMENT_ID.test(value.assessmentId)) {
      errors.push("third-party claim promotion identity invalid");
    }
    if (!SHA256.test(value.candidateHash) || !SHA256.test(value.assessmentHash) || !CAPTURE_ID.test(value.originalCaptureId)
      || !CAPTURE_ID.test(value.promotedCaptureId) || value.originalCaptureId === value.promotedCaptureId
      || !claimMatch || !SHA256.test(value.activeClaimHash) || claimMatch?.[1] !== value.activeClaimHash || !iso(value.promotedAt)) {
      errors.push("third-party claim promotion authority binding invalid");
    }
    if (validateAgentWriteApprovalBindingRuntime(value.approval).length
      || value.approval?.toolName !== "propose_fact_update"
      || value.promotedAt !== value.approval?.issuedAt) {
      errors.push("third-party claim promotion reviewed approval binding invalid");
    }
    const expected = sha256Json(material(value));
    if (!SHA256.test(value.contentHash) || value.contentHash !== expected
      || value.promotionId !== `third-party-promotion-sha256-${expected}`) errors.push("third-party claim promotion content identity invalid");
    return errors;
  }, ["third-party claim promotion runtime validation failed"]);
}

export function validateThirdPartyClaimPromotionEnvelopeRuntime(value, expectedPromotionId) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "kind", "checksum", "payload"])) return ["third-party claim promotion envelope fields invalid"];
    const errors = validateThirdPartyClaimPromotionRuntime(value.payload);
    if (value.schemaVersion !== "third-party-claim-promotion-envelope-v1" || value.kind !== "third-party-claim-promotion"
      || !SHA256.test(value.checksum) || value.checksum !== sha256Json(value.payload)) errors.push("third-party claim promotion envelope integrity invalid");
    if (expectedPromotionId !== undefined && value.payload?.promotionId !== expectedPromotionId) errors.push("third-party claim promotion path binding invalid");
    return errors;
  }, ["third-party claim promotion envelope runtime validation failed"]);
}

export function thirdPartyClaimPromotionReferencesRuntime(value) {
  if (validateThirdPartyClaimPromotionRuntime(value).length) return null;
  const approvalReferences = agentWriteApprovalBindingReferencesRuntime(value.approval);
  if (!approvalReferences) return null;
  return [
    { ref: `plan:${value.planId}`, necessity: "required_for_replay" },
    { ref: `evidence-third-party-claim-candidate:${value.candidateId}`, necessity: "required_for_replay" },
    { ref: `evidence-capture:${value.originalCaptureId}`, necessity: "required_for_replay" },
    { ref: `evidence-capture:${value.promotedCaptureId}`, necessity: "required_for_replay" },
    { ref: `evidence-claim:${value.activeClaimId}`, necessity: "required_for_replay" },
    ...approvalReferences,
  ];
}
