import type { CanonicalizationPolicy, CanonicalJsonValue } from "./canonical";

export const HASH_SPEC = Object.freeze({
  version: "hash-spec-v1",
  algorithm: "sha256",
  canonicalization: "rfc8785-jcs-with-buildsim-domain-prefix",
  unicode: "utf8-nfc",
  numberPolicy: "finite-json-number",
  excludes: Object.freeze(["the-hash-field-itself"]),
} as const);

export type HashSpec = typeof HASH_SPEC;
export const HASH_SPEC_VERSION: HashSpec["version"] = HASH_SPEC.version;
export type Sha256Hex = string;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

/**
 * Canonicalization policies are persisted protocol, not caller preferences.
 * Adding or changing one requires a new ID and new cross-runtime golden vectors.
 */
export const HASH_CANONICALIZATION_POLICIES = deepFreeze({
  "canonical-json-v1": {},
  "golden-id-set-v1": { setPaths: ["/ids"] },
  "golden-clearance-mm-v1": {
    unitRules: [{
      path: "/clearance",
      canonicalUnitId: "mm",
      conversions: {
        mm: { scale: 1 },
        cm: { scale: 10 },
        m: { scale: 1000 },
      },
    }],
  },
  "content-hash-self-v1": { excludedPaths: ["/contentHash"] },
  "listing-capture-content-v1": { excludedPaths: ["/contentHash"] },
  "portable-reference-graph-v1": { setPaths: ["/nodes", "/edges"], excludedPaths: ["/graphHash"] },
  "config-v3-v1": {
    setPaths: ["/components", "/roleDecisions", "/placements", "/connections", "/logicalLayouts", "/firmwareTargets"],
    excludedPaths: ["/configHash"],
  },
  "requirement-spec-v1": {
    setPaths: ["/workloads", "/workloads/*/metrics", "/workloads/*/evidenceOrBenchmarkRefs", "/constraints"],
    excludedPaths: ["/requirementSpecHash"],
  },
  "fact-snapshot-v1": {
    setPaths: ["/facts", "/conflictSets", "/facts/*/evidenceRefs"],
    excludedPaths: ["/factSnapshotHash"],
  },
  "fact-snapshot-content-v1": {
    setPaths: ["/factIds", "/conflictSetIds"],
    excludedPaths: ["/contentHash"],
  },
  "observation-snapshot-v1": {
    setPaths: ["/observations", "/observations/*/attachmentRefs"],
    excludedPaths: ["/userObservationSnapshotHash"],
  },
  "observation-snapshot-content-v1": {
    setPaths: ["/observationIds"],
    excludedPaths: ["/contentHash"],
  },
  "adapter-snapshot-v1": {
    setPaths: ["/adapters", "/adapters/*/capabilities"],
    excludedPaths: ["/adapterSnapshotHash"],
  },
  "adapter-snapshot-content-v1": {
    setPaths: ["/adapters", "/adapters/*/componentKindIds", "/adapters/*/emittedFacetIds"],
    excludedPaths: ["/contentHash"],
  },
  "simulation-model-v1": { excludedPaths: ["/simulationModelHash"] },
  "simulation-model-artifact-v1": {
    setPaths: ["/assumptions"],
    excludedPaths: ["/contentHash"],
  },
  "artifact-payload-v1": { excludedPaths: ["/contentHash"] },
  "artifact-lockfile-v1": { excludedPaths: ["/lockfileHash"] },
  "backup-manifest-v1": { excludedPaths: ["/manifestHash"] },
  "doctor-report-v1": { excludedPaths: ["/reportHash"] },
} as const satisfies Readonly<Record<string, CanonicalizationPolicy>>);

export type CanonicalizationPolicyId = keyof typeof HASH_CANONICALIZATION_POLICIES;

interface RegisteredHashDomain {
  readonly domain: string;
  readonly schemaVersion: string;
  readonly canonicalizationPolicyId: CanonicalizationPolicyId;
}

/**
 * Frozen domain-to-policy bindings. A schema may never silently change its
 * canonicalization policy; introduce a new schema or domain registration.
 */
export const HASH_DOMAIN_REGISTRY = deepFreeze({
  "golden-text@1.0.0": { domain: "golden-text", schemaVersion: "1.0.0", canonicalizationPolicyId: "canonical-json-v1" },
  "golden-number@1.0.0": { domain: "golden-number", schemaVersion: "1.0.0", canonicalizationPolicyId: "canonical-json-v1" },
  "golden-set@1.0.0": { domain: "golden-set", schemaVersion: "1.0.0", canonicalizationPolicyId: "golden-id-set-v1" },
  "golden-unit@1.0.0": { domain: "golden-unit", schemaVersion: "1.0.0", canonicalizationPolicyId: "golden-clearance-mm-v1" },
  "golden-self@1.0.0": { domain: "golden-self", schemaVersion: "1.0.0", canonicalizationPolicyId: "content-hash-self-v1" },
  "other-domain@1.0.0": { domain: "other-domain", schemaVersion: "1.0.0", canonicalizationPolicyId: "content-hash-self-v1" },
  "golden-self@2.0.0": { domain: "golden-self", schemaVersion: "2.0.0", canonicalizationPolicyId: "content-hash-self-v1" },
  "build-config@3.0.0": { domain: "build-config", schemaVersion: "3.0.0", canonicalizationPolicyId: "config-v3-v1" },
  "requirement-spec@1.0.0": { domain: "requirement-spec", schemaVersion: "1.0.0", canonicalizationPolicyId: "requirement-spec-v1" },
  "fact-snapshot@1.0.0": { domain: "fact-snapshot", schemaVersion: "1.0.0", canonicalizationPolicyId: "fact-snapshot-v1" },
  "user-observation-snapshot@1.0.0": { domain: "user-observation-snapshot", schemaVersion: "1.0.0", canonicalizationPolicyId: "observation-snapshot-v1" },
  "adapter-snapshot@1.0.0": { domain: "adapter-snapshot", schemaVersion: "1.0.0", canonicalizationPolicyId: "adapter-snapshot-v1" },
  "simulation-model@1.0.0": { domain: "simulation-model", schemaVersion: "1.0.0", canonicalizationPolicyId: "simulation-model-v1" },
  "artifact@1.0.0": { domain: "artifact", schemaVersion: "1.0.0", canonicalizationPolicyId: "artifact-payload-v1" },
  "fact-snapshot@fact-snapshot-v1": { domain: "fact-snapshot", schemaVersion: "fact-snapshot-v1", canonicalizationPolicyId: "fact-snapshot-content-v1" },
  "user-observation-snapshot@user-observation-snapshot-v1": { domain: "user-observation-snapshot", schemaVersion: "user-observation-snapshot-v1", canonicalizationPolicyId: "observation-snapshot-content-v1" },
  "adapter-snapshot@adapter-snapshot-v1": { domain: "adapter-snapshot", schemaVersion: "adapter-snapshot-v1", canonicalizationPolicyId: "adapter-snapshot-content-v1" },
  "simulation-model@simulation-model-artifact-v1": { domain: "simulation-model", schemaVersion: "simulation-model-artifact-v1", canonicalizationPolicyId: "simulation-model-artifact-v1" },
  "artifact@artifact-payload-v1": { domain: "artifact", schemaVersion: "artifact-payload-v1", canonicalizationPolicyId: "artifact-payload-v1" },
  "listing-capture@listing-capture-v1": { domain: "listing-capture", schemaVersion: "listing-capture-v1", canonicalizationPolicyId: "listing-capture-content-v1" },
  "portable-reference-graph@portable-reference-graph-v1": { domain: "portable-reference-graph", schemaVersion: "portable-reference-graph-v1", canonicalizationPolicyId: "portable-reference-graph-v1" },
  "engine@1.0.0": { domain: "engine", schemaVersion: "1.0.0", canonicalizationPolicyId: "canonical-json-v1" },
  "artifact-lockfile@artifact-lockfile-v1": { domain: "artifact-lockfile", schemaVersion: "artifact-lockfile-v1", canonicalizationPolicyId: "artifact-lockfile-v1" },
  "backup-manifest@backup-v1": { domain: "backup-manifest", schemaVersion: "backup-v1", canonicalizationPolicyId: "backup-manifest-v1" },
  "doctor-report@doctor-v1": { domain: "doctor-report", schemaVersion: "doctor-v1", canonicalizationPolicyId: "doctor-report-v1" },
  "artifact.rule-set@1.0.0": { domain: "artifact.rule-set", schemaVersion: "1.0.0", canonicalizationPolicyId: "artifact-payload-v1" },
  "artifact.standard-set@1.0.0": { domain: "artifact.standard-set", schemaVersion: "1.0.0", canonicalizationPolicyId: "artifact-payload-v1" },
  "artifact.system-profile@1.0.0": { domain: "artifact.system-profile", schemaVersion: "1.0.0", canonicalizationPolicyId: "artifact-payload-v1" },
  "artifact.adapter-snapshot@1.0.0": { domain: "artifact.adapter-snapshot", schemaVersion: "1.0.0", canonicalizationPolicyId: "artifact-payload-v1" },
  "artifact.engine@1.0.0": { domain: "artifact.engine", schemaVersion: "1.0.0", canonicalizationPolicyId: "artifact-payload-v1" },
  "artifact.simulation-model@1.0.0": { domain: "artifact.simulation-model", schemaVersion: "1.0.0", canonicalizationPolicyId: "artifact-payload-v1" },
} as const satisfies Readonly<Record<string, RegisteredHashDomain>>);

export interface HashDomainContract {
  /** Stable semantic domain, for example `build-config` or `artifact-lockfile`. */
  readonly domain: string;
  /** Schema of the value being hashed, separate from HashSpec's own version. */
  readonly schemaVersion: string;
  /** Optional only for source compatibility; when present it must match the frozen domain binding. */
  readonly canonicalizationPolicyId?: CanonicalizationPolicyId;
}

export interface ContentAddressedRef {
  readonly ref: string;
  readonly hashSpecVersion: HashSpec["version"];
  readonly algorithm: "sha256";
  readonly contentHash: Sha256Hex;
  readonly domain: string;
  readonly schemaVersion: string;
  readonly canonicalizationPolicyId: CanonicalizationPolicyId;
}

/** A repository artifact envelope whose payload is inert, portable JSON data. */
export interface ArtifactPayload {
  readonly schemaVersion: "artifact-payload-v1";
  readonly artifactId: string;
  readonly mediaType: string;
  readonly payload: CanonicalJsonValue;
  readonly contentHash: Sha256Hex;
}

export interface SnapshotHashes {
  readonly configHash: Sha256Hex;
  readonly requirementSpecHash: Sha256Hex;
  readonly factSnapshotHash: Sha256Hex;
  readonly userObservationSnapshotHash: Sha256Hex;
  readonly priceSnapshotHash: Sha256Hex;
  readonly ruleSetHash: Sha256Hex;
  readonly systemProfileHash: Sha256Hex;
  readonly adapterSnapshotHash: Sha256Hex;
  readonly engineHash: Sha256Hex;
  readonly simulationModelHash: Sha256Hex;
  readonly simulationInputHash: Sha256Hex;
}

export interface DomainHashes {
  readonly compatibilityHash: Sha256Hex;
  readonly spatialHash: Sha256Hex;
  readonly simulationHash: Sha256Hex;
  readonly procedureSafetyHash: Sha256Hex;
  readonly priceHash: Sha256Hex;
}

export const ARTIFACT_LOCK_ROLES = [
  "ruleSet",
  "standardSet",
  "systemProfile",
  "adapterSnapshot",
  "engine",
  "simulationModel",
] as const;

export type ArtifactLockRole = (typeof ARTIFACT_LOCK_ROLES)[number];

export interface LockedArtifactRef extends ContentAddressedRef {
  readonly role: ArtifactLockRole;
  readonly artifactId: string;
  readonly mediaType: string;
  readonly requiredForReplay: true;
}

export type ArtifactLockEntries = Readonly<{ [Role in ArtifactLockRole]: LockedArtifactRef }>;

export interface ArtifactLockfile {
  readonly schemaVersion: "artifact-lockfile-v1";
  readonly hashSpecVersion: HashSpec["version"];
  readonly artifacts: ArtifactLockEntries;
  /** Hash of this lockfile with only `/lockfileHash` excluded. */
  readonly lockfileHash: Sha256Hex;
}

export interface ArtifactReplayReadiness {
  readonly replayable: boolean;
  readonly missingRoles: readonly ArtifactLockRole[];
  readonly invalidRoles: readonly ArtifactLockRole[];
  readonly reasons: readonly string[];
}

export const SNAPSHOT_HASH_FIELDS = [
  "configHash",
  "requirementSpecHash",
  "factSnapshotHash",
  "userObservationSnapshotHash",
  "priceSnapshotHash",
  "ruleSetHash",
  "systemProfileHash",
  "adapterSnapshotHash",
  "engineHash",
  "simulationModelHash",
  "simulationInputHash",
] as const satisfies readonly (keyof SnapshotHashes)[];

export const DOMAIN_HASH_FIELDS = [
  "compatibilityHash",
  "spatialHash",
  "simulationHash",
  "procedureSafetyHash",
  "priceHash",
] as const satisfies readonly (keyof DomainHashes)[];

export function isSha256Hex(value: unknown): value is Sha256Hex {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

function isPlainJsonValue(value: unknown, ancestors: Set<object>): value is CanonicalJsonValue {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return isUnicodeScalarString(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    ancestors.add(value);
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) return false;
      return value.every((item) => isPlainJsonValue(item, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.entries(value).every(([key, item]) => isUnicodeScalarString(key) && isPlainJsonValue(item, ancestors));
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

/** Structural validation only; cryptographic verification compares `contentHash` separately. */
export function validateArtifactPayload(value: unknown): string[] {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return ["artifact payload must be an object"];
    const artifact = value as Record<string, unknown>;
    const errors: string[] = [];
    const fields = ["schemaVersion", "artifactId", "mediaType", "payload", "contentHash"];
    if (Object.keys(artifact).some((key) => !fields.includes(key))) errors.push("artifact payload contains unknown fields");
    if (artifact.schemaVersion !== "artifact-payload-v1") errors.push("artifact payload schemaVersion invalid");
    if (typeof artifact.artifactId !== "string" || artifact.artifactId.trim().length === 0) errors.push("artifact payload artifactId invalid");
    if (typeof artifact.mediaType !== "string" || artifact.mediaType.trim().length === 0) errors.push("artifact payload mediaType invalid");
    if (!("payload" in artifact) || !isPlainJsonValue(artifact.payload, new Set())) errors.push("artifact payload must contain plain finite JSON data");
    if (!isSha256Hex(artifact.contentHash)) errors.push("artifact payload contentHash invalid");
    return errors;
  } catch {
    return ["artifact payload validation failed"];
  }
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

export function isSnapshotHashes(value: unknown): value is SnapshotHashes {
  return isExactRecord(value, SNAPSHOT_HASH_FIELDS)
    && SNAPSHOT_HASH_FIELDS.every((field) => isSha256Hex(value[field]));
}

export function isDomainHashes(value: unknown): value is DomainHashes {
  return isExactRecord(value, DOMAIN_HASH_FIELDS)
    && DOMAIN_HASH_FIELDS.every((field) => isSha256Hex(value[field]));
}

export function isContentAddressedRef(value: unknown): value is ContentAddressedRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (typeof ref.domain !== "string" || typeof ref.schemaVersion !== "string") return false;
  const registered = HASH_DOMAIN_REGISTRY[`${ref.domain}@${ref.schemaVersion}` as keyof typeof HASH_DOMAIN_REGISTRY];
  return isExactRecord(ref, ["ref", "hashSpecVersion", "algorithm", "contentHash", "domain", "schemaVersion", "canonicalizationPolicyId"])
    && ref.hashSpecVersion === HASH_SPEC.version
    && ref.algorithm === "sha256"
    && isSha256Hex(ref.contentHash)
    && ref.ref === `sha256:${ref.contentHash}`
    && /^[a-z][a-z0-9._-]{0,127}$/.test(ref.domain)
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref.schemaVersion)
    && registered !== undefined
    && ref.canonicalizationPolicyId === registered.canonicalizationPolicyId;
}
