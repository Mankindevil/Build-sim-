import { PLAN_PATCH_PATHS } from "../plans/contracts";
import type { UnitNormalizationRule } from "../hash";

export { PLAN_PATCH_PATHS } from "../plans/contracts";

export const REGISTRY_SCHEMA_VERSION = "governed-registries-v2" as const;

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export type RegistryValueType = "number" | "string" | "boolean" | "string_set";

interface MetricDefinition {
  readonly valueType: RegistryValueType;
  readonly unitIds: readonly string[];
  readonly operators: readonly ComparisonOperator[];
}

interface FacetDefinition {
  readonly valueType: RegistryValueType;
  readonly unitIds: readonly string[];
  readonly operators: readonly ComparisonOperator[];
}

export type SafetyClass = "informational" | "compatibility" | "boot" | "electrical_safety" | "destructive_action";
export type RegistrySourcePolicy = "official_required" | "official_or_standard" | "official_third_party_or_user_observation";
export type CapabilityEvidenceAuthority = "official" | "standard" | "third_party" | "user_observation" | "agent_inference";

interface ObservationFieldDefinition {
  readonly valueType: RegistryValueType;
  readonly unitIds: readonly string[];
  readonly subjectKinds: readonly ("plan" | "instance" | "placement" | "connection" | "port" | "mount" | "firmware_instance")[];
  readonly uncertainty: "required" | "optional" | "not_applicable";
}

export const COMPARISON_OPERATORS = deepFreeze(["eq", "gte", "lte", "between", "includes"] as const);
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

/** Initial requirement vocabulary. New IDs require an explicit registry version change. */
export const METRIC_REGISTRY = deepFreeze({
  "budget.total": { valueType: "number", unitIds: ["cny"], operators: ["lte", "between"] },
  "service.horizon": { valueType: "number", unitIds: ["year"], operators: ["gte", "between"] },
  "performance.cpu.multicore": { valueType: "number", unitIds: ["score"], operators: ["gte", "between"] },
  "performance.gpu.frame_rate": { valueType: "number", unitIds: ["fps"], operators: ["gte", "between"] },
  "memory.capacity": { valueType: "number", unitIds: ["gib"], operators: ["gte", "between"] },
  "storage.usable_capacity": { valueType: "number", unitIds: ["tib"], operators: ["gte", "between"] },
  "storage.concurrent_disk_count": { valueType: "number", unitIds: ["count"], operators: ["gte", "between"] },
  "network.throughput": { valueType: "number", unitIds: ["gbps"], operators: ["gte", "between"] },
  "power.capacity": { valueType: "number", unitIds: ["w"], operators: ["gte", "between"] },
  "physical.case_volume": { valueType: "number", unitIds: ["liter"], operators: ["lte", "between"] },
  "physical.gpu_length": { valueType: "number", unitIds: ["mm"], operators: ["lte", "between"] },
  "thermal.ambient": { valueType: "number", unitIds: ["celsius"], operators: ["eq", "between"] },
  "thermal.scenario": { valueType: "string", unitIds: [], operators: ["eq"] },
  "acoustics.noise": { valueType: "number", unitIds: ["dba"], operators: ["lte", "between"] },
  "platform.operating_system": { valueType: "string_set", unitIds: [], operators: ["includes"] },
} as const satisfies Record<string, MetricDefinition>);

/** Facets are typed predicates; arbitrary free-text property names are not accepted. */
export const FACET_REGISTRY = deepFreeze({
  "identity.category": { valueType: "string", unitIds: [], operators: ["eq"] },
  "identity.manufacturer": { valueType: "string", unitIds: [], operators: ["eq"] },
  "identity.model": { valueType: "string", unitIds: [], operators: ["eq"] },
  "identity.revision": { valueType: "string", unitIds: [], operators: ["eq"] },
  "physical.width": { valueType: "number", unitIds: ["mm"], operators: ["lte", "gte", "between"] },
  "physical.height": { valueType: "number", unitIds: ["mm"], operators: ["lte", "gte", "between"] },
  "physical.depth": { valueType: "number", unitIds: ["mm"], operators: ["lte", "gte", "between"] },
  "mount.standard": { valueType: "string", unitIds: [], operators: ["eq"] },
  "mount.point_ids": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "cpu.socket": { valueType: "string", unitIds: [], operators: ["eq"] },
  "motherboard.cpu_socket": { valueType: "string", unitIds: [], operators: ["eq"] },
  "motherboard.chipset": { valueType: "string", unitIds: [], operators: ["eq"] },
  "motherboard.memory_type": { valueType: "string", unitIds: [], operators: ["eq"] },
  "motherboard.memory_slot_count": { valueType: "number", unitIds: ["count"], operators: ["gte", "lte", "between"] },
  "motherboard.memory_population_rules": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "motherboard.form_factor": { valueType: "string", unitIds: [], operators: ["eq", "includes"] },
  "motherboard.bios_version": { valueType: "string", unitIds: [], operators: ["eq"] },
  "motherboard.bios_upgrade_methods": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "motherboard.display_outputs": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "motherboard.supported_operating_systems": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "memory.type": { valueType: "string", unitIds: [], operators: ["eq"] },
  "memory.capacity": { valueType: "number", unitIds: ["gib"], operators: ["gte", "lte", "between"] },
  "io.port_types": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "io.header_types": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "io.endpoint_ids": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "case.motherboard_form_factors": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "case.side_panel": { valueType: "string", unitIds: [], operators: ["eq"] },
  "case.gpu_max_length": { valueType: "number", unitIds: ["mm"], operators: ["gte", "between"] },
  "case.cpu_cooler_max_height": { valueType: "number", unitIds: ["mm"], operators: ["gte", "between"] },
  "gpu.length": { valueType: "number", unitIds: ["mm"], operators: ["lte", "between"] },
  "gpu.slot_width": { valueType: "number", unitIds: ["slot"], operators: ["lte", "between"] },
  "gpu.power_connectors": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "psu.capacity": { valueType: "number", unitIds: ["w"], operators: ["gte", "between"] },
  "psu.connectors": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "power.source_type": { valueType: "string", unitIds: [], operators: ["eq"] },
  "power.load": { valueType: "number", unitIds: ["w"], operators: ["lte", "gte", "between"] },
  "power.cable_families": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "pcie.lane_count": { valueType: "number", unitIds: ["count"], operators: ["gte", "between"] },
  "pcie.slot_types": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "pcie.lane_sharing": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "storage.interface": { valueType: "string", unitIds: [], operators: ["eq"] },
  "storage.boot_support": { valueType: "boolean", unitIds: [], operators: ["eq"] },
  "storage.capacity_bytes": { valueType: "number", unitIds: ["byte"], operators: ["gte", "lte", "between"] },
  "storage.recording_technology": { valueType: "string", unitIds: [], operators: ["eq"] },
  "hba.mode": { valueType: "string", unitIds: [], operators: ["eq"] },
  "cooling.fan_mounts": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "cooling.radiator_support": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "cooling.pump_header": { valueType: "boolean", unitIds: [], operators: ["eq"] },
  "firmware.version": { valueType: "string", unitIds: [], operators: ["eq"] },
  "firmware.upgrade_path_refs": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "driver.supported_operating_systems": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "driver.package_versions": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "thermal.curve_refs": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "acoustic.curve_refs": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "package.contents": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  /** Governed assembly-resource vocabulary shared by RequirementNode and package supplies. */
  "resource.kind": { valueType: "string", unitIds: [], operators: ["eq"] },
  "cable.connector_standard": { valueType: "string_set", unitIds: [], operators: ["includes"] },
  "fastener.thread": { valueType: "string", unitIds: [], operators: ["eq"] },
  "fastener.length_mm": { valueType: "number", unitIds: ["mm"], operators: ["eq", "gte", "lte", "between"] },
  "fastener.head": { valueType: "string", unitIds: [], operators: ["eq"] },
  "tool.drive": { valueType: "string", unitIds: [], operators: ["eq"] },
  "consumable.type": { valueType: "string", unitIds: [], operators: ["eq"] },
  "accessory.standard": { valueType: "string", unitIds: [], operators: ["eq"] },
  "acoustic.noise_class": { valueType: "string", unitIds: [], operators: ["eq"] },
} as const satisfies Record<string, FacetDefinition>);

export const UNIT_REGISTRY = deepFreeze({
  mm: { dimension: "length", canonicalUnitId: "mm", scale: 1 },
  cm: { dimension: "length", canonicalUnitId: "mm", scale: 10 },
  m: { dimension: "length", canonicalUnitId: "mm", scale: 1000 },
  w: { dimension: "power", canonicalUnitId: "w", scale: 1 },
  kw: { dimension: "power", canonicalUnitId: "w", scale: 1000 },
  gib: { dimension: "binary-storage", canonicalUnitId: "gib", scale: 1 },
  tib: { dimension: "binary-storage", canonicalUnitId: "gib", scale: 1024 },
  gb: { dimension: "decimal-storage", canonicalUnitId: "gb", scale: 1 },
  tb: { dimension: "decimal-storage", canonicalUnitId: "gb", scale: 1000 },
  celsius: { dimension: "temperature", canonicalUnitId: "celsius", scale: 1 },
  cny: { dimension: "currency-cny", canonicalUnitId: "cny", scale: 1 },
  year: { dimension: "duration-year", canonicalUnitId: "year", scale: 1 },
  count: { dimension: "count", canonicalUnitId: "count", scale: 1 },
  slot: { dimension: "pcie-slot-width", canonicalUnitId: "slot", scale: 1 },
  fps: { dimension: "frame-rate", canonicalUnitId: "fps", scale: 1 },
  gbps: { dimension: "network-throughput", canonicalUnitId: "gbps", scale: 1 },
  dba: { dimension: "sound-pressure-level", canonicalUnitId: "dba", scale: 1 },
  liter: { dimension: "volume-liter", canonicalUnitId: "liter", scale: 1 },
  score: { dimension: "benchmark-specific-score", canonicalUnitId: "score", scale: 1 },
  percent: { dimension: "ratio-percent", canonicalUnitId: "percent", scale: 1 },
  a: { dimension: "electric-current", canonicalUnitId: "a", scale: 1 },
  byte: { dimension: "byte-count", canonicalUnitId: "byte", scale: 1 },
  tbw: { dimension: "storage-endurance-tbw", canonicalUnitId: "tbw", scale: 1 },
  degree: { dimension: "plane-angle", canonicalUnitId: "degree", scale: 1 },
  rpm: { dimension: "rotational-speed", canonicalUnitId: "rpm", scale: 1 },
} as const);

export const OBSERVATION_FIELD_REGISTRY = deepFreeze({
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
} as const satisfies Record<string, ObservationFieldDefinition>);

/** Stable physical instance kinds. Logical pools/vdevs deliberately do not appear here. */
export const COMPONENT_KIND_REGISTRY = deepFreeze({
  case: { schemaVersion: "1.0.0", category: "enclosure", safetyClass: "compatibility", sourcePolicy: "official_or_standard" },
  motherboard: { schemaVersion: "1.0.0", category: "compute", safetyClass: "boot", sourcePolicy: "official_or_standard" },
  cpu: { schemaVersion: "1.0.0", category: "compute", safetyClass: "boot", sourcePolicy: "official_or_standard" },
  memory_module: { schemaVersion: "1.0.0", category: "compute", safetyClass: "boot", sourcePolicy: "official_or_standard" },
  gpu: { schemaVersion: "1.0.0", category: "expansion", safetyClass: "electrical_safety", sourcePolicy: "official_or_standard" },
  psu: { schemaVersion: "1.0.0", category: "power", safetyClass: "electrical_safety", sourcePolicy: "official_required" },
  cpu_cooler: { schemaVersion: "1.0.0", category: "cooling", safetyClass: "boot", sourcePolicy: "official_or_standard" },
  aio: { schemaVersion: "1.0.0", category: "cooling", safetyClass: "electrical_safety", sourcePolicy: "official_required" },
  radiator: { schemaVersion: "1.0.0", category: "cooling", safetyClass: "compatibility", sourcePolicy: "official_or_standard" },
  pump: { schemaVersion: "1.0.0", category: "cooling", safetyClass: "electrical_safety", sourcePolicy: "official_required" },
  case_fan: { schemaVersion: "1.0.0", category: "cooling", safetyClass: "compatibility", sourcePolicy: "official_or_standard" },
  fan_rgb_hub: { schemaVersion: "1.0.0", category: "cooling", safetyClass: "electrical_safety", sourcePolicy: "official_required" },
  storage_drive: { schemaVersion: "1.0.0", category: "storage", safetyClass: "destructive_action", sourcePolicy: "official_third_party_or_user_observation" },
  hba: { schemaVersion: "1.0.0", category: "storage", safetyClass: "boot", sourcePolicy: "official_required" },
  raid_controller: { schemaVersion: "1.0.0", category: "storage", safetyClass: "destructive_action", sourcePolicy: "official_required" },
  storage_expander: { schemaVersion: "1.0.0", category: "storage", safetyClass: "boot", sourcePolicy: "official_required" },
  backplane: { schemaVersion: "1.0.0", category: "storage", safetyClass: "electrical_safety", sourcePolicy: "official_required" },
  nic: { schemaVersion: "1.0.0", category: "expansion", safetyClass: "boot", sourcePolicy: "official_or_standard" },
  capture_card: { schemaVersion: "1.0.0", category: "expansion", safetyClass: "compatibility", sourcePolicy: "official_or_standard" },
  expansion_board: { schemaVersion: "1.0.0", category: "expansion", safetyClass: "compatibility", sourcePolicy: "official_or_standard" },
  pcie_card: { schemaVersion: "1.0.0", category: "expansion", safetyClass: "compatibility", sourcePolicy: "official_or_standard" },
  cable: { schemaVersion: "1.0.0", category: "interconnect", safetyClass: "electrical_safety", sourcePolicy: "official_required" },
  adapter: { schemaVersion: "1.0.0", category: "interconnect", safetyClass: "electrical_safety", sourcePolicy: "official_required" },
  bracket: { schemaVersion: "1.0.0", category: "assembly", safetyClass: "compatibility", sourcePolicy: "official_or_standard" },
} as const satisfies Record<string, {
  schemaVersion: "1.0.0";
  category: "enclosure" | "compute" | "expansion" | "power" | "cooling" | "storage" | "interconnect" | "assembly";
  safetyClass: SafetyClass;
  sourcePolicy: RegistrySourcePolicy;
}>);

export const SYSTEM_PROFILE_REGISTRY = deepFreeze({
  "system.windows-11": { schemaVersion: "1.0.0", type: "desktop_os", safetyClass: "boot", sourcePolicy: "official_required" },
  "system.linux-desktop": { schemaVersion: "1.0.0", type: "desktop_os", safetyClass: "boot", sourcePolicy: "official_required" },
  "system.truenas-scale": { schemaVersion: "1.0.0", type: "storage_os", safetyClass: "destructive_action", sourcePolicy: "official_required" },
  "system.proxmox-ve": { schemaVersion: "1.0.0", type: "hypervisor", safetyClass: "destructive_action", sourcePolicy: "official_required" },
} as const satisfies Record<string, { schemaVersion: "1.0.0"; type: "desktop_os" | "storage_os" | "hypervisor"; safetyClass: SafetyClass; sourcePolicy: RegistrySourcePolicy }>);

/** Bootstrap release IDs are registry identities, never an assertion that a release is currently latest. */
export const SYSTEM_RELEASE_REGISTRY = deepFreeze({
  "system-release.windows-11.24h2": { schemaVersion: "1.0.0", profileId: "system.windows-11", release: "24H2", safetyClass: "boot", sourcePolicy: "official_required" },
  "system-release.truenas-scale.25.04": { schemaVersion: "1.0.0", profileId: "system.truenas-scale", release: "25.04", safetyClass: "destructive_action", sourcePolicy: "official_required" },
  "system-release.proxmox-ve.9": { schemaVersion: "1.0.0", profileId: "system.proxmox-ve", release: "9", safetyClass: "destructive_action", sourcePolicy: "official_required" },
} as const satisfies Record<string, { schemaVersion: "1.0.0"; profileId: keyof typeof SYSTEM_PROFILE_REGISTRY; release: string; safetyClass: SafetyClass; sourcePolicy: RegistrySourcePolicy }>);

export const FIRMWARE_SETTING_REGISTRY = deepFreeze({
  iommu: { schemaVersion: "1.0.0", valueType: "enum", allowedValues: ["enabled", "disabled"], safetyClass: "boot", sourcePolicy: "official_required" },
  virtualization: { schemaVersion: "1.0.0", valueType: "enum", allowedValues: ["enabled", "disabled"], safetyClass: "boot", sourcePolicy: "official_required" },
  secure_boot: { schemaVersion: "1.0.0", valueType: "enum", allowedValues: ["enabled", "disabled"], safetyClass: "boot", sourcePolicy: "official_required" },
  tpm: { schemaVersion: "1.0.0", valueType: "enum", allowedValues: ["enabled", "disabled"], safetyClass: "boot", sourcePolicy: "official_required" },
  csm: { schemaVersion: "1.0.0", valueType: "enum", allowedValues: ["enabled", "disabled"], safetyClass: "boot", sourcePolicy: "official_required" },
  storage_controller_mode: { schemaVersion: "1.0.0", valueType: "enum", allowedValues: ["ahci", "raid", "hba_it"], safetyClass: "destructive_action", sourcePolicy: "official_required" },
  memory_profile: { schemaVersion: "1.0.0", valueType: "enum", allowedValues: ["jedec", "xmp", "expo"], safetyClass: "compatibility", sourcePolicy: "official_required" },
  resizable_bar: { schemaVersion: "1.0.0", valueType: "enum", allowedValues: ["enabled", "disabled"], safetyClass: "compatibility", sourcePolicy: "official_required" },
  above_4g_decoding: { schemaVersion: "1.0.0", valueType: "enum", allowedValues: ["enabled", "disabled"], safetyClass: "boot", sourcePolicy: "official_required" },
  ecc: { schemaVersion: "1.0.0", valueType: "enum", allowedValues: ["enabled", "disabled", "auto"], safetyClass: "boot", sourcePolicy: "official_required" },
} as const satisfies Record<string, { schemaVersion: "1.0.0"; valueType: "enum"; allowedValues: readonly string[]; safetyClass: SafetyClass; sourcePolicy: RegistrySourcePolicy }>);

export const BENCHMARK_REGISTRY = deepFreeze({
  "benchmark.cinebench-2024.cpu-multicore": {
    schemaVersion: "1.0.0", metricId: "performance.cpu.multicore", unitId: "score",
    requiredContextKeys: ["softwareVersion", "powerProfile"],
  },
  "benchmark.game.fps": {
    schemaVersion: "1.0.0", metricId: "performance.gpu.frame_rate", unitId: "fps",
    requiredContextKeys: ["title", "titleVersion", "resolution", "qualityPreset", "graphicsApi"],
  },
} as const);

export type MetricId = keyof typeof METRIC_REGISTRY;
export type FacetId = keyof typeof FACET_REGISTRY;
export type UnitId = keyof typeof UNIT_REGISTRY;
export type ObservationFieldId = keyof typeof OBSERVATION_FIELD_REGISTRY;
export type ComponentKindId = keyof typeof COMPONENT_KIND_REGISTRY;
export type SystemProfileId = keyof typeof SYSTEM_PROFILE_REGISTRY;
export type SystemReleaseId = keyof typeof SYSTEM_RELEASE_REGISTRY;
export type FirmwareSettingId = keyof typeof FIRMWARE_SETTING_REGISTRY;
export type BenchmarkId = keyof typeof BENCHMARK_REGISTRY;

export interface CapabilityFacet {
  facetId: FacetId;
  value: number | string | boolean | readonly string[];
  unitId?: UnitId;
  sourceFactIds: string[];
  safetyClass: SafetyClass;
}

const ELECTRICAL_SAFETY_FACETS = new Set<FacetId>([
  "io.port_types", "io.header_types", "io.endpoint_ids",
  "gpu.power_connectors", "psu.capacity", "psu.connectors",
  "power.source_type", "power.load", "power.cable_families",
  "cooling.pump_header", "package.contents", "cable.connector_standard",
]);

const BOOT_FACETS = new Set<FacetId>([
  "cpu.socket", "motherboard.cpu_socket", "motherboard.chipset",
  "motherboard.memory_type", "motherboard.memory_slot_count", "motherboard.memory_population_rules",
  "motherboard.bios_version", "motherboard.bios_upgrade_methods", "motherboard.display_outputs",
  "motherboard.supported_operating_systems", "memory.type", "memory.capacity",
  "pcie.lane_count", "pcie.slot_types", "pcie.lane_sharing",
  "storage.interface", "storage.boot_support", "storage.capacity_bytes", "hba.mode",
  "firmware.version", "firmware.upgrade_path_refs",
  "driver.supported_operating_systems", "driver.package_versions",
]);

const INFORMATIONAL_FACETS = new Set<FacetId>([
  "thermal.curve_refs", "acoustic.curve_refs", "acoustic.noise_class",
]);

const OBSERVATIONAL_PASS_FACETS = new Set<FacetId>([
  "physical.width", "physical.height", "physical.depth", "mount.point_ids",
  "case.side_panel", "case.gpu_max_length", "case.cpu_cooler_max_height",
  "gpu.length", "gpu.slot_width", "cooling.fan_mounts", "cooling.radiator_support",
  "resource.kind", "fastener.thread", "fastener.length_mm", "fastener.head",
  "tool.drive", "consumable.type", "accessory.standard",
  ...INFORMATIONAL_FACETS,
]);

/**
 * `sourcePolicy` below is the minimum evidence class that may support a
 * positive/pass conclusion. It is not an ingestion allowlist: weaker sources
 * may still be stored, but cannot green a stricter facet.
 */
export const CAPABILITY_FACET_REGISTRY = deepFreeze(Object.fromEntries(
  Object.entries(FACET_REGISTRY).map(([facetId, definition]) => [facetId, {
    schemaVersion: "1.0.0" as const,
    valueType: definition.valueType,
    unitIds: definition.unitIds,
    safetyClass: ELECTRICAL_SAFETY_FACETS.has(facetId as FacetId)
      ? "electrical_safety" as const
      : BOOT_FACETS.has(facetId as FacetId)
        ? "boot" as const
        : INFORMATIONAL_FACETS.has(facetId as FacetId)
          ? "informational" as const
          : "compatibility" as const,
    sourcePolicy: ELECTRICAL_SAFETY_FACETS.has(facetId as FacetId) || BOOT_FACETS.has(facetId as FacetId)
      ? "official_required" as const
      : OBSERVATIONAL_PASS_FACETS.has(facetId as FacetId)
        ? "official_third_party_or_user_observation" as const
        : "official_or_standard" as const,
  }]),
) as unknown as Record<FacetId, { schemaVersion: "1.0.0"; valueType: RegistryValueType; unitIds: readonly string[]; safetyClass: SafetyClass; sourcePolicy: RegistrySourcePolicy }>);

/**
 * Serializable registry metadata. This is hashable configuration, not the
 * executable adapter contract from the architecture plan.
 */
export interface HardwareAdapterManifest {
  adapterId: string;
  adapterVersion: string;
  contractVersion: "hardware-adapter-v1";
  componentKindIds: readonly ComponentKindId[];
  emittedFacetIds: readonly FacetId[];
  safetyClass: SafetyClass;
  sourcePolicy: RegistrySourcePolicy;
}

/** Domain manifests are versioned adapter outputs whose detailed schemas are frozen by their owning domains. */
export type GeometryManifest = Readonly<Record<string, unknown>>;
export type RoutingManifest = Readonly<Record<string, unknown>>;
export type AssemblyManifest = Readonly<Record<string, unknown>>;
export type ThermalManifest = Readonly<Record<string, unknown>>;

/** Executable adapter boundary frozen by authoritative plan §4.4. */
export interface HardwareAdapter {
  adapterId: string;
  adapterVersion: string;
  subjectSkuId: string;
  capabilities(): CapabilityFacet[];
  geometry(): GeometryManifest | null;
  routing(): RoutingManifest | null;
  assembly(): AssemblyManifest | null;
  thermal(): ThermalManifest | null;
  provenance(): string[];
}

export const HARDWARE_ADAPTER_REGISTRY = deepFreeze({
  "adapter.catalog.generic": {
    adapterId: "adapter.catalog.generic", adapterVersion: "1.0.0", contractVersion: "hardware-adapter-v1",
    componentKindIds: ["case", "motherboard", "cpu", "memory_module", "gpu", "psu", "cpu_cooler", "aio", "radiator", "pump", "case_fan", "fan_rgb_hub", "storage_drive", "hba", "raid_controller", "storage_expander", "backplane", "nic", "capture_card", "expansion_board", "pcie_card", "cable", "adapter", "bracket"],
    // v1.0.0 is a persisted adapter contract. U6 resource/allocation facets
    // are governed vocabulary for package manifests and RequirementNode, not
    // newly claimed outputs of this frozen catalog adapter version.
    emittedFacetIds: [
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
      "storage.interface", "storage.boot_support", "storage.recording_technology", "hba.mode",
      "cooling.fan_mounts", "cooling.radiator_support", "cooling.pump_header", "firmware.version",
      "firmware.upgrade_path_refs", "driver.supported_operating_systems", "driver.package_versions",
      "thermal.curve_refs", "acoustic.curve_refs", "package.contents", "acoustic.noise_class",
    ],
    safetyClass: "electrical_safety", sourcePolicy: "official_required",
  },
} as const satisfies Record<string, HardwareAdapterManifest>);
export type HardwareAdapterId = keyof typeof HARDWARE_ADAPTER_REGISTRY;

export interface GovernedRequirementMetric {
  readonly metricId: MetricId;
  readonly operator: ComparisonOperator;
  readonly value: number | string | boolean | readonly [number, number];
  readonly unitId?: UnitId;
  readonly priority: "must" | "important" | "nice_to_have";
  /** Required for benchmark-shaped performance metrics; context prevents a universal score. */
  readonly benchmarkId?: BenchmarkId;
  readonly benchmarkContext?: Readonly<Record<string, string>>;
}

export interface GovernedFacetPredicate {
  readonly facetId: FacetId;
  readonly operator: ComparisonOperator;
  readonly value: number | string | boolean | readonly [number, number];
  readonly unitId?: UnitId;
}

export const SIMULATION_JSON_PATCH_PATHS = deepFreeze([
  "/workloadMetricRefs",
  "/workloadMetricRefs/{index}",
  "/workloadMetricRefs/-",
  "/ambientC",
  "/ambientC/min",
  "/ambientC/max",
  "/fanPolicyId",
  "/storageActivity",
  "/storageActivity/{index}",
  "/storageActivity/-",
  "/storageActivity/{index}/logicalLayoutId",
  "/storageActivity/{index}/dutyCycle",
  "/storageActivity/{index}/concurrentDiskCount",
  "/placementIds",
  "/placementIds/{index}",
  "/placementIds/-",
  "/routeIds",
  "/routeIds/{index}",
  "/routeIds/-",
  "/modelVersion",
] as const);

type JsonPatchArrayIndex = `${number}`;
type JsonPatchArrayPosition = JsonPatchArrayIndex | "-";
export type SimulationJsonPatchPath =
  | "/workloadMetricRefs" | `/workloadMetricRefs/${JsonPatchArrayPosition}`
  | "/ambientC" | "/ambientC/min" | "/ambientC/max"
  | "/fanPolicyId"
  | "/storageActivity" | `/storageActivity/${JsonPatchArrayPosition}`
  | `/storageActivity/${JsonPatchArrayIndex}/${"logicalLayoutId" | "dutyCycle" | "concurrentDiskCount"}`
  | "/placementIds" | `/placementIds/${JsonPatchArrayPosition}`
  | "/routeIds" | `/routeIds/${JsonPatchArrayPosition}`
  | "/modelVersion";

/**
 * V3 does not pretend RFC 6902 can address an element by stable identity. Each
 * operation carries a structured selector. Collection IDs are immutable;
 * runtime application must additionally prove existence/non-existence against
 * the exact base config before applying the operation.
 */
export const TOPOLOGY_V3_PATCH_COLLECTION_REGISTRY = deepFreeze({
  config: { idField: null, parentCollection: null, mutableFields: ["name", "intent", "requirementSpec", "requirementBudget", "requirementHorizonYears", "system", "notes"] },
  components: { idField: "instanceId", parentCollection: null, mutableFields: ["kind", "role", "state", "identity"] },
  roleDecisions: { idField: "roleDecisionId", parentCollection: null, mutableFields: [] },
  placements: { idField: "placementId", parentCollection: null, mutableFields: ["componentInstanceId", "mountOwnerInstanceId", "mountId"] },
  connections: { idField: "connectionId", parentCollection: null, mutableFields: ["from", "to", "cableInstanceId", "status"] },
  logicalLayouts: { idField: "layoutId", parentCollection: null, mutableFields: ["bootPoolDiskIds", "spareDiskIds"] },
  vdevs: { idField: "vdevId", parentCollection: "logicalLayouts", mutableFields: ["topology", "diskInstanceIds"] },
  firmwareTargets: { idField: "instanceId", parentCollection: null, mutableFields: ["targetReleaseFactId", "requestedSettings"] },
  workloads: { idField: "workloadId", parentCollection: null, mutableFields: ["name", "evidenceOrBenchmarkRefs"] },
  metrics: { idField: "metricId", parentCollection: "workloads", mutableFields: [] },
  constraints: { idField: "constraintId", parentCollection: null, mutableFields: [] },
} as const);

export type TopologyV3PatchCollection = keyof typeof TOPOLOGY_V3_PATCH_COLLECTION_REGISTRY;
export interface TopologyV3PatchSelector {
  collection: TopologyV3PatchCollection;
  id?: string;
  parentId?: string;
  field?: string;
}
export type TopologyV3PatchOperation =
  | { op: "add" | "replace"; selector: TopologyV3PatchSelector; value: unknown }
  | { op: "remove"; selector: TopologyV3PatchSelector };
export type PatchActor = "user" | "agent" | "solver" | "system";
export interface PatchValidationContext { actor: PatchActor }

export type GovernedPatchTarget = "plan" | "plan-v3" | "simulation";

function hasOwn(registry: object, id: unknown): id is string {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(registry, id);
}

export function isMetricId(id: unknown): id is MetricId { return hasOwn(METRIC_REGISTRY, id); }
export function isFacetId(id: unknown): id is FacetId { return hasOwn(FACET_REGISTRY, id); }
export function isUnitId(id: unknown): id is UnitId { return hasOwn(UNIT_REGISTRY, id); }
export function isObservationFieldId(id: unknown): id is ObservationFieldId { return hasOwn(OBSERVATION_FIELD_REGISTRY, id); }
export function isComponentKindId(id: unknown): id is ComponentKindId { return hasOwn(COMPONENT_KIND_REGISTRY, id); }
export function isSystemProfileId(id: unknown): id is SystemProfileId { return hasOwn(SYSTEM_PROFILE_REGISTRY, id); }
export function isSystemReleaseId(id: unknown): id is SystemReleaseId { return hasOwn(SYSTEM_RELEASE_REGISTRY, id); }
export function isFirmwareSettingId(id: unknown): id is FirmwareSettingId { return hasOwn(FIRMWARE_SETTING_REGISTRY, id); }
export function isBenchmarkId(id: unknown): id is BenchmarkId { return hasOwn(BENCHMARK_REGISTRY, id); }
export function isHardwareAdapterId(id: unknown): id is HardwareAdapterId { return hasOwn(HARDWARE_ADAPTER_REGISTRY, id); }
export function isComparisonOperator(value: unknown): value is ComparisonOperator {
  return typeof value === "string" && (COMPARISON_OPERATORS as readonly string[]).includes(value);
}

/** Governed pass-source decision. Ingestion may retain sources that return false here. */
export function canCapabilityEvidenceSupportPass(facetId: unknown, authority: CapabilityEvidenceAuthority): boolean {
  if (!isFacetId(facetId)) return false;
  const policy = CAPABILITY_FACET_REGISTRY[facetId].sourcePolicy;
  if (policy === "official_required") return authority === "official";
  if (policy === "official_or_standard") return authority === "official" || authority === "standard";
  return authority !== "agent_inference";
}

export function assertMetricId(id: unknown): asserts id is MetricId {
  if (!isMetricId(id)) throw new TypeError(`Unknown governed metricId: ${String(id)}`);
}

export function assertFacetId(id: unknown): asserts id is FacetId {
  if (!isFacetId(id)) throw new TypeError(`Unknown governed facetId: ${String(id)}`);
}

export function assertUnitId(id: unknown): asserts id is UnitId {
  if (!isUnitId(id)) throw new TypeError(`Unknown governed unitId: ${String(id)}`);
}

export function assertObservationFieldId(id: unknown): asserts id is ObservationFieldId {
  if (!isObservationFieldId(id)) throw new TypeError(`Unknown governed observation fieldId: ${String(id)}`);
}

function validateGovernedValue(valueType: RegistryValueType, operator: ComparisonOperator, value: unknown): string[] {
  if (operator === "between") {
    if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
      return ["between value must be a pair of finite numbers"];
    }
    return Number(value[0]) <= Number(value[1]) ? [] : ["between lower bound must not exceed upper bound"];
  }
  if (valueType === "number") return typeof value === "number" && Number.isFinite(value) ? [] : ["value must be a finite number"];
  if (valueType === "boolean") return typeof value === "boolean" ? [] : ["value must be a boolean"];
  // `includes` consumes one governed member, not a caller-defined expression or regex.
  return typeof value === "string" && value.length > 0 ? [] : ["value must be a non-empty string"];
}

function validateUnit(unitIds: readonly string[], unitId: unknown): string[] {
  if (unitIds.length === 0) return unitId === undefined ? [] : ["unitId is not allowed for this registry entry"];
  if (typeof unitId !== "string" || !unitIds.includes(unitId)) return ["unitId is not allowlisted for this registry entry"];
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUniqueNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(isNonEmptyString)
    && new Set(value).size === value.length;
}

function hasSameUniqueStrings(value: unknown, expected: readonly string[]): boolean {
  return isUniqueNonEmptyStringArray(value)
    && value.length === expected.length
    && value.every((item) => expected.includes(item));
}

export function validateCapabilityFacet(value: unknown): string[] {
  if (!isRecord(value)) return ["capability facet must be an object"];
  const errors: string[] = [];
  if (Object.keys(value).some((key) => !["facetId", "value", "unitId", "sourceFactIds", "safetyClass"].includes(key))) errors.push("capability facet contains unknown fields");
  if (!isFacetId(value.facetId)) return [...errors, "capability facetId is not allowlisted"];
  const contract = CAPABILITY_FACET_REGISTRY[value.facetId];
  if (contract.valueType === "string_set") {
    if (!isUniqueNonEmptyStringArray(value.value)) errors.push("capability facet value must be a unique non-empty string set");
  } else errors.push(...validateGovernedValue(contract.valueType, "eq", value.value));
  errors.push(...validateUnit(contract.unitIds, value.unitId));
  if (!isUniqueNonEmptyStringArray(value.sourceFactIds) || value.sourceFactIds.length === 0) errors.push("capability facet requires unique source fact IDs");
  if (value.safetyClass !== contract.safetyClass) errors.push("capability facet safetyClass must match registry");
  return errors;
}

export function validateHardwareAdapterManifest(value: unknown): string[] {
  if (!isRecord(value)) return ["hardware adapter manifest must be an object"];
  const errors: string[] = [];
  const fields = ["adapterId", "adapterVersion", "contractVersion", "componentKindIds", "emittedFacetIds", "safetyClass", "sourcePolicy"];
  if (Object.keys(value).some((key) => !fields.includes(key))) errors.push("hardware adapter manifest contains unknown fields");
  if (!isNonEmptyString(value.adapterId) || !isNonEmptyString(value.adapterVersion)) errors.push("hardware adapter manifest identity invalid");
  if (value.contractVersion !== "hardware-adapter-v1") errors.push("hardware adapter manifest contractVersion invalid");
  if (!isUniqueNonEmptyStringArray(value.componentKindIds) || value.componentKindIds.some((id) => !isComponentKindId(id))) errors.push("hardware adapter manifest component kinds invalid");
  if (!isUniqueNonEmptyStringArray(value.emittedFacetIds) || value.emittedFacetIds.some((id) => !isFacetId(id))) errors.push("hardware adapter manifest emitted facets invalid");
  if (!["informational", "compatibility", "boot", "electrical_safety", "destructive_action"].includes(String(value.safetyClass))) errors.push("hardware adapter manifest safetyClass invalid");
  if (!["official_required", "official_or_standard", "official_third_party_or_user_observation"].includes(String(value.sourcePolicy))) errors.push("hardware adapter manifest sourcePolicy invalid");
  if (!isHardwareAdapterId(value.adapterId)) errors.push("hardware adapter manifest adapterId is not registered");
  else {
    const registered = HARDWARE_ADAPTER_REGISTRY[value.adapterId];
    if (value.adapterVersion !== registered.adapterVersion
      || value.contractVersion !== registered.contractVersion
      || value.safetyClass !== registered.safetyClass
      || value.sourcePolicy !== registered.sourcePolicy
      || !hasSameUniqueStrings(value.componentKindIds, registered.componentKindIds)
      || !hasSameUniqueStrings(value.emittedFacetIds, registered.emittedFacetIds)) errors.push("hardware adapter manifest does not match frozen registry entry");
  }
  return errors;
}

function validateOptionalDomainManifest(value: unknown, methodName: string): string[] {
  return value === null || isRecord(value) ? [] : [`hardware adapter ${methodName}() must return an object or null`];
}

/**
 * Validate the executable §4.4 adapter contract and bind its identity and
 * emitted capabilities to the frozen serializable manifest.
 */
export function validateHardwareAdapter(value: unknown): string[] {
  if (!isRecord(value)) return ["hardware adapter must be an object"];
  const errors: string[] = [];
  const fields = ["adapterId", "adapterVersion", "subjectSkuId", "capabilities", "geometry", "routing", "assembly", "thermal", "provenance"];
  if (Object.keys(value).some((key) => !fields.includes(key))) errors.push("hardware adapter contains unknown fields");
  if (!isNonEmptyString(value.adapterId) || !isNonEmptyString(value.adapterVersion) || !isNonEmptyString(value.subjectSkuId)) {
    errors.push("hardware adapter identity/subject invalid");
  }
  const methodNames = ["capabilities", "geometry", "routing", "assembly", "thermal", "provenance"] as const;
  for (const methodName of methodNames) {
    if (typeof value[methodName] !== "function") errors.push(`hardware adapter ${methodName}() missing`);
  }
  if (!isHardwareAdapterId(value.adapterId)) errors.push("hardware adapterId is not registered");
  else if (value.adapterVersion !== HARDWARE_ADAPTER_REGISTRY[value.adapterId].adapterVersion) {
    errors.push("hardware adapter version does not match frozen registry entry");
  }
  if (errors.some((error) => error.endsWith("() missing"))) return errors;

  try {
    const capabilities = (value.capabilities as () => unknown).call(value);
    if (!Array.isArray(capabilities)) errors.push("hardware adapter capabilities() must return an array");
    else {
      const facetIds: string[] = [];
      capabilities.forEach((facet, index) => {
        if (isRecord(facet) && isNonEmptyString(facet.facetId)) facetIds.push(facet.facetId);
        errors.push(...validateCapabilityFacet(facet).map((error) => `hardware adapter capabilities.${index}: ${error}`));
      });
      if (new Set(facetIds).size !== facetIds.length) errors.push("hardware adapter capabilities must have unique facetId values");
      if (isHardwareAdapterId(value.adapterId)) {
        const emittedFacetIds = HARDWARE_ADAPTER_REGISTRY[value.adapterId].emittedFacetIds as readonly string[];
        if (facetIds.some((facetId) => !emittedFacetIds.includes(facetId))) errors.push("hardware adapter emitted an undeclared capability facet");
      }
    }
    errors.push(...validateOptionalDomainManifest((value.geometry as () => unknown).call(value), "geometry"));
    errors.push(...validateOptionalDomainManifest((value.routing as () => unknown).call(value), "routing"));
    errors.push(...validateOptionalDomainManifest((value.assembly as () => unknown).call(value), "assembly"));
    errors.push(...validateOptionalDomainManifest((value.thermal as () => unknown).call(value), "thermal"));
    const provenance = (value.provenance as () => unknown).call(value);
    if (!isUniqueNonEmptyStringArray(provenance) || provenance.length === 0) errors.push("hardware adapter provenance() must return unique non-empty references");
  } catch {
    errors.push("hardware adapter method threw during contract validation");
  }
  return errors;
}

export function validateSystemReleaseReference(profileId: unknown, releaseId: unknown): string[] {
  if (!isSystemProfileId(profileId)) return ["system profileId is not registered"];
  if (!isSystemReleaseId(releaseId)) return ["system releaseId is not registered"];
  return SYSTEM_RELEASE_REGISTRY[releaseId].profileId === profileId ? [] : ["system release does not belong to profile"];
}

export function validateFirmwareSettingValue(settingId: unknown, desiredValue: unknown): string[] {
  if (!isFirmwareSettingId(settingId)) return ["firmware settingId is not allowlisted"];
  return typeof desiredValue === "string" && (FIRMWARE_SETTING_REGISTRY[settingId].allowedValues as readonly string[]).includes(desiredValue)
    ? []
    : ["firmware desiredValue is not allowlisted for settingId"];
}

export function validateRequirementMetric(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["requirement metric must be an object"];
  const input = value as Record<string, unknown>;
  const errors: string[] = [];
  if (Object.keys(input).some((key) => !["metricId", "operator", "value", "unitId", "priority", "benchmarkId", "benchmarkContext"].includes(key))) errors.push("requirement metric contains unknown fields");
  if (!isMetricId(input.metricId)) return [...errors, "metricId is not allowlisted"];
  if (!isComparisonOperator(input.operator)) return [...errors, "operator is not allowlisted"];
  const definition: MetricDefinition = METRIC_REGISTRY[input.metricId];
  if (!definition.operators.includes(input.operator)) errors.push("operator is not allowed for metricId");
  errors.push(...validateGovernedValue(definition.valueType, input.operator, input.value));
  errors.push(...validateUnit(definition.unitIds, input.unitId));
  if (input.priority !== "must" && input.priority !== "important" && input.priority !== "nice_to_have") errors.push("priority invalid");
  const requiresBenchmark = input.metricId === "performance.cpu.multicore" || input.metricId === "performance.gpu.frame_rate";
  if (requiresBenchmark) {
    if (!isBenchmarkId(input.benchmarkId)) errors.push("performance metric benchmarkId is required and must be allowlisted");
    else {
      const benchmark = BENCHMARK_REGISTRY[input.benchmarkId];
      if (benchmark.metricId !== input.metricId || benchmark.unitId !== input.unitId) errors.push("benchmarkId does not match metricId/unitId");
      const benchmarkContext = input.benchmarkContext;
      if (!isRecord(benchmarkContext)
        || Object.keys(benchmarkContext).some((key) => !(benchmark.requiredContextKeys as readonly string[]).includes(key))
        || (benchmark.requiredContextKeys as readonly string[]).some((key) => !isRecord(benchmarkContext) || !isNonEmptyString(benchmarkContext[key]))) {
        errors.push("performance metric benchmarkContext is incomplete or contains unknown keys");
      }
    }
  } else if (input.benchmarkId !== undefined || input.benchmarkContext !== undefined) {
    errors.push("benchmark identity is only allowed for benchmark-shaped performance metrics");
  }
  return errors;
}

export function validateFacetPredicate(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["facet predicate must be an object"];
  const input = value as Record<string, unknown>;
  const errors: string[] = [];
  if (Object.keys(input).some((key) => !["facetId", "operator", "value", "unitId"].includes(key))) errors.push("facet predicate contains unknown fields");
  if (!isFacetId(input.facetId)) return [...errors, "facetId is not allowlisted"];
  if (!isComparisonOperator(input.operator)) return [...errors, "operator is not allowlisted"];
  const definition: FacetDefinition = FACET_REGISTRY[input.facetId];
  if (!definition.operators.includes(input.operator)) errors.push("operator is not allowed for facetId");
  errors.push(...validateGovernedValue(definition.valueType, input.operator, input.value));
  errors.push(...validateUnit(definition.unitIds, input.unitId));
  return errors;
}

export function validateObservationFieldValue(
  fieldId: unknown,
  value: unknown,
  unitId: unknown,
  subjectKind: unknown,
  hasUncertainty: boolean,
): string[] {
  if (!isObservationFieldId(fieldId)) return ["observation fieldId is not allowlisted"];
  const definition: ObservationFieldDefinition = OBSERVATION_FIELD_REGISTRY[fieldId];
  const errors = validateGovernedValue(definition.valueType, "eq", value);
  errors.push(...validateUnit(definition.unitIds, unitId));
  if (typeof subjectKind !== "string" || !(definition.subjectKinds as readonly string[]).includes(subjectKind)) errors.push("subject kind is not allowed for observation fieldId");
  if (definition.uncertainty === "required" && !hasUncertainty) errors.push("uncertainty is required for observation fieldId");
  if (definition.uncertainty === "not_applicable" && hasUncertainty) errors.push("uncertainty is not allowed for observation fieldId");
  return errors;
}

const CANONICAL_ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

function matchesJsonPatchPathPattern(path: string, pattern: string): boolean {
  const pathSegments = path.split("/");
  const patternSegments = pattern.split("/");
  if (pathSegments.length !== patternSegments.length) return false;
  return patternSegments.every((segment, index) => (
    segment === "{index}" ? CANONICAL_ARRAY_INDEX.test(pathSegments[index] ?? "") : segment === pathSegments[index]
  ));
}

export function isAllowedJsonPatchPath(target: GovernedPatchTarget, path: unknown): boolean {
  if (typeof path !== "string") return false;
  if (target === "plan") return (PLAN_PATCH_PATHS as readonly string[]).includes(path);
  if (target === "plan-v3") return false;
  return (SIMULATION_JSON_PATCH_PATHS as readonly string[])
    .some((pattern) => matchesJsonPatchPathPattern(path, pattern));
}

function containsForbiddenActorAssertion(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenActorAssertion);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    (key === "confirmedByUser" && child === true)
    || (key === "lockedByUser" && child === true)
    || (key === "confirmedAt" && isNonEmptyString(child))
    || (key === "source" && child === "user")
    || containsForbiddenActorAssertion(child)
  ));
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return !Object.keys(value).some((key) => !fields.includes(key));
}

function stringArray(value: unknown, requireNonEmpty = false): value is string[] {
  return Array.isArray(value)
    && (!requireNonEmpty || value.length > 0)
    && value.every(isNonEmptyString)
    && new Set(value).size === value.length;
}

function validateIdentity(value: unknown): string[] {
  if (!isRecord(value)) return ["component identity must be an object"];
  if (value.status === "unresolved") {
    const errors = !exactFields(value, ["status", "userText", "candidateIds"]) ? ["unresolved identity contains unknown fields"] : [];
    if (!isNonEmptyString(value.userText)) errors.push("unresolved identity userText invalid");
    if (value.candidateIds !== undefined && !stringArray(value.candidateIds)) errors.push("unresolved identity candidateIds invalid");
    return errors;
  }
  if (value.status === "resolved") {
    const errors = !exactFields(value, ["status", "skuId", "identityClaimIds"]) ? ["resolved identity contains unknown fields"] : [];
    if (!isNonEmptyString(value.skuId) || !stringArray(value.identityClaimIds, true)) errors.push("resolved identity skuId/identityClaimIds invalid");
    return errors;
  }
  return ["component identity status invalid"];
}

function validateDraft(value: unknown, valueKind: "intent" | "budget" | "horizon"): string[] {
  if (!isRecord(value)) return ["draft field must be an object"];
  const answered = value.state === "answered";
  const errors: string[] = [];
  if (!exactFields(value, answered ? ["state", "value", "source", "confirmedByUser"] : ["state", "source", "confirmedByUser"])) errors.push("draft field contains unknown fields");
  if (!answered && value.state !== "deferred" && value.state !== "not_applicable") errors.push("draft field state invalid");
  if (!["user", "defaulted", "agent_proposed"].includes(String(value.source)) || typeof value.confirmedByUser !== "boolean") errors.push("draft field provenance invalid");
  if (!answered && "value" in value) errors.push("unanswered draft field cannot contain value");
  if (answered) {
    if (valueKind === "intent" && !["pc", "workstation", "nas"].includes(String(value.value))) errors.push("intent value invalid");
    if (valueKind === "horizon" && !(typeof value.value === "number" && Number.isFinite(value.value) && value.value > 0)) errors.push("horizon value invalid");
    if (valueKind === "budget") {
      if (!isRecord(value.value) || !exactFields(value.value, ["targetCny", "hardCapCny", "reserveCny"])) errors.push("budget value invalid");
      else {
        const amounts = Object.values(value.value);
        if (amounts.length === 0 || amounts.some((amount) => typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) errors.push("budget amounts invalid");
        if (typeof value.value.targetCny === "number" && typeof value.value.hardCapCny === "number" && value.value.targetCny > value.value.hardCapCny) errors.push("budget target exceeds hard cap");
      }
    }
  }
  return errors;
}

function validateMetricEntity(value: unknown, selectorId: string): string[] {
  if (!isRecord(value)) return ["metric value must be an object"];
  if (value.state === "deferred" || value.state === "not_applicable") {
    const errors = !exactFields(value, ["metricId", "state", "source", "confirmedByUser"])
      ? [`${value.state} metric must not contain answered fields`]
      : [];
    if (value.metricId !== selectorId || !isMetricId(value.metricId)) errors.push("metric selector id must equal a governed metricId");
    if (!["user", "migration", "agent_proposed"].includes(String(value.source)) || typeof value.confirmedByUser !== "boolean") errors.push("metric provenance invalid");
    return errors;
  }
  if (value.state !== undefined && value.state !== "answered") return ["metric state invalid"];
  const fields = ["metricId", "state", "operator", "value", "unitId", "priority", "source", "confirmedByUser", "benchmarkId", "benchmarkContext"];
  const errors = !exactFields(value, fields) ? ["metric value contains unknown fields"] : [];
  if (value.metricId !== selectorId) errors.push("metric selector id must equal metricId");
  const governed = Object.fromEntries(Object.entries(value).filter(([key]) => ["metricId", "operator", "value", "unitId", "priority", "benchmarkId", "benchmarkContext"].includes(key)));
  errors.push(...validateRequirementMetric(governed));
  if ((value.state === "answered" || "source" in value || "confirmedByUser" in value)
    && (!['user', 'migration', 'agent_proposed'].includes(String(value.source)) || typeof value.confirmedByUser !== "boolean")) errors.push("metric provenance invalid");
  return errors;
}

function validateWorkloadEntity(value: unknown, selectorId: string): string[] {
  if (!isRecord(value)) return ["workload value must be an object"];
  if (value.state === "deferred" || value.state === "not_applicable") {
    const errors = !exactFields(value, ["workloadId", "metrics", "state", "source", "confirmedByUser"])
      ? [`${value.state} workload must not contain answered fields`]
      : [];
    if (value.workloadId !== selectorId || !isNonEmptyString(value.workloadId)) errors.push("workload selector id must equal workloadId");
    if (!Array.isArray(value.metrics) || value.metrics.length !== 0) errors.push("unanswered workload metrics must be empty");
    if (!["user", "defaulted", "agent_proposed"].includes(String(value.source)) || typeof value.confirmedByUser !== "boolean") errors.push("workload provenance invalid");
    return errors;
  }
  if (value.state !== undefined && value.state !== "answered") return ["workload state invalid"];
  const fields = value.state === "answered"
    ? ["workloadId", "state", "name", "metrics", "evidenceOrBenchmarkRefs", "source", "confirmedByUser"]
    : ["workloadId", "name", "metrics", "evidenceOrBenchmarkRefs"];
  const errors = !exactFields(value, fields) ? ["workload value contains unknown fields"] : [];
  if (value.workloadId !== selectorId || !isNonEmptyString(value.name) || !Array.isArray(value.metrics)) errors.push("workload identity/name/metrics invalid");
  else {
    const metricIds: string[] = [];
    value.metrics.forEach((metric, index) => {
      const id = isRecord(metric) && isNonEmptyString(metric.metricId) ? metric.metricId : "";
      if (id) metricIds.push(id);
      errors.push(...validateMetricEntity(metric, id).map((error) => `metrics.${index}: ${error}`));
    });
    if (new Set(metricIds).size !== metricIds.length) errors.push("workload metricId must be unique for stable selection");
  }
  if (value.evidenceOrBenchmarkRefs !== undefined && !stringArray(value.evidenceOrBenchmarkRefs)) errors.push("workload evidence refs invalid");
  if (value.state === "answered"
    && (!["user", "defaulted", "agent_proposed"].includes(String(value.source)) || typeof value.confirmedByUser !== "boolean")) errors.push("workload provenance invalid");
  return errors;
}

function validateConstraintEntity(value: unknown, selectorId: string): string[] {
  if (!isRecord(value)) return ["constraint value must be an object"];
  if (value.state === "deferred" || value.state === "not_applicable") {
    const errors = !exactFields(value, ["constraintId", "state", "source", "confirmedByUser"])
      ? [`${value.state} constraint must not contain answered fields`]
      : [];
    if (value.constraintId !== selectorId || !isNonEmptyString(value.constraintId)) errors.push("constraint selector id must equal constraintId");
    if (!["user", "migration", "agent_proposed"].includes(String(value.source)) || typeof value.confirmedByUser !== "boolean") errors.push("constraint provenance invalid");
    return errors;
  }
  if (value.state !== undefined && value.state !== "answered") return ["constraint state invalid"];
  const fields = value.state === "answered"
    ? ["constraintId", "state", "predicate", "strength", "source", "confirmedByUser"]
    : ["constraintId", "predicate", "strength", "source", "confirmedByUser"];
  const errors = !exactFields(value, fields) ? ["constraint value contains unknown fields"] : [];
  if (value.constraintId !== selectorId) errors.push("constraint selector id must equal constraintId");
  errors.push(...validateFacetPredicate(value.predicate).map((error) => `constraint predicate: ${error}`));
  if (!["hard", "soft"].includes(String(value.strength)) || !["user", "migration", "agent_proposed"].includes(String(value.source)) || typeof value.confirmedByUser !== "boolean") errors.push("constraint strength/provenance invalid");
  return errors;
}

function validateRequirementSpecPatchValue(value: unknown): string[] {
  if (value === null) return [];
  if (!isRecord(value)) return ["requirementSpec value must be an object or null"];
  const errors = !exactFields(value, ["requirementSpecId", "schemaVersion", "budget", "workloads", "constraints", "horizonYears"]) ? ["requirementSpec contains derived or unknown fields"] : [];
  if (!isNonEmptyString(value.requirementSpecId) || value.schemaVersion !== "1.0.0") errors.push("requirementSpec identity/schema invalid");
  if (value.budget !== undefined) errors.push(...validateDraft(value.budget, "budget").map((error) => `budget: ${error}`));
  if (value.horizonYears !== undefined) errors.push(...validateDraft(value.horizonYears, "horizon").map((error) => `horizonYears: ${error}`));
  if (!Array.isArray(value.workloads)) errors.push("requirementSpec workloads invalid");
  else {
    const workloadIds: string[] = [];
    value.workloads.forEach((workload, index) => {
      const id = isRecord(workload) && isNonEmptyString(workload.workloadId) ? workload.workloadId : "";
      if (id) workloadIds.push(id);
      errors.push(...validateWorkloadEntity(workload, id).map((error) => `workloads.${index}: ${error}`));
    });
    if (new Set(workloadIds).size !== workloadIds.length) errors.push("requirementSpec workloadId must be unique");
  }
  if (!Array.isArray(value.constraints)) errors.push("requirementSpec constraints invalid");
  else {
    const constraintIds: string[] = [];
    value.constraints.forEach((constraint, index) => {
      const id = isRecord(constraint) && isNonEmptyString(constraint.constraintId) ? constraint.constraintId : "";
      if (id) constraintIds.push(id);
      errors.push(...validateConstraintEntity(constraint, id).map((error) => `constraints.${index}: ${error}`));
    });
    if (new Set(constraintIds).size !== constraintIds.length) errors.push("requirementSpec constraintId must be unique");
  }
  return errors;
}

function validateSystemSelection(value: unknown): string[] {
  if (value === null) return [];
  if (!isRecord(value) || !exactFields(value, ["profileId", "versionFactId", "source", "lockedByUser"])) return ["system selection contains unknown fields or is not an object"];
  const errors: string[] = [];
  if (!isSystemProfileId(value.profileId) || !isNonEmptyString(value.versionFactId)) errors.push("system selection profile/version fact invalid");
  if (!["defaulted", "user"].includes(String(value.source)) || typeof value.lockedByUser !== "boolean") errors.push("system selection provenance/lock invalid");
  return errors;
}

function validateEndpoint(value: unknown): boolean {
  return isRecord(value) && exactFields(value, ["instanceId", "portId"])
    && isNonEmptyString(value.instanceId) && isNonEmptyString(value.portId);
}

function validateFirmwareSettings(value: unknown): string[] {
  if (!Array.isArray(value)) return ["requestedSettings must be an array"];
  const errors: string[] = [];
  const ids: string[] = [];
  value.forEach((setting, index) => {
    if (!isRecord(setting) || !exactFields(setting, ["settingId", "desiredValue"])) errors.push(`requestedSettings.${index} invalid`);
    else {
      if (isNonEmptyString(setting.settingId)) ids.push(setting.settingId);
      errors.push(...validateFirmwareSettingValue(setting.settingId, setting.desiredValue).map((error) => `requestedSettings.${index}: ${error}`));
    }
  });
  if (new Set(ids).size !== ids.length) errors.push("requestedSettings settingId must be unique");
  return errors;
}

function validateAddedEntity(collection: Exclude<TopologyV3PatchCollection, "config">, selector: TopologyV3PatchSelector, value: unknown): string[] {
  if (!isRecord(value)) return [`${collection} add value must be an object`];
  const idField = TOPOLOGY_V3_PATCH_COLLECTION_REGISTRY[collection].idField;
  const errors: string[] = value[idField] === selector.id ? [] : [`${collection} selector id must equal ${idField}`];
  if (collection === "components") {
    if (!exactFields(value, ["instanceId", "kind", "role", "state", "identity", "source"])) errors.push("component contains derived or unknown fields");
    if (!isComponentKindId(value.kind) || !isNonEmptyString(value.role) || !["planned", "ordered"].includes(String(value.state)) || !["user", "agent", "migration"].includes(String(value.source))) errors.push("component kind/role/state/source invalid");
    errors.push(...validateIdentity(value.identity));
  } else if (collection === "roleDecisions") {
    if (!exactFields(value, ["roleDecisionId", "role", "decision", "source", "confirmedAt"]) || !isNonEmptyString(value.role) || value.decision !== "not_needed" || !["user", "migration"].includes(String(value.source)) || !isNonEmptyString(value.confirmedAt)) errors.push("role decision invalid or contains unknown fields");
  } else if (collection === "placements") {
    if (!exactFields(value, ["placementId", "componentInstanceId", "mountOwnerInstanceId", "mountId"]) || !isNonEmptyString(value.componentInstanceId) || !isNonEmptyString(value.mountOwnerInstanceId) || !isNonEmptyString(value.mountId)) errors.push("placement invalid or contains unknown fields");
  } else if (collection === "connections") {
    if (!exactFields(value, ["connectionId", "from", "to", "cableInstanceId", "status"]) || !validateEndpoint(value.from) || !validateEndpoint(value.to) || (value.cableInstanceId !== undefined && !isNonEmptyString(value.cableInstanceId)) || !["required", "planned", "satisfied", "blocked"].includes(String(value.status))) errors.push("connection invalid or contains unknown fields");
  } else if (collection === "logicalLayouts") {
    if (!exactFields(value, ["layoutId", "bootPoolDiskIds", "vdevs", "spareDiskIds"]) || !stringArray(value.bootPoolDiskIds) || !Array.isArray(value.vdevs) || !stringArray(value.spareDiskIds)) errors.push("logical layout invalid or contains unknown fields");
    else {
      const vdevIds: string[] = [];
      const assignedDiskIds = [...value.bootPoolDiskIds, ...value.spareDiskIds];
      value.vdevs.forEach((vdev, index) => {
        const id = isRecord(vdev) && isNonEmptyString(vdev.vdevId) ? vdev.vdevId : "";
        if (id) vdevIds.push(id);
        if (isRecord(vdev) && Array.isArray(vdev.diskInstanceIds)) assignedDiskIds.push(...vdev.diskInstanceIds);
        errors.push(...validateAddedEntity("vdevs", { collection: "vdevs", parentId: String(selector.id), id }, vdev).map((error) => `vdevs.${index}: ${error}`));
      });
      if (new Set(vdevIds).size !== vdevIds.length) errors.push("logical layout vdevId must be unique");
      if (new Set(assignedDiskIds).size !== assignedDiskIds.length) errors.push("logical layout cannot assign one disk more than once");
    }
  } else if (collection === "vdevs") {
    if (!exactFields(value, ["vdevId", "topology", "diskInstanceIds"]) || !["mirror", "raidz1", "raidz2", "raidz3", "stripe"].includes(String(value.topology)) || !stringArray(value.diskInstanceIds, true)) errors.push("vdev invalid or contains unknown fields");
  } else if (collection === "firmwareTargets") {
    if (!exactFields(value, ["instanceId", "targetReleaseFactId", "requestedSettings", "source"]) || !isNonEmptyString(value.targetReleaseFactId) || !["user", "system_requirement"].includes(String(value.source))) errors.push("firmware target invalid or contains unknown fields");
    errors.push(...validateFirmwareSettings(value.requestedSettings));
  } else if (collection === "workloads") errors.push(...validateWorkloadEntity(value, String(selector.id)));
  else if (collection === "metrics") errors.push(...validateMetricEntity(value, String(selector.id)));
  else if (collection === "constraints") errors.push(...validateConstraintEntity(value, String(selector.id)));
  return errors;
}

function validateReplacementValue(selector: TopologyV3PatchSelector, value: unknown): string[] {
  if (selector.collection === "config") {
    if (selector.field === "name") return isNonEmptyString(value) ? [] : ["config name must be a non-empty string"];
    if (selector.field === "intent") return value === null ? [] : validateDraft(value, "intent");
    if (selector.field === "requirementSpec") return validateRequirementSpecPatchValue(value);
    if (selector.field === "requirementBudget") return validateDraft(value, "budget");
    if (selector.field === "requirementHorizonYears") return validateDraft(value, "horizon");
    if (selector.field === "system") return validateSystemSelection(value);
    if (selector.field === "notes") return Array.isArray(value) && value.every((note) => typeof note === "string") ? [] : ["notes must be a string array"];
  }
  if (selector.collection === "components") {
    if (selector.field === "kind") return isComponentKindId(value) ? [] : ["component kind is not allowlisted"];
    if (selector.field === "role") return isNonEmptyString(value) ? [] : ["component role invalid"];
    if (selector.field === "state") return value === "planned" || value === "ordered" ? [] : ["component state invalid"];
    if (selector.field === "identity") return validateIdentity(value);
  }
  if (selector.collection === "placements") return isNonEmptyString(value) ? [] : ["placement reference invalid"];
  if (selector.collection === "connections") {
    if (selector.field === "from" || selector.field === "to") return validateEndpoint(value) ? [] : ["connection endpoint invalid"];
    if (selector.field === "cableInstanceId") return value === null || isNonEmptyString(value) ? [] : ["connection cableInstanceId invalid"];
    if (selector.field === "status") return ["required", "planned", "satisfied", "blocked"].includes(String(value)) ? [] : ["connection status invalid"];
  }
  if (selector.collection === "logicalLayouts") return stringArray(value) ? [] : ["logical layout disk IDs invalid"];
  if (selector.collection === "vdevs") {
    if (selector.field === "topology") return ["mirror", "raidz1", "raidz2", "raidz3", "stripe"].includes(String(value)) ? [] : ["vdev topology invalid"];
    if (selector.field === "diskInstanceIds") return stringArray(value, true) ? [] : ["vdev diskInstanceIds invalid"];
  }
  if (selector.collection === "firmwareTargets") {
    if (selector.field === "targetReleaseFactId") return isNonEmptyString(value) ? [] : ["firmware target release fact invalid"];
    if (selector.field === "requestedSettings") return validateFirmwareSettings(value);
  }
  if (selector.collection === "workloads") {
    if (selector.field === "name") return isNonEmptyString(value) ? [] : ["workload name invalid"];
    if (selector.field === "evidenceOrBenchmarkRefs") return stringArray(value) ? [] : ["workload evidence refs invalid"];
  }
  return ["replacement value has no governed schema"];
}

function validateTopologyV3PatchOperation(value: unknown, context: PatchValidationContext): string[] {
  if (!isRecord(value)) return ["patch operation must be an object"];
  const errors: string[] = [];
  const operationFields = value.op === "remove" ? ["op", "selector"] : ["op", "selector", "value"];
  if (!exactFields(value, operationFields)) errors.push("patch operation contains unknown fields");
  if (!["add", "replace", "remove"].includes(String(value.op))) errors.push("patch operation op is not allowlisted");
  if (!isRecord(value.selector) || !exactFields(value.selector, ["collection", "id", "parentId", "field"]) || !hasOwn(TOPOLOGY_V3_PATCH_COLLECTION_REGISTRY, value.selector.collection)) {
    errors.push("plan-v3 patch selector invalid or not allowlisted");
    return errors;
  }
  const selector = value.selector as unknown as TopologyV3PatchSelector;
  const rule = TOPOLOGY_V3_PATCH_COLLECTION_REGISTRY[selector.collection];
  if (selector.collection === "config") {
    if (selector.id !== undefined || selector.parentId !== undefined || !isNonEmptyString(selector.field) || !(rule.mutableFields as readonly string[]).includes(selector.field) || value.op !== "replace") errors.push("config selector requires a governed field and replace operation");
  } else {
    if (!isNonEmptyString(selector.id)) errors.push("collection selector requires a stable non-empty id");
    if (rule.parentCollection === null ? selector.parentId !== undefined : !isNonEmptyString(selector.parentId)) errors.push("collection selector parentId invalid");
    if (value.op === "replace") {
      if (!isNonEmptyString(selector.field) || !(rule.mutableFields as readonly string[]).includes(selector.field)) errors.push("replace selector field is not allowlisted");
    } else if (selector.field !== undefined) errors.push("add/remove selectors cannot address a mutable field");
  }
  if ((value.op === "add" || value.op === "replace") && !("value" in value)) errors.push("patch operation value missing");
  if (value.op === "remove" && "value" in value) errors.push("remove patch operation cannot contain value");
  if (errors.length === 0 && value.op === "add" && selector.collection !== "config") errors.push(...validateAddedEntity(selector.collection, selector, value.value));
  if (errors.length === 0 && value.op === "replace") errors.push(...validateReplacementValue(selector, value.value));
  if (context.actor !== "user" && containsForbiddenActorAssertion(value.value)) errors.push(`${context.actor} patch cannot assert user source, confirmation, confirmedAt or lockedByUser`);
  if (context.actor !== "user" && selector.collection === "roleDecisions") errors.push(`${context.actor} patch cannot mutate user-only role decisions`);
  return errors;
}

function validateSimulationPatchValue(operation: Record<string, unknown>): string[] {
  if (typeof operation.path !== "string" || operation.op === "remove") return [];
  const path = operation.path;
  const value = operation.value;
  if (path === "/ambientC") return isRecord(value) && exactFields(value, ["min", "max"]) && Number.isFinite(value.min) && Number.isFinite(value.max) && Number(value.min) <= Number(value.max) ? [] : ["simulation ambientC value invalid"];
  if (path === "/ambientC/min" || path === "/ambientC/max") return typeof value === "number" && Number.isFinite(value) ? [] : ["simulation temperature value invalid"];
  if (path === "/fanPolicyId" || path === "/modelVersion") return isNonEmptyString(value) ? [] : ["simulation string value invalid"];
  if (/^\/(?:workloadMetricRefs|placementIds|routeIds)(?:\/\d+|\/-)?$/.test(path)) return path.split("/").length === 2 ? stringArray(value) ? [] : ["simulation ID list invalid"] : isNonEmptyString(value) ? [] : ["simulation ID value invalid"];
  if (path === "/storageActivity") return Array.isArray(value) ? value.flatMap((item) => validateSimulationPatchValue({ op: "add", path: "/storageActivity/-", value: item })) : ["simulation storageActivity must be an array"];
  if (/^\/storageActivity\/(?:\d+|-)$/.test(path)) return isRecord(value) && exactFields(value, ["logicalLayoutId", "dutyCycle", "concurrentDiskCount"]) && isNonEmptyString(value.logicalLayoutId) && typeof value.dutyCycle === "number" && Number.isFinite(value.dutyCycle) && value.dutyCycle >= 0 && value.dutyCycle <= 1 && Number.isInteger(value.concurrentDiskCount) && Number(value.concurrentDiskCount) >= 0 && (value.dutyCycle === 0 || Number(value.concurrentDiskCount) > 0) ? [] : ["simulation storage activity invalid"];
  if (/\/logicalLayoutId$/.test(path)) return isNonEmptyString(value) ? [] : ["simulation logicalLayoutId invalid"];
  if (/\/dutyCycle$/.test(path)) return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? [] : ["simulation dutyCycle invalid"];
  if (/\/concurrentDiskCount$/.test(path)) return Number.isInteger(value) && Number(value) >= 0 ? [] : ["simulation concurrentDiskCount invalid"];
  return [];
}

export function validateGovernedPatchOperation(target: GovernedPatchTarget, value: unknown, context: PatchValidationContext = { actor: "user" }): string[] {
  if (target === "plan-v3") return validateTopologyV3PatchOperation(value, context);
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["patch operation must be an object"];
  const operation = value as Record<string, unknown>;
  const errors: string[] = [];
  const allowedKeys = operation.op === "remove" ? ["op", "path"] : ["op", "path", "value"];
  if (Object.keys(operation).some((key) => !allowedKeys.includes(key))) errors.push("patch operation contains unknown fields");
  if (operation.op !== "add" && operation.op !== "replace" && operation.op !== "remove") errors.push("patch operation op is not allowlisted");
  if (!isAllowedJsonPatchPath(target, operation.path)) errors.push(`${target} patch path is not allowlisted`);
  if (typeof operation.path === "string" && operation.path.endsWith("/-") && operation.op !== "add") {
    errors.push("array append path is only allowed for add operations");
  }
  if ((operation.op === "add" || operation.op === "replace") && !("value" in operation)) errors.push("patch operation value missing");
  if (operation.op === "remove" && "value" in operation) errors.push("remove patch operation cannot contain value");
  if (target === "simulation" && typeof operation.path === "string") {
    const arrayMemberPath = /^\/(?:workloadMetricRefs|placementIds|routeIds|storageActivity)\/(?:0|[1-9]\d*|-)$/;
    if (operation.op === "add" && !arrayMemberPath.test(operation.path)) errors.push("simulation add is only allowed for array members");
    if (operation.op === "remove" && (!arrayMemberPath.test(operation.path) || operation.path.endsWith("/-"))) errors.push("simulation remove is only allowed for existing array members");
    if (errors.length === 0) errors.push(...validateSimulationPatchValue(operation));
  }
  return errors;
}

/** Builds an explicit hash policy rule from one governed unit dimension. */
export function governedUnitRule(path: string, canonicalUnitId: UnitId): UnitNormalizationRule {
  assertUnitId(canonicalUnitId);
  const canonical = UNIT_REGISTRY[canonicalUnitId];
  if (canonical.canonicalUnitId !== canonicalUnitId) throw new TypeError(`${canonicalUnitId} is not a canonical unit`);
  const conversions = Object.fromEntries(
    Object.entries(UNIT_REGISTRY)
      .filter(([, definition]) => definition.dimension === canonical.dimension)
      .map(([unitId, definition]) => [unitId, { scale: definition.scale }]),
  );
  return deepFreeze({ path, canonicalUnitId, conversions });
}
