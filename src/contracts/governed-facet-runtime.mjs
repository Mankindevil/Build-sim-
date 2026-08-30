const DEFINITIONS = Object.freeze({
  "identity.category": ["string", [], ["eq"]],
  "identity.manufacturer": ["string", [], ["eq"]],
  "identity.model": ["string", [], ["eq"]],
  "identity.revision": ["string", [], ["eq"]],
  "physical.width": ["number", ["mm"], ["lte", "gte", "between"]],
  "physical.height": ["number", ["mm"], ["lte", "gte", "between"]],
  "physical.depth": ["number", ["mm"], ["lte", "gte", "between"]],
  "mount.standard": ["string", [], ["eq"]],
  "mount.point_ids": ["string_set", [], ["includes"]],
  "cpu.socket": ["string", [], ["eq"]],
  "motherboard.cpu_socket": ["string", [], ["eq"]],
  "motherboard.chipset": ["string", [], ["eq"]],
  "motherboard.memory_type": ["string", [], ["eq"]],
  "motherboard.memory_slot_count": ["number", ["count"], ["gte", "lte", "between"]],
  "motherboard.memory_population_rules": ["string_set", [], ["includes"]],
  "motherboard.form_factor": ["string", [], ["eq", "includes"]],
  "motherboard.bios_version": ["string", [], ["eq"]],
  "motherboard.bios_upgrade_methods": ["string_set", [], ["includes"]],
  "motherboard.display_outputs": ["string_set", [], ["includes"]],
  "motherboard.supported_operating_systems": ["string_set", [], ["includes"]],
  "memory.type": ["string", [], ["eq"]],
  "memory.capacity": ["number", ["gib"], ["gte", "lte", "between"]],
  "io.port_types": ["string_set", [], ["includes"]],
  "io.header_types": ["string_set", [], ["includes"]],
  "io.endpoint_ids": ["string_set", [], ["includes"]],
  "case.motherboard_form_factors": ["string_set", [], ["includes"]],
  "case.side_panel": ["string", [], ["eq"]],
  "case.gpu_max_length": ["number", ["mm"], ["gte", "between"]],
  "case.cpu_cooler_max_height": ["number", ["mm"], ["gte", "between"]],
  "gpu.length": ["number", ["mm"], ["lte", "between"]],
  "gpu.slot_width": ["number", ["slot"], ["lte", "between"]],
  "gpu.power_connectors": ["string_set", [], ["includes"]],
  "psu.capacity": ["number", ["w"], ["gte", "between"]],
  "psu.connectors": ["string_set", [], ["includes"]],
  "power.source_type": ["string", [], ["eq"]],
  "power.load": ["number", ["w"], ["lte", "gte", "between"]],
  "power.cable_families": ["string_set", [], ["includes"]],
  "pcie.lane_count": ["number", ["count"], ["gte", "between"]],
  "pcie.slot_types": ["string_set", [], ["includes"]],
  "pcie.lane_sharing": ["string_set", [], ["includes"]],
  "storage.interface": ["string", [], ["eq"]],
  "storage.boot_support": ["boolean", [], ["eq"]],
  "storage.recording_technology": ["string", [], ["eq"]],
  "hba.mode": ["string", [], ["eq"]],
  "cooling.fan_mounts": ["string_set", [], ["includes"]],
  "cooling.radiator_support": ["string_set", [], ["includes"]],
  "cooling.pump_header": ["boolean", [], ["eq"]],
  "firmware.version": ["string", [], ["eq"]],
  "firmware.upgrade_path_refs": ["string_set", [], ["includes"]],
  "driver.supported_operating_systems": ["string_set", [], ["includes"]],
  "driver.package_versions": ["string_set", [], ["includes"]],
  "thermal.curve_refs": ["string_set", [], ["includes"]],
  "acoustic.curve_refs": ["string_set", [], ["includes"]],
  "package.contents": ["string_set", [], ["includes"]],
  "resource.kind": ["string", [], ["eq"]],
  "cable.connector_standard": ["string_set", [], ["includes"]],
  "fastener.thread": ["string", [], ["eq"]],
  "fastener.length_mm": ["number", ["mm"], ["eq", "gte", "lte", "between"]],
  "fastener.head": ["string", [], ["eq"]],
  "tool.drive": ["string", [], ["eq"]],
  "consumable.type": ["string", [], ["eq"]],
  "accessory.standard": ["string", [], ["eq"]],
  "acoustic.noise_class": ["string", [], ["eq"]],
});

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, required, optional = []) {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value === value.normalize("NFC")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function canonicallyOrderedStrings(value) {
  return value.every((entry, index) => index === 0 || value[index - 1] < entry);
}

function predicateValue(definition, operator, value) {
  const [type] = definition;
  if (operator === "between") return Array.isArray(value) && value.length === 2
    && finite(value[0]) && finite(value[1]) && value[0] <= value[1];
  if (type === "number") return finite(value);
  if (type === "boolean") return typeof value === "boolean";
  // A predicate over a string-set uses one scalar membership value.
  return text(value);
}

export function isGovernedFacetIdRuntime(value) {
  try { return typeof value === "string" && Object.prototype.hasOwnProperty.call(DEFINITIONS, value); }
  catch { return false; }
}

export function validateGovernedFacetPredicateRuntime(value) {
  try {
    if (!exact(value, ["facetId", "operator", "value"], ["unitId"])) return ["facet predicate shape invalid"];
    if (!isGovernedFacetIdRuntime(value.facetId)) return ["facetId is not allowlisted"];
    const definition = DEFINITIONS[value.facetId];
    const [, units, operators] = definition;
    const errors = [];
    if (!operators.includes(value.operator)) errors.push("operator is not allowed for facetId");
    if (!predicateValue(definition, value.operator, value.value)) errors.push("facet predicate value invalid");
    if (units.length > 0 ? !units.includes(value.unitId) : value.unitId !== undefined) errors.push("facet predicate unit invalid");
    return errors;
  } catch { return ["facet predicate is inaccessible or invalid"]; }
}

/** Validate a supply-side concrete facet (`value` may be a string set). */
export function validateGovernedFacetValueRuntime(value) {
  try {
    if (!exact(value, ["facetId", "value"], ["unitId"])) return ["facet value shape invalid"];
    if (!isGovernedFacetIdRuntime(value.facetId)) return ["facetId is not allowlisted"];
    const [type, units] = DEFINITIONS[value.facetId];
    const shape = type === "number" ? finite(value.value)
      : type === "boolean" ? typeof value.value === "boolean"
        : type === "string_set" ? Array.isArray(value.value) && value.value.length > 0
          && value.value.every(text) && new Set(value.value).size === value.value.length
          && canonicallyOrderedStrings(value.value)
          : text(value.value);
    const errors = shape ? [] : ["facet value invalid"];
    if (units.length > 0 ? !units.includes(value.unitId) : value.unitId !== undefined) errors.push("facet value unit invalid");
    return errors;
  } catch { return ["facet value is inaccessible or invalid"]; }
}

export function governedFacetSatisfiesRuntime(facet, predicate) {
  try {
    if (validateGovernedFacetValueRuntime(facet).length || validateGovernedFacetPredicateRuntime(predicate).length
      || facet.facetId !== predicate.facetId || facet.unitId !== predicate.unitId) return false;
    if (predicate.operator === "includes") return Array.isArray(facet.value) && facet.value.includes(predicate.value);
    if (predicate.operator === "eq") return facet.value === predicate.value;
    if (typeof facet.value !== "number") return false;
    if (predicate.operator === "gte") return facet.value >= predicate.value;
    if (predicate.operator === "lte") return facet.value <= predicate.value;
    return Array.isArray(predicate.value) && facet.value >= predicate.value[0] && facet.value <= predicate.value[1];
  } catch { return false; }
}

export const GOVERNED_FACET_IDS_RUNTIME = Object.freeze(Object.keys(DEFINITIONS));
