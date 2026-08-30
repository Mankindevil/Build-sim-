import { sha256Json } from "../runtime/fs.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const PROPOSAL_ID = /^evidence-binding-proposal-sha256-[a-f0-9]{64}$/;
const PLAN_ID = /^[-A-Za-z0-9._]{1,160}$/;
const PIPELINE_ID = /^evidence-pipeline-sha256-[a-f0-9]{64}$/;
const JOB_ID = /^job-[a-f0-9]{64}$/;
const ARTIFACT_REF = /^sha256:[a-f0-9]{64}$/;
const OFFICIAL_CANDIDATE_ID = /^claim-candidate-sha256-[a-f0-9]{64}$/;
const THIRD_PARTY_CANDIDATE_ID = /^third-party-claim-candidate-sha256-[a-f0-9]{64}$/;
const ADAPTER_CANDIDATE_ID = /^evidence-adapter-candidate-sha256-([a-f0-9]{64})$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;

function total(operation, fallback) { try { return operation(); } catch { return fallback; } }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function exact(value, allowed, required = allowed) {
  return record(value) && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => own(value, key));
}
function iso(value) { return total(() => typeof value === "string" && new Date(value).toISOString() === value, false); }
function text(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim()
    && value === value.normalize("NFC") && !/[\u0000-\u001f\u007f]/.test(value);
}
function subject(value) {
  const keys = ["brand", "category", "skuId", "familyId", "modelId", "variantId", "revision", "region"];
  if (!exact(value, keys, ["brand", "category", "skuId", "familyId"])) return false;
  return text(value.brand) && text(value.category) && TOKEN.test(value.skuId) && TOKEN.test(value.familyId)
    && ["modelId", "variantId", "revision", "region"].every((key) => value[key] === undefined || TOKEN.test(value[key]));
}
function candidateIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 512 || new Set(value).size !== value.length) return false;
  const official = value.every((item) => typeof item === "string" && OFFICIAL_CANDIDATE_ID.test(item));
  const thirdParty = value.every((item) => typeof item === "string" && THIRD_PARTY_CANDIDATE_ID.test(item));
  return (official || thirdParty) && value.every((item, index) => index === 0 || value[index - 1].localeCompare(item) < 0);
}

function proposalMaterial(value) {
  return {
    schemaVersion: "evidence-binding-proposal-v1",
    planId: value.planId,
    pipelineId: value.pipelineId,
    subject: value.subject,
    claimCandidateIds: value.claimCandidateIds,
    adapterCandidateId: value.adapterCandidateId,
    adapterCandidateHash: value.adapterCandidateHash,
    approvalRequired: true,
    createdAt: value.createdAt,
  };
}

export function createEvidenceBindingProposalRuntime(input) {
  return total(() => {
    if (!exact(input, ["planId", "pipelineId", "subject", "claimCandidateIds", "adapterCandidateId", "adapterCandidateHash", "createdAt"])) return null;
    const material = proposalMaterial({
      ...input,
      claimCandidateIds: Object.freeze([...new Set(input.claimCandidateIds)].sort()),
    });
    const contentHash = sha256Json(material);
    const proposal = Object.freeze({
      ...material,
      bindingProposalId: `evidence-binding-proposal-sha256-${contentHash}`,
      contentHash,
    });
    return validateEvidenceBindingProposalRuntime(proposal).length ? null : proposal;
  }, null);
}

export function validateEvidenceBindingProposalRuntime(value) {
  return total(() => {
    const keys = [
      "schemaVersion", "bindingProposalId", "planId", "pipelineId", "subject", "claimCandidateIds",
      "adapterCandidateId", "adapterCandidateHash", "approvalRequired", "createdAt", "contentHash",
    ];
    if (!exact(value, keys)) return ["evidence binding proposal fields invalid"];
    const errors = [];
    const adapterMatch = typeof value.adapterCandidateId === "string" ? ADAPTER_CANDIDATE_ID.exec(value.adapterCandidateId) : null;
    if (value.schemaVersion !== "evidence-binding-proposal-v1" || !PROPOSAL_ID.test(value.bindingProposalId)
      || !PLAN_ID.test(value.planId) || !PIPELINE_ID.test(value.pipelineId)) errors.push("evidence binding proposal identity invalid");
    if (!subject(value.subject) || !candidateIds(value.claimCandidateIds)) errors.push("evidence binding proposal governed subject/candidates invalid");
    if (!adapterMatch || !SHA256.test(value.adapterCandidateHash) || adapterMatch[1] !== value.adapterCandidateHash) {
      errors.push("evidence binding proposal adapter candidate hash binding invalid");
    }
    if (value.approvalRequired !== true || !iso(value.createdAt)) errors.push("evidence binding proposal approval/time invalid");
    const expectedHash = sha256Json(proposalMaterial(value));
    if (!SHA256.test(value.contentHash) || value.contentHash !== expectedHash
      || value.bindingProposalId !== `evidence-binding-proposal-sha256-${expectedHash}`) {
      errors.push("evidence binding proposal content identity invalid");
    }
    return errors;
  }, ["evidence binding proposal runtime validation failed"]);
}

export function validateEvidenceBindingProposalRecordRuntime(value) {
  return total(() => {
    const keys = [
      "schemaVersion", "proposal", "planConfigHash", "planDraftRevision", "jobId", "runtimeGeneration",
      "resultArtifactRef", "claimResultArtifactRef", "adapterResultArtifactRef", "recordHash",
    ];
    if (!exact(value, keys)) return ["evidence binding proposal record fields invalid"];
    const errors = validateEvidenceBindingProposalRuntime(value.proposal);
    if (value.schemaVersion !== "evidence-binding-proposal-record-v1" || !SHA256.test(value.planConfigHash)
      || !Number.isSafeInteger(value.planDraftRevision) || value.planDraftRevision < 0 || !JOB_ID.test(value.jobId)
      || !Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 1
      || !ARTIFACT_REF.test(value.resultArtifactRef) || !ARTIFACT_REF.test(value.claimResultArtifactRef)
      || !ARTIFACT_REF.test(value.adapterResultArtifactRef)) errors.push("evidence binding proposal record provenance invalid");
    const material = { ...value }; delete material.recordHash;
    if (!SHA256.test(value.recordHash) || value.recordHash !== sha256Json(material)) errors.push("evidence binding proposal record hash invalid");
    return errors;
  }, ["evidence binding proposal record runtime validation failed"]);
}

export function validateEvidenceBindingProposalEnvelopeRuntime(value, expectedProposalId) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "kind", "checksum", "payload"])) return ["evidence binding proposal envelope fields invalid"];
    const errors = validateEvidenceBindingProposalRecordRuntime(value.payload);
    if (value.schemaVersion !== "evidence-binding-proposal-envelope-v1" || value.kind !== "evidence-binding-proposal"
      || !SHA256.test(value.checksum) || value.checksum !== sha256Json(value.payload)) errors.push("evidence binding proposal envelope integrity invalid");
    if (expectedProposalId !== undefined && value.payload?.proposal?.bindingProposalId !== expectedProposalId) errors.push("evidence binding proposal path binding invalid");
    return errors;
  }, ["evidence binding proposal envelope runtime validation failed"]);
}

export function evidenceBindingProposalReferencesRuntime(value) {
  if (validateEvidenceBindingProposalRecordRuntime(value).length) return null;
  return [
    { ref: `plan:${value.proposal.planId}`, necessity: "required_for_replay" },
    { ref: `job:${value.jobId}`, necessity: "required_for_replay" },
    { ref: value.resultArtifactRef, necessity: "required_for_replay" },
    { ref: value.claimResultArtifactRef, necessity: "required_for_replay" },
    { ref: value.adapterResultArtifactRef, necessity: "required_for_replay" },
    ...value.proposal.claimCandidateIds.map((candidateId) => ({
      ref: candidateId.startsWith("third-party-")
        ? `evidence-third-party-claim-candidate:${candidateId}` : `evidence-claim-candidate:${candidateId}`,
      necessity: "required_for_replay",
    })),
  ];
}
