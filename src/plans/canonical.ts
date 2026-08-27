import { legacyCanonicalize, legacySha256Hex } from "../hash";

/** @deprecated New persisted contracts must use `hashContent` with a domain and schema. */
export const canonicalJson = legacyCanonicalize;

/** @deprecated Compatibility adapter for the pre-U0 unscoped hash API. */
export const sha256Hex = legacySha256Hex;

export function deepReadonly<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) deepReadonly(item);
  return value;
}
