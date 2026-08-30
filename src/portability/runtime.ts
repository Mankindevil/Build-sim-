import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BackupEnvelope, BackupManifest, ImportPlan, PortableReferenceEdge } from "../backup/contracts";
import { validateBackupEnvelope, validateBackupManifest, validateImportPlan, verifyBackupManifestHash, verifyPortableProfileClosure } from "../backup/contracts";
import { prepareStagedRuntimeGeneration, secretContentKind } from "../backup/runtime.mjs";
import { verifyArtifactLockfile, type ArtifactLockfile } from "../hash";
import { hashPlanConfigRuntime } from "../plans/canonical-runtime.mjs";
import { planEvidenceBindingId } from "../plans/validation";
import { RuntimeCoordinator, RUNTIME_REQUIRED_ROOTS } from "../runtime/coordinator.mjs";
import {
  atomicWriteFile,
  canonicalJson,
  confined,
  ensurePrivateDirectory,
  listRegularFiles,
  pathExists,
  readJson,
  sha256Bytes,
  sha256Json,
} from "../runtime/fs.mjs";
import {
  createProductionReferenceGraphAtSnapshot,
  validateProductionRuntimeRoot,
} from "../runtime/production-reference-graph.mjs";
import { portableReferenceGraphHash, verifyReferenceGraph } from "../runtime/reference-graph.mjs";
import {
  PORTABLE_PACKAGE_SCHEMA_VERSION,
  PORTABLE_PAYLOAD_SCHEMA_VERSION,
  type PortablePlanPackage,
  type PortablePlanPayload,
  type PortableReferenceGraph,
} from "./contracts";

const FORMAT_VERSION = "buildsim-plan-portable-envelope-v1";
const MANIFEST_PREFIX = "buildsim\0hash-spec-v1\0backup-manifest\0backup-v1\0";
const PAYLOAD_LIMIT = 512 * 1024 * 1024;
const ENTRY_LIMIT = 128 * 1024 * 1024;
const FILE_COUNT_LIMIT = 100_000;
const KDF_PARAMS = Object.freeze({ n: 32_768, r: 8, p: 1 });
const SAFE_PLAN_ID = /^[a-z0-9][a-z0-9-]{7,79}$/;
const PORTABLE_EXCLUDED_ROOTS = new Set(["backups", "diagnostics", "exports"]);
const PORTABLE_SECRET_PATTERN = /(^|[\/_\.\-])(\.env|cookie|cookies|api[-_]?key|provider[-_]?key|secret|password|access[-_]?token|refresh[-_]?token|browser[-_ ]?profile)([\/_\.\-]|$)/i;

interface RuntimeReferenceGraph {
  readonly runtimeGeneration: number;
  readonly runtimeRevision: number;
  readonly createdAt: string;
  readonly nodes: readonly string[];
  readonly edges: readonly PortableReferenceEdge[];
  readonly snapshotPointers: readonly string[];
}
type StoredFile = { logicalPath: string; bytes: Buffer };

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function unique(values: readonly string[]): string[] { return [...new Set(values)].sort(compare); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function safeLogicalPath(value: string): boolean {
  return value.length > 0 && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && value.split(/[\\/]/).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
function assertPassword(password: string): void {
  if (typeof password !== "string" || Buffer.byteLength(password, "utf8") < 12) throw new TypeError("portable package password must contain at least 12 UTF-8 bytes");
}
function manifestHash(value: Omit<BackupManifest, "manifestHash">): string {
  return sha256Bytes(Buffer.from(`${MANIFEST_PREFIX}${canonicalJson(value).normalize("NFC")}`, "utf8"));
}
function aadFor(manifestDigest: string, publicParameters: object): Buffer {
  return Buffer.from(canonicalJson({ formatVersion: FORMAT_VERSION, manifestHash: manifestDigest, encryption: publicParameters }), "utf8");
}
async function deriveKey(password: string, salt: Buffer, params: { n: number; r: number; p: number }): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => scryptCallback(
    password,
    salt,
    32,
    { N: params.n, r: params.r, p: params.p, maxmem: 128 * params.n * params.r + 16 * 1024 * 1024 },
    (error, value) => error ? reject(error) : resolve(value),
  ));
}
function exactEnvelope(value: unknown, schemaVersion: string, kind: string): value is { payload: Record<string, unknown>; checksum: string } {
  return isRecord(value) && value.schemaVersion === schemaVersion && value.kind === kind && isRecord(value.payload)
    && typeof value.checksum === "string" && value.checksum === sha256Json(value.payload);
}
function planEnvelopeFrom(files: Map<string, Buffer>, planId: string): { logicalPath: string; envelope: { payload: Record<string, unknown>; checksum: string } } {
  const logicalPath = `plans/${planId}/plan.json`;
  const bytes = files.get(logicalPath);
  if (!bytes) throw new Error("portable package plan record is missing");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("portable package plan record is malformed"); }
  if (!exactEnvelope(value, "1.0.0", "plan") || value.payload.id !== planId) throw new Error("portable package plan record is invalid");
  return { logicalPath, envelope: value };
}
function referenceTokens(ref: string): string[] {
  const tokens = [ref];
  const parts = ref.split(":");
  for (const part of parts) if (part.length >= 8) tokens.push(part);
  const tail = ref.slice(ref.indexOf(":") + 1);
  if (tail.length >= 8) tokens.push(tail);
  return unique(tokens);
}
function fileMentionsRef(file: StoredFile, ref: string): boolean {
  const haystack = `${file.logicalPath}\n${file.bytes.length <= 16 * 1024 * 1024 ? file.bytes.toString("utf8") : ""}`;
  return referenceTokens(ref).some((token) => haystack.includes(token));
}
function reachableGraph(source: RuntimeReferenceGraph, seeds: readonly string[], includeAudit: boolean): { nodes: string[]; edges: PortableReferenceEdge[] } {
  const allowedNecessity = includeAudit ? new Set(["required_for_replay", "optional_for_audit"]) : new Set(["required_for_replay"]);
  const reached = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const from = queue.shift()!;
    for (const edge of source.edges) if (edge.fromRef === from && allowedNecessity.has(edge.necessity) && !reached.has(edge.toRef)) {
      reached.add(edge.toRef); queue.push(edge.toRef);
    }
  }
  return {
    nodes: unique([...reached]),
    edges: source.edges.filter((edge) => reached.has(edge.fromRef) && reached.has(edge.toRef) && allowedNecessity.has(edge.necessity))
      .sort((left, right) => compare(canonicalJson(left), canonicalJson(right))),
  };
}
function planScopedSeeds(graph: RuntimeReferenceGraph, planRef: string): string[] {
  const seeds = new Set([planRef]);
  for (const edge of graph.edges) {
    if (edge.toRef === planRef && !edge.fromRef.startsWith("runtime-repository:")) seeds.add(edge.fromRef);
  }
  return unique([...seeds]);
}
function artifactLockfileHash(files: Map<string, Buffer>, planId: string): string | null {
  const plan = planEnvelopeFrom(files, planId).envelope.payload;
  const activeVersionId = typeof plan.activeVersionId === "string" ? plan.activeVersionId : null;
  if (!activeVersionId) return null;
  const bytes = files.get(`plans/${planId}/versions/${activeVersionId}.json`);
  if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  return exactEnvelope(value, "1.0.0", "version") && isRecord(value.payload.evaluationLock)
    && typeof value.payload.evaluationLock.artifactLockfileHash === "string"
    ? value.payload.evaluationLock.artifactLockfileHash : null;
}
function parseArtifactLockfile(files: Map<string, Buffer>, hash: string): ArtifactLockfile {
  const candidates = [...files].filter(([logicalPath]) => logicalPath.includes(hash) && logicalPath.endsWith(".json"));
  for (const [, bytes] of candidates) {
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { continue; }
    const payload = isRecord(value) && isRecord(value.payload) ? value.payload : value;
    if (isRecord(payload) && payload.lockfileHash === hash) return payload as unknown as ArtifactLockfile;
  }
  throw new Error("portable package artifact lockfile is missing");
}
async function activeFiles(activeRoot: string): Promise<StoredFile[]> {
  const result: StoredFile[] = [];
  for (const file of await listRegularFiles(activeRoot)) {
    if (file.symlink) throw new Error("portable export source contains a symbolic link");
    if (!safeLogicalPath(file.logicalPath) || PORTABLE_SECRET_PATTERN.test(file.logicalPath)) continue;
    const root = file.logicalPath.split("/", 1)[0]!;
    if (PORTABLE_EXCLUDED_ROOTS.has(root)) continue;
    const bytes = await readFile(file.absolutePath);
    if (bytes.length > ENTRY_LIMIT) throw new Error("portable source entry exceeds the bounded entry size");
    result.push({ logicalPath: file.logicalPath, bytes });
  }
  return result;
}
function selectFiles(allFiles: StoredFile[], planId: string, refs: readonly string[], profile: "slim" | "complete"): StoredFile[] {
  const selected = new Map<string, StoredFile>();
  for (const file of allFiles) {
    if (file.logicalPath.startsWith(`plans/${planId}/`)) selected.set(file.logicalPath, file);
    if (profile === "complete" && refs.some((ref) => fileMentionsRef(file, ref))) selected.set(file.logicalPath, file);
    if (profile === "complete" && (file.logicalPath.startsWith("catalog-overlays/") || file.logicalPath.startsWith("domain-overlays/"))) selected.set(file.logicalPath, file);
  }
  return [...selected.values()].sort((left, right) => compare(left.logicalPath, right.logicalPath));
}
function assertPortableSecretPolicy(files: readonly StoredFile[]): void {
  for (const file of files) {
    if (PORTABLE_SECRET_PATTERN.test(file.logicalPath)) throw new Error("portable closure contains a forbidden secret path");
    if (secretContentKind(file.bytes)) throw new Error("secret-bearing content inside the portable closure blocks export");
  }
}
function portableGraph(source: RuntimeReferenceGraph, closure: { nodes: string[]; edges: PortableReferenceEdge[] }, roots: string[], aliases: string[]): PortableReferenceGraph {
  const nodes = unique([...closure.nodes, ...aliases]);
  const edges = closure.edges.filter((edge) => nodes.includes(edge.fromRef) && nodes.includes(edge.toRef));
  const base = {
    graphVersion: "portable-reference-graph-v1" as const,
    runtimeGeneration: source.runtimeGeneration,
    runtimeRevision: source.runtimeRevision,
    createdAt: source.createdAt,
    nodes,
    edges,
    requiredRoots: unique(roots),
    snapshotPointers: source.snapshotPointers.filter((ref) => nodes.includes(ref)).sort(compare),
    providerSnapshots: [] as const,
  };
  return { ...base, graphHash: portableReferenceGraphHash(base) };
}
async function materializePortableFiles(files: readonly StoredFile[], root: string): Promise<void> {
  for (const file of files) await atomicWriteFile(confined(root, ...file.logicalPath.split("/")), file.bytes, { mode: 0o600 });
  for (const name of RUNTIME_REQUIRED_ROOTS) await ensurePrivateDirectory(confined(root, name));
}
function manifestEntries(files: readonly StoredFile[]): BackupManifest["entries"] {
  return files.map(({ logicalPath, bytes }) => ({
    logicalPath, kind: "portable_record", byteLength: bytes.length, sha256: sha256Bytes(bytes),
    privacyClass: logicalPath.startsWith("artifacts/") || logicalPath.startsWith("snapshots/") ? "runtime_internal" : "private_user",
  }));
}

export async function createPortablePlanPackage(options: {
  coordinator: RuntimeCoordinator;
  outputFile: string;
  password: string;
  planId: string;
  portableProfile: "slim" | "complete";
  redacted?: boolean;
  now?: () => string;
  appVersion?: string;
}): Promise<{ manifest: BackupManifest & { mode: "plan_portable" }; outputFile: string; exactReplayReady: boolean }> {
  if (!options.coordinator || typeof options.outputFile !== "string" || !SAFE_PLAN_ID.test(options.planId)) throw new TypeError("portable export input is invalid");
  if (!['slim', 'complete'].includes(options.portableProfile)) throw new TypeError("portable profile is invalid");
  assertPassword(options.password);
  const createdAt = (options.now ?? (() => new Date().toISOString()))();
  const captured = await options.coordinator.withConsistentSnapshot(async ({ state, activeRoot }: { state: { runtimeGeneration: number; revision: number; appVersion: string }; activeRoot: string }) => {
    const sourceGraph = await createProductionReferenceGraphAtSnapshot({ state, activeRoot, now: () => createdAt }) as RuntimeReferenceGraph;
    const planRef = `plan:${options.planId}`;
    if (!sourceGraph.nodes.includes(planRef)) throw new Error("portable export plan was not found in the production reference graph");
    const seeds = planScopedSeeds(sourceGraph, planRef);
    const closure = reachableGraph(sourceGraph, seeds, options.redacted !== true);
    const all = await activeFiles(activeRoot);
    const selected = selectFiles(all, options.planId, closure.nodes, options.portableProfile);
    assertPortableSecretPolicy(selected);
    const selectedMap = new Map(selected.map((file) => [file.logicalPath, file.bytes]));
    const planRecord = planEnvelopeFrom(selectedMap, options.planId);
    const sourcePlanHash = sha256Json(planRecord.envelope.payload);
    const lockHash = artifactLockfileHash(selectedMap, options.planId);
    if (options.portableProfile === "complete" && !lockHash) throw new Error("complete portable export requires an active governed plan version and artifact lockfile");
    const lockfile = lockHash ? parseArtifactLockfile(selectedMap, lockHash) : null;
    if (lockfile && !await verifyArtifactLockfile(lockfile)) throw new Error("portable export artifact lockfile failed verification");
    const aliases = lockfile
      ? [`sha256:${lockfile.lockfileHash}`, ...Object.values(lockfile.artifacts).map((artifact) => artifact.ref)]
      : [];
    const graph = portableGraph(sourceGraph, closure, seeds, aliases);
    const includedRefs = unique([...graph.nodes]);
    const includedRoots = unique(selected.map((file) => file.logicalPath.split("/", 1)[0]!));
    const plan = planRecord.envelope.payload;
    const activeVersionId = typeof plan.activeVersionId === "string" ? plan.activeVersionId : null;
    let activeVersion: Record<string, unknown> | null = null;
    if (activeVersionId) {
      const raw = selectedMap.get(`plans/${options.planId}/versions/${activeVersionId}.json`);
      if (raw) { const parsed: unknown = JSON.parse(raw.toString("utf8")); if (exactEnvelope(parsed, "1.0.0", "version")) activeVersion = parsed.payload; }
    }
    const entries = manifestEntries(selected);
    const base = {
      schemaVersion: "backup-v1" as const,
      backupId: `portable-${randomUUID()}`,
      createdAt,
      appVersion: options.appVersion ?? state.appVersion,
      runtimeGeneration: state.runtimeGeneration,
      entries,
      includedRoots,
      excludedEntries: [
        { kind: "secret", reason: "excluded by portable secret policy" },
        ...(options.redacted === true ? [{ kind: "optional_audit", reason: "excluded by redacted portable profile" }] : []),
      ],
      planIds: [options.planId],
      requirementSpecHashes: [],
      factSnapshotIds: activeVersion && isRecord(activeVersion.evaluationLock) && typeof activeVersion.evaluationLock.factSnapshotId === "string" ? [activeVersion.evaluationLock.factSnapshotId] : [],
      userObservationSnapshotIds: activeVersion && isRecord(activeVersion.evaluationLock) && typeof activeVersion.evaluationLock.userObservationSnapshotId === "string" ? [activeVersion.evaluationLock.userObservationSnapshotId] : [],
      priceSnapshotIds: [],
      evaluationHashes: activeVersion && typeof activeVersion.evaluationHash === "string" ? [activeVersion.evaluationHash] : [],
      artifactLockfileRef: lockHash ? `sha256:${lockHash}` : "unavailable:current-runtime-reevaluation",
      executionSessionIds: closure.nodes.filter((ref) => ref.startsWith("execution-session:")).map((ref) => ref.slice("execution-session:".length)).sort(compare),
      mode: "plan_portable" as const,
      portableProfile: options.portableProfile,
    };
    const manifest = { ...base, manifestHash: manifestHash(base) } satisfies BackupManifest & { mode: "plan_portable" };
    if (validateBackupManifest(manifest).length || (await verifyBackupManifestHash(manifest)).length) throw new Error("portable export manifest failed validation");
    if (options.portableProfile === "complete") {
      const temporary = await mkdtemp(path.join(tmpdir(), "buildsim-portable-export-"));
      try {
        await materializePortableFiles(selected, temporary);
        await validateProductionRuntimeRoot({ state: { runtimeGeneration: state.runtimeGeneration, revision: state.revision }, activeRoot: temporary, now: () => createdAt });
      } finally { await rm(temporary, { recursive: true, force: true }); }
      const closureResult = await verifyPortableProfileClosure(manifest, {
        trustedRepositoryGraph: graph,
        requiredRoots: seeds,
        stagedIncludedRefs: includedRefs,
        artifactLockfile: lockfile!,
      });
      if (!closureResult.valid || !closureResult.exactReplayReady) throw new Error(`complete portable closure is incomplete: ${closureResult.errors.join("; ")}`);
    }
    return { manifest, sourcePlanHash, graph, selected, includedRefs };
  });
  const payload: PortablePlanPayload = {
    schemaVersion: PORTABLE_PAYLOAD_SCHEMA_VERSION,
    manifest: captured.result.manifest,
    sourcePlanId: options.planId,
    sourcePlanHash: captured.result.sourcePlanHash,
    redacted: options.redacted === true,
    requiredRefs: captured.result.graph.requiredRoots,
    includedRefs: captured.result.includedRefs,
    referenceGraph: captured.result.graph,
    files: (captured.result.selected as StoredFile[]).map(({ logicalPath, bytes }: StoredFile) => ({ logicalPath, dataBase64: bytes.toString("base64") })),
  };
  const plaintext = Buffer.from(canonicalJson(payload).normalize("NFC"), "utf8");
  if (plaintext.length > PAYLOAD_LIMIT) throw new Error("portable package exceeds the bounded payload size");
  const salt = randomBytes(16); const nonce = randomBytes(12);
  const publicParameters = { mode: "authenticated" as const, formatVersion: FORMAT_VERSION, kdf: "scrypt" as const, kdfParams: { ...KDF_PARAMS, saltBase64: salt.toString("base64") }, cipher: "aes-256-gcm" as const, keyLengthBits: 256 as const, nonceBase64: nonce.toString("base64") };
  const aad = aadFor(payload.manifest.manifestHash, publicParameters);
  const key = await deriveKey(options.password, salt, KDF_PARAMS);
  let ciphertext: Buffer; let authTag: Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); authTag = cipher.getAuthTag();
  } finally { key.fill(0); }
  const envelope: BackupEnvelope = {
    formatVersion: FORMAT_VERSION,
    manifestHash: payload.manifest.manifestHash,
    payloadSha256: sha256Bytes(ciphertext), payloadSha256Basis: "ciphertext",
    encryption: { ...publicParameters, authTagBase64: authTag.toString("base64"), aadSha256: sha256Bytes(aad) },
  };
  const packageValue: PortablePlanPackage = { schemaVersion: PORTABLE_PACKAGE_SCHEMA_VERSION, envelope, ciphertextBase64: ciphertext.toString("base64") };
  await atomicWriteFile(path.resolve(options.outputFile), `${JSON.stringify(packageValue)}\n`, { mode: 0o600 });
  return { manifest: payload.manifest, outputFile: path.resolve(options.outputFile), exactReplayReady: options.portableProfile === "complete" };
}

export interface OpenedPortablePlanPackage {
  readonly envelope: BackupEnvelope;
  readonly payload: PortablePlanPayload;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly artifactLockfile: ArtifactLockfile | null;
  readonly exactReplayReady: boolean;
}

export async function openPortablePlanPackage(inputFile: string, password: string): Promise<OpenedPortablePlanPackage> {
  assertPassword(password);
  const raw = await readFile(path.resolve(inputFile));
  if (raw.length > PAYLOAD_LIMIT * 2) throw new Error("portable package exceeds the bounded encoded size");
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch { throw new Error("portable package is not valid JSON"); }
  if (!isRecord(parsed) || parsed.schemaVersion !== PORTABLE_PACKAGE_SCHEMA_VERSION || !isRecord(parsed.envelope) || typeof parsed.ciphertextBase64 !== "string") throw new Error("portable package structure invalid");
  const envelope = parsed.envelope as unknown as BackupEnvelope;
  const encryption = envelope.encryption;
  if (envelope.formatVersion !== FORMAT_VERSION || encryption.mode !== "authenticated" || encryption.formatVersion !== FORMAT_VERSION
    || encryption.kdf !== "scrypt" || encryption.cipher !== "aes-256-gcm" || encryption.keyLengthBits !== 256
    || encryption.kdfParams.n !== KDF_PARAMS.n || encryption.kdfParams.r !== KDF_PARAMS.r || encryption.kdfParams.p !== KDF_PARAMS.p) throw new Error("portable package encryption parameters invalid");
  const ciphertext = Buffer.from(parsed.ciphertextBase64, "base64");
  if (ciphertext.toString("base64") !== parsed.ciphertextBase64 || ciphertext.length > PAYLOAD_LIMIT || sha256Bytes(ciphertext) !== envelope.payloadSha256) throw new Error("portable package ciphertext is invalid");
  const salt = Buffer.from(encryption.kdfParams.saltBase64, "base64"); const nonce = Buffer.from(encryption.nonceBase64, "base64"); const tag = Buffer.from(encryption.authTagBase64, "base64");
  if (salt.length !== 16 || nonce.length !== 12 || tag.length !== 16) throw new Error("portable package cryptographic parameters invalid");
  const { authTagBase64: _tag, aadSha256: _aad, ...publicParameters } = encryption;
  const aad = aadFor(envelope.manifestHash, publicParameters);
  if (sha256Bytes(aad) !== encryption.aadSha256) throw new Error("portable package authenticated metadata mismatch");
  const key = await deriveKey(password, salt, encryption.kdfParams);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce); decipher.setAAD(aad); decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { throw new Error("portable package authentication failed"); }
  finally { key.fill(0); }
  let payload: unknown;
  try { payload = JSON.parse(plaintext.toString("utf8")); } catch { throw new Error("portable payload is not valid JSON"); }
  if (!isRecord(payload) || payload.schemaVersion !== PORTABLE_PAYLOAD_SCHEMA_VERSION || !isRecord(payload.manifest)
    || payload.manifest.mode !== "plan_portable" || typeof payload.sourcePlanId !== "string" || !SAFE_PLAN_ID.test(payload.sourcePlanId)
    || typeof payload.sourcePlanHash !== "string" || !/^[a-f0-9]{64}$/.test(payload.sourcePlanHash)
    || typeof payload.redacted !== "boolean" || !Array.isArray(payload.files) || payload.files.length < 1 || payload.files.length > FILE_COUNT_LIMIT
    || !Array.isArray(payload.requiredRefs) || !Array.isArray(payload.includedRefs) || !isRecord(payload.referenceGraph)) throw new Error("portable payload structure invalid");
  const manifest = payload.manifest as unknown as BackupManifest & { mode: "plan_portable" };
  if (envelope.manifestHash !== manifest.manifestHash || validateBackupEnvelope(envelope, manifest).length
    || validateBackupManifest(manifest).length || (await verifyBackupManifestHash(manifest)).length) throw new Error("portable package manifest/envelope verification failed");
  const files = new Map<string, Buffer>(); let total = 0;
  for (const item of payload.files) {
    if (!isRecord(item) || typeof item.logicalPath !== "string" || !safeLogicalPath(item.logicalPath) || PORTABLE_SECRET_PATTERN.test(item.logicalPath)
      || typeof item.dataBase64 !== "string" || files.has(item.logicalPath)) throw new Error("portable package contains an unsafe or duplicate entry");
    const bytes = Buffer.from(item.dataBase64, "base64");
    if (bytes.toString("base64") !== item.dataBase64 || bytes.length > ENTRY_LIMIT) throw new Error("portable package entry encoding or size is invalid");
    if (secretContentKind(bytes)) throw new Error("portable package contains secret-bearing content");
    total += bytes.length; if (total > PAYLOAD_LIMIT) throw new Error("portable package expanded size exceeds the bounded limit");
    files.set(item.logicalPath, bytes);
  }
  const entries = new Map(manifest.entries.map((entry) => [entry.logicalPath, entry]));
  if (entries.size !== manifest.entries.length || entries.size !== files.size) throw new Error("portable package manifest file coverage mismatch");
  for (const [logicalPath, bytes] of files) {
    const entry = entries.get(logicalPath);
    if (!entry || entry.byteLength !== bytes.length || entry.sha256 !== sha256Bytes(bytes)) throw new Error("portable package entry hash mismatch");
  }
  const graph = payload.referenceGraph as unknown as PortableReferenceGraph;
  if (verifyReferenceGraph(graph).length || graph.runtimeGeneration !== manifest.runtimeGeneration
    || canonicalJson(graph.requiredRoots) !== canonicalJson(payload.requiredRefs)
    || (payload.includedRefs as unknown[]).some((ref) => typeof ref !== "string")
    || new Set(payload.includedRefs as string[]).size !== (payload.includedRefs as string[]).length) throw new Error("portable package reference graph is invalid");
  const plan = planEnvelopeFrom(files, payload.sourcePlanId);
  if (sha256Json(plan.envelope.payload) !== payload.sourcePlanHash) throw new Error("portable package source plan hash mismatch");
  let lockfile: ArtifactLockfile | null = null; let exactReplayReady = false;
  if (manifest.portableProfile === "complete") {
    const hash = manifest.artifactLockfileRef.startsWith("sha256:") ? manifest.artifactLockfileRef.slice(7) : "";
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("complete portable package artifact lock binding is invalid");
    lockfile = parseArtifactLockfile(files, hash);
    const closure = await verifyPortableProfileClosure(manifest, {
      trustedRepositoryGraph: graph,
      requiredRoots: payload.requiredRefs as string[],
      stagedIncludedRefs: payload.includedRefs as string[],
      artifactLockfile: lockfile,
    });
    if (!closure.valid || !closure.exactReplayReady) throw new Error(`complete portable package closure is invalid: ${closure.errors.join("; ")}`);
    const temporary = await mkdtemp(path.join(tmpdir(), "buildsim-portable-open-"));
    try {
      await materializePortableFiles([...files].map(([logicalPath, bytes]) => ({ logicalPath, bytes })), temporary);
      await validateProductionRuntimeRoot({
        state: { runtimeGeneration: graph.runtimeGeneration, revision: graph.runtimeRevision },
        activeRoot: temporary,
        now: () => graph.createdAt,
      });
    } catch (error) {
      throw new Error(`complete portable staged authority validation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally { await rm(temporary, { recursive: true, force: true }); }
    exactReplayReady = true;
  }
  return { envelope, payload: payload as unknown as PortablePlanPayload, files, artifactLockfile: lockfile, exactReplayReady };
}

export type PortableConflictStrategy = "reject" | "copy_as_new_plan" | "replace_after_backup";

export async function planPortableImport(options: {
  coordinator: RuntimeCoordinator;
  inputFile: string;
  password: string;
  mode: "dry_run" | "apply";
  strategy?: PortableConflictStrategy;
  newPlanId?: string;
  rollbackRef?: string;
  expectedManifestHash?: string;
  beforePointerSwitch?: (input: { staging: string; plan: ImportPlan }) => void | Promise<void>;
  now?: () => string;
}): Promise<{ plan: ImportPlan; sourcePlanId: string; sourcePlanName: string; sourcePlanHash: string; state?: { runtimeGeneration: number; revision: number; activeRoot: string }; importedPlanId: string }> {
  if (!options.coordinator) throw new TypeError("portable import requires a coordinator");
  const opened = await openPortablePlanPackage(options.inputFile, options.password);
  if (options.expectedManifestHash !== undefined && options.expectedManifestHash !== opened.payload.manifest.manifestHash) throw new Error("portable import manifest changed after dry-run");
  const sourcePlanId = opened.payload.sourcePlanId;
  const incoming = planEnvelopeFrom(new Map(opened.files), sourcePlanId).envelope;
  const sourcePlanName = typeof incoming.payload.name === "string" ? incoming.payload.name : sourcePlanId;
  await options.coordinator.initialize();
  const inspection = await options.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => {
    const existingPath = confined(activeRoot, "plans", sourcePlanId, "plan.json");
    const exists = await pathExists(existingPath);
    let existingHash: string | null = null;
    if (exists) {
      const value = await readJson(existingPath);
      if (!exactEnvelope(value, "1.0.0", "plan") || value.payload.id !== sourcePlanId) throw new Error("existing plan authority is invalid");
      existingHash = sha256Json(value.payload);
    }
    return { exists, existingHash };
  });
  const strategy = options.strategy ?? "reject";
  let action: ImportPlan["action"]; const idRemap: Record<string, string> = {}; const conflicts: ImportPlan["conflicts"] = [];
  if (!inspection.result.exists) action = "copy_as_new_plan";
  else if (inspection.result.existingHash === opened.payload.sourcePlanHash) action = "no_op_same_hash";
  else {
    conflicts.push({ existingId: sourcePlanId, incomingHash: opened.payload.sourcePlanHash, existingHash: inspection.result.existingHash! });
    if (strategy === "copy_as_new_plan") {
      if (!options.newPlanId || !SAFE_PLAN_ID.test(options.newPlanId) || options.newPlanId === sourcePlanId) throw new Error("copy import requires a distinct valid newPlanId");
      const targetExists = await options.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => pathExists(confined(activeRoot, "plans", options.newPlanId!, "plan.json")));
      if (targetExists.result) throw new Error("copy import target plan already exists");
      idRemap[sourcePlanId] = options.newPlanId; action = "copy_as_new_plan";
    } else if (strategy === "replace_after_backup") action = options.rollbackRef ? "replace_after_backup" : "reject";
    else action = "reject";
  }
  const importedPlanId = idRemap[sourcePlanId] ?? sourcePlanId;
  const resultMode: ImportPlan["resultMode"] = opened.exactReplayReady && importedPlanId === sourcePlanId ? "exact_replay" : "reevaluate_with_current_runtime";
  const basePlan = {
    importPlanId: sha256Json({ manifestHash: opened.payload.manifest.manifestHash, action, conflicts, idRemap, resultMode, rollbackRef: options.rollbackRef ?? null }),
    mode: options.mode,
    manifestHash: opened.payload.manifest.manifestHash,
    portableProfile: opened.payload.manifest.portableProfile,
    resultMode,
    conflicts,
    idRemap,
    action,
    ...(action === "replace_after_backup" ? { rollbackRef: options.rollbackRef } : {}),
  } satisfies ImportPlan;
  const errors = validateImportPlan(basePlan);
  if (errors.length) throw new Error(`portable import plan is invalid: ${errors.join("; ")}`);
  if (options.mode === "dry_run" || action === "no_op_same_hash" || action === "reject") return { plan: basePlan, sourcePlanId, sourcePlanName, sourcePlanHash: opened.payload.sourcePlanHash, importedPlanId };
  const lease = await options.coordinator.acquireMaintenanceLease("portable-plan-import", { ttlMs: 300_000 });
  let staging: string | undefined;
  try {
    const before = await options.coordinator.readState();
    const targetGeneration = before.runtimeGeneration + 1;
    staging = await options.coordinator.createStagingGeneration(lease.token);
    await prepareStagedRuntimeGeneration({ sourceRoot: options.coordinator.activeRoot(before), stagingRoot: staging, targetGeneration, restoredAt: (options.now ?? (() => new Date().toISOString()))() });
    const incomingFiles = new Map(opened.files);
    if (importedPlanId !== sourcePlanId) {
      for (const logicalPath of [...incomingFiles.keys()]) if (logicalPath.startsWith(`plans/${sourcePlanId}/`)) incomingFiles.delete(logicalPath);
      const source = structuredClone(incoming.payload);
      const bindings = isRecord(source.draft) && Array.isArray(source.draft.evidenceBindings) ? source.draft.evidenceBindings : [];
      const config = isRecord(source.draft) && isRecord(source.draft.config) ? structuredClone(source.draft.config) : source.draft;
      if (isRecord(config)) config.id = importedPlanId;
      const remappedBindings = bindings.map((binding) => {
        if (!isRecord(binding)) throw new Error("portable plan evidence binding is invalid");
        const subject = isRecord(binding.subject) && binding.subject.kind === "plan"
          ? { ...binding.subject, id: importedPlanId }
          : binding.subject;
        const base = { ...binding, planId: importedPlanId, subject } as Parameters<typeof planEvidenceBindingId>[0];
        return { ...base, id: planEvidenceBindingId(base) };
      });
      const draft = { ...(source.draft as Record<string, unknown>), config, baseVersionId: null, evidenceBindings: remappedBindings, dirty: true };
      const remapped = { ...source, id: importedPlanId, activeVersionId: null, draftRevision: 0, draft };
      incomingFiles.set(`plans/${importedPlanId}/plan.json`, Buffer.from(`${JSON.stringify({ schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(remapped), payload: remapped }, null, 2)}\n`, "utf8"));
      for (const logicalPath of [...incomingFiles.keys()]) {
        if (["facts", "snapshots", "prices", "jobs", "execution-sessions", "scenarios", "transactions", "agent", "audit", "observations"].includes(logicalPath.split("/", 1)[0]!)) incomingFiles.delete(logicalPath);
      }
    } else if (action === "replace_after_backup") {
      await rm(confined(staging, "plans", sourcePlanId), { recursive: true, force: true });
    }
    for (const [logicalPath, bytes] of incomingFiles) await atomicWriteFile(confined(staging, ...logicalPath.split("/")), bytes, { mode: 0o600 });
    if (importedPlanId !== sourcePlanId) {
      const remappedEnvelope = JSON.parse(incomingFiles.get(`plans/${importedPlanId}/plan.json`)!.toString("utf8")) as { payload: { draft: { config: unknown } } };
      if (hashPlanConfigRuntime(remappedEnvelope.payload.draft.config) === "") throw new Error("remapped portable plan config hash failed");
    }
    if (typeof options.beforePointerSwitch === "function") await options.beforePointerSwitch({ staging, plan: basePlan });
    await validateProductionRuntimeRoot({ state: { runtimeGeneration: targetGeneration, revision: before.revision + 1 }, activeRoot: staging, now: options.now });
    const state = await options.coordinator.activateStagingGeneration(staging, before.runtimeGeneration, lease.token, { minimumGeneration: targetGeneration });
    staging = undefined;
    return { plan: basePlan, sourcePlanId, sourcePlanName, sourcePlanHash: opened.payload.sourcePlanHash, importedPlanId, state };
  } catch (error) {
    if (staging) await options.coordinator.discardStagingGeneration(staging).catch(() => undefined);
    throw error;
  } finally { await options.coordinator.releaseMaintenanceLease(lease.token).catch(() => undefined); }
}
