import { validateObservationFieldValue, type ObservationFieldId, type UnitId } from "../contracts/registries";
import { isSha256Hex } from "../hash";

export type ObservationSubjectRef =
  | { kind: "plan" }
  | { kind: "instance"; instanceId: string }
  | { kind: "placement"; placementId: string }
  | { kind: "connection"; connectionId: string }
  | { kind: "port"; instanceId: string; portId: string }
  | { kind: "mount"; ownerInstanceId: string; mountId: string }
  | { kind: "firmware_instance"; instanceId: string };

export interface ObservationUncertainty {
  plusMinus?: number;
  min?: number;
  max?: number;
}

/** A plan-scoped user claim; `stale` is deliberately not a persisted status. */
export interface UserObservation {
  observationId: string;
  planId: string;
  subjectRef: ObservationSubjectRef;
  fieldId: ObservationFieldId;
  value: unknown;
  unit?: UnitId;
  uncertainty?: ObservationUncertainty;
  method: "measurement" | "photo" | "label" | "visual_confirmation" | "user_assertion";
  attachmentRefs: string[];
  confirmedByUser: boolean;
  observedAgainstConfigHash: string;
  subjectRevisionHash: string;
  capturedAt: string;
  validatedAt?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
  status: "proposed" | "active" | "superseded" | "retracted";
  supersedesObservationId?: string;
  contentHash: string;
}

export interface UserObservationSnapshot {
  schemaVersion: "user-observation-snapshot-v1";
  snapshotId: string;
  planId: string;
  observationIds: string[];
  createdAt: string;
  contentHash: string;
}

export interface ObservationAttachment {
  attachmentId: string;
  contentHash: string;
  mediaType: string;
  privacyClass: "private_user";
  deletionPolicy: "retain_until_user_deletes" | "delete_after_extraction";
  status: "available" | "deleted_tombstone";
  deletedAt?: string;
}

export interface ObservationProjectionContext {
  planId: string;
  subjectExists: boolean;
  currentConfigHash: string;
  currentSubjectRevisionHash: string;
}

export type ObservationLifecycle = "proposed" | "active" | "stale" | "superseded" | "retracted";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validUncertainty(value: unknown, observedValue: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !["plusMinus", "min", "max"].includes(key))) return false;
  const numbers = Object.values(value);
  if (numbers.length === 0 || numbers.some((item) => typeof item !== "number" || !Number.isFinite(item))) return false;
  const usesPlusMinus = value.plusMinus !== undefined;
  const usesRange = value.min !== undefined || value.max !== undefined;
  if (usesPlusMinus === usesRange) return false;
  if (usesPlusMinus && (typeof value.plusMinus !== "number" || value.plusMinus <= 0)) return false;
  if (usesRange && (typeof value.min !== "number" || typeof value.max !== "number" || value.min > value.max)) return false;
  if (usesRange && typeof observedValue === "number" && (observedValue < (value.min as number) || observedValue > (value.max as number))) return false;
  return true;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function subjectKind(value: ObservationSubjectRef): ObservationSubjectRef["kind"] {
  return value.kind;
}

export function validateObservationSubjectRef(value: unknown): string[] {
  if (!isRecord(value)) return ["subjectRef invalid"];
  const expectedFields: Record<string, readonly string[]> = {
    plan: ["kind"],
    instance: ["kind", "instanceId"],
    placement: ["kind", "placementId"],
    connection: ["kind", "connectionId"],
    port: ["kind", "instanceId", "portId"],
    mount: ["kind", "ownerInstanceId", "mountId"],
    firmware_instance: ["kind", "instanceId"],
  };
  const fields = typeof value.kind === "string" ? expectedFields[value.kind] : undefined;
  if (!fields) return ["subjectRef kind invalid"];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))) return ["subjectRef fields invalid"];
  return fields.filter((field) => field !== "kind" && (typeof value[field] !== "string" || value[field].length === 0)).map((field) => `subjectRef.${field} missing`);
}

export function validateUserObservation(value: unknown): string[] {
  if (!isRecord(value)) return ["user observation must be an object"];
  const errors: string[] = [];
  const allowed = [
    "observationId", "planId", "subjectRef", "fieldId", "value", "unit", "uncertainty", "method", "attachmentRefs",
    "confirmedByUser", "observedAgainstConfigHash", "subjectRevisionHash", "capturedAt", "validatedAt", "invalidatedAt",
    "invalidationReason", "status", "supersedesObservationId", "contentHash",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) errors.push("user observation contains derived or unknown fields");
  for (const field of ["observationId", "planId", "fieldId", "capturedAt"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) errors.push(`${field} missing`);
  }
  for (const field of ["observedAgainstConfigHash", "subjectRevisionHash", "contentHash"] as const) {
    if (!isSha256Hex(value[field])) errors.push(`${field} must be sha256`);
  }
  if (!isRecord(value.subjectRef) || typeof value.subjectRef.kind !== "string") {
    errors.push("subjectRef invalid");
  } else {
    errors.push(...validateObservationSubjectRef(value.subjectRef));
    const subject = value.subjectRef as ObservationSubjectRef;
    errors.push(...validateObservationFieldValue(value.fieldId, value.value, value.unit, subjectKind(subject), value.uncertainty !== undefined));
  }
  if (value.uncertainty !== undefined && !validUncertainty(value.uncertainty, value.value)) errors.push("uncertainty invalid");
  if (!["measurement", "photo", "label", "visual_confirmation", "user_assertion"].includes(String(value.method))) errors.push("method invalid");
  if (!Array.isArray(value.attachmentRefs) || value.attachmentRefs.some((ref) => typeof ref !== "string" || ref.length === 0)) errors.push("attachmentRefs invalid");
  else if (new Set(value.attachmentRefs).size !== value.attachmentRefs.length) errors.push("attachmentRefs contains duplicates");
  if ((value.method === "photo" || value.method === "label") && (!Array.isArray(value.attachmentRefs) || value.attachmentRefs.length === 0)) errors.push("photo/label observation requires an attachment");
  if (typeof value.confirmedByUser !== "boolean") errors.push("confirmedByUser must be boolean");
  const capturedAt = isIsoTimestamp(value.capturedAt) ? Date.parse(value.capturedAt) : Number.NaN;
  const validatedAt = isIsoTimestamp(value.validatedAt) ? Date.parse(value.validatedAt) : undefined;
  const invalidatedAt = isIsoTimestamp(value.invalidatedAt) ? Date.parse(value.invalidatedAt) : undefined;
  if (!Number.isFinite(capturedAt)) errors.push("capturedAt must be an ISO timestamp");
  if (value.validatedAt !== undefined && validatedAt === undefined) errors.push("validatedAt invalid");
  if (value.invalidatedAt !== undefined && invalidatedAt === undefined) errors.push("invalidatedAt invalid");
  if (validatedAt !== undefined && validatedAt < capturedAt) errors.push("validatedAt cannot precede capturedAt");
  if (invalidatedAt !== undefined && invalidatedAt < (validatedAt ?? capturedAt)) errors.push("invalidatedAt cannot precede capture/validation");
  if (value.invalidationReason !== undefined && (typeof value.invalidationReason !== "string" || value.invalidationReason.length === 0)) errors.push("invalidationReason invalid");
  if (!["proposed", "active", "superseded", "retracted"].includes(String(value.status))) errors.push("status invalid");
  if (value.status === "active" && (!value.confirmedByUser || validatedAt === undefined)) errors.push("active observation must be user-confirmed and validated");
  if (value.invalidatedAt !== undefined && typeof value.invalidationReason !== "string") errors.push("invalidated observation requires a reason");
  if (value.invalidationReason !== undefined && typeof value.invalidatedAt !== "string") errors.push("invalidation reason requires invalidatedAt");
  if (value.supersedesObservationId !== undefined) {
    if (typeof value.supersedesObservationId !== "string" || value.supersedesObservationId.length === 0) errors.push("supersedesObservationId invalid");
    if (value.status !== "active") errors.push("only an active replacement observation may declare supersedesObservationId");
    if (value.supersedesObservationId === value.observationId) errors.push("observation cannot supersede itself");
  }
  return errors;
}

export function observationLifecycle(observation: UserObservation, context: ObservationProjectionContext): ObservationLifecycle {
  if (observation.status !== "active") return observation.status;
  if (observation.planId !== context.planId || !context.subjectExists || observation.invalidatedAt !== undefined
    || observation.observedAgainstConfigHash !== context.currentConfigHash
    || observation.subjectRevisionHash !== context.currentSubjectRevisionHash) return "stale";
  return "active";
}

/** Only this predicate permits projection into a plan-subject user_observation fact. */
export function canProjectUserObservation(observation: UserObservation, context: ObservationProjectionContext): boolean {
  return validateUserObservation(observation).length === 0
    && observationLifecycle(observation, context) === "active";
}

export function validateUserObservationSnapshot(value: unknown): string[] {
  if (!isRecord(value)) return ["user observation snapshot must be an object"];
  const errors: string[] = [];
  const allowed = ["schemaVersion", "snapshotId", "planId", "observationIds", "createdAt", "contentHash"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) errors.push("user observation snapshot contains unknown fields");
  if (value.schemaVersion !== "user-observation-snapshot-v1") errors.push("user observation snapshot schemaVersion invalid");
  for (const field of ["snapshotId", "planId"] as const) if (typeof value[field] !== "string" || value[field].length === 0) errors.push(`user observation snapshot ${field} invalid`);
  if (!isIsoTimestamp(value.createdAt)) errors.push("user observation snapshot createdAt invalid");
  if (!Array.isArray(value.observationIds) || value.observationIds.some((id) => typeof id !== "string" || id.length === 0)) errors.push("user observation snapshot observationIds invalid");
  else if (new Set(value.observationIds).size !== value.observationIds.length) errors.push("user observation snapshot contains duplicate observation IDs");
  if (!isSha256Hex(value.contentHash)) errors.push("user observation snapshot contentHash must be sha256");
  return errors;
}

export function validateObservationAttachment(value: unknown): string[] {
  if (!isRecord(value)) return ["observation attachment must be an object"];
  const errors: string[] = [];
  const allowed = ["attachmentId", "contentHash", "mediaType", "privacyClass", "deletionPolicy", "status", "deletedAt"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) errors.push("observation attachment contains unknown fields");
  if (typeof value.attachmentId !== "string" || value.attachmentId.length === 0 || typeof value.mediaType !== "string" || value.mediaType.length === 0) errors.push("observation attachment identity invalid");
  if (value.privacyClass !== "private_user") errors.push("user attachment privacyClass must be private_user");
  if (value.deletionPolicy !== "retain_until_user_deletes" && value.deletionPolicy !== "delete_after_extraction") errors.push("observation attachment deletionPolicy invalid");
  if (value.status !== "available" && value.status !== "deleted_tombstone") errors.push("observation attachment status invalid");
  if (value.status === "deleted_tombstone" && !isIsoTimestamp(value.deletedAt)) errors.push("deleted attachment must retain a timestamped tombstone");
  if (value.status === "available" && value.deletedAt !== undefined) errors.push("available attachment cannot have deletedAt");
  if (!isSha256Hex(value.contentHash)) errors.push("attachment tombstone must retain sha256 contentHash");
  return errors;
}
