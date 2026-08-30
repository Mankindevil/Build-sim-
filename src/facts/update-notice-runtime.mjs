import { sha256Json } from "../runtime/fs.mjs";
import {
  FACT_FIELD_POLICY_RUNTIME,
  isCanonicalUnicodeRuntime,
  isIsoTimestampRuntime,
  runtimeRecord,
  verifyFactRecordRuntime,
  verifyFactSnapshotRuntime,
} from "./canonical-runtime.mjs";
import { requiredEvaluationDomainsForFactFieldRuntime } from "./update-evaluation-runtime.mjs";

export const FACT_UPDATE_NOTICE_SCHEMA_VERSION_RUNTIME = "fact-update-notice-v1";
export const FACT_UPDATE_NOTICE_HASH_AUTHORITY_RUNTIME = Object.freeze({
  hashSpecVersion: "hash-spec-v1",
  algorithm: "sha256",
  canonicalizationPolicyId: "canonical-json-v1",
  domain: "fact-update-notice",
});

const SHA256 = /^[a-f0-9]{64}$/;
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SNAPSHOT_ID = /^fact-snapshot-sha256-[a-f0-9]{64}$/;
const NOTICE_ID = /^fact-update-notice-sha256-[a-f0-9]{64}$/;
const DECISION_ID = /^update-decision-sha256-[a-f0-9]{64}$/;

function total(operation, fallback) {
  try { return operation(); } catch { return fallback; }
}

function exact(value, required, optional = []) {
  if (!runtimeRecord(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key))
    && keys.length === required.length + optional.filter((key) => keys.includes(key)).length;
}

function same(left, right) {
  return total(() => sha256Json(left) === sha256Json(right), false);
}

function sortedUnique(values) {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

function validateTarget(value) {
  if (value?.kind === "draft") {
    return exact(value, ["kind", "expectedDraftRevision", "expectedConfigHash"])
      && Number.isInteger(value.expectedDraftRevision) && value.expectedDraftRevision >= 0 && SHA256.test(value.expectedConfigHash)
      ? [] : ["fact update notice draft target invalid"];
  }
  if (value?.kind === "version") {
    return exact(value, ["kind", "versionId"], ["expectedConfigHash"])
      && typeof value.versionId === "string" && PLAN_ID.test(value.versionId)
      && (value.expectedConfigHash === undefined || SHA256.test(value.expectedConfigHash))
      ? [] : ["fact update notice version target invalid"];
  }
  return ["fact update notice target kind invalid"];
}

function validateSnapshotRef(value, label) {
  return exact(value, ["snapshotId", "contentHash"])
    && typeof value.snapshotId === "string" && SNAPSHOT_ID.test(value.snapshotId)
    && SHA256.test(value.contentHash) && value.snapshotId === `fact-snapshot-sha256-${value.contentHash}`
    ? [] : [`fact update notice ${label} invalid`];
}

function validateFactRefs(value, label) {
  if (!Array.isArray(value) || value.length === 0) return [`fact update notice ${label} invalid`];
  const errors = [];
  const ids = [];
  for (const ref of value) {
    if (!exact(ref, ["factId", "contentHash"]) || !isCanonicalUnicodeRuntime(ref.factId, 256) || !SHA256.test(ref.contentHash)) {
      errors.push(`fact update notice ${label} invalid`);
      continue;
    }
    ids.push(ref.factId);
  }
  if (new Set(ids).size !== ids.length || !sortedUnique(ids)) errors.push(`fact update notice ${label} must be sorted and unique`);
  return errors;
}

function warningFor(policy) {
  return {
    safetyClass: policy.safetyClass,
    warningCode: policy.safetyClass === "electrical_safety" ? "electrical_safety_fact_update"
      : policy.safetyClass === "compatibility_critical" ? "compatibility_critical_fact_update" : "fact_update",
    confirmationRequired: true,
  };
}

function sourceMaterial(value) {
  return {
    planId: structuredClone(value.planId),
    target: structuredClone(value.target),
    subjectKey: value.subjectKey,
    claimKey: value.claimKey,
    revision: value.revision,
    expectedMemoryRevision: value.expectedMemoryRevision,
    memoryRevision: value.memoryRevision,
    ...(value.previousDecisionRef ? { previousDecisionRef: structuredClone(value.previousDecisionRef) } : {}),
    oldSnapshotRef: structuredClone(value.oldSnapshotRef),
    oldFactRefs: structuredClone(value.oldFactRefs),
    newFactRefs: structuredClone(value.newFactRefs),
    affectedDomains: [...value.affectedDomains],
  };
}

export function factUpdateNoticeSourceHashRuntime(value) {
  return total(() => sha256Json({
    domain: "fact-update-notice-source",
    schemaVersion: FACT_UPDATE_NOTICE_SCHEMA_VERSION_RUNTIME,
    canonicalizationPolicyId: "canonical-json-v1",
    payload: sourceMaterial(value),
  }), "");
}

function hashMaterial(value) {
  const material = structuredClone(value);
  delete material.schemaVersion;
  delete material.hashSpecVersion;
  delete material.hashAlgorithm;
  delete material.canonicalizationPolicyId;
  delete material.updateNoticeId;
  delete material.contentHash;
  return {
    ...FACT_UPDATE_NOTICE_HASH_AUTHORITY_RUNTIME,
    schemaVersion: FACT_UPDATE_NOTICE_SCHEMA_VERSION_RUNTIME,
    payload: material,
  };
}

export function factUpdateNoticeContentHashRuntime(value) {
  return total(() => sha256Json(hashMaterial(value)), "");
}

export function validateFactUpdateNoticeRuntime(value) {
  return total(() => {
    if (!runtimeRecord(value)) return ["fact update notice must be an object"];
    const required = [
      "schemaVersion", "hashSpecVersion", "hashAlgorithm", "canonicalizationPolicyId", "updateNoticeId", "sourceHash",
      "planId", "target", "subjectKey", "claimKey", "revision", "expectedMemoryRevision", "memoryRevision",
      "oldSnapshotRef", "newSnapshotRef", "oldFactRefs", "newFactRefs", "affectedDomains", "safetyWarning",
      "createdAt", "contentHash",
    ];
    const errors = [];
    if (!exact(value, required, ["previousDecisionRef"])) errors.push("fact update notice fields invalid");
    if (value.schemaVersion !== FACT_UPDATE_NOTICE_SCHEMA_VERSION_RUNTIME || value.hashSpecVersion !== "hash-spec-v1"
      || value.hashAlgorithm !== "sha256" || value.canonicalizationPolicyId !== "canonical-json-v1") {
      errors.push("fact update notice hash authority invalid");
    }
    if (typeof value.updateNoticeId !== "string" || !NOTICE_ID.test(value.updateNoticeId)
      || !SHA256.test(value.contentHash) || value.updateNoticeId !== `fact-update-notice-sha256-${value.contentHash}`) {
      errors.push("fact update notice content identity invalid");
    }
    if (!SHA256.test(value.sourceHash)) errors.push("fact update notice sourceHash invalid");
    if (typeof value.planId !== "string" || !PLAN_ID.test(value.planId)) errors.push("fact update notice planId invalid");
    errors.push(...validateTarget(value.target));
    for (const field of ["subjectKey", "claimKey", "revision"]) {
      if (!isCanonicalUnicodeRuntime(value[field], 256)) errors.push(`fact update notice ${field} invalid`);
    }
    if (!Number.isInteger(value.expectedMemoryRevision) || value.expectedMemoryRevision < -1
      || !Number.isInteger(value.memoryRevision) || value.memoryRevision < 0
      || value.memoryRevision !== value.expectedMemoryRevision + 1) errors.push("fact update notice memory revision invalid");
    const previous = value.previousDecisionRef;
    if (value.expectedMemoryRevision === -1 ? previous !== undefined : !runtimeRecord(previous)) {
      errors.push("fact update notice previous decision closure invalid");
    } else if (runtimeRecord(previous) && (!exact(previous, ["updateDecisionId", "contentHash"])
      || typeof previous.updateDecisionId !== "string" || !DECISION_ID.test(previous.updateDecisionId)
      || !SHA256.test(previous.contentHash) || previous.updateDecisionId !== `update-decision-sha256-${previous.contentHash}`)) {
      errors.push("fact update notice previous decision closure invalid");
    }
    errors.push(...validateSnapshotRef(value.oldSnapshotRef, "oldSnapshotRef"));
    errors.push(...validateSnapshotRef(value.newSnapshotRef, "newSnapshotRef"));
    if (same(value.oldSnapshotRef, value.newSnapshotRef)) errors.push("fact update notice snapshots must differ");
    errors.push(...validateFactRefs(value.oldFactRefs, "oldFactRefs"));
    errors.push(...validateFactRefs(value.newFactRefs, "newFactRefs"));
    if (same(value.oldFactRefs, value.newFactRefs)) errors.push("fact update notice fact refs must differ");
    const policy = FACT_FIELD_POLICY_RUNTIME[value.claimKey];
    if (!policy) {
      errors.push("fact update notice claimKey is not governed");
    } else {
      const domains = requiredEvaluationDomainsForFactFieldRuntime(value.claimKey);
      if (!domains || !Array.isArray(value.affectedDomains) || !sortedUnique(value.affectedDomains)
        || !same(value.affectedDomains, [...domains].sort())) errors.push("fact update notice affectedDomains invalid");
      if (!exact(value.safetyWarning, ["safetyClass", "warningCode", "confirmationRequired"])
        || !same(value.safetyWarning, warningFor(policy))) errors.push("fact update notice safety warning invalid");
    }
    if (!isIsoTimestampRuntime(value.createdAt)) errors.push("fact update notice createdAt invalid");
    return errors;
  }, ["fact update notice validation threw"]);
}

export function verifyFactUpdateNoticeRuntime(value) {
  return total(() => validateFactUpdateNoticeRuntime(value).length === 0
    && value.sourceHash === factUpdateNoticeSourceHashRuntime(value)
    && value.contentHash === factUpdateNoticeContentHashRuntime(value)
    && value.updateNoticeId === `fact-update-notice-sha256-${value.contentHash}`, false);
}

function factLookup(facts, factId) {
  return facts instanceof Map ? facts.get(factId) : runtimeRecord(facts) ? facts[factId] : undefined;
}

/** Exact persisted notice -> snapshot/fact closure shared by graph and Doctor. */
export function validateFactUpdateNoticeClosureRuntime(notice, oldSnapshot, newSnapshot, facts) {
  return total(() => {
    const errors = [];
    if (!verifyFactUpdateNoticeRuntime(notice)) return ["fact update notice content authority invalid"];
    if (!verifyFactSnapshotRuntime(oldSnapshot) || !verifyFactSnapshotRuntime(newSnapshot)
      || oldSnapshot.snapshotId !== notice.oldSnapshotRef.snapshotId
      || oldSnapshot.contentHash !== notice.oldSnapshotRef.contentHash
      || newSnapshot.snapshotId !== notice.newSnapshotRef.snapshotId
      || newSnapshot.contentHash !== notice.newSnapshotRef.contentHash) {
      return ["fact update notice snapshot authority is missing or mismatched"];
    }
    const oldRefs = new Map(oldSnapshot.factRefs.map((ref) => [ref.factId, ref.contentHash]));
    const newRefs = new Map(newSnapshot.factRefs.map((ref) => [ref.factId, ref.contentHash]));
    const oldDelta = oldSnapshot.factRefs.filter((ref) => newRefs.get(ref.factId) !== ref.contentHash)
      .sort((left, right) => left.factId.localeCompare(right.factId));
    const newDelta = newSnapshot.factRefs.filter((ref) => oldRefs.get(ref.factId) !== ref.contentHash)
      .sort((left, right) => left.factId.localeCompare(right.factId));
    const oldConflicts = [...oldSnapshot.conflictRefs].sort((left, right) => left.conflictSetId.localeCompare(right.conflictSetId));
    const newConflicts = [...newSnapshot.conflictRefs].sort((left, right) => left.conflictSetId.localeCompare(right.conflictSetId));
    if (!same(oldDelta, notice.oldFactRefs) || !same(newDelta, notice.newFactRefs)
      || !same(oldConflicts, newConflicts)) {
      errors.push("fact update notice snapshot delta authority is not exact");
    }
    const joined = [...notice.oldFactRefs, ...notice.newFactRefs].map((ref) => ({ ref, fact: factLookup(facts, ref.factId) }));
    if (joined.some(({ ref, fact }) => !fact || !verifyFactRecordRuntime(fact) || fact.contentHash !== ref.contentHash)) {
      errors.push("fact update notice fact hash closure is missing or mismatched");
      return errors;
    }
    const first = joined[0]?.fact;
    const subjectKey = first?.subject?.kind === "product" ? sha256Json(first.subject) : null;
    const revision = first?.subject?.kind === "product"
      ? first.subject.revision ?? first.subject.variantId ?? first.subject.modelId ?? first.subject.familyId ?? first.subject.skuId
      : null;
    if (!subjectKey || joined.some(({ fact }) => fact.subject?.kind !== "product"
      || sha256Json(fact.subject) !== subjectKey || fact.field !== notice.claimKey)
      || notice.subjectKey !== subjectKey || notice.revision !== revision) {
      errors.push("fact update notice product subject/field authority is invalid");
    }
    return errors;
  }, ["fact update notice closure runtime validation failed"]);
}
