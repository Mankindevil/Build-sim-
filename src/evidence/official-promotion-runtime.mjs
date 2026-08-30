import { sha256Json } from "../runtime/fs.mjs";
import {
  agentWriteApprovalBindingReferencesRuntime,
  validateAgentWriteApprovalBindingRuntime,
} from "../agent/write-approval-runtime.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const PROMOTION_ID = /^official-promotion-sha256-[a-f0-9]{64}$/;
const CANDIDATE_ID = /^claim-candidate-sha256-[a-f0-9]{64}$/;
const CONFIRMATION_ID = /^official-confirmation-sha256-([a-f0-9]{64})$/;
const CAPTURE_ID = /^capture-sha256-[a-f0-9]{64}$/;
const CLAIM_ID = /^claim-sha256-([a-f0-9]{64})$/;
const PLAN_ID = /^[-A-Za-z0-9._]{1,160}$/;

function total(operation, fallback) { try { return operation(); } catch { return fallback; } }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) { return record(value) && Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key)); }
function iso(value) { return total(() => typeof value === "string" && new Date(value).toISOString() === value, false); }

function material(value) {
  return {
    schemaVersion: "official-claim-promotion-v1",
    candidateId: value.candidateId,
    candidateHash: value.candidateHash,
    planId: value.planId,
    confirmationId: value.confirmationId,
    confirmationHash: value.confirmationHash,
    originalCaptureId: value.originalCaptureId,
    promotedCaptureId: value.promotedCaptureId,
    activeClaimId: value.activeClaimId,
    activeClaimHash: value.activeClaimHash,
    approval: value.approval,
    promotedAt: value.promotedAt,
  };
}

export function createOfficialClaimPromotionRuntime(input) {
  return total(() => {
    const contentHash = sha256Json(material(input));
    const value = Object.freeze({
      ...material(input),
      promotionId: `official-promotion-sha256-${contentHash}`,
      contentHash,
    });
    return validateOfficialClaimPromotionRuntime(value).length ? null : value;
  }, null);
}

export function validateOfficialClaimPromotionRuntime(value) {
  return total(() => {
    const keys = [
      "schemaVersion", "promotionId", "candidateId", "candidateHash", "planId", "confirmationId", "confirmationHash",
      "originalCaptureId", "promotedCaptureId", "activeClaimId", "activeClaimHash", "promotedAt", "contentHash",
      "approval",
    ];
    if (!exact(value, keys)) return ["official claim promotion fields invalid"];
    const errors = [];
    const claimMatch = typeof value.activeClaimId === "string" ? CLAIM_ID.exec(value.activeClaimId) : null;
    const confirmationMatch = typeof value.confirmationId === "string" ? CONFIRMATION_ID.exec(value.confirmationId) : null;
    if (value.schemaVersion !== "official-claim-promotion-v1" || !PROMOTION_ID.test(value.promotionId)
      || !CANDIDATE_ID.test(value.candidateId) || !PLAN_ID.test(value.planId) || !confirmationMatch) {
      errors.push("official claim promotion identity invalid");
    }
    if (!SHA256.test(value.candidateHash) || !SHA256.test(value.confirmationHash)
      || confirmationMatch?.[1] !== value.confirmationHash || !CAPTURE_ID.test(value.originalCaptureId)
      || !CAPTURE_ID.test(value.promotedCaptureId) || value.originalCaptureId === value.promotedCaptureId
      || !claimMatch || !SHA256.test(value.activeClaimHash) || claimMatch?.[1] !== value.activeClaimHash || !iso(value.promotedAt)) {
      errors.push("official claim promotion authority binding invalid");
    }
    if (validateAgentWriteApprovalBindingRuntime(value.approval).length
      || value.approval?.toolName !== "archive_official_evidence"
      || value.promotedAt !== value.approval?.issuedAt) {
      errors.push("official claim promotion reviewed approval binding invalid");
    }
    const expected = sha256Json(material(value));
    if (!SHA256.test(value.contentHash) || value.contentHash !== expected
      || value.promotionId !== `official-promotion-sha256-${expected}`) errors.push("official claim promotion content identity invalid");
    return errors;
  }, ["official claim promotion runtime validation failed"]);
}

export function officialClaimPromotionReferencesRuntime(value) {
  if (validateOfficialClaimPromotionRuntime(value).length) return null;
  const approvalReferences = agentWriteApprovalBindingReferencesRuntime(value.approval);
  if (!approvalReferences) return null;
  return [
    { ref: `plan:${value.planId}`, necessity: "required_for_replay" },
    { ref: `evidence-claim-candidate:${value.candidateId}`, necessity: "required_for_replay" },
    { ref: `evidence-capture:${value.originalCaptureId}`, necessity: "required_for_replay" },
    { ref: `evidence-capture:${value.promotedCaptureId}`, necessity: "required_for_replay" },
    { ref: `evidence-claim:${value.activeClaimId}`, necessity: "required_for_replay" },
    ...approvalReferences,
  ];
}
