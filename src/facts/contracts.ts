import type { EvaluationDecision } from "../requirements/contracts";
import { isSha256Hex } from "../hash";
import { validateObservationSubjectRef, type ObservationSubjectRef } from "../observations/contracts";

export type FactSubject =
  | { kind: "product"; skuId: string; revision?: string; region?: string; familyId?: string }
  | { kind: "plan_subject"; planId: string; subjectRef: ObservationSubjectRef };

export interface FactRecord {
  factId: string;
  subject: FactSubject;
  field: string;
  value: unknown;
  unit?: string;
  scope: "family" | "model" | "variant" | "revision" | "plan_subject";
  authority: "official" | "third_party" | "user_observation" | "agent_inference";
  safetyClass: "normal" | "compatibility_critical" | "electrical_safety";
  status: "active" | "superseded" | "conflicted" | "unresolved_blocker";
  evidenceRefs: string[];
  derivedFromFactIds: string[];
  extractorOrRuleVersion?: string;
  assumptions?: string[];
  confidence: number;
  retrievedAt: string;
  validFrom?: string;
  supersedesFactId?: string;
}

export interface FactSnapshot {
  schemaVersion: "fact-snapshot-v1";
  snapshotId: string;
  factIds: string[];
  conflictSetIds: string[];
  createdAt: string;
  contentHash: string;
}

export interface ConflictSet {
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
}

export interface IdentityResolution {
  identityResolutionId: string;
  subjectText: string;
  status: "resolved" | "ambiguous" | "unresolved";
  scope: "family" | "model" | "variant" | "revision";
  resolvedSkuId?: string;
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
  updateDecisionId: string;
  subjectKey: string;
  claimKey: string;
  revision: string;
  oldFactIds: string[];
  newFactIds: string[];
  fieldDiffs: FactFieldDiff[];
  affectedDomains: EvaluationDecision["domain"][];
  decision: "accept" | "reject" | "defer" | "undo";
  decidedBy: "user";
  decidedAt: string;
  supersedesDecisionId?: string;
  safetyWarningRetained: boolean;
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
    if (!hasOnlyKeys(value, ["kind", "skuId", "revision", "region", "familyId"]) || !isNonEmptyString(value.skuId)) errors.push("product subject invalid");
    for (const optional of ["revision", "region", "familyId"] as const) if (value[optional] !== undefined && !isNonEmptyString(value[optional])) errors.push(`product subject ${optional} invalid`);
    return errors;
  }
  return ["subject kind invalid"];
}

export function validateFactRecord(value: unknown): string[] {
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

/** Active means current evidence, not a green verdict. Critical inference needs stronger support. */
export function canFactAloneSupportSafetyPass(fact: FactRecord, context?: SafetyFactPassContext): boolean {
  const critical = fact.safetyClass === "compatibility_critical" || fact.safetyClass === "electrical_safety";
  const exactIdentity = context !== undefined
    && typeof context.activeConflictFactIds?.has === "function"
    && validateIdentityResolution(context.identityResolution).length === 0
    && context.identityResolution.status === "resolved"
    && (context.identityResolution.scope === "variant" || context.identityResolution.scope === "revision")
    && fact.subject.kind === "product"
    && context.identityResolution.resolvedSkuId === fact.subject.skuId;
  return validateFactRecord(fact).length === 0
    && isKnownFactValue(fact.value)
    && fact.evidenceRefs.length > 0
    && fact.authority !== "agent_inference"
    && fact.status === "active"
    && (!critical || (
      fact.authority === "official"
      && fact.confidence >= CRITICAL_FACT_MIN_CONFIDENCE
      && exactIdentity
      && !context!.activeConflictFactIds.has(fact.factId)
      && fact.scope !== "family"
      && fact.scope !== "model"
      && fact.scope !== "plan_subject"
    ));
}

export function validateFactSnapshot(snapshot: unknown): string[] {
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

export function validateConflictSet(conflict: unknown): string[] {
  if (!isRecord(conflict)) return ["conflict set must be an object"];
  const errors: string[] = [];
  const allowed = ["conflictSetId", "subject", "field", "factIds", "reason", "status", "resolutionFactIds", "decisionIds", "createdAt", "resolvedAt"];
  if (!hasOnlyKeys(conflict, allowed)) errors.push("conflict set contains unknown fields");
  for (const field of ["conflictSetId", "field", "createdAt"] as const) if (!isNonEmptyString(conflict[field])) errors.push(`conflict set ${field} invalid`);
  errors.push(...validateFactSubject(conflict.subject).map((error) => `conflict set ${error}`));
  if (!isStringArray(conflict.factIds) || new Set(conflict.factIds).size < 2) errors.push("conflict set requires at least two distinct facts");
  if (!["official_internal", "official_vs_third_party", "revision", "region", "value_disagreement"].includes(String(conflict.reason))) errors.push("conflict set reason invalid");
  if (conflict.status !== "open" && conflict.status !== "resolved") errors.push("conflict set status invalid");
  if (!isStringArray(conflict.resolutionFactIds) || !isStringArray(conflict.decisionIds)) errors.push("conflict set resolution refs invalid");
  if (conflict.resolvedAt !== undefined && !isNonEmptyString(conflict.resolvedAt)) errors.push("conflict set resolvedAt invalid");
  if (conflict.status === "open" && ((Array.isArray(conflict.resolutionFactIds) && conflict.resolutionFactIds.length > 0) || conflict.resolvedAt !== undefined)) errors.push("open conflict cannot carry a resolution");
  if (conflict.status === "resolved" && (!Array.isArray(conflict.resolutionFactIds) || conflict.resolutionFactIds.length === 0 || !isNonEmptyString(conflict.resolvedAt))) errors.push("resolved conflict requires resolution facts and time");
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
  const allowed = ["identityResolutionId", "subjectText", "status", "scope", "resolvedSkuId", "candidateSkuIds", "identityClaimIds", "unresolvedFieldIds", "evaluatedAt"];
  if (!hasOnlyKeys(resolution, allowed)) errors.push("identity resolution contains unknown fields");
  for (const field of ["identityResolutionId", "subjectText", "evaluatedAt"] as const) if (!isNonEmptyString(resolution[field])) errors.push(`identity resolution ${field} invalid`);
  if (!["resolved", "ambiguous", "unresolved"].includes(String(resolution.status))) errors.push("identity status invalid");
  if (!["family", "model", "variant", "revision"].includes(String(resolution.scope))) errors.push("identity scope invalid");
  if (!isStringArray(resolution.candidateSkuIds) || !isStringArray(resolution.identityClaimIds) || !isStringArray(resolution.unresolvedFieldIds)) errors.push("identity resolution references invalid");
  if (resolution.resolvedSkuId !== undefined && !isNonEmptyString(resolution.resolvedSkuId)) errors.push("resolved SKU invalid");
  if (resolution.status === "resolved" && (!resolution.resolvedSkuId || !Array.isArray(resolution.candidateSkuIds) || resolution.candidateSkuIds.length !== 1 || resolution.candidateSkuIds[0] !== resolution.resolvedSkuId)) errors.push("resolved identity requires one matching candidate SKU");
  if (resolution.status !== "resolved" && resolution.resolvedSkuId !== undefined) errors.push("ambiguous/unresolved identity cannot select a SKU");
  if (resolution.status === "ambiguous" && (!Array.isArray(resolution.candidateSkuIds) || resolution.candidateSkuIds.length < 2)) errors.push("ambiguous identity requires multiple candidates");
  if (resolution.status === "unresolved" && (!Array.isArray(resolution.unresolvedFieldIds) || resolution.unresolvedFieldIds.length === 0)) errors.push("unresolved identity must identify missing fields");
  return errors;
}

export function validateUpdateDecision(decision: unknown): string[] {
  if (!isRecord(decision)) return ["update decision must be an object"];
  const errors: string[] = [];
  const allowed = ["updateDecisionId", "subjectKey", "claimKey", "revision", "oldFactIds", "newFactIds", "fieldDiffs", "affectedDomains", "decision", "decidedBy", "decidedAt", "supersedesDecisionId", "safetyWarningRetained"];
  if (!hasOnlyKeys(decision, allowed)) errors.push("update decision contains unknown fields");
  for (const field of ["updateDecisionId", "subjectKey", "claimKey", "revision", "decidedAt"] as const) if (!isNonEmptyString(decision[field])) errors.push("update decision memory key incomplete");
  if (!["accept", "reject", "defer", "undo"].includes(String(decision.decision))) errors.push("update decision invalid");
  if (decision.decidedBy !== "user") errors.push("update decision must be made by user");
  if (typeof decision.safetyWarningRetained !== "boolean") errors.push("update decision safetyWarningRetained invalid");
  if (decision.supersedesDecisionId !== undefined && !isNonEmptyString(decision.supersedesDecisionId)) errors.push("supersedesDecisionId invalid");
  if (!isStringArray(decision.oldFactIds) || decision.oldFactIds.length === 0 || !isStringArray(decision.newFactIds) || decision.newFactIds.length === 0 || !Array.isArray(decision.fieldDiffs) || decision.fieldDiffs.length === 0) errors.push("update decision must retain old/new facts and field diffs");
  if (Array.isArray(decision.fieldDiffs)) for (const [index, diff] of decision.fieldDiffs.entries()) {
    if (!isRecord(diff) || !hasOnlyKeys(diff, ["field", "beforeFactIds", "afterFactIds"])
      || !isNonEmptyString(diff.field) || !isStringArray(diff.beforeFactIds) || !isStringArray(diff.afterFactIds)) errors.push(`update decision fieldDiffs.${index} invalid`);
  }
  const domains = ["identity", "mechanical", "electrical", "firmware", "system", "storage", "assembly", "commissioning", "routing", "thermal", "acoustic", "procurement"];
  if (!Array.isArray(decision.affectedDomains) || decision.affectedDomains.some((domain) => !domains.includes(String(domain)))) errors.push("update decision affectedDomains invalid");
  if ((decision.decision === "reject" || decision.decision === "defer") && !decision.safetyWarningRetained) errors.push("rejecting or deferring an update must retain its safety warning");
  return errors;
}
