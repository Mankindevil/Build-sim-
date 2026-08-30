import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";

/**
 * JavaScript-runtime projection of the persisted U3 Fact authority contract.
 *
 * Production backup/Doctor/restore code deliberately cannot import TypeScript
 * validators.  This module therefore mirrors the frozen write-side contract
 * and its hash policies.  Every public validator is total: hostile JavaScript
 * values yield errors rather than an exception that could turn a bad record
 * into a skipped check.
 */

export const SHA256_HEX = /^[a-f0-9]{64}$/;
const FACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const OBSERVATION_REF = /^observation:([A-Za-z0-9][A-Za-z0-9._-]{0,159})@sha256:([a-f0-9]{64})$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

function total(operation, fallback) {
  try { return operation(); } catch { return fallback; }
}

export function runtimeRecord(value) {
  return total(() => value !== null && typeof value === "object" && !Array.isArray(value), false);
}

export function isSha256HexRuntime(value) {
  return typeof value === "string" && SHA256_HEX.test(value);
}

export function isCanonicalUnicodeRuntime(value, maxLength = 512) {
  return total(() => {
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
  }, false);
}

export function isIsoTimestampRuntime(value) {
  return total(() => typeof value === "string" && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)), false);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function onlyKeys(value, allowed) {
  return runtimeRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function nonEmpty(value) { return typeof value === "string" && value.length > 0; }
function stringArray(value) { return Array.isArray(value) && value.every(nonEmpty); }

export function finiteCanonicalJsonRuntime(value, depth = 0) {
  return total(() => {
    if (depth > 16 || value === undefined) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") return isCanonicalUnicodeRuntime(value, 4096);
    if (Array.isArray(value)) return value.length <= 1024 && value.every((item) => finiteCanonicalJsonRuntime(item, depth + 1));
    if (!runtimeRecord(value) || Object.keys(value).length > 256) return false;
    return Object.entries(value).every(([key, item]) => isCanonicalUnicodeRuntime(key, 256) && finiteCanonicalJsonRuntime(item, depth + 1));
  }, false);
}

/** Exact buildsim hash-spec-v1 canonicalizer for the frozen U3 policies. */
function canonicalize(value, policy = {}, path = [], ancestors = new Set()) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (!isCanonicalUnicodeRuntime(value, Number.MAX_SAFE_INTEGER)) throw new TypeError("canonical string invalid");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical number invalid");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") throw new TypeError("canonical value is not JSON");
  if (ancestors.has(value)) throw new TypeError("canonical value is cyclic");
  ancestors.add(value);
  try {
    const keyPath = `/${path.join("/")}`;
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new TypeError("canonical array invalid");
      const items = value.map((item, index) => canonicalize(item, policy, [...path, String(index)], ancestors));
      if ((policy.setPaths ?? []).includes(keyPath)) {
        items.sort();
        if (items.some((item, index) => index > 0 && item === items[index - 1])) throw new TypeError("canonical set duplicates");
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) throw new TypeError("canonical object invalid");
    const entries = new Map();
    for (const [rawKey, item] of Object.entries(value)) {
      if (!isCanonicalUnicodeRuntime(rawKey, Number.MAX_SAFE_INTEGER)) throw new TypeError("canonical key invalid");
      const childPath = `/${[...path, rawKey].join("/")}`;
      if ((policy.excludedPaths ?? []).includes(childPath)) continue;
      if (entries.has(rawKey)) throw new TypeError("canonical key collision");
      entries.set(rawKey, item);
    }
    return `{${[...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item, policy, [...path, key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

const HASH_POLICIES = Object.freeze({
  listingCapture: { excludedPaths: ["/contentHash"] },
  factRecord: { setPaths: ["/evidenceRefs", "/derivedFromFactIds", "/assumptions"], excludedPaths: ["/contentHash"] },
  factSnapshot: { setPaths: ["/factRefs", "/conflictRefs"], excludedPaths: ["/snapshotId", "/contentHash"] },
  conflictSet: { setPaths: ["/factIds", "/resolutionFactIds", "/decisionIds"], excludedPaths: ["/contentHash"] },
  factInference: { setPaths: ["/inputFactRefs", "/outputFactIds", "/assumptions", "/invalidationConditions"], excludedPaths: ["/inferenceTraceId", "/contentHash"] },
  updateDecision: { setPaths: ["/planIds", "/oldFactIds", "/newFactIds", "/fieldDiffs", "/affectedDomains"], excludedPaths: ["/updateDecisionId", "/contentHash"] },
  evidenceClaim: { excludedPaths: ["/claimId", "/contentHash"] },
  observationSnapshot: { setPaths: ["/observationIds"], excludedPaths: ["/contentHash"] },
});

export function contentHashRuntime(value, domain, schemaVersion, policyName) {
  return total(() => {
    const policy = HASH_POLICIES[policyName];
    if (!policy || typeof domain !== "string" || typeof schemaVersion !== "string") return null;
    const canonical = canonicalize(value, policy);
    const preimage = `buildsim\u0000hash-spec-v1\u0000${domain}\u0000${schemaVersion}\u0000${canonical}`;
    return sha256Utf8Runtime(preimage);
  }, null);
}

/** Compatibility canonicalizer used by the immutable observation repository. */
export function legacyCanonicalJsonRuntime(value) {
  return total(() => {
    const ancestors = new Set();
    const normalize = (item) => {
      if (item === null || typeof item !== "object") return item;
      if (ancestors.has(item)) throw new TypeError("legacy value is cyclic");
      ancestors.add(item);
      try {
        if (Array.isArray(item)) return item.map(normalize);
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) throw new TypeError("legacy object invalid");
        return Object.fromEntries(Object.entries(item)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]));
      } finally { ancestors.delete(item); }
    };
    const result = JSON.stringify(normalize(value));
    if (result === undefined) throw new TypeError("legacy root invalid");
    return result;
  }, null);
}

export function legacySha256Runtime(value) {
  return total(() => {
    const canonical = legacyCanonicalJsonRuntime(value);
    return canonical === null ? null : sha256Utf8Runtime(canonical);
  }, null);
}

const FACET_DEFINITIONS = Object.freeze({
  "identity.category": ["string", []], "identity.manufacturer": ["string", []], "identity.model": ["string", []], "identity.revision": ["string", []],
  "physical.width": ["number", ["mm"]], "physical.height": ["number", ["mm"]], "physical.depth": ["number", ["mm"]],
  "mount.standard": ["string", []], "mount.point_ids": ["string_set", []], "cpu.socket": ["string", []],
  "motherboard.cpu_socket": ["string", []], "motherboard.chipset": ["string", []], "motherboard.memory_type": ["string", []],
  "motherboard.memory_slot_count": ["number", ["count"]], "motherboard.memory_population_rules": ["string_set", []], "motherboard.form_factor": ["string", []],
  "motherboard.bios_version": ["string", []], "motherboard.bios_upgrade_methods": ["string_set", []], "motherboard.display_outputs": ["string_set", []],
  "motherboard.supported_operating_systems": ["string_set", []], "memory.type": ["string", []], "memory.capacity": ["number", ["gib"]],
  "io.port_types": ["string_set", []], "io.header_types": ["string_set", []], "io.endpoint_ids": ["string_set", []],
  "case.motherboard_form_factors": ["string_set", []], "case.side_panel": ["string", []], "case.gpu_max_length": ["number", ["mm"]],
  "case.cpu_cooler_max_height": ["number", ["mm"]], "gpu.length": ["number", ["mm"]], "gpu.slot_width": ["number", ["slot"]],
  "gpu.power_connectors": ["string_set", []], "psu.capacity": ["number", ["w"]], "psu.connectors": ["string_set", []],
  "power.source_type": ["string", []], "power.load": ["number", ["w"]], "power.cable_families": ["string_set", []],
  "pcie.lane_count": ["number", ["count"]], "pcie.slot_types": ["string_set", []], "pcie.lane_sharing": ["string_set", []],
  "storage.interface": ["string", []], "storage.boot_support": ["boolean", []], "storage.capacity_bytes": ["number", ["byte"]], "storage.recording_technology": ["string", []], "hba.mode": ["string", []],
  "cooling.fan_mounts": ["string_set", []], "cooling.radiator_support": ["string_set", []], "cooling.pump_header": ["boolean", []],
  "firmware.version": ["string", []], "firmware.upgrade_path_refs": ["string_set", []], "driver.supported_operating_systems": ["string_set", []],
  "driver.package_versions": ["string_set", []], "thermal.curve_refs": ["string_set", []], "acoustic.curve_refs": ["string_set", []],
  "package.contents": ["string_set", []], "resource.kind": ["string", []], "cable.connector_standard": ["string_set", []],
  "fastener.thread": ["string", []], "fastener.length_mm": ["number", ["mm"]], "fastener.head": ["string", []],
  "tool.drive": ["string", []], "consumable.type": ["string", []], "accessory.standard": ["string", []],
  "acoustic.noise_class": ["string", []],
});
const ELECTRICAL_FACETS = new Set([
  "io.port_types", "io.header_types", "io.endpoint_ids", "gpu.power_connectors", "psu.capacity", "psu.connectors",
  "power.source_type", "power.load", "power.cable_families", "cooling.pump_header", "package.contents", "cable.connector_standard",
]);
const BOOT_FACETS = new Set([
  "cpu.socket", "motherboard.cpu_socket", "motherboard.chipset", "motherboard.memory_type", "motherboard.memory_slot_count",
  "motherboard.memory_population_rules", "motherboard.bios_version", "motherboard.bios_upgrade_methods", "motherboard.display_outputs",
  "motherboard.supported_operating_systems", "memory.type", "memory.capacity", "pcie.lane_count", "pcie.slot_types", "pcie.lane_sharing",
  "storage.interface", "storage.boot_support", "storage.capacity_bytes", "hba.mode", "firmware.version", "firmware.upgrade_path_refs", "driver.supported_operating_systems", "driver.package_versions",
]);
const INFORMATIONAL_FACETS = new Set(["thermal.curve_refs", "acoustic.curve_refs", "acoustic.noise_class"]);
const OBSERVATIONAL_PASS_FACETS = new Set([
  "physical.width", "physical.height", "physical.depth", "mount.point_ids", "case.side_panel", "case.gpu_max_length",
  "case.cpu_cooler_max_height", "gpu.length", "gpu.slot_width", "cooling.fan_mounts", "cooling.radiator_support",
  "resource.kind", "fastener.thread", "fastener.length_mm", "fastener.head", "tool.drive", "consumable.type", "accessory.standard",
  ...INFORMATIONAL_FACETS,
]);

function baseFieldPolicy(fieldId, definition) {
  const [valueType, unitIds] = definition;
  const sourcePolicy = ELECTRICAL_FACETS.has(fieldId) || BOOT_FACETS.has(fieldId)
    ? "official_required" : OBSERVATIONAL_PASS_FACETS.has(fieldId) ? "official_third_party_or_user_observation" : "official_or_standard";
  const safetyClass = ELECTRICAL_FACETS.has(fieldId) ? "electrical_safety" : INFORMATIONAL_FACETS.has(fieldId) ? "normal" : "compatibility_critical";
  const allowedScopes = fieldId === "identity.category" || fieldId === "identity.manufacturer" ? ["family", "model", "variant", "revision"]
    : fieldId === "identity.model" ? ["model", "variant", "revision"]
      : fieldId === "identity.revision" ? ["revision"]
        : sourcePolicy === "official_third_party_or_user_observation" ? ["variant", "revision", "plan_subject"] : ["variant", "revision"];
  const minimumProductPassScope = fieldId === "identity.category" || fieldId === "identity.manufacturer" ? "family"
    : fieldId === "identity.model" ? "model" : fieldId === "identity.revision" ? "revision" : "variant";
  const userObservationPassAllowed = sourcePolicy === "official_third_party_or_user_observation" && safetyClass !== "electrical_safety";
  const passAuthorities = sourcePolicy === "official_required" || sourcePolicy === "official_or_standard" ? ["official"]
    : userObservationPassAllowed ? ["official", "third_party", "user_observation"] : ["official", "third_party"];
  return Object.freeze({ schemaVersion: "fact-field-policy-v1", fieldId, valueType, unitIds: Object.freeze([...unitIds]), allowedScopes: Object.freeze(allowedScopes), safetyClass, sourcePolicy, passAuthorities: Object.freeze(passAuthorities), minimumProductPassScope, userObservationPassAllowed });
}

const EXTRA_FIELD_POLICIES = Object.freeze({
  "storage.recording_technology": { valueType: "string", unitIds: [], allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false },
  "hba.mode": { valueType: "string", unitIds: [], allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false },
  "package.contents": { valueType: "string_set", unitIds: [], allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false },
  "psu.pinout": { valueType: "structured", unitIds: [], allowedScopes: ["variant", "revision"], safetyClass: "electrical_safety", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false },
  "power.cable_wire_gauge": { valueType: "string", unitIds: [], allowedScopes: ["variant", "revision"], safetyClass: "electrical_safety", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false },
  "power.connector_current_rating": { valueType: "number", unitIds: ["a"], allowedScopes: ["variant", "revision"], safetyClass: "electrical_safety", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false },
  "firmware.cpu_support": { valueType: "structured", unitIds: [], allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false },
  "firmware.bridge_version": { valueType: "string", unitIds: [], allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false },
  "firmware.upgrade_method": { valueType: "string_set", unitIds: [], allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false },
  "firmware.file_hash": { valueType: "string", unitIds: [], allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false },
  "firmware.rollback_support": { valueType: "boolean", unitIds: [], allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false },
  "storage.logical_sector_size": { valueType: "number", unitIds: ["byte"], allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false },
  "storage.capacity_bytes": { valueType: "number", unitIds: ["byte"], allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false },
  "storage.physical_sector_size": { valueType: "number", unitIds: ["byte"], allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false },
  "storage.endurance_tbw": { valueType: "number", unitIds: ["tbw"], allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false },
  "package.fastener_count": { valueType: "structured", unitIds: [], allowedScopes: ["variant", "revision", "plan_subject"], safetyClass: "compatibility_critical", sourcePolicy: "official_third_party_or_user_observation", passAuthorities: ["official", "third_party", "user_observation"], minimumProductPassScope: "variant", userObservationPassAllowed: true },
  "package.tool_required": { valueType: "structured", unitIds: [], allowedScopes: ["variant", "revision", "plan_subject"], safetyClass: "compatibility_critical", sourcePolicy: "official_third_party_or_user_observation", passAuthorities: ["official", "third_party", "user_observation"], minimumProductPassScope: "variant", userObservationPassAllowed: true },
  "compatibility.qvl_entry": { valueType: "structured", unitIds: [], allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false },
  "io.port_topology": { valueType: "structured", unitIds: [], allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false },
  "package.cable_count": { valueType: "structured", unitIds: [], allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false },
  "thermal.fan_curve": { valueType: "structured", unitIds: [], allowedScopes: ["variant", "revision"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation", passAuthorities: ["official", "third_party"], minimumProductPassScope: "variant", userObservationPassAllowed: false },
  "thermal.airflow_curve": { valueType: "structured", unitIds: [], allowedScopes: ["variant", "revision"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation", passAuthorities: ["official", "third_party"], minimumProductPassScope: "variant", userObservationPassAllowed: false },
  "thermal.airflow_resistance": { valueType: "structured", unitIds: [], allowedScopes: ["variant", "revision", "plan_subject"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation", passAuthorities: ["official", "third_party", "user_observation"], minimumProductPassScope: "variant", userObservationPassAllowed: true },
  "thermal.design_power": { valueType: "number", unitIds: ["w"], allowedScopes: ["variant", "revision", "plan_subject"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation", passAuthorities: ["official", "third_party", "user_observation", "agent_inference"], minimumProductPassScope: "variant", userObservationPassAllowed: true },
  "thermal.case_to_air_resistance": { valueType: "structured", unitIds: [], allowedScopes: ["variant", "revision", "plan_subject"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation", passAuthorities: ["official", "third_party", "user_observation", "agent_inference"], minimumProductPassScope: "variant", userObservationPassAllowed: true },
  "thermal.maximum_temperature": { valueType: "number", unitIds: ["celsius"], allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false },
  "acoustic.sound_curve": { valueType: "structured", unitIds: [], allowedScopes: ["variant", "revision"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation", passAuthorities: ["official", "third_party"], minimumProductPassScope: "variant", userObservationPassAllowed: false },
  "acoustic.coil_whine_risk": { valueType: "structured", unitIds: [], allowedScopes: ["variant", "revision", "plan_subject"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation", passAuthorities: ["official", "third_party", "user_observation"], minimumProductPassScope: "variant", userObservationPassAllowed: true },
  "system.requirement": { valueType: "structured", unitIds: [], allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false },
  "physical.clearance": { valueType: "number", unitIds: ["mm"], allowedScopes: ["plan_subject"], safetyClass: "compatibility_critical", sourcePolicy: "official_third_party_or_user_observation", passAuthorities: ["user_observation"], minimumProductPassScope: "revision", userObservationPassAllowed: true },
});

export const FACT_FIELD_POLICY_RUNTIME = Object.freeze(Object.fromEntries([
  ...Object.entries(FACET_DEFINITIONS).map(([fieldId, definition]) => [fieldId, baseFieldPolicy(fieldId, definition)]),
  ...Object.entries(EXTRA_FIELD_POLICIES).map(([fieldId, policy]) => [fieldId, Object.freeze({ schemaVersion: "fact-field-policy-v1", fieldId, ...policy, unitIds: Object.freeze([...policy.unitIds]), allowedScopes: Object.freeze([...policy.allowedScopes]), passAuthorities: Object.freeze([...policy.passAuthorities]) })]),
]));

export function factFieldPolicyRuntime(fieldId) {
  return total(() => typeof fieldId === "string" && Object.prototype.hasOwnProperty.call(FACT_FIELD_POLICY_RUNTIME, fieldId)
    ? FACT_FIELD_POLICY_RUNTIME[fieldId] : null, null);
}

function validateFieldValue(policy, value, unit) {
  const errors = [];
  if (policy.unitIds.length === 0 ? unit !== undefined : typeof unit !== "string" || !policy.unitIds.includes(unit)) errors.push("fact unit does not match field policy");
  if (policy.valueType === "number" && (typeof value !== "number" || !Number.isFinite(value))) errors.push("fact value must be a finite number");
  else if (policy.valueType === "string" && (typeof value !== "string" || value.length === 0)) errors.push("fact value must be a non-empty string");
  else if (policy.valueType === "boolean" && typeof value !== "boolean") errors.push("fact value must be boolean");
  else if (policy.valueType === "string_set" && (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0) || new Set(value).size !== value.length)) errors.push("fact value must be a unique non-empty string set");
  else if (policy.valueType === "structured" && (!runtimeRecord(value) || Object.keys(value).length === 0)) errors.push("fact value must be a non-empty structured object");
  if (errors.length === 0) errors.push(...validateFormalFieldValue(policy.fieldId, value));
  return errors;
}

function governedFactId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/.test(value) && isCanonicalUnicodeRuntime(value, 256);
}

function exactFieldShape(value, fields) {
  return runtimeRecord(value) && Object.keys(value).every((key) => fields.includes(key)) && fields.every((key) => own(value, key));
}

/** Mirrors the safety-sensitive formal schemas in field-registry.ts. */
function validateFormalFieldValue(fieldId, value) {
  if (fieldId === "firmware.cpu_support") {
    if (!exactFieldShape(value, ["cpuSkuId", "boardRevision", "region", "sinceVersion"])
      || !governedFactId(value.cpuSkuId) || !governedFactId(value.boardRevision) || !governedFactId(value.region) || !governedFactId(value.sinceVersion)) return ["firmware cpu support value invalid"];
  }
  if (fieldId === "firmware.upgrade_method") {
    const allowed = new Set(["uefi", "flashback", "bmc", "in_os", "external_programmer"]);
    if (!Array.isArray(value) || value.some((item) => !allowed.has(String(item)))) return ["firmware upgrade method invalid"];
  }
  if (fieldId === "firmware.file_hash" && !isSha256HexRuntime(value)) return ["firmware file hash invalid"];
  if (fieldId === "storage.capacity_bytes"
    && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) return ["storage capacity invalid"];
  if ((fieldId === "storage.logical_sector_size" || fieldId === "storage.physical_sector_size")
    && (typeof value !== "number" || !Number.isInteger(value) || value < 512 || value > 65536 || (value & (value - 1)) !== 0)) return ["storage sector size invalid"];
  if (fieldId === "storage.endurance_tbw" && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) return ["storage endurance invalid"];
  if (fieldId === "storage.recording_technology" && !["cmr", "smr", "slc", "mlc", "tlc", "qlc"].includes(String(value))) return ["storage recording technology invalid"];
  if (fieldId === "hba.mode" && !["it", "ir", "raid"].includes(String(value))) return ["hba mode invalid"];
  if (fieldId === "package.contents" && (!Array.isArray(value) || value.some((item) => !governedFactId(item)))) return ["package contents invalid"];
  if (fieldId === "package.fastener_count") {
    if (!exactFieldShape(value, ["fastenerId", "quantity"]) || !governedFactId(value.fastenerId)
      || !Number.isSafeInteger(value.quantity) || value.quantity < 0) return ["package fastener count invalid"];
  }
  if (fieldId === "package.tool_required") {
    if (!exactFieldShape(value, ["toolId", "required"]) || !governedFactId(value.toolId) || typeof value.required !== "boolean") return ["package tool requirement invalid"];
  }
  if (fieldId === "compatibility.qvl_entry") {
    if (!exactFieldShape(value, ["componentSkuId", "boardRevision", "region", "sinceVersion", "status"])
      || !governedFactId(value.componentSkuId) || !governedFactId(value.boardRevision) || !governedFactId(value.region)
      || !governedFactId(value.sinceVersion) || value.status !== "qualified") return ["compatibility QVL entry invalid"];
  }
  if (fieldId === "io.port_topology") {
    if (!exactFieldShape(value, ["endpointId", "connectorType", "location", "controllerId", "pathId", "quantity"])
      || !governedFactId(value.endpointId) || !governedFactId(value.connectorType)
      || !["internal", "rear", "front", "external"].includes(String(value.location))
      || !governedFactId(value.controllerId) || !governedFactId(value.pathId)
      || !Number.isSafeInteger(value.quantity) || value.quantity < 1 || value.quantity > 1024) return ["I/O port topology invalid"];
  }
  if (fieldId === "package.cable_count") {
    if (!exactFieldShape(value, ["cableId", "connectorFamily", "quantity"])
      || !governedFactId(value.cableId) || !governedFactId(value.connectorFamily)
      || !Number.isSafeInteger(value.quantity) || value.quantity < 0 || value.quantity > 1024) return ["package cable count invalid"];
  }
  if (fieldId === "thermal.fan_curve") {
    const points = runtimeRecord(value) && Array.isArray(value.points) ? value.points : [];
    if (!exactFieldShape(value, ["curveId", "input", "output", "points"])
      || !governedFactId(value.curveId) || value.input !== "temperature_c" || value.output !== "duty_percent"
      || points.length < 2 || points.length > 32 || points.some((point, index) => !exactFieldShape(point, ["input", "output"])
        || typeof point.input !== "number" || !Number.isFinite(point.input) || point.input < -50 || point.input > 200
        || typeof point.output !== "number" || !Number.isFinite(point.output) || point.output < 0 || point.output > 100
        || (index > 0 && Number(points[index - 1]?.input) >= point.input))) return ["thermal fan curve invalid"];
  }
  if (fieldId === "thermal.airflow_curve") {
    const points = runtimeRecord(value) && Array.isArray(value.points) ? value.points : [];
    if (!exactFieldShape(value, ["curveId", "uncertaintyFraction", "points"]) || !governedFactId(value.curveId)
      || typeof value.uncertaintyFraction !== "number" || !Number.isFinite(value.uncertaintyFraction)
      || value.uncertaintyFraction < 0 || value.uncertaintyFraction > 1 || points.length < 2 || points.length > 64
      || points.some((point, index) => !exactFieldShape(point, ["airflowCfm", "staticPressurePa", "rpm"])
        || [point.airflowCfm, point.staticPressurePa, point.rpm].some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || entry < 0)
        || (index > 0 && Number(points[index - 1]?.airflowCfm) >= point.airflowCfm))) return ["thermal airflow curve invalid"];
  }
  if (fieldId === "thermal.airflow_resistance" || fieldId === "thermal.case_to_air_resistance") {
    if (!exactFieldShape(value, ["lo", "hi"]) || typeof value.lo !== "number" || !Number.isFinite(value.lo)
      || typeof value.hi !== "number" || !Number.isFinite(value.hi) || value.lo < 0 || value.lo > value.hi) return [`${fieldId} interval invalid`];
  }
  if (fieldId === "thermal.design_power" && (typeof value !== "number" || value < 0 || value > 10000)) return ["thermal design power invalid"];
  if (fieldId === "thermal.maximum_temperature" && (typeof value !== "number" || value < -50 || value > 250)) return ["thermal maximum temperature invalid"];
  if (fieldId === "acoustic.sound_curve") {
    const points = runtimeRecord(value) && Array.isArray(value.points) ? value.points : [];
    if (!exactFieldShape(value, ["curveId", "weighting", "referenceDistanceM", "loadId", "testMethodId", "points"])
      || !governedFactId(value.curveId) || value.weighting !== "A" || typeof value.referenceDistanceM !== "number"
      || !Number.isFinite(value.referenceDistanceM) || value.referenceDistanceM <= 0 || !governedFactId(value.loadId)
      || !governedFactId(value.testMethodId) || points.length < 2 || points.length > 64
      || points.some((point, index) => !exactFieldShape(point, ["rpm", "lo", "hi"])
        || [point.rpm, point.lo, point.hi].some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
        || point.rpm < 0 || point.lo < 0 || point.lo > point.hi || (index > 0 && Number(points[index - 1]?.rpm) >= point.rpm))) return ["acoustic sound curve invalid"];
  }
  if (fieldId === "acoustic.coil_whine_risk") {
    if (!exactFieldShape(value, ["risk", "note"]) || !["unknown", "reported", "observed"].includes(String(value.risk))
      || typeof value.note !== "string" || value.note.trim().length === 0) return ["acoustic coil whine risk invalid"];
  }
  if (fieldId === "system.requirement") {
    const fields = ["systemProfileId", "releaseId", "requirementId", "operator", "valueType", "value", "unit"];
    const required = fields.filter((field) => field !== "unit");
    const shapes = {
      "memory.minimum": { valueType: "number", operator: "gte", unit: "gib" },
      "boot_pool.device_count": { valueType: "number", operator: "gte", unit: "count" },
      "hba.mode": { valueType: "string", operator: "eq", unit: undefined },
      "storage.disk_locator.required": { valueType: "boolean", operator: "eq", unit: undefined },
    };
    const releases = {
      "system-release.windows-11.24h2": "system.windows-11",
      "system-release.truenas-scale.25.04": "system.truenas-scale",
      "system-release.proxmox-ve.9": "system.proxmox-ve",
    };
    const shape = runtimeRecord(value) ? shapes[value.requirementId] : null;
    if (!runtimeRecord(value) || Object.keys(value).some((key) => !fields.includes(key)) || required.some((key) => !own(value, key))
      || !governedFactId(value.systemProfileId) || !governedFactId(value.releaseId) || !governedFactId(value.requirementId)
      || !shape || releases[value.releaseId] !== value.systemProfileId || value.valueType !== shape.valueType
      || value.operator !== shape.operator || value.unit !== shape.unit || (value.unit !== undefined && !["gib", "count"].includes(value.unit))
      || (shape.valueType === "number" && (typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0))
      || (shape.valueType === "string" && !governedFactId(value.value))
      || (shape.valueType === "boolean" && typeof value.value !== "boolean")) return ["system requirement invalid"];
  }
  if (fieldId === "psu.pinout") {
    if (!exactFieldShape(value, ["connectorFamily", "revision", "pinCount", "pinMapHash"])
      || !governedFactId(value.connectorFamily) || !governedFactId(value.revision)
      || !Number.isSafeInteger(value.pinCount) || value.pinCount <= 0 || !isSha256HexRuntime(value.pinMapHash)) return ["PSU pinout value invalid"];
  }
  return [];
}

export function validateObservationSubjectRefRuntime(value) {
  return total(() => {
    if (!runtimeRecord(value)) return ["subjectRef invalid"];
    const expected = {
      plan: ["kind"], instance: ["kind", "instanceId"], placement: ["kind", "placementId"], connection: ["kind", "connectionId"],
      port: ["kind", "instanceId", "portId"], mount: ["kind", "ownerInstanceId", "mountId"], firmware_instance: ["kind", "instanceId"],
    };
    const fields = typeof value.kind === "string" ? expected[value.kind] : undefined;
    if (!fields) return ["subjectRef kind invalid"];
    if (Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))) return ["subjectRef fields invalid"];
    return fields.filter((field) => field !== "kind" && !nonEmpty(value[field])).map((field) => `subjectRef.${field} missing`);
  }, ["subjectRef validation failed"]);
}

function validateFactSubject(value) {
  if (!runtimeRecord(value)) return ["subject invalid"];
  if (value.kind === "plan_subject") {
    const errors = [];
    if (!onlyKeys(value, ["kind", "planId", "subjectRef"]) || !nonEmpty(value.planId)) errors.push("plan subject invalid");
    errors.push(...validateObservationSubjectRefRuntime(value.subjectRef).map((error) => `plan subject ${error}`));
    return errors;
  }
  if (value.kind === "product") {
    const errors = [];
    if (!onlyKeys(value, ["kind", "skuId", "revision", "region", "familyId", "modelId", "variantId"]) || !nonEmpty(value.skuId)) errors.push("product subject invalid");
    for (const key of ["revision", "region", "familyId", "modelId", "variantId"]) if (value[key] !== undefined && !nonEmpty(value[key])) errors.push(`product subject ${key} invalid`);
    return errors;
  }
  return ["subject kind invalid"];
}

function validateGovernedFactSubject(value) {
  const errors = validateFactSubject(value);
  if (!runtimeRecord(value)) return errors;
  for (const [key, item] of Object.entries(value)) {
    if (key === "subjectRef" || key === "kind") continue;
    if (!isCanonicalUnicodeRuntime(item, 256)) errors.push(`subject ${key} must be canonical Unicode`);
  }
  if (runtimeRecord(value.subjectRef)) for (const [key, item] of Object.entries(value.subjectRef)) {
    if (key !== "kind" && !isCanonicalUnicodeRuntime(item, 256)) errors.push(`subjectRef.${key} must be canonical Unicode`);
  }
  return errors;
}

export function validateFactRecordRuntime(value) {
  return total(() => {
    if (!runtimeRecord(value)) return ["fact must be an object"];
    const errors = [];
    const allowed = ["schemaVersion", "factId", "subject", "field", "value", "unit", "scope", "authority", "safetyClass", "status", "evidenceRefs", "derivedFromFactIds", "inferenceTraceId", "extractorOrRuleVersion", "assumptions", "confidence", "retrievedAt", "validFrom", "validUntil", "supersedesFactId", "supersededFactHash", "contentHash"];
    if (!onlyKeys(value, allowed)) errors.push("fact contains unknown fields");
    if (value.schemaVersion !== "fact-record-v1") errors.push("fact schemaVersion invalid");
    if (!isCanonicalUnicodeRuntime(value.factId, 256) || !FACT_ID.test(String(value.factId ?? ""))) errors.push("factId invalid");
    if (!isCanonicalUnicodeRuntime(value.field, 256)) errors.push("fact field invalid");
    const policy = factFieldPolicyRuntime(value.field);
    if (!policy) errors.push("fact field is not governed");
    if (!own(value, "value")) errors.push("fact value missing");
    else if (!finiteCanonicalJsonRuntime(value.value)) errors.push("fact value must be finite canonical JSON");
    if (policy) {
      errors.push(...validateFieldValue(policy, value.value, value.unit));
      if (value.safetyClass !== policy.safetyClass) errors.push("fact safetyClass must be derived from field policy");
      if (!policy.allowedScopes.includes(value.scope)) errors.push("fact scope is not allowed by field policy");
      if (value.authority === "user_observation" && !policy.userObservationPassAllowed) errors.push("field policy forbids user observation authority");
    }
    if (!["family", "model", "variant", "revision", "plan_subject"].includes(String(value.scope))) errors.push("fact scope invalid");
    if (!["official", "third_party", "user_observation", "agent_inference"].includes(String(value.authority))) errors.push("fact authority invalid");
    if (!["normal", "compatibility_critical", "electrical_safety"].includes(String(value.safetyClass))) errors.push("fact safetyClass invalid");
    if (!["active", "superseded", "conflicted", "unresolved_blocker"].includes(String(value.status))) errors.push("fact status invalid");
    errors.push(...validateGovernedFactSubject(value.subject));
    if (runtimeRecord(value.subject) && value.subject.kind === "plan_subject") {
      if (value.scope !== "plan_subject") errors.push("plan subject facts must use plan_subject scope");
      if (value.authority !== "user_observation" && value.authority !== "agent_inference") errors.push("plan subject fact authority invalid");
    } else if (runtimeRecord(value.subject) && value.subject.kind === "product") {
      if (value.scope === "plan_subject") errors.push("product fact cannot use plan_subject scope");
      if (value.authority === "user_observation") errors.push("user observation cannot become a global product fact");
      if (value.scope === "revision" && !isCanonicalUnicodeRuntime(value.subject.revision, 256)) errors.push("revision-scoped fact requires exact revision");
      if ((value.scope === "variant" || value.scope === "revision") && !isCanonicalUnicodeRuntime(value.subject.skuId, 256)) errors.push("variant/revision fact requires exact SKU");
    }
    if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((ref) => !isCanonicalUnicodeRuntime(ref, 256)) || new Set(value.evidenceRefs).size !== value.evidenceRefs.length) errors.push("fact evidence refs invalid");
    if (!stringArray(value.derivedFromFactIds) || new Set(value.derivedFromFactIds).size !== value.derivedFromFactIds.length) errors.push("fact derivation refs invalid");
    if (value.assumptions !== undefined && (!stringArray(value.assumptions) || value.assumptions.some((item) => !isCanonicalUnicodeRuntime(item, 1024)))) errors.push("fact assumptions invalid");
    if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) errors.push("confidence must be between 0 and 1");
    if (!isIsoTimestampRuntime(value.retrievedAt)) errors.push("fact retrievedAt invalid");
    if (value.validFrom !== undefined && !isIsoTimestampRuntime(value.validFrom)) errors.push("fact validFrom invalid");
    if (value.validUntil !== undefined && !isIsoTimestampRuntime(value.validUntil)) errors.push("fact validUntil invalid");
    if (isIsoTimestampRuntime(value.validFrom) && isIsoTimestampRuntime(value.validUntil) && Date.parse(value.validUntil) < Date.parse(value.validFrom)) errors.push("fact validity interval invalid");
    if (!isSha256HexRuntime(value.contentHash)) errors.push("fact contentHash invalid");
    const evidence = Array.isArray(value.evidenceRefs) ? value.evidenceRefs : [];
    if (value.authority === "official" || value.authority === "third_party") {
      if (evidence.length === 0 || evidence.some((ref) => !/^claim-sha256-[a-f0-9]{64}$/.test(String(ref)))) errors.push("source fact requires content-addressed evidence claims");
    }
    if (value.authority === "user_observation") {
      if (evidence.length === 0 || evidence.some((ref) => !OBSERVATION_REF.test(String(ref)))) errors.push("user observation fact requires content-addressed observation evidence");
    }
    if (value.authority === "agent_inference") {
      if (!Array.isArray(value.derivedFromFactIds) || value.derivedFromFactIds.length === 0
        || !/^inference-sha256-[a-f0-9]{64}$/.test(String(value.inferenceTraceId))
        || !isCanonicalUnicodeRuntime(value.extractorOrRuleVersion, 256) || !Array.isArray(value.assumptions)) errors.push("agent inference must be replayable from a trace, facts, version and assumptions");
    } else if (value.extractorOrRuleVersion !== undefined || value.inferenceTraceId !== undefined) errors.push("only agent inference may carry inference trace/version");
    const supersessionPresent = value.supersedesFactId !== undefined || value.supersededFactHash !== undefined;
    if (supersessionPresent) {
      if (value.status !== "active") errors.push("only an active replacement fact may declare supersession");
      if (!isCanonicalUnicodeRuntime(value.supersedesFactId, 256) || !isSha256HexRuntime(value.supersededFactHash)) errors.push("replacement fact requires old fact ID and hash");
      if (value.supersedesFactId === value.factId) errors.push("fact cannot supersede itself");
    }
    return errors;
  }, ["fact runtime validation failed"]);
}

export function verifyFactRecordRuntime(value) {
  return total(() => {
    if (validateFactRecordRuntime(value).length) return false;
    return value.contentHash === contentHashRuntime(value, "fact-record", "fact-record-v1", "factRecord");
  }, false);
}

export function validateConflictSetRuntime(value) {
  return total(() => {
    if (!runtimeRecord(value)) return ["conflict set must be an object"];
    const errors = [];
    const allowed = ["schemaVersion", "conflictSetId", "subject", "field", "factIds", "reason", "status", "resolutionFactIds", "decisionIds", "createdAt", "resolvedAt", "contentHash"];
    if (!onlyKeys(value, allowed)) errors.push("conflict set contains unknown fields");
    if (value.schemaVersion !== "fact-conflict-v1") errors.push("conflict set schemaVersion invalid");
    for (const field of ["conflictSetId", "field"]) if (!isCanonicalUnicodeRuntime(value[field], 256)) errors.push(`conflict set ${field} invalid`);
    if (!isIsoTimestampRuntime(value.createdAt)) errors.push("conflict set createdAt invalid");
    errors.push(...validateFactSubject(value.subject).map((error) => `conflict set ${error}`));
    if (!Array.isArray(value.factIds) || value.factIds.some((id) => !isCanonicalUnicodeRuntime(id, 256)) || new Set(value.factIds).size < 2) errors.push("conflict set requires at least two distinct facts");
    if (!["official_internal", "official_vs_third_party", "revision", "region", "value_disagreement"].includes(String(value.reason))) errors.push("conflict set reason invalid");
    if (value.status !== "open" && value.status !== "resolved") errors.push("conflict set status invalid");
    if (!Array.isArray(value.resolutionFactIds) || value.resolutionFactIds.some((id) => !isCanonicalUnicodeRuntime(id, 256))
      || !Array.isArray(value.decisionIds) || value.decisionIds.some((id) => !/^update-decision-sha256-[a-f0-9]{64}$/.test(String(id)))
      || (Array.isArray(value.resolutionFactIds) && new Set(value.resolutionFactIds).size !== value.resolutionFactIds.length)
      || (Array.isArray(value.decisionIds) && new Set(value.decisionIds).size !== value.decisionIds.length)) errors.push("conflict set resolution refs invalid");
    if (value.resolvedAt !== undefined && !isIsoTimestampRuntime(value.resolvedAt)) errors.push("conflict set resolvedAt invalid");
    if (value.status === "open" && ((Array.isArray(value.resolutionFactIds) && value.resolutionFactIds.length > 0)
      || (Array.isArray(value.decisionIds) && value.decisionIds.length > 0) || value.resolvedAt !== undefined)) errors.push("open conflict cannot carry a resolution");
    if (value.status === "resolved" && (!Array.isArray(value.resolutionFactIds) || value.resolutionFactIds.length === 0
      || !Array.isArray(value.decisionIds) || value.decisionIds.length === 0 || !isIsoTimestampRuntime(value.resolvedAt))) errors.push("resolved conflict requires resolution facts, decisions and time");
    if (isIsoTimestampRuntime(value.createdAt) && isIsoTimestampRuntime(value.resolvedAt) && Date.parse(value.resolvedAt) < Date.parse(value.createdAt)) errors.push("conflict set resolution predates creation");
    if (!isSha256HexRuntime(value.contentHash)) errors.push("conflict set contentHash invalid");
    return errors;
  }, ["conflict set runtime validation failed"]);
}

export function verifyConflictSetRuntime(value) {
  return total(() => validateConflictSetRuntime(value).length === 0
    && value.contentHash === contentHashRuntime(value, "fact-conflict", "fact-conflict-v1", "conflictSet"), false);
}

function canonicalStringArray(value, maxLength = 256, requireNonEmpty = false) {
  return Array.isArray(value) && (!requireNonEmpty || value.length > 0)
    && value.every((item) => isCanonicalUnicodeRuntime(item, maxLength));
}

/** Total JavaScript projection of the immutable replayable inference trace contract. */
export function validateReplayableInferenceTraceRuntime(value) {
  return total(() => {
    if (!runtimeRecord(value)) return ["inference trace must be an object"];
    const errors = [];
    const allowed = ["schemaVersion", "inferenceTraceId", "inputFactRefs", "outputFactIds", "engine", "ruleOrModelId", "ruleOrModelVersion", "ruleOrModelArtifactHash", "assumptions", "confidence", "outputRange", "invalidationConditions", "createdAt", "contentHash"];
    if (!onlyKeys(value, allowed)) errors.push("inference trace contains unknown fields");
    if (value.schemaVersion !== "fact-inference-v1") errors.push("inference trace schemaVersion invalid");
    if (!isSha256HexRuntime(value.contentHash) || !/^inference-sha256-[a-f0-9]{64}$/.test(String(value.inferenceTraceId))
      || value.inferenceTraceId !== `inference-sha256-${String(value.contentHash)}`) errors.push("inference trace content identity invalid");
    if (!Array.isArray(value.inputFactRefs) || value.inputFactRefs.length === 0) errors.push("inference trace input facts invalid");
    else {
      const ids = new Set();
      for (const reference of value.inputFactRefs) {
        if (!runtimeRecord(reference) || !onlyKeys(reference, ["factId", "contentHash"])
          || !isCanonicalUnicodeRuntime(reference.factId, 256) || !isSha256HexRuntime(reference.contentHash)) {
          errors.push("inference trace input fact ref invalid");
        } else if (ids.has(reference.factId)) errors.push("inference trace input facts duplicated");
        else ids.add(reference.factId);
      }
    }
    if (!canonicalStringArray(value.outputFactIds, 256, true) || new Set(value.outputFactIds ?? []).size !== (value.outputFactIds ?? []).length) errors.push("inference trace output fact IDs invalid");
    if (value.engine !== "rule" && value.engine !== "model") errors.push("inference trace engine invalid");
    if (!isCanonicalUnicodeRuntime(value.ruleOrModelId, 256) || !isCanonicalUnicodeRuntime(value.ruleOrModelVersion, 256)
      || !isSha256HexRuntime(value.ruleOrModelArtifactHash)) errors.push("inference trace rule/model artifact invalid");
    if (!canonicalStringArray(value.assumptions, 1024) || new Set(value.assumptions ?? []).size !== (value.assumptions ?? []).length) errors.push("inference trace assumptions invalid");
    if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) errors.push("inference trace confidence invalid");
    if (value.outputRange !== undefined && (!runtimeRecord(value.outputRange) || !onlyKeys(value.outputRange, ["min", "max", "unit"])
      || typeof value.outputRange.min !== "number" || !Number.isFinite(value.outputRange.min)
      || typeof value.outputRange.max !== "number" || !Number.isFinite(value.outputRange.max) || value.outputRange.min > value.outputRange.max
      || (value.outputRange.unit !== undefined && !isCanonicalUnicodeRuntime(value.outputRange.unit, 64)))) errors.push("inference trace output range invalid");
    if (!canonicalStringArray(value.invalidationConditions, 1024, true) || new Set(value.invalidationConditions ?? []).size !== (value.invalidationConditions ?? []).length) errors.push("inference trace invalidation conditions invalid");
    if (!isIsoTimestampRuntime(value.createdAt)) errors.push("inference trace createdAt invalid");
    return errors;
  }, ["inference trace runtime validation failed"]);
}

export function verifyReplayableInferenceTraceRuntime(value) {
  return total(() => validateReplayableInferenceTraceRuntime(value).length === 0
    && value.contentHash === contentHashRuntime(value, "fact-inference", "fact-inference-v1", "factInference")
    && value.inferenceTraceId === `inference-sha256-${value.contentHash}`, false);
}

function validateUpdateDecisionSnapshotRefRuntime(value, label) {
  if (!runtimeRecord(value) || !onlyKeys(value, ["snapshotId", "contentHash"])
    || !isCanonicalUnicodeRuntime(value.snapshotId, 256) || !isSha256HexRuntime(value.contentHash)
    || value.snapshotId !== `fact-snapshot-sha256-${value.contentHash}`) return [`update decision ${label} invalid`];
  return [];
}

/** Total JavaScript projection of the immutable fact-update decision contract. */
export function validateUpdateDecisionRuntime(value) {
  return total(() => {
    if (!runtimeRecord(value)) return ["update decision must be an object"];
    const errors = [];
    const allowed = ["schemaVersion", "updateDecisionId", "subjectKey", "claimKey", "revision", "memoryRevision", "planIds", "oldSnapshotRef", "newSnapshotRef", "oldFactIds", "newFactIds", "fieldDiffs", "affectedDomains", "decision", "decidedBy", "decidedAt", "supersedesDecisionId", "supersedesDecisionHash", "safetyWarningRetained", "contentHash"];
    if (!onlyKeys(value, allowed)) errors.push("update decision contains unknown fields");
    if (value.schemaVersion !== "fact-update-decision-v1") errors.push("update decision schemaVersion invalid");
    for (const field of ["updateDecisionId", "subjectKey", "claimKey", "revision"]) if (!isCanonicalUnicodeRuntime(value[field], 256)) errors.push("update decision memory key incomplete");
    if (!isIsoTimestampRuntime(value.decidedAt)) errors.push("update decision decidedAt invalid");
    if (!Number.isInteger(value.memoryRevision) || value.memoryRevision < 0) errors.push("update decision memoryRevision invalid");
    if (!canonicalStringArray(value.planIds, 256, true) || new Set(value.planIds ?? []).size !== (value.planIds ?? []).length) errors.push("update decision planIds invalid");
    errors.push(...validateUpdateDecisionSnapshotRefRuntime(value.oldSnapshotRef, "oldSnapshotRef"));
    errors.push(...validateUpdateDecisionSnapshotRefRuntime(value.newSnapshotRef, "newSnapshotRef"));
    if (!canonicalStringArray(value.oldFactIds, 256, true) || !canonicalStringArray(value.newFactIds, 256, true)) errors.push("update decision must retain old/new facts and field diffs");
    if (!Array.isArray(value.fieldDiffs) || value.fieldDiffs.length === 0) errors.push("update decision must retain old/new facts and field diffs");
    else for (const [index, diff] of value.fieldDiffs.entries()) {
      if (!runtimeRecord(diff) || !onlyKeys(diff, ["field", "beforeFactIds", "afterFactIds"])
        || !isCanonicalUnicodeRuntime(diff.field, 256) || !canonicalStringArray(diff.beforeFactIds, 256) || !canonicalStringArray(diff.afterFactIds, 256)) errors.push(`update decision fieldDiffs.${index} invalid`);
    }
    const domains = new Set(["identity", "mechanical", "electrical", "firmware", "system", "storage", "assembly", "commissioning", "routing", "thermal", "acoustic", "procurement"]);
    if (!Array.isArray(value.affectedDomains) || value.affectedDomains.some((domain) => !domains.has(domain))) errors.push("update decision affectedDomains invalid");
    if (!["accept", "reject", "defer", "undo"].includes(value.decision)) errors.push("update decision invalid");
    if (value.decidedBy !== "user") errors.push("update decision must be made by user");
    if (typeof value.safetyWarningRetained !== "boolean") errors.push("update decision safetyWarningRetained invalid");
    const supersessionPresent = value.supersedesDecisionId !== undefined || value.supersedesDecisionHash !== undefined;
    if (supersessionPresent && (!isCanonicalUnicodeRuntime(value.supersedesDecisionId, 256) || !isSha256HexRuntime(value.supersedesDecisionHash)
      || value.supersedesDecisionId !== `update-decision-sha256-${value.supersedesDecisionHash}`)) errors.push("update decision supersession closure invalid");
    if (value.memoryRevision === 0 && supersessionPresent) errors.push("initial update decision cannot supersede another decision");
    if (value.memoryRevision > 0 && !supersessionPresent) errors.push("revised update decision requires previous decision ID and hash");
    if ((value.decision === "reject" || value.decision === "defer") && !value.safetyWarningRetained) errors.push("rejecting or deferring an update must retain its safety warning");
    if (value.decision === "undo" && (!supersessionPresent || !value.safetyWarningRetained)) errors.push("undo must retain the warning and supersede a prior decision");
    if (!isSha256HexRuntime(value.contentHash) || value.updateDecisionId !== `update-decision-sha256-${value.contentHash}`) errors.push("update decision content identity invalid");
    return errors;
  }, ["update decision runtime validation failed"]);
}

export function verifyUpdateDecisionRuntime(value) {
  return total(() => validateUpdateDecisionRuntime(value).length === 0
    && value.contentHash === contentHashRuntime(value, "fact-update-decision", "fact-update-decision-v1", "updateDecision")
    && value.updateDecisionId === `update-decision-sha256-${value.contentHash}`, false);
}

export function selectedFactSnapshotRefRuntime(value) {
  return total(() => {
    if (validateUpdateDecisionRuntime(value).length) return null;
    const reference = value.decision === "accept" ? value.newSnapshotRef : value.oldSnapshotRef;
    return { snapshotId: reference.snapshotId, contentHash: reference.contentHash };
  }, null);
}

/** Total validation for the current-memory authority maintained by UpdateDecisionRepository. */
export function validateUpdateDecisionMemoryRuntime(value, expectedMemoryKey = undefined) {
  return total(() => {
    if (!runtimeRecord(value)) return ["update decision memory must be an object"];
    const errors = [];
    if (!onlyKeys(value, ["schemaVersion", "memoryKey", "revision", "decisionId", "decisionHash", "selectedSnapshotRef", "updatedAt"])) errors.push("update decision memory contains unknown fields");
    if (value.schemaVersion !== "fact-update-memory-v1") errors.push("update decision memory schema invalid");
    if (!isSha256HexRuntime(value.memoryKey) || (expectedMemoryKey !== undefined && value.memoryKey !== expectedMemoryKey)) errors.push("update decision memory key invalid");
    if (!Number.isInteger(value.revision) || value.revision < 0) errors.push("update decision memory revision invalid");
    if (!/^update-decision-sha256-[a-f0-9]{64}$/.test(String(value.decisionId)) || !isSha256HexRuntime(value.decisionHash)
      || value.decisionId !== `update-decision-sha256-${value.decisionHash}`) errors.push("update decision memory decision identity invalid");
    errors.push(...validateUpdateDecisionSnapshotRefRuntime(value.selectedSnapshotRef, "selectedSnapshotRef"));
    if (!isIsoTimestampRuntime(value.updatedAt)) errors.push("update decision memory updatedAt invalid");
    return errors;
  }, ["update decision memory runtime validation failed"]);
}

export function validateFactSnapshotRuntime(value) {
  return total(() => {
    if (!runtimeRecord(value)) return ["fact snapshot must be an object"];
    const errors = [];
    if (!onlyKeys(value, ["schemaVersion", "snapshotId", "factRefs", "conflictRefs", "createdAt", "contentHash"])) errors.push("fact snapshot contains unknown fields");
    if (value.schemaVersion !== "fact-snapshot-v2") errors.push("fact snapshot schemaVersion invalid");
    if (!isCanonicalUnicodeRuntime(value.snapshotId, 256) || !/^fact-snapshot-sha256-[a-f0-9]{64}$/.test(String(value.snapshotId))) errors.push("fact snapshot ID invalid");
    if (!isIsoTimestampRuntime(value.createdAt)) errors.push("fact snapshot createdAt invalid");
    if (!isSha256HexRuntime(value.contentHash) || value.snapshotId !== `fact-snapshot-sha256-${String(value.contentHash)}`) errors.push("fact snapshot content identity invalid");
    const validateRefs = (refs, idKey, label) => {
      if (!Array.isArray(refs)) { errors.push(`fact snapshot ${label} invalid`); return; }
      const ids = new Set();
      for (const ref of refs) {
        if (!runtimeRecord(ref) || !onlyKeys(ref, [idKey, "contentHash"]) || !isCanonicalUnicodeRuntime(ref[idKey], 256) || !isSha256HexRuntime(ref.contentHash)) {
          errors.push(`fact snapshot ${label} invalid`); continue;
        }
        if (ids.has(ref[idKey])) errors.push(`fact snapshot ${label} contains duplicate IDs`);
        ids.add(ref[idKey]);
      }
    };
    validateRefs(value.factRefs, "factId", "factRefs"); validateRefs(value.conflictRefs, "conflictSetId", "conflictRefs");
    return errors;
  }, ["fact snapshot runtime validation failed"]);
}

export function verifyFactSnapshotRuntime(value) {
  return total(() => {
    if (validateFactSnapshotRuntime(value).length) return false;
    const hash = contentHashRuntime(value, "fact-snapshot", "fact-snapshot-v2", "factSnapshot");
    return hash !== null && value.contentHash === hash && value.snapshotId === `fact-snapshot-sha256-${hash}`;
  }, false);
}

export function parseObservationReferenceRuntime(value) {
  return total(() => {
    const match = typeof value === "string" ? OBSERVATION_REF.exec(value) : null;
    return match ? { observationId: match[1], contentHash: match[2] } : null;
  }, null);
}

export function factsRuntimeSubjectMatchesClaim(subject, claim) {
  // Claims bind a governed product identity, not a loose SKU-family match.
  // The TypeScript repository deliberately removes only the FactSubject
  // discriminator and then requires exact canonical equality; preserving that
  // here prevents a checksum-valid fact from silently dropping region,
  // revision, variant, or model authority.
  return total(() => {
    if (!runtimeRecord(subject) || subject.kind !== "product" || !runtimeRecord(claim?.subject)) return false;
    const { kind: _kind, ...identity } = subject;
    return canonicalize(identity) === canonicalize(claim.subject);
  }, false);
}

export function factsRuntimeSubjectMatchesObservation(subject, observation, sameJson) {
  return total(() => runtimeRecord(subject) && subject.kind === "plan_subject" && runtimeRecord(observation)
    && subject.planId === observation.planId && typeof sameJson === "function" && sameJson(subject.subjectRef, observation.subjectRef), false);
}
