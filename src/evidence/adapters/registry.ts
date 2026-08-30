import type { EvidencePipelineSubject } from "../jobs/contracts";
import {
  EVIDENCE_EXTRACTION_ADAPTER_SCHEMA_VERSION,
  createEvidenceExtractionAdapterManifest,
  deepFreeze,
  type ConfirmableOfficialPageKind,
  type EvidenceAdapterDecoderId,
  type EvidenceExtractionAdapterManifest,
  type EvidenceExtractionAdapterManifestMaterial,
  type EvidenceExtractionRule,
} from "./contracts";

interface RuleSeed {
  readonly id: string;
  readonly field: string;
  readonly label: string;
  readonly decoder: EvidenceAdapterDecoderId;
  readonly unit?: string;
}

interface AdapterSeed {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly brandId: string;
  readonly brandAliases: readonly string[];
  readonly categoryIds: readonly string[];
  readonly officialHosts: readonly string[];
  readonly pageKind: ConfirmableOfficialPageKind;
  readonly rules: readonly RuleSeed[];
}

const SEED_VALUES: AdapterSeed[] = [
  {
    adapterId: "evidence.adapter.asus.motherboard",
    adapterVersion: "1.0.0",
    brandId: "asus",
    brandAliases: ["ASUS"],
    categoryIds: ["motherboard"],
    officialHosts: ["www.asus.com"],
    pageKind: "manual",
    rules: [
      { id: "asus-bios-upgrade", field: "firmware.upgrade_method", label: "BIOS Upgrade Methods:", decoder: "string_set" },
      { id: "asus-cpu-socket", field: "motherboard.cpu_socket", label: "CPU Socket:", decoder: "token" },
      { id: "asus-cpu-support", field: "firmware.cpu_support", label: "CPU Support:", decoder: "firmware_cpu_support" },
      { id: "asus-fan-curve", field: "thermal.fan_curve", label: "Fan Curve:", decoder: "fan_curve" },
      { id: "asus-fastener-count", field: "package.fastener_count", label: "Fastener Count:", decoder: "fastener_count" },
      { id: "asus-port-topology", field: "io.port_topology", label: "Port Topology:", decoder: "port_topology" },
      { id: "asus-qvl-entry", field: "compatibility.qvl_entry", label: "QVL Entry:", decoder: "qvl_entry" },
      { id: "asus-tool-required", field: "package.tool_required", label: "Tool Required:", decoder: "tool_required" },
    ],
  },
  {
    adapterId: "evidence.adapter.broadcom.hba",
    adapterVersion: "1.0.0",
    brandId: "broadcom",
    brandAliases: ["Broadcom"],
    categoryIds: ["hba"],
    officialHosts: ["www.broadcom.com"],
    pageKind: "support",
    rules: [
      { id: "broadcom-firmware-upgrade", field: "firmware.upgrade_method", label: "Firmware Upgrade Methods:", decoder: "string_set" },
      { id: "broadcom-hba-mode", field: "hba.mode", label: "HBA Mode:", decoder: "token" },
      { id: "broadcom-port-topology", field: "io.port_topology", label: "Port Topology:", decoder: "port_topology" },
    ],
  },
  {
    adapterId: "evidence.adapter.corsair.cooler",
    adapterVersion: "1.0.0",
    brandId: "corsair",
    brandAliases: ["Corsair"],
    categoryIds: ["cooler"],
    officialHosts: ["www.corsair.com"],
    pageKind: "manual",
    rules: [
      { id: "corsair-fan-curve", field: "thermal.fan_curve", label: "Fan Curve:", decoder: "fan_curve" },
      { id: "corsair-fan-mounts", field: "cooling.fan_mounts", label: "Fan Mounts:", decoder: "string_set" },
      { id: "corsair-fastener-count", field: "package.fastener_count", label: "Fastener Count:", decoder: "fastener_count" },
      { id: "corsair-package-contents", field: "package.contents", label: "Package Contents:", decoder: "string_set" },
      { id: "corsair-tool-required", field: "package.tool_required", label: "Tool Required:", decoder: "tool_required" },
    ],
  },
  {
    adapterId: "evidence.adapter.intel.cpu",
    adapterVersion: "1.0.0",
    brandId: "intel",
    brandAliases: ["Intel"],
    categoryIds: ["cpu"],
    officialHosts: ["www.intel.com"],
    pageKind: "technical_specification",
    rules: [
      { id: "intel-cpu-socket", field: "cpu.socket", label: "CPU Socket:", decoder: "token" },
      { id: "intel-package-contents", field: "package.contents", label: "Package Contents:", decoder: "string_set" },
      { id: "intel-turbo-power", field: "power.load", label: "Maximum Turbo Power:", decoder: "number", unit: "w" },
    ],
  },
  {
    adapterId: "evidence.adapter.samsung.storage",
    adapterVersion: "1.0.0",
    brandId: "samsung",
    brandAliases: ["Samsung"],
    categoryIds: ["storage"],
    officialHosts: ["semiconductor.samsung.com"],
    pageKind: "technical_specification",
    rules: [
      { id: "samsung-endurance", field: "storage.endurance_tbw", label: "Endurance TBW:", decoder: "number", unit: "tbw" },
      { id: "samsung-interface", field: "storage.interface", label: "Storage Interface:", decoder: "token" },
      { id: "samsung-logical-sector", field: "storage.logical_sector_size", label: "Logical Sector Size:", decoder: "number", unit: "byte" },
      { id: "samsung-physical-sector", field: "storage.physical_sector_size", label: "Physical Sector Size:", decoder: "number", unit: "byte" },
      { id: "samsung-recording", field: "storage.recording_technology", label: "Recording Technology:", decoder: "token" },
    ],
  },
  {
    adapterId: "evidence.adapter.seagate.storage",
    adapterVersion: "1.0.0",
    brandId: "seagate",
    brandAliases: ["Seagate"],
    categoryIds: ["storage"],
    officialHosts: ["www.seagate.com"],
    pageKind: "technical_specification",
    rules: [
      { id: "seagate-interface", field: "storage.interface", label: "Storage Interface:", decoder: "token" },
      { id: "seagate-logical-sector", field: "storage.logical_sector_size", label: "Logical Sector Size:", decoder: "number", unit: "byte" },
      { id: "seagate-physical-sector", field: "storage.physical_sector_size", label: "Physical Sector Size:", decoder: "number", unit: "byte" },
      { id: "seagate-recording", field: "storage.recording_technology", label: "Recording Technology:", decoder: "token" },
    ],
  },
  {
    adapterId: "evidence.adapter.seasonic.psu",
    adapterVersion: "1.0.0",
    brandId: "seasonic",
    brandAliases: ["Seasonic"],
    categoryIds: ["psu"],
    officialHosts: ["seasonic.com"],
    pageKind: "manual",
    rules: [
      { id: "seasonic-cable-count", field: "package.cable_count", label: "Cable Count:", decoder: "cable_count" },
      { id: "seasonic-cable-families", field: "power.cable_families", label: "Cable Families:", decoder: "string_set" },
      { id: "seasonic-capacity", field: "psu.capacity", label: "PSU Capacity:", decoder: "number", unit: "w" },
      { id: "seasonic-connectors", field: "psu.connectors", label: "PSU Connectors:", decoder: "string_set" },
      { id: "seasonic-pinout", field: "psu.pinout", label: "PSU Pinout:", decoder: "psu_pinout" },
    ],
  },
  {
    adapterId: "evidence.adapter.truenas.system",
    adapterVersion: "1.0.0",
    brandId: "truenas",
    brandAliases: ["TrueNAS"],
    categoryIds: ["system"],
    officialHosts: ["www.truenas.com"],
    pageKind: "support",
    rules: [
      { id: "truenas-system-requirement", field: "system.requirement", label: "System Requirement:", decoder: "system_requirement" },
    ],
  },
];

const SEEDS: readonly AdapterSeed[] = deepFreeze(SEED_VALUES.sort((left, right) => left.adapterId.localeCompare(right.adapterId)));

function material(seed: AdapterSeed): EvidenceExtractionAdapterManifestMaterial {
  const rules: EvidenceExtractionRule[] = seed.rules.map((rule) => ({
    ruleId: rule.id,
    fieldId: rule.field,
    label: rule.label,
    decoder: rule.decoder,
    ...(rule.unit === undefined ? {} : { unit: rule.unit }),
  })).sort((left, right) => left.ruleId.localeCompare(right.ruleId));
  return {
    schemaVersion: EVIDENCE_EXTRACTION_ADAPTER_SCHEMA_VERSION,
    adapterId: seed.adapterId,
    adapterVersion: seed.adapterVersion,
    brandId: seed.brandId,
    brandAliases: Object.freeze([...seed.brandAliases].sort()),
    categoryIds: Object.freeze([...seed.categoryIds].sort()),
    officialHosts: Object.freeze([...seed.officialHosts].sort()),
    pageKind: seed.pageKind,
    identityScope: "revision",
    supportedFieldIds: Object.freeze([...new Set(rules.map((rule) => rule.fieldId))].sort()),
    rules: Object.freeze(rules),
    approvalRequired: true,
  };
}

let registryPromise: Promise<readonly EvidenceExtractionAdapterManifest[]> | null = null;

export function listEvidenceVendorAdapterManifests(): Promise<readonly EvidenceExtractionAdapterManifest[]> {
  registryPromise ??= Promise.all(SEEDS.map((seed) => createEvidenceExtractionAdapterManifest(material(seed))))
    .then((manifests) => deepFreeze(manifests.sort((left, right) => left.adapterId.localeCompare(right.adapterId))));
  return registryPromise;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export async function evidenceVendorAdapterForSubject(
  subject: EvidencePipelineSubject,
): Promise<EvidenceExtractionAdapterManifest | null> {
  const brand = normalized(subject.brand);
  const category = normalized(subject.category);
  const matches = (await listEvidenceVendorAdapterManifests()).filter((manifest) => (
    normalized(manifest.brandId) === brand || manifest.brandAliases.some((alias) => normalized(alias) === brand)
  ) && manifest.categoryIds.some((item) => normalized(item) === category));
  return matches.length === 1 ? matches[0]! : null;
}

export async function vendorAdapterSearchQueries(
  subject: EvidencePipelineSubject,
  requestedFieldIds: readonly string[],
): Promise<readonly string[]> {
  const manifest = await evidenceVendorAdapterForSubject(subject);
  if (!manifest) return Object.freeze([`${subject.brand} ${subject.modelId ?? subject.skuId}`.slice(0, 160)]);
  const requested = new Set(requestedFieldIds);
  return Object.freeze([
    "Product Model",
    ...manifest.rules.filter((rule) => requested.has(rule.fieldId)).map((rule) => rule.label.slice(0, -1)),
  ].slice(0, 32));
}
