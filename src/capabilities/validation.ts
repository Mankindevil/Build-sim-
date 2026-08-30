export function safeRecord(value: unknown): Record<string, unknown> | null {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  try {
    return Object.keys(value).every((key) => allowed.includes(key));
  } catch {
    return false;
  }
}

export function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  try {
    const keys = Object.keys(value);
    return required.every((key) => keys.includes(key))
      && keys.every((key) => required.includes(key) || optional.includes(key));
  } catch {
    return false;
  }
}

export function isNfcText(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string"
    && (allowEmpty || value.length > 0)
    && value === value.normalize("NFC")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function isPortableId(value: unknown): value is string {
  return isNfcText(value) && value.length <= 256 && !/\s/u.test(value);
}

export function isAsciiToken(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u.test(value)
    && value === value.normalize("NFC");
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function isPositiveSafeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum;
}

export function isNonNegativeSafeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

export function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isUniquePortableIdArray(value: unknown, requireNonEmpty = true): value is string[] {
  return Array.isArray(value)
    && (!requireNonEmpty || value.length > 0)
    && value.every(isPortableId)
    && new Set(value).size === value.length;
}

export function containsNonNfcText(value: unknown): boolean {
  const seen = new Set<object>();
  const visit = (candidate: unknown): boolean => {
    if (typeof candidate === "string") return candidate !== candidate.normalize("NFC");
    if (candidate === null || typeof candidate !== "object") return false;
    try {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      if (Array.isArray(candidate)) return candidate.some(visit);
      return Object.entries(candidate as Record<string, unknown>)
        .some(([key, child]) => key !== key.normalize("NFC") || visit(child));
    } catch {
      return true;
    }
  };
  return visit(value);
}

export function normalizeNfcJson<T>(value: T): T {
  const visit = (candidate: unknown): unknown => {
    if (typeof candidate === "string") return candidate.normalize("NFC");
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (candidate !== null && typeof candidate === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
        if (child !== undefined) result[key.normalize("NFC")] = visit(child);
      }
      return result;
    }
    return candidate;
  };
  return visit(value) as T;
}

export function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sameSnapshotRef(
  left: { snapshotId: string; contentHash: string },
  right: { snapshotId: string; contentHash: string },
): boolean {
  return left.snapshotId === right.snapshotId && left.contentHash === right.contentHash;
}

export function validateFactSnapshotRef(value: unknown): string[] {
  const record = safeRecord(value);
  if (!record) return ["factSnapshotRef must be an object"];
  const errors: string[] = [];
  if (!hasExactKeys(record, ["snapshotId", "contentHash"])) errors.push("factSnapshotRef contains unknown or missing fields");
  if (!isSha256(record.contentHash)
    || record.snapshotId !== `fact-snapshot-sha256-${String(record.contentHash)}`) errors.push("factSnapshotRef identity/hash invalid");
  return errors;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value as Readonly<T>;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value as Readonly<T>;
}
