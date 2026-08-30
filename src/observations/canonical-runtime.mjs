import {
  contentHashRuntime,
  isIsoTimestampRuntime,
  isSha256HexRuntime,
  legacyCanonicalJsonRuntime,
  legacySha256Runtime,
  runtimeRecord,
  validateObservationSubjectRefRuntime,
} from "../facts/canonical-runtime.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const OBSERVATION_FIELDS = Object.freeze({
  "physical.clearance": { valueType: "number", unitIds: ["mm"], subjectKinds: ["placement", "connection", "mount", "port"], uncertainty: "required" },
  "physical.component_length": { valueType: "number", unitIds: ["mm"], subjectKinds: ["instance"], uncertainty: "required" },
  "case.envelope.width": { valueType: "number", unitIds: ["mm"], subjectKinds: ["instance"], uncertainty: "required" },
  "case.envelope.height": { valueType: "number", unitIds: ["mm"], subjectKinds: ["instance"], uncertainty: "required" },
  "case.envelope.depth": { valueType: "number", unitIds: ["mm"], subjectKinds: ["instance"], uncertainty: "required" },
  "case.anchor.x": { valueType: "number", unitIds: ["mm"], subjectKinds: ["mount", "port"], uncertainty: "required" },
  "case.anchor.y": { valueType: "number", unitIds: ["mm"], subjectKinds: ["mount", "port"], uncertainty: "required" },
  "case.anchor.z": { valueType: "number", unitIds: ["mm"], subjectKinds: ["mount", "port"], uncertainty: "required" },
  "case.routing.width": { valueType: "number", unitIds: ["mm"], subjectKinds: ["mount", "port", "connection"], uncertainty: "required" },
  "case.routing.height": { valueType: "number", unitIds: ["mm"], subjectKinds: ["mount", "port", "connection"], uncertainty: "required" },
  "case.routing.depth": { valueType: "number", unitIds: ["mm"], subjectKinds: ["mount", "port", "connection"], uncertainty: "required" },
  "case.pose.x": { valueType: "number", unitIds: ["mm"], subjectKinds: ["placement", "mount", "port"], uncertainty: "required" },
  "case.pose.y": { valueType: "number", unitIds: ["mm"], subjectKinds: ["placement", "mount", "port"], uncertainty: "required" },
  "case.pose.z": { valueType: "number", unitIds: ["mm"], subjectKinds: ["placement", "mount", "port"], uncertainty: "required" },
  "case.pose.roll": { valueType: "number", unitIds: ["degree"], subjectKinds: ["placement", "mount", "port"], uncertainty: "required" },
  "case.pose.pitch": { valueType: "number", unitIds: ["degree"], subjectKinds: ["placement", "mount", "port"], uncertainty: "required" },
  "case.pose.yaw": { valueType: "number", unitIds: ["degree"], subjectKinds: ["placement", "mount", "port"], uncertainty: "required" },
  "identity.serial_number": { valueType: "string", unitIds: [], subjectKinds: ["instance"], uncertainty: "not_applicable" },
  "firmware.bios_version": { valueType: "string", unitIds: [], subjectKinds: ["firmware_instance"], uncertainty: "not_applicable" },
  "port.presence": { valueType: "boolean", unitIds: [], subjectKinds: ["port"], uncertainty: "not_applicable" },
  "connection.connected": { valueType: "boolean", unitIds: [], subjectKinds: ["connection"], uncertainty: "not_applicable" },
  "mount.standoff_present": { valueType: "boolean", unitIds: [], subjectKinds: ["mount"], uncertainty: "not_applicable" },
  "storage.disk_locator": { valueType: "string", unitIds: [], subjectKinds: ["instance", "placement", "port"], uncertainty: "not_applicable" },
  "boot.result": { valueType: "string", unitIds: [], subjectKinds: ["plan"], uncertainty: "not_applicable" },
  "package.item_count": { valueType: "number", unitIds: ["count"], subjectKinds: ["instance"], uncertainty: "optional" },
  "assembly.resource_assertion_hash": { valueType: "string", unitIds: [], subjectKinds: ["instance"], uncertainty: "not_applicable" },
  "assembly.check_assertion_hash": { valueType: "string", unitIds: [], subjectKinds: ["instance"], uncertainty: "not_applicable" },
  "thermal.ambient_temperature": { valueType: "number", unitIds: ["celsius"], subjectKinds: ["plan"], uncertainty: "required" },
  "thermal.fan_rpm": { valueType: "number", unitIds: ["rpm"], subjectKinds: ["instance"], uncertainty: "required" },
  "thermal.component_temperature": { valueType: "number", unitIds: ["celsius"], subjectKinds: ["instance"], uncertainty: "required" },
  "acoustics.sound_pressure": { valueType: "number", unitIds: ["dba"], subjectKinds: ["instance"], uncertainty: "required" },
});

export const OBSERVATION_FIELD_RUNTIME = OBSERVATION_FIELDS;

function total(operation, fallback) { try { return operation(); } catch { return fallback; } }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function onlyKeys(value, allowed) { return runtimeRecord(value) && Object.keys(value).every((key) => allowed.includes(key)); }
function nonEmpty(value) { return typeof value === "string" && value.length > 0; }
function sameLegacyJson(left, right) {
  const leftHash = legacySha256Runtime(left); const rightHash = legacySha256Runtime(right);
  return leftHash !== null && leftHash === rightHash;
}

function validUncertainty(value, observedValue) {
  if (!runtimeRecord(value) || !onlyKeys(value, ["plusMinus", "min", "max"])) return false;
  const numbers = Object.values(value);
  if (numbers.length === 0 || numbers.some((item) => typeof item !== "number" || !Number.isFinite(item))) return false;
  const usesPlusMinus = value.plusMinus !== undefined;
  const usesRange = value.min !== undefined || value.max !== undefined;
  if (usesPlusMinus === usesRange) return false;
  if (usesPlusMinus && (typeof value.plusMinus !== "number" || value.plusMinus <= 0)) return false;
  if (usesRange && (typeof value.min !== "number" || typeof value.max !== "number" || value.min > value.max)) return false;
  return !(usesRange && typeof observedValue === "number" && (observedValue < value.min || observedValue > value.max));
}

function validMeasurementContext(fieldId, value) {
  if (fieldId === "thermal.ambient_temperature") return value === undefined;
  if (!["thermal.fan_rpm", "thermal.component_temperature", "acoustics.sound_pressure"].includes(String(fieldId))) return value === undefined;
  if (!runtimeRecord(value) || !onlyKeys(value, ["workloadId", "testMethodId", "referenceDistanceM", "rpm"])
    || !nonEmpty(value.workloadId)) return false;
  if (fieldId !== "acoustics.sound_pressure") return Object.keys(value).length === 1;
  return Object.keys(value).length === 4 && nonEmpty(value.testMethodId)
    && typeof value.referenceDistanceM === "number" && Number.isFinite(value.referenceDistanceM) && value.referenceDistanceM > 0
    && runtimeRecord(value.rpm) && onlyKeys(value.rpm, ["lo", "hi"]) && Object.keys(value.rpm).length === 2
    && typeof value.rpm.lo === "number" && Number.isFinite(value.rpm.lo) && value.rpm.lo >= 0
    && typeof value.rpm.hi === "number" && Number.isFinite(value.rpm.hi) && value.rpm.hi >= value.rpm.lo;
}

function validateFieldValue(fieldId, value, unit, subjectKind, hasUncertainty) {
  const definition = OBSERVATION_FIELDS[fieldId];
  if (!definition) return ["observation fieldId is not allowlisted"];
  const errors = [];
  if (definition.valueType === "number" && (typeof value !== "number" || !Number.isFinite(value))) errors.push("value must be a finite number");
  else if (definition.valueType === "string" && !nonEmpty(value)) errors.push("value must be a non-empty string");
  else if (definition.valueType === "boolean" && typeof value !== "boolean") errors.push("value must be a boolean");
  if (definition.unitIds.length === 0 ? unit !== undefined : typeof unit !== "string" || !definition.unitIds.includes(unit)) errors.push(definition.unitIds.length === 0 ? "unitId is not allowed for this registry entry" : "unitId is not allowlisted for this registry entry");
  if (typeof subjectKind !== "string" || !definition.subjectKinds.includes(subjectKind)) errors.push("subject kind is not allowed for observation fieldId");
  if (definition.uncertainty === "required" && !hasUncertainty) errors.push("uncertainty is required for observation fieldId");
  if (definition.uncertainty === "not_applicable" && hasUncertainty) errors.push("uncertainty is not allowed for observation fieldId");
  return errors;
}

/** Total JavaScript projection of validateUserObservation(). */
export function validateUserObservationRuntime(value) {
  return total(() => {
    if (!runtimeRecord(value)) return ["user observation must be an object"];
    const errors = [];
    const allowed = ["observationId", "planId", "subjectRef", "fieldId", "value", "unit", "uncertainty", "measurementContext", "method", "attachmentRefs", "confirmedByUser", "observedAgainstConfigHash", "subjectRevisionHash", "capturedAt", "validatedAt", "invalidatedAt", "invalidationReason", "status", "supersedesObservationId", "contentHash"];
    if (!onlyKeys(value, allowed)) errors.push("user observation contains derived or unknown fields");
    for (const field of ["observationId", "planId", "fieldId", "capturedAt"]) if (!nonEmpty(value[field])) errors.push(`${field} missing`);
    for (const field of ["observedAgainstConfigHash", "subjectRevisionHash", "contentHash"]) if (!isSha256HexRuntime(value[field])) errors.push(`${field} must be sha256`);
    if (!runtimeRecord(value.subjectRef) || typeof value.subjectRef.kind !== "string") errors.push("subjectRef invalid");
    else {
      errors.push(...validateObservationSubjectRefRuntime(value.subjectRef));
      errors.push(...validateFieldValue(value.fieldId, value.value, value.unit, value.subjectRef.kind, value.uncertainty !== undefined));
    }
    if (value.uncertainty !== undefined && !validUncertainty(value.uncertainty, value.value)) errors.push("uncertainty invalid");
    if (!validMeasurementContext(value.fieldId, value.measurementContext)) errors.push("measurementContext invalid for observation fieldId");
    if (!["measurement", "photo", "label", "visual_confirmation", "user_assertion"].includes(String(value.method))) errors.push("method invalid");
    if (!Array.isArray(value.attachmentRefs) || value.attachmentRefs.some((ref) => !nonEmpty(ref))) errors.push("attachmentRefs invalid");
    else if (new Set(value.attachmentRefs).size !== value.attachmentRefs.length) errors.push("attachmentRefs contains duplicates");
    if ((value.method === "photo" || value.method === "label") && (!Array.isArray(value.attachmentRefs) || value.attachmentRefs.length === 0)) errors.push("photo/label observation requires an attachment");
    if (typeof value.confirmedByUser !== "boolean") errors.push("confirmedByUser must be boolean");
    const capturedAt = isIsoTimestampRuntime(value.capturedAt) ? Date.parse(value.capturedAt) : Number.NaN;
    const validatedAt = isIsoTimestampRuntime(value.validatedAt) ? Date.parse(value.validatedAt) : undefined;
    const invalidatedAt = isIsoTimestampRuntime(value.invalidatedAt) ? Date.parse(value.invalidatedAt) : undefined;
    if (!Number.isFinite(capturedAt)) errors.push("capturedAt must be an ISO timestamp");
    if (value.validatedAt !== undefined && validatedAt === undefined) errors.push("validatedAt invalid");
    if (value.invalidatedAt !== undefined && invalidatedAt === undefined) errors.push("invalidatedAt invalid");
    if (validatedAt !== undefined && validatedAt < capturedAt) errors.push("validatedAt cannot precede capturedAt");
    if (invalidatedAt !== undefined && invalidatedAt < (validatedAt ?? capturedAt)) errors.push("invalidatedAt cannot precede capture/validation");
    if (value.invalidationReason !== undefined && !nonEmpty(value.invalidationReason)) errors.push("invalidationReason invalid");
    if (!["proposed", "active", "superseded", "retracted"].includes(String(value.status))) errors.push("status invalid");
    if (value.status === "active" && (!value.confirmedByUser || validatedAt === undefined)) errors.push("active observation must be user-confirmed and validated");
    if (value.invalidatedAt !== undefined && typeof value.invalidationReason !== "string") errors.push("invalidated observation requires a reason");
    if (value.invalidationReason !== undefined && typeof value.invalidatedAt !== "string") errors.push("invalidation reason requires invalidatedAt");
    if (value.supersedesObservationId !== undefined) {
      if (!nonEmpty(value.supersedesObservationId)) errors.push("supersedesObservationId invalid");
      if (value.status !== "active" && value.status !== "retracted") errors.push("only an active replacement observation may declare supersedesObservationId");
      if (value.supersedesObservationId === value.observationId) errors.push("observation cannot supersede itself");
    }
    return errors;
  }, ["user observation runtime validation failed"]);
}

export function verifyUserObservationRuntime(value) {
  return total(() => {
    if (validateUserObservationRuntime(value).length) return false;
    const base = { ...value }; delete base.contentHash;
    return value.contentHash === legacySha256Runtime(base);
  }, false);
}

/** Total JavaScript projection of validateUserObservationSnapshot(). */
export function validateUserObservationSnapshotRuntime(value) {
  return total(() => {
    if (!runtimeRecord(value)) return ["user observation snapshot must be an object"];
    const errors = [];
    const allowed = ["schemaVersion", "snapshotId", "planId", "observationIds", "observationRecordHashes", "createdAt", "contentHash"];
    if (!onlyKeys(value, allowed)) errors.push("user observation snapshot contains unknown fields");
    if (value.schemaVersion !== "user-observation-snapshot-v1") errors.push("user observation snapshot schemaVersion invalid");
    for (const field of ["snapshotId", "planId"]) if (!nonEmpty(value[field])) errors.push(`user observation snapshot ${field} invalid`);
    if (!isIsoTimestampRuntime(value.createdAt)) errors.push("user observation snapshot createdAt invalid");
    if (!Array.isArray(value.observationIds) || value.observationIds.some((id) => !nonEmpty(id))) errors.push("user observation snapshot observationIds invalid");
    else if (new Set(value.observationIds).size !== value.observationIds.length) errors.push("user observation snapshot contains duplicate observation IDs");
    if (value.observationRecordHashes !== undefined) {
      if (!runtimeRecord(value.observationRecordHashes)) errors.push("user observation snapshot observationRecordHashes invalid");
      else {
        const ids = Array.isArray(value.observationIds) ? value.observationIds.filter((id) => typeof id === "string") : [];
        const declared = Object.keys(value.observationRecordHashes).sort();
        if (declared.length !== ids.length || declared.some((id, index) => id !== [...ids].sort()[index])) errors.push("user observation snapshot record hash closure invalid");
        if (Object.values(value.observationRecordHashes).some((hash) => !isSha256HexRuntime(hash))) errors.push("user observation snapshot observation record hash invalid");
      }
    }
    if (!isSha256HexRuntime(value.contentHash)) errors.push("user observation snapshot contentHash must be sha256");
    return errors;
  }, ["user observation snapshot runtime validation failed"]);
}

export function verifyUserObservationSnapshotRuntime(value) {
  return total(() => {
    if (validateUserObservationSnapshotRuntime(value).length) return false;
    const base = { ...value }; delete base.contentHash;
    return value.contentHash === contentHashRuntime(base, "user-observation-snapshot", "user-observation-snapshot-v1", "observationSnapshot");
  }, false);
}

export function validateObservationSupersessionRuntime(value, { planId, replacementObservationId } = {}) {
  return total(() => {
    if (!runtimeRecord(value)) return ["observation supersession must be an object"];
    const errors = [];
    if (!onlyKeys(value, ["schemaVersion", "planId", "supersededObservationId", "replacementObservationId", "createdAt", "contentHash"])) errors.push("observation supersession contains unknown fields");
    if (value.schemaVersion !== "observation-supersession-v1") errors.push("observation supersession schema invalid");
    if (!nonEmpty(value.planId) || (planId !== undefined && value.planId !== planId)) errors.push("observation supersession plan invalid");
    if (!SAFE_ID.test(String(value.supersededObservationId ?? ""))) errors.push("observation supersession source invalid");
    if (!SAFE_ID.test(String(value.replacementObservationId ?? "")) || (replacementObservationId !== undefined && value.replacementObservationId !== replacementObservationId)) errors.push("observation supersession replacement invalid");
    if (!Number.isFinite(Date.parse(value.createdAt))) errors.push("observation supersession time invalid");
    if (!isSha256HexRuntime(value.contentHash)) errors.push("observation supersession contentHash invalid");
    const base = { schemaVersion: "observation-supersession-v1", planId: value.planId, supersededObservationId: value.supersededObservationId, replacementObservationId: value.replacementObservationId, createdAt: value.createdAt };
    if (value.contentHash !== legacySha256Runtime(base)) errors.push("observation supersession contentHash mismatch");
    return errors;
  }, ["observation supersession runtime validation failed"]);
}

/** Validates the immutable replacement graph and returns current IDs. */
export function currentObservationIdsRuntime(observations) {
  return total(() => {
    if (!Array.isArray(observations)) return { errors: ["observation records invalid"], currentIds: new Set() };
    const errors = [];
    const byId = new Map();
    for (const observation of observations) {
      if (!runtimeRecord(observation) || !nonEmpty(observation.observationId)) { errors.push("observation record identity invalid"); continue; }
      if (byId.has(observation.observationId)) errors.push("observation records contain duplicate identities");
      byId.set(observation.observationId, observation);
    }
    const replaced = new Set();
    for (const observation of observations) {
      if (!runtimeRecord(observation) || !observation.supersedesObservationId) continue;
      const source = byId.get(observation.supersedesObservationId);
      if (!source) { errors.push("observation supersession source is missing"); continue; }
      if (source.planId !== observation.planId || source.fieldId !== observation.fieldId || !sameLegacyJson(source.subjectRef, observation.subjectRef)) errors.push("observation supersession crosses a plan, subject, or field");
      if (replaced.has(observation.supersedesObservationId)) errors.push("observation supersession has multiple replacements");
      replaced.add(observation.supersedesObservationId);
    }
    // Writing can only point to an already-current record. Detect forged cycles
    // explicitly; a set-only current calculation would otherwise hide them.
    for (const id of byId.keys()) {
      const seen = new Set(); let current = id;
      while (true) {
        const observation = byId.get(current); const next = observation?.supersedesObservationId;
        if (!next) break;
        if (seen.has(next)) { errors.push("observation supersession contains a cycle"); break; }
        seen.add(current); current = next;
      }
    }
    return { errors, currentIds: new Set([...byId.keys()].filter((id) => !replaced.has(id))) };
  }, { errors: ["observation current-set validation failed"], currentIds: new Set() });
}

const CASE_INSTANCE_OVERRIDE_FIELDS = Object.freeze({
  "physical.clearance": { targetKind: "clearance", property: "clearance", unit: "mm", subjectKinds: ["placement", "connection", "mount", "port"] },
  "case.envelope.width": { targetKind: "envelope", property: "width", unit: "mm", subjectKinds: ["instance"] },
  "case.envelope.height": { targetKind: "envelope", property: "height", unit: "mm", subjectKinds: ["instance"] },
  "case.envelope.depth": { targetKind: "envelope", property: "depth", unit: "mm", subjectKinds: ["instance"] },
  "case.anchor.x": { targetKind: "anchor", property: "x", unit: "mm", subjectKinds: ["mount", "port"] },
  "case.anchor.y": { targetKind: "anchor", property: "y", unit: "mm", subjectKinds: ["mount", "port"] },
  "case.anchor.z": { targetKind: "anchor", property: "z", unit: "mm", subjectKinds: ["mount", "port"] },
  "case.routing.width": { targetKind: "routing", property: "width", unit: "mm", subjectKinds: ["mount", "port", "connection"] },
  "case.routing.height": { targetKind: "routing", property: "height", unit: "mm", subjectKinds: ["mount", "port", "connection"] },
  "case.routing.depth": { targetKind: "routing", property: "depth", unit: "mm", subjectKinds: ["mount", "port", "connection"] },
  "case.pose.x": { targetKind: "pose", property: "x", unit: "mm", subjectKinds: ["placement", "mount", "port"] },
  "case.pose.y": { targetKind: "pose", property: "y", unit: "mm", subjectKinds: ["placement", "mount", "port"] },
  "case.pose.z": { targetKind: "pose", property: "z", unit: "mm", subjectKinds: ["placement", "mount", "port"] },
  "case.pose.roll": { targetKind: "pose", property: "roll", unit: "degree", subjectKinds: ["placement", "mount", "port"] },
  "case.pose.pitch": { targetKind: "pose", property: "pitch", unit: "degree", subjectKinds: ["placement", "mount", "port"] },
  "case.pose.yaw": { targetKind: "pose", property: "yaw", unit: "degree", subjectKinds: ["placement", "mount", "port"] },
});

export const CASE_INSTANCE_OVERRIDE_FIELD_RUNTIME = CASE_INSTANCE_OVERRIDE_FIELDS;

function exactKeys(value, fields) {
  return runtimeRecord(value) && Object.keys(value).length === fields.length
    && fields.every((field) => own(value, field));
}

function subjectBoundToInstance(subject, targetKind, instanceId) {
  if (!runtimeRecord(subject)) return false;
  if (targetKind === "envelope") return subject.kind === "instance" && subject.instanceId === instanceId;
  if (subject.kind === "mount") return subject.ownerInstanceId === instanceId;
  if (subject.kind === "port") return subject.instanceId === instanceId;
  // placement/connection membership is proven by the root-bound config
  // authority; the portable output still retains the complete typed subject.
  return subject.kind === "placement" || subject.kind === "connection";
}

function overrideSortKey(entry) {
  return legacyCanonicalJsonRuntime([entry.targetKind, entry.subjectRef, entry.property, entry.observationId]);
}

function overrideSlotKey(entry) {
  return legacyCanonicalJsonRuntime([entry.targetKind, entry.subjectRef, entry.property]);
}

function caseInstanceSpatialHashMaterialRuntime(value) {
  return {
    schemaVersion: "case-instance-spatial-input-v1",
    planId: value.planId,
    instanceId: value.instanceId,
    subjectRevisionHash: value.subjectRevisionHash,
    observationSnapshotHash: value.observationSnapshotHash,
    baseManifestHash: value.baseManifestHash,
    baseProjectionHash: value.baseProjectionHash,
    overrides: value.overrides,
  };
}

/** Total JavaScript validator for the immutable case-instance override layer. */
export function validateCaseInstanceOverridesRuntime(value) {
  return total(() => {
    if (!runtimeRecord(value)) return ["case instance overrides must be an object"];
    const errors = [];
    const fields = [
      "schemaVersion", "planId", "instanceId", "subjectRevisionHash", "observationSnapshotId", "observationSnapshotHash",
      "baseManifestHash", "baseProjectionHash", "overrides", "spatialHash", "contentHash",
    ];
    if (!exactKeys(value, fields)) errors.push("case instance overrides contain unknown or missing fields");
    if (value.schemaVersion !== "case-instance-overrides-v1") errors.push("case instance overrides schemaVersion invalid");
    for (const field of ["planId", "instanceId", "observationSnapshotId"]) {
      if (!SAFE_ID.test(String(value[field] ?? ""))) errors.push(`case instance overrides ${field} invalid`);
    }
    for (const field of ["subjectRevisionHash", "observationSnapshotHash", "baseManifestHash", "baseProjectionHash", "spatialHash", "contentHash"]) {
      if (!isSha256HexRuntime(value[field])) errors.push(`case instance overrides ${field} invalid`);
    }
    if (!Array.isArray(value.overrides)) errors.push("case instance overrides entries invalid");
    else {
      const observationIds = new Set();
      const slots = new Set();
      let previousKey = null;
      value.overrides.forEach((entry, index) => {
        const label = `case instance overrides entries.${index}`;
        if (!exactKeys(entry, [
          "observationId", "observationRecordHash", "subjectRef", "subjectRevisionHash", "fieldId", "targetKind",
          "property", "value", "unit", "uncertainty",
        ])) { errors.push(`${label} shape invalid`); return; }
        if (!SAFE_ID.test(String(entry.observationId ?? "")) || observationIds.has(entry.observationId)) errors.push(`${label} observation identity invalid or duplicate`);
        else observationIds.add(entry.observationId);
        if (!isSha256HexRuntime(entry.observationRecordHash) || !isSha256HexRuntime(entry.subjectRevisionHash)) errors.push(`${label} hash binding invalid`);
        errors.push(...validateObservationSubjectRefRuntime(entry.subjectRef).map((error) => `${label} ${error}`));
        const definition = typeof entry.fieldId === "string" ? CASE_INSTANCE_OVERRIDE_FIELDS[entry.fieldId] : undefined;
        if (!definition || entry.targetKind !== definition.targetKind || entry.property !== definition.property
          || entry.unit !== definition.unit || !runtimeRecord(entry.subjectRef)
          || !definition.subjectKinds.includes(entry.subjectRef.kind)) errors.push(`${label} field target/unit invalid`);
        if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) errors.push(`${label} value invalid`);
        if (!validUncertainty(entry.uncertainty, entry.value)) errors.push(`${label} uncertainty invalid`);
        if (!subjectBoundToInstance(entry.subjectRef, entry.targetKind, value.instanceId)) errors.push(`${label} crosses the bound case instance`);
        const slot = overrideSlotKey(entry);
        if (slot === null || slots.has(slot)) errors.push(`${label} target is ambiguous or duplicate`);
        else slots.add(slot);
        const key = overrideSortKey(entry);
        if (key === null || previousKey !== null && key <= previousKey) errors.push(`${label} is not in canonical order`);
        previousKey = key;
      });
    }
    if (isSha256HexRuntime(value.spatialHash)) {
      const expected = contentHashRuntime(
        caseInstanceSpatialHashMaterialRuntime(value),
        "spatial-topology",
        "1.0.0",
        "observationSnapshot",
      );
      if (value.spatialHash !== expected) errors.push("case instance overrides spatialHash mismatch");
    }
    if (isSha256HexRuntime(value.contentHash)) {
      const expected = contentHashRuntime(value, "artifact", "1.0.0", "observationSnapshot");
      if (value.contentHash !== expected) errors.push("case instance overrides contentHash mismatch");
    }
    return errors;
  }, ["case instance overrides runtime validation failed"]);
}

export function verifyCaseInstanceOverridesRuntime(value) {
  return validateCaseInstanceOverridesRuntime(value).length === 0;
}
