import { V3_RESOLVED_CATALOG_KIND_MATCHERS } from "../config/v3-catalog-runtime.mjs";
import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";

const TOP_LEVEL_SET_PATHS = new Set([
  "/components", "/roleDecisions", "/placements", "/connections", "/logicalLayouts", "/firmwareTargets",
]);

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Browser/Node-neutral equivalent of runtime/fs canonicalJson. */
export function canonicalJsonRuntime(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonRuntime).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compare(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJsonRuntime(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("value is not finite JSON");
  return encoded;
}

function sha256Utf8(value) {
  const digest = sha256Utf8Runtime(value);
  if (digest === null) throw new TypeError("value cannot be hashed");
  return digest;
}

export function sha256JsonRuntime(value) {
  return sha256Utf8(canonicalJsonRuntime(value).normalize("NFC"));
}

function normalizeString(value) {
  const normalized = value.normalize("NFC");
  for (let index = 0; index < normalized.length; index += 1) {
    const codeUnit = normalized.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = normalized.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("config string must contain only Unicode scalar values");
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("config string must contain only Unicode scalar values");
    }
  }
  return normalized;
}

function normalizeStringSet(values) {
  return values.map((value) => normalizeString(value)).sort(compare);
}

function normalizeJson(value) {
  if (typeof value === "string") return normalizeString(value);
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === "object") {
    const entries = new Map();
    for (const [rawKey, child] of Object.entries(value)) {
      const key = normalizeString(rawKey);
      if (entries.has(key)) throw new TypeError("config keys collide after NFC normalization");
      entries.set(key, normalizeJson(child));
    }
    return Object.fromEntries([...entries].sort(([left], [right]) => compare(left, right)));
  }
  return value;
}

function normalizeRequirementSpec(spec) {
  if (spec === null) return null;
  const normalized = structuredClone(spec);
  normalized.workloads.sort((left, right) => compare(left.workloadId, right.workloadId));
  for (const workload of normalized.workloads) {
    if (Array.isArray(workload.metrics)) workload.metrics.sort((left, right) => compare(left.metricId, right.metricId));
    if (Array.isArray(workload.evidenceOrBenchmarkRefs)) workload.evidenceOrBenchmarkRefs.sort(compare);
  }
  normalized.constraints.sort((left, right) => compare(left.constraintId, right.constraintId));
  return normalized;
}

function normalizeBuildConfigV3(config) {
  // TypeScript normalizeBuildConfigV3 delegates RequirementSpec to a deep-NFC
  // normalizer before any stable-ID sorting. Preserve that ordering contract.
  const normalized = normalizeJson(config);
  normalized.requirementSpec = normalizeRequirementSpec(normalized.requirementSpec);
  normalized.components = normalized.components.map((component) => {
    const result = structuredClone(component);
    if (result.identity.status === "resolved") result.identity.identityClaimIds = normalizeStringSet(result.identity.identityClaimIds);
    else if (Array.isArray(result.identity.candidateIds)) result.identity.candidateIds = normalizeStringSet(result.identity.candidateIds);
    return result;
  }).sort((left, right) => compare(left.instanceId, right.instanceId));
  normalized.roleDecisions.sort((left, right) => compare(left.roleDecisionId, right.roleDecisionId));
  normalized.placements.sort((left, right) => compare(left.placementId, right.placementId));
  normalized.connections.sort((left, right) => compare(left.connectionId, right.connectionId));
  normalized.logicalLayouts = normalized.logicalLayouts.map((layout) => ({
    ...layout,
    bootPoolDiskIds: normalizeStringSet(layout.bootPoolDiskIds),
    spareDiskIds: normalizeStringSet(layout.spareDiskIds),
    vdevs: layout.vdevs.map((vdev) => ({ ...vdev, diskInstanceIds: normalizeStringSet(vdev.diskInstanceIds) }))
      .sort((left, right) => compare(left.vdevId, right.vdevId)),
  })).sort((left, right) => compare(left.layoutId, right.layoutId));
  normalized.firmwareTargets = normalized.firmwareTargets.map((target) => ({
    ...target,
    requestedSettings: target.requestedSettings.map((setting) => structuredClone(setting))
      .sort((left, right) => compare(left.settingId, right.settingId)),
  })).sort((left, right) => compare(left.instanceId, right.instanceId));
  return normalized;
}

function canonicalize(value, path = "", ancestors = new Set()) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(normalizeString(value));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("config number must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") throw new TypeError("config contains a non-JSON value");
  if (ancestors.has(value)) throw new TypeError("config must not be cyclic");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item, index) => canonicalize(item, `${path}/${index}`, ancestors));
      if (TOP_LEVEL_SET_PATHS.has(path)) {
        items.sort(compare);
        if (items.some((item, index) => index > 0 && item === items[index - 1])) throw new TypeError(`duplicate member in config set ${path}`);
      }
      return `[${items.join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("config objects must be plain");
    const entries = new Map();
    for (const [rawKey, child] of Object.entries(value)) {
      const key = normalizeString(rawKey);
      if (path === "" && key === "configHash") continue;
      if (entries.has(key)) throw new TypeError("config keys collide after NFC normalization");
      entries.set(key, child);
    }
    return `{${[...entries].sort(([left], [right]) => compare(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child, `${path}/${key}`, ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Browser/Node-neutral equivalent of the TypeScript Plan config hash dispatcher. */
export function hashPlanConfigRuntime(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("plan config must be an object");
  if (config.schemaVersion === "2.0.0") return sha256JsonRuntime(config);
  if (config.schemaVersion !== "3.0.0") throw new TypeError(`unsupported plan config schema: ${String(config.schemaVersion ?? "missing")}`);
  const normalized = normalizeBuildConfigV3(config);
  const preimage = `buildsim\u0000hash-spec-v1\u0000build-config\u00003.0.0\u0000${canonicalize(normalized)}`;
  return sha256Utf8(preimage);
}

const SHA256 = /^[a-f0-9]{64}$/;
const PLAN_STORAGE_ID = /^[a-z0-9][a-z0-9-]{7,79}$/;
const BINDING_STORAGE_ID = /^binding-sha256-[a-f0-9]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MIGRATION_POINTER = /^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])+)*$/;
const MIGRATION_DIFF_OPERATIONS = new Set(["mapped", "expanded", "omitted"]);
const MIGRATION_WARNING_CODES = new Set([
  "owned_mapped_to_ordered", "legacy_purchase_bucket_mapped_to_planned", "nvme_identity_unresolved",
  "fan_identity_unresolved", "disk_identity_missing", "cooler_kind_unresolved", "legacy_hba_not_migrated",
  "legacy_bom_item_not_migrated", "legacy_topology_not_migrated",
]);
const EVIDENCE_PURPOSES = new Set(["identity", "compatibility", "geometry", "power", "wiring", "thermal", "assembly"]);
const EVIDENCE_SUBJECTS = new Set(["plan", "sku", "case-profile", "component"]);
const EVIDENCE_CATEGORIES = new Set(["case", "motherboard", "cpu", "psu", "cooler", "gpu", "memory", "storage", "hba", "fan", "accessory"]);
const COMPONENT_KINDS = new Set(["case", "motherboard", "cpu", "memory_module", "gpu", "psu", "cpu_cooler", "aio", "radiator", "pump", "case_fan", "fan_rgb_hub", "storage_drive", "hba", "raid_controller", "storage_expander", "backplane", "nic", "capture_card", "expansion_board", "pcie_card", "cable", "adapter", "bracket"]);
const SYSTEM_PROFILES = new Set(["system.windows-11", "system.linux-desktop", "system.truenas-scale", "system.proxmox-ve"]);
const METRICS = Object.freeze({
  "budget.total": { units: ["cny"], operators: ["lte", "between"] },
  "service.horizon": { units: ["year"], operators: ["gte", "between"] },
  "performance.cpu.multicore": { units: ["score"], operators: ["gte", "between"] },
  "performance.gpu.frame_rate": { units: ["fps"], operators: ["gte", "between"] },
  "memory.capacity": { units: ["gib"], operators: ["gte", "between"] },
  "storage.usable_capacity": { units: ["tib"], operators: ["gte", "between"] },
  "storage.concurrent_disk_count": { units: ["count"], operators: ["gte", "between"] },
  "network.throughput": { units: ["gbps"], operators: ["gte", "between"] },
  "power.capacity": { units: ["w"], operators: ["gte", "between"] },
  "physical.case_volume": { units: ["liter"], operators: ["lte", "between"] },
  "physical.gpu_length": { units: ["mm"], operators: ["lte", "between"] },
  "thermal.ambient": { units: ["celsius"], operators: ["eq", "between"] },
  "acoustics.noise": { units: ["dba"], operators: ["lte", "between"] },
  "platform.operating_system": { units: [], operators: ["includes"], stringSet: true },
});
const FACETS = new Set([
  "identity.category", "identity.manufacturer", "identity.model", "identity.revision", "physical.width", "physical.height", "physical.depth",
  "mount.standard", "mount.point_ids", "cpu.socket", "motherboard.cpu_socket", "motherboard.chipset", "motherboard.memory_type",
  "motherboard.memory_slot_count", "motherboard.memory_population_rules", "motherboard.form_factor", "motherboard.bios_version",
  "motherboard.bios_upgrade_methods", "motherboard.display_outputs", "motherboard.supported_operating_systems", "memory.type", "memory.capacity",
  "io.port_types", "io.header_types", "io.endpoint_ids", "case.motherboard_form_factors", "case.side_panel", "case.gpu_max_length",
  "case.cpu_cooler_max_height", "gpu.length", "gpu.slot_width", "gpu.power_connectors", "psu.capacity", "psu.connectors", "power.source_type",
  "power.load", "power.cable_families", "pcie.lane_count", "pcie.slot_types", "pcie.lane_sharing", "storage.interface", "storage.boot_support", "storage.capacity_bytes",
  "storage.recording_technology", "hba.mode", "cooling.fan_mounts", "cooling.radiator_support", "cooling.pump_header", "firmware.version",
  "firmware.upgrade_path_refs", "driver.supported_operating_systems", "driver.package_versions", "thermal.curve_refs", "acoustic.curve_refs",
  "package.contents", "resource.kind", "cable.connector_standard", "fastener.thread", "fastener.length_mm", "fastener.head",
  "tool.drive", "consumable.type", "accessory.standard", "acoustic.noise_class",
]);
const FACET_RULES = {};
function registerFacet(ids, valueType, units, operators) { for (const id of ids) FACET_RULES[id] = { valueType, units, operators }; }
registerFacet(["physical.width", "physical.height", "physical.depth"], "number", ["mm"], ["lte", "gte", "between"]);
registerFacet(["motherboard.memory_slot_count"], "number", ["count"], ["gte", "lte", "between"]);
registerFacet(["memory.capacity"], "number", ["gib"], ["gte", "lte", "between"]);
registerFacet(["case.gpu_max_length", "case.cpu_cooler_max_height"], "number", ["mm"], ["gte", "between"]);
registerFacet(["gpu.length"], "number", ["mm"], ["lte", "between"]);
registerFacet(["gpu.slot_width"], "number", ["slot"], ["lte", "between"]);
registerFacet(["psu.capacity"], "number", ["w"], ["gte", "between"]);
registerFacet(["power.load"], "number", ["w"], ["lte", "gte", "between"]);
registerFacet(["storage.capacity_bytes"], "number", ["byte"], ["gte", "lte", "between"]);
registerFacet(["fastener.length_mm"], "number", ["mm"], ["eq", "gte", "lte", "between"]);
registerFacet(["pcie.lane_count"], "number", ["count"], ["gte", "between"]);
registerFacet(["storage.boot_support", "cooling.pump_header"], "boolean", [], ["eq"]);
registerFacet(["mount.point_ids", "motherboard.memory_population_rules", "motherboard.bios_upgrade_methods", "motherboard.display_outputs", "motherboard.supported_operating_systems", "io.port_types", "io.header_types", "io.endpoint_ids", "case.motherboard_form_factors", "gpu.power_connectors", "psu.connectors", "power.cable_families", "pcie.slot_types", "pcie.lane_sharing", "cooling.fan_mounts", "cooling.radiator_support", "firmware.upgrade_path_refs", "driver.supported_operating_systems", "driver.package_versions", "thermal.curve_refs", "acoustic.curve_refs", "package.contents", "cable.connector_standard"], "string", [], ["includes"]);
registerFacet(["motherboard.form_factor"], "string", [], ["eq", "includes"]);
for (const id of FACETS) if (!FACET_RULES[id]) FACET_RULES[id] = { valueType: "string", units: [], operators: ["eq"] };
const FIRMWARE_SETTINGS = Object.freeze({
  iommu: ["enabled", "disabled"], virtualization: ["enabled", "disabled"], secure_boot: ["enabled", "disabled"], tpm: ["enabled", "disabled"],
  csm: ["enabled", "disabled"], storage_controller_mode: ["ahci", "raid", "hba_it"], memory_profile: ["jedec", "xmp", "expo"],
  resizable_bar: ["enabled", "disabled"], above_4g_decoding: ["enabled", "disabled"], ecc: ["enabled", "disabled", "auto"],
});

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactOrSubset(value, allowed, required = []) {
  return object(value) && Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function stableId(value) { try { return nonEmpty(value) ? normalizeString(value) : null; } catch { return null; } }
function containsIllFormedUnicode(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    try { normalizeString(value); return false; } catch { return true; }
  }
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsIllFormedUnicode(item, seen));
  return Object.entries(value).some(([key, child]) => containsIllFormedUnicode(key, seen) || containsIllFormedUnicode(child, seen));
}
function uniqueStrings(value, nonempty = false) {
  return Array.isArray(value) && (!nonempty || value.length > 0) && value.every(nonEmpty)
    && new Set(value.map((item) => item.normalize("NFC"))).size === value.length;
}
function iso(value) { return typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value)); }
function migrationPointer(value) { return typeof value === "string" && value.length <= 512 && MIGRATION_POINTER.test(value); }
function finiteJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.every((item) => finiteJsonValue(item, ancestors));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    return Object.values(value).every((item) => finiteJsonValue(item, ancestors));
  } finally { ancestors.delete(value); }
}
function migrationDiff(value) {
  return exactOrSubset(value, ["sourcePath", "targetPath", "operation", "before", "after"], ["sourcePath", "targetPath", "operation", "before", "after"])
    && migrationPointer(value.sourcePath) && (value.targetPath === null || migrationPointer(value.targetPath))
    && MIGRATION_DIFF_OPERATIONS.has(value.operation) && finiteJsonValue(value.before) && finiteJsonValue(value.after);
}
function migrationWarning(value) {
  return exactOrSubset(value, ["code", "sourcePath", "message"], ["code", "sourcePath", "message"])
    && MIGRATION_WARNING_CODES.has(value.code) && migrationPointer(value.sourcePath)
    && typeof value.message === "string" && value.message.trim().length > 0 && value.message.length <= 2_000;
}

function planIdempotencyOperation(value) {
  if (value === "create") return { kind: "create", ownerPlanId: null, resultKind: "plan" };
  const match = /^(updateDraft|migrateDraftToV3|saveVersion|duplicate|bindEvidence|unbindEvidence):([a-z0-9][a-z0-9-]{7,79})$/.exec(String(value ?? ""));
  if (!match) return null;
  const resultKinds = { updateDraft: "plan", migrateDraftToV3: "plan", saveVersion: "version", duplicate: "plan", bindEvidence: "evidence-binding", unbindEvidence: "void" };
  return { kind: match[1], ownerPlanId: match[2], resultKind: resultKinds[match[1]] };
}

/** Strict persisted Plan idempotency record validator shared by repository and production graph. */
export function validatePlanIdempotencyRuntime(record) {
  if (!exactOrSubset(record, ["schemaVersion", "operation", "requestHash", "result"], ["schemaVersion", "operation", "requestHash", "result"])
    || record.schemaVersion !== "plan-idempotency-v2" || !SHA256.test(String(record.requestHash ?? ""))) return ["plan idempotency record shape/hash invalid"];
  const operation = planIdempotencyOperation(record.operation);
  const result = record.result;
  if (!operation || !object(result) || result.kind !== operation.resultKind || !PLAN_STORAGE_ID.test(String(result.planId ?? "")) || !SHA256.test(String(result.resultHash ?? ""))) return ["plan idempotency operation/result reference invalid"];
  const allowed = result.kind === "version" ? ["kind", "planId", "versionId", "resultHash"]
    : result.kind === "evidence-binding" ? ["kind", "planId", "bindingId", "resultHash"]
      : result.kind === "plan" ? ["kind", "planId", "writeReceipt", "resultHash"] : ["kind", "planId", "resultHash"];
  const required = result.kind === "plan" ? ["kind", "planId", "resultHash"] : allowed;
  if (!exactOrSubset(result, allowed, required)
    || result.kind === "version" && !PLAN_STORAGE_ID.test(String(result.versionId ?? ""))
    || result.kind === "evidence-binding" && !BINDING_STORAGE_ID.test(String(result.bindingId ?? ""))) return ["plan idempotency result reference shape invalid"];
  if (result.kind === "plan" && result.writeReceipt !== undefined) {
    const receipt = result.writeReceipt;
    if (!exactOrSubset(receipt,
      ["schemaVersion", "appliedDraftRevision", "appliedConfigHash", "appliedUpdatedAt", "appliedPlanHash"],
      ["schemaVersion", "appliedDraftRevision", "appliedConfigHash", "appliedUpdatedAt", "appliedPlanHash"])
      || receipt.schemaVersion !== "plan-write-receipt-v1"
      || !Number.isSafeInteger(receipt.appliedDraftRevision) || receipt.appliedDraftRevision < 0
      || !SHA256.test(String(receipt.appliedConfigHash ?? ""))
      || !iso(receipt.appliedUpdatedAt)
      || !SHA256.test(String(receipt.appliedPlanHash ?? ""))) return ["plan idempotency immutable write receipt invalid"];
  }
  if (operation.ownerPlanId && operation.kind !== "duplicate" && result.planId !== operation.ownerPlanId) return ["plan idempotency result owner invalid"];
  if (operation.kind === "duplicate" && result.planId === operation.ownerPlanId) return ["plan duplicate idempotency result must reference the copied plan"];
  const { resultHash, ...material } = result;
  if (resultHash !== sha256JsonRuntime(material)) return ["plan idempotency result reference hash invalid"];
  return [];
}

function migrationStableIdRuntime(prefix, sourceHash, sourcePath, ordinal = 1) {
  const digest = sha256Utf8(`build-sim:v2-migration:${sourceHash}:${sourcePath}:${ordinal}`);
  return `${prefix}-${digest}`;
}

function migrationCatalogBindingMaterialRuntime(binding) {
  return {
    schemaVersion: binding.schemaVersion,
    rulesetId: binding.rulesetId,
    catalog: { ...binding.catalog },
    cooler: { ...binding.cooler },
  };
}

export function validateMigrationCatalogBindingRuntime(binding, coolerSkuId) {
  if (!exactOrSubset(binding, ["schemaVersion", "rulesetId", "catalog", "cooler", "bindingHash"], ["schemaVersion", "rulesetId", "catalog", "cooler", "bindingHash"])
    || binding.schemaVersion !== "build-config-v3-migration-catalog-binding-v1" || binding.rulesetId !== "v2-to-v3-governed-component-kind-v1"
    || !exactOrSubset(binding.catalog, ["contentHash", "schemaVersion", "catalogVersion", "updatedAt"], ["contentHash", "schemaVersion", "catalogVersion", "updatedAt"])
    || !SHA256.test(String(binding.catalog.contentHash ?? "")) || !nonEmpty(binding.catalog.schemaVersion)
    || binding.catalog.schemaVersion !== binding.catalog.schemaVersion.normalize("NFC")
    || binding.catalog.catalogVersion !== null && (!nonEmpty(binding.catalog.catalogVersion) || binding.catalog.catalogVersion !== binding.catalog.catalogVersion.normalize("NFC"))
    || typeof binding.catalog.updatedAt !== "string" || !Number.isFinite(Date.parse(binding.catalog.updatedAt)) || binding.catalog.updatedAt !== binding.catalog.updatedAt.normalize("NFC")
    || !exactOrSubset(binding.cooler, ["skuId", "catalogSkuId", "category", "type"], ["skuId", "catalogSkuId", "category", "type"])
    || typeof binding.cooler.skuId !== "string" || binding.cooler.skuId !== coolerSkuId || binding.cooler.skuId !== binding.cooler.skuId.normalize("NFC")
    || binding.cooler.catalogSkuId !== null && (!nonEmpty(binding.cooler.catalogSkuId) || binding.cooler.catalogSkuId !== binding.cooler.skuId || binding.cooler.catalogSkuId !== binding.cooler.catalogSkuId.normalize("NFC"))
    || binding.cooler.category !== null && (!nonEmpty(binding.cooler.category) || binding.cooler.category !== binding.cooler.category.normalize("NFC"))
    || binding.cooler.type !== null && (!nonEmpty(binding.cooler.type) || binding.cooler.type !== binding.cooler.type.normalize("NFC"))
    || (binding.cooler.catalogSkuId === null) !== (binding.cooler.category === null)
    || binding.cooler.catalogSkuId === null && binding.cooler.type !== null
    || !SHA256.test(String(binding.bindingHash ?? ""))
    || binding.bindingHash !== sha256JsonRuntime(migrationCatalogBindingMaterialRuntime(binding))) return false;
  return true;
}

function recomputeMigrationAuditRuntime(source, sourceHash, catalogBinding) {
  const parsedUpdatedAt = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(source.updatedAt) ? `${source.updatedAt}T00:00:00.000Z` : source.updatedAt);
  if (!Number.isFinite(parsedUpdatedAt)) throw new TypeError("migration source timestamp invalid");
  const migratedUpdatedAt = new Date(parsedUpdatedAt).toISOString();
  const components = [];
  const diff = source.updatedAt === migratedUpdatedAt ? [] : [{ sourcePath: "/updatedAt", targetPath: "/updatedAt", operation: "mapped", before: source.updatedAt, after: migratedUpdatedAt }];
  const warnings = [];
  const migratedSkuIds = new Set();
  const stateWarningKeys = new Set();
  const bomBySku = new Map();
  const bomInstanceCursor = new Map();
  for (const line of source.bom) bomBySku.set(line.skuId, [...(bomBySku.get(line.skuId) ?? []), line]);
  const stateForSku = (skuId, sourcePath) => {
    const lines = bomBySku.get(skuId) ?? [];
    const instanceOrdinal = bomInstanceCursor.get(skuId) ?? 0;
    bomInstanceCursor.set(skuId, instanceOrdinal + 1);
    const ownedQuantity = lines.filter((line) => line.bucket === "owned").reduce((total, line) => total + line.qty, 0);
    if (instanceOrdinal < ownedQuantity) {
      const key = `owned\0${sourcePath}\0${skuId}`;
      if (!stateWarningKeys.has(key)) {
        warnings.push({ code: "owned_mapped_to_ordered", sourcePath, message: `Legacy owned state for ${skuId} became ordered; possession, installation, and health remain unknown.` });
        stateWarningKeys.add(key);
      }
      return "ordered";
    }
    if (lines.length > 0) {
      const key = `planned\0${sourcePath}\0${skuId}`;
      if (!stateWarningKeys.has(key)) {
        warnings.push({ code: "legacy_purchase_bucket_mapped_to_planned", sourcePath, message: `Legacy purchase state for ${skuId} instance ${instanceOrdinal + 1} became planned; only ${ownedQuantity} explicitly owned unit(s) may become ordered.` });
        stateWarningKeys.add(key);
      }
    }
    return "planned";
  };
  const addResolved = ({ kind, role, skuId, sourcePath, ordinal = 1 }) => {
    if (!skuId) return;
    const component = {
      instanceId: migrationStableIdRuntime("migci", sourceHash, sourcePath, ordinal), kind, role,
      state: stateForSku(skuId, sourcePath),
      identity: { status: "resolved", skuId, identityClaimIds: [`migration:v2:${sourceHash}:${sourcePath.replace(/^\//, "")}`] },
      source: "migration",
    };
    components.push(component); migratedSkuIds.add(skuId);
    diff.push({ sourcePath, targetPath: `/components/${components.length - 1}`, operation: "mapped", before: skuId, after: component });
  };
  addResolved({ kind: "case", role: "case", skuId: source.caseId, sourcePath: "/caseId" });
  addResolved({ kind: "motherboard", role: "motherboard", skuId: source.boardId, sourcePath: "/boardId" });
  addResolved({ kind: "cpu", role: "cpu", skuId: source.cpuId, sourcePath: "/cpuId" });
  addResolved({ kind: "psu", role: "primary_psu", skuId: source.selection.psuId, sourcePath: "/selection/psuId" });
  if (source.selection.secondaryPsuId) addResolved({ kind: "psu", role: "secondary_psu", skuId: source.selection.secondaryPsuId, sourcePath: "/selection/secondaryPsuId" });
  const coolerSku = catalogBinding.cooler.catalogSkuId === null ? undefined : {
    id: catalogBinding.cooler.catalogSkuId,
    category: catalogBinding.cooler.category,
    attrs: { type: catalogBinding.cooler.type },
  };
  const coolerKind = coolerSku && V3_RESOLVED_CATALOG_KIND_MATCHERS.aio(coolerSku) ? "aio"
    : coolerSku && V3_RESOLVED_CATALOG_KIND_MATCHERS.cpu_cooler(coolerSku) ? "cpu_cooler" : null;
  if (coolerKind) addResolved({ kind: coolerKind, role: "cpu_cooler", skuId: source.selection.coolerId, sourcePath: "/selection/coolerId" });
  else {
    warnings.push({ code: "cooler_kind_unresolved", sourcePath: "/selection/coolerId", message: `Legacy cooler ${source.selection.coolerId} was not migrated because the governed catalog does not prove AIO or CPU cooler kind.` });
    diff.push({ sourcePath: "/selection/coolerId", targetPath: null, operation: "omitted", before: source.selection.coolerId, after: null });
  }
  addResolved({ kind: "memory_module", role: "system_memory", skuId: source.selection.memoryId, sourcePath: "/selection/memoryId" });
  if (source.selection.gpuId === "gpu.none") {
    const decision = { roleDecisionId: migrationStableIdRuntime("migrd", sourceHash, "/selection/gpuId"), role: "discrete_gpu", decision: "not_needed", source: "migration", confirmedAt: migratedUpdatedAt };
    diff.push({ sourcePath: "/selection/gpuId", targetPath: "/roleDecisions/0", operation: "mapped", before: source.selection.gpuId, after: decision });
  } else addResolved({ kind: "gpu", role: "discrete_gpu", skuId: source.selection.gpuId, sourcePath: "/selection/gpuId" });
  if (source.selection.diskCount > 0 && source.selection.diskSkuId) {
    for (let index = 1; index <= source.selection.diskCount; index += 1) addResolved({ kind: "storage_drive", role: "data_disk", skuId: source.selection.diskSkuId, sourcePath: "/selection/diskSkuId", ordinal: index });
    diff.push({ sourcePath: "/selection/diskCount", targetPath: "/components", operation: "expanded", before: source.selection.diskCount, after: components.filter((component) => component.role === "data_disk").map((component) => component.instanceId) });
  } else if (source.selection.diskCount > 0) {
    warnings.push({ code: "disk_identity_missing", sourcePath: "/selection/diskCount", message: "Legacy diskCount had no diskSkuId; no SATA disk identity was invented." });
    diff.push({ sourcePath: "/selection/diskCount", targetPath: null, operation: "omitted", before: source.selection.diskCount, after: null });
  }
  for (let index = 1; index <= (source.selection.nvmeCount ?? 0); index += 1) components.push({
    instanceId: migrationStableIdRuntime("migci", sourceHash, "/selection/nvmeCount", index), kind: "storage_drive", role: "nvme_storage", state: "planned",
    identity: { status: "unresolved", userText: `Legacy config recorded NVMe drive ${index} of ${source.selection.nvmeCount}; no SKU was recorded.` }, source: "migration",
  });
  if ((source.selection.nvmeCount ?? 0) > 0) {
    warnings.push({ code: "nvme_identity_unresolved", sourcePath: "/selection/nvmeCount", message: "NVMe count was preserved as unresolved instances; no Samsung 980 PRO or other SKU was inferred." });
    diff.push({ sourcePath: "/selection/nvmeCount", targetPath: "/components", operation: "expanded", before: source.selection.nvmeCount, after: components.filter((component) => component.role === "nvme_storage").map((component) => component.instanceId) });
  }
  for (const [groupIndex, group] of (source.selection.fanGroups ?? []).entries()) {
    const sourcePath = `/selection/fanGroups/${groupIndex}`;
    const role = migrationStableIdRuntime("migrole", sourceHash, sourcePath);
    for (let index = 1; index <= group.count; index += 1) components.push({
      instanceId: migrationStableIdRuntime("migci", sourceHash, sourcePath, index), kind: "case_fan", role, state: "planned",
      identity: { status: "unresolved", userText: `Legacy config requested ${group.sizeMm}mm case fan ${index} of ${group.count} at mount ${group.mountId}; no fan SKU was recorded.` }, source: "migration",
    });
    warnings.push({ code: "fan_identity_unresolved", sourcePath, message: `Fan group ${group.mountId} was preserved as unresolved ${group.sizeMm}mm fan requirements.` });
  }
  if ((source.selection.fanGroups?.length ?? 0) > 0) diff.push({ sourcePath: "/selection/fanGroups", targetPath: "/components", operation: "expanded", before: source.selection.fanGroups, after: components.filter((component) => component.kind === "case_fan").map((component) => component.instanceId) });
  if (source.selection.hbaSkuId || source.selection.hbaMode === "always") {
    warnings.push({ code: "legacy_hba_not_migrated", sourcePath: "/selection/hbaSkuId", message: "Legacy HBA policy/SKU was not promoted into topology because controller need and identity require explicit V3 review." });
    diff.push({ sourcePath: "/selection/hbaSkuId", targetPath: null, operation: "omitted", before: source.selection.hbaSkuId ?? null, after: null });
  }
  if (source.selection.psuTopology !== "auto" || source.selection.dualStart) warnings.push({ code: "legacy_topology_not_migrated", sourcePath: "/selection/psuTopology", message: "Legacy PSU placement/start policy was not converted into placement or connection edges." });
  for (const [index, line] of source.bom.entries()) {
    if (migratedSkuIds.has(line.skuId) || line.skuId === source.selection.hbaSkuId) continue;
    warnings.push({ code: "legacy_bom_item_not_migrated", sourcePath: `/bom/${index}`, message: `Legacy BOM row ${line.skuId} was outside the explicit V2 component mapping and was not invented as V3 topology.` });
    diff.push({ sourcePath: `/bom/${index}`, targetPath: null, operation: "omitted", before: line, after: null });
  }
  return { diff, warnings, components };
}
function draftField(value, kind) {
  if (!exactOrSubset(value, value?.state === "answered" ? ["state", "value", "source", "confirmedByUser"] : ["state", "source", "confirmedByUser"], ["state", "source", "confirmedByUser"])) return false;
  if (!["answered", "deferred", "not_applicable"].includes(value.state) || !["user", "defaulted", "agent_proposed"].includes(value.source) || typeof value.confirmedByUser !== "boolean") return false;
  if (value.state !== "answered") return !("value" in value);
  if (!("value" in value)) return false;
  if (kind === "intent") return ["pc", "workstation", "nas"].includes(value.value);
  if (kind === "horizon") return typeof value.value === "number" && Number.isFinite(value.value) && value.value > 0;
  return object(value.value) && Object.keys(value.value).length > 0 && Object.keys(value.value).every((key) => ["targetCny", "hardCapCny", "reserveCny"].includes(key))
    && Object.values(value.value).every((amount) => typeof amount === "number" && Number.isFinite(amount) && amount >= 0)
    && !(typeof value.value.targetCny === "number" && typeof value.value.hardCapCny === "number" && value.value.targetCny > value.value.hardCapCny);
}
function requirementMetric(value) {
  if (!object(value) || !Object.prototype.hasOwnProperty.call(METRICS, value.metricId)) return false;
  if (value.state === "deferred" || value.state === "not_applicable") return exactOrSubset(value, ["metricId", "state", "source", "confirmedByUser"], ["metricId", "state", "source", "confirmedByUser"])
    && ["user", "migration", "agent_proposed"].includes(value.source) && typeof value.confirmedByUser === "boolean";
  if (value.state !== undefined && value.state !== "answered") return false;
  const allowed = ["metricId", "state", "operator", "value", "unitId", "priority", "benchmarkId", "benchmarkContext", "source", "confirmedByUser"];
  if (!exactOrSubset(value, allowed, ["metricId", "operator", "value", "unitId", "priority"])) return false;
  const rule = METRICS[value.metricId];
  const shape = value.operator === "between"
    ? Array.isArray(value.value) && value.value.length === 2 && value.value.every((item) => typeof item === "number" && Number.isFinite(item)) && value.value[0] <= value.value[1]
    : rule.stringSet ? nonEmpty(value.value) : typeof value.value === "number" && Number.isFinite(value.value);
  const unitValid = rule.units.length ? rule.units.includes(value.unitId) : value.unitId === undefined;
  if (!shape || !rule.operators.includes(value.operator) || !unitValid || !["must", "important", "nice_to_have"].includes(value.priority)) return false;
  const benchmark = value.metricId === "performance.cpu.multicore"
    ? { id: "benchmark.cinebench-2024.cpu-multicore", keys: ["softwareVersion", "powerProfile"] }
    : value.metricId === "performance.gpu.frame_rate"
      ? { id: "benchmark.game.fps", keys: ["title", "titleVersion", "resolution", "qualityPreset", "graphicsApi"] }
      : null;
  if (benchmark) {
    if (value.benchmarkId !== benchmark.id || !exactOrSubset(value.benchmarkContext, benchmark.keys, benchmark.keys) || benchmark.keys.some((key) => !nonEmpty(value.benchmarkContext[key]))) return false;
  } else if (value.benchmarkId !== undefined || value.benchmarkContext !== undefined) return false;
  if (value.state === "answered" || "source" in value || "confirmedByUser" in value) return ["user", "migration", "agent_proposed"].includes(value.source) && typeof value.confirmedByUser === "boolean";
  return true;
}

function facetPredicate(value) {
  if (!exactOrSubset(value, ["facetId", "operator", "value", "unitId"], ["facetId", "operator", "value"]) || !FACETS.has(value.facetId)) return false;
  const rule = FACET_RULES[value.facetId];
  if (!rule.operators.includes(value.operator)) return false;
  const shape = value.operator === "between"
    ? Array.isArray(value.value) && value.value.length === 2 && value.value.every((item) => typeof item === "number" && Number.isFinite(item)) && value.value[0] <= value.value[1]
    : rule.valueType === "number" ? typeof value.value === "number" && Number.isFinite(value.value)
      : rule.valueType === "boolean" ? typeof value.value === "boolean" : nonEmpty(value.value);
  return shape && (rule.units.length ? rule.units.includes(value.unitId) : value.unitId === undefined);
}
function requirementSpec(value) {
  if (!exactOrSubset(value, ["requirementSpecId", "schemaVersion", "budget", "workloads", "constraints", "horizonYears"], ["requirementSpecId", "schemaVersion", "workloads", "constraints"])) return false;
  if (!nonEmpty(value.requirementSpecId) || value.schemaVersion !== "1.0.0" || (value.budget !== undefined && !draftField(value.budget, "budget")) || (value.horizonYears !== undefined && !draftField(value.horizonYears, "horizon"))) return false;
  if (!Array.isArray(value.workloads) || !Array.isArray(value.constraints)) return false;
  const workloadIds = [];
  for (const workload of value.workloads) {
    if (!object(workload) || !nonEmpty(workload.workloadId) || !Array.isArray(workload.metrics)) return false;
    workloadIds.push(workload.workloadId.normalize("NFC"));
    if (workload.state === "deferred" || workload.state === "not_applicable") {
      if (!exactOrSubset(workload, ["workloadId", "metrics", "state", "source", "confirmedByUser"], ["workloadId", "metrics", "state", "source", "confirmedByUser"]) || workload.metrics.length || !["user", "defaulted", "agent_proposed"].includes(workload.source) || typeof workload.confirmedByUser !== "boolean") return false;
      continue;
    }
    if (workload.state !== undefined && workload.state !== "answered") return false;
    const allowed = workload.state === "answered" ? ["workloadId", "state", "name", "metrics", "evidenceOrBenchmarkRefs", "source", "confirmedByUser"] : ["workloadId", "name", "metrics", "evidenceOrBenchmarkRefs"];
    if (!exactOrSubset(workload, allowed, ["workloadId", "name", "metrics"]) || !nonEmpty(workload.name) || workload.metrics.some((metric) => !requirementMetric(metric))) return false;
    if (new Set(workload.metrics.map((metric) => metric.metricId)).size !== workload.metrics.length || (workload.evidenceOrBenchmarkRefs !== undefined && !uniqueStrings(workload.evidenceOrBenchmarkRefs))) return false;
    if (workload.state === "answered" && (!["user", "defaulted", "agent_proposed"].includes(workload.source) || typeof workload.confirmedByUser !== "boolean")) return false;
  }
  if (new Set(workloadIds).size !== workloadIds.length) return false;
  const constraintIds = [];
  for (const constraint of value.constraints) {
    if (!object(constraint) || !nonEmpty(constraint.constraintId)) return false;
    constraintIds.push(constraint.constraintId.normalize("NFC"));
    if (constraint.state === "deferred" || constraint.state === "not_applicable") {
      if (!exactOrSubset(constraint, ["constraintId", "state", "source", "confirmedByUser"], ["constraintId", "state", "source", "confirmedByUser"]) || !["user", "migration", "agent_proposed"].includes(constraint.source) || typeof constraint.confirmedByUser !== "boolean") return false;
      continue;
    }
    const allowed = constraint.state === "answered" ? ["constraintId", "state", "predicate", "strength", "source", "confirmedByUser"] : ["constraintId", "predicate", "strength", "source", "confirmedByUser"];
    if (!exactOrSubset(constraint, allowed, ["constraintId", "predicate", "strength", "source", "confirmedByUser"]) || (constraint.state !== undefined && constraint.state !== "answered") || !object(constraint.predicate)
      || !facetPredicate(constraint.predicate)
      || !["hard", "soft"].includes(constraint.strength) || !["user", "migration", "agent_proposed"].includes(constraint.source) || typeof constraint.confirmedByUser !== "boolean") return false;
  }
  return new Set(constraintIds).size === constraintIds.length;
}

function validateV2(config) {
  const errors = [];
  const fields = ["schemaVersion", "id", "name", "updatedAt", "caseId", "boardId", "cpuId", "selection", "bom", "notes", "migration"];
  const required = ["schemaVersion", "id", "name", "updatedAt", "caseId", "boardId", "cpuId", "selection", "bom"];
  if (!exactOrSubset(config, fields, required)) return ["Malformed BuildConfig: unknown or missing fields"];
  if (config.schemaVersion !== "2.0.0" || !nonEmpty(config.id) || !nonEmpty(config.name) || !nonEmpty(config.updatedAt)
    || typeof config.caseId !== "string" || typeof config.boardId !== "string" || typeof config.cpuId !== "string"
    || !object(config.selection) || !Array.isArray(config.bom)) errors.push("Malformed BuildConfig: missing required fields");
  const selection = config.selection;
  const selectionFields = ["psuId", "psuTopology", "secondaryPsuId", "dualStart", "coolerId", "gpuId", "memoryId", "diskCount", "diskSkuId", "nvmeCount", "boot", "hbaMode", "hbaSkuId", "fanMode", "fanGroups"];
  const selectionRequired = ["psuId", "psuTopology", "coolerId", "gpuId", "memoryId", "diskCount", "boot", "hbaMode"];
  if (!exactOrSubset(selection, selectionFields, selectionRequired)
    || [selection?.psuId, selection?.coolerId, selection?.gpuId, selection?.memoryId].some((value) => typeof value !== "string")
    || (selection?.secondaryPsuId !== undefined && selection.secondaryPsuId !== null && typeof selection.secondaryPsuId !== "string")
    || (selection?.diskSkuId !== undefined && typeof selection.diskSkuId !== "string")
    || (selection?.hbaSkuId !== undefined && selection.hbaSkuId !== null && typeof selection.hbaSkuId !== "string")) errors.push("Malformed BuildConfig: selection shape invalid");
  if (!Number.isSafeInteger(selection?.diskCount) || selection.diskCount < 0
    || (selection?.nvmeCount !== undefined && (!Number.isSafeInteger(selection.nvmeCount) || selection.nvmeCount < 0))) errors.push("Malformed BuildConfig: disk counts must be non-negative integers");
  if (!["auto", "bottom", "dual"].includes(selection?.psuTopology) || !["bay", "m2", "usbssd"].includes(selection?.boot) || !["auto", "always"].includes(selection?.hbaMode)
    || (selection?.dualStart !== undefined && selection.dualStart !== null && !["sync", "none"].includes(selection.dualStart))) errors.push("Malformed BuildConfig: selection enum invalid");
  if (selection?.fanMode !== undefined && !["quiet", "balanced", "performance"].includes(selection.fanMode)) errors.push("Malformed BuildConfig: invalid fan mode");
  const groups = selection?.fanGroups;
  if (groups !== undefined && (!Array.isArray(groups) || groups.length > 16 || groups.some((group) => !exactOrSubset(group, ["mountId", "sizeMm", "count"], ["mountId", "sizeMm", "count"]) || !nonEmpty(group.mountId) || ![120, 140].includes(group.sizeMm) || !Number.isSafeInteger(group.count) || group.count < 1 || group.count > 16) || new Set(groups.map((group) => group.mountId)).size !== groups.length)) errors.push("Malformed BuildConfig: invalid fan groups");
  if (!Array.isArray(config.bom) || config.bom.some((line) => !exactOrSubset(line, ["skuId", "qty", "bucket"], ["skuId", "qty", "bucket"]) || !nonEmpty(line.skuId) || !Number.isSafeInteger(line.qty) || line.qty <= 0 || !["owned", "buy_now", "upgrade_later", "optional"].includes(line.bucket))
    || new Set(config.bom.map((line) => line.skuId)).size !== config.bom.length) errors.push("Malformed BuildConfig: invalid BOM");
  if (config.notes !== undefined && (!Array.isArray(config.notes) || config.notes.some((note) => typeof note !== "string"))) errors.push("Malformed BuildConfig: notes invalid");
  if (config.migration !== undefined && (!exactOrSubset(config.migration, ["fromSchemaVersion", "toSchemaVersion"], ["fromSchemaVersion", "toSchemaVersion"])
    || !nonEmpty(config.migration.fromSchemaVersion) || config.migration.toSchemaVersion !== "2.0.0")) errors.push("Malformed BuildConfig: migration invalid");
  return errors;
}

function validateV3(config) {
  const errors = [];
  const fields = ["schemaVersion", "id", "name", "updatedAt", "intent", "requirementSpec", "system", "components", "roleDecisions", "placements", "connections", "logicalLayouts", "firmwareTargets", "notes"];
  if (!exactOrSubset(config, fields, fields.slice(0, -1))) return ["build config contains derived, unknown, or missing fields"];
  if (config.schemaVersion !== "3.0.0" || !nonEmpty(config.id) || !nonEmpty(config.name) || !iso(config.updatedAt)) errors.push("build config identity/schema invalid");
  if (config.intent !== null && !draftField(config.intent, "intent")) errors.push("intent invalid");
  if (config.requirementSpec !== null && !requirementSpec(config.requirementSpec)) errors.push("requirementSpec invalid");
  if (config.system !== null && (!exactOrSubset(config.system, ["profileId", "versionFactId", "source", "lockedByUser"], ["profileId", "versionFactId", "source", "lockedByUser"]) || !SYSTEM_PROFILES.has(config.system.profileId) || !nonEmpty(config.system.versionFactId) || !["defaulted", "user"].includes(config.system.source) || typeof config.system.lockedByUser !== "boolean")) errors.push("system selection invalid");
  for (const field of ["components", "roleDecisions", "placements", "connections", "logicalLayouts", "firmwareTargets"]) if (!Array.isArray(config[field])) errors.push(`${field} must be an array`);
  const notesInvalid = config.notes !== undefined && (!Array.isArray(config.notes) || config.notes.some((note) => typeof note !== "string"));
  if (errors.length || notesInvalid) return [...errors, ...(notesInvalid ? ["notes invalid"] : [])];
  const componentIds = new Set(); const kinds = new Map(); const roles = new Set();
  for (const component of config.components) {
    const componentId = stableId(component?.instanceId); const role = stableId(component?.role);
    if (!exactOrSubset(component, ["instanceId", "kind", "role", "state", "identity", "source"], ["instanceId", "kind", "role", "state", "identity", "source"]) || !componentId || componentIds.has(componentId) || !COMPONENT_KINDS.has(component.kind) || !role || !["planned", "ordered"].includes(component.state) || !["user", "agent", "migration"].includes(component.source)) { errors.push("component invalid"); continue; }
    componentIds.add(componentId); kinds.set(componentId, component.kind); roles.add(role);
    const identity = component.identity;
    if (identity?.status === "unresolved" ? !exactOrSubset(identity, ["status", "userText", "candidateIds"], ["status", "userText"]) || !nonEmpty(identity.userText) || (identity.candidateIds !== undefined && !uniqueStrings(identity.candidateIds)) : identity?.status === "resolved" ? !exactOrSubset(identity, ["status", "skuId", "identityClaimIds"], ["status", "skuId", "identityClaimIds"]) || !nonEmpty(identity.skuId) || !uniqueStrings(identity.identityClaimIds, true) : true) errors.push("component identity invalid");
  }
  const decisionIds = new Set(); const decisionRoles = new Set();
  for (const decision of config.roleDecisions) {
    const decisionId = stableId(decision?.roleDecisionId); const role = stableId(decision?.role);
    if (!exactOrSubset(decision, ["roleDecisionId", "role", "decision", "source", "confirmedAt"], ["roleDecisionId", "role", "decision", "source", "confirmedAt"]) || !decisionId || decisionIds.has(decisionId) || !role || decisionRoles.has(role) || roles.has(role) || decision.decision !== "not_needed" || !["user", "migration"].includes(decision.source) || !iso(decision.confirmedAt)) errors.push("role decision invalid");
    if (decisionId) decisionIds.add(decisionId); if (role) decisionRoles.add(role);
  }
  const placementIds = new Set(); const mounts = new Set();
  for (const placement of config.placements) {
    const placementId = stableId(placement?.placementId); const componentId = stableId(placement?.componentInstanceId); const ownerId = stableId(placement?.mountOwnerInstanceId); const mountId = stableId(placement?.mountId); const mountKey = `${ownerId}\0${mountId}`;
    if (!exactOrSubset(placement, ["placementId", "componentInstanceId", "mountOwnerInstanceId", "mountId"], ["placementId", "componentInstanceId", "mountOwnerInstanceId", "mountId"]) || !placementId || placementIds.has(placementId) || !componentId || !componentIds.has(componentId) || !ownerId || !componentIds.has(ownerId) || !mountId || mounts.has(mountKey)) errors.push("placement invalid");
    if (placementId) placementIds.add(placementId); mounts.add(mountKey);
  }
  const connectionIds = new Set(); const cables = new Set();
  for (const connection of config.connections) {
    const endpoint = (value) => exactOrSubset(value, ["instanceId", "portId"], ["instanceId", "portId"]) && componentIds.has(stableId(value.instanceId)) && stableId(value.portId);
    const connectionId = stableId(connection?.connectionId); const fromKey = `${stableId(connection?.from?.instanceId)}\0${stableId(connection?.from?.portId)}`; const toKey = `${stableId(connection?.to?.instanceId)}\0${stableId(connection?.to?.portId)}`; const cableId = connection?.cableInstanceId === undefined ? undefined : stableId(connection.cableInstanceId);
    if (!exactOrSubset(connection, ["connectionId", "from", "to", "cableInstanceId", "status"], ["connectionId", "from", "to", "status"]) || !connectionId || connectionIds.has(connectionId) || !endpoint(connection.from) || !endpoint(connection.to) || fromKey === toKey || !["required", "planned", "satisfied", "blocked"].includes(connection.status) || (connection.cableInstanceId !== undefined && (!cableId || !componentIds.has(cableId) || kinds.get(cableId) !== "cable" || cables.has(cableId)))) errors.push("connection invalid");
    if (connectionId) connectionIds.add(connectionId); if (cableId) cables.add(cableId);
  }
  const layoutIds = new Set(); const globallyAssignedDisks = new Set();
  for (const layout of config.logicalLayouts) {
    const layoutId = stableId(layout?.layoutId);
    if (!exactOrSubset(layout, ["layoutId", "bootPoolDiskIds", "vdevs", "spareDiskIds"], ["layoutId", "bootPoolDiskIds", "vdevs", "spareDiskIds"]) || !layoutId || layoutIds.has(layoutId) || !uniqueStrings(layout.bootPoolDiskIds) || !uniqueStrings(layout.spareDiskIds) || !Array.isArray(layout.vdevs)) { errors.push("logical layout invalid"); continue; }
    layoutIds.add(layoutId); const assigned = [...layout.bootPoolDiskIds, ...layout.spareDiskIds].map(stableId); const vdevIds = new Set();
    for (const vdev of layout.vdevs) {
      const minimum = { stripe: 1, mirror: 2, raidz1: 2, raidz2: 3, raidz3: 4 }[vdev?.topology];
      const vdevId = stableId(vdev?.vdevId); const disks = Array.isArray(vdev?.diskInstanceIds) ? vdev.diskInstanceIds.map(stableId) : [];
      if (!exactOrSubset(vdev, ["vdevId", "topology", "diskInstanceIds"], ["vdevId", "topology", "diskInstanceIds"]) || !vdevId || vdevIds.has(vdevId) || !minimum || !uniqueStrings(vdev.diskInstanceIds, true) || vdev.diskInstanceIds.length < minimum || disks.some((id) => !id || !componentIds.has(id) || kinds.get(id) !== "storage_drive")) errors.push("vdev invalid");
      if (vdevId) vdevIds.add(vdevId); assigned.push(...disks);
    }
    if (assigned.some((id) => !id || !componentIds.has(id) || kinds.get(id) !== "storage_drive") || new Set(assigned).size !== assigned.length || assigned.some((id) => globallyAssignedDisks.has(id))) errors.push("logical layout disk assignment invalid");
    assigned.forEach((id) => { if (id) globallyAssignedDisks.add(id); });
  }
  const firmwareIds = new Set();
  for (const target of config.firmwareTargets) {
    const instanceId = stableId(target?.instanceId);
    if (!exactOrSubset(target, ["instanceId", "targetReleaseFactId", "requestedSettings", "source"], ["instanceId", "targetReleaseFactId", "requestedSettings", "source"]) || !instanceId || !componentIds.has(instanceId) || firmwareIds.has(instanceId) || !nonEmpty(target.targetReleaseFactId) || !["user", "system_requirement"].includes(target.source) || !Array.isArray(target.requestedSettings)) { errors.push("firmware target invalid"); continue; }
    firmwareIds.add(instanceId); const settings = new Set();
    for (const setting of target.requestedSettings) { const settingId = stableId(setting?.settingId); if (!exactOrSubset(setting, ["settingId", "desiredValue"], ["settingId", "desiredValue"]) || !settingId || !Object.prototype.hasOwnProperty.call(FIRMWARE_SETTINGS, setting.settingId) || !FIRMWARE_SETTINGS[setting.settingId].includes(setting.desiredValue) || settings.has(settingId)) errors.push("firmware setting invalid"); else settings.add(settingId); }
  }
  return errors;
}

/** Pure semantic validator used by raw Node production graph/Doctor paths. */
export function validatePlanConfigRuntime(config, options = { topologyV3Enabled: true }) {
  if (!object(config)) return ["config must be an object"];
  if (config.schemaVersion === "2.0.0") return validateV2(config);
  if (config.schemaVersion === "3.0.0") {
    if (containsIllFormedUnicode(config)) return ["build config contains ill-formed Unicode text"];
    return options.topologyV3Enabled === true ? validateV3(config) : ["BuildConfig V3 is disabled"];
  }
  return [`unsupported plan config schema: ${String(config.schemaVersion ?? "missing")}`];
}

function evidenceLocator(value) {
  if (!object(value) || !exactOrSubset(value, ["page", "printedPage", "section", "field", "locator", "snippet"]) || Object.keys(value).length === 0) return false;
  const page = value.page;
  if (page !== undefined && !(Number.isSafeInteger(page) && page > 0
    || Array.isArray(page) && page.length > 0 && page.every((item) => Number.isSafeInteger(item) && item > 0))) return false;
  const printedPage = value.printedPage;
  if (printedPage !== undefined && !(nonEmpty(printedPage)
    || Array.isArray(printedPage) && printedPage.length > 0 && printedPage.every(nonEmpty))) return false;
  return ["section", "field", "locator", "snippet"].every((key) => value[key] === undefined || nonEmpty(value[key]));
}

function evidenceBindingIdentityRuntime(binding) {
  const purposes = [...binding.purposes].sort();
  const locators = binding.locators
    ? [...binding.locators].map((locator) => structuredClone(locator)).sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)))
    : undefined;
  return {
    planId: binding.planId,
    documentId: binding.documentId,
    ...(binding.captureId ? { captureId: binding.captureId } : {}),
    subject: structuredClone(binding.subject),
    purposes,
    ...(locators ? { locators } : {}),
  };
}

export function evidenceBindingIdRuntime(binding) {
  return `binding-sha256-${sha256Utf8(canonicalize(evidenceBindingIdentityRuntime(binding)))}`;
}

export function validatePlanEvidenceBindingRuntime(binding, context = {}) {
  const allowed = ["schemaVersion", "id", "planId", "planVersionId", "documentId", "contentHash", "captureId", "subject", "purposes", "locators", "boundAt", "note"];
  const required = ["schemaVersion", "id", "planId", "documentId", "contentHash", "subject", "purposes", "boundAt"];
  if (!object(binding) || !exactOrSubset(binding, allowed, required)) return ["evidence binding shape is invalid"];
  const errors = [];
  if (binding.schemaVersion !== "1.0.0" || !/^binding-sha256-[a-f0-9]{64}$/.test(String(binding.id ?? ""))
    || !nonEmpty(binding.planId) || !/^doc-sha256-[a-f0-9]{64}$/.test(String(binding.documentId ?? ""))
    || !SHA256.test(String(binding.contentHash ?? "")) || binding.documentId !== `doc-sha256-${binding.contentHash}` || !iso(binding.boundAt)
    || (binding.captureId !== undefined && !/^capture-sha256-[a-f0-9]{64}$/.test(String(binding.captureId)))) errors.push("evidence binding identity/hash is invalid");
  if (context.planId !== undefined && binding.planId !== context.planId) errors.push("evidence binding plan owner is invalid");
  if (context.versionId === undefined) {
    if (binding.planVersionId !== undefined && binding.planVersionId !== null) errors.push("draft evidence binding must not claim a plan version");
  } else if (binding.planVersionId !== context.versionId) errors.push("version evidence binding owner is invalid");
  const subject = binding.subject;
  if (!object(subject) || !EVIDENCE_SUBJECTS.has(subject.kind) || !nonEmpty(subject.id)
    || !exactOrSubset(subject, ["kind", "id", "category"], ["kind", "id"])
    || (subject.category !== undefined && !EVIDENCE_CATEGORIES.has(subject.category))
    || (subject.category !== undefined && !["sku", "component"].includes(subject.kind))
    || (subject.kind === "plan" && context.planId !== undefined && subject.id !== context.planId)) errors.push("evidence binding subject is invalid");
  if (!Array.isArray(binding.purposes) || binding.purposes.length === 0 || new Set(binding.purposes).size !== binding.purposes.length
    || binding.purposes.some((purpose) => !EVIDENCE_PURPOSES.has(purpose))) errors.push("evidence binding purposes are invalid");
  if (binding.locators !== undefined && (!Array.isArray(binding.locators) || binding.locators.length === 0 || binding.locators.some((locator) => !evidenceLocator(locator)))) errors.push("evidence binding locators are invalid");
  if (binding.note !== undefined && (typeof binding.note !== "string" || binding.note.length > 500)) errors.push("evidence binding note is invalid");
  try {
    if (binding.id !== evidenceBindingIdRuntime(binding)) errors.push("evidence binding ID does not match semantic identity");
  } catch {
    errors.push("evidence binding semantic identity is invalid");
  }
  return errors;
}

function validatePlanEvidenceBindingsRuntime(bindings, context) {
  if (bindings === undefined) return [];
  if (!Array.isArray(bindings)) return ["evidenceBindings must be an array"];
  const errors = []; const ids = new Set(); const semanticIdentities = new Set();
  bindings.forEach((binding, index) => {
    errors.push(...validatePlanEvidenceBindingRuntime(binding, context).map((error) => `evidenceBindings.${index}: ${error}`));
    if (ids.has(binding?.id)) errors.push(`evidenceBindings.${index}: binding ID is duplicated`);
    ids.add(binding?.id);
    try {
      const identity = canonicalize(evidenceBindingIdentityRuntime(binding));
      if (semanticIdentities.has(identity)) errors.push(`evidenceBindings.${index}: binding semantic identity is duplicated`);
      semanticIdentities.add(identity);
    } catch {
      // The item validator reports the malformed identity.
    }
  });
  return errors;
}

function planIntentRuntime(value) {
  const allowed = ["useCase", "budgetCny", "region", "targetResolution", "targetFps", "games", "ownedSkuIds", "preferences"];
  return exactOrSubset(value, allowed, ["useCase"]) && nonEmpty(value.useCase)
    && (value.budgetCny === undefined || value.budgetCny === null || typeof value.budgetCny === "number" && Number.isFinite(value.budgetCny) && value.budgetCny >= 0)
    && (value.region === undefined || typeof value.region === "string")
    && (value.targetResolution === undefined || ["1080p", "1440p", "4k", "other"].includes(value.targetResolution))
    && (value.targetFps === undefined || value.targetFps === null || typeof value.targetFps === "number" && Number.isFinite(value.targetFps) && value.targetFps >= 0)
    && ["games", "ownedSkuIds", "preferences"].every((key) => value[key] === undefined || Array.isArray(value[key]) && value[key].every((item) => typeof item === "string"));
}

function planInitializationRuntime(value) {
  return exactOrSubset(value, ["status", "source", "intent", "proposalId", "initializedAt"], ["status", "source"])
    && ["pending", "initialized"].includes(value.status) && ["agent", "template", "manual"].includes(value.source)
    && (value.intent === undefined || planIntentRuntime(value.intent))
    && (value.proposalId === undefined || nonEmpty(value.proposalId))
    && (value.initializedAt === undefined || iso(value.initializedAt));
}

function planMetadataRuntime(value) {
  return exactOrSubset(value, ["useCase", "budgetCny", "tags", "initialization"])
    && (value.useCase === undefined || typeof value.useCase === "string")
    && (value.budgetCny === undefined || value.budgetCny === null || typeof value.budgetCny === "number" && Number.isFinite(value.budgetCny) && value.budgetCny >= 0)
    && (value.tags === undefined || Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string"))
    && (value.initialization === undefined || planInitializationRuntime(value.initialization));
}

export function validatePlanVersionRuntime(version, options = { topologyV3Enabled: true }) {
  const errors = [];
  let configHashMatches = false;
  let evidenceHashMatches = version?.evidenceBindings === undefined && version?.evidenceHash === undefined;
  try {
    configHashMatches = object(version?.config) && SHA256.test(String(version?.configHash ?? ""))
      && version.configHash === hashPlanConfigRuntime(version.config);
  } catch {
    // Persisted hostile input must produce diagnostics instead of escaping the
    // production graph/Doctor validator as an exception.
  }
  if (version?.evidenceBindings !== undefined || version?.evidenceHash !== undefined) {
    try {
      evidenceHashMatches = Array.isArray(version?.evidenceBindings) && SHA256.test(String(version?.evidenceHash ?? ""))
        && version.evidenceHash === sha256JsonRuntime(version.evidenceBindings);
    } catch {
      evidenceHashMatches = false;
    }
  }
  const allowed = ["schemaVersion", "id", "planId", "versionNumber", "createdAt", "reason", "summary", "config", "configHash", "evidenceBindings", "evidenceHash", "evaluationHash", "evaluatedAt", "evaluationLock", "parentVersionId"];
  const required = ["schemaVersion", "id", "planId", "versionNumber", "createdAt", "reason", "config", "configHash", "parentVersionId"];
  if (!exactOrSubset(version, allowed, required) || version.schemaVersion !== "1.0.0" || !nonEmpty(version.id) || !nonEmpty(version.planId) || !Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1 || !iso(version.createdAt)
    || !["initial", "manual-save", "agent-proposal", "import", "restore", "migration-source"].includes(version.reason) || !configHashMatches
    || (version.parentVersionId !== null && !nonEmpty(version.parentVersionId))
    || (version.summary !== undefined && (typeof version.summary !== "string" || version.summary.length > 500))
    || (version.evaluationHash !== undefined && !SHA256.test(String(version.evaluationHash)))
    || (version.evaluationLock !== undefined && version.evaluationHash === undefined)
    || (version.evaluatedAt !== undefined && !iso(version.evaluatedAt))) errors.push("plan version identity/schema/config hash invalid");
  errors.push(...validatePlanConfigRuntime(version?.config, options).map((error) => `config: ${error}`));
  errors.push(...validatePlanEvidenceBindingsRuntime(version?.evidenceBindings, { planId: version?.planId, versionId: version?.id }));
  if (!evidenceHashMatches) errors.push("plan version evidence hash invalid");
  if (version?.evaluationLock !== undefined) errors.push(...validatePlanEvaluationLockRuntime(version.evaluationLock));
  return errors;
}

const SNAPSHOT_HASH_FIELDS = [
  "configHash", "requirementSpecHash", "factSnapshotHash", "userObservationSnapshotHash", "priceSnapshotHash", "ruleSetHash",
  "systemProfileHash", "adapterSnapshotHash", "engineHash", "simulationModelHash", "simulationInputHash",
];

export function validatePlanEvaluationLockRuntime(value) {
  const errors = [];
  const fields = ["schemaVersion", "planId", "snapshotHashes", "factSnapshotId", "userObservationSnapshotId", "artifactLockfileHash", "contentHash"];
  if (!exactOrSubset(value, fields, fields) || value.schemaVersion !== "plan-evaluation-lock-v1" || !nonEmpty(value.planId) || !nonEmpty(value.factSnapshotId)
    || !nonEmpty(value.userObservationSnapshotId) || !SHA256.test(String(value.artifactLockfileHash ?? "")) || !SHA256.test(String(value.contentHash ?? ""))) {
    return ["plan evaluation lock structure invalid"];
  }
  if (!exactOrSubset(value.snapshotHashes, SNAPSHOT_HASH_FIELDS, SNAPSHOT_HASH_FIELDS)
    || SNAPSHOT_HASH_FIELDS.some((field) => !SHA256.test(String(value.snapshotHashes[field] ?? "")))) errors.push("plan evaluation lock snapshot hashes invalid");
  try {
    const material = { ...value };
    delete material.contentHash;
    const preimage = `buildsim\0hash-spec-v1\0plan-evaluation-lock\0plan-evaluation-lock-v1\0${canonicalJsonRuntime(material).normalize("NFC")}`;
    if (sha256Utf8(preimage) !== value.contentHash) errors.push("plan evaluation lock content hash invalid");
  } catch { errors.push("plan evaluation lock content hash invalid"); }
  return errors;
}

/** Validate durable migration metadata and its resolved immutable source version. */
export function validatePlanConfigMigrationRuntime(record, context) {
  const errors = [];
  const allowed = ["schemaVersion", "sourceSchemaVersion", "targetSchemaVersion", "sourceVersionId", "sourceConfigHash", "migratedAt", "catalogBinding", "diff", "warnings", "rollbackRef"];
  if (!exactOrSubset(record, allowed, allowed) || record.schemaVersion !== "plan-config-migration-v1" || record.sourceSchemaVersion !== "2.0.0" || record.targetSchemaVersion !== "3.0.0" || !nonEmpty(record.sourceVersionId) || !SHA256.test(String(record.sourceConfigHash ?? "")) || !iso(record.migratedAt)
    || !Array.isArray(record.diff) || record.diff.some((item) => !migrationDiff(item))
    || !Array.isArray(record.warnings) || record.warnings.some((item) => !migrationWarning(item))
    || !validateMigrationCatalogBindingRuntime(record.catalogBinding, context?.sourceVersion?.config?.selection?.coolerId)) return ["config migration record invalid"];
  const source = context?.sourceVersion;
  if (!context || !nonEmpty(context.planId) || context.config?.schemaVersion !== "3.0.0" || !source || source.id !== record.sourceVersionId || source.planId !== context.planId || source.config?.schemaVersion !== "2.0.0" || validatePlanVersionRuntime(source, { topologyV3Enabled: false }).length || source.configHash !== record.sourceConfigHash) errors.push("config migration source version closure invalid");
  const sourceBytes = source?.config ? `${JSON.stringify(source.config, null, 2)}\n` : "";
  const rollback = record.rollbackRef;
  if (!exactOrSubset(rollback, ["schemaVersion", "configId", "sourceSchemaVersion", "sourceHash", "sourceByteLength"], ["schemaVersion", "configId", "sourceSchemaVersion", "sourceHash", "sourceByteLength"])
    || rollback.schemaVersion !== "build-config-v2-rollback-ref-v1" || rollback.configId !== context?.planId || rollback.sourceSchemaVersion !== "2.0.0"
    || rollback.sourceHash !== sha256Utf8(sourceBytes) || rollback.sourceByteLength !== new TextEncoder().encode(sourceBytes).byteLength) errors.push("config migration rollback closure invalid");
  if (source?.config?.schemaVersion === "2.0.0" && SHA256.test(String(rollback?.sourceHash ?? ""))) {
    try {
      const expected = recomputeMigrationAuditRuntime(source.config, rollback.sourceHash, record.catalogBinding);
      if (sha256JsonRuntime(record.diff) !== sha256JsonRuntime(expected.diff) || sha256JsonRuntime(record.warnings) !== sha256JsonRuntime(expected.warnings)) errors.push("config migration audit does not match immutable source");
    } catch {
      errors.push("config migration audit cannot be recomputed from immutable source");
    }
  }
  return errors;
}

/**
 * Resolve the narrow historical catalog authority carried by a valid migration.
 * Only the exact cooler component projected from the immutable V2 source is
 * returned; callers must continue validating every other resolved identity
 * against its normal catalog authority.
 */
export function migrationCatalogProjectionRuntime(record, context) {
  try {
    if (validatePlanConfigMigrationRuntime(record, context).length) return null;
    const expected = recomputeMigrationAuditRuntime(context.sourceVersion.config, record.rollbackRef.sourceHash, record.catalogBinding);
    const cooler = expected.components.find((component) => component.identity?.status === "resolved"
      && component.identity.skuId === context.sourceVersion.config.selection.coolerId
      && component.role === "cpu_cooler") ?? null;
    return {
      sourceVersionId: record.sourceVersionId,
      sourceCoolerSkuId: context.sourceVersion.config.selection.coolerId,
      migratedCoolerComponent: cooler ? structuredClone(cooler) : null,
      bindingHash: record.catalogBinding.bindingHash,
    };
  } catch {
    return null;
  }
}

export function validatePlanRuntime(plan, context = {}) {
  const errors = [];
  const planAllowed = ["schemaVersion", "id", "name", "description", "status", "createdAt", "updatedAt", "activeVersionId", "draftRevision", "draft", "metadata"];
  const planRequired = ["schemaVersion", "id", "name", "status", "createdAt", "updatedAt", "activeVersionId", "draftRevision", "draft", "metadata"];
  const draftAllowed = ["schemaVersion", "baseVersionId", "config", "configMigration", "evidenceBindings", "dirty", "updatedAt"];
  const draftRequired = ["schemaVersion", "baseVersionId", "config", "dirty", "updatedAt"];
  if (!exactOrSubset(plan, planAllowed, planRequired) || plan.schemaVersion !== "1.0.0" || !nonEmpty(plan.id) || !nonEmpty(plan.name) || (plan.description !== undefined && typeof plan.description !== "string") || !["active", "archived"].includes(plan.status) || !iso(plan.createdAt) || !iso(plan.updatedAt)
    || (plan.activeVersionId !== null && !nonEmpty(plan.activeVersionId)) || !Number.isSafeInteger(plan.draftRevision) || plan.draftRevision < 0 || !planMetadataRuntime(plan.metadata) || !exactOrSubset(plan.draft, draftAllowed, draftRequired)
    || plan.draft.schemaVersion !== "1.0.0" || (plan.draft.baseVersionId !== null && !nonEmpty(plan.draft.baseVersionId)) || typeof plan.draft.dirty !== "boolean" || !iso(plan.draft.updatedAt)) errors.push("plan identity/schema/draft invalid");
  errors.push(...validatePlanConfigRuntime(plan?.draft?.config, { topologyV3Enabled: context.topologyV3Enabled !== false }).map((error) => `draft.config: ${error}`));
  errors.push(...validatePlanEvidenceBindingsRuntime(plan?.draft?.evidenceBindings, { planId: plan?.id }));
  if (plan?.draft?.configMigration !== undefined) errors.push(...validatePlanConfigMigrationRuntime(plan.draft.configMigration, { planId: plan.id, config: plan.draft.config, sourceVersion: context.sourceVersion, catalog: context.catalog }).map((error) => `draft.configMigration: ${error}`));
  return errors;
}
