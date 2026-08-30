import { HASH_SPEC_VERSION, isSha256Hex } from "../hash";
import { sha256Json } from "../runtime/fs.mjs";
import type { FactSnapshotRef, UpdateDecision } from "./contracts";
import { factFieldPolicy, type FactSafetyClass } from "./field-registry";
import {
  requiredEvaluationDomainsForFactField,
  type FactUpdateEvaluationDomain,
} from "./update-evaluation";

export const FACT_UPDATE_NOTICE_SCHEMA_VERSION = "fact-update-notice-v1" as const;

export const FACT_UPDATE_NOTICE_HASH_AUTHORITY = Object.freeze({
  hashSpecVersion: HASH_SPEC_VERSION,
  algorithm: "sha256",
  canonicalizationPolicyId: "canonical-json-v1",
  domain: "fact-update-notice",
} as const);

export type FactUpdateNoticePlanTarget =
  | { kind: "draft"; expectedDraftRevision: number; expectedConfigHash: string }
  | { kind: "version"; versionId: string; expectedConfigHash?: string };

export interface FactUpdateSafetyWarning {
  safetyClass: FactSafetyClass;
  warningCode: "fact_update" | "compatibility_critical_fact_update" | "electrical_safety_fact_update";
  confirmationRequired: true;
}

export interface FactUpdateNotice {
  schemaVersion: typeof FACT_UPDATE_NOTICE_SCHEMA_VERSION;
  hashSpecVersion: typeof HASH_SPEC_VERSION;
  hashAlgorithm: "sha256";
  canonicalizationPolicyId: "canonical-json-v1";
  updateNoticeId: string;
  sourceHash: string;
  planId: string;
  target: FactUpdateNoticePlanTarget;
  subjectKey: string;
  claimKey: string;
  revision: string;
  expectedMemoryRevision: number;
  memoryRevision: number;
  previousDecisionRef?: { updateDecisionId: string; contentHash: string };
  oldSnapshotRef: UpdateDecision["oldSnapshotRef"];
  newSnapshotRef: UpdateDecision["newSnapshotRef"];
  oldFactRefs: FactSnapshotRef[];
  newFactRefs: FactSnapshotRef[];
  affectedDomains: FactUpdateEvaluationDomain[];
  safetyWarning: FactUpdateSafetyWarning;
  createdAt: string;
  contentHash: string;
}

export type FactUpdateNoticeInput = Omit<FactUpdateNotice,
  | "schemaVersion"
  | "hashSpecVersion"
  | "hashAlgorithm"
  | "canonicalizationPolicyId"
  | "updateNoticeId"
  | "sourceHash"
  | "safetyWarning"
  | "contentHash"
>;

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SNAPSHOT_ID = /^fact-snapshot-sha256-[a-f0-9]{64}$/;
const NOTICE_ID = /^fact-update-notice-sha256-[a-f0-9]{64}$/;
const DECISION_ID = /^update-decision-sha256-[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key))
    && keys.length === required.length + optional.filter((key) => keys.includes(key)).length;
}

function canonicalString(value: unknown, maxLength = 256): value is string {
  if (typeof value !== "string" || !value || value.length > maxLength || value !== value.normalize("NFC")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function same(left: unknown, right: unknown): boolean {
  return sha256Json(left) === sha256Json(right);
}

function sortedUniqueStrings(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function validateSnapshotRef(value: unknown, label: string): string[] {
  if (!record(value) || !exactKeys(value, ["snapshotId", "contentHash"])
    || typeof value.snapshotId !== "string" || !SNAPSHOT_ID.test(value.snapshotId)
    || !isSha256Hex(value.contentHash)
    || value.snapshotId !== `fact-snapshot-sha256-${String(value.contentHash)}`) {
    return [`fact update notice ${label} invalid`];
  }
  return [];
}

function validateFactRefs(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) return [`fact update notice ${label} invalid`];
  const errors: string[] = [];
  const ids: string[] = [];
  for (const ref of value) {
    if (!record(ref) || !exactKeys(ref, ["factId", "contentHash"])
      || !canonicalString(ref.factId) || !isSha256Hex(ref.contentHash)) {
      errors.push(`fact update notice ${label} invalid`);
      continue;
    }
    ids.push(ref.factId);
  }
  if (new Set(ids).size !== ids.length || !sortedUniqueStrings(ids)) errors.push(`fact update notice ${label} must be sorted and unique`);
  return errors;
}

export function validateFactUpdateNoticePlanTarget(value: unknown): string[] {
  if (!record(value)) return ["fact update notice target invalid"];
  if (value.kind === "draft") {
    return exactKeys(value, ["kind", "expectedDraftRevision", "expectedConfigHash"])
      && Number.isInteger(value.expectedDraftRevision) && (value.expectedDraftRevision as number) >= 0
      && isSha256Hex(value.expectedConfigHash)
      ? [] : ["fact update notice draft target invalid"];
  }
  if (value.kind === "version") {
    return exactKeys(value, ["kind", "versionId"], ["expectedConfigHash"])
      && canonicalString(value.versionId) && PLAN_ID.test(value.versionId)
      && (value.expectedConfigHash === undefined || isSha256Hex(value.expectedConfigHash))
      ? [] : ["fact update notice version target invalid"];
  }
  return ["fact update notice target kind invalid"];
}

function warningForSafetyClass(safetyClass: FactSafetyClass): FactUpdateSafetyWarning {
  return {
    safetyClass,
    warningCode: safetyClass === "electrical_safety" ? "electrical_safety_fact_update"
      : safetyClass === "compatibility_critical" ? "compatibility_critical_fact_update" : "fact_update",
    confirmationRequired: true,
  };
}

function sourceMaterial(value: FactUpdateNoticeInput | FactUpdateNotice): unknown {
  return {
    planId: value.planId,
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

export function factUpdateNoticeSourceHash(value: FactUpdateNoticeInput | FactUpdateNotice): string {
  return sha256Json({
    domain: "fact-update-notice-source",
    schemaVersion: FACT_UPDATE_NOTICE_SCHEMA_VERSION,
    canonicalizationPolicyId: "canonical-json-v1",
    payload: sourceMaterial(value),
  });
}

function hashMaterial(value: FactUpdateNoticeInput | FactUpdateNotice): unknown {
  const material = structuredClone(value) as Partial<FactUpdateNotice>;
  delete material.schemaVersion;
  delete material.hashSpecVersion;
  delete material.hashAlgorithm;
  delete material.canonicalizationPolicyId;
  delete material.updateNoticeId;
  delete material.contentHash;
  return {
    ...FACT_UPDATE_NOTICE_HASH_AUTHORITY,
    schemaVersion: FACT_UPDATE_NOTICE_SCHEMA_VERSION,
    payload: material,
  };
}

export function factUpdateNoticeContentHash(value: FactUpdateNoticeInput | FactUpdateNotice): string {
  return sha256Json(hashMaterial(value));
}

export function validateFactUpdateNotice(value: unknown): string[] {
  if (!record(value)) return ["fact update notice must be an object"];
  const required = [
    "schemaVersion", "hashSpecVersion", "hashAlgorithm", "canonicalizationPolicyId", "updateNoticeId", "sourceHash",
    "planId", "target", "subjectKey", "claimKey", "revision", "expectedMemoryRevision", "memoryRevision",
    "oldSnapshotRef", "newSnapshotRef", "oldFactRefs", "newFactRefs", "affectedDomains", "safetyWarning",
    "createdAt", "contentHash",
  ];
  const errors: string[] = [];
  if (!exactKeys(value, required, ["previousDecisionRef"])) errors.push("fact update notice fields invalid");
  if (value.schemaVersion !== FACT_UPDATE_NOTICE_SCHEMA_VERSION
    || value.hashSpecVersion !== HASH_SPEC_VERSION
    || value.hashAlgorithm !== "sha256"
    || value.canonicalizationPolicyId !== "canonical-json-v1") errors.push("fact update notice hash authority invalid");
  if (typeof value.updateNoticeId !== "string" || !NOTICE_ID.test(value.updateNoticeId)
    || !isSha256Hex(value.contentHash)
    || value.updateNoticeId !== `fact-update-notice-sha256-${String(value.contentHash)}`) {
    errors.push("fact update notice content identity invalid");
  }
  if (!isSha256Hex(value.sourceHash)) errors.push("fact update notice sourceHash invalid");
  if (typeof value.planId !== "string" || !PLAN_ID.test(value.planId)) errors.push("fact update notice planId invalid");
  errors.push(...validateFactUpdateNoticePlanTarget(value.target));
  for (const field of ["subjectKey", "claimKey", "revision"] as const) {
    if (!canonicalString(value[field])) errors.push(`fact update notice ${field} invalid`);
  }
  if (!Number.isInteger(value.expectedMemoryRevision) || (value.expectedMemoryRevision as number) < -1
    || !Number.isInteger(value.memoryRevision) || (value.memoryRevision as number) < 0
    || value.memoryRevision !== (value.expectedMemoryRevision as number) + 1) {
    errors.push("fact update notice memory revision invalid");
  }
  const previous = value.previousDecisionRef;
  if (value.expectedMemoryRevision === -1 ? previous !== undefined : !record(previous)) {
    errors.push("fact update notice previous decision closure invalid");
  } else if (record(previous) && (!exactKeys(previous, ["updateDecisionId", "contentHash"])
    || typeof previous.updateDecisionId !== "string" || !DECISION_ID.test(previous.updateDecisionId)
    || !isSha256Hex(previous.contentHash)
    || previous.updateDecisionId !== `update-decision-sha256-${String(previous.contentHash)}`)) {
    errors.push("fact update notice previous decision closure invalid");
  }
  errors.push(...validateSnapshotRef(value.oldSnapshotRef, "oldSnapshotRef"));
  errors.push(...validateSnapshotRef(value.newSnapshotRef, "newSnapshotRef"));
  if (same(value.oldSnapshotRef, value.newSnapshotRef)) errors.push("fact update notice snapshots must differ");
  errors.push(...validateFactRefs(value.oldFactRefs, "oldFactRefs"));
  errors.push(...validateFactRefs(value.newFactRefs, "newFactRefs"));
  if (Array.isArray(value.oldFactRefs) && Array.isArray(value.newFactRefs)
    && same(value.oldFactRefs, value.newFactRefs)) errors.push("fact update notice fact refs must differ");
  const policy = factFieldPolicy(value.claimKey);
  if (!policy) {
    errors.push("fact update notice claimKey is not governed");
  } else {
    let requiredDomains: readonly FactUpdateEvaluationDomain[] = [];
    try { requiredDomains = requiredEvaluationDomainsForFactField(policy.fieldId); }
    catch { errors.push("fact update notice field has no evaluation-domain authority"); }
    if (!Array.isArray(value.affectedDomains)
      || value.affectedDomains.some((domain) => typeof domain !== "string")
      || !sortedUniqueStrings(value.affectedDomains as string[])
      || !same(value.affectedDomains, [...requiredDomains].sort())) {
      errors.push("fact update notice affectedDomains invalid");
    }
    if (!record(value.safetyWarning)
      || !exactKeys(value.safetyWarning, ["safetyClass", "warningCode", "confirmationRequired"])
      || !same(value.safetyWarning, warningForSafetyClass(policy.safetyClass))) {
      errors.push("fact update notice safety warning invalid");
    }
  }
  if (!isoTimestamp(value.createdAt)) errors.push("fact update notice createdAt invalid");
  return errors;
}

export function verifyFactUpdateNotice(value: unknown): boolean {
  if (validateFactUpdateNotice(value).length) return false;
  const notice = value as FactUpdateNotice;
  return notice.sourceHash === factUpdateNoticeSourceHash(notice)
    && notice.contentHash === factUpdateNoticeContentHash(notice)
    && notice.updateNoticeId === `fact-update-notice-sha256-${notice.contentHash}`;
}

export function createFactUpdateNotice(input: FactUpdateNoticeInput): FactUpdateNotice {
  const policy = factFieldPolicy(input.claimKey);
  if (!policy) throw new TypeError(`fact update notice field is not governed: ${input.claimKey}`);
  const canonicalInput: FactUpdateNoticeInput = {
    ...structuredClone(input),
    oldFactRefs: [...input.oldFactRefs].sort((left, right) => left.factId.localeCompare(right.factId)),
    newFactRefs: [...input.newFactRefs].sort((left, right) => left.factId.localeCompare(right.factId)),
    affectedDomains: [...input.affectedDomains].sort(),
  };
  const material = {
    schemaVersion: FACT_UPDATE_NOTICE_SCHEMA_VERSION,
    hashSpecVersion: HASH_SPEC_VERSION,
    hashAlgorithm: "sha256" as const,
    canonicalizationPolicyId: "canonical-json-v1" as const,
    sourceHash: factUpdateNoticeSourceHash(canonicalInput),
    ...canonicalInput,
    safetyWarning: warningForSafetyClass(policy.safetyClass),
  };
  const contentHash = factUpdateNoticeContentHash(material as FactUpdateNoticeInput & typeof material);
  const notice: FactUpdateNotice = Object.freeze({
    ...material,
    updateNoticeId: `fact-update-notice-sha256-${contentHash}`,
    contentHash,
  });
  const errors = validateFactUpdateNotice(notice);
  if (errors.length || !verifyFactUpdateNotice(notice)) throw new TypeError(`Invalid FactUpdateNotice: ${errors.join("; ")}`);
  return notice;
}
