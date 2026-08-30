import { isIsoTimestampRuntime, isSha256HexRuntime, legacySha256Runtime, runtimeRecord } from "../facts/canonical-runtime.mjs";
import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";
import {
  sha256JsonRuntime,
  validatePlanEvaluationLockRuntime,
} from "./canonical-runtime.mjs";

/**
 * JavaScript-only projection of EvaluationLockRepository's persisted authority.
 *
 * Backup/Doctor/restore load this module without a TypeScript loader.  Keep the
 * domain bindings here deliberately small and frozen to the values accepted by
 * the evaluation pipeline; transport-provided hash policies are never trusted.
 */

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const HASH_SPEC_VERSION = "hash-spec-v1";
const ARTIFACT_ROLES = Object.freeze([
  "ruleSet", "standardSet", "systemProfile", "adapterSnapshot", "engine", "simulationModel",
]);
const EXTERNAL_ROLES = Object.freeze(["requirementSpec", "priceSnapshot", "simulationInput"]);
const SNAPSHOT_HASH_FIELDS = Object.freeze([
  "configHash", "requirementSpecHash", "factSnapshotHash", "userObservationSnapshotHash", "priceSnapshotHash",
  "ruleSetHash", "systemProfileHash", "adapterSnapshotHash", "engineHash", "simulationModelHash", "simulationInputHash",
]);

const POLICIES = Object.freeze({
  "plan-evaluation-lock-content-v1": { excludedPaths: ["/contentHash"] },
  "artifact-payload-v1": { excludedPaths: ["/contentHash"] },
  "artifact-lockfile-v1": { excludedPaths: ["/lockfileHash"] },
  "requirement-spec-v1": {
    setPaths: ["/workloads", "/workloads/*/metrics", "/workloads/*/evidenceOrBenchmarkRefs", "/constraints"],
    excludedPaths: ["/requirementSpecHash"],
  },
});

const HASH_DOMAINS = Object.freeze({
  "plan-evaluation-lock@plan-evaluation-lock-v1": "plan-evaluation-lock-content-v1",
  "artifact@artifact-payload-v1": "artifact-payload-v1",
  "artifact-lockfile@artifact-lockfile-v1": "artifact-lockfile-v1",
  "requirement-spec@1.0.0": "requirement-spec-v1",
  "artifact.rule-set@1.0.0": "artifact-payload-v1",
  "artifact.standard-set@1.0.0": "artifact-payload-v1",
  "artifact.system-profile@1.0.0": "artifact-payload-v1",
  "artifact.adapter-snapshot@1.0.0": "artifact-payload-v1",
  "artifact.engine@1.0.0": "artifact-payload-v1",
  "artifact.simulation-model@1.0.0": "artifact-payload-v1",
});

function total(operation, fallback) { try { return operation(); } catch { return fallback; } }
function exact(value, keys) {
  return runtimeRecord(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function nonEmpty(value) { return typeof value === "string" && value.length > 0; }
function normalizedScalar(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC");
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = normalized.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return null;
  }
  return normalized;
}
function pathMatches(pattern, parts) {
  const segments = pattern === "" ? [] : pattern.slice(1).split("/");
  return segments.length === parts.length && segments.every((segment, index) => segment === "*" || segment === parts[index]);
}
function policyMatches(patterns, parts) { return (patterns ?? []).some((pattern) => pathMatches(pattern, parts)); }

/** Exact hash-spec-v1 serialization for the frozen snapshot authority policies. */
function canonicalize(value, policy, parts = [], ancestors = new Set()) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    const normalized = normalizedScalar(value);
    if (normalized === null) throw new TypeError("invalid canonical string");
    return JSON.stringify(normalized);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("invalid canonical number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new TypeError("invalid canonical JSON");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new TypeError("invalid canonical array");
      const items = value.map((item, index) => canonicalize(item, policy, [...parts, String(index)], ancestors));
      if (policyMatches(policy.setPaths, parts)) {
        items.sort();
        if (items.some((item, index) => index > 0 && item === items[index - 1])) throw new TypeError("duplicate canonical set member");
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) throw new TypeError("invalid canonical object");
    const entries = new Map();
    for (const [rawKey, item] of Object.entries(value)) {
      const key = normalizedScalar(rawKey);
      if (key === null) throw new TypeError("invalid canonical key");
      const childParts = [...parts, key];
      if (policyMatches(policy.excludedPaths, childParts)) continue;
      if (entries.has(key)) throw new TypeError("canonical key collision");
      entries.set(key, item);
    }
    return `{${[...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item, policy, [...parts, key], ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}

function contentHash(value, domain, schemaVersion) {
  return total(() => {
    const policyId = HASH_DOMAINS[`${domain}@${schemaVersion}`];
    if (!policyId) return null;
    const canonical = canonicalize(value, POLICIES[policyId]);
    return sha256Utf8Runtime(`buildsim\u0000${HASH_SPEC_VERSION}\u0000${domain}\u0000${schemaVersion}\u0000${canonical}`);
  }, null);
}

function contentRef(value) {
  if (!exact(value, ["ref", "hashSpecVersion", "algorithm", "contentHash", "domain", "schemaVersion", "canonicalizationPolicyId"])) return false;
  const expectedPolicy = HASH_DOMAINS[`${value.domain}@${value.schemaVersion}`];
  return value.hashSpecVersion === HASH_SPEC_VERSION && value.algorithm === "sha256" && isSha256HexRuntime(value.contentHash)
    && value.ref === `sha256:${value.contentHash}` && typeof value.domain === "string" && typeof value.schemaVersion === "string"
    && expectedPolicy !== undefined && value.canonicalizationPolicyId === expectedPolicy;
}

function contentRefProjection(value) {
  if (!runtimeRecord(value)) return null;
  return {
    ref: value.ref,
    hashSpecVersion: value.hashSpecVersion,
    algorithm: value.algorithm,
    contentHash: value.contentHash,
    domain: value.domain,
    schemaVersion: value.schemaVersion,
    canonicalizationPolicyId: value.canonicalizationPolicyId,
  };
}

function verifyContentRef(payload, ref) {
  return total(() => {
    // LockedArtifactRef extends ContentAddressedRef.  Its role metadata is
    // validated separately, but the hash verifier must calculate from the
    // underlying seven-field content-addressed projection rather than reject
    // every valid extended reference for carrying that metadata.
    const content = contentRefProjection(ref);
    return content !== null && contentRef(content)
      && contentHash(payload, content.domain, content.schemaVersion) === content.contentHash;
  }, false);
}

function lockedArtifactRef(value, role) {
  return exact(value, ["ref", "hashSpecVersion", "algorithm", "contentHash", "domain", "schemaVersion", "canonicalizationPolicyId", "role", "artifactId", "mediaType", "requiredForReplay"])
    && contentRef({
      ref: value.ref, hashSpecVersion: value.hashSpecVersion, algorithm: value.algorithm, contentHash: value.contentHash,
      domain: value.domain, schemaVersion: value.schemaVersion, canonicalizationPolicyId: value.canonicalizationPolicyId,
    }) && value.role === role && nonEmpty(value.artifactId) && nonEmpty(value.mediaType) && value.requiredForReplay === true;
}

export function validateEvaluationLockEnvelopeRuntime(value, kind) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "kind", "checksum", "payload"])) return ["evaluation snapshot envelope fields invalid"];
    if (value.schemaVersion !== "evaluation-lock-envelope-v1" || value.kind !== kind || !isSha256HexRuntime(value.checksum)
      || value.checksum !== sha256JsonRuntime(value.payload)) return ["evaluation snapshot envelope checksum or kind invalid"];
    return [];
  }, ["evaluation snapshot envelope runtime validation failed"]);
}

export function validateEvaluationArtifactInputRuntime(value) {
  return total(() => {
    if (!exact(value, ["ref", "payload"])) return ["evaluation artifact input fields invalid"];
    if (!ARTIFACT_ROLES.includes(value.ref?.role) || !lockedArtifactRef(value.ref, value.ref.role)) return ["evaluation artifact ref invalid"];
    return verifyContentRef(value.payload, value.ref) ? [] : ["evaluation artifact payload/ref closure invalid"];
  }, ["evaluation artifact runtime validation failed"]);
}

export function validateArtifactLockfileRuntime(value) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "hashSpecVersion", "artifacts", "lockfileHash"])) return ["artifact lockfile fields invalid"];
    if (value.schemaVersion !== "artifact-lockfile-v1" || value.hashSpecVersion !== HASH_SPEC_VERSION || !isSha256HexRuntime(value.lockfileHash)
      || !exact(value.artifacts, ARTIFACT_ROLES)) return ["artifact lockfile structure invalid"];
    for (const role of ARTIFACT_ROLES) if (!lockedArtifactRef(value.artifacts[role], role)) return ["artifact lockfile artifact ref invalid"];
    return contentHash(value, "artifact-lockfile", "artifact-lockfile-v1") === value.lockfileHash
      ? [] : ["artifact lockfile content hash invalid"];
  }, ["artifact lockfile runtime validation failed"]);
}

function artifactPayload(value) {
  if (!exact(value, ["schemaVersion", "artifactId", "mediaType", "payload", "contentHash"])) return false;
  if (value.schemaVersion !== "artifact-payload-v1" || !nonEmpty(value.artifactId) || !nonEmpty(value.mediaType) || !isSha256HexRuntime(value.contentHash)) return false;
  return contentHash(value, "artifact", "artifact-payload-v1") === value.contentHash;
}

export function validateEvaluationExternalRuntime(value) {
  return total(() => {
    if (!exact(value, ["role", "snapshot"]) || !EXTERNAL_ROLES.includes(value.role) || !exact(value.snapshot, ["ref", "payload"])) {
      return ["evaluation external snapshot structure invalid"];
    }
    const { ref, payload } = value.snapshot;
    if (!contentRef(ref) || !verifyContentRef(payload, ref)) return ["evaluation external payload/ref closure invalid"];
    if (value.role === "requirementSpec" && (ref.domain !== "requirement-spec" || ref.schemaVersion !== "1.0.0")) {
      return ["evaluation requirement snapshot domain invalid"];
    }
    if ((value.role === "priceSnapshot" || value.role === "simulationInput")
      && (ref.domain !== "artifact" || ref.schemaVersion !== "artifact-payload-v1" || !artifactPayload(payload))) {
      return ["evaluation artifact external snapshot domain invalid"];
    }
    return [];
  }, ["evaluation external runtime validation failed"]);
}

export function evaluationTargetKeyRuntime(target) {
  return total(() => {
    if (exact(target, ["kind", "draftRevision"]) && target.kind === "draft" && Number.isInteger(target.draftRevision) && target.draftRevision >= 0) {
      return `draft-${target.draftRevision}`;
    }
    if (exact(target, ["kind", "versionId"]) && target.kind === "version" && PLAN_ID.test(target.versionId)) return `version-${target.versionId}`;
    return null;
  }, null);
}

export function validateAuthoritativeEvaluationReceiptRuntime(value) {
  return total(() => {
    const fields = [
      "schemaVersion", "planId", "target", "runtimeGeneration", "preparedRevision", "committedRevision", "configHash",
      "evaluationHash", "evaluationLock", "evaluatedAt", "evaluation", "catalogVersion", "priceSnapshotVersion", "cacheStatus",
    ];
    if (!exact(value, fields) || value.schemaVersion !== "authoritative-evaluation-receipt-v1" || !PLAN_ID.test(String(value.planId ?? ""))
      || evaluationTargetKeyRuntime(value.target) === null || !Number.isInteger(value.runtimeGeneration) || value.runtimeGeneration < 1
      || !Number.isInteger(value.preparedRevision) || value.preparedRevision < 0 || value.committedRevision !== value.preparedRevision + 1
      || !isSha256HexRuntime(value.configHash) || !isSha256HexRuntime(value.evaluationHash) || !isIsoTimestampRuntime(value.evaluatedAt)
      || !nonEmpty(value.catalogVersion) || !(value.priceSnapshotVersion === null || nonEmpty(value.priceSnapshotVersion))
      || !["hit", "miss"].includes(value.cacheStatus)) return ["authoritative evaluation receipt structure invalid"];
    const lockErrors = validatePlanEvaluationLockRuntime(value.evaluationLock);
    if (lockErrors.length || value.evaluationLock.planId !== value.planId || value.evaluationLock.snapshotHashes.configHash !== value.configHash) {
      return ["authoritative evaluation receipt lock closure invalid"];
    }
    const evaluationHash = legacySha256Runtime({
      domain: "authoritative-evaluation-identity", schemaVersion: "authoritative-evaluation-identity-v1",
      evaluationLockHash: value.evaluationLock.contentHash, evaluation: value.evaluation,
    });
    return evaluationHash === value.evaluationHash ? [] : ["authoritative evaluation receipt hash invalid"];
  }, ["authoritative evaluation receipt runtime validation failed"]);
}

export function validateEvaluationCurrentPointerRuntime(value) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "planId", "target", "receiptHash", "evaluationLockHash", "evaluationHash"])) {
      return ["evaluation current pointer fields invalid"];
    }
    if (value.schemaVersion !== "evaluation-current-v1" || !PLAN_ID.test(String(value.planId ?? "")) || evaluationTargetKeyRuntime(value.target) === null
      || !isSha256HexRuntime(value.receiptHash) || !isSha256HexRuntime(value.evaluationLockHash) || !isSha256HexRuntime(value.evaluationHash)) {
      return ["evaluation current pointer structure invalid"];
    }
    return [];
  }, ["evaluation current pointer runtime validation failed"]);
}

export function evaluationSnapshotLockClosureRuntime(lock, facts, observations, artifacts, externals) {
  return total(() => {
    const errors = [...validatePlanEvaluationLockRuntime(lock)];
    if (errors.length) return errors;
    const fact = facts.get(lock.factSnapshotId);
    if (!fact || fact.contentHash !== lock.snapshotHashes.factSnapshotHash) errors.push("evaluation lock fact snapshot closure invalid");
    const observation = observations.get(`${lock.planId}\u0000${lock.userObservationSnapshotId}`);
    if (!observation || observation.contentHash !== lock.snapshotHashes.userObservationSnapshotHash) errors.push("evaluation lock observation snapshot closure invalid");
    const lockfile = artifacts.lockfiles.get(lock.artifactLockfileHash);
    if (!lockfile || lockfile.lockfileHash !== lock.artifactLockfileHash) errors.push("evaluation lock artifact lockfile closure invalid");
    if (lockfile) {
      const expected = [
        ["ruleSetHash", "ruleSet"], ["systemProfileHash", "systemProfile"], ["adapterSnapshotHash", "adapterSnapshot"],
        ["engineHash", "engine"], ["simulationModelHash", "simulationModel"],
      ];
      for (const [field, role] of expected) if (lock.snapshotHashes[field] !== lockfile.artifacts[role]?.contentHash) errors.push("evaluation lock artifact snapshot hashes invalid");
      for (const role of ARTIFACT_ROLES) {
        const ref = lockfile.artifacts[role]; const stored = ref && artifacts.payloads.get(ref.contentHash);
        if (!stored || stored.ref.role !== role || sha256JsonRuntime(stored.ref) !== sha256JsonRuntime(ref)) errors.push("evaluation lock artifact payload closure invalid");
      }
    }
    const expectedExternal = [
      ["requirementSpec", "requirementSpecHash"], ["priceSnapshot", "priceSnapshotHash"], ["simulationInput", "simulationInputHash"],
    ];
    for (const [role, field] of expectedExternal) {
      const stored = externals.get(`${role}\u0000${lock.snapshotHashes[field]}`);
      if (!stored) errors.push("evaluation lock external snapshot closure invalid");
    }
    return errors;
  }, ["evaluation lock closure runtime validation failed"]);
}

export const EVALUATION_LOCK_RUNTIME = Object.freeze({ ARTIFACT_ROLES, EXTERNAL_ROLES, SNAPSHOT_HASH_FIELDS });
