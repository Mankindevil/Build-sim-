import { sha256Json } from "../runtime/fs.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SESSION_ID = /^[A-Za-z0-9._:-]{8,120}$/;
const PLAN_ID = /^[-A-Za-z0-9._]{1,160}$/;
const PROPOSAL_ID = /^agent-proposal-[a-f0-9]{64}$/;
const CLAIM_CANDIDATE_ID = /^claim-candidate-sha256-[a-f0-9]{64}$/;
const THIRD_PARTY_CLAIM_CANDIDATE_ID = /^third-party-claim-candidate-sha256-[a-f0-9]{64}$/;
const CLAIM_ID = /^claim-sha256-([a-f0-9]{64})$/;
const DOCUMENT_ID = /^doc-sha256-([a-f0-9]{64})$/;
const CAPTURE_ID = /^capture-sha256-[a-f0-9]{64}$/;
const CONFIRMATION_ID = /^official-confirmation-sha256-[a-f0-9]{64}$/;
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "application/pdf"]);
const CLAIM_SCOPES = new Set(["family", "model", "variant", "revision"]);
const ACTIONS = new Set([
  "archive_official_evidence",
  "propose_fact_update",
  "bind_fact_evidence",
  "resolve_fact_conflict",
]);

function total(operation, fallback) { try { return operation(); } catch { return fallback; } }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function exact(value, allowed, required = allowed) {
  return record(value) && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => own(value, key));
}
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function safeText(value, maximum = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.normalize("NFC") && !/[\u0000-\u001f\u007f]/.test(value);
}
function hashBoundId(value, expression, hash) {
  const match = typeof value === "string" ? expression.exec(value) : null;
  return Boolean(match && match[1] === hash);
}

function validateClaimSubject(value, scope) {
  const allowed = ["skuId", "familyId", "modelId", "variantId", "revision", "region"];
  if (!exact(value, allowed, ["skuId", "familyId"])) return false;
  if (Object.values(value).some((entry) => !safeText(entry, 256))) return false;
  if (scope === "model" && !own(value, "modelId")) return false;
  if (scope === "variant" && (!own(value, "modelId") || !own(value, "variantId"))) return false;
  if (scope === "revision" && (!own(value, "modelId") || !own(value, "variantId") || !own(value, "revision"))) return false;
  return CLAIM_SCOPES.has(scope);
}

function validateArchiveOfficialPayload(value) {
  const keys = [
    "candidateId", "candidateHash", "activeClaimId", "activeClaimHash", "authority", "scope", "subject", "documentId",
    "documentSha256", "captureId", "originalCaptureId", "promotionConfirmationId", "exactIdentityRecheckedByClaimRepository",
  ];
  return exact(value, keys)
    && SHA256.test(value.candidateHash)
    && CLAIM_CANDIDATE_ID.test(value.candidateId)
    && SHA256.test(value.activeClaimHash)
    && hashBoundId(value.activeClaimId, CLAIM_ID, value.activeClaimHash)
    && value.authority === "official"
    && validateClaimSubject(value.subject, value.scope)
    && SHA256.test(value.documentSha256)
    && hashBoundId(value.documentId, DOCUMENT_ID, value.documentSha256)
    && CAPTURE_ID.test(value.captureId)
    && CAPTURE_ID.test(value.originalCaptureId)
    && value.captureId !== value.originalCaptureId
    && CONFIRMATION_ID.test(value.promotionConfirmationId)
    && value.exactIdentityRecheckedByClaimRepository === true;
}

function validateFactUpdatePayload(value) {
  const allowed = [
    "claimCandidateId", "claimCandidateHash", "claimAuthority", "claimFieldId",
    "claimSubject", "sourceCandidateId", "sourceCandidateHash", "intent", "targetFactId", "targetFactHash",
  ];
  const required = allowed.filter((key) => !["sourceCandidateId", "sourceCandidateHash", "targetFactId", "targetFactHash"].includes(key));
  if (!exact(value, allowed, required) || !SHA256.test(value.claimCandidateHash)
    || !hashBoundId(value.claimCandidateId, CLAIM_ID, value.claimCandidateHash)
    || !["official", "third_party"].includes(value.claimAuthority)
    || !safeText(value.claimFieldId, 256) || !validateClaimSubject(value.claimSubject, inferSubjectScope(value.claimSubject))
    || !["create", "replace", "withdraw"].includes(value.intent)) return false;
  const sourceCandidatePresent = own(value, "sourceCandidateId") || own(value, "sourceCandidateHash");
  if (sourceCandidatePresent && (!own(value, "sourceCandidateId") || !own(value, "sourceCandidateHash")
    || !THIRD_PARTY_CLAIM_CANDIDATE_ID.test(value.sourceCandidateId) || !SHA256.test(value.sourceCandidateHash)
    || value.claimAuthority !== "third_party")) return false;
  const targetPresent = own(value, "targetFactId") || own(value, "targetFactHash");
  if (targetPresent && (!own(value, "targetFactId") || !own(value, "targetFactHash")
    || !SAFE_ID.test(value.targetFactId) || !SHA256.test(value.targetFactHash))) return false;
  if (value.intent === "create" && targetPresent) return false;
  if (["replace", "withdraw"].includes(value.intent) && !targetPresent) return false;
  return true;
}

function inferSubjectScope(subject) {
  if (record(subject) && own(subject, "revision")) return "revision";
  if (record(subject) && own(subject, "variantId")) return "variant";
  if (record(subject) && own(subject, "modelId")) return "model";
  return "family";
}

function validateBindFactPayload(value) {
  const keys = ["factUpdateProposalId", "factUpdateProposalHash", "evidenceClaimId", "evidenceClaimHash", "bindingProposalId", "bindingProposalHash"];
  return exact(value, keys) && PROPOSAL_ID.test(value.factUpdateProposalId)
    && SHA256.test(value.factUpdateProposalHash) && SHA256.test(value.evidenceClaimHash)
    && hashBoundId(value.evidenceClaimId, CLAIM_ID, value.evidenceClaimHash)
    && /^evidence-binding-proposal-sha256-[a-f0-9]{64}$/.test(value.bindingProposalId)
    && SHA256.test(value.bindingProposalHash);
}

function validateResolveConflictPayload(value) {
  const allowed = ["conflictSetId", "conflictSetHash", "resolution", "selectedFactId", "selectedFactHash"];
  const required = ["conflictSetId", "conflictSetHash", "resolution"];
  if (!exact(value, allowed, required) || !SAFE_ID.test(value.conflictSetId)
    || !SHA256.test(value.conflictSetHash)
    || !["select_existing", "defer", "reject_candidates"].includes(value.resolution)) return false;
  const selectedPresent = own(value, "selectedFactId") || own(value, "selectedFactHash");
  if (value.resolution === "select_existing") {
    return selectedPresent && own(value, "selectedFactId") && own(value, "selectedFactHash")
      && SAFE_ID.test(value.selectedFactId) && SHA256.test(value.selectedFactHash);
  }
  return !selectedPresent;
}

function validActionPayload(action, payload) {
  if (action === "archive_official_evidence") return validateArchiveOfficialPayload(payload);
  if (action === "propose_fact_update") return validateFactUpdatePayload(payload);
  if (action === "bind_fact_evidence") return validateBindFactPayload(payload);
  if (action === "resolve_fact_conflict") return validateResolveConflictPayload(payload);
  return false;
}

/** Total validator shared by the write-side repository and production graph. */
export function validateGovernedAgentProposalRuntime(value) {
  return total(() => {
    const keys = [
      "schemaVersion", "proposalId", "action", "planId", "sessionId", "runId", "approvalId",
      "approvedBy", "requestHash", "payload", "status", "createdAt", "contentHash",
    ];
    if (!exact(value, keys)) return ["governed Agent proposal fields invalid"];
    const errors = [];
    if (value.schemaVersion !== "governed-agent-action-proposal-v1" || !PROPOSAL_ID.test(value.proposalId)) errors.push("governed Agent proposal identity invalid");
    if (!ACTIONS.has(value.action) || !validActionPayload(value.action, value.payload)) errors.push("governed Agent proposal action payload invalid");
    if (!PLAN_ID.test(value.planId) || !SESSION_ID.test(value.sessionId) || !SESSION_ID.test(value.runId)
      || !SESSION_ID.test(value.approvalId) || !SESSION_ID.test(value.approvedBy)) errors.push("governed Agent proposal authority IDs invalid");
    if (value.status !== "proposed" || !iso(value.createdAt)) errors.push("governed Agent proposal state invalid");
    const expectedRequestHash = sha256Json({ action: value.action, planId: value.planId, payload: value.payload });
    if (!SHA256.test(value.requestHash) || value.requestHash !== expectedRequestHash) errors.push("governed Agent proposal request hash invalid");
    const material = { ...value }; delete material.contentHash;
    if (!SHA256.test(value.contentHash) || value.contentHash !== sha256Json(material)) errors.push("governed Agent proposal content hash invalid");
    return errors;
  }, ["governed Agent proposal runtime validation failed"]);
}

export function validateGovernedAgentProposalEnvelopeRuntime(value, expectedProposalId) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "kind", "checksum", "payload"])) return ["governed Agent proposal envelope fields invalid"];
    const errors = validateGovernedAgentProposalRuntime(value.payload);
    if (value.schemaVersion !== "governed-agent-action-proposal-envelope-v1"
      || value.kind !== "governed-agent-action-proposal" || !SHA256.test(value.checksum)
      || value.checksum !== sha256Json(value.payload)) errors.push("governed Agent proposal envelope integrity invalid");
    if (expectedProposalId !== undefined && value.payload?.proposalId !== expectedProposalId) errors.push("governed Agent proposal path binding invalid");
    return errors;
  }, ["governed Agent proposal envelope runtime validation failed"]);
}

/** Exact action-owned graph targets; callers must not synthesize extra refs. */
export function governedAgentProposalReferencesRuntime(value) {
  if (validateGovernedAgentProposalRuntime(value).length) return null;
  const references = [
    { ref: `plan:${value.planId}`, necessity: "required_for_replay" },
    { ref: `agent-session:${value.sessionId}`, necessity: "optional_for_audit" },
    { ref: `agent-audit:${value.runId}`, necessity: "optional_for_audit" },
  ];
  if (value.action === "archive_official_evidence") references.push(
    { ref: `evidence-claim-candidate:${value.payload.candidateId}`, necessity: "required_for_replay" },
    { ref: `evidence-claim:${value.payload.activeClaimId}`, necessity: "required_for_replay" },
    { ref: `evidence-capture:${value.payload.originalCaptureId}`, necessity: "required_for_replay" },
    { ref: `evidence-capture:${value.payload.captureId}`, necessity: "required_for_replay" },
  );
  if (value.action === "propose_fact_update") {
    references.push({ ref: `evidence-claim:${value.payload.claimCandidateId}`, necessity: "required_for_replay" });
    if (value.payload.sourceCandidateId) references.push({ ref: `evidence-third-party-claim-candidate:${value.payload.sourceCandidateId}`, necessity: "required_for_replay" });
    if (value.payload.targetFactId) references.push({ ref: `fact:${value.payload.targetFactId}`, necessity: "required_for_replay" });
  }
  if (value.action === "bind_fact_evidence") references.push(
    { ref: `agent-proposal:${value.payload.factUpdateProposalId}`, necessity: "required_for_replay" },
    { ref: `evidence-claim:${value.payload.evidenceClaimId}`, necessity: "required_for_replay" },
    { ref: `evidence-binding-proposal:${value.payload.bindingProposalId}`, necessity: "required_for_replay" },
  );
  if (value.action === "resolve_fact_conflict") {
    references.push({ ref: `fact-conflict:${value.payload.conflictSetId}`, necessity: "required_for_replay" });
    if (value.payload.selectedFactId) references.push({ ref: `fact:${value.payload.selectedFactId}`, necessity: "required_for_replay" });
  }
  return references;
}

export function validateStagedUploadRecordRuntime(value, options = {}) {
  return total(() => {
    const allowed = [
      "schemaVersion", "uploadId", "sessionId", "mediaType", "byteLength", "contentHash", "status",
      "revision", "consumerHash", "attachmentId", "createdAt", "expiresAt", "consumedAt",
    ];
    const required = allowed.filter((key) => !["consumerHash", "attachmentId", "consumedAt"].includes(key));
    if (!exact(value, allowed, required)) return ["staged attachment fields invalid"];
    const errors = [];
    const maximum = Number.isSafeInteger(options.maxBytes) ? options.maxBytes : 20 * 1024 * 1024;
    if (value.schemaVersion !== "staged-user-attachment-v2" || !SAFE_ID.test(value.uploadId)
      || (options.uploadId !== undefined && value.uploadId !== options.uploadId)
      || !SESSION_ID.test(value.sessionId)) errors.push("staged attachment identity invalid");
    if (!MEDIA_TYPES.has(value.mediaType) || !Number.isSafeInteger(value.byteLength)
      || value.byteLength < 1 || value.byteLength > maximum || !SHA256.test(value.contentHash)) errors.push("staged attachment body authority invalid");
    if (!iso(value.createdAt) || !iso(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) errors.push("staged attachment retention interval invalid");
    if (!["available", "claimed", "consumed"].includes(value.status)) errors.push("staged attachment status invalid");
    if (value.status === "available" && (value.revision !== 0 || own(value, "consumerHash") || own(value, "attachmentId") || own(value, "consumedAt"))) errors.push("staged attachment available state invalid");
    if (value.status === "claimed" && (value.revision !== 1 || !SHA256.test(value.consumerHash) || own(value, "attachmentId") || own(value, "consumedAt"))) errors.push("staged attachment claimed state invalid");
    if (value.status === "consumed" && (value.revision !== 2 || !SHA256.test(value.consumerHash)
      || !SAFE_ID.test(value.attachmentId) || !iso(value.consumedAt)
      || Date.parse(value.consumedAt) < Date.parse(value.createdAt))) errors.push("staged attachment consumed state invalid");
    return errors;
  }, ["staged attachment runtime validation failed"]);
}

export function validateStagedUploadEnvelopeRuntime(value, options = {}) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "kind", "checksum", "payload"])) return ["staged attachment envelope fields invalid"];
    const errors = validateStagedUploadRecordRuntime(value.payload, options);
    if (value.schemaVersion !== "staged-user-attachment-envelope-v1" || value.kind !== "staged-user-attachment"
      || !SHA256.test(value.checksum) || value.checksum !== sha256Json(value.payload)) errors.push("staged attachment envelope integrity invalid");
    return errors;
  }, ["staged attachment envelope runtime validation failed"]);
}

export function stagedUploadReferencesRuntime(value) {
  if (validateStagedUploadRecordRuntime(value).length) return null;
  const references = [
    { ref: `staged-attachment-blob:sha256:${value.contentHash}`, necessity: "required_for_replay" },
    { ref: `agent-session:${value.sessionId}`, necessity: "required_for_replay" },
  ];
  return references;
}
