import { readFile } from "node:fs/promises";
import { confined, sha256Json } from "../runtime/fs.mjs";
import { hashPlanConfigRuntime, validatePlanConfigRuntime } from "../plans/canonical-runtime.mjs";
import { validateResolvedV3CatalogBindingsRuntime } from "../config/v3-catalog-runtime.mjs";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import {
  validateSolverWhatIfArtifactRuntime,
} from "../solver/runtime-validation.mjs";

const ENVELOPE_VERSION = "scenario-repository-envelope-v1";
const SCHEMA_VERSION = "1.0.0";
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const REF = /^sha256:[a-f0-9]{64}$/;
const SNAPSHOT_SET_ID = /^snapshot-set-[a-f0-9]{64}$/;
const COMPONENT_KINDS = new Set(["case", "motherboard", "cpu", "memory_module", "gpu", "psu", "cpu_cooler", "aio", "radiator", "pump", "case_fan", "fan_rgb_hub", "storage_drive", "hba", "raid_controller", "storage_expander", "backplane", "nic", "capture_card", "expansion_board", "pcie_card", "cable", "adapter", "bracket"]);
const FIRMWARE_SETTINGS = Object.freeze({
  iommu: ["enabled", "disabled"], virtualization: ["enabled", "disabled"], secure_boot: ["enabled", "disabled"],
  tpm: ["enabled", "disabled"], csm: ["enabled", "disabled"], storage_controller_mode: ["ahci", "raid", "hba_it"],
  memory_profile: ["jedec", "xmp", "expo"], resizable_bar: ["enabled", "disabled"], above_4g_decoding: ["enabled", "disabled"],
  ecc: ["enabled", "disabled", "auto"],
});
const METRIC_IDS = new Set(["budget.total", "service.horizon", "performance.cpu.multicore", "performance.gpu.frame_rate", "memory.capacity", "storage.usable_capacity", "storage.concurrent_disk_count", "network.throughput", "power.capacity", "physical.case_volume", "physical.gpu_length", "thermal.ambient", "acoustics.noise", "platform.operating_system"]);
const FACET_IDS = new Set(["identity.category", "identity.manufacturer", "identity.model", "identity.revision", "physical.width", "physical.height", "physical.depth", "mount.standard", "mount.point_ids", "cpu.socket", "motherboard.cpu_socket", "motherboard.chipset", "motherboard.memory_type", "motherboard.memory_slot_count", "motherboard.memory_population_rules", "motherboard.form_factor", "motherboard.bios_version", "motherboard.bios_upgrade_methods", "motherboard.display_outputs", "motherboard.supported_operating_systems", "memory.type", "memory.capacity", "io.port_types", "io.header_types", "io.endpoint_ids", "case.motherboard_form_factors", "case.side_panel", "case.gpu_max_length", "case.cpu_cooler_max_height", "gpu.length", "gpu.slot_width", "gpu.power_connectors", "psu.capacity", "psu.connectors", "power.source_type", "power.load", "power.cable_families", "pcie.lane_count", "pcie.slot_types", "pcie.lane_sharing", "storage.interface", "storage.boot_support", "storage.capacity_bytes", "storage.recording_technology", "hba.mode", "cooling.fan_mounts", "cooling.radiator_support", "cooling.pump_header", "firmware.version", "firmware.upgrade_path_refs", "driver.supported_operating_systems", "driver.package_versions", "thermal.curve_refs", "acoustic.curve_refs", "package.contents", "resource.kind", "cable.connector_standard", "fastener.thread", "fastener.length_mm", "fastener.head", "tool.drive", "consumable.type", "accessory.standard", "acoustic.noise_class"]);
const COLLECTIONS = Object.freeze({
  config: { parent: false, fields: ["name", "intent", "requirementSpec", "requirementBudget", "requirementHorizonYears", "system", "notes"] },
  components: { parent: false, fields: ["kind", "role", "state", "identity"] },
  roleDecisions: { parent: false, fields: [] },
  placements: { parent: false, fields: ["componentInstanceId", "mountOwnerInstanceId", "mountId"] },
  connections: { parent: false, fields: ["from", "to", "cableInstanceId", "status"] },
  logicalLayouts: { parent: false, fields: ["bootPoolDiskIds", "spareDiskIds"] },
  vdevs: { parent: true, fields: ["topology", "diskInstanceIds"] },
  firmwareTargets: { parent: false, fields: ["targetReleaseFactId", "requestedSettings"] },
  workloads: { parent: false, fields: ["name", "evidenceOrBenchmarkRefs"] },
  metrics: { parent: true, fields: [] }, constraints: { parent: false, fields: [] },
});
const SNAPSHOT_FIELDS = Object.freeze([
  "adapterSnapshotHash", "configHash", "engineHash", "factSnapshotHash", "priceSnapshotHash",
  "requirementSpecHash", "ruleSetHash", "simulationInputHash", "simulationModelHash", "systemProfileHash",
  "userObservationSnapshotHash",
]);

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function normalizeScenarioAuthorityValue(value) {
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(normalizeScenarioAuthorityValue);
  if (object(value)) {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key.normalize("NFC"), normalizeScenarioAuthorityValue(child)]);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new TypeError("scenario authority keys collide after NFC normalization");
    return Object.fromEntries(entries);
  }
  return value;
}
function exact(value, fields) {
  return object(value) && Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
}
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function invariant(condition, message) { if (!condition) throw new Error(message); }
function validSnapshots(value) {
  return exact(value, SNAPSHOT_FIELDS) && SNAPSHOT_FIELDS.every((field) => SHA256.test(String(value[field] ?? "")));
}
export function createScenarioSnapshotSetManifest(snapshotHashes) {
  const normalized = normalizeScenarioAuthorityValue(snapshotHashes);
  if (!validSnapshots(normalized)) throw new TypeError("scenario snapshot hashes are invalid");
  const contentHash = sha256Json(normalized);
  return {
    schemaVersion: "scenario-snapshot-set-v1",
    snapshotSetId: `snapshot-set-${contentHash}`,
    snapshotHashes: normalized,
    contentHash,
  };
}
export function validateScenarioSnapshotSetManifest(value, expectedId) {
  if (!exact(value, ["schemaVersion", "snapshotSetId", "snapshotHashes", "contentHash"])
    || value.schemaVersion !== "scenario-snapshot-set-v1" || !SNAPSHOT_SET_ID.test(String(value.snapshotSetId ?? ""))
    || !validSnapshots(value.snapshotHashes) || value.contentHash !== sha256Json(normalizeScenarioAuthorityValue(value.snapshotHashes))
    || value.snapshotSetId !== `snapshot-set-${value.contentHash}` || (expectedId !== undefined && value.snapshotSetId !== expectedId)) {
    return ["scenario snapshot-set manifest identity/content hash is invalid"];
  }
  return [];
}
function envelopePayload(record, kind) {
  const value = record.value;
  invariant(exact(value, ["schemaVersion", "kind", "checksum", "payload"])
    && value.schemaVersion === ENVELOPE_VERSION && value.kind === kind
    && value.checksum === sha256Json(value.payload), `scenario ${kind} envelope/checksum is invalid`);
  return value.payload;
}
function containsUserAssertion(value) {
  if (Array.isArray(value)) return value.some(containsUserAssertion);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, child]) => key === "confirmedAt" || (key === "lockedByUser" && child === true)
    || (key === "confirmedByUser" && child === true) || (key === "source" && child === "user")
    || containsUserAssertion(child));
}
function requirementEntityProvenance(value, kind, source, confirmedByUser) {
  if (!object(value) || value.source !== source || value.confirmedByUser !== confirmedByUser) return false;
  if (kind === "workload") return Array.isArray(value.metrics)
    && value.metrics.every((metric) => requirementEntityProvenance(metric, "metric", source, confirmedByUser));
  return true;
}
function requirementSpecProvenance(value, source, confirmedByUser) {
  if (!object(value)) return false;
  return (value.budget === undefined || requirementEntityProvenance(value.budget, "draft", source, confirmedByUser))
    && (value.horizonYears === undefined || requirementEntityProvenance(value.horizonYears, "draft", source, confirmedByUser))
    && Array.isArray(value.workloads) && value.workloads.every((workload) => requirementEntityProvenance(workload, "workload", source, confirmedByUser))
    && Array.isArray(value.constraints) && value.constraints.every((constraint) => requirementEntityProvenance(constraint, "constraint", source, confirmedByUser));
}
function containsSource(value, source) {
  if (Array.isArray(value)) return value.some((child) => containsSource(child, source));
  if (!object(value)) return false;
  return Object.entries(value).some(([key, child]) => key === "source" && child === source || containsSource(child, source));
}
function actorRequirementProvenance(actor) {
  if (actor === "user") return { source: "user", confirmedByUser: true };
  if (actor === "agent" || actor === "solver") return { source: "agent_proposed", confirmedByUser: false };
  if (actor === "system") return { source: "defaulted", confirmedByUser: false };
  return null;
}
function validScenarioActorProvenance(operation, actor) {
  // `migration` belongs exclusively to the governed V2 -> V3 migration path;
  // no interactive what-if actor may mint it.
  if (containsSource(operation.value, "migration")) return false;
  const selector = operation.selector;
  if (operation.op === "add" && selector.collection === "components") {
    return actor === "user" ? operation.value?.source === "user"
      : actor === "agent" || actor === "solver" ? operation.value?.source === "agent" : false;
  }
  const requirementProvenance = actorRequirementProvenance(actor);
  if (selector.collection === "config" && selector.field === "intent") {
    return requirementProvenance !== null && requirementEntityProvenance(
      operation.value, "draft", requirementProvenance.source, requirementProvenance.confirmedByUser,
    );
  }
  if (selector.collection === "config" && selector.field === "requirementSpec") {
    return requirementProvenance !== null && requirementSpecProvenance(
      operation.value, requirementProvenance.source, requirementProvenance.confirmedByUser,
    );
  }
  if (selector.collection === "config" && ["requirementBudget", "requirementHorizonYears"].includes(selector.field)) {
    return requirementProvenance !== null && requirementEntityProvenance(
      operation.value, "draft", requirementProvenance.source, requirementProvenance.confirmedByUser,
    );
  }
  if (operation.op === "add" && selector.collection === "workloads") {
    return requirementProvenance !== null && requirementEntityProvenance(
      operation.value, "workload", requirementProvenance.source, requirementProvenance.confirmedByUser,
    );
  }
  if (operation.op === "add" && selector.collection === "metrics") {
    return requirementProvenance !== null && requirementEntityProvenance(
      operation.value, "metric", requirementProvenance.source, requirementProvenance.confirmedByUser,
    );
  }
  if (operation.op === "add" && selector.collection === "constraints") {
    return requirementProvenance !== null && requirementEntityProvenance(
      operation.value, "constraint", requirementProvenance.source, requirementProvenance.confirmedByUser,
    );
  }
  if (selector.collection === "config" && selector.field === "system") {
    if (operation.value === null) return actor === "user" || actor === "system";
    if (actor === "user") return operation.value?.source === "user" && operation.value?.lockedByUser === true;
    if (actor === "system") return operation.value?.source === "defaulted" && operation.value?.lockedByUser === false;
    return false;
  }
  if (selector.collection === "firmwareTargets") {
    if (actor !== "user" && actor !== "system") return false;
    if (operation.op !== "add") return true;
    return actor === "user" ? operation.value?.source === "user" : operation.value?.source === "system_requirement";
  }
  // A system branch is not a general topology author; source-free mutations
  // outside requirements and firmware remain user/Agent/solver territory.
  return actor !== "system";
}
function string(value) { return typeof value === "string" && value.length > 0; }
function strings(value, nonEmpty = false) {
  return Array.isArray(value) && (!nonEmpty || value.length > 0) && value.every(string) && new Set(value).size === value.length;
}
function endpoint(value) { return exact(value, ["instanceId", "portId"]) && string(value.instanceId) && string(value.portId); }
function identity(value) {
  if (value?.status === "unresolved") return object(value) && Object.keys(value).every((key) => ["status", "userText", "candidateIds"].includes(key))
    && string(value.userText) && (value.candidateIds === undefined || strings(value.candidateIds));
  return value?.status === "resolved" && exact(value, ["status", "skuId", "identityClaimIds"])
    && string(value.skuId) && strings(value.identityClaimIds, true);
}
function firmwareSettings(value) {
  return Array.isArray(value) && new Set(value.map((setting) => setting?.settingId)).size === value.length
    && value.every((setting) => exact(setting, ["settingId", "desiredValue"])
      && Object.prototype.hasOwnProperty.call(FIRMWARE_SETTINGS, setting.settingId)
      && FIRMWARE_SETTINGS[setting.settingId].includes(setting.desiredValue));
}
function draft(value, kind) {
  if (!object(value) || !["answered", "deferred", "not_applicable"].includes(value.state)
    || !["user", "defaulted", "agent_proposed"].includes(value.source) || typeof value.confirmedByUser !== "boolean") return false;
  if (value.state !== "answered") return exact(value, ["state", "source", "confirmedByUser"]);
  if (!exact(value, ["state", "value", "source", "confirmedByUser"])) return false;
  if (kind === "intent") return ["pc", "workstation", "nas"].includes(value.value);
  if (kind === "horizon") return typeof value.value === "number" && Number.isFinite(value.value) && value.value > 0;
  return exact(value.value, ["targetCny", "hardCapCny", "reserveCny"])
    && Object.values(value.value).every((amount) => typeof amount === "number" && Number.isFinite(amount) && amount >= 0)
    && value.value.targetCny <= value.value.hardCapCny;
}
function requirementSpec(value) {
  if (value === null) return true;
  return object(value) && Object.keys(value).every((key) => ["requirementSpecId", "schemaVersion", "budget", "workloads", "constraints", "horizonYears"].includes(key))
    && string(value.requirementSpecId) && value.schemaVersion === "1.0.0"
    && (value.budget === undefined || draft(value.budget, "budget"))
    && (value.horizonYears === undefined || draft(value.horizonYears, "horizon"))
    && Array.isArray(value.workloads) && new Set(value.workloads.map((workload) => workload?.workloadId)).size === value.workloads.length
    && value.workloads.every((workload) => validRequirementEntity("workloads", { id: workload?.workloadId }, workload))
    && Array.isArray(value.constraints) && new Set(value.constraints.map((constraint) => constraint?.constraintId)).size === value.constraints.length
    && value.constraints.every((constraint) => validRequirementEntity("constraints", { id: constraint?.constraintId }, constraint));
}
function validRequirementSpecRuntime(spec, overrides = {}) {
  const config = {
    schemaVersion: "3.0.0", id: "scenario-validation", name: "Scenario validation",
    updatedAt: "2000-01-01T00:00:00.000Z", intent: null, requirementSpec: spec, system: null,
    components: [], roleDecisions: [], placements: [], connections: [], logicalLayouts: [], firmwareTargets: [],
    ...overrides,
  };
  return validatePlanConfigRuntime(config, { topologyV3Enabled: true }).length === 0;
}
function validMetric(value, selectorId) {
  if (!object(value) || value.metricId !== selectorId || !METRIC_IDS.has(value.metricId)) return false;
  if (["deferred", "not_applicable"].includes(value.state)) return exact(value, ["metricId", "state", "source", "confirmedByUser"])
    && ["user", "migration", "agent_proposed"].includes(value.source) && typeof value.confirmedByUser === "boolean";
  return Object.keys(value).every((key) => ["metricId", "state", "operator", "value", "unitId", "priority", "source", "confirmedByUser", "benchmarkId", "benchmarkContext"].includes(key))
    && (value.state === undefined || value.state === "answered") && ["eq", "gte", "lte", "between", "includes"].includes(value.operator)
    && ["must", "important", "nice_to_have"].includes(value.priority)
    && (value.source === undefined || ["user", "migration", "agent_proposed"].includes(value.source))
    && (value.confirmedByUser === undefined || typeof value.confirmedByUser === "boolean");
}
function validRequirementEntity(collection, selector, value) {
  if (!object(value)) return false;
  if (collection === "metrics") return validMetric(value, selector.id);
  if (collection === "workloads") {
    if (value.workloadId !== selector.id || !string(value.workloadId)) return false;
    if (["deferred", "not_applicable"].includes(value.state)) return exact(value, ["workloadId", "metrics", "state", "source", "confirmedByUser"])
      && Array.isArray(value.metrics) && value.metrics.length === 0 && ["user", "defaulted", "agent_proposed"].includes(value.source) && typeof value.confirmedByUser === "boolean";
    return Object.keys(value).every((key) => ["workloadId", "state", "name", "metrics", "evidenceOrBenchmarkRefs", "source", "confirmedByUser"].includes(key))
      && string(value.name) && Array.isArray(value.metrics) && new Set(value.metrics.map((metric) => metric?.metricId)).size === value.metrics.length
      && value.metrics.every((metric) => validMetric(metric, metric?.metricId))
      && (value.evidenceOrBenchmarkRefs === undefined || strings(value.evidenceOrBenchmarkRefs));
  }
  if (collection === "constraints") {
    if (value.constraintId !== selector.id || !string(value.constraintId)) return false;
    if (["deferred", "not_applicable"].includes(value.state)) return exact(value, ["constraintId", "state", "source", "confirmedByUser"]);
    return Object.keys(value).every((key) => ["constraintId", "state", "predicate", "strength", "source", "confirmedByUser"].includes(key))
      && object(value.predicate) && Object.keys(value.predicate).every((key) => ["facetId", "operator", "value", "unitId"].includes(key))
      && FACET_IDS.has(value.predicate.facetId) && ["eq", "gte", "lte", "between", "includes"].includes(value.predicate.operator)
      && ["hard", "soft"].includes(value.strength) && ["user", "migration", "agent_proposed"].includes(value.source)
      && typeof value.confirmedByUser === "boolean";
  }
  return false;
}
function validAdded(collection, selector, value) {
  if (!object(value)) return false;
  const identities = { components: "instanceId", roleDecisions: "roleDecisionId", placements: "placementId", connections: "connectionId", logicalLayouts: "layoutId", vdevs: "vdevId", firmwareTargets: "instanceId", workloads: "workloadId", metrics: "metricId", constraints: "constraintId" };
  if (value[identities[collection]] !== selector.id) return false;
  if (collection === "components") return exact(value, ["instanceId", "kind", "role", "state", "identity", "source"])
    && COMPONENT_KINDS.has(value.kind) && string(value.role) && ["planned", "ordered"].includes(value.state)
    && ["user", "agent", "migration"].includes(value.source) && identity(value.identity);
  if (collection === "roleDecisions") return exact(value, ["roleDecisionId", "role", "decision", "source", "confirmedAt"])
    && string(value.role) && value.decision === "not_needed" && ["user", "migration"].includes(value.source) && string(value.confirmedAt);
  if (collection === "placements") return exact(value, ["placementId", "componentInstanceId", "mountOwnerInstanceId", "mountId"])
    && string(value.componentInstanceId) && string(value.mountOwnerInstanceId) && string(value.mountId);
  if (collection === "connections") return object(value) && Object.keys(value).every((key) => ["connectionId", "from", "to", "cableInstanceId", "status"].includes(key))
    && endpoint(value.from) && endpoint(value.to) && (value.cableInstanceId === undefined || string(value.cableInstanceId))
    && ["required", "planned", "satisfied", "blocked"].includes(value.status);
  if (collection === "vdevs") return exact(value, ["vdevId", "topology", "diskInstanceIds"])
    && ["mirror", "raidz1", "raidz2", "raidz3", "stripe"].includes(value.topology) && strings(value.diskInstanceIds, true);
  if (collection === "logicalLayouts") return exact(value, ["layoutId", "bootPoolDiskIds", "vdevs", "spareDiskIds"])
    && strings(value.bootPoolDiskIds) && strings(value.spareDiskIds) && Array.isArray(value.vdevs)
    && value.vdevs.every((vdev) => validAdded("vdevs", { id: vdev?.vdevId }, vdev));
  if (collection === "firmwareTargets") return exact(value, ["instanceId", "targetReleaseFactId", "requestedSettings", "source"])
    && string(value.targetReleaseFactId) && ["user", "system_requirement"].includes(value.source) && firmwareSettings(value.requestedSettings);
  // Requirement entities are still schema-bound and identity-bound here; the
  // TS authoring boundary performs the registry-specific metric/facet checks.
  if (collection === "workloads") return validRequirementSpecRuntime({ requirementSpecId: "scenario-requirements", schemaVersion: "1.0.0", workloads: [value], constraints: [] });
  if (collection === "metrics") return validRequirementSpecRuntime({
    requirementSpecId: "scenario-requirements", schemaVersion: "1.0.0",
    workloads: [{ workloadId: selector.parentId, name: "Scenario workload", metrics: [value], evidenceOrBenchmarkRefs: [] }], constraints: [],
  });
  if (collection === "constraints") return validRequirementSpecRuntime({ requirementSpecId: "scenario-requirements", schemaVersion: "1.0.0", workloads: [], constraints: [value] });
  return false;
}
function validReplacement(collection, field, value) {
  if (collection === "config") {
    if (field === "name") return string(value);
    if (field === "notes") return Array.isArray(value) && value.every((note) => typeof note === "string");
    if (field === "intent") return validRequirementSpecRuntime(null, { intent: value });
    if (field === "requirementSpec") return validRequirementSpecRuntime(value);
    if (field === "requirementBudget") return validRequirementSpecRuntime({
      requirementSpecId: "scenario-requirements", schemaVersion: "1.0.0", budget: value, workloads: [], constraints: [],
    });
    if (field === "requirementHorizonYears") return validRequirementSpecRuntime({
      requirementSpecId: "scenario-requirements", schemaVersion: "1.0.0", horizonYears: value, workloads: [], constraints: [],
    });
    if (field === "system") return validRequirementSpecRuntime(null, { system: value });
  }
  if (collection === "components") return field === "identity" ? identity(value) : field === "state" ? ["planned", "ordered"].includes(value) : string(value);
  if (collection === "placements") return string(value);
  if (collection === "connections") return ["from", "to"].includes(field) ? endpoint(value) : field === "cableInstanceId" ? value === null || string(value) : ["required", "planned", "satisfied", "blocked"].includes(value);
  if (collection === "logicalLayouts") return strings(value);
  if (collection === "vdevs") return field === "topology" ? ["mirror", "raidz1", "raidz2", "raidz3", "stripe"].includes(value) : strings(value, true);
  if (collection === "firmwareTargets") return field === "targetReleaseFactId" ? string(value) : firmwareSettings(value);
  if (collection === "workloads") return field === "name" ? string(value) : strings(value);
  return false;
}
function validTopologyPatch(operation, actor) {
  if (!object(operation) || !["add", "replace", "remove"].includes(operation.op)) return false;
  if (!exact(operation, operation.op === "remove" ? ["op", "selector"] : ["op", "selector", "value"])) return false;
  const selector = operation.selector;
  if (!object(selector) || !Object.keys(selector).every((key) => ["collection", "id", "parentId", "field"].includes(key)) || !COLLECTIONS[selector.collection]) return false;
  const rule = COLLECTIONS[selector.collection];
  if (selector.collection === "config") {
    if (operation.op !== "replace" || selector.id !== undefined || selector.parentId !== undefined || !rule.fields.includes(selector.field)) return false;
  } else if (!string(selector.id) || (rule.parent ? !string(selector.parentId) : selector.parentId !== undefined)
    || (operation.op === "replace" ? !rule.fields.includes(selector.field) : selector.field !== undefined)) return false;
  if (actor !== "user" && (selector.collection === "roleDecisions" || containsUserAssertion(operation.value))) return false;
  if (!validScenarioActorProvenance(operation, actor)) return false;
  return operation.op === "remove" || operation.op === "add" && validAdded(selector.collection, selector, operation.value)
    || operation.op === "replace" && validReplacement(selector.collection, selector.field, operation.value);
}
function validSimulationPatch(operation) {
  if (!object(operation) || !["add", "replace", "remove"].includes(operation.op)
    || !exact(operation, operation.op === "remove" ? ["op", "path"] : ["op", "path", "value"])) return false;
  const path = operation.path;
  if (typeof path !== "string" || !/^\/(?:workloadMetricRefs|placementIds|routeIds)(?:\/(?:0|[1-9]\d*|-))?$|^\/ambientC(?:\/(?:min|max))?$|^\/fanPolicyId$|^\/modelVersion$|^\/storageActivity(?:\/(?:0|[1-9]\d*|-)(?:\/(?:logicalLayoutId|dutyCycle|concurrentDiskCount))?)?$/.test(path)) return false;
  if (operation.op === "add" && !/\/(?:0|[1-9]\d*|-)$/.test(path)) return false;
  if (operation.op === "remove" && (!/\/(?:0|[1-9]\d*)$/.test(path) || path.endsWith("/-"))) return false;
  if (operation.op === "remove") return true;
  if (path === "/ambientC") return exact(operation.value, ["min", "max"])
    && typeof operation.value.min === "number" && Number.isFinite(operation.value.min)
    && typeof operation.value.max === "number" && Number.isFinite(operation.value.max) && operation.value.min <= operation.value.max;
  const storageActivity = (value) => exact(value, ["logicalLayoutId", "dutyCycle", "concurrentDiskCount"])
    && string(value.logicalLayoutId) && typeof value.dutyCycle === "number" && Number.isFinite(value.dutyCycle)
    && value.dutyCycle >= 0 && value.dutyCycle <= 1 && Number.isInteger(value.concurrentDiskCount) && value.concurrentDiskCount >= 0
    && (value.dutyCycle === 0 || value.concurrentDiskCount > 0);
  if (path === "/storageActivity") return Array.isArray(operation.value) && operation.value.every(storageActivity);
  if (/^\/storageActivity\/(?:0|[1-9]\d*|-)$/.test(path)) return storageActivity(operation.value);
  if (/\/dutyCycle$/.test(path)) return typeof operation.value === "number" && Number.isFinite(operation.value) && operation.value >= 0 && operation.value <= 1;
  if (/\/(?:min|max)$/.test(path)) return typeof operation.value === "number" && Number.isFinite(operation.value);
  if (/\/concurrentDiskCount$/.test(path)) return Number.isInteger(operation.value) && operation.value >= 0;
  if (/\/(?:logicalLayoutId)$/.test(path) || path === "/fanPolicyId" || path === "/modelVersion" || /\/(?:0|[1-9]\d*|-)$/.test(path) && !path.startsWith("/storageActivity")) return string(operation.value);
  return operation.value !== undefined;
}

export function validateScenarioPatchAuthority(patch, simulationInputPatch, actor) {
  const errors = [];
  if (!Array.isArray(patch)) errors.push("patch must be an array");
  else patch.map(normalizeScenarioAuthorityValue).forEach((operation, index) => { if (!validTopologyPatch(operation, actor)) errors.push(`patch.${index}: runtime governed patch invalid`); });
  if (simulationInputPatch !== undefined) {
    if (!Array.isArray(simulationInputPatch)) errors.push("simulationInputPatch must be an array");
    else simulationInputPatch.map(normalizeScenarioAuthorityValue).forEach((operation, index) => { if (!validSimulationPatch(operation)) errors.push(`simulationInputPatch.${index}: runtime governed patch invalid`); });
  }
  return errors;
}

export function isScenarioArtifactReference(value) { return REF.test(String(value ?? "")); }

/** Pure canonical materializer shared by TS authoring and production replay.
 * Callers must first run validateScenarioPatchAuthority and validate the base. */
export function applyScenarioTopologyPatchRuntime(base, operations) {
  const result = normalizeScenarioAuthorityValue(base);
  const normalizedOperations = normalizeScenarioAuthorityValue(operations);
  const collection = (selector) => {
    if (selector.collection === "vdevs") {
      const layout = result.logicalLayouts.find((item) => item.layoutId === selector.parentId);
      if (!layout) throw new Error("scenario patch parent layout is missing");
      return [layout.vdevs, "vdevId"];
    }
    if (["workloads", "metrics", "constraints"].includes(selector.collection)) {
      if (!result.requirementSpec) throw new Error("scenario patch requirementSpec is missing");
      if (selector.collection === "workloads") return [result.requirementSpec.workloads, "workloadId"];
      if (selector.collection === "constraints") return [result.requirementSpec.constraints, "constraintId"];
      const workload = result.requirementSpec.workloads.find((item) => item.workloadId === selector.parentId);
      if (!workload) throw new Error("scenario patch parent workload is missing");
      return [workload.metrics, "metricId"];
    }
    const rule = COLLECTIONS[selector.collection];
    if (!rule || selector.collection === "config") throw new Error("scenario patch collection is invalid");
    return [result[selector.collection], ({ components: "instanceId", roleDecisions: "roleDecisionId", placements: "placementId", connections: "connectionId", logicalLayouts: "layoutId", firmwareTargets: "instanceId" })[selector.collection]];
  };
  for (const operation of normalizedOperations) {
    const selector = operation.selector;
    if (selector.collection === "config") {
      if (selector.field === "requirementBudget" || selector.field === "requirementHorizonYears") {
        if (!result.requirementSpec) throw new Error("scenario patch requirementSpec is missing");
        const field = selector.field === "requirementBudget" ? "budget" : "horizonYears";
        result.requirementSpec[field] = structuredClone(operation.value);
      } else result[selector.field] = structuredClone(operation.value);
      continue;
    }
    const [values, idField] = collection(selector);
    const index = values.findIndex((value) => value[idField] === selector.id);
    if (operation.op === "add") {
      if (index !== -1) throw new Error("scenario patch target already exists");
      values.push(structuredClone(operation.value)); continue;
    }
    if (index === -1) throw new Error("scenario patch target is missing");
    if (operation.op === "remove") { values.splice(index, 1); continue; }
    if (selector.collection === "connections" && selector.field === "cableInstanceId" && operation.value === null) delete values[index][selector.field];
    else values[index][selector.field] = structuredClone(operation.value);
  }
  return normalizeScenarioAuthorityValue(result);
}

function family(record, id, context) {
  const value = envelopePayload(record, "family");
  invariant(exact(value, ["schemaVersion", "familyId", "planId", "name", "basePlanVersionId", "baseConfigHash", "baseSnapshotHashes", "createdAt", "updatedAt"])
    && value.schemaVersion === SCHEMA_VERSION && value.familyId === id && ID.test(value.familyId)
    && typeof value.planId === "string" && value.planId && typeof value.name === "string" && value.name
    && typeof value.basePlanVersionId === "string" && value.basePlanVersionId
    && SHA256.test(String(value.baseConfigHash ?? "")) && validSnapshots(value.baseSnapshotHashes)
    && value.baseConfigHash === value.baseSnapshotHashes.configHash && iso(value.createdAt) && iso(value.updatedAt)
    && value.updatedAt >= value.createdAt, "scenario family payload/identity/schema is invalid");
  const ref = `scenario-family:${id}`;
  context.nodes.push(ref); context.pointers.push(ref);
  context.edges.push({ fromRef: ref, toRef: `plan:${value.planId}`, necessity: "required_for_replay" });
  context.edges.push({ fromRef: ref, toRef: `plan-version:${value.basePlanVersionId}`, necessity: "required_for_replay" });
  return value;
}

function branch(record, id, context) {
  const value = envelopePayload(record, "branch");
  const allowed = ["schemaVersion", "createdByActor", "createdAt", "patchHash", "materializedConfigHash", "scenarioId", "familyId", "basePlanVersionId", "baseConfigHash", "baseSnapshotHashes", "patch", "simulationInputPatch"];
  invariant(object(value) && Object.keys(value).every((key) => allowed.includes(key))
    && value.schemaVersion === SCHEMA_VERSION && value.scenarioId === id && ID.test(value.scenarioId) && ID.test(String(value.familyId ?? ""))
    && typeof value.basePlanVersionId === "string" && value.basePlanVersionId
    && SHA256.test(String(value.baseConfigHash ?? "")) && validSnapshots(value.baseSnapshotHashes)
    && value.baseConfigHash === value.baseSnapshotHashes.configHash
    && ["user", "agent", "solver", "system"].includes(value.createdByActor) && iso(value.createdAt)
    && SHA256.test(String(value.patchHash ?? "")) && value.patchHash === sha256Json(normalizeScenarioAuthorityValue({ patch: value.patch, simulationInputPatch: value.simulationInputPatch ?? [] }))
    && SHA256.test(String(value.materializedConfigHash ?? ""))
    && Array.isArray(value.patch) && (value.patch.length > 0 || (Array.isArray(value.simulationInputPatch) && value.simulationInputPatch.length > 0))
    && validateScenarioPatchAuthority(value.patch, value.simulationInputPatch, value.createdByActor).length === 0,
  "scenario branch payload/identity/schema/actor binding is invalid");
  const ref = `scenario-branch:${id}`;
  context.nodes.push(ref); context.pointers.push(ref);
  context.edges.push({ fromRef: ref, toRef: `scenario-family:${value.familyId}`, necessity: "required_for_replay" });
  context.edges.push({ fromRef: ref, toRef: `plan-version:${value.basePlanVersionId}`, necessity: "required_for_replay" });
  return value;
}

function authoritativeResult(record, id) {
  const value = envelopePayload(record, "result");
  invariant(exact(value, ["schemaVersion", "result", "authority"])
    && value.schemaVersion === "scenario-authoritative-result-v1"
    && exact(value.authority, ["artifactRef", "artifact"]) && REF.test(String(value.authority.artifactRef ?? ""))
    && validateSolverWhatIfArtifactRuntime(value.authority.artifact).length === 0
    && exact(value.result, [
      "schemaVersion", "createdAt", "scenarioId", "beforeConfigHash", "afterConfigHash", "patchHash",
      "beforeEvaluationHash", "afterEvaluationHash", "decisionDiffRef", "domainDiffRefs", "snapshotAttribution",
    ]) && value.result.schemaVersion === SCHEMA_VERSION && value.result.scenarioId === id
    && ID.test(value.result.scenarioId) && iso(value.result.createdAt)
    && [value.result.beforeConfigHash, value.result.afterConfigHash, value.result.patchHash,
      value.result.beforeEvaluationHash, value.result.afterEvaluationHash].every((hash) => SHA256.test(String(hash ?? "")))
    && REF.test(String(value.result.decisionDiffRef ?? ""))
    && Array.isArray(value.result.domainDiffRefs) && value.result.domainDiffRefs.every((ref) => REF.test(String(ref)))
    && ["same_snapshots", "refreshed"].includes(value.result.snapshotAttribution),
  "persisted scenario result authority is unavailable or invalid");
  return value;
}

/** Strict production authority scanner. It does not mutate or initialize. */
export async function validateScenarioRuntimeRecords(records, context, activeRoot, catalog) {
  const families = new Map(); const branches = new Map(); const results = new Map(); const snapshots = new Map();
  for (const record of records) {
    const snapshotMatch = /^snapshots\/(snapshot-set-[a-f0-9]{64})\.json$/.exec(record.rootLogicalPath);
    if (snapshotMatch) {
      invariant(validateScenarioSnapshotSetManifest(record.value, snapshotMatch[1]).length === 0,
        "scenario snapshot-set manifest identity/content hash is invalid");
      invariant(!snapshots.has(snapshotMatch[1]), "scenario snapshot-set manifest ID is duplicated");
      snapshots.set(snapshotMatch[1], record.value);
      context.nodes.push(`scenario-snapshot-set:${snapshotMatch[1]}`);
      continue;
    }
    const evaluationMatch = /^evaluations\/(evaluation-[a-f0-9]{64})\.json$/.exec(record.rootLogicalPath);
    if (evaluationMatch) {
      throw new Error("persisted scenario evaluation authority is unavailable until the governed replay verifier is installed");
    }
    const evaluationSnapshotMatch = /^evaluation-snapshots\/(evaluation-snapshot-[a-f0-9]{64})\.json$/.exec(record.rootLogicalPath);
    if (evaluationSnapshotMatch) {
      throw new Error("persisted scenario evaluation authority is unavailable until the governed replay verifier is installed");
    }
    const match = /^(families|branches|results)\/([a-z0-9][a-z0-9-]{2,79})\.json$/.exec(record.rootLogicalPath);
    invariant(match && record.rootLogicalPath.endsWith(".json"), "scenarios repository contains an unrecognized authority path");
    if (match[1] === "families") families.set(match[2], family(record, match[2], context));
    else if (match[1] === "branches") branches.set(match[2], branch(record, match[2], context));
    else results.set(match[2], authoritativeResult(record, match[2]));
  }
  for (const familyValue of families.values()) {
    const expected = createScenarioSnapshotSetManifest(familyValue.baseSnapshotHashes);
    const manifest = snapshots.get(expected.snapshotSetId);
    invariant(manifest && manifest.contentHash === expected.contentHash
      && sha256Json(manifest.snapshotHashes) === sha256Json(familyValue.baseSnapshotHashes),
    "scenario family snapshot-set manifest is missing or hash-mismatched");
    context.edges.push({
      fromRef: `scenario-family:${familyValue.familyId}`,
      toRef: `scenario-snapshot-set:${expected.snapshotSetId}`,
      necessity: "required_for_replay",
    });
  }
  for (const branchValue of branches.values()) {
    const familyValue = families.get(branchValue.familyId);
    invariant(familyValue && branchValue.basePlanVersionId === familyValue.basePlanVersionId
      && branchValue.baseConfigHash === familyValue.baseConfigHash
      && sha256Json(branchValue.baseSnapshotHashes) === sha256Json(familyValue.baseSnapshotHashes),
    "scenario branch base does not match its family");
  }
  if (activeRoot) for (const familyValue of families.values()) {
    const file = confined(activeRoot, "plans", familyValue.planId, "versions", `${familyValue.basePlanVersionId}.json`);
    const planEnvelope = await readFile(file, "utf8").then((text) => JSON.parse(text)).catch(() => null);
    invariant(planEnvelope && exact(planEnvelope, ["schemaVersion", "kind", "checksum", "payload"])
      && planEnvelope.schemaVersion === "1.0.0" && planEnvelope.kind === "version"
      && planEnvelope.checksum === sha256Json(planEnvelope.payload)
      && planEnvelope.payload?.id === familyValue.basePlanVersionId && planEnvelope.payload.planId === familyValue.planId
      && planEnvelope.payload.configHash === familyValue.baseConfigHash,
    "scenario family base plan version is missing, stale, or hash-mismatched");
  }
  if (activeRoot) for (const branchValue of branches.values()) {
    const familyValue = families.get(branchValue.familyId);
    const file = confined(activeRoot, "plans", familyValue.planId, "versions", `${familyValue.basePlanVersionId}.json`);
    const planEnvelope = JSON.parse(await readFile(file, "utf8"));
    const materialized = applyScenarioTopologyPatchRuntime(planEnvelope.payload.config, branchValue.patch);
    invariant(validatePlanConfigRuntime(materialized, { topologyV3Enabled: true }).length === 0,
      "scenario branch materialized config is semantically invalid");
    invariant(catalog && validateResolvedV3CatalogBindingsRuntime(materialized, catalog).length === 0,
      "scenario branch materialized resolved identity is not proven by the active merged catalog");
    invariant(hashPlanConfigRuntime(materialized) === branchValue.materializedConfigHash,
      "scenario branch materialized config hash is forged or stale");
  }
  invariant(results.size === 0 || activeRoot, "scenario result requires its active-root solver artifact authority");
  if (activeRoot) {
    const artifactRoot = confined(activeRoot, "artifacts");
    const artifacts = new FileArtifactRepository({ root: artifactRoot });
    for (const [scenarioId, record] of results) {
      const familyValue = families.get(record.authority.artifact.familyId);
      const branchValue = branches.get(scenarioId);
      invariant(familyValue && branchValue && branchValue.familyId === familyValue.familyId,
        "scenario result family/branch authority is missing");
      const artifact = record.authority.artifact;
      const result = record.result;
      invariant(artifact.scenarioId === scenarioId && artifact.familyId === familyValue.familyId
        && artifact.basePlanVersionId === familyValue.basePlanVersionId
        && artifact.baseConfigHash === familyValue.baseConfigHash
        && artifact.afterConfigHash === branchValue.materializedConfigHash
        && sha256Json(artifact.baseSnapshotHashes) === sha256Json(familyValue.baseSnapshotHashes)
        && result.createdAt === artifact.createdAt && result.beforeConfigHash === artifact.baseConfigHash
        && result.afterConfigHash === artifact.afterConfigHash && result.patchHash === branchValue.patchHash
        && result.beforeEvaluationHash === artifact.beforeEvaluationHash
        && result.afterEvaluationHash === artifact.afterEvaluationHash
        && result.decisionDiffRef === artifact.decisionDiffRef
        && sha256Json(result.domainDiffRefs) === sha256Json(artifact.domainDiffRefs)
        && result.snapshotAttribution === artifact.snapshotAttribution,
      "scenario result does not bind its exact family/branch/materialization");
      const stored = await artifacts.getAt(artifactRoot, record.authority.artifactRef, { initialize: false });
      invariant(stored && stored.record.kind === "solver-what-if-result"
        && stored.record.mediaType === "application/vnd.buildsim.solver+json"
        && sha256Json(JSON.parse(Buffer.from(stored.bytes).toString("utf8"))) === sha256Json(artifact),
      "scenario result solver artifact authority is missing or mismatched");
      const ref = `scenario-result:${scenarioId}`;
      context.nodes.push(ref); context.pointers.push(ref);
      context.edges.push({ fromRef: ref, toRef: `scenario-branch:${scenarioId}`, necessity: "required_for_replay" });
      context.edges.push({ fromRef: ref, toRef: record.authority.artifactRef, necessity: "required_for_replay" });
    }
  }
}
