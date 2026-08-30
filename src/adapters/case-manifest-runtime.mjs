import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";

const HASH = /^[a-f0-9]{64}$/;
const MOUNT_KINDS = new Set(["motherboard", "psu", "drive", "fan", "radiator", "pcie", "backplane", "accessory"]);
const ROUTING_KINDS = new Set(["free", "channel", "opening"]);
const BUNDLE_KINDS = new Set(["cable", "fastener", "standoff", "bracket", "adapter", "tool", "consumable"]);
const NEED_KINDS = new Set(["accessory", ...BUNDLE_KINDS]);
const FACETS = new Set([
  "identity.category", "identity.manufacturer", "identity.model", "identity.revision",
  "physical.width", "physical.height", "physical.depth", "mount.standard", "mount.point_ids",
  "cpu.socket", "motherboard.cpu_socket", "motherboard.chipset", "motherboard.memory_type",
  "motherboard.memory_slot_count", "motherboard.memory_population_rules", "motherboard.form_factor",
  "motherboard.bios_version", "motherboard.bios_upgrade_methods", "motherboard.display_outputs",
  "motherboard.supported_operating_systems", "memory.type", "memory.capacity", "io.port_types",
  "io.header_types", "io.endpoint_ids", "case.motherboard_form_factors", "case.side_panel",
  "case.gpu_max_length", "case.cpu_cooler_max_height", "gpu.length", "gpu.slot_width",
  "gpu.power_connectors", "psu.capacity", "psu.connectors", "power.source_type", "power.load",
  "power.cable_families", "pcie.lane_count", "pcie.slot_types", "pcie.lane_sharing",
  "storage.interface", "storage.boot_support", "storage.capacity_bytes", "storage.recording_technology", "hba.mode",
  "cooling.fan_mounts", "cooling.radiator_support", "cooling.pump_header", "firmware.version",
  "firmware.upgrade_path_refs", "driver.supported_operating_systems", "driver.package_versions",
  "thermal.curve_refs", "acoustic.curve_refs", "package.contents", "resource.kind", "cable.connector_standard",
  "fastener.thread", "fastener.length_mm", "fastener.head", "tool.drive", "consumable.type", "accessory.standard", "acoustic.noise_class",
]);
const RESOURCE_FACETS = Object.freeze({
  "resource.kind": { type: "string", operators: ["eq"] },
  "cable.connector_standard": { type: "string_set", operators: ["includes"] },
  "fastener.thread": { type: "string", operators: ["eq"] },
  "fastener.length_mm": { type: "number", operators: ["eq", "gte", "lte", "between"] },
  "fastener.head": { type: "string", operators: ["eq"] },
  "tool.drive": { type: "string", operators: ["eq"] },
  "consumable.type": { type: "string", operators: ["eq"] },
  "mount.standard": { type: "string", operators: ["eq"] },
  "accessory.standard": { type: "string", operators: ["eq"] },
});

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, required, optional = []) {
  if (!object(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function nfc(value, empty = false) {
  return typeof value === "string" && (empty || value.length > 0) && value === value.normalize("NFC")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function portable(value) { return nfc(value) && value.length <= 256 && !/\s/u.test(value); }
function ids(value, empty = false) { return Array.isArray(value) && (empty || value.length > 0) && value.every(portable) && new Set(value).size === value.length; }
function vec(value, positive = false) { return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item) && (!positive || item > 0)); }
function positiveInt(value, maximum) { return Number.isSafeInteger(value) && value > 0 && value <= maximum; }
function canonical(value, atRoot = true, ancestors = new Set()) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite manifest number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (!object(value) && !Array.isArray(value) || ancestors.has(value)) throw new TypeError("non-canonical manifest value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).some((key, index) => key !== String(index))) throw new TypeError("sparse manifest array");
      return `[${value.map((item) => canonical(item, false, ancestors)).join(",")}]`;
    }
    return `{${Object.entries(value)
      .filter(([key]) => !(atRoot && key === "contentHash"))
      .map(([key, child]) => [key.normalize("NFC"), child])
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child, false, ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}
function contentHash(value) {
  const preimage = ["buildsim", "hash-spec-v1", "artifact.adapter-snapshot", "1.0.0", canonical(value)].join("\0");
  const digest = sha256Utf8Runtime(preimage);
  if (digest === null) throw new TypeError("manifest hash preimage invalid");
  return digest;
}
function binding(value) {
  return exact(value, ["status", "sourceFactIds", "derivationIds", "uncertaintyMm"])
    && ids(value.sourceFactIds) && ids(value.derivationIds, true)
    && typeof value.uncertaintyMm === "number" && Number.isFinite(value.uncertaintyMm) && value.uncertaintyMm >= 0
    && (value.status === "verified" ? value.uncertaintyMm === 0 && value.derivationIds.length === 0
      : value.status === "provisional" && value.uncertaintyMm > 0 && value.derivationIds.length > 0);
}
function spatial(value, idKey = "nodeId") {
  return exact(value, [idKey, "centerMm", "sizeMm", "binding"])
    && portable(value[idKey]) && vec(value.centerMm) && vec(value.sizeMm, true) && binding(value.binding);
}
function inside(value, envelope) {
  if (!vec(value?.centerMm) || !vec(value?.sizeMm, true) || !vec(envelope?.centerMm) || !vec(envelope?.sizeMm, true)) return false;
  return [0, 1, 2].every((axis) => Math.abs(value.centerMm[axis] - envelope.centerMm[axis]) + value.sizeMm[axis] / 2 <= envelope.sizeMm[axis] / 2 + 1e-9);
}
function pointInside(point, envelope) {
  return vec(point) && vec(envelope?.centerMm) && vec(envelope?.sizeMm, true)
    && [0, 1, 2].every((axis) => Math.abs(point[axis] - envelope.centerMm[axis]) <= envelope.sizeMm[axis] / 2 + 1e-9);
}
function uniqueBy(values, key) { return Array.isArray(values) && new Set(values.map((value) => value?.[key])).size === values.length; }
function resourceFacet(value) {
  const contract = object(value) ? RESOURCE_FACETS[value.facetId] : null;
  if (!contract || !exact(value, ["facetId", "value"])) return false;
  if (contract.type === "number") return typeof value.value === "number" && Number.isFinite(value.value) && value.value >= 0;
  if (contract.type === "string_set") return ids(value.value);
  return portable(value.value);
}
function resourcePredicate(value) {
  const contract = object(value) ? RESOURCE_FACETS[value.facetId] : null;
  if (!contract || !exact(value, ["facetId", "operator", "value"]) || !contract.operators.includes(value.operator)) return false;
  if (value.operator === "between") return Array.isArray(value.value) && value.value.length === 2
    && value.value.every((item) => typeof item === "number" && Number.isFinite(item)) && value.value[0] <= value.value[1];
  return contract.type === "number" ? typeof value.value === "number" && Number.isFinite(value.value) : portable(value.value);
}
function bundle(value) {
  if (!exact(value, ["schemaVersion", "bundleItemId", "ownerSkuId", "kind", "specification", "quantity", "variantScopeFactIds", "evidenceFactIds", "contentHash"], ["region", "revision"])) return false;
  return value.schemaVersion === "bundle-item-v1" && portable(value.bundleItemId) && portable(value.ownerSkuId)
    && BUNDLE_KINDS.has(value.kind) && Array.isArray(value.specification) && value.specification.length > 0
    && value.specification.every(resourceFacet) && uniqueBy(value.specification, "facetId")
    && value.specification.some((facet) => facet.facetId === "resource.kind" && facet.value === value.kind)
    && positiveInt(value.quantity, 65_536) && (value.region === undefined || portable(value.region))
    && (value.revision === undefined || portable(value.revision)) && ids(value.variantScopeFactIds) && ids(value.evidenceFactIds)
    && HASH.test(String(value.contentHash ?? "")) && contentHash(value) === value.contentHash;
}
function need(value) {
  return exact(value, ["needTemplateId", "kind", "specification", "quantity", "criticality", "requiredBefore"])
    && portable(value.needTemplateId) && NEED_KINDS.has(value.kind) && Array.isArray(value.specification)
    && value.specification.length > 0 && value.specification.every(resourcePredicate) && uniqueBy(value.specification, "facetId")
    && positiveInt(value.quantity, 65_536) && ["normal", "boot", "safety"].includes(value.criticality)
    && ["assembly", "pre_power", "first_boot", "os_install"].includes(value.requiredBefore);
}
function pattern(value) {
  return exact(value, ["schemaVersion", "patternId", "mountStandardIds", "needs", "evidenceFactIds", "contentHash"])
    && value.schemaVersion === "assembly-resource-pattern-v1" && portable(value.patternId) && ids(value.mountStandardIds)
    && Array.isArray(value.needs) && value.needs.length > 0 && value.needs.every(need) && uniqueBy(value.needs, "needTemplateId")
    && ids(value.evidenceFactIds) && HASH.test(String(value.contentHash ?? "")) && contentHash(value) === value.contentHash;
}
function cycle(constraints) {
  const adjacency = new Map();
  for (const item of constraints) adjacency.set(item.beforeActionId, [...(adjacency.get(item.beforeActionId) ?? []), item.afterActionId]);
  const visiting = new Set(); const visited = new Set();
  const visit = (node) => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    if ((adjacency.get(node) ?? []).some(visit)) return true;
    visiting.delete(node); visited.add(node); return false;
  };
  return [...adjacency.keys()].some(visit);
}

export function caseAdapterManifestContentHashRuntime(value) {
  try { return object(value) ? contentHash(value) : null; } catch { return null; }
}

/** Total JS-safe validation used by graph/Doctor/restore without TS trust. */
export function validateCaseAdapterManifestRuntime(value) {
  try {
    const keys = ["schemaVersion", "adapterId", "adapterVersion", "identity", "capabilityBindings", "geometry", "mounts", "ports", "routingZones", "assemblyConstraints", "bundleItems", "resourcePatterns", "sourceRefs", "contentHash"];
    if (!exact(value, keys)) return ["case adapter manifest fields invalid"];
    const errors = [];
    if (value.schemaVersion !== "case-adapter-manifest-v1" || !portable(value.adapterId) || !portable(value.adapterVersion)) errors.push("manifest identity invalid");
    if (!exact(value.identity, ["skuId", "region", "revision", "identityFactIds"]) || !portable(value.identity.skuId)
      || !portable(value.identity.region) || !portable(value.identity.revision) || !ids(value.identity.identityFactIds)) errors.push("manifest exact identity invalid");
    if (!Array.isArray(value.capabilityBindings) || !value.capabilityBindings.length
      || value.capabilityBindings.some((item) => !exact(item, ["facetId", "sourceFactIds"]) || !FACETS.has(item.facetId) || !ids(item.sourceFactIds))
      || !uniqueBy(value.capabilityBindings, "facetId")) errors.push("manifest capability bindings invalid");
    const geometry = value.geometry;
    if (!exact(geometry, ["envelope", "interiorSpaces", "forbiddenZones", "serviceCorridors"]) || !spatial(geometry?.envelope)
      || !Array.isArray(geometry?.interiorSpaces) || !geometry.interiorSpaces.length || !geometry.interiorSpaces.every((item) => spatial(item))
      || !Array.isArray(geometry?.forbiddenZones) || !geometry.forbiddenZones.every((item) => spatial(item))
      || !Array.isArray(geometry?.serviceCorridors) || !geometry.serviceCorridors.every((item) => spatial(item))
      || !uniqueBy([geometry?.envelope, ...(geometry?.interiorSpaces ?? []), ...(geometry?.forbiddenZones ?? []), ...(geometry?.serviceCorridors ?? [])], "nodeId")
      || [...(geometry?.interiorSpaces ?? []), ...(geometry?.forbiddenZones ?? []), ...(geometry?.serviceCorridors ?? [])].some((item) => !inside(item, geometry.envelope))) errors.push("manifest geometry closure invalid");
    if (!Array.isArray(value.mounts) || !value.mounts.length || !uniqueBy(value.mounts, "mountId") || value.mounts.some((item) => !exact(item, ["mountId", "kind", "standardIds", "quantity", "location", "binding"])
      || !portable(item.mountId) || !MOUNT_KINDS.has(item.kind) || !ids(item.standardIds) || !positiveInt(item.quantity, 4096) || !portable(item.location) || !binding(item.binding))) errors.push("manifest mounts invalid");
    if (!Array.isArray(value.ports) || !value.ports.length || !uniqueBy(value.ports, "portId") || value.ports.some((item) => !exact(item, ["portId", "connectorStandardId", "direction", "quantity", "anchorMm", "binding"])
      || !portable(item.portId) || !portable(item.connectorStandardId) || !["input", "output", "bidirectional"].includes(item.direction) || !positiveInt(item.quantity, 4096)
      || !vec(item.anchorMm) || !binding(item.binding) || !pointInside(item.anchorMm, geometry?.envelope))) errors.push("manifest ports invalid");
    const zoneIds = new Set(Array.isArray(value.routingZones) ? value.routingZones.map((item) => item?.zoneId) : []);
    if (!Array.isArray(value.routingZones) || !uniqueBy(value.routingZones, "zoneId") || value.routingZones.some((item) => !exact(item, ["zoneId", "kind", "centerMm", "sizeMm", "connectsToZoneIds", "binding"])
      || !portable(item.zoneId) || !ROUTING_KINDS.has(item.kind) || !vec(item.centerMm) || !vec(item.sizeMm, true) || !ids(item.connectsToZoneIds, true)
      || item.connectsToZoneIds.some((id) => id === item.zoneId || !zoneIds.has(id)) || !binding(item.binding) || !inside(item, geometry?.envelope))) errors.push("manifest routing closure invalid");
    if (!Array.isArray(value.assemblyConstraints) || !uniqueBy(value.assemblyConstraints, "constraintId") || value.assemblyConstraints.some((item) => !exact(item, ["constraintId", "beforeActionId", "afterActionId", "binding"])
      || !portable(item.constraintId) || !portable(item.beforeActionId) || !portable(item.afterActionId) || item.beforeActionId === item.afterActionId || !binding(item.binding))
      || cycle(value.assemblyConstraints ?? [])) errors.push("manifest assembly closure invalid");
    if (!Array.isArray(value.bundleItems) || value.bundleItems.some((item) => !bundle(item)
      || item.ownerSkuId !== value.identity?.skuId || item.region !== value.identity?.region || item.revision !== value.identity?.revision)
      || !uniqueBy(value.bundleItems, "bundleItemId")) errors.push("manifest bundle items invalid");
    if (!Array.isArray(value.resourcePatterns) || value.resourcePatterns.some((item) => !pattern(item)) || !uniqueBy(value.resourcePatterns, "patternId")) errors.push("manifest resource patterns invalid");
    if (!ids(value.sourceRefs) || !HASH.test(String(value.contentHash ?? "")) || contentHash(value) !== value.contentHash) errors.push("manifest source/content hash invalid");
    return [...new Set(errors)];
  } catch { return ["case adapter manifest runtime validation failed closed"]; }
}

export function verifyCaseAdapterManifestRuntime(value) {
  return validateCaseAdapterManifestRuntime(value).length === 0;
}
