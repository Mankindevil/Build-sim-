import {
  CAPABILITY_FACET_REGISTRY,
  FACET_REGISTRY,
  SYSTEM_PROFILE_REGISTRY,
  SYSTEM_RELEASE_REGISTRY,
  UNIT_REGISTRY,
  type FacetId,
  type RegistrySourcePolicy,
  type RegistryValueType,
} from "../contracts/registries";

export type FactSafetyClass = "normal" | "compatibility_critical" | "electrical_safety";
export type FactScope = "family" | "model" | "variant" | "revision" | "plan_subject";
export type FactAuthority = "official" | "third_party" | "user_observation" | "agent_inference";

export interface FactFieldPolicy {
  readonly schemaVersion: "fact-field-policy-v1";
  readonly fieldId: string;
  readonly valueType: RegistryValueType | "structured";
  readonly unitIds: readonly string[];
  readonly allowedScopes: readonly FactScope[];
  readonly safetyClass: FactSafetyClass;
  readonly sourcePolicy: RegistrySourcePolicy;
  /** Authorities that may independently support a positive conclusion. */
  readonly passAuthorities: readonly FactAuthority[];
  readonly minimumProductPassScope: Exclude<FactScope, "plan_subject">;
  readonly userObservationPassAllowed: boolean;
}

const PRODUCT_SCOPES = Object.freeze(["family", "model", "variant", "revision"] as const);
const EXACT_PRODUCT_SCOPES = Object.freeze(["variant", "revision"] as const);

function factSafety(value: (typeof CAPABILITY_FACET_REGISTRY)[FacetId]["safetyClass"]): FactSafetyClass {
  return value === "electrical_safety" ? "electrical_safety"
    : value === "informational" ? "normal" : "compatibility_critical";
}

function productScopes(fieldId: FacetId): readonly FactScope[] {
  if (fieldId === "identity.category" || fieldId === "identity.manufacturer") return PRODUCT_SCOPES;
  if (fieldId === "identity.model") return ["model", "variant", "revision"];
  if (fieldId === "identity.revision") return ["revision"];
  const policy = CAPABILITY_FACET_REGISTRY[fieldId];
  return policy.sourcePolicy === "official_third_party_or_user_observation"
    ? [...EXACT_PRODUCT_SCOPES, "plan_subject"] : EXACT_PRODUCT_SCOPES;
}

function minimumScope(fieldId: FacetId): Exclude<FactScope, "plan_subject"> {
  if (fieldId === "identity.category" || fieldId === "identity.manufacturer") return "family";
  if (fieldId === "identity.model") return "model";
  if (fieldId === "identity.revision") return "revision";
  return "variant";
}

const FACET_POLICIES = Object.fromEntries((Object.keys(FACET_REGISTRY) as FacetId[]).map((fieldId) => {
  const facet = FACET_REGISTRY[fieldId];
  const capability = CAPABILITY_FACET_REGISTRY[fieldId];
  const userObservationPassAllowed = capability.sourcePolicy === "official_third_party_or_user_observation"
    && capability.safetyClass !== "electrical_safety";
  const passAuthorities: FactAuthority[] = capability.sourcePolicy === "official_required"
    ? ["official"]
    : capability.sourcePolicy === "official_or_standard"
      ? ["official"]
      : userObservationPassAllowed
        ? ["official", "third_party", "user_observation"] : ["official", "third_party"];
  const policy: FactFieldPolicy = {
    schemaVersion: "fact-field-policy-v1",
    fieldId,
    valueType: facet.valueType,
    unitIds: facet.unitIds,
    allowedScopes: productScopes(fieldId),
    safetyClass: factSafety(capability.safetyClass),
    sourcePolicy: capability.sourcePolicy,
    passAuthorities,
    minimumProductPassScope: minimumScope(fieldId),
    userObservationPassAllowed,
  };
  return [fieldId, policy];
}));

const EXTRA_POLICIES: Record<string, FactFieldPolicy> = {
  "storage.recording_technology": {
    schemaVersion: "fact-field-policy-v1", fieldId: "storage.recording_technology", valueType: "string", unitIds: [],
    allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false,
  },
  "hba.mode": {
    schemaVersion: "fact-field-policy-v1", fieldId: "hba.mode", valueType: "string", unitIds: [],
    allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false,
  },
  "package.contents": {
    schemaVersion: "fact-field-policy-v1", fieldId: "package.contents", valueType: "string_set", unitIds: [],
    allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false,
  },
  "psu.pinout": {
    schemaVersion: "fact-field-policy-v1", fieldId: "psu.pinout", valueType: "structured", unitIds: [],
    allowedScopes: ["variant", "revision"], safetyClass: "electrical_safety", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false,
  },
  "power.cable_wire_gauge": {
    schemaVersion: "fact-field-policy-v1", fieldId: "power.cable_wire_gauge", valueType: "string", unitIds: [],
    allowedScopes: ["variant", "revision"], safetyClass: "electrical_safety", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false,
  },
  "power.connector_current_rating": {
    schemaVersion: "fact-field-policy-v1", fieldId: "power.connector_current_rating", valueType: "number", unitIds: ["a"],
    allowedScopes: ["variant", "revision"], safetyClass: "electrical_safety", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false,
  },
  "firmware.cpu_support": {
    schemaVersion: "fact-field-policy-v1", fieldId: "firmware.cpu_support", valueType: "structured", unitIds: [],
    allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false,
  },
  "firmware.bridge_version": {
    schemaVersion: "fact-field-policy-v1", fieldId: "firmware.bridge_version", valueType: "string", unitIds: [],
    allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false,
  },
  "firmware.upgrade_method": {
    schemaVersion: "fact-field-policy-v1", fieldId: "firmware.upgrade_method", valueType: "string_set", unitIds: [],
    allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false,
  },
  "firmware.file_hash": {
    schemaVersion: "fact-field-policy-v1", fieldId: "firmware.file_hash", valueType: "string", unitIds: [],
    allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false,
  },
  "firmware.rollback_support": {
    schemaVersion: "fact-field-policy-v1", fieldId: "firmware.rollback_support", valueType: "boolean", unitIds: [],
    allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false,
  },
  "storage.logical_sector_size": {
    schemaVersion: "fact-field-policy-v1", fieldId: "storage.logical_sector_size", valueType: "number", unitIds: ["byte"],
    allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false,
  },
  "storage.capacity_bytes": {
    schemaVersion: "fact-field-policy-v1", fieldId: "storage.capacity_bytes", valueType: "number", unitIds: ["byte"],
    allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false,
  },
  "storage.physical_sector_size": {
    schemaVersion: "fact-field-policy-v1", fieldId: "storage.physical_sector_size", valueType: "number", unitIds: ["byte"],
    allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false,
  },
  "storage.endurance_tbw": {
    schemaVersion: "fact-field-policy-v1", fieldId: "storage.endurance_tbw", valueType: "number", unitIds: ["tbw"],
    allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false,
  },
  "package.fastener_count": {
    schemaVersion: "fact-field-policy-v1", fieldId: "package.fastener_count", valueType: "structured", unitIds: [],
    allowedScopes: ["variant", "revision", "plan_subject"], safetyClass: "compatibility_critical", sourcePolicy: "official_third_party_or_user_observation",
    passAuthorities: ["official", "third_party", "user_observation"], minimumProductPassScope: "variant", userObservationPassAllowed: true,
  },
  "package.tool_required": {
    schemaVersion: "fact-field-policy-v1", fieldId: "package.tool_required", valueType: "structured", unitIds: [],
    allowedScopes: ["variant", "revision", "plan_subject"], safetyClass: "compatibility_critical", sourcePolicy: "official_third_party_or_user_observation",
    passAuthorities: ["official", "third_party", "user_observation"], minimumProductPassScope: "variant", userObservationPassAllowed: true,
  },
  "compatibility.qvl_entry": {
    schemaVersion: "fact-field-policy-v1", fieldId: "compatibility.qvl_entry", valueType: "structured", unitIds: [],
    allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false,
  },
  "io.port_topology": {
    schemaVersion: "fact-field-policy-v1", fieldId: "io.port_topology", valueType: "structured", unitIds: [],
    allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false,
  },
  "package.cable_count": {
    schemaVersion: "fact-field-policy-v1", fieldId: "package.cable_count", valueType: "structured", unitIds: [],
    allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false,
  },
  "thermal.fan_curve": {
    schemaVersion: "fact-field-policy-v1", fieldId: "thermal.fan_curve", valueType: "structured", unitIds: [],
    allowedScopes: ["variant", "revision"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation",
    passAuthorities: ["official", "third_party"], minimumProductPassScope: "variant", userObservationPassAllowed: false,
  },
  "thermal.airflow_curve": {
    schemaVersion: "fact-field-policy-v1", fieldId: "thermal.airflow_curve", valueType: "structured", unitIds: [],
    allowedScopes: ["variant", "revision"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation",
    passAuthorities: ["official", "third_party"], minimumProductPassScope: "variant", userObservationPassAllowed: false,
  },
  "thermal.airflow_resistance": {
    schemaVersion: "fact-field-policy-v1", fieldId: "thermal.airflow_resistance", valueType: "structured", unitIds: [],
    allowedScopes: ["variant", "revision", "plan_subject"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation",
    passAuthorities: ["official", "third_party", "user_observation"], minimumProductPassScope: "variant", userObservationPassAllowed: true,
  },
  "thermal.design_power": {
    schemaVersion: "fact-field-policy-v1", fieldId: "thermal.design_power", valueType: "number", unitIds: ["w"],
    allowedScopes: ["variant", "revision", "plan_subject"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation",
    passAuthorities: ["official", "third_party", "user_observation", "agent_inference"], minimumProductPassScope: "variant", userObservationPassAllowed: true,
  },
  "thermal.case_to_air_resistance": {
    schemaVersion: "fact-field-policy-v1", fieldId: "thermal.case_to_air_resistance", valueType: "structured", unitIds: [],
    allowedScopes: ["variant", "revision", "plan_subject"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation",
    passAuthorities: ["official", "third_party", "user_observation", "agent_inference"], minimumProductPassScope: "variant", userObservationPassAllowed: true,
  },
  "thermal.maximum_temperature": {
    schemaVersion: "fact-field-policy-v1", fieldId: "thermal.maximum_temperature", valueType: "number", unitIds: ["celsius"],
    allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "variant", userObservationPassAllowed: false,
  },
  "acoustic.sound_curve": {
    schemaVersion: "fact-field-policy-v1", fieldId: "acoustic.sound_curve", valueType: "structured", unitIds: [],
    allowedScopes: ["variant", "revision"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation",
    passAuthorities: ["official", "third_party"], minimumProductPassScope: "variant", userObservationPassAllowed: false,
  },
  "acoustic.coil_whine_risk": {
    schemaVersion: "fact-field-policy-v1", fieldId: "acoustic.coil_whine_risk", valueType: "structured", unitIds: [],
    allowedScopes: ["variant", "revision", "plan_subject"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation",
    passAuthorities: ["official", "third_party", "user_observation"], minimumProductPassScope: "variant", userObservationPassAllowed: true,
  },
  "system.requirement": {
    schemaVersion: "fact-field-policy-v1", fieldId: "system.requirement", valueType: "structured", unitIds: [],
    allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required",
    passAuthorities: ["official"], minimumProductPassScope: "revision", userObservationPassAllowed: false,
  },
  "physical.clearance": {
    schemaVersion: "fact-field-policy-v1", fieldId: "physical.clearance", valueType: "number", unitIds: ["mm"],
    allowedScopes: ["plan_subject"], safetyClass: "compatibility_critical", sourcePolicy: "official_third_party_or_user_observation",
    passAuthorities: ["user_observation"], minimumProductPassScope: "revision", userObservationPassAllowed: true,
  },
};

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export const FACT_FIELD_POLICY_REGISTRY = deepFreeze({ ...FACET_POLICIES, ...EXTRA_POLICIES }) as Readonly<Record<string, FactFieldPolicy>>;

export function factFieldPolicy(fieldId: unknown): FactFieldPolicy | null {
  return typeof fieldId === "string" && Object.prototype.hasOwnProperty.call(FACT_FIELD_POLICY_REGISTRY, fieldId)
    ? FACT_FIELD_POLICY_REGISTRY[fieldId] ?? null : null;
}

export function validateFactFieldValue(policy: FactFieldPolicy, value: unknown, unit: unknown): string[] {
  try {
    const errors: string[] = [];
    if (policy.unitIds.length === 0 ? unit !== undefined : typeof unit !== "string" || !policy.unitIds.includes(unit)) errors.push("fact unit does not match field policy");
    if (policy.valueType === "number" && (typeof value !== "number" || !Number.isFinite(value))) errors.push("fact value must be a finite number");
    else if (policy.valueType === "string" && (typeof value !== "string" || value.length === 0)) errors.push("fact value must be a non-empty string");
    else if (policy.valueType === "boolean" && typeof value !== "boolean") errors.push("fact value must be boolean");
    else if (policy.valueType === "string_set" && (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0) || new Set(value).size !== value.length)) errors.push("fact value must be a unique non-empty string set");
    else if (policy.valueType === "structured" && (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0)) errors.push("fact value must be a non-empty structured object");
    if (!errors.length) errors.push(...validateFormalFactValue(policy.fieldId, value));
    return errors;
  } catch {
    return ["fact value validation failed closed"];
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

function governedId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/.test(value) && value === value.normalize("NFC");
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

const SYSTEM_REQUIREMENT_SHAPES = Object.freeze({
  "memory.minimum": { valueType: "number", operator: "gte", unit: "gib" },
  "boot_pool.device_count": { valueType: "number", operator: "gte", unit: "count" },
  "hba.mode": { valueType: "string", operator: "eq", unit: undefined },
  "storage.disk_locator.required": { valueType: "boolean", operator: "eq", unit: undefined },
} as const);

/** Field-specific schemas keep safety-relevant values out of generic objects/strings. */
function validateFormalFactValue(fieldId: string, value: unknown): string[] {
  if (fieldId === "firmware.cpu_support") {
    if (!record(value) || !exact(value, ["cpuSkuId", "boardRevision", "region", "sinceVersion"])
      || !governedId(value.cpuSkuId) || !governedId(value.boardRevision) || !governedId(value.region)
      || !governedId(value.sinceVersion)) return ["firmware cpu support value invalid"];
  }
  if (fieldId === "firmware.upgrade_method") {
    const allowed = new Set(["uefi", "flashback", "bmc", "in_os", "external_programmer"]);
    if (!Array.isArray(value) || value.some((item) => !allowed.has(String(item)))) return ["firmware upgrade method invalid"];
  }
  if (fieldId === "firmware.file_hash" && !sha256(value)) return ["firmware file hash invalid"];
  if (fieldId === "storage.capacity_bytes"
    && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) return ["storage capacity invalid"];
  if ((fieldId === "storage.logical_sector_size" || fieldId === "storage.physical_sector_size")
    && (typeof value !== "number" || !Number.isInteger(value) || value < 512 || value > 65536 || (value & (value - 1)) !== 0)) {
    return ["storage sector size invalid"];
  }
  if (fieldId === "storage.endurance_tbw" && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) return ["storage endurance invalid"];
  if (fieldId === "storage.recording_technology" && !["cmr", "smr", "slc", "mlc", "tlc", "qlc"].includes(String(value))) return ["storage recording technology invalid"];
  if (fieldId === "hba.mode" && !["it", "ir", "raid"].includes(String(value))) return ["hba mode invalid"];
  if (fieldId === "package.contents" && (!Array.isArray(value) || value.some((item) => !governedId(item)))) return ["package contents invalid"];
  if (fieldId === "package.fastener_count") {
    if (!record(value) || !exact(value, ["fastenerId", "quantity"]) || !governedId(value.fastenerId)
      || !Number.isSafeInteger(value.quantity) || Number(value.quantity) < 0) return ["package fastener count invalid"];
  }
  if (fieldId === "package.tool_required") {
    if (!record(value) || !exact(value, ["toolId", "required"]) || !governedId(value.toolId) || typeof value.required !== "boolean") return ["package tool requirement invalid"];
  }
  if (fieldId === "compatibility.qvl_entry") {
    if (!record(value) || !exact(value, ["componentSkuId", "boardRevision", "region", "sinceVersion", "status"])
      || !governedId(value.componentSkuId) || !governedId(value.boardRevision) || !governedId(value.region)
      || !governedId(value.sinceVersion) || value.status !== "qualified") return ["compatibility QVL entry invalid"];
  }
  if (fieldId === "io.port_topology") {
    if (!record(value) || !exact(value, ["endpointId", "connectorType", "location", "controllerId", "pathId", "quantity"])
      || !governedId(value.endpointId) || !governedId(value.connectorType)
      || !["internal", "rear", "front", "external"].includes(String(value.location))
      || !governedId(value.controllerId) || !governedId(value.pathId)
      || !Number.isSafeInteger(value.quantity) || Number(value.quantity) < 1 || Number(value.quantity) > 1024) {
      return ["I/O port topology invalid"];
    }
  }
  if (fieldId === "package.cable_count") {
    if (!record(value) || !exact(value, ["cableId", "connectorFamily", "quantity"])
      || !governedId(value.cableId) || !governedId(value.connectorFamily)
      || !Number.isSafeInteger(value.quantity) || Number(value.quantity) < 0 || Number(value.quantity) > 1024) {
      return ["package cable count invalid"];
    }
  }
  if (fieldId === "thermal.fan_curve") {
    const points = record(value) && Array.isArray(value.points) ? value.points : [];
    if (!record(value) || !exact(value, ["curveId", "input", "output", "points"])
      || !governedId(value.curveId) || value.input !== "temperature_c" || value.output !== "duty_percent"
      || points.length < 2 || points.length > 32 || points.some((point, index) => !record(point)
        || !exact(point, ["input", "output"]) || typeof point.input !== "number" || !Number.isFinite(point.input)
        || point.input < -50 || point.input > 200 || typeof point.output !== "number" || !Number.isFinite(point.output)
        || point.output < 0 || point.output > 100 || (index > 0 && Number(points[index - 1]?.input) >= point.input))) {
      return ["thermal fan curve invalid"];
    }
  }
  if (fieldId === "thermal.airflow_curve") {
    const points = record(value) && Array.isArray(value.points) ? value.points : [];
    if (!record(value) || !exact(value, ["curveId", "uncertaintyFraction", "points"]) || !governedId(value.curveId)
      || typeof value.uncertaintyFraction !== "number" || !Number.isFinite(value.uncertaintyFraction)
      || value.uncertaintyFraction < 0 || value.uncertaintyFraction > 1 || points.length < 2 || points.length > 64
      || points.some((point, index) => !record(point) || !exact(point, ["airflowCfm", "staticPressurePa", "rpm"])
        || [point.airflowCfm, point.staticPressurePa, point.rpm].some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || entry < 0)
        || (index > 0 && Number(points[index - 1]?.airflowCfm) >= Number(point.airflowCfm)))) return ["thermal airflow curve invalid"];
  }
  if (fieldId === "thermal.airflow_resistance" || fieldId === "thermal.case_to_air_resistance") {
    if (!record(value) || !exact(value, ["lo", "hi"]) || typeof value.lo !== "number" || !Number.isFinite(value.lo)
      || typeof value.hi !== "number" || !Number.isFinite(value.hi) || value.lo < 0 || value.lo > value.hi) return [`${fieldId} interval invalid`];
  }
  if (fieldId === "thermal.design_power" && (typeof value !== "number" || value < 0 || value > 10000)) return ["thermal design power invalid"];
  if (fieldId === "thermal.maximum_temperature" && (typeof value !== "number" || value < -50 || value > 250)) return ["thermal maximum temperature invalid"];
  if (fieldId === "acoustic.sound_curve") {
    const points = record(value) && Array.isArray(value.points) ? value.points : [];
    if (!record(value) || !exact(value, ["curveId", "weighting", "referenceDistanceM", "loadId", "testMethodId", "points"])
      || !governedId(value.curveId) || value.weighting !== "A" || typeof value.referenceDistanceM !== "number"
      || !Number.isFinite(value.referenceDistanceM) || value.referenceDistanceM <= 0 || !governedId(value.loadId)
      || !governedId(value.testMethodId) || points.length < 2 || points.length > 64
      || points.some((point, index) => !record(point) || !exact(point, ["rpm", "lo", "hi"])
        || [point.rpm, point.lo, point.hi].some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
        || Number(point.rpm) < 0 || Number(point.lo) < 0 || Number(point.lo) > Number(point.hi)
        || (index > 0 && Number(points[index - 1]?.rpm) >= Number(point.rpm)))) return ["acoustic sound curve invalid"];
  }
  if (fieldId === "acoustic.coil_whine_risk") {
    if (!record(value) || !exact(value, ["risk", "note"]) || !["unknown", "reported", "observed"].includes(String(value.risk))
      || typeof value.note !== "string" || value.note.trim().length === 0) return ["acoustic coil whine risk invalid"];
  }
  if (fieldId === "system.requirement") {
    if (!record(value) || !exact(value, ["systemProfileId", "releaseId", "requirementId", "operator", "valueType", "value", "unit"])
      || !governedId(value.systemProfileId) || !governedId(value.releaseId) || !governedId(value.requirementId)) {
      return ["system requirement invalid"];
    }
    const shape = SYSTEM_REQUIREMENT_SHAPES[value.requirementId as keyof typeof SYSTEM_REQUIREMENT_SHAPES];
    const profile = SYSTEM_PROFILE_REGISTRY[value.systemProfileId as keyof typeof SYSTEM_PROFILE_REGISTRY];
    const release = SYSTEM_RELEASE_REGISTRY[value.releaseId as keyof typeof SYSTEM_RELEASE_REGISTRY];
    if (!shape || !profile || !release || release.profileId !== value.systemProfileId
      || value.valueType !== shape.valueType || value.operator !== shape.operator || value.unit !== shape.unit
      || (value.unit !== undefined && (typeof value.unit !== "string" || !Object.prototype.hasOwnProperty.call(UNIT_REGISTRY, value.unit)))
      || (shape.valueType === "number" && (typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0))
      || (shape.valueType === "string" && !governedId(value.value))
      || (shape.valueType === "boolean" && typeof value.value !== "boolean")) return ["system requirement invalid"];
  }
  if (fieldId === "psu.pinout") {
    if (!record(value) || !exact(value, ["connectorFamily", "revision", "pinCount", "pinMapHash"])
      || !governedId(value.connectorFamily) || !governedId(value.revision)
      || !Number.isSafeInteger(value.pinCount) || Number(value.pinCount) <= 0 || !sha256(value.pinMapHash)) return ["PSU pinout value invalid"];
  }
  return [];
}
