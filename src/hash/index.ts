import { canonicalize, legacyCanonicalize } from "./canonical";
import {
  ARTIFACT_LOCK_ROLES,
  HASH_SPEC,
  HASH_CANONICALIZATION_POLICIES,
  HASH_DOMAIN_REGISTRY,
  isContentAddressedRef,
  isSha256Hex,
  type ArtifactLockEntries,
  type ArtifactLockfile,
  type ArtifactReplayReadiness,
  type ContentAddressedRef,
  type HashDomainContract,
  type LockedArtifactRef,
} from "./contracts";

export * from "./canonical";
export * from "./contracts";

const DOMAIN_TOKEN = /^[a-z][a-z0-9._-]{0,127}$/;
const SCHEMA_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const encoder = new TextEncoder();

function resolveContract(contract: HashDomainContract) {
  if (!DOMAIN_TOKEN.test(contract.domain)) throw new TypeError(`Invalid hash domain: ${contract.domain}`);
  if (!SCHEMA_TOKEN.test(contract.schemaVersion)) throw new TypeError(`Invalid hash schemaVersion: ${contract.schemaVersion}`);
  if (Object.keys(contract).some((key) => !["domain", "schemaVersion", "canonicalizationPolicyId"].includes(key))) {
    throw new TypeError("Hash domain contract contains unknown fields; canonicalization policies must come from the frozen registry");
  }
  const registered = HASH_DOMAIN_REGISTRY[`${contract.domain}@${contract.schemaVersion}` as keyof typeof HASH_DOMAIN_REGISTRY];
  if (!registered) throw new TypeError(`Unknown hash domain/schema registration: ${contract.domain}@${contract.schemaVersion}`);
  if (contract.canonicalizationPolicyId !== undefined && contract.canonicalizationPolicyId !== registered.canonicalizationPolicyId) {
    throw new TypeError(`Hash policy ${contract.canonicalizationPolicyId} is not registered for ${contract.domain}@${contract.schemaVersion}`);
  }
  const policy = HASH_CANONICALIZATION_POLICIES[registered.canonicalizationPolicyId];
  if (!policy) throw new TypeError(`Unknown canonicalization policy: ${registered.canonicalizationPolicyId}`);
  return { ...registered, policy };
}

/** Runtime-neutral SHA-256 over a UTF-8 string. */
export async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The exact preimage format is part of hash-spec-v1 and is covered by golden vectors. */
export function canonicalHashPreimage(value: unknown, contract: HashDomainContract): string {
  const resolved = resolveContract(contract);
  const canonical = canonicalize(value, resolved.policy);
  return `buildsim\u0000${HASH_SPEC.version}\u0000${contract.domain}\u0000${contract.schemaVersion}\u0000${canonical}`;
}

export async function hashContent(value: unknown, contract: HashDomainContract): Promise<string> {
  return sha256Hex(canonicalHashPreimage(value, contract));
}

export async function createContentAddressedRef(
  value: unknown,
  contract: HashDomainContract,
): Promise<ContentAddressedRef> {
  const resolved = resolveContract(contract);
  const contentHash = await hashContent(value, contract);
  return Object.freeze({
    ref: `sha256:${contentHash}`,
    hashSpecVersion: HASH_SPEC.version,
    algorithm: "sha256",
    contentHash,
    domain: contract.domain,
    schemaVersion: contract.schemaVersion,
    canonicalizationPolicyId: resolved.canonicalizationPolicyId,
  });
}

export async function createLockedArtifactRef(
  value: unknown,
  role: LockedArtifactRef["role"],
  artifactId: string,
  mediaType: string,
  contract: HashDomainContract,
): Promise<LockedArtifactRef> {
  if (!(ARTIFACT_LOCK_ROLES as readonly string[]).includes(role)) throw new TypeError(`Unknown artifact lock role: ${role}`);
  if (!artifactId) throw new TypeError("artifactId must not be empty");
  if (!mediaType) throw new TypeError("mediaType must not be empty");
  return Object.freeze({
    ...await createContentAddressedRef(value, contract),
    role,
    artifactId,
    mediaType,
    requiredForReplay: true as const,
  });
}

export async function verifyContentAddressedRef(value: unknown, ref: ContentAddressedRef): Promise<boolean> {
  if (!isContentAddressedRef(ref)) return false;
  return ref.contentHash === await hashContent(value, {
    domain: ref.domain,
    schemaVersion: ref.schemaVersion,
    canonicalizationPolicyId: ref.canonicalizationPolicyId,
  });
}

/**
 * Compatibility adapter for pre-U0 callers. It intentionally has no domain or
 * schema prefix; new persisted contracts must use `hashContent`.
 */
export async function legacySha256Hex(value: unknown): Promise<string> {
  return sha256Hex(legacyCanonicalize(value));
}

function isLockedArtifactRef(value: unknown, role: string): value is LockedArtifactRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  const contentRef = {
    ref: ref.ref,
    hashSpecVersion: ref.hashSpecVersion,
    algorithm: ref.algorithm,
    contentHash: ref.contentHash,
    domain: ref.domain,
    schemaVersion: ref.schemaVersion,
    canonicalizationPolicyId: ref.canonicalizationPolicyId,
  };
  return Object.keys(ref).length === 11
    && Object.keys(ref).every((key) => ["ref", "hashSpecVersion", "algorithm", "contentHash", "domain", "schemaVersion", "canonicalizationPolicyId", "role", "artifactId", "mediaType", "requiredForReplay"].includes(key))
    && isContentAddressedRef(contentRef)
    && ref.role === role
    && typeof ref.artifactId === "string" && ref.artifactId.length > 0
    && typeof ref.mediaType === "string" && ref.mediaType.length > 0
    && ref.requiredForReplay === true;
}

export function validateArtifactLockfile(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["artifact lockfile must be an object"];
  const lockfile = value as Record<string, unknown>;
  const errors: string[] = [];
  if (Object.keys(lockfile).some((key) => !["schemaVersion", "hashSpecVersion", "artifacts", "lockfileHash"].includes(key))) errors.push("artifact lockfile contains unknown fields");
  if (lockfile.schemaVersion !== "artifact-lockfile-v1") errors.push("artifact lockfile schemaVersion invalid");
  if (lockfile.hashSpecVersion !== HASH_SPEC.version) errors.push("artifact lockfile hashSpecVersion invalid");
  if (!isSha256Hex(lockfile.lockfileHash)) errors.push("artifact lockfile lockfileHash invalid");
  if (lockfile.artifacts === null || typeof lockfile.artifacts !== "object" || Array.isArray(lockfile.artifacts)) {
    errors.push("artifact lockfile artifacts invalid");
  } else {
    const artifacts = lockfile.artifacts as Record<string, unknown>;
    if (Object.keys(artifacts).length !== ARTIFACT_LOCK_ROLES.length || Object.keys(artifacts).some((key) => !(ARTIFACT_LOCK_ROLES as readonly string[]).includes(key))) {
      errors.push("artifact lockfile must contain exactly the replay-required artifact roles");
    }
    for (const role of ARTIFACT_LOCK_ROLES) {
      if (!isLockedArtifactRef(artifacts[role], role)) errors.push(`artifact lockfile ${role} ref invalid`);
    }
  }
  return errors;
}

/** Legacy evaluations with no complete, valid lockfile are explicitly non-replayable. */
export function assessArtifactReplay(value: unknown): ArtifactReplayReadiness {
  const artifacts = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).artifacts
    : undefined;
  const artifactRecord = artifacts && typeof artifacts === "object" && !Array.isArray(artifacts)
    ? artifacts as Record<string, unknown>
    : {};
  const missingRoles = ARTIFACT_LOCK_ROLES.filter((role) => !(role in artifactRecord));
  const invalidRoles = ARTIFACT_LOCK_ROLES.filter((role) => role in artifactRecord && !isLockedArtifactRef(artifactRecord[role], role));
  const reasons = validateArtifactLockfile(value);
  return Object.freeze({
    replayable: reasons.length === 0,
    missingRoles: Object.freeze([...missingRoles]),
    invalidRoles: Object.freeze([...invalidRoles]),
    reasons: Object.freeze([...reasons]),
  });
}

export async function createArtifactLockfile(artifacts: ArtifactLockEntries): Promise<ArtifactLockfile> {
  const lockedArtifacts = Object.freeze(Object.fromEntries(ARTIFACT_LOCK_ROLES.map((role) => {
    const ref = artifacts[role];
    if (!isLockedArtifactRef(ref, role)) throw new TypeError(`artifact lockfile ${role} ref invalid`);
    return [role, Object.freeze({ ...ref })];
  }))) as unknown as ArtifactLockEntries;
  const candidate = {
    schemaVersion: "artifact-lockfile-v1" as const,
    hashSpecVersion: HASH_SPEC.version,
    artifacts: lockedArtifacts,
  };
  const lockfileHash = await hashContent(candidate, {
    domain: "artifact-lockfile",
    schemaVersion: "artifact-lockfile-v1",
  });
  const lockfile = Object.freeze({ ...candidate, lockfileHash });
  const errors = validateArtifactLockfile(lockfile);
  if (errors.length) throw new TypeError(errors.join("; "));
  return lockfile;
}

export async function verifyArtifactLockfile(lockfile: ArtifactLockfile): Promise<boolean> {
  if (validateArtifactLockfile(lockfile).length) return false;
  return lockfile.lockfileHash === await hashContent(lockfile, {
    domain: "artifact-lockfile",
    schemaVersion: "artifact-lockfile-v1",
  });
}
