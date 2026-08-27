import {
  validateHardwareAdapterManifest,
  type HardwareAdapterManifest,
} from "../contracts/registries";

/** Immutable, serializable adapter registry state used by evaluation replay. */
export interface AdapterSnapshot {
  schemaVersion: "adapter-snapshot-v1";
  snapshotId: string;
  adapters: HardwareAdapterManifest[];
  createdAt: string;
  contentHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validateAdapterSnapshotValue(value: unknown): string[] {
  if (!isRecord(value)) return ["adapter snapshot must be an object"];
  const errors: string[] = [];
  const fields = ["schemaVersion", "snapshotId", "adapters", "createdAt", "contentHash"];
  if (Object.keys(value).some((key) => !fields.includes(key))) errors.push("adapter snapshot contains unknown fields");
  if (value.schemaVersion !== "adapter-snapshot-v1") errors.push("adapter snapshot schemaVersion invalid");
  if (typeof value.snapshotId !== "string" || value.snapshotId.trim().length === 0) errors.push("adapter snapshot snapshotId invalid");
  if (!isIsoTimestamp(value.createdAt)) errors.push("adapter snapshot createdAt invalid");
  if (!isSha256Hex(value.contentHash)) errors.push("adapter snapshot contentHash invalid");
  if (!Array.isArray(value.adapters) || value.adapters.length === 0) {
    errors.push("adapter snapshot requires at least one registered manifest");
  } else {
    const adapterIds: string[] = [];
    value.adapters.forEach((adapter, index) => {
      if (isRecord(adapter) && typeof adapter.adapterId === "string") adapterIds.push(adapter.adapterId);
      errors.push(...validateHardwareAdapterManifest(adapter).map((error) => `adapter snapshot adapters.${index}: ${error}`));
    });
    if (new Set(adapterIds).size !== adapterIds.length) errors.push("adapter snapshot adapterId values must be unique");
  }
  return errors;
}

/** Bind every snapshot entry to the frozen serializable adapter registry. */
export function validateAdapterSnapshot(value: unknown): string[] {
  try {
    return validateAdapterSnapshotValue(value);
  } catch {
    return ["adapter snapshot validation failed"];
  }
}
