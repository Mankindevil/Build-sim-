import { hashContent } from "../hash";
import type { HardwareStandardRegistry } from "../standards/registry";
import type { CapabilityFactSnapshotRef } from "./facets";
import {
  compareCanonical,
  containsNonNfcText,
  deepFreeze,
  hasExactKeys,
  isNonNegativeSafeInteger,
  isPortableId,
  isPositiveSafeInteger,
  isSha256,
  isUniquePortableIdArray,
  normalizeNfcJson,
  safeRecord,
  validateFactSnapshotRef,
} from "./validation";

interface StorageCapabilityBase {
  subjectSkuId: string;
  factSnapshotRef: CapabilityFactSnapshotRef;
  failureDomainIds: string[];
  sourceFactIds: string[];
}

export interface StorageDriveCapabilityInput extends StorageCapabilityBase {
  schemaVersion: "storage-drive-capability-v1";
  interfaceStandardId: string;
  logicalSectorBytes: number;
  physicalSectorBytes: number;
  recordingTechnology: "cmr" | "smr" | "slc" | "mlc" | "tlc" | "qlc";
  trimSupported: boolean;
  enduranceTbw: number | null;
}

export interface StorageControllerCapabilityInput extends StorageCapabilityBase {
  schemaVersion: "storage-controller-capability-v1";
  supportedInterfaceStandardIds: string[];
  modes: Array<"hba_it" | "hba_ir" | "raid" | "ahci">;
  passthroughSupported: boolean;
  maximumDeviceCount: number;
}

export interface StorageBackplaneCapabilityInput extends StorageCapabilityBase {
  schemaVersion: "storage-backplane-capability-v1";
  upstreamStandardIds: string[];
  downstreamStandardIds: string[];
  bayCount: number;
  hotSwapSupported: boolean;
}

export type StorageCapabilityInput = StorageDriveCapabilityInput | StorageControllerCapabilityInput | StorageBackplaneCapabilityInput;
export type StorageCapability =
  | (StorageDriveCapabilityInput & { contentHash: string })
  | (StorageControllerCapabilityInput & { contentHash: string })
  | (StorageBackplaneCapabilityInput & { contentHash: string });

const CONTRACT = Object.freeze({ domain: "artifact.adapter-snapshot", schemaVersion: "1.0.0" } as const);
const RECORDING = new Set(["cmr", "smr", "slc", "mlc", "tlc", "qlc"]);
const MODES = new Set(["hba_it", "hba_ir", "raid", "ahci"]);

function powerOfTwoSector(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 512 && Number(value) <= 65_536
    && (Number(value) & (Number(value) - 1)) === 0;
}

function validateBase(value: Record<string, unknown>, requireHash: boolean): string[] {
  const errors: string[] = [];
  if (containsNonNfcText(value)) errors.push("storage capability contains non-NFC text");
  if (!isPortableId(value.subjectSkuId)) errors.push("storage capability subjectSkuId invalid");
  errors.push(...validateFactSnapshotRef(value.factSnapshotRef).map((error) => `storage capability ${error}`));
  if (!isUniquePortableIdArray(value.failureDomainIds)) errors.push(`storage ${String(value.schemaVersion).includes("backplane") ? "backplane" : "capability"} failureDomainIds invalid`);
  if (!isUniquePortableIdArray(value.sourceFactIds)) errors.push("storage capability sourceFactIds invalid");
  if (requireHash && !isSha256(value.contentHash)) errors.push("storage capability contentHash invalid");
  return errors;
}

function validateStorageCapabilityUnsafe(value: unknown, requireHash: boolean): string[] {
  const capability = safeRecord(value);
  if (!capability) return ["storage capability must be an object"];
  const common = ["schemaVersion", "subjectSkuId", "factSnapshotRef", "failureDomainIds", "sourceFactIds"];
  const optionalHash = requireHash ? ["contentHash"] : [];
  const errors = validateBase(capability, requireHash);
  if (capability.schemaVersion === "storage-drive-capability-v1") {
    const fields = [...common, "interfaceStandardId", "logicalSectorBytes", "physicalSectorBytes", "recordingTechnology", "trimSupported", "enduranceTbw"];
    if (!hasExactKeys(capability, fields, optionalHash) || (requireHash && !("contentHash" in capability))) errors.push("storage drive capability contains unknown fields");
    if (!isPortableId(capability.interfaceStandardId)) errors.push("storage drive interfaceStandardId invalid");
    if (!powerOfTwoSector(capability.logicalSectorBytes)) errors.push("storage drive logicalSectorBytes invalid");
    if (!powerOfTwoSector(capability.physicalSectorBytes)
      || (powerOfTwoSector(capability.logicalSectorBytes) && Number(capability.physicalSectorBytes) < Number(capability.logicalSectorBytes))) errors.push("storage drive physicalSectorBytes invalid");
    if (!RECORDING.has(String(capability.recordingTechnology))) errors.push("storage drive recordingTechnology invalid");
    if (typeof capability.trimSupported !== "boolean") errors.push("storage drive trimSupported invalid");
    if (capability.enduranceTbw !== null && (typeof capability.enduranceTbw !== "number" || !Number.isFinite(capability.enduranceTbw) || capability.enduranceTbw <= 0)) errors.push("storage drive enduranceTbw invalid");
    if ((capability.recordingTechnology === "cmr" || capability.recordingTechnology === "smr") && capability.enduranceTbw !== null) errors.push("magnetic drive enduranceTbw must be null");
  } else if (capability.schemaVersion === "storage-controller-capability-v1") {
    const fields = [...common, "supportedInterfaceStandardIds", "modes", "passthroughSupported", "maximumDeviceCount"];
    if (!hasExactKeys(capability, fields, optionalHash) || (requireHash && !("contentHash" in capability))) errors.push("storage controller capability contains unknown fields");
    if (!isUniquePortableIdArray(capability.supportedInterfaceStandardIds)) errors.push("storage controller supportedInterfaceStandardIds invalid");
    if (!isUniquePortableIdArray(capability.modes) || capability.modes.some((mode) => !MODES.has(mode))) errors.push("storage controller modes invalid");
    if (typeof capability.passthroughSupported !== "boolean") errors.push("storage controller passthroughSupported invalid");
    if (capability.passthroughSupported === true && (!Array.isArray(capability.modes) || !capability.modes.includes("hba_it"))) errors.push("storage controller passthrough requires hba_it mode");
    if (!isPositiveSafeInteger(capability.maximumDeviceCount, 65_536)) errors.push("storage controller maximumDeviceCount invalid");
  } else if (capability.schemaVersion === "storage-backplane-capability-v1") {
    const fields = [...common, "upstreamStandardIds", "downstreamStandardIds", "bayCount", "hotSwapSupported"];
    if (!hasExactKeys(capability, fields, optionalHash) || (requireHash && !("contentHash" in capability))) errors.push("storage backplane capability contains unknown fields");
    if (!isUniquePortableIdArray(capability.upstreamStandardIds)) errors.push("storage backplane upstreamStandardIds invalid");
    if (!isUniquePortableIdArray(capability.downstreamStandardIds)) errors.push("storage backplane downstreamStandardIds invalid");
    if (!isPositiveSafeInteger(capability.bayCount, 65_536)) errors.push("storage backplane bayCount invalid");
    if (typeof capability.hotSwapSupported !== "boolean") errors.push("storage backplane hotSwapSupported invalid");
  } else {
    errors.push("storage capability schemaVersion invalid");
  }
  return errors;
}

export function validateStorageCapabilityInput(value: unknown): string[] {
  try { return validateStorageCapabilityUnsafe(value, false); }
  catch { return ["storage capability input is inaccessible or invalid"]; }
}

export function validateStorageCapability(value: unknown): string[] {
  try { return validateStorageCapabilityUnsafe(value, true); }
  catch { return ["storage capability is inaccessible or invalid"]; }
}

function normalizeStorageCapability<T extends StorageCapabilityInput>(input: T): T {
  const normalized = normalizeNfcJson(input);
  normalized.failureDomainIds.sort(compareCanonical);
  normalized.sourceFactIds.sort(compareCanonical);
  if (normalized.schemaVersion === "storage-controller-capability-v1") {
    normalized.supportedInterfaceStandardIds.sort(compareCanonical);
    normalized.modes.sort(compareCanonical);
  } else if (normalized.schemaVersion === "storage-backplane-capability-v1") {
    normalized.upstreamStandardIds.sort(compareCanonical);
    normalized.downstreamStandardIds.sort(compareCanonical);
  }
  return normalized;
}

export async function storageCapabilityContentHash(value: StorageCapabilityInput | StorageCapability): Promise<string> {
  return hashContent(value, CONTRACT);
}

export async function createStorageCapability<T extends StorageCapabilityInput>(input: T): Promise<T & { contentHash: string }> {
  const normalized = normalizeStorageCapability(input);
  const errors = validateStorageCapabilityInput(normalized);
  if (errors.length) throw new TypeError(`Invalid storage capability: ${errors.join("; ")}`);
  const capability = { ...normalized, contentHash: await storageCapabilityContentHash(normalized) } as T & { contentHash: string };
  return deepFreeze(capability) as T & { contentHash: string };
}

export async function verifyStorageCapability(value: unknown): Promise<boolean> {
  if (validateStorageCapability(value).length) return false;
  const capability = value as StorageCapability;
  return capability.contentHash === await storageCapabilityContentHash(capability);
}

/** Consumption-time standard closure: unknown or wrong-family IDs fail closed. */
export async function validateStorageCapabilityAgainstStandards(
  capability: StorageCapability,
  standards: HardwareStandardRegistry,
): Promise<string[]> {
  if (!await verifyStorageCapability(capability)) return ["storage capability invalid or content hash mismatch"];
  const ids = capability.schemaVersion === "storage-drive-capability-v1"
    ? [capability.interfaceStandardId]
    : capability.schemaVersion === "storage-controller-capability-v1"
      ? capability.supportedInterfaceStandardIds
      : [...capability.upstreamStandardIds, ...capability.downstreamStandardIds];
  const errors: string[] = [];
  for (const id of ids) {
    const standard = standards.get(id);
    if (!standard) errors.push(`storage capability standard is unknown: ${id}`);
    else if (!(["pcie", "m2", "sata", "slimsas"] as const).includes(standard.family as "pcie" | "m2" | "sata" | "slimsas")) {
      errors.push(`storage capability standard has incompatible family: ${id}`);
    }
  }
  return errors;
}
