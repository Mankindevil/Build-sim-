import { validatePlanEvaluationLockRuntime } from "../plans/canonical-runtime.mjs";
import { sha256Json } from "../runtime/fs.mjs";
import {
  FACT_FIELD_POLICY_RUNTIME,
  isCanonicalUnicodeRuntime,
  isIsoTimestampRuntime,
  runtimeRecord,
  selectedFactSnapshotRefRuntime,
  validateConflictSetRuntime,
  validateUpdateDecisionRuntime,
  verifyConflictSetRuntime,
  verifyFactRecordRuntime,
  verifyUpdateDecisionRuntime,
} from "./canonical-runtime.mjs";

export const FACT_UPDATE_EVALUATION_DIFF_SCHEMA_VERSION_RUNTIME = "fact-update-evaluation-diff-v1";
export const FACT_UPDATE_SNAPSHOT_EVALUATION_SCHEMA_VERSION_RUNTIME = "fact-update-snapshot-evaluation-receipt-v1";
export const FACT_UPDATE_EVALUATION_DIFF_HASH_AUTHORITY_RUNTIME = Object.freeze({
  hashSpecVersion: "hash-spec-v1",
  algorithm: "sha256",
  canonicalizationPolicyId: "canonical-json-v1",
  domain: "fact-update-evaluation-diff",
});

export const FACT_UPDATE_EVALUATION_DOMAINS_RUNTIME = Object.freeze([
  "identity", "mechanical", "electrical", "firmware", "system", "storage", "assembly",
  "commissioning", "routing", "thermal", "acoustic", "procurement",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SNAPSHOT_ID = /^fact-snapshot-sha256-[a-f0-9]{64}$/;
const DECISION_ID = /^update-decision-sha256-[a-f0-9]{64}$/;
const DIFF_ID = /^fact-update-evaluation-diff-sha256-[a-f0-9]{64}$/;
const TRANSACTION_ID = /^fact-update-transaction-sha256-[a-f0-9]{64}$/;
const DOMAIN_SET = new Set(FACT_UPDATE_EVALUATION_DOMAINS_RUNTIME);

function total(operation, fallback) {
  try { return operation(); } catch { return fallback; }
}

function exact(value, keys) {
  return runtimeRecord(value) && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function uniqueStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
    && new Set(value).size === value.length;
}

function same(left, right) {
  return total(() => sha256Json(left) === sha256Json(right), false);
}

function sameStringSet(left, right) {
  return uniqueStrings(left) && uniqueStrings(right) && same([...left].sort(), [...right].sort());
}

function sortedUnique(values) {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

function domainsForGovernedFieldRuntime(fieldId) {
  if (fieldId.startsWith("identity.")) return ["identity"];
  if (fieldId.startsWith("physical.") || fieldId.startsWith("case.") || fieldId.startsWith("mount.")
    || fieldId === "motherboard.form_factor" || fieldId === "gpu.length" || fieldId === "gpu.slot_width"
    || fieldId === "cooling.fan_mounts" || fieldId === "cooling.radiator_support") return ["mechanical"];
  if (fieldId.startsWith("psu.") || fieldId.startsWith("power.")
    || fieldId === "gpu.power_connectors" || fieldId === "cooling.pump_header") return ["electrical"];
  if (fieldId.startsWith("io.")) return ["electrical", "routing"];
  if (fieldId.startsWith("firmware.") || fieldId === "motherboard.bios_version"
    || fieldId === "motherboard.bios_upgrade_methods") return ["firmware"];
  if (fieldId.startsWith("storage.") || fieldId === "hba.mode") return ["storage"];
  if (fieldId.startsWith("package.")) return ["assembly"];
  if (fieldId === "cable.connector_standard") return ["assembly", "electrical", "routing"];
  if (fieldId === "resource.kind" || fieldId.startsWith("fastener.") || fieldId.startsWith("tool.")
    || fieldId.startsWith("consumable.") || fieldId.startsWith("accessory.")) return ["assembly"];
  if (fieldId.startsWith("thermal.")) return ["thermal"];
  if (fieldId.startsWith("acoustic.")) return ["acoustic"];
  if (fieldId.startsWith("pcie.")) return ["routing"];
  if (fieldId.startsWith("compatibility.") || fieldId.startsWith("system.")) return ["system"];
  if (fieldId.startsWith("cpu.") || fieldId.startsWith("motherboard.") || fieldId.startsWith("memory.")
    || fieldId.startsWith("driver.")) return ["system"];
  return null;
}

export const FACT_UPDATE_FIELD_DOMAIN_RUNTIME = Object.freeze(Object.fromEntries(
  Object.keys(FACT_FIELD_POLICY_RUNTIME).sort().map((fieldId) => {
    const domains = domainsForGovernedFieldRuntime(fieldId);
    if (!domains) throw new Error(`governed fact field has no evaluation-domain authority: ${fieldId}`);
    return [fieldId, Object.freeze([...domains].sort())];
  }),
));

export function requiredEvaluationDomainsForFactFieldRuntime(fieldId) {
  return total(() => {
    const domains = FACT_UPDATE_FIELD_DOMAIN_RUNTIME[fieldId];
    return domains ? [...domains] : null;
  }, null);
}

function validateTarget(value) {
  if (value?.kind === "draft") {
    return exact(value, ["kind", "draftRevision"]) && Number.isInteger(value.draftRevision) && value.draftRevision >= 0
      ? [] : ["snapshot evaluation draft target invalid"];
  }
  if (value?.kind === "version") {
    return exact(value, ["kind", "versionId"]) && typeof value.versionId === "string" && PLAN_ID.test(value.versionId)
      ? [] : ["snapshot evaluation version target invalid"];
  }
  return ["snapshot evaluation plan target kind invalid"];
}

export function validateSnapshotEvaluationReceiptRuntime(value) {
  return total(() => {
    if (!runtimeRecord(value)) return ["snapshot evaluation receipt must be an object"];
    const errors = [];
    const keys = [
      "schemaVersion", "planId", "target", "runtimeGeneration", "configHash", "factSnapshotId", "factSnapshotHash",
      "evaluationHash", "evaluationLock", "domainHashes",
    ];
    if (!exact(value, keys)) errors.push("snapshot evaluation receipt fields invalid");
    if (value.schemaVersion !== FACT_UPDATE_SNAPSHOT_EVALUATION_SCHEMA_VERSION_RUNTIME) errors.push("snapshot evaluation receipt schema invalid");
    if (typeof value.planId !== "string" || !PLAN_ID.test(value.planId)) errors.push("snapshot evaluation receipt planId invalid");
    errors.push(...validateTarget(value.target));
    if (!Number.isInteger(value.runtimeGeneration) || value.runtimeGeneration < 1) {
      errors.push("snapshot evaluation receipt runtimeGeneration invalid");
    }
    for (const field of ["configHash", "factSnapshotHash", "evaluationHash"]) {
      if (!SHA256.test(String(value[field] ?? ""))) errors.push(`snapshot evaluation receipt ${field} invalid`);
    }
    if (typeof value.factSnapshotId !== "string" || !SNAPSHOT_ID.test(value.factSnapshotId)
      || value.factSnapshotId !== `fact-snapshot-sha256-${value.factSnapshotHash}`) {
      errors.push("snapshot evaluation receipt fact snapshot identity invalid");
    }
    errors.push(...validatePlanEvaluationLockRuntime(value.evaluationLock).map((error) => `snapshot evaluation receipt ${error}`));
    if (runtimeRecord(value.evaluationLock)) {
      const lock = value.evaluationLock;
      if (lock.planId !== value.planId || lock.factSnapshotId !== value.factSnapshotId
        || lock.snapshotHashes?.factSnapshotHash !== value.factSnapshotHash
        || lock.snapshotHashes?.configHash !== value.configHash) {
        errors.push("snapshot evaluation receipt plan/snapshot lock closure invalid");
      }
    }
    if (!runtimeRecord(value.domainHashes)) {
      errors.push("snapshot evaluation receipt domainHashes invalid");
    } else {
      for (const [domain, hash] of Object.entries(value.domainHashes)) {
        if (!DOMAIN_SET.has(domain) || !SHA256.test(String(hash))) errors.push("snapshot evaluation receipt domain hash invalid");
      }
    }
    return errors;
  }, ["snapshot evaluation receipt runtime validation failed"]);
}

export function verifySnapshotEvaluationReceiptRuntime(value) {
  return total(() => validateSnapshotEvaluationReceiptRuntime(value).length === 0, false);
}

function validateFieldDiffs(value) {
  if (!Array.isArray(value) || value.length === 0) return ["evaluation diff fieldDiffs invalid"];
  const errors = [];
  const fields = new Set();
  for (const [index, item] of value.entries()) {
    if (!exact(item, ["field", "beforeFactIds", "afterFactIds"])
      || typeof item.field !== "string" || item.field.length === 0
      || !uniqueStrings(item.beforeFactIds) || !uniqueStrings(item.afterFactIds)) {
      errors.push(`evaluation diff fieldDiffs.${index} invalid`);
      continue;
    }
    if (fields.has(item.field)) errors.push("evaluation diff contains duplicate field authority");
    fields.add(item.field);
  }
  return errors;
}

function evaluationDiffHashMaterialRuntime(value) {
  const material = structuredClone(value);
  delete material.schemaVersion;
  delete material.hashSpecVersion;
  delete material.hashAlgorithm;
  delete material.canonicalizationPolicyId;
  delete material.evaluationDiffId;
  delete material.contentHash;
  return {
    ...FACT_UPDATE_EVALUATION_DIFF_HASH_AUTHORITY_RUNTIME,
    schemaVersion: FACT_UPDATE_EVALUATION_DIFF_SCHEMA_VERSION_RUNTIME,
    payload: material,
  };
}

export function factUpdateEvaluationDiffContentHashRuntime(value) {
  return total(() => sha256Json(evaluationDiffHashMaterialRuntime(value)), null);
}

export function validateFactUpdateEvaluationDiffRuntime(value) {
  return total(() => {
    if (!runtimeRecord(value)) return ["fact update evaluation diff must be an object"];
    const errors = [];
    const keys = [
      "schemaVersion", "hashSpecVersion", "hashAlgorithm", "canonicalizationPolicyId", "evaluationDiffId",
      "updateDecisionId", "updateDecisionHash", "planId", "before", "after", "changedDomains", "fieldDiffs", "contentHash",
    ];
    if (!exact(value, keys)) errors.push("fact update evaluation diff fields invalid");
    if (value.schemaVersion !== FACT_UPDATE_EVALUATION_DIFF_SCHEMA_VERSION_RUNTIME) errors.push("fact update evaluation diff schema invalid");
    if (value.hashSpecVersion !== "hash-spec-v1" || value.hashAlgorithm !== "sha256"
      || value.canonicalizationPolicyId !== "canonical-json-v1") errors.push("fact update evaluation diff hash authority invalid");
    if (typeof value.evaluationDiffId !== "string" || !DIFF_ID.test(value.evaluationDiffId)
      || !SHA256.test(String(value.contentHash ?? ""))
      || value.evaluationDiffId !== `fact-update-evaluation-diff-sha256-${value.contentHash}`) {
      errors.push("fact update evaluation diff content identity invalid");
    }
    if (typeof value.updateDecisionId !== "string" || !DECISION_ID.test(value.updateDecisionId)
      || !SHA256.test(String(value.updateDecisionHash ?? ""))
      || value.updateDecisionId !== `update-decision-sha256-${value.updateDecisionHash}`) {
      errors.push("fact update evaluation diff decision identity invalid");
    }
    if (typeof value.planId !== "string" || !PLAN_ID.test(value.planId)) errors.push("fact update evaluation diff planId invalid");
    errors.push(...validateSnapshotEvaluationReceiptRuntime(value.before).map((error) => `before ${error}`));
    errors.push(...validateSnapshotEvaluationReceiptRuntime(value.after).map((error) => `after ${error}`));
    if (runtimeRecord(value.before) && runtimeRecord(value.after)) {
      if (value.before.planId !== value.planId || value.after.planId !== value.planId) errors.push("fact update evaluation diff plan closure invalid");
      if (value.before.runtimeGeneration !== value.after.runtimeGeneration) {
        errors.push("fact update evaluation diff runtime generation changed between snapshots");
      }
      if (!same(value.before.target, value.after.target) || value.before.configHash !== value.after.configHash) {
        errors.push("fact update evaluation diff plan target changed between snapshots");
      }
    }
    if (!uniqueStrings(value.changedDomains) || value.changedDomains.some((domain) => !DOMAIN_SET.has(domain))) {
      errors.push("fact update evaluation diff changedDomains invalid");
    } else if (!sortedUnique(value.changedDomains)) {
      errors.push("fact update evaluation diff changedDomains must be canonical");
    }
    errors.push(...validateFieldDiffs(value.fieldDiffs));
    return errors;
  }, ["fact update evaluation diff runtime validation failed"]);
}

export function verifyFactUpdateEvaluationDiffRuntime(value) {
  return total(() => validateFactUpdateEvaluationDiffRuntime(value).length === 0
    && value.contentHash === factUpdateEvaluationDiffContentHashRuntime(value), false);
}

function normalizedFieldDiffs(value) {
  return value.map((diff) => ({
    field: diff.field,
    beforeFactIds: [...diff.beforeFactIds].sort(),
    afterFactIds: [...diff.afterFactIds].sort(),
  })).sort((left, right) => left.field.localeCompare(right.field));
}

function unchangedLockClosure(receipt) {
  const hashes = { ...receipt.evaluationLock.snapshotHashes, factSnapshotHash: undefined };
  return {
    planId: receipt.evaluationLock.planId,
    snapshotHashes: hashes,
    userObservationSnapshotId: receipt.evaluationLock.userObservationSnapshotId,
    artifactLockfileHash: receipt.evaluationLock.artifactLockfileHash,
  };
}

export function validateFactUpdateEvaluationDiffClosureRuntime(diff, decision) {
  return total(() => {
    const errors = [];
    if (!verifyFactUpdateEvaluationDiffRuntime(diff)) errors.push("evaluation diff content authority invalid");
    if (validateUpdateDecisionRuntime(decision).length || !verifyUpdateDecisionRuntime(decision)) errors.push("evaluation diff update decision authority invalid");
    if (diff.updateDecisionId !== decision.updateDecisionId || diff.updateDecisionHash !== decision.contentHash) {
      errors.push("evaluation diff decision closure invalid");
    }
    if (!decision.planIds.includes(diff.planId)) errors.push("evaluation diff plan is outside the update decision");
    const beforeRef = decision.decision === "undo" ? decision.newSnapshotRef : decision.oldSnapshotRef;
    const afterRef = decision.decision === "undo" ? decision.oldSnapshotRef : decision.newSnapshotRef;
    if (diff.before.factSnapshotId !== beforeRef.snapshotId || diff.before.factSnapshotHash !== beforeRef.contentHash
      || diff.after.factSnapshotId !== afterRef.snapshotId || diff.after.factSnapshotHash !== afterRef.contentHash) {
      errors.push("evaluation diff snapshot direction closure invalid");
    }
    if (!same(unchangedLockClosure(diff.before), unchangedLockClosure(diff.after))) {
      errors.push("evaluation diff changed non-fact evaluation authority");
    }
    const expectedFields = normalizedFieldDiffs(decision.decision === "undo"
      ? decision.fieldDiffs.map((field) => ({ field: field.field, beforeFactIds: field.afterFactIds, afterFactIds: field.beforeFactIds }))
      : decision.fieldDiffs);
    if (!same(normalizedFieldDiffs(diff.fieldDiffs), expectedFields)) errors.push("evaluation diff field closure invalid");
    const affected = [...decision.affectedDomains].sort();
    if (!same(Object.keys(diff.before.domainHashes).sort(), affected)
      || !same(Object.keys(diff.after.domainHashes).sort(), affected)) {
      errors.push("evaluation diff affected-domain receipt closure incomplete");
    }
    const expectedChanged = affected.filter((domain) => diff.before.domainHashes[domain] !== diff.after.domainHashes[domain]);
    if (!same(diff.changedDomains, expectedChanged)) errors.push("evaluation diff changed-domain summary invalid");
    return errors;
  }, ["evaluation diff closure runtime validation failed"]);
}

export function updateDecisionMemoryKeyRuntime(decision) {
  return total(() => sha256Json({
    subjectKey: decision.subjectKey,
    claimKey: decision.claimKey,
    revision: decision.revision,
    planIds: [...decision.planIds].sort(),
  }), null);
}

export function factUpdatePlanKeyRuntime(planId) {
  return total(() => PLAN_ID.test(planId) ? sha256Json({ planId }) : null, null);
}

function snapshotRef(value) {
  return exact(value, ["snapshotId", "contentHash"])
    && SNAPSHOT_ID.test(String(value.snapshotId ?? "")) && SHA256.test(String(value.contentHash ?? ""))
    && value.snapshotId === `fact-snapshot-sha256-${value.contentHash}`;
}

export function validateFactUpdatePlanPointerRuntime(value, expectedPlanKey = undefined) {
  return total(() => {
    if (!runtimeRecord(value)) return ["fact update plan pointer must be an object"];
    const errors = [];
    const allowed = [
      "schemaVersion", "planKey", "planId", "revision", "decisionId", "decisionHash", "decisionMemoryKey",
      "selectedSnapshotRef", "previousSnapshotRef", "previousDecisionId", "previousDecisionHash", "updatedAt",
    ];
    const required = allowed.filter((key) => key !== "previousDecisionId" && key !== "previousDecisionHash");
    const keys = Object.keys(value);
    const previousPresent = value.previousDecisionId !== undefined || value.previousDecisionHash !== undefined;
    if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))
      || keys.length !== required.length + (previousPresent ? 2 : 0)
      || value.schemaVersion !== "fact-update-plan-pointer-v1" || !PLAN_ID.test(String(value.planId ?? ""))
      || !SHA256.test(String(value.planKey ?? "")) || value.planKey !== factUpdatePlanKeyRuntime(value.planId)
      || (expectedPlanKey !== undefined && value.planKey !== expectedPlanKey)
      || !Number.isInteger(value.revision) || value.revision < 0
      || !DECISION_ID.test(String(value.decisionId ?? "")) || !SHA256.test(String(value.decisionHash ?? ""))
      || value.decisionId !== `update-decision-sha256-${value.decisionHash}`
      || !SHA256.test(String(value.decisionMemoryKey ?? "")) || !snapshotRef(value.selectedSnapshotRef)
      || !snapshotRef(value.previousSnapshotRef) || !isIsoTimestampRuntime(value.updatedAt)
      || previousPresent !== (value.previousDecisionId !== undefined && value.previousDecisionHash !== undefined)
      || (previousPresent && (value.revision === 0 || !DECISION_ID.test(String(value.previousDecisionId))
        || !SHA256.test(String(value.previousDecisionHash))
        || value.previousDecisionId !== `update-decision-sha256-${value.previousDecisionHash}`))) {
      errors.push("fact update plan pointer authority invalid");
    }
    return errors;
  }, ["fact update plan pointer runtime validation failed"]);
}

export function validateFactUpdatePlanPointerClosureRuntime(pointer, decision, previousDecision = undefined) {
  return total(() => {
    const errors = [...validateFactUpdatePlanPointerRuntime(pointer)];
    if (validateUpdateDecisionRuntime(decision).length || !verifyUpdateDecisionRuntime(decision)) {
      errors.push("fact update plan pointer decision authority invalid");
      return errors;
    }
    const beforeRef = decision.decision === "undo" ? decision.newSnapshotRef : decision.oldSnapshotRef;
    if ((decision.decision !== "accept" && decision.decision !== "undo") || !decision.planIds.includes(pointer.planId)
      || decision.updateDecisionId !== pointer.decisionId || decision.contentHash !== pointer.decisionHash
      || updateDecisionMemoryKeyRuntime(decision) !== pointer.decisionMemoryKey
      || !same(selectedFactSnapshotRefRuntime(decision), pointer.selectedSnapshotRef)
      || !same(beforeRef, pointer.previousSnapshotRef)) {
      errors.push("fact update plan pointer decision closure invalid");
    }
    if (pointer.previousDecisionId !== undefined) {
      if (!previousDecision || validateUpdateDecisionRuntime(previousDecision).length || !verifyUpdateDecisionRuntime(previousDecision)
        || previousDecision.updateDecisionId !== pointer.previousDecisionId
        || previousDecision.contentHash !== pointer.previousDecisionHash || !previousDecision.planIds.includes(pointer.planId)
        || !same(selectedFactSnapshotRefRuntime(previousDecision), pointer.previousSnapshotRef)) {
        errors.push("fact update plan pointer previous-decision closure invalid");
      }
    } else if (previousDecision !== undefined) {
      errors.push("fact update plan pointer has undeclared previous decision");
    }
    return errors;
  }, ["fact update plan pointer closure runtime validation failed"]);
}

export function factUpdateConflictKeyRuntime(conflictSetId) {
  return total(() => isCanonicalUnicodeRuntime(conflictSetId, 256) ? sha256Json({ conflictSetId }) : null, null);
}

function conflictStateRef(value, conflictSetId) {
  return exact(value, ["conflictSetId", "contentHash"])
    && value.conflictSetId === conflictSetId && isCanonicalUnicodeRuntime(conflictSetId, 256)
    && SHA256.test(String(value.contentHash ?? ""));
}

export function validateFactUpdateConflictPointerRuntime(value, expectedConflictKey = undefined) {
  return total(() => {
    if (!runtimeRecord(value)) return ["fact update conflict pointer must be an object"];
    const errors = [];
    const allowed = [
      "schemaVersion", "conflictKey", "conflictSetId", "revision", "decisionId", "decisionHash",
      "decisionMemoryKey", "selectedConflictRef", "previousConflictRef", "previousDecisionId",
      "previousDecisionHash", "updatedAt",
    ];
    const required = allowed.filter((key) => key !== "previousDecisionId" && key !== "previousDecisionHash");
    const keys = Object.keys(value);
    const previousPresent = value.previousDecisionId !== undefined || value.previousDecisionHash !== undefined;
    if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))
      || keys.length !== required.length + (previousPresent ? 2 : 0)
      || value.schemaVersion !== "fact-update-conflict-pointer-v1"
      || !isCanonicalUnicodeRuntime(value.conflictSetId, 256)
      || !SHA256.test(String(value.conflictKey ?? ""))
      || value.conflictKey !== factUpdateConflictKeyRuntime(value.conflictSetId)
      || (expectedConflictKey !== undefined && value.conflictKey !== expectedConflictKey)
      || !Number.isInteger(value.revision) || value.revision < 0
      || !DECISION_ID.test(String(value.decisionId ?? "")) || !SHA256.test(String(value.decisionHash ?? ""))
      || value.decisionId !== `update-decision-sha256-${value.decisionHash}`
      || !SHA256.test(String(value.decisionMemoryKey ?? ""))
      || !conflictStateRef(value.selectedConflictRef, value.conflictSetId)
      || !conflictStateRef(value.previousConflictRef, value.conflictSetId)
      || same(value.selectedConflictRef, value.previousConflictRef)
      || !isIsoTimestampRuntime(value.updatedAt)
      || previousPresent !== (value.previousDecisionId !== undefined && value.previousDecisionHash !== undefined)
      || (previousPresent && (!DECISION_ID.test(String(value.previousDecisionId))
        || !SHA256.test(String(value.previousDecisionHash))
        || value.previousDecisionId !== `update-decision-sha256-${value.previousDecisionHash}`))) {
      errors.push("fact update conflict pointer authority invalid");
    }
    return errors;
  }, ["fact update conflict pointer runtime validation failed"]);
}

function conflictStaticAuthorityRuntime(value) {
  const material = { ...value };
  delete material.status;
  delete material.resolutionFactIds;
  delete material.decisionIds;
  delete material.resolvedAt;
  delete material.contentHash;
  return material;
}

export function validateFactUpdateConflictTransitionRuntime(value, decision) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "pointer", "before", "after"])
      || value.schemaVersion !== "fact-update-conflict-transition-v1") {
      return ["fact update conflict transition schema invalid"];
    }
    const errors = [...validateFactUpdateConflictPointerRuntime(value.pointer)];
    errors.push(...validateConflictSetRuntime(value.before).map((error) => `before ${error}`));
    errors.push(...validateConflictSetRuntime(value.after).map((error) => `after ${error}`));
    if (!verifyConflictSetRuntime(value.before) || !verifyConflictSetRuntime(value.after)) {
      errors.push("fact update conflict transition state content authority invalid");
    }
    const pointer = value.pointer;
    if (validateUpdateDecisionRuntime(decision).length || !verifyUpdateDecisionRuntime(decision)) {
      errors.push("fact update conflict transition decision authority invalid");
      return errors;
    }
    if (pointer.decisionId !== decision.updateDecisionId || pointer.decisionHash !== decision.contentHash
      || pointer.decisionMemoryKey !== updateDecisionMemoryKeyRuntime(decision)
      || pointer.conflictSetId !== value.before.conflictSetId || pointer.conflictSetId !== value.after.conflictSetId
      || pointer.previousConflictRef?.contentHash !== value.before.contentHash
      || pointer.selectedConflictRef?.contentHash !== value.after.contentHash
      || !same(conflictStaticAuthorityRuntime(value.before), conflictStaticAuthorityRuntime(value.after))) {
      errors.push("fact update conflict transition decision/state closure invalid");
    }
    const previousPresent = pointer.previousDecisionId !== undefined || pointer.previousDecisionHash !== undefined;
    if (decision.decision === "accept") {
      if (value.before.status !== "open" || value.after.status !== "resolved"
        || !same(value.after.resolutionFactIds, decision.newFactIds)
        || !same(value.after.decisionIds, [decision.updateDecisionId])
        || value.after.resolvedAt !== decision.decidedAt
        || !decision.oldFactIds.every((id) => value.before.factIds.includes(id))
        || !decision.newFactIds.every((id) => value.before.factIds.includes(id))
        || (pointer.revision === 0 && previousPresent) || (pointer.revision > 0 && !previousPresent)) {
        errors.push("accepted update conflict transition closure invalid");
      }
    } else if (decision.decision === "undo") {
      if (value.before.status !== "resolved" || value.after.status !== "open"
        || !decision.supersedesDecisionId || !value.before.decisionIds.includes(decision.supersedesDecisionId)
        || pointer.previousDecisionId !== decision.supersedesDecisionId
        || pointer.previousDecisionHash !== decision.supersedesDecisionHash) {
        errors.push("undo conflict transition closure invalid");
      }
    } else {
      errors.push("reject/defer cannot transition conflict lifecycle");
    }
    return errors;
  }, ["fact update conflict transition runtime validation failed"]);
}

export function verifyFactUpdateConflictTransitionRuntime(value, decision) {
  return total(() => validateFactUpdateConflictTransitionRuntime(value, decision).length === 0, false);
}

function transactionHashMaterialRuntime(value) {
  const material = structuredClone(value);
  delete material.transactionId;
  delete material.contentHash;
  return {
    domain: "fact-update-decision-transaction",
    schemaVersion: "fact-update-decision-transaction-v1",
    canonicalizationPolicyId: "canonical-json-v1",
    payload: material,
  };
}

export function transactionContentHashRuntime(value) {
  return total(() => sha256Json(transactionHashMaterialRuntime(value)), null);
}

export function validateFactUpdateDecisionTransactionRuntime(value) {
  return total(() => {
    if (!runtimeRecord(value)) return ["fact update decision transaction must be an object"];
    const errors = [];
    const keys = ["schemaVersion", "transactionId", "memoryKey", "decision", "evaluationDiffs", "conflictTransitions", "contentHash"];
    if (!exact(value, keys) || value.schemaVersion !== "fact-update-decision-transaction-v1") {
      errors.push("fact update decision transaction schema invalid");
    }
    if (!TRANSACTION_ID.test(String(value.transactionId ?? "")) || !SHA256.test(String(value.contentHash ?? ""))
      || value.transactionId !== `fact-update-transaction-sha256-${value.contentHash}`) {
      errors.push("fact update decision transaction identity invalid");
    }
    if (validateUpdateDecisionRuntime(value.decision).length || !verifyUpdateDecisionRuntime(value.decision)) {
      errors.push("fact update decision transaction decision authority invalid");
    }
    if (!SHA256.test(String(value.memoryKey ?? "")) || value.memoryKey !== updateDecisionMemoryKeyRuntime(value.decision)) {
      errors.push("fact update decision transaction memory key invalid");
    }
    if (!Array.isArray(value.evaluationDiffs)) {
      errors.push("fact update decision transaction evaluation diffs invalid");
      return errors;
    }
    const needsDiffs = value.decision?.decision === "accept" || value.decision?.decision === "undo";
    if (!needsDiffs && value.evaluationDiffs.length) errors.push("reject/defer transaction must not carry evaluation diffs");
    if (needsDiffs) {
      const planIds = value.evaluationDiffs.map((diff) => diff?.planId);
      if (value.evaluationDiffs.length !== value.decision.planIds.length || !sameStringSet(planIds, value.decision.planIds)) {
        errors.push("accept/undo transaction evaluation diff set incomplete");
      }
      if (!sortedUnique(planIds)) errors.push("fact update decision transaction diff order is non-canonical");
    }
    for (const diff of value.evaluationDiffs) errors.push(...validateFactUpdateEvaluationDiffClosureRuntime(diff, value.decision));
    if (!Array.isArray(value.conflictTransitions)) {
      errors.push("fact update decision transaction conflict transitions invalid");
      return errors;
    }
    if (!needsDiffs && value.conflictTransitions.length) errors.push("reject/defer transaction must not carry conflict transitions");
    const conflictIds = value.conflictTransitions.map((transition) => transition?.pointer?.conflictSetId);
    if (!uniqueStrings(conflictIds) && conflictIds.length) errors.push("fact update decision transaction conflict transition IDs invalid");
    if (conflictIds.length && !sortedUnique(conflictIds)) errors.push("fact update decision transaction conflict transition order is non-canonical");
    for (const transition of value.conflictTransitions) {
      errors.push(...validateFactUpdateConflictTransitionRuntime(transition, value.decision));
    }
    return errors;
  }, ["fact update decision transaction runtime validation failed"]);
}

export function verifyFactUpdateDecisionTransactionRuntime(value) {
  return total(() => validateFactUpdateDecisionTransactionRuntime(value).length === 0
    && value.contentHash === transactionContentHashRuntime(value), false);
}

function factSubjectRevisionRuntime(subject) {
  return subject.revision ?? subject.variantId ?? subject.modelId ?? subject.familyId ?? subject.skuId;
}

function factSubjectKeyRuntime(subject) {
  return total(() => sha256Json(subject), null);
}

function factLookup(facts, factId) {
  return facts instanceof Map ? facts.get(factId) : runtimeRecord(facts) ? facts[factId] : undefined;
}

/** Exact fact/snapshot/memory/domain closure shared by graph and Doctor. */
export function validateUpdateDecisionFactClosureRuntime(decision, oldSnapshot, newSnapshot, facts) {
  return total(() => {
    const errors = [];
    if (validateUpdateDecisionRuntime(decision).length || !verifyUpdateDecisionRuntime(decision)) {
      return ["update decision content authority invalid"];
    }
    const requiredDomains = requiredEvaluationDomainsForFactFieldRuntime(decision.claimKey);
    if (!requiredDomains || !same(decision.affectedDomains, requiredDomains)) errors.push("update decision affected domains are not governed by its field");
    if (!uniqueStrings(decision.oldFactIds) || !uniqueStrings(decision.newFactIds)
      || !uniqueStrings(decision.affectedDomains) || decision.fieldDiffs.length !== 1
      || decision.fieldDiffs[0]?.field !== decision.claimKey
      || !sameStringSet(decision.oldFactIds, decision.fieldDiffs[0]?.beforeFactIds)
      || !sameStringSet(decision.newFactIds, decision.fieldDiffs[0]?.afterFactIds)) {
      errors.push("update decision field diff authority is not exact");
    }
    const oldRefs = new Map((oldSnapshot?.factRefs ?? []).map((ref) => [ref.factId, ref.contentHash]));
    const newRefs = new Map((newSnapshot?.factRefs ?? []).map((ref) => [ref.factId, ref.contentHash]));
    if (decision.oldFactIds.some((id) => !oldRefs.has(id)) || decision.newFactIds.some((id) => !newRefs.has(id))) {
      errors.push("update decision fact diff is outside its snapshots");
    }
    const oldDelta = (oldSnapshot?.factRefs ?? []).filter((ref) => newRefs.get(ref.factId) !== ref.contentHash).map((ref) => ref.factId);
    const newDelta = (newSnapshot?.factRefs ?? []).filter((ref) => oldRefs.get(ref.factId) !== ref.contentHash).map((ref) => ref.factId);
    const oldConflicts = [...(oldSnapshot?.conflictRefs ?? [])].sort((left, right) => left.conflictSetId.localeCompare(right.conflictSetId));
    const newConflicts = [...(newSnapshot?.conflictRefs ?? [])].sort((left, right) => left.conflictSetId.localeCompare(right.conflictSetId));
    if (!sameStringSet(oldDelta, decision.oldFactIds) || !sameStringSet(newDelta, decision.newFactIds)
      || !same(oldConflicts, newConflicts)) errors.push("update decision snapshots contain undeclared fact or conflict changes");
    const oldFacts = decision.oldFactIds.map((id) => factLookup(facts, id));
    const newFacts = decision.newFactIds.map((id) => factLookup(facts, id));
    if (oldFacts.some((fact, index) => !fact || !verifyFactRecordRuntime(fact)
      || fact.contentHash !== oldRefs.get(decision.oldFactIds[index]))
      || newFacts.some((fact, index) => !fact || !verifyFactRecordRuntime(fact)
        || fact.contentHash !== newRefs.get(decision.newFactIds[index]))) {
      errors.push("update decision fact/snapshot hash closure invalid");
      return errors;
    }
    const joined = [...oldFacts, ...newFacts];
    const first = joined[0];
    const subjectKey = first?.subject?.kind === "product" ? factSubjectKeyRuntime(first.subject) : null;
    if (!subjectKey || joined.some((fact) => fact.subject?.kind !== "product"
      || factSubjectKeyRuntime(fact.subject) !== subjectKey || fact.field !== decision.claimKey)) {
      errors.push("update decision facts do not share one product subject and field");
      return errors;
    }
    if (decision.subjectKey !== subjectKey || decision.revision !== factSubjectRevisionRuntime(first.subject)) {
      errors.push("update decision memory identity is not derived from its facts");
    }
    if (![decision.subjectKey, decision.claimKey, decision.revision, ...decision.planIds, ...decision.oldFactIds, ...decision.newFactIds]
      .every((value) => isCanonicalUnicodeRuntime(value, 256))) errors.push("update decision string authority invalid");
    return errors;
  }, ["update decision fact closure runtime validation failed"]);
}
