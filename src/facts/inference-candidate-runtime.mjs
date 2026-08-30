import { sha256Json } from "../runtime/fs.mjs";
import {
  factFieldPolicyRuntime,
  validateFactRecordRuntime,
  validateReplayableInferenceTraceRuntime,
  verifyFactRecordRuntime,
  verifyReplayableInferenceTraceRuntime,
} from "./canonical-runtime.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_REF = /^sha256:([a-f0-9]{64})$/;
const CANDIDATE_ID = /^fact-inference-candidate-sha256-[a-f0-9]{64}$/;
const APPROVAL_ID = /^inference-approval-sha256-[a-f0-9]{64}$/;
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/;
const REQUIRED_INVALIDATION_CONDITIONS = Object.freeze([
  "input_fact_hash_changed",
  "plan_revision_changed",
  "rule_artifact_changed",
]);

function total(operation, fallback) { try { return operation(); } catch { return fallback; } }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function exact(value, allowed, required = allowed) {
  return record(value) && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => own(value, key));
}
function iso(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && total(() => new Date(value).toISOString() === value, false);
}
function text(value, maximum = 512) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || value !== value.trim() || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return true;
}
function sortedUniqueText(value, maximum = 512, nonEmpty = true) {
  return Array.isArray(value) && (!nonEmpty || value.length > 0)
    && value.every((item) => text(item, maximum))
    && new Set(value).size === value.length
    && value.every((item, index) => index === 0 || value[index - 1].localeCompare(item) < 0);
}
function finiteJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || value === undefined || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.keys(value).length === value.length && value.every((item) => finiteJson(item, ancestors));
    if (!record(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
    return Object.values(value).every((item) => item !== undefined && finiteJson(item, ancestors));
  } finally { ancestors.delete(value); }
}

export function validateGovernedInferenceRuleArtifactRuntime(value) {
  return total(() => {
    const keys = [
      "schemaVersion", "ruleId", "ruleVersion", "implementationId", "implementationHash", "engine", "targetFieldId",
      "inputFieldIds", "formula", "parameters", "assumptions", "confidence", "invalidationConditions",
    ];
    if (!exact(value, keys)) return ["governed inference rule artifact fields invalid"];
    const errors = [];
    if (value.schemaVersion !== "governed-inference-rule-v1" || value.engine !== "rule"
      || !TOKEN.test(String(value.ruleId ?? "")) || !TOKEN.test(String(value.ruleVersion ?? ""))
      || !TOKEN.test(String(value.implementationId ?? "")) || !SHA256.test(String(value.implementationHash ?? ""))
      || !TOKEN.test(String(value.targetFieldId ?? ""))) {
      errors.push("governed inference rule identity invalid");
    }
    if (!sortedUniqueText(value.inputFieldIds, 256) || value.inputFieldIds.includes(value.targetFieldId)) {
      errors.push("governed inference rule input fields invalid");
    }
    if (!text(value.formula, 2_048) || !finiteJson(value.parameters)) errors.push("governed inference rule formula/parameters invalid");
    if (!sortedUniqueText(value.assumptions, 1_024) || typeof value.confidence !== "number"
      || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
      errors.push("governed inference rule assumptions/confidence invalid");
    }
    if (!sortedUniqueText(value.invalidationConditions, 1_024)
      || REQUIRED_INVALIDATION_CONDITIONS.some((condition) => !value.invalidationConditions.includes(condition))) {
      errors.push("governed inference rule invalidation conditions incomplete");
    }
    return errors;
  }, ["governed inference rule artifact validation failed closed"]);
}

export function factInferenceCandidateIdRuntime(input) {
  const keys = ["planId", "planDraftRevision", "ruleArtifactRef", "inferenceTraceId", "proposedFactId",
    ...(input?.proposalApprovalRef === undefined ? [] : ["proposalApprovalRef"])];
  if (!exact(input, keys)
    || !PLAN_ID.test(String(input.planId ?? "")) || !Number.isSafeInteger(input.planDraftRevision) || input.planDraftRevision < 0
    || !ARTIFACT_REF.test(String(input.ruleArtifactRef ?? ""))
    || !/^inference-sha256-[a-f0-9]{64}$/.test(String(input.inferenceTraceId ?? ""))
    || !TOKEN.test(String(input.proposedFactId ?? ""))
    || (input.proposalApprovalRef !== undefined && !ARTIFACT_REF.test(String(input.proposalApprovalRef)))) return null;
  return `fact-inference-candidate-sha256-${sha256Json({
    schemaVersion: "fact-inference-candidate-identity-v1",
    planId: input.planId,
    planDraftRevision: input.planDraftRevision,
    ruleArtifactRef: input.ruleArtifactRef,
    inferenceTraceId: input.inferenceTraceId,
    proposedFactId: input.proposedFactId,
    ...(input.proposalApprovalRef === undefined ? {} : { proposalApprovalRef: input.proposalApprovalRef }),
  })}`;
}

export function validateFactInferenceCandidateRuntime(value) {
  return total(() => {
    const keys = [
      "schemaVersion", "candidateId", "planId", "planConfigHash", "planDraftRevision", "runtimeGeneration",
      "ruleArtifactRef", "rule", "target", "trace", "proposedFact", "candidateStatus", "safetyDisposition",
      "maySupportSafetyPass", "createdAt", "contentHash",
      ...(value?.proposalApprovalRef === undefined ? [] : ["proposalApprovalRef"]),
    ];
    if (!exact(value, keys)) return ["fact inference candidate fields invalid"];
    const errors = [];
    const artifact = ARTIFACT_REF.exec(String(value.ruleArtifactRef ?? ""));
    if (value.schemaVersion !== "fact-inference-candidate-v1" || !CANDIDATE_ID.test(String(value.candidateId ?? ""))
      || !PLAN_ID.test(String(value.planId ?? "")) || !SHA256.test(String(value.planConfigHash ?? ""))
      || !Number.isSafeInteger(value.planDraftRevision) || value.planDraftRevision < 0
      || !Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 1 || !artifact || !iso(value.createdAt)
      || (value.proposalApprovalRef !== undefined && !ARTIFACT_REF.test(String(value.proposalApprovalRef)))) {
      errors.push("fact inference candidate identity/provenance invalid");
    }
    if (validateGovernedInferenceRuleArtifactRuntime(value.rule).length) errors.push("fact inference candidate rule artifact invalid");
    if (!exact(value.target, ["fieldId"]) || value.target.fieldId !== value.rule?.targetFieldId) {
      errors.push("fact inference candidate target invalid");
    }
    if (validateReplayableInferenceTraceRuntime(value.trace).length || !verifyReplayableInferenceTraceRuntime(value.trace)) {
      errors.push("fact inference candidate trace invalid");
    }
    if (validateFactRecordRuntime(value.proposedFact).length || !verifyFactRecordRuntime(value.proposedFact)) {
      errors.push("fact inference candidate proposed fact invalid");
    }
    const trace = value.trace;
    const fact = value.proposedFact;
    if (fact?.authority !== "agent_inference" || fact?.status !== "active" || fact?.field !== value.target?.fieldId
      || fact?.inferenceTraceId !== trace?.inferenceTraceId || fact?.extractorOrRuleVersion !== value.rule?.ruleVersion
      || fact?.retrievedAt !== value.createdAt || !Array.isArray(trace?.outputFactIds) || trace.outputFactIds.length !== 1
      || trace.outputFactIds[0] !== fact?.factId || trace?.ruleOrModelId !== value.rule?.ruleId
      || trace?.ruleOrModelVersion !== value.rule?.ruleVersion || trace?.engine !== "rule"
      || trace?.ruleOrModelArtifactHash !== artifact?.[1]
      || sha256Json(trace?.assumptions) !== sha256Json(value.rule?.assumptions)
      || sha256Json(trace?.invalidationConditions) !== sha256Json(value.rule?.invalidationConditions)
      || trace?.confidence !== value.rule?.confidence
      || sha256Json(trace?.inputFactRefs?.map((ref) => ref.factId) ?? []) !== sha256Json(fact?.derivedFromFactIds ?? [])
      || sha256Json(fact?.assumptions ?? []) !== sha256Json(value.rule?.assumptions ?? [])) {
      errors.push("fact inference candidate trace/fact/rule closure invalid");
    }
    const expectedDisposition = fact?.safetyClass === "normal" ? "planning_only" : "blocked_requires_non_inference_evidence";
    if (value.candidateStatus !== "pending_approval" || value.maySupportSafetyPass !== false
      || value.safetyDisposition !== expectedDisposition) {
      errors.push("fact inference candidate approval/safety disposition invalid");
    }
    const expectedId = factInferenceCandidateIdRuntime({
      planId: value.planId,
      planDraftRevision: value.planDraftRevision,
      ruleArtifactRef: value.ruleArtifactRef,
      inferenceTraceId: trace?.inferenceTraceId,
      proposedFactId: fact?.factId,
      ...(value.proposalApprovalRef === undefined ? {} : { proposalApprovalRef: value.proposalApprovalRef }),
    });
    if (expectedId === null || value.candidateId !== expectedId) errors.push("fact inference candidate ID binding invalid");
    const material = { ...value }; delete material.contentHash;
    if (!SHA256.test(String(value.contentHash ?? "")) || value.contentHash !== sha256Json(material)) {
      errors.push("fact inference candidate content hash invalid");
    }
    return errors;
  }, ["fact inference candidate runtime validation failed closed"]);
}

export function validateFactInferenceCandidateEnvelopeRuntime(value, expectedCandidateId) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "kind", "checksum", "payload"])) {
      return ["fact inference candidate envelope fields invalid"];
    }
    const errors = validateFactInferenceCandidateRuntime(value.payload);
    if (value.schemaVersion !== "fact-inference-candidate-envelope-v1" || value.kind !== "fact-inference-candidate"
      || !SHA256.test(String(value.checksum ?? "")) || value.checksum !== sha256Json(value.payload)) {
      errors.push("fact inference candidate envelope integrity invalid");
    }
    if (expectedCandidateId !== undefined && value.payload?.candidateId !== expectedCandidateId) {
      errors.push("fact inference candidate path binding invalid");
    }
    return errors;
  }, ["fact inference candidate envelope validation failed closed"]);
}

export function inferenceCandidateReferencesRuntime(value) {
  if (validateFactInferenceCandidateRuntime(value).length) return null;
  return [
    { ref: `plan:${value.planId}`, necessity: "required_for_replay" },
    { ref: value.ruleArtifactRef, necessity: "required_for_replay" },
    ...(value.proposalApprovalRef === undefined ? [] : [{ ref: value.proposalApprovalRef, necessity: "required_for_replay" }]),
    ...value.trace.inputFactRefs.map((input) => ({ ref: `fact:${input.factId}`, necessity: "required_for_replay" })),
  ];
}

export function inferenceApprovalTransactionIdRuntime(candidateId, candidateHash, trace, fact, approvalAuthorityRef) {
  if (!CANDIDATE_ID.test(String(candidateId ?? "")) || !SHA256.test(String(candidateHash ?? ""))) return null;
  if (approvalAuthorityRef !== undefined && !ARTIFACT_REF.test(String(approvalAuthorityRef))) return null;
  if (validateReplayableInferenceTraceRuntime(trace).length || !verifyReplayableInferenceTraceRuntime(trace)
    || validateFactRecordRuntime(fact).length || !verifyFactRecordRuntime(fact)) return null;
  return `inference-approval-sha256-${sha256Json({
    schemaVersion: "fact-inference-approval-identity-v1",
    candidateId,
    candidateHash,
    inferenceTraceId: trace.inferenceTraceId,
    factId: fact.factId,
    ...(approvalAuthorityRef === undefined ? {} : { approvalAuthorityRef }),
  })}`;
}

/** Total validator shared by repository restore, Doctor, and production graph. */
export function validateInferenceApprovalTransactionRuntime(value, expectedTransactionId) {
  return total(() => {
    const status = value?.status;
    const keys = [
      "schemaVersion", "transactionId", "candidateId", "candidateHash", "status", "trace", "fact", "createdAt", "contentHash",
      ...(value?.approvalAuthorityRef === undefined ? [] : ["approvalAuthorityRef"]),
      ...(status === "committed" ? ["committedAt"] : []),
      ...(status === "aborted_stale" ? ["abortedAt", "abortReason"] : []),
    ];
    if (!exact(value, keys)) return ["inference approval transaction fields invalid"];
    const errors = [];
    const transactionId = inferenceApprovalTransactionIdRuntime(
      value.candidateId,
      value.candidateHash,
      value.trace,
      value.fact,
      value.approvalAuthorityRef,
    );
    if (value.schemaVersion !== "fact-inference-approval-transaction-v1"
      || !APPROVAL_ID.test(String(value.transactionId ?? ""))
      || !CANDIDATE_ID.test(String(value.candidateId ?? ""))
      || !SHA256.test(String(value.candidateHash ?? ""))
      || (value.approvalAuthorityRef !== undefined && !ARTIFACT_REF.test(String(value.approvalAuthorityRef)))
      || (expectedTransactionId !== undefined && value.transactionId !== expectedTransactionId)
      || transactionId !== value.transactionId || !iso(value.createdAt)
      || !["pending", "committed", "aborted_stale"].includes(status)) {
      errors.push("inference approval transaction identity/provenance invalid");
    }
    if (status === "committed" ? !iso(value.committedAt)
      : status === "aborted_stale" ? !iso(value.abortedAt) || value.abortReason !== "authority_or_input_stale"
        : false) {
      errors.push("inference approval transaction lifecycle invalid");
    }
    const trace = value.trace;
    const fact = value.fact;
    const policy = factFieldPolicyRuntime(fact?.field);
    const requiredInvalidations = ["input_fact_hash_changed", "plan_revision_changed", "rule_artifact_changed"];
    if (!policy || fact?.authority !== "agent_inference" || fact?.status !== "active"
      || fact?.safetyClass !== policy.safetyClass || !policy.allowedScopes.includes(fact?.scope)
      || !Array.isArray(fact?.evidenceRefs) || fact.evidenceRefs.length !== 0
      || fact?.inferenceTraceId !== trace?.inferenceTraceId
      || !Array.isArray(trace?.outputFactIds) || trace.outputFactIds.length !== 1 || trace.outputFactIds[0] !== fact?.factId
      || trace?.ruleOrModelVersion !== fact?.extractorOrRuleVersion
      || sha256Json(trace?.assumptions ?? null) !== sha256Json(fact?.assumptions ?? [])
      || sha256Json(trace?.inputFactRefs?.map((ref) => ref.factId).sort() ?? null)
        !== sha256Json([...(fact?.derivedFromFactIds ?? [])].sort())
      || requiredInvalidations.some((condition) => !trace?.invalidationConditions?.includes(condition))
      || policy.passAuthorities.includes("agent_inference")) {
      errors.push("inference approval transaction trace/fact/field/safety closure invalid");
    }
    if (!trace?.outputRange || typeof fact?.value !== "number" || !Number.isFinite(fact.value)
      || fact.value < trace.outputRange.min || fact.value > trace.outputRange.max
      || trace.outputRange.unit !== fact.unit) {
      errors.push("inference approval transaction output range closure invalid");
    }
    const material = { ...value }; delete material.contentHash;
    if (!SHA256.test(String(value.contentHash ?? "")) || value.contentHash !== sha256Json(material)) {
      errors.push("inference approval transaction content hash invalid");
    }
    return errors;
  }, ["inference approval transaction validation failed closed"]);
}

export function validateInferenceApprovalEnvelopeRuntime(value, expectedTransactionId) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "kind", "checksum", "payload"])) {
      return ["inference approval envelope fields invalid"];
    }
    const errors = validateInferenceApprovalTransactionRuntime(value.payload, expectedTransactionId);
    if (value.schemaVersion !== "fact-repository-envelope-v1" || value.kind !== "inference-approval"
      || !SHA256.test(String(value.checksum ?? "")) || value.checksum !== sha256Json(value.payload)) {
      errors.push("inference approval envelope integrity invalid");
    }
    return errors;
  }, ["inference approval envelope validation failed closed"]);
}
