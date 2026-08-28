import { legacyCanonicalize, legacySha256Hex } from "../hash";
import type { BuildConfigDocument } from "../config/types";
import { configV3Hash } from "../topology/hash";

/** @deprecated New persisted contracts must use `hashContent` with a domain and schema. */
export const canonicalJson = legacyCanonicalize;

/** @deprecated Compatibility adapter for the pre-U0 unscoped hash API. */
export const sha256Hex = legacySha256Hex;

/** Preserve the V2 hash contract while using the governed V3 domain hash. */
export async function hashPlanConfig(config: BuildConfigDocument): Promise<string> {
  return config.schemaVersion === "3.0.0" ? configV3Hash(config) : sha256Hex(config);
}

export function deepReadonly<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) deepReadonly(item);
  return value;
}
