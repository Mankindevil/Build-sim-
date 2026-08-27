/** JSON values accepted by the Build Sim canonicalizer. */
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

/**
 * A JSON Pointer pattern. `*` matches one complete path segment.
 *
 * Arrays retain their input order unless their exact path matches `setPaths`.
 * This keeps list semantics distinct from explicitly governed set semantics.
 */
export type JsonPointerPattern = string;

export interface UnitConversion {
  /** `canonicalValue = value * scale + offset`. */
  readonly scale: number;
  readonly offset?: number;
}

export interface UnitNormalizationRule {
  /** Path of a `{ value: number, unitId: string }` quantity object. */
  readonly path: JsonPointerPattern;
  readonly canonicalUnitId: string;
  readonly conversions: Readonly<Record<string, UnitConversion>>;
}

export interface CanonicalizationPolicy {
  /** Paths whose array values have set semantics and are sorted by canonical representation. */
  readonly setPaths?: readonly JsonPointerPattern[];
  /** Object fields omitted before hashing, normally the object's own hash field. */
  readonly excludedPaths?: readonly JsonPointerPattern[];
  /** Explicit quantity paths and conversion tables; no unit is inferred from a field name. */
  readonly unitRules?: readonly UnitNormalizationRule[];
}

interface CompiledPattern {
  readonly source: string;
  readonly segments: readonly string[];
}

interface CanonicalContext {
  readonly sets: readonly CompiledPattern[];
  readonly exclusions: readonly CompiledPattern[];
  readonly units: readonly (UnitNormalizationRule & { readonly pattern: CompiledPattern })[];
  readonly ancestors: Set<object>;
}

function normalizeUnicode(value: string, label: string): string {
  const normalized = value.normalize("NFC");
  for (let index = 0; index < normalized.length; index += 1) {
    const codeUnit = normalized.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = normalized.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${label} must contain only Unicode scalar values`);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${label} must contain only Unicode scalar values`);
    }
  }
  return normalized;
}

function decodePointerSegment(segment: string, source: string): string {
  if (/~(?:[^01]|$)/.test(segment)) throw new TypeError(`Invalid JSON Pointer escape in ${source}`);
  return normalizeUnicode(segment.replace(/~1/g, "/").replace(/~0/g, "~"), `JSON Pointer segment in ${source}`);
}

function compilePattern(source: string): CompiledPattern {
  if (source === "") return { source, segments: [] };
  if (!source.startsWith("/")) throw new TypeError(`JSON Pointer pattern must start with '/': ${source}`);
  return { source, segments: source.slice(1).split("/").map((segment) => decodePointerSegment(segment, source)) };
}

function matches(pattern: CompiledPattern, path: readonly string[]): boolean {
  return pattern.segments.length === path.length
    && pattern.segments.every((segment, index) => segment === "*" || segment === path[index]);
}

function matching<T extends { readonly pattern: CompiledPattern }>(patterns: readonly T[], path: readonly string[]): T | undefined {
  return patterns.find((candidate) => matches(candidate.pattern, path));
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertFinite(value: number, label = "number"): void {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite JSON number`);
}

function transformUnit(
  input: Record<string, unknown>,
  rule: UnitNormalizationRule,
): Record<string, unknown> {
  if (typeof input.value !== "number" || typeof input.unitId !== "string") {
    throw new TypeError(`Unit-normalized value at ${rule.path} must contain numeric value and string unitId`);
  }
  assertFinite(input.value, `Unit-normalized value at ${rule.path}`);
  const conversion = rule.conversions[input.unitId];
  if (!conversion) throw new TypeError(`Unit ${input.unitId} is not allowed at ${rule.path}`);
  assertFinite(conversion.scale, `Unit scale for ${input.unitId}`);
  const offset = conversion.offset ?? 0;
  assertFinite(offset, `Unit offset for ${input.unitId}`);
  const canonicalValue = input.value * conversion.scale + offset;
  assertFinite(canonicalValue, `Canonical unit value at ${rule.path}`);
  return { ...input, value: Object.is(canonicalValue, -0) ? 0 : canonicalValue, unitId: normalizeUnicode(rule.canonicalUnitId, `Canonical unit ID at ${rule.path}`) };
}

function serialize(
  value: unknown,
  path: readonly string[],
  context: CanonicalContext,
  skipUnitAtCurrentPath = false,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(normalizeUnicode(value, `String at ${path.length ? `/${path.join("/")}` : "<root>"}`));
  if (typeof value === "number") {
    assertFinite(value);
    // JSON.stringify uses the ECMAScript number serialization required by JCS.
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Unsupported non-JSON value at ${path.length ? `/${path.join("/")}` : "<root>"}`);
  }
  if (context.ancestors.has(value)) throw new TypeError("Cannot canonicalize a cyclic value");

  if (!skipUnitAtCurrentPath && !Array.isArray(value) && isPlainRecord(value)) {
    const unitRule = matching(context.units, path);
    if (unitRule) return serialize(transformUnit(value, unitRule), path, context, true);
  }

  context.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new TypeError(`Canonical JSON arrays must be dense and contain no named properties at ${path.length ? `/${path.join("/")}` : "<root>"}`);
      }
      const items = value.map((item, index) => serialize(item, [...path, String(index)], context));
      if (context.sets.some((pattern) => matches(pattern, path))) {
        items.sort();
        for (let index = 1; index < items.length; index += 1) {
          if (items[index] === items[index - 1]) {
            throw new TypeError(`Duplicate member in canonical set at /${path.join("/")}`);
          }
        }
      }
      return `[${items.join(",")}]`;
    }

    if (!isPlainRecord(value)) {
      throw new TypeError(`Only plain JSON objects are supported at ${path.length ? `/${path.join("/")}` : "<root>"}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`Canonical JSON objects cannot contain symbol keys at ${path.length ? `/${path.join("/")}` : "<root>"}`);
    }

    const entries = new Map<string, unknown>();
    for (const [rawKey, item] of Object.entries(value)) {
      const key = normalizeUnicode(rawKey, `Object key at ${path.length ? `/${path.join("/")}` : "<root>"}`);
      const childPath = [...path, key];
      if (context.exclusions.some((pattern) => matches(pattern, childPath))) continue;
      if (entries.has(key)) throw new TypeError(`Object keys collide after NFC normalization at /${childPath.join("/")}`);
      entries.set(key, item);
    }
    return `{${[...entries]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item, [...path, key], context)}`)
      .join(",")}}`;
  } finally {
    context.ancestors.delete(value);
  }
}

function compilePolicy(policy: CanonicalizationPolicy): CanonicalContext {
  const sets = (policy.setPaths ?? []).map(compilePattern);
  const exclusions = (policy.excludedPaths ?? []).map(compilePattern);
  const units = (policy.unitRules ?? []).map((rule) => ({ ...rule, pattern: compilePattern(rule.path) }));
  const duplicates = <T>(values: readonly T[]): boolean => new Set(values).size !== values.length;
  if (duplicates(sets.map(({ source }) => source))) throw new TypeError("setPaths must not contain duplicates");
  if (duplicates(exclusions.map(({ source }) => source))) throw new TypeError("excludedPaths must not contain duplicates");
  if (duplicates(units.map(({ path }) => path))) throw new TypeError("unitRules must not contain duplicate paths");
  if (exclusions.some(({ segments }) => segments.length === 0)) throw new TypeError("The root value cannot exclude itself");
  return { sets, exclusions, units, ancestors: new Set<object>() };
}

/**
 * Deterministic Build Sim canonical JSON.
 *
 * Values are normalized to Build Sim's governed domain representation first
 * (NFC, declared sets, units and self-hash exclusions), then serialized with the
 * RFC 8785 JSON/ECMAScript number and UTF-16 property-ordering rules. The domain
 * and schema prefix is added by `canonicalHashPreimage`.
 */
export function canonicalize(value: unknown, policy: CanonicalizationPolicy = {}): string {
  return serialize(value, [], compilePolicy(policy));
}

/** Compatibility canonicalizer for pre-U0 persisted hashes only. */
export function legacyCanonicalize(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  const result = JSON.stringify(normalize(value));
  if (result === undefined) throw new TypeError("Legacy canonical hash root is not JSON serializable");
  return result;
}
