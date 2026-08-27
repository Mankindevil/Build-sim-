import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  atomicWriteFile,
  atomicWriteJson,
  canonicalJson,
  confined,
  ensurePrivateDirectory,
  listRegularFiles,
  privateMode,
  sha256Bytes,
  sha256Json,
} from "../runtime/fs.mjs";
import { RUNTIME_REQUIRED_ROOTS } from "../runtime/coordinator.mjs";
import {
  createProductionReferenceGraphAtSnapshot,
  validateProductionRuntimeRoot,
  verifyProductionReferenceGraph,
} from "../runtime/production-reference-graph.mjs";
import { restoreRuntimeBackgroundJob } from "../jobs/runtime-validation.mjs";

const scrypt = promisify(scryptCallback);
const MANIFEST_PREFIX = "buildsim\0hash-spec-v1\0backup-manifest\0backup-v1\0";
const ARTIFACT_PREFIX = "buildsim\0hash-spec-v1\0artifact\0artifact-payload-v1\0";
const FORMAT_VERSION = "buildsim-backup-envelope-v1";
const PAYLOAD_VERSION = "buildsim-backup-encrypted-payload-v1";
const SECRET_KINDS = ["provider_key", "cookie", "browser_profile", "env_file"];
const KDF_PARAMS = Object.freeze({ n: 32_768, r: 8, p: 1 });
const VERIFIED_BACKUP_RESULTS = new WeakSet();
const VERIFIED_BACKUP_PAYLOADS = new WeakMap();

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function manifestHash(manifest) {
  const { manifestHash: _ignored, ...payload } = manifest;
  return sha256Bytes(Buffer.from(`${MANIFEST_PREFIX}${canonicalJson(payload).normalize("NFC")}`, "utf8"));
}
function artifactHash(value) {
  const payload = { ...value, contentHash: undefined };
  return sha256Bytes(Buffer.from(`${ARTIFACT_PREFIX}${canonicalJson(payload).normalize("NFC")}`, "utf8"));
}
function artifactRef(value) {
  const contentHash = artifactHash(value);
  return {
    ref: `sha256:${contentHash}`, hashSpecVersion: "hash-spec-v1", algorithm: "sha256", contentHash,
    domain: "artifact", schemaVersion: "artifact-payload-v1", canonicalizationPolicyId: "artifact-payload-v1",
  };
}
function safeLogicalPath(value) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)
    && value.split(/[\\/]/).every((segment) => segment && segment !== ".." && segment !== ".");
}
function secretKind(logicalPath) {
  const lower = logicalPath.toLowerCase();
  const base = path.posix.basename(lower);
  if (base === ".env" || base.startsWith(".env.") || base.endsWith(".env")) return "env_file";
  if (/(^|[\/_.-])(cookie|cookies)([\/_.-]|$)/.test(lower)) return "cookie";
  if (/(^|\/)(browser[-_ ]?profiles?|(?:chromium|chrome|firefox|playwright)(?:[-_ ]?(?:profiles?|cache|user[-_ ]?data))?)(\/|$)/.test(lower)) return "browser_profile";
  if (/(^|[\/_.-])(api[-_]?key|provider[-_]?key|secret|access[-_]?token|refresh[-_]?token)([\/_.-]|$)/.test(lower)) return "provider_key";
  return null;
}
function secretContentKind(bytes) {
  if (bytes.length > 8 * 1024 * 1024) return null;
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD")) return null;
  try {
    const value = JSON.parse(text);
    const keys = [];
    const visit = (item) => {
      if (!item || typeof item !== "object") return;
      if (Array.isArray(item)) { for (const child of item) visit(child); return; }
      for (const [key, child] of Object.entries(item)) { keys.push(key); visit(child); }
    };
    visit(value);
    if (keys.some((key) => /^(?:cookie|cookies|cookieHeader|cookie_header)$/i.test(key))) return "cookie";
    if (keys.some((key) => /^(?:apiKey|api_key|providerKey|provider_key|secret|password|accessToken|access_token|refreshToken|refresh_token)$/i.test(key))) return "provider_key";
  } catch { /* Non-JSON text is checked below. */ }
  if (/(?:^|\n)\s*(?:api[_-]?key|provider[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)\s*[:=]/i.test(text)) return "provider_key";
  if (/(?:^|\n)\s*cookies?\s*[:=]/i.test(text)) return "cookie";
  return null;
}
function entryKind(logicalPath) {
  if (logicalPath === "audit/backup-runtime-snapshot.json") return "runtime_snapshot";
  if (logicalPath.endsWith("repository-manifest.json")) return "repository_manifest";
  return "runtime_file";
}
function privacyClass(logicalPath) {
  return logicalPath.startsWith("facts/") ? "runtime_internal" : "private_user";
}
function encodePayload(value) { return Buffer.from(canonicalJson(value).normalize("NFC"), "utf8"); }
function assertPassword(password) {
  if (typeof password !== "string" || Buffer.byteLength(password, "utf8") < 12) throw new TypeError("backup password must contain at least 12 UTF-8 bytes");
}
function assertManifest(manifest, snapshot, referenceGraph) {
  if (!manifest || manifest.schemaVersion !== "backup-v1" || typeof manifest.backupId !== "string" || !manifest.backupId
    || !Number.isInteger(manifest.runtimeGeneration) || manifest.runtimeGeneration < 1 || !Array.isArray(manifest.entries)
    || !Array.isArray(manifest.includedRoots) || new Set(manifest.includedRoots).size !== manifest.includedRoots.length
    || !Array.isArray(manifest.excludedEntries) || manifest.manifestHash !== manifestHash(manifest)) throw new Error("backup manifest structure or hash invalid");
  if (manifest.mode === "full_local_backup") {
    if (Object.prototype.hasOwnProperty.call(manifest, "portableProfile")) throw new Error("full backup cannot carry a portable profile");
    for (const root of RUNTIME_REQUIRED_ROOTS) if (!manifest.includedRoots.includes(root)) throw new Error("full backup repository root coverage incomplete");
    for (const kind of SECRET_KINDS) if (!manifest.excludedEntries.some((entry) => entry?.kind === kind && typeof entry.reason === "string" && entry.reason)) throw new Error("full backup secret exclusion declaration incomplete");
    if (!referenceGraph || !snapshot?.referenceGraphHash) throw new Error("full backup requires a production reference graph");
  } else if (manifest.mode !== "plan_portable" || !["slim", "complete"].includes(manifest.portableProfile)) throw new Error("backup mode/profile invalid");
  if (!snapshot || snapshot.schemaVersion !== "runtime-backup-snapshot-v1" || snapshot.runtimeGeneration !== manifest.runtimeGeneration
    || !Number.isInteger(snapshot.runtimeRevision) || snapshot.runtimeRevision < 0 || !Array.isArray(snapshot.repositoryRoots)
    || snapshot.repositoryRoots.length !== manifest.includedRoots.length || snapshot.repositoryRoots.some((root, index) => root !== manifest.includedRoots[index])) throw new Error("backup runtime snapshot binding invalid");
  if (referenceGraph !== undefined) {
    const errors = verifyProductionReferenceGraph(referenceGraph, { runtimeGeneration: manifest.runtimeGeneration, revision: snapshot.runtimeRevision });
    if (errors.length || referenceGraph.runtimeGeneration !== manifest.runtimeGeneration || referenceGraph.runtimeRevision !== snapshot.runtimeRevision
      || referenceGraph.graphHash !== snapshot.referenceGraphHash) throw new Error("backup reference graph binding invalid");
  }
}
async function deriveKey(password, salt, params) {
  return scrypt(password, salt, 32, { N: params.n, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 });
}
function publicEncryptionParameters(salt, nonce) {
  return {
    mode: "authenticated", formatVersion: "aes-256-gcm+scrypt-v1", kdf: "scrypt",
    kdfParams: { ...KDF_PARAMS, saltBase64: salt.toString("base64") }, cipher: "aes-256-gcm",
    keyLengthBits: 256, nonceBase64: nonce.toString("base64"),
  };
}
function aadFor(manifestHashValue, encryption) {
  return Buffer.from(canonicalJson({ formatVersion: FORMAT_VERSION, manifestHash: manifestHashValue, encryption }).normalize("NFC"), "utf8");
}
function executionInventory(files, runtimeGeneration, referenceGraph, declaredIds) {
  const sessions = [];
  for (const file of files) {
    if (!file.logicalPath.startsWith("execution-sessions/sessions/") || !file.logicalPath.endsWith(".json")) continue;
    let envelope;
    try { envelope = JSON.parse(Buffer.from(file.dataBase64, "base64").toString("utf8")); } catch { throw new Error("execution session envelope is not valid JSON"); }
    const stored = envelope?.payload;
    const session = stored?.session;
    const base = stored && typeof stored === "object" ? { ...stored, recordHash: undefined } : undefined;
    const pathId = path.posix.basename(file.logicalPath, ".json");
    if (envelope?.schemaVersion !== "execution-repository-v1" || envelope.kind !== "execution-session"
      || envelope.checksum !== sha256Json(stored) || stored?.schemaVersion !== "execution-repository-v1"
      || stored.recordHash !== sha256Json(base) || !Number.isInteger(stored.revision) || stored.revision < 0
      || stored.runtimeGeneration !== runtimeGeneration || typeof stored.leaseToken !== "string" || !stored.leaseToken
      || !Number.isFinite(Date.parse(stored.leaseExpiresAt)) || session?.executionSessionId !== pathId
      || !["active", "completed", "stale", "abandoned"].includes(session?.status) || !Array.isArray(session.results)) throw new Error("execution session envelope/hash/generation is invalid");
    const replayReferences = stored.replayContext?.references;
    const expectedReplayReferences = replayReferences && typeof replayReferences === "object"
      ? [replayReferences.planVersionRef, replayReferences.evaluationRef, replayReferences.procedureRef, replayReferences.procedureSafetyRef, replayReferences.evaluatorArtifactRef]
      : [];
    if (expectedReplayReferences.length !== 5 || expectedReplayReferences.some((ref) => typeof ref !== "string" || !ref)
      || new Set(expectedReplayReferences).size !== expectedReplayReferences.length
      || !String(replayReferences.evaluatorArtifactRef).startsWith("sha256:")
      || replayReferences.evaluatorArtifactRef !== `sha256:${stored.replayContext?.dependencyContext?.evaluatorArtifactHash}`
      || replayReferences.planVersionRef !== `plan-version:${session.planVersionId}`
      || replayReferences.evaluationRef !== `evaluation:${session.evaluationHash}`
      || replayReferences.procedureRef !== `execution-procedure:sha256:${sha256Json(stored.replayContext?.procedure)}`
      || replayReferences.procedureSafetyRef !== `procedure-safety:${session.procedureSafetyHash}`) {
      throw new Error("execution replay reference context is invalid");
    }
    if (stored.replayContext.procedure?.procedureId !== session.procedureId
      || stored.replayContext.procedure?.inputEvaluationHash !== session.evaluationHash
      || stored.replayContext.procedure?.procedureSafetyHash !== session.procedureSafetyHash
      || stored.replayContext.dependencyContext?.expectedInputEvaluationHash !== session.evaluationHash
      || stored.replayContext.dependencyContext?.expectedProcedureSafetyHash !== session.procedureSafetyHash) {
      throw new Error("execution replay procedure binding is invalid");
    }
    const observationIds = [...new Set(session.results.flatMap((result) => Array.isArray(result?.observationIds) ? result.observationIds : []))].sort(compare);
    sessions.push({
      executionSessionId: session.executionSessionId,
      sessionRef: `execution-session:${session.executionSessionId}`,
      replayRefs: [...expectedReplayReferences].sort(compare),
      observationRefs: observationIds.map((id) => `observation:${id}`),
    });
  }
  sessions.sort((left, right) => compare(left.executionSessionId, right.executionSessionId));
  const ids = sessions.map((session) => session.executionSessionId);
  if (declaredIds !== undefined) {
    const declared = Array.isArray(declaredIds) ? [...declaredIds].sort(compare) : [];
    if (!Array.isArray(declaredIds) || new Set(declaredIds).size !== declaredIds.length || declared.some((id, index) => id !== ids[index]) || declared.length !== ids.length) {
      throw new Error("declared executionSessionIds do not exact-match the runtime snapshot");
    }
  }
  if (sessions.length && !referenceGraph) throw new Error("execution replay closure requires a consistent reference graph");
  if (referenceGraph) {
    const nodes = new Set(referenceGraph.nodes);
    const edges = new Set(referenceGraph.edges.map((edge) => `${edge.fromRef}\0${edge.toRef}\0${edge.necessity}`));
    for (const session of sessions) {
      if (!nodes.has(session.sessionRef)) throw new Error("execution session is missing from the consistent reference graph");
      for (const requiredRef of [...session.replayRefs, ...session.observationRefs]) if (!nodes.has(requiredRef) || !edges.has(`${session.sessionRef}\0${requiredRef}\0required_for_replay`)) {
        throw new Error("execution replay reference closure is incomplete");
      }
    }
  }
  return { ids, sessions };
}
async function activeRoots(activeRoot) {
  const discovered = [];
  for (const entry of await readdir(activeRoot, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) discovered.push(entry.name);
  return [...new Set([...RUNTIME_REQUIRED_ROOTS, ...discovered])].sort(compare);
}

async function availableAttachmentBlobHashes(files) {
  const hashes = new Set();
  for (const file of files) {
    if (!file.logicalPath.startsWith("attachments/metadata/")) continue;
    if (file.symlink) throw new Error("attachment metadata symlink blocks backup");
    if (!file.logicalPath.endsWith(".json")) continue;
    let envelope;
    try { envelope = JSON.parse(await readFile(file.absolutePath, "utf8")); }
    catch { throw new Error("attachment metadata is not valid JSON"); }
    const value = envelope?.payload;
    const base = value && typeof value === "object" ? { ...value, metadataHash: undefined } : undefined;
    if (envelope?.schemaVersion !== "attachment-repository-v1" || envelope.kind !== "attachment"
      || envelope.checksum !== sha256Json(value) || value?.metadataHash !== sha256Json(base)
      || !/^[a-f0-9]{64}$/.test(String(value?.contentHash ?? ""))
      || !["available", "deleted_tombstone"].includes(value?.status)) {
      throw new Error("attachment metadata integrity blocks backup");
    }
    if (value.status === "available") hashes.add(value.contentHash);
  }
  return hashes;
}

export async function createBackup(options) {
  const { coordinator, outputFile, password } = options ?? {};
  if (!coordinator || typeof outputFile !== "string") throw new TypeError("backup requires coordinator and outputFile");
  assertPassword(password);
  const mode = options.mode ?? "full_local_backup";
  if (mode !== "full_local_backup" && mode !== "plan_portable") throw new TypeError("backup mode is invalid");
  if (mode === "plan_portable") throw new Error("plan_portable requires the U12 scoped closure exporter and cannot use the full-runtime backup path");
  const createdAt = (options.now ?? (() => new Date().toISOString()))();
  const captured = await coordinator.withConsistentSnapshot(async ({ state, activeRoot }) => {
    const referenceGraph = await createProductionReferenceGraphAtSnapshot({ state, activeRoot, now: () => createdAt });
    if (options.referenceGraph !== undefined && options.referenceGraph?.graphHash !== referenceGraph.graphHash) {
      throw new Error("caller reference graph is stale or does not match the production composition");
    }
    const roots = await activeRoots(activeRoot);
    const files = [];
    const excludedKinds = new Set(SECRET_KINDS);
    const runtimeFiles = await listRegularFiles(activeRoot);
    const availableAttachmentHashes = await availableAttachmentBlobHashes(runtimeFiles);
    for (const file of runtimeFiles) {
      // This record is synthesized for each package from the snapshot being
      // captured. A restored generation can already contain the prior
      // package's copy, which must not be carried forward alongside the newly
      // generated record under the same logical path.
      if (file.logicalPath === "audit/backup-runtime-snapshot.json") continue;
      const excluded = secretKind(file.logicalPath);
      if (file.symlink) { excludedKinds.add("symlink"); continue; }
      if (excluded) { excludedKinds.add(excluded); continue; }
      const attachmentBlob = /^attachments\/blobs\/sha256\/[a-f0-9]{2}\/([a-f0-9]{64})$/.exec(file.logicalPath);
      if (attachmentBlob && !availableAttachmentHashes.has(attachmentBlob[1])) {
        excludedKinds.add("deleted_attachment_bytes");
        continue;
      }
      const bytes = await readFile(file.absolutePath);
      const contentExcluded = secretContentKind(bytes);
      if (contentExcluded) {
        const governedRoot = file.logicalPath.split("/", 1)[0];
        if (["artifacts", "jobs", "execution-sessions", "observations", "attachments", "facts", "prices", "transactions", "agent", "plans", "evidence", "catalog-overlays", "domain-overlays", "snapshots", "migrations", "audit", "exports", "backups", "diagnostics"].includes(governedRoot)) {
          throw new Error("secret-bearing content inside a governed repository blocks backup closure");
        }
        excludedKinds.add(contentExcluded);
        continue;
      }
      files.push({ logicalPath: file.logicalPath, dataBase64: bytes.toString("base64") });
    }
    const sourceValidation = new Map(files.map((file) => [file.logicalPath, Buffer.from(file.dataBase64, "base64")]));
    quarantineRestoredJobPayloads(sourceValidation, state.runtimeGeneration + 1, createdAt);
    const execution = executionInventory(files, state.runtimeGeneration, referenceGraph, options.executionSessionIds);
    const snapshotPointers = roots.map((root) => {
      const inventory = files.filter((file) => file.logicalPath === root || file.logicalPath.startsWith(`${root}/`)).map((file) => {
        const bytes = Buffer.from(file.dataBase64, "base64");
        return { logicalPath: file.logicalPath, byteLength: bytes.length, sha256: sha256Bytes(bytes) };
      });
      return `runtime-root:${root}:sha256:${sha256Bytes(Buffer.from(canonicalJson(inventory), "utf8"))}`;
    });
    const snapshot = {
      schemaVersion: "runtime-backup-snapshot-v1", runtimeGeneration: state.runtimeGeneration,
      runtimeRevision: state.revision, activeRoot: state.activeRoot,
      repositoryRoots: roots, snapshotPointers, referenceGraphHash: referenceGraph.graphHash,
      executionReferenceClosure: execution.sessions,
      closureLimitations: [],
    };
    files.push({ logicalPath: "audit/backup-runtime-snapshot.json", dataBase64: Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`).toString("base64") });
    files.sort((left, right) => compare(left.logicalPath, right.logicalPath));
    const entries = files.map((file) => {
      const bytes = Buffer.from(file.dataBase64, "base64");
      return { logicalPath: file.logicalPath, kind: entryKind(file.logicalPath), byteLength: bytes.length, sha256: sha256Bytes(bytes), privacyClass: privacyClass(file.logicalPath) };
    });
    const base = {
      schemaVersion: "backup-v1", backupId: options.backupId ?? `backup-${randomUUID()}`, createdAt,
      appVersion: options.appVersion ?? state.appVersion, runtimeGeneration: state.runtimeGeneration,
      entries, includedRoots: roots, excludedEntries: [...excludedKinds].sort(compare).map((kind) => ({ kind, reason: "excluded by full-backup secret/symlink policy" })),
      planIds: options.planIds ?? [], requirementSpecHashes: options.requirementSpecHashes ?? [],
      factSnapshotIds: options.factSnapshotIds ?? [], userObservationSnapshotIds: options.userObservationSnapshotIds ?? [],
      priceSnapshotIds: options.priceSnapshotIds ?? [], evaluationHashes: options.evaluationHashes ?? [],
      artifactLockfileRef: options.artifactLockfileRef ?? "unavailable:runtime-artifact-lockfile",
      executionSessionIds: execution.ids, mode,
      ...(mode === "plan_portable" ? { portableProfile: options.portableProfile } : {}),
    };
    const manifest = { ...base, manifestHash: manifestHash(base) };
    return { manifest, files, snapshot, referenceGraph };
  });

  const inner = { schemaVersion: PAYLOAD_VERSION, manifest: captured.result.manifest, snapshot: captured.result.snapshot, referenceGraph: captured.result.referenceGraph, files: captured.result.files };
  assertManifest(inner.manifest, inner.snapshot, inner.referenceGraph);
  const plaintext = encodePayload(inner);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const publicParameters = publicEncryptionParameters(salt, nonce);
  const aad = aadFor(inner.manifest.manifestHash, publicParameters);
  const key = await deriveKey(password, salt, KDF_PARAMS);
  let ciphertext;
  let authTag;
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    authTag = cipher.getAuthTag();
  } finally { key.fill(0); }
  const envelope = {
    formatVersion: FORMAT_VERSION, manifestHash: inner.manifest.manifestHash,
    payloadSha256: sha256Bytes(ciphertext), payloadSha256Basis: "ciphertext",
    encryption: { ...publicParameters, authTagBase64: authTag.toString("base64"), aadSha256: sha256Bytes(aad) },
  };
  const packageValue = { schemaVersion: "buildsim-backup-package-v1", envelope, ciphertextBase64: ciphertext.toString("base64") };
  await atomicWriteFile(path.resolve(outputFile), `${JSON.stringify(packageValue)}\n`, { mode: 0o600 });
  return { manifest: inner.manifest, envelope, snapshot: inner.snapshot, outputFile: path.resolve(outputFile) };
}

export async function openBackup(inputFile, password) {
  assertPassword(password);
  const parsed = JSON.parse(await readFile(path.resolve(inputFile), "utf8"));
  if (!parsed || parsed.schemaVersion !== "buildsim-backup-package-v1" || !parsed.envelope || typeof parsed.ciphertextBase64 !== "string") throw new Error("backup package structure invalid");
  const envelope = parsed.envelope;
  const encryption = envelope.encryption;
  if (envelope.formatVersion !== FORMAT_VERSION || envelope.payloadSha256Basis !== "ciphertext" || encryption?.mode !== "authenticated"
    || encryption.kdf !== "scrypt" || encryption.cipher !== "aes-256-gcm" || encryption.keyLengthBits !== 256
    || !Number.isInteger(encryption.kdfParams?.n) || encryption.kdfParams.n < 32_768 || encryption.kdfParams.n > 1_048_576
    || (encryption.kdfParams.n & (encryption.kdfParams.n - 1)) !== 0 || !Number.isInteger(encryption.kdfParams?.r)
    || encryption.kdfParams.r < 8 || encryption.kdfParams.r > 32 || !Number.isInteger(encryption.kdfParams?.p)
    || encryption.kdfParams.p < 1 || encryption.kdfParams.p > 16) throw new Error("backup encryption envelope invalid");
  const ciphertext = Buffer.from(parsed.ciphertextBase64, "base64");
  if (sha256Bytes(ciphertext) !== envelope.payloadSha256) throw new Error("backup ciphertext hash mismatch");
  const salt = Buffer.from(encryption.kdfParams.saltBase64, "base64");
  const nonce = Buffer.from(encryption.nonceBase64, "base64");
  const authTag = Buffer.from(encryption.authTagBase64, "base64");
  if (salt.length < 16 || nonce.length !== 12 || authTag.length !== 16) throw new Error("backup cryptographic parameters invalid");
  const { authTagBase64: _tag, aadSha256: _aadHash, ...publicParameters } = encryption;
  const aad = aadFor(envelope.manifestHash, publicParameters);
  if (sha256Bytes(aad) !== encryption.aadSha256) throw new Error("backup authenticated metadata mismatch");
  const key = await deriveKey(password, salt, encryption.kdfParams);
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { throw new Error("backup authentication failed"); }
  finally { key.fill(0); }
  const inner = JSON.parse(plaintext.toString("utf8"));
  if (inner?.schemaVersion !== PAYLOAD_VERSION || inner.manifest?.manifestHash !== envelope.manifestHash || !Array.isArray(inner.files)) throw new Error("backup inner manifest integrity failed");
  assertManifest(inner.manifest, inner.snapshot, inner.referenceGraph);
  return { envelope, inner, stagedPayloadSha256: envelope.payloadSha256 };
}

function assertPayloadFiles(inner) {
  const files = new Map();
  for (const file of inner.files) {
    if (!file || !safeLogicalPath(file.logicalPath) || typeof file.dataBase64 !== "string" || files.has(file.logicalPath)) throw new Error("backup contains unsafe or duplicate path");
    if (secretKind(file.logicalPath)) throw new Error("backup contains a forbidden secret path");
    const bytes = Buffer.from(file.dataBase64, "base64");
    if (bytes.toString("base64") !== file.dataBase64) throw new Error("backup entry encoding invalid");
    files.set(file.logicalPath, bytes);
  }
  const manifestEntries = new Map(inner.manifest.entries.map((entry) => [entry.logicalPath, entry]));
  if (manifestEntries.size !== inner.manifest.entries.length || manifestEntries.size !== files.size) throw new Error("backup manifest file coverage mismatch");
  const checks = [];
  for (const [logicalPath, bytes] of files) {
    const expected = manifestEntries.get(logicalPath);
    const actualHash = sha256Bytes(bytes);
    if (!expected || expected.byteLength !== bytes.length || expected.sha256 !== actualHash) throw new Error("backup entry hash mismatch");
    checks.push({ logicalPath, expectedByteLength: expected.byteLength, actualByteLength: bytes.length, expectedSha256: expected.sha256, actualSha256: actualHash });
  }
  return { files, checks: checks.sort((left, right) => compare(left.logicalPath, right.logicalPath)) };
}

async function materialize(files, root) {
  for (const [logicalPath, bytes] of files) {
    const target = confined(root, ...logicalPath.split("/"));
    await atomicWriteFile(target, bytes, { mode: 0o600 });
  }
}

function quarantineRestoredJobPayloads(files, runtimeGeneration, restoredAt) {
  const terminal = new Set(["succeeded", "failed", "cancelled", "dead_letter"]);
  for (const [logicalPath, bytes] of files) {
    if (!logicalPath.endsWith(".json")) continue;
    const standard = logicalPath.startsWith("jobs/records/");
    const catalog = logicalPath.startsWith("jobs/catalog-search/records/");
    if (!standard && !catalog) continue;
    let envelope;
    try { envelope = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("restored job record is not valid JSON"); }
    if (standard && (envelope?.schemaVersion !== "job-store-envelope-v1" || envelope.kind !== "background-job"
      || envelope.checksum !== sha256Json(envelope.payload))) throw new Error("restored job record is corrupt");
    if (catalog && (envelope?.schemaVersion !== "catalog-search-store-envelope-v1" || envelope.kind !== "catalog-search-job"
      || envelope.checksum !== sha256Json(envelope.payload) || !envelope.payload?.catalog)) throw new Error("restored catalog job record is corrupt");
    const pathJobId = path.posix.basename(logicalPath, ".json");
    const payload = standard
      ? restoreRuntimeBackgroundJob(envelope.payload, runtimeGeneration, restoredAt)
      : { ...envelope.payload, job: restoreRuntimeBackgroundJob(envelope.payload.job, runtimeGeneration, restoredAt, { jobIdPattern: /^catalog-search-[a-f0-9]{20}$/ }), catalog: {
        ...envelope.payload.catalog,
        ...(terminal.has(envelope.payload.job.status) ? {} : { stage: "paused_restore_review" }),
      } };
    const restoredJob = standard ? payload : payload.job;
    if (restoredJob.jobId !== pathJobId || (catalog && (typeof payload.catalog?.stage !== "string" || !payload.catalog.stage))) {
      throw new Error("restored job path identity or catalog checkpoint is invalid");
    }
    files.set(logicalPath, Buffer.from(`${JSON.stringify({ ...envelope, checksum: sha256Json(payload), payload }, null, 2)}\n`, "utf8"));
  }
}

function fenceRestoredExecutionPayloads(files, runtimeGeneration, restoredAt) {
  for (const [logicalPath, bytes] of files) {
    if (!logicalPath.startsWith("execution-sessions/sessions/") || !logicalPath.endsWith(".json")) continue;
    let envelope;
    try { envelope = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("restored execution session is not valid JSON"); }
    const stored = envelope?.payload;
    const baseForHash = stored && typeof stored === "object" ? { ...stored, recordHash: undefined } : undefined;
    if (envelope?.schemaVersion !== "execution-repository-v1" || envelope.kind !== "execution-session"
      || envelope.checksum !== sha256Json(stored) || stored?.recordHash !== sha256Json(baseForHash)
      || !Number.isInteger(stored.runtimeGeneration) || stored.runtimeGeneration >= runtimeGeneration || !stored.session) throw new Error("restored execution session envelope is corrupt or not from an older generation");
    const session = stored.session.status === "active"
      ? { ...stored.session, status: "stale", staleReason: "runtime_restored_requires_review" }
      : stored.session;
    const nextBase = {
      ...stored, recordHash: undefined, revision: stored.revision + 1, runtimeGeneration,
      leaseToken: `restore-fenced-${randomUUID()}`, leaseExpiresAt: restoredAt, session,
    };
    const payload = { ...nextBase, recordHash: sha256Json(nextBase) };
    files.set(logicalPath, Buffer.from(`${JSON.stringify({ ...envelope, checksum: sha256Json(payload), payload }, null, 2)}\n`, "utf8"));
  }
}

export async function verifyBackup({ inputFile, password, now = () => new Date().toISOString() }) {
  const opened = await openBackup(inputFile, password);
  const { files, checks } = assertPayloadFiles(opened.inner);
  const stagedValidation = new Map([...files].map(([logicalPath, bytes]) => [logicalPath, Buffer.from(bytes)]));
  const validationGeneration = opened.inner.manifest.runtimeGeneration + 1;
  const validationTimestamp = now();
  quarantineRestoredJobPayloads(stagedValidation, validationGeneration, validationTimestamp);
  fenceRestoredExecutionPayloads(stagedValidation, validationGeneration, validationTimestamp);
  const temporary = await mkdtemp(path.join(tmpdir(), "buildsim-backup-verify-"));
  try {
    await ensurePrivateDirectory(temporary);
    await materialize(files, temporary);
    const sourceState = {
      runtimeGeneration: opened.inner.manifest.runtimeGeneration,
      revision: opened.inner.snapshot.runtimeRevision,
    };
    const regeneratedGraph = await validateProductionRuntimeRoot({ state: sourceState, activeRoot: temporary, now: () => opened.inner.referenceGraph.createdAt });
    const expectedSnapshots = new Map(opened.inner.referenceGraph.providerSnapshots.map((snapshot) => [snapshot.providerId, snapshot]));
    for (const snapshot of regeneratedGraph.providerSnapshots) {
      if (snapshot.providerId === "runtime/config") continue;
      const expected = expectedSnapshots.get(snapshot.providerId);
      if (!expected || expected.revision !== snapshot.revision || expected.manifestHash !== snapshot.manifestHash) {
        throw new Error("backup production reference providers do not reproduce from staged bytes");
      }
    }
    if (canonicalJson(regeneratedGraph.nodes) !== canonicalJson(opened.inner.referenceGraph.nodes)
      || canonicalJson(regeneratedGraph.edges) !== canonicalJson(opened.inner.referenceGraph.edges)
      || canonicalJson(regeneratedGraph.requiredRoots) !== canonicalJson(opened.inner.referenceGraph.requiredRoots)
      || canonicalJson(regeneratedGraph.snapshotPointers) !== canonicalJson(opened.inner.referenceGraph.snapshotPointers)) {
      throw new Error("backup production reference closure does not reproduce from staged bytes");
    }
    await materialize(stagedValidation, temporary);
    await validateProductionRuntimeRoot({
      state: { runtimeGeneration: validationGeneration, revision: sourceState.revision + 1 },
      activeRoot: temporary,
      now: () => opened.inner.referenceGraph.createdAt,
    });
    const restoredRootHash = sha256Bytes(Buffer.from(canonicalJson(checks.map(({ logicalPath, actualByteLength, actualSha256 }) => ({ logicalPath, byteLength: actualByteLength, sha256: actualSha256 }))), "utf8"));
    const runtimeGeneration = validationGeneration;
    const temporaryRestoreArtifact = {
      schemaVersion: "temporary-restore-artifact-v1", backupId: opened.inner.manifest.backupId,
      manifestHash: opened.inner.manifest.manifestHash, runtimeGeneration, restoredRootHash, entryCount: checks.length,
    };
    const artifact = artifactRef(temporaryRestoreArtifact);
    const temporaryRestoreReport = {
      schemaVersion: "temporary-restore-report-v1", backupId: opened.inner.manifest.backupId,
      manifestHash: opened.inner.manifest.manifestHash, runtimeGeneration, restoreArtifactRef: artifact.ref,
      checkedEntryCount: checks.length, result: "pass",
    };
    const reportRef = artifactRef(temporaryRestoreReport);
    const report = {
      backupId: opened.inner.manifest.backupId, manifestHash: opened.inner.manifest.manifestHash,
      stagedPayloadSha256: opened.stagedPayloadSha256, verifiedAt: now(), appVersion: opened.inner.manifest.appVersion,
      schemaVersion: "backup-verification-v1", entryChecks: checks,
      temporaryRestore: { artifactRef: artifact, reportRef, restoredManifestHash: opened.inner.manifest.manifestHash, runtimeGeneration }, result: "pass",
    };
    const result = { valid: true, manifest: opened.inner.manifest, envelope: opened.envelope, snapshot: opened.inner.snapshot, referenceGraph: opened.inner.referenceGraph, report, temporaryRestoreArtifact, temporaryRestoreReport };
    VERIFIED_BACKUP_RESULTS.add(result);
    VERIFIED_BACKUP_PAYLOADS.set(result, opened.inner);
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function restoreBackup(options) {
  const { coordinator, inputFile, password } = options ?? {};
  if (!coordinator) throw new TypeError("restore requires a coordinator");
  const verified = await verifyBackup({ inputFile, password, now: options.now });
  if (verified.manifest.mode !== "full_local_backup") throw new Error("active runtime restore requires full_local_backup mode");
  await coordinator.initialize(verified.manifest.appVersion);
  const lease = await coordinator.acquireMaintenanceLease(options.owner ?? "backup-restore", { ttlMs: options.leaseTtlMs ?? 300_000 });
  let staging;
  try {
    const before = await coordinator.readState();
    const targetGeneration = Math.max(before.runtimeGeneration, verified.manifest.runtimeGeneration) + 1;
    staging = await coordinator.createStagingGeneration(lease.token);
    const trustedPayload = VERIFIED_BACKUP_PAYLOADS.get(verified);
    if (!trustedPayload) throw new Error("verified backup payload identity was lost before restore");
    const { files } = assertPayloadFiles(trustedPayload);
    const restoredAt = (options.now ?? (() => new Date().toISOString()))();
    quarantineRestoredJobPayloads(files, targetGeneration, restoredAt);
    fenceRestoredExecutionPayloads(files, targetGeneration, restoredAt);
    await materialize(files, staging);
    for (const name of RUNTIME_REQUIRED_ROOTS) await ensurePrivateDirectory(confined(staging, name));
    if (typeof options.beforePointerSwitch === "function") await options.beforePointerSwitch({ staging, state: before, verified });
    // The authenticated package was verified in an isolated temporary root,
    // but the materialized staging tree is the object that will actually become
    // authority. Re-run the same production semantic composition after all
    // restore transforms/hooks and before the pointer commit.
    await validateProductionRuntimeRoot({
      state: { runtimeGeneration: targetGeneration, revision: before.revision + 1 },
      activeRoot: staging,
      now: () => restoredAt,
    });
    const state = await coordinator.activateStagingGeneration(staging, before.runtimeGeneration, lease.token, { minimumGeneration: targetGeneration });
    staging = undefined;
    return { restored: true, state, verification: verified.report };
  } catch (error) {
    if (staging) await coordinator.discardStagingGeneration(staging).catch(() => undefined);
    throw error;
  } finally {
    await coordinator.releaseMaintenanceLease(lease.token).catch(() => undefined);
  }
}

export async function backupFileMode(inputFile) { return privateMode(path.resolve(inputFile)); }

/** Runtime identity check; JSON clones and caller-fabricated reports fail. */
export function isVerifiedBackupResult(value) { return !!value && typeof value === "object" && VERIFIED_BACKUP_RESULTS.has(value); }

export function validatePersistedBackupVerificationRecord(record) {
  if (!record || record.schemaVersion !== "backup-verification-record-v1" || record.checksum !== sha256Json(record.payload)) return false;
  const value = record.payload;
  if (!value || value.schemaVersion !== "backup-verification-payload-v1" || value.report?.result !== "pass"
    || value.report.backupId !== value.manifest?.backupId || value.report.manifestHash !== value.manifest?.manifestHash
    || value.envelope?.manifestHash !== value.manifest.manifestHash || value.report.stagedPayloadSha256 !== value.envelope.payloadSha256) return false;
  try { assertManifest(value.manifest, value.snapshot, value.referenceGraph); } catch { return false; }
  const entries = new Map(value.manifest.entries.map((entry) => [entry.logicalPath, entry]));
  if (!Array.isArray(value.report.entryChecks) || entries.size !== value.report.entryChecks.length) return false;
  for (const check of value.report.entryChecks) {
    const entry = entries.get(check.logicalPath);
    if (!entry || check.expectedByteLength !== entry.byteLength || check.actualByteLength !== entry.byteLength
      || check.expectedSha256 !== entry.sha256 || check.actualSha256 !== entry.sha256) return false;
  }
  const restore = value.temporaryRestoreArtifact;
  const restoreReport = value.temporaryRestoreReport;
  return value.report.temporaryRestore?.artifactRef?.ref === artifactRef(restore).ref
    && value.report.temporaryRestore?.reportRef?.ref === artifactRef(restoreReport).ref
    && restore?.manifestHash === value.manifest.manifestHash && restoreReport?.manifestHash === value.manifest.manifestHash
    && restoreReport?.result === "pass";
}

/** Persists only a verifier-issued result inside the active backup repository. */
/** @param {{ coordinator: any, verification: any, expectedRuntimeRevision?: number }} options */
export async function persistBackupVerification({ coordinator, verification, expectedRuntimeRevision }) {
  if (!coordinator || !isVerifiedBackupResult(verification)) throw new Error("only a runner-issued backup verification can be persisted");
  const payload = {
    schemaVersion: "backup-verification-payload-v1", manifest: verification.manifest, envelope: verification.envelope,
    snapshot: verification.snapshot, referenceGraph: verification.referenceGraph, report: verification.report,
    temporaryRestoreArtifact: verification.temporaryRestoreArtifact, temporaryRestoreReport: verification.temporaryRestoreReport,
  };
  const record = { schemaVersion: "backup-verification-record-v1", checksum: sha256Json(payload), payload };
  if (!validatePersistedBackupVerificationRecord(record)) throw new Error("backup verification record failed its own binding checks");
  return coordinator.withWrite(async ({ activeRoot }) => {
    const file = confined(activeRoot, "backups", "verifications", `${verification.manifest.manifestHash}.json`);
    await atomicWriteJson(file, record);
    return { fileRef: `backups/verifications/${verification.manifest.manifestHash}.json`, backupId: verification.manifest.backupId };
  }, { expectedRevision: expectedRuntimeRevision });
}
