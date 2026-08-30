import type { EvaluationDecision } from "../requirements/contracts";
import { isSha256Hex } from "../hash";
import { validateObservationSubjectRef, type ObservationSubjectRef } from "../observations/contracts";
import {
  factFieldPolicy,
  validateFactFieldValue,
  type FactAuthority,
  type FactSafetyClass,
  type FactScope,
} from "./field-registry";

export type FactSubject =
  | { kind: "product"; skuId: string; revision?: string; region?: string; familyId?: string; modelId?: string; variantId?: string }
  | { kind: "plan_subject"; planId: string; subjectRef: ObservationSubjectRef };

export interface FactRecord {
  schemaVersion: "fact-record-v1";
  factId: string;
  subject: FactSubject;
  field: string;
  value: unknown;
  unit?: string;
  scope: FactScope;
  authority: FactAuthority;
  safetyClass: FactSafetyClass;
  status: "active" | "superseded" | "conflicted" | "unresolved_blocker";
  evidenceRefs: string[];
  derivedFromFactIds: string[];
  inferenceTraceId?: string;
  extractorOrRuleVersion?: string;
  assumptions?: string[];
  confidence: number;
  retrievedAt: string;
  validFrom?: string;
  validUntil?: string;
  supersedesFactId?: string;
  supersededFactHash?: string;
  contentHash: string;
}

/** Explicit U0 compatibility shape. It is never accepted by the governed validator. */
export type LegacyFactRecord = Omit<FactRecord,
  "schemaVersion" | "validUntil" | "supersededFactHash" | "contentHash"
>;

export interface LegacyFactSnapshot {
  schemaVersion: "fact-snapshot-v1";
  snapshotId: string;
  factIds: string[];
  conflictSetIds: string[];
  createdAt: string;
  contentHash: string;
}

export interface FactSnapshotRef {
  factId: string;
  contentHash: string;
}

export interface FactConflictRef {
  conflictSetId: string;
  contentHash: string;
}

export interface FactSnapshot {
  schemaVersion: "fact-snapshot-v2";
  snapshotId: string;
  factRefs: FactSnapshotRef[];
  conflictRefs: FactConflictRef[];
  createdAt: string;
  contentHash: string;
}

export interface ConflictSet {
  schemaVersion: "fact-conflict-v1";
  conflictSetId: string;
  subject: FactSubject;
  field: string;
  factIds: string[];
  reason: "official_internal" | "official_vs_third_party" | "revision" | "region" | "value_disagreement";
  status: "open" | "resolved";
  resolutionFactIds: string[];
  decisionIds: string[];
  createdAt: string;
  resolvedAt?: string;
  contentHash: string;
}

export interface IdentityResolution {
  identityResolutionId: string;
  subjectText: string;
  status: "resolved" | "ambiguous" | "unresolved";
  scope: "family" | "model" | "variant" | "revision";
  resolvedSkuId?: string;
  /** Exact claim-derived identity at the requested scope. Never caller shorthand. */
  resolvedSubject?: Extract<FactSubject, { kind: "product" }>;
  candidateSkuIds: string[];
  identityClaimIds: string[];
  unresolvedFieldIds: string[];
  evaluatedAt: string;
}

export interface FactFieldDiff {
  field: string;
  beforeFactIds: string[];
  afterFactIds: string[];
}

export interface UpdateDecision {
  schemaVersion: "fact-update-decision-v1";
  updateDecisionId: string;
  subjectKey: string;
  claimKey: string;
  revision: string;
  memoryRevision: number;
  planIds: string[];
  oldSnapshotRef: { snapshotId: string; contentHash: string };
  newSnapshotRef: { snapshotId: string; contentHash: string };
  oldFactIds: string[];
  newFactIds: string[];
  fieldDiffs: FactFieldDiff[];
  affectedDomains: EvaluationDecision["domain"][];
  decision: "accept" | "reject" | "defer" | "undo";
  decidedBy: "user";
  decidedAt: string;
  supersedesDecisionId?: string;
  supersedesDecisionHash?: string;
  safetyWarningRetained: boolean;
  contentHash: string;
}

export interface InferenceTrace {
  inferenceTraceId: string;
  inputFactIds: string[];
  outputFactIds: string[];
  engine: "rule" | "model";
  ruleOrModelId: string;
  ruleOrModelVersion: string;
  assumptions: string[];
  confidence: number;
  outputRange?: { min: number; max: number; unit?: string };
  invalidationConditions: string[];
  createdAt: string;
}

export type EvidenceSearchReason =
  | "official_not_published"
  | "official_page_found_field_missing"
  | "official_identity_unresolved"
  | "official_access_blocked"
  | "official_parse_failed"
  | "official_sources_conflict"
  | "official_search_exhausted";

export interface EvidenceSearchOutcome {
  searchOutcomeId: string;
  subject: FactSubject;
  field: string;
  reason: EvidenceSearchReason;
  officialEvidenceRefs: string[];
  thirdPartyEvidenceRefs: string[];
  searchAttemptRefs: string[];
  exhaustive: boolean;
  searchedAt: string;
}

export interface SafetyFactPassContext {
  identityResolution: IdentityResolution;
  activeConflictFactIds: ReadonlySet<string>;
  contentHashVerified?: boolean;
  evidenceClaimsVerified?: boolean;
  observationValidated?: boolean;
  observationHasRequiredUncertainty?: boolean;
}

export const CRITICAL_FACT_MIN_CONFIDENCE = 0.95;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isCanonicalUnicode(value: unknown, maxLength = 512): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value !== value.normalize("NFC")) return false;
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isKnownFactValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0 && !["unknown", "unresolved", "not_known"].includes(value.trim().toLowerCase());
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0 && value.every(isKnownFactValue);
  if (isRecord(value)) {
    if (value.status === "unknown" || value.status === "unresolved") return false;
    return Object.keys(value).length > 0 && Object.values(value).every(isKnownFactValue);
  }
  return typeof value === "boolean";
}

function isFiniteCanonicalJson(value: unknown, depth = 0): boolean {
  if (depth > 16 || value === undefined) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return isCanonicalUnicode(value, 4096);
  if (Array.isArray(value)) return value.length <= 1024 && value.every((item) => isFiniteCanonicalJson(item, depth + 1));
  if (!isRecord(value) || Object.keys(value).length > 256) return false;
  return Object.entries(value).every(([key, item]) => isCanonicalUnicode(key, 256) && isFiniteCanonicalJson(item, depth + 1));
}

function validateFactSubject(value: unknown): string[] {
  if (!isRecord(value)) return ["subject invalid"];
  if (value.kind === "plan_subject") {
    const errors: string[] = [];
    if (!hasOnlyKeys(value, ["kind", "planId", "subjectRef"]) || !isNonEmptyString(value.planId)) errors.push("plan subject invalid");
    errors.push(...validateObservationSubjectRef(value.subjectRef).map((error) => `plan subject ${error}`));
    return errors;
  }
  if (value.kind === "product") {
    const errors: string[] = [];
    if (!hasOnlyKeys(value, ["kind", "skuId", "revision", "region", "familyId", "modelId", "variantId"]) || !isNonEmptyString(value.skuId)) errors.push("product subject invalid");
    for (const optional of ["revision", "region", "familyId", "modelId", "variantId"] as const) if (value[optional] !== undefined && !isNonEmptyString(value[optional])) errors.push(`product subject ${optional} invalid`);
    return errors;
  }
  return ["subject kind invalid"];
}

export function validateLegacyFactRecord(value: unknown): string[] {
  if (!isRecord(value)) return ["fact must be an object"];
  const errors: string[] = [];
  const allowed = [
    "factId", "subject", "field", "value", "unit", "scope", "authority", "safetyClass", "status", "evidenceRefs",
    "derivedFromFactIds", "extractorOrRuleVersion", "assumptions", "confidence", "retrievedAt", "validFrom", "supersedesFactId",
  ];
  if (!hasOnlyKeys(value, allowed)) errors.push("fact contains unknown fields");
  for (const field of ["factId", "field", "retrievedAt"] as const) if (typeof value[field] !== "string" || value[field].length === 0) errors.push(`${field} missing`);
  if (!("value" in value)) errors.push("fact value missing");
  if (value.unit !== undefined && !isNonEmptyString(value.unit)) errors.push("fact unit invalid");
  if (!["family", "model", "variant", "revision", "plan_subject"].includes(String(value.scope))) errors.push("fact scope invalid");
  if (!["official", "third_party", "user_observation", "agent_inference"].includes(String(value.authority))) errors.push("fact authority invalid");
  if (!["normal", "compatibility_critical", "electrical_safety"].includes(String(value.safetyClass))) errors.push("fact safetyClass invalid");
  if (!["active", "superseded", "conflicted", "unresolved_blocker"].includes(String(value.status))) errors.push("fact status invalid");
  if (!isStringArray(value.evidenceRefs) || !isStringArray(value.derivedFromFactIds)) errors.push("fact evidence/derivation refs invalid");
  if (value.assumptions !== undefined && !isStringArray(value.assumptions)) errors.push("fact assumptions invalid");
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) errors.push("confidence must be between 0 and 1");
  errors.push(...validateFactSubject(value.subject));
  if (!isRecord(value.subject)) {
    // Subject shape is reported by validateFactSubject.
  }
  else if (value.subject.kind === "plan_subject") {
    if (value.scope !== "plan_subject") errors.push("plan subject facts must use plan_subject scope");
  } else if (value.subject.kind === "product") {
    if (value.scope === "plan_subject") errors.push("product fact cannot use plan_subject scope");
    if (value.authority === "user_observation") errors.push("user observation cannot become a global product fact");
  }
  if (value.authority === "user_observation" && (!isRecord(value.subject) || value.subject.kind !== "plan_subject" || value.scope !== "plan_subject")) errors.push("user observation facts must be plan_subject scoped");
  if (value.authority === "agent_inference" && (!Array.isArray(value.derivedFromFactIds) || value.derivedFromFactIds.length === 0 || typeof value.extractorOrRuleVersion !== "string" || !Array.isArray(value.assumptions))) errors.push("agent inference must be replayable from facts, version and assumptions");
  if (value.supersedesFactId !== undefined) {
    if (!isNonEmptyString(value.supersedesFactId)) errors.push("supersedesFactId invalid");
    if (value.status !== "active") errors.push("only an active replacement fact may declare supersedesFactId");
    if (value.supersedesFactId === value.factId) errors.push("fact cannot supersede itself");
  }
  return errors;
}

function validateGovernedFactSubject(value: unknown): string[] {
  const errors = validateFactSubject(value);
  if (!isRecord(value)) return errors;
  for (const [key, item] of Object.entries(value)) {
    if (key === "subjectRef" || key === "kind") continue;
    if (!isCanonicalUnicode(item, 256)) errors.push(`subject ${key} must be canonical Unicode`);
  }
  if (isRecord(value.subjectRef)) for (const [key, item] of Object.entries(value.subjectRef)) {
    if (key !== "kind" && !isCanonicalUnicode(item, 256)) errors.push(`subjectRef.${key} must be canonical Unicode`);
  }
  return errors;
}

/** Default active-authority validator. Free-form U0 records require validateLegacyFactRecord explicitly. */
export function validateFactRecord(value: unknown): string[] {
  if (!isRecord(value)) return ["fact must be an object"];
  const errors: string[] = [];
  const allowed = [
    "schemaVersion", "factId", "subject", "field", "value", "unit", "scope", "authority", "safetyClass", "status",
    "evidenceRefs", "derivedFromFactIds", "inferenceTraceId", "extractorOrRuleVersion", "assumptions", "confidence", "retrievedAt", "validFrom",
    "validUntil", "supersedesFactId", "supersededFactHash", "contentHash",
  ];
  if (!hasOnlyKeys(value, allowed)) errors.push("fact contains unknown fields");
  if (value.schemaVersion !== "fact-record-v1") errors.push("fact schemaVersion invalid");
  if (!isCanonicalUnicode(value.factId, 256)) errors.push("factId invalid");
  if (!isCanonicalUnicode(value.field, 256)) errors.push("fact field invalid");
  const policy = factFieldPolicy(value.field);
  if (!policy) errors.push("fact field is not governed");
  if (!Object.prototype.hasOwnProperty.call(value, "value")) errors.push("fact value missing");
  else if (!isFiniteCanonicalJson(value.value)) errors.push("fact value must be finite canonical JSON");
  if (policy) {
    errors.push(...validateFactFieldValue(policy, value.value, value.unit));
    if (value.safetyClass !== policy.safetyClass) errors.push("fact safetyClass must be derived from field policy");
    if (!policy.allowedScopes.includes(value.scope as FactScope)) errors.push("fact scope is not allowed by field policy");
    if (value.authority === "user_observation" && !policy.userObservationPassAllowed) errors.push("field policy forbids user observation authority");
  }
  if (!["family", "model", "variant", "revision", "plan_subject"].includes(String(value.scope))) errors.push("fact scope invalid");
  if (!["official", "third_party", "user_observation", "agent_inference"].includes(String(value.authority))) errors.push("fact authority invalid");
  if (!["normal", "compatibility_critical", "electrical_safety"].includes(String(value.safetyClass))) errors.push("fact safetyClass invalid");
  if (!["active", "superseded", "conflicted", "unresolved_blocker"].includes(String(value.status))) errors.push("fact status invalid");
  errors.push(...validateGovernedFactSubject(value.subject));
  if (isRecord(value.subject) && value.subject.kind === "plan_subject") {
    if (value.scope !== "plan_subject") errors.push("plan subject facts must use plan_subject scope");
    if (value.authority !== "user_observation" && value.authority !== "agent_inference") errors.push("plan subject fact authority invalid");
  } else if (isRecord(value.subject) && value.subject.kind === "product") {
    if (value.scope === "plan_subject") errors.push("product fact cannot use plan_subject scope");
    if (value.authority === "user_observation") errors.push("user observation cannot become a global product fact");
    if (value.scope === "revision" && !isCanonicalUnicode(value.subject.revision, 256)) errors.push("revision-scoped fact requires exact revision");
    if ((value.scope === "variant" || value.scope === "revision") && !isCanonicalUnicode(value.subject.skuId, 256)) errors.push("variant/revision fact requires exact SKU");
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((ref) => !isCanonicalUnicode(ref, 256)) || new Set(value.evidenceRefs).size !== value.evidenceRefs.length) errors.push("fact evidence refs invalid");
  if (!isStringArray(value.derivedFromFactIds) || new Set(value.derivedFromFactIds).size !== value.derivedFromFactIds.length) errors.push("fact derivation refs invalid");
  if (value.assumptions !== undefined && (!isStringArray(value.assumptions) || value.assumptions.some((item) => !isCanonicalUnicode(item, 1024)))) errors.push("fact assumptions invalid");
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) errors.push("confidence must be between 0 and 1");
  if (!isIsoTimestamp(value.retrievedAt)) errors.push("fact retrievedAt invalid");
  if (value.validFrom !== undefined && !isIsoTimestamp(value.validFrom)) errors.push("fact validFrom invalid");
  if (value.validUntil !== undefined && !isIsoTimestamp(value.validUntil)) errors.push("fact validUntil invalid");
  if (isIsoTimestamp(value.validFrom) && isIsoTimestamp(value.validUntil) && Date.parse(value.validUntil) < Date.parse(value.validFrom)) errors.push("fact validity interval invalid");
  if (!isSha256Hex(value.contentHash)) errors.push("fact contentHash invalid");
  const evidence = Array.isArray(value.evidenceRefs) ? value.evidenceRefs : [];
  if (value.authority === "official" || value.authority === "third_party") {
    if (evidence.length === 0 || evidence.some((ref) => !/^claim-sha256-[a-f0-9]{64}$/.test(String(ref)))) errors.push("source fact requires content-addressed evidence claims");
  }
  if (value.authority === "user_observation") {
    if (evidence.length === 0 || evidence.some((ref) => !/^observation:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/.test(String(ref)))) errors.push("user observation fact requires content-addressed observation evidence");
  }
  if (value.authority === "agent_inference") {
    if (!Array.isArray(value.derivedFromFactIds) || value.derivedFromFactIds.length === 0
      || !/^inference-sha256-[a-f0-9]{64}$/.test(String(value.inferenceTraceId))
      || !isCanonicalUnicode(value.extractorOrRuleVersion, 256) || !Array.isArray(value.assumptions)) errors.push("agent inference must be replayable from a trace, facts, version and assumptions");
  } else if (value.extractorOrRuleVersion !== undefined || value.inferenceTraceId !== undefined) errors.push("only agent inference may carry inference trace/version");
  const supersessionPresent = value.supersedesFactId !== undefined || value.supersededFactHash !== undefined;
  if (supersessionPresent) {
    if (value.status !== "active") errors.push("only an active replacement fact may declare supersession");
    if (!isCanonicalUnicode(value.supersedesFactId, 256) || !isSha256Hex(value.supersededFactHash)) errors.push("replacement fact requires old fact ID and hash");
    if (value.supersedesFactId === value.factId) errors.push("fact cannot supersede itself");
  }
  return errors;
}

/** Active means current evidence, not a green verdict. Critical inference needs stronger support. */
export function canFactAloneSupportSafetyPass(fact: FactRecord, context?: SafetyFactPassContext): boolean {
  const policy = factFieldPolicy(fact.field);
  if (!policy) return false;
  const critical = policy.safetyClass === "compatibility_critical" || policy.safetyClass === "electrical_safety";
  const resolvedSubject = context?.identityResolution.resolvedSubject;
  const identityScopeRank: Record<IdentityResolution["scope"], number> = { family: 0, model: 1, variant: 2, revision: 3 };
  const factScopeRank: Record<Exclude<FactScope, "plan_subject">, number> = { family: 0, model: 1, variant: 2, revision: 3 };
  const identityFields: Record<Exclude<FactScope, "plan_subject">, readonly (keyof Extract<FactSubject, { kind: "product" }>)[]> = {
    family: ["familyId"],
    model: ["familyId", "modelId"],
    variant: ["skuId", "familyId", "modelId", "variantId"],
    revision: ["skuId", "familyId", "modelId", "variantId", "revision", "region"],
  };
  const productScope = fact.scope === "plan_subject" ? null : fact.scope;
  const productSubject = fact.subject.kind === "product" ? fact.subject : null;
  const exactIdentity = context !== undefined
    && typeof context.activeConflictFactIds?.has === "function"
    && validateIdentityResolution(context.identityResolution).length === 0
    && context.identityResolution.status === "resolved"
    && productSubject !== null
    && productScope !== null
    && resolvedSubject?.kind === "product"
    && context.identityResolution.resolvedSkuId === resolvedSubject.skuId
    && identityScopeRank[context.identityResolution.scope] >= factScopeRank[productScope]
    && identityFields[productScope].every((field) => productSubject[field] !== undefined && productSubject[field] === resolvedSubject[field]);
  const observationAuthority = fact.authority === "user_observation"
    && fact.subject.kind === "plan_subject"
    && policy.userObservationPassAllowed
    && context?.observationValidated === true
    && context.observationHasRequiredUncertainty === true;
  const minimumScopeSatisfied = fact.scope !== "plan_subject"
    && factScopeRank[fact.scope] >= factScopeRank[policy.minimumProductPassScope];
  const evaluatedAt = context ? Date.parse(context.identityResolution.evaluatedAt) : Number.NaN;
  const temporallyCurrent = Number.isFinite(evaluatedAt)
    && Date.parse(fact.retrievedAt) <= evaluatedAt
    && (fact.validFrom === undefined || Date.parse(fact.validFrom) <= evaluatedAt)
    && (fact.validUntil === undefined || evaluatedAt <= Date.parse(fact.validUntil));
  return validateFactRecord(fact).length === 0
    && context?.contentHashVerified === true
    && isKnownFactValue(fact.value)
    && fact.evidenceRefs.length > 0
    && fact.authority !== "agent_inference"
    && policy.passAuthorities.includes(fact.authority)
    && fact.status === "active"
    && temporallyCurrent
    && (!critical || observationAuthority || (
      fact.authority === "official"
      && context?.evidenceClaimsVerified === true
      && fact.confidence >= CRITICAL_FACT_MIN_CONFIDENCE
      && exactIdentity
      && !context!.activeConflictFactIds.has(fact.factId)
      && minimumScopeSatisfied
    ));
}

export function validateLegacyFactSnapshot(snapshot: unknown): string[] {
  if (!isRecord(snapshot)) return ["fact snapshot must be an object"];
  const errors: string[] = [];
  if (!hasOnlyKeys(snapshot, ["schemaVersion", "snapshotId", "factIds", "conflictSetIds", "createdAt", "contentHash"])) errors.push("fact snapshot contains unknown fields");
  if (snapshot.schemaVersion !== "fact-snapshot-v1") errors.push("fact snapshot schemaVersion invalid");
  if (!isNonEmptyString(snapshot.snapshotId) || !isNonEmptyString(snapshot.createdAt)) errors.push("fact snapshot identity/time invalid");
  if (!isStringArray(snapshot.factIds)) errors.push("fact snapshot factIds invalid");
  else if (new Set(snapshot.factIds).size !== snapshot.factIds.length) errors.push("fact snapshot contains duplicate fact IDs");
  if (!isStringArray(snapshot.conflictSetIds)) errors.push("fact snapshot conflictSetIds invalid");
  else if (new Set(snapshot.conflictSetIds).size !== snapshot.conflictSetIds.length) errors.push("fact snapshot contains duplicate conflict IDs");
  if (!isSha256Hex(snapshot.contentHash)) errors.push("fact snapshot contentHash must be sha256");
  return errors;
}

export function validateFactSnapshot(snapshot: unknown): string[] {
  if (!isRecord(snapshot)) return ["fact snapshot must be an object"];
  const errors: string[] = [];
  if (!hasOnlyKeys(snapshot, ["schemaVersion", "snapshotId", "factRefs", "conflictRefs", "createdAt", "contentHash"])) errors.push("fact snapshot contains unknown fields");
  if (snapshot.schemaVersion !== "fact-snapshot-v2") errors.push("fact snapshot schemaVersion invalid");
  if (!isCanonicalUnicode(snapshot.snapshotId, 256) || !/^fact-snapshot-sha256-[a-f0-9]{64}$/.test(String(snapshot.snapshotId))) errors.push("fact snapshot ID invalid");
  if (!isIsoTimestamp(snapshot.createdAt)) errors.push("fact snapshot createdAt invalid");
  if (!isSha256Hex(snapshot.contentHash) || snapshot.snapshotId !== `fact-snapshot-sha256-${String(snapshot.contentHash)}`) errors.push("fact snapshot content identity invalid");
  const validateRefs = (value: unknown, idKey: "factId" | "conflictSetId", label: string): void => {
    if (!Array.isArray(value)) { errors.push(`fact snapshot ${label} invalid`); return; }
    const ids = new Set<string>();
    for (const ref of value) {
      if (!isRecord(ref) || !hasOnlyKeys(ref, [idKey, "contentHash"]) || !isCanonicalUnicode(ref[idKey], 256) || !isSha256Hex(ref.contentHash)) {
        errors.push(`fact snapshot ${label} invalid`);
        continue;
      }
      if (ids.has(ref[idKey] as string)) errors.push(`fact snapshot ${label} contains duplicate IDs`);
      ids.add(ref[idKey] as string);
    }
  };
  validateRefs(snapshot.factRefs, "factId", "factRefs");
  validateRefs(snapshot.conflictRefs, "conflictSetId", "conflictRefs");
  return errors;
}

export function validateConflictSet(conflict: unknown): string[] {
  if (!isRecord(conflict)) return ["conflict set must be an object"];
  const errors: string[] = [];
  const allowed = ["schemaVersion", "conflictSetId", "subject", "field", "factIds", "reason", "status", "resolutionFactIds", "decisionIds", "createdAt", "resolvedAt", "contentHash"];
  if (!hasOnlyKeys(conflict, allowed)) errors.push("conflict set contains unknown fields");
  if (conflict.schemaVersion !== "fact-conflict-v1") errors.push("conflict set schemaVersion invalid");
  for (const field of ["conflictSetId", "field"] as const) if (!isCanonicalUnicode(conflict[field], 256)) errors.push(`conflict set ${field} invalid`);
  if (!isIsoTimestamp(conflict.createdAt)) errors.push("conflict set createdAt invalid");
  errors.push(...validateFactSubject(conflict.subject).map((error) => `conflict set ${error}`));
  if (!Array.isArray(conflict.factIds) || conflict.factIds.some((id) => !isCanonicalUnicode(id, 256)) || new Set(conflict.factIds).size < 2) errors.push("conflict set requires at least two distinct facts");
  if (!["official_internal", "official_vs_third_party", "revision", "region", "value_disagreement"].includes(String(conflict.reason))) errors.push("conflict set reason invalid");
  if (conflict.status !== "open" && conflict.status !== "resolved") errors.push("conflict set status invalid");
  if (!Array.isArray(conflict.resolutionFactIds) || conflict.resolutionFactIds.some((id) => !isCanonicalUnicode(id, 256))
    || !Array.isArray(conflict.decisionIds) || conflict.decisionIds.some((id) => !/^update-decision-sha256-[a-f0-9]{64}$/.test(String(id)))
    || (Array.isArray(conflict.resolutionFactIds) && new Set(conflict.resolutionFactIds).size !== conflict.resolutionFactIds.length)
    || (Array.isArray(conflict.decisionIds) && new Set(conflict.decisionIds).size !== conflict.decisionIds.length)) errors.push("conflict set resolution refs invalid");
  if (conflict.resolvedAt !== undefined && !isIsoTimestamp(conflict.resolvedAt)) errors.push("conflict set resolvedAt invalid");
  if (conflict.status === "open" && ((Array.isArray(conflict.resolutionFactIds) && conflict.resolutionFactIds.length > 0)
    || (Array.isArray(conflict.decisionIds) && conflict.decisionIds.length > 0) || conflict.resolvedAt !== undefined)) errors.push("open conflict cannot carry a resolution");
  if (conflict.status === "resolved" && (!Array.isArray(conflict.resolutionFactIds) || conflict.resolutionFactIds.length === 0
    || !Array.isArray(conflict.decisionIds) || conflict.decisionIds.length === 0 || !isIsoTimestamp(conflict.resolvedAt))) errors.push("resolved conflict requires resolution facts, decisions and time");
  if (isIsoTimestamp(conflict.createdAt) && isIsoTimestamp(conflict.resolvedAt) && Date.parse(conflict.resolvedAt) < Date.parse(conflict.createdAt)) errors.push("conflict set resolution predates creation");
  if (!isSha256Hex(conflict.contentHash)) errors.push("conflict set contentHash invalid");
  return errors;
}

export function validateInferenceTrace(trace: unknown): string[] {
  if (!isRecord(trace)) return ["inference trace must be an object"];
  const errors: string[] = [];
  const allowed = ["inferenceTraceId", "inputFactIds", "outputFactIds", "engine", "ruleOrModelId", "ruleOrModelVersion", "assumptions", "confidence", "outputRange", "invalidationConditions", "createdAt"];
  if (!hasOnlyKeys(trace, allowed)) errors.push("inference trace contains unknown fields");
  for (const field of ["inferenceTraceId", "ruleOrModelId", "ruleOrModelVersion", "createdAt"] as const) if (!isNonEmptyString(trace[field])) errors.push("inference requires identity, time and a versioned rule or model");
  if (!isStringArray(trace.inputFactIds) || trace.inputFactIds.length === 0) errors.push("inference requires input facts");
  if (!isStringArray(trace.outputFactIds) || trace.outputFactIds.length === 0) errors.push("inference requires output facts");
  if (trace.engine !== "rule" && trace.engine !== "model") errors.push("inference engine invalid");
  if (!isStringArray(trace.assumptions)) errors.push("inference assumptions invalid");
  if (typeof trace.confidence !== "number" || trace.confidence < 0 || trace.confidence > 1 || !Number.isFinite(trace.confidence)) errors.push("inference confidence invalid");
  if (trace.outputRange !== undefined) {
    if (!isRecord(trace.outputRange)
      || !hasOnlyKeys(trace.outputRange, ["min", "max", "unit"])
      || typeof trace.outputRange.min !== "number" || !Number.isFinite(trace.outputRange.min)
      || typeof trace.outputRange.max !== "number" || !Number.isFinite(trace.outputRange.max)
      || trace.outputRange.min > trace.outputRange.max
      || (trace.outputRange.unit !== undefined && !isNonEmptyString(trace.outputRange.unit))) errors.push("inference output range invalid");
  }
  if (!isStringArray(trace.invalidationConditions) || trace.invalidationConditions.length === 0) errors.push("inference must state invalidation conditions");
  return errors;
}

export function validateIdentityResolution(resolution: unknown): string[] {
  if (!isRecord(resolution)) return ["identity resolution must be an object"];
  const errors: string[] = [];
  const allowed = ["identityResolutionId", "subjectText", "status", "scope", "resolvedSkuId", "resolvedSubject", "candidateSkuIds", "identityClaimIds", "unresolvedFieldIds", "evaluatedAt"];
  if (!hasOnlyKeys(resolution, allowed)) errors.push("identity resolution contains unknown fields");
  for (const field of ["identityResolutionId", "subjectText"] as const) if (!isCanonicalUnicode(resolution[field], field === "subjectText" ? 1024 : 256)) errors.push(`identity resolution ${field} invalid`);
  if (!isIsoTimestamp(resolution.evaluatedAt)) errors.push("identity resolution evaluatedAt invalid");
  if (!["resolved", "ambiguous", "unresolved"].includes(String(resolution.status))) errors.push("identity status invalid");
  if (!["family", "model", "variant", "revision"].includes(String(resolution.scope))) errors.push("identity scope invalid");
  for (const field of ["candidateSkuIds", "identityClaimIds", "unresolvedFieldIds"] as const) {
    const refs = resolution[field];
    if (!Array.isArray(refs) || refs.some((item) => !isCanonicalUnicode(item, 256)) || new Set(refs).size !== refs.length) errors.push("identity resolution references invalid");
  }
  if (resolution.resolvedSkuId !== undefined && !isCanonicalUnicode(resolution.resolvedSkuId, 256)) errors.push("resolved SKU invalid");
  const resolvedSubjectErrors = validateGovernedFactSubject(resolution.resolvedSubject);
  if (resolution.resolvedSubject !== undefined && resolvedSubjectErrors.length) errors.push("resolved identity subject invalid");
  if (resolution.status === "resolved" && (!resolution.resolvedSkuId || !Array.isArray(resolution.candidateSkuIds) || resolution.candidateSkuIds.length !== 1 || resolution.candidateSkuIds[0] !== resolution.resolvedSkuId
    || !Array.isArray(resolution.identityClaimIds) || resolution.identityClaimIds.length === 0
    || !Array.isArray(resolution.unresolvedFieldIds) || resolution.unresolvedFieldIds.length !== 0
    || !isRecord(resolution.resolvedSubject) || resolution.resolvedSubject.kind !== "product"
    || resolution.resolvedSubject.skuId !== resolution.resolvedSkuId)) errors.push("resolved identity requires one matching candidate SKU, exact subject and claim closure");
  const resolvedIdentitySubject = isRecord(resolution.resolvedSubject) && resolution.resolvedSubject.kind === "product"
    ? resolution.resolvedSubject : null;
  if (resolution.status === "resolved" && resolvedIdentitySubject) {
    const requiredByScope: Record<IdentityResolution["scope"], readonly string[]> = {
      family: ["familyId"], model: ["familyId", "modelId"], variant: ["familyId", "modelId", "variantId"],
      revision: ["familyId", "modelId", "variantId", "revision", "region"],
    };
    if (requiredByScope[resolution.scope as IdentityResolution["scope"]]?.some((field) => !isCanonicalUnicode(resolvedIdentitySubject[field], 256))) {
      errors.push("resolved identity subject is incomplete for its scope");
    }
  }
  if (resolution.status !== "resolved" && (resolution.resolvedSkuId !== undefined || resolution.resolvedSubject !== undefined)) errors.push("ambiguous/unresolved identity cannot select a subject");
  if (resolution.status === "ambiguous" && (!Array.isArray(resolution.candidateSkuIds) || resolution.candidateSkuIds.length < 1
    || !Array.isArray(resolution.identityClaimIds) || resolution.identityClaimIds.length < 2)) errors.push("ambiguous identity requires conflicting scoped claims");
  if (resolution.status === "unresolved" && (!Array.isArray(resolution.unresolvedFieldIds) || resolution.unresolvedFieldIds.length === 0)) errors.push("unresolved identity must identify missing fields");
  return errors;
}

export function validateUpdateDecision(decision: unknown): string[] {
  if (!isRecord(decision)) return ["update decision must be an object"];
  const errors: string[] = [];
  const allowed = ["schemaVersion", "updateDecisionId", "subjectKey", "claimKey", "revision", "memoryRevision", "planIds", "oldSnapshotRef", "newSnapshotRef", "oldFactIds", "newFactIds", "fieldDiffs", "affectedDomains", "decision", "decidedBy", "decidedAt", "supersedesDecisionId", "supersedesDecisionHash", "safetyWarningRetained", "contentHash"];
  if (!hasOnlyKeys(decision, allowed)) errors.push("update decision contains unknown fields");
  if (decision.schemaVersion !== "fact-update-decision-v1") errors.push("update decision schemaVersion invalid");
  for (const field of ["updateDecisionId", "subjectKey", "claimKey", "revision", "decidedAt"] as const) if (!isNonEmptyString(decision[field])) errors.push("update decision memory key incomplete");
  if (!Number.isInteger(decision.memoryRevision) || (decision.memoryRevision as number) < 0) errors.push("update decision memoryRevision invalid");
  if (!isStringArray(decision.planIds) || !decision.planIds.length || new Set(decision.planIds).size !== decision.planIds.length) errors.push("update decision planIds invalid");
  for (const field of ["oldSnapshotRef", "newSnapshotRef"] as const) {
    const ref = decision[field];
    if (!isRecord(ref) || !hasOnlyKeys(ref, ["snapshotId", "contentHash"]) || !isNonEmptyString(ref.snapshotId) || !isSha256Hex(ref.contentHash)
      || ref.snapshotId !== `fact-snapshot-sha256-${String(ref.contentHash)}`) errors.push(`update decision ${field} invalid`);
  }
  if (!["accept", "reject", "defer", "undo"].includes(String(decision.decision))) errors.push("update decision invalid");
  if (decision.decidedBy !== "user") errors.push("update decision must be made by user");
  if (typeof decision.safetyWarningRetained !== "boolean") errors.push("update decision safetyWarningRetained invalid");
  const supersessionPresent = decision.supersedesDecisionId !== undefined || decision.supersedesDecisionHash !== undefined;
  if (supersessionPresent && (!isNonEmptyString(decision.supersedesDecisionId) || !isSha256Hex(decision.supersedesDecisionHash)
    || decision.supersedesDecisionId !== `update-decision-sha256-${String(decision.supersedesDecisionHash)}`)) errors.push("update decision supersession closure invalid");
  if ((decision.memoryRevision as number) === 0 && supersessionPresent) errors.push("initial update decision cannot supersede another decision");
  if ((decision.memoryRevision as number) > 0 && !supersessionPresent) errors.push("revised update decision requires previous decision ID and hash");
  if (!isStringArray(decision.oldFactIds) || decision.oldFactIds.length === 0 || !isStringArray(decision.newFactIds) || decision.newFactIds.length === 0 || !Array.isArray(decision.fieldDiffs) || decision.fieldDiffs.length === 0) errors.push("update decision must retain old/new facts and field diffs");
  if (Array.isArray(decision.fieldDiffs)) for (const [index, diff] of decision.fieldDiffs.entries()) {
    if (!isRecord(diff) || !hasOnlyKeys(diff, ["field", "beforeFactIds", "afterFactIds"])
      || !isNonEmptyString(diff.field) || !isStringArray(diff.beforeFactIds) || !isStringArray(diff.afterFactIds)) errors.push(`update decision fieldDiffs.${index} invalid`);
  }
  const domains = ["identity", "mechanical", "electrical", "firmware", "system", "storage", "assembly", "commissioning", "routing", "thermal", "acoustic", "procurement"];
  if (!Array.isArray(decision.affectedDomains) || decision.affectedDomains.some((domain) => !domains.includes(String(domain)))) errors.push("update decision affectedDomains invalid");
  if ((decision.decision === "reject" || decision.decision === "defer") && !decision.safetyWarningRetained) errors.push("rejecting or deferring an update must retain its safety warning");
  if (decision.decision === "undo" && (!supersessionPresent || !decision.safetyWarningRetained)) errors.push("undo must retain the warning and supersede a prior decision");
  if (!isSha256Hex(decision.contentHash) || decision.updateDecisionId !== `update-decision-sha256-${String(decision.contentHash)}`) errors.push("update decision content identity invalid");
  return errors;
}
