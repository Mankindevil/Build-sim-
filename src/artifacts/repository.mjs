import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteFile,
  atomicWriteJson,
  canonicalJson,
  confined,
  ensurePrivateDirectory,
  listRegularFiles,
  pathExists,
  readJson,
  sha256Bytes,
  sha256Json,
  withDirectoryLock,
} from "../runtime/fs.mjs";
import { validateRuntimeJobSideEffectFence } from "../jobs/runtime-validation.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const REF = /^sha256:([a-f0-9]{64})$/;
const PRIVACY = new Set(["public_source", "private_user", "runtime_internal"]);
const NECESSITY = new Set(["required_for_replay", "optional_for_audit"]);

function clone(value) { return structuredClone(value); }
function manifestHash(value) {
  const { contentHash: _contentHash, ...payload } = value;
  return sha256Json(payload);
}
function metadataChecksum(value) { return sha256Json(value); }
function assertRef(ref) {
  const match = REF.exec(String(ref ?? ""));
  if (!match) throw new ArtifactRepositoryError("invalid_ref", "artifact ref must be sha256:<hex>");
  return match[1];
}
/** @param {Array<{ ref: string, necessity: "required_for_replay" | "optional_for_audit" }>} [value] */
function validateReferences(value = []) {
  if (!Array.isArray(value)) throw new ArtifactRepositoryError("invalid_input", "artifact references must be an array");
  const keys = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !REF.test(String(entry.ref ?? "")) || !NECESSITY.has(entry.necessity)) {
      throw new ArtifactRepositoryError("invalid_input", "artifact reference is invalid");
    }
    const key = `${entry.ref}\0${entry.necessity}`;
    if (keys.has(key)) throw new ArtifactRepositoryError("invalid_input", "artifact references must be unique");
    keys.add(key);
    return { ref: entry.ref, necessity: entry.necessity };
  }).sort((left, right) => `${left.ref}\0${left.necessity}`.localeCompare(`${right.ref}\0${right.necessity}`));
}

export class ArtifactRepositoryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ArtifactRepositoryError";
    this.code = code;
  }
}

export class FileArtifactRepository {
  constructor(options = {}) {
    if (!options.root && !options.coordinator) throw new TypeError("artifact repository requires root or coordinator");
    this.root = options.root ? path.resolve(options.root) : null;
    this.coordinator = options.coordinator ?? null;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async repositoryRoot(activeRoot) {
    if (activeRoot) return confined(activeRoot, "artifacts");
    if (this.root) return this.root;
    const state = await this.coordinator.readState();
    return confined(this.coordinator.activeRoot(state), "artifacts");
  }

  paths(root, hash) {
    return {
      manifest: confined(root, "repository-manifest.json"),
      lock: confined(root, ".artifact-lock"),
      blob: confined(root, "blobs", "sha256", hash.slice(0, 2), hash),
      metadata: confined(root, "metadata", `${hash}.json`),
      quarantine: confined(root, "quarantine"),
      rollback: confined(root, "rollback"),
    };
  }

  async initializeAt(root) {
    await ensurePrivateDirectory(root);
    await ensurePrivateDirectory(confined(root, "blobs", "sha256"));
    await ensurePrivateDirectory(confined(root, "metadata"));
    await ensurePrivateDirectory(confined(root, "quarantine"));
    await ensurePrivateDirectory(confined(root, "rollback"));
    const file = this.paths(root, "00").manifest;
    if (!await pathExists(file)) {
      const base = { schemaVersion: "artifact-repository-manifest-v1", revision: 0, records: {}, updatedAt: this.now(), contentHash: "" };
      await atomicWriteJson(file, { ...base, contentHash: manifestHash(base) });
    }
  }

  async initialize() {
    if (this.coordinator) {
      return this.coordinator.withWrite(async ({ activeRoot }) => this.initializeAt(await this.repositoryRoot(activeRoot)));
    }
    await this.initializeAt(await this.repositoryRoot());
  }

  async readManifestAt(root, options = {}) {
    if (options.initialize === true) await this.initializeAt(root);
    const file = this.paths(root, "00").manifest;
    if (!await pathExists(file)) throw new ArtifactRepositoryError("missing_manifest", "artifact repository manifest is missing");
    const manifest = await readJson(file);
    if (!manifest || manifest.schemaVersion !== "artifact-repository-manifest-v1" || !Number.isInteger(manifest.revision)
      || manifest.revision < 0 || !manifest.records || typeof manifest.records !== "object" || Array.isArray(manifest.records)
      || !SHA256.test(String(manifest.contentHash ?? "")) || manifest.contentHash !== manifestHash(manifest)) {
      throw new ArtifactRepositoryError("corrupt_manifest", "artifact repository manifest integrity check failed");
    }
    for (const [hash, checksum] of Object.entries(manifest.records)) if (!SHA256.test(hash) || !SHA256.test(String(checksum))) {
      throw new ArtifactRepositoryError("corrupt_manifest", "artifact repository manifest record is invalid");
    }
    return manifest;
  }

  async writeManifestAt(root, manifest) {
    const next = { ...manifest, contentHash: manifestHash(manifest) };
    const file = this.paths(root, "00").manifest;
    if (await pathExists(file)) {
      const previous = await readJson(file);
      if (previous?.schemaVersion === "artifact-repository-manifest-v1" && previous.contentHash === manifestHash(previous)) {
        await atomicWriteJson(confined(root, "rollback", `${String(previous.revision).padStart(12, "0")}-${previous.contentHash}.json`), previous);
      }
    }
    await atomicWriteJson(file, next);
    return next;
  }

  async withWrite(operation, options = {}) {
    if (this.coordinator) {
      return (await this.coordinator.withWrite(async ({ activeRoot, state }) => {
        if (options.expectedRuntimeGeneration !== undefined && state.runtimeGeneration !== options.expectedRuntimeGeneration) {
          throw new ArtifactRepositoryError("fenced", "artifact write belongs to a stale runtime generation");
        }
        if (options.expectedJobLease) {
          const fence = options.expectedJobLease;
          if (!/^job-[a-f0-9]{64}$/.test(String(fence.jobId ?? ""))) throw new ArtifactRepositoryError("fenced", "artifact job fence is invalid");
          const jobEnvelope = await readJson(confined(activeRoot, "jobs", "records", `${fence.jobId}.json`));
          if (jobEnvelope?.schemaVersion !== "job-store-envelope-v1" || jobEnvelope.kind !== "background-job"
            || jobEnvelope.checksum !== sha256Json(jobEnvelope.payload)
            || validateRuntimeJobSideEffectFence(jobEnvelope.payload, {
              ...fence,
              runtimeGeneration: options.expectedRuntimeGeneration ?? state.runtimeGeneration,
            }, this.now()).length > 0) {
            throw new ArtifactRepositoryError("fenced", "artifact write belongs to a stale job lease");
          }
        }
        const root = await this.repositoryRoot(activeRoot);
        await this.initializeAt(root);
        return operation(root);
      }, { expectedRevision: options.expectedRuntimeRevision, maintenanceLeaseToken: options.maintenanceLeaseToken })).result;
    }
    const root = await this.repositoryRoot();
    await this.initializeAt(root);
    return withDirectoryLock(this.paths(root, "00").lock, () => operation(root));
  }

  async withRead(operation) {
    if (this.coordinator) {
      return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }) => operation(await this.repositoryRoot(activeRoot)))).result;
    }
    return operation(await this.repositoryRoot());
  }

  async put(input, options = {}) {
    const bytes = Buffer.isBuffer(input?.bytes) ? Buffer.from(input.bytes)
      : input?.bytes instanceof Uint8Array ? Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength) : null;
    if (!bytes) throw new ArtifactRepositoryError("invalid_input", "artifact bytes must be Buffer or Uint8Array");
    if (typeof input.mediaType !== "string" || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(input.mediaType)) throw new ArtifactRepositoryError("invalid_input", "artifact mediaType is invalid");
    if (!PRIVACY.has(input.privacyClass) || typeof input.kind !== "string" || !input.kind) throw new ArtifactRepositoryError("invalid_input", "artifact kind/privacyClass is invalid");
    const references = validateReferences(input.references);
    const hash = sha256Bytes(bytes);
    const ref = `sha256:${hash}`;
    if (references.some((reference) => reference.ref === ref)) throw new ArtifactRepositoryError("invalid_input", "artifact cannot reference itself");
    return this.withWrite(async (root) => {
      const manifest = await this.readManifestAt(root);
      if (options.expectedManifestHash !== undefined && options.expectedManifestHash !== manifest.contentHash) throw new ArtifactRepositoryError("conflict", "artifact repository expected manifest hash conflict");
      const paths = this.paths(root, hash);
      const record = {
        schemaVersion: "artifact-record-v1", ref, sha256: hash, byteLength: bytes.length,
        mediaType: input.mediaType.toLowerCase(), privacyClass: input.privacyClass, kind: input.kind,
        references, createdAt: input.createdAt ?? this.now(),
      };
      const envelope = { schemaVersion: "artifact-metadata-envelope-v1", checksum: metadataChecksum(record), record };
      if (manifest.records[hash]) {
        const existing = await this.getAt(root, ref, { initialize: false });
        const sameMetadata = existing && existing.record.mediaType === record.mediaType
          && existing.record.privacyClass === record.privacyClass && existing.record.kind === record.kind
          && canonicalJson(existing.record.references) === canonicalJson(record.references);
        if (!sameMetadata) throw new ArtifactRepositoryError("conflict", "artifact bytes already exist with different governed metadata");
        return { record: clone(existing.record), manifestHash: manifest.contentHash, manifestRevision: manifest.revision, created: false };
      }
      if (await pathExists(paths.blob)) {
        const existing = await readFile(paths.blob);
        if (sha256Bytes(existing) !== hash) throw new ArtifactRepositoryError("corrupt_blob", "existing artifact blob hash mismatch");
      } else await atomicWriteFile(paths.blob, bytes);
      await atomicWriteJson(paths.metadata, envelope);
      const next = await this.writeManifestAt(root, {
        ...manifest,
        revision: manifest.revision + 1,
        records: { ...manifest.records, [hash]: envelope.checksum },
        updatedAt: this.now(),
      });
      return { record: clone(record), manifestHash: next.contentHash, manifestRevision: next.revision, created: true };
    }, options);
  }

  async getAt(root, ref, options = {}) {
    const hash = assertRef(ref);
    const manifestFile = this.paths(root, "00").manifest;
    if (!await pathExists(manifestFile)) {
      const files = await listRegularFiles(root);
      if (options.allowMissingManifest === true && files.length === 0) return null;
      throw new ArtifactRepositoryError("missing_manifest", "artifact repository manifest is missing");
    }
    const manifest = await this.readManifestAt(root, options);
    const expectedMetadataHash = manifest.records[hash];
    if (!expectedMetadataHash) return null;
    const paths = this.paths(root, hash);
    let envelope;
    try { envelope = await readJson(paths.metadata); } catch (error) { throw new ArtifactRepositoryError("corrupt_metadata", "artifact metadata is unreadable", { cause: error }); }
    if (!envelope || envelope.schemaVersion !== "artifact-metadata-envelope-v1" || envelope.checksum !== expectedMetadataHash
      || envelope.checksum !== metadataChecksum(envelope.record) || envelope.record?.ref !== ref || envelope.record?.sha256 !== hash) {
      throw new ArtifactRepositoryError("corrupt_metadata", "artifact metadata integrity check failed");
    }
    const bytes = await readFile(paths.blob).catch((error) => { throw new ArtifactRepositoryError("missing_blob", "artifact blob is missing", { cause: error }); });
    if (bytes.length !== envelope.record.byteLength || sha256Bytes(bytes) !== hash) throw new ArtifactRepositoryError("corrupt_blob", "artifact blob integrity check failed");
    return { record: clone(envelope.record), bytes: Buffer.from(bytes) };
  }

  async get(ref) { return this.withRead((root) => this.getAt(root, ref, { allowMissingManifest: true })); }

  async listAt(root, options = {}) {
    const manifest = await this.readManifestAt(root, options);
    const records = [];
    for (const hash of Object.keys(manifest.records).sort()) records.push((await this.getAt(root, `sha256:${hash}`, options)).record);
    return { manifest: clone(manifest), records };
  }

  async list() { return this.withRead((root) => this.listAt(root)); }

  /** Called inside RuntimeCoordinator.withConsistentSnapshot without reacquiring its lock. */
  async snapshotReferences(activeRoot) {
    const root = await this.repositoryRoot(activeRoot);
    const { manifest, records } = await this.listAt(root, { initialize: false });
    return {
      providerId: "artifacts",
      revision: manifest.revision,
      manifestHash: manifest.contentHash,
      snapshotPointers: [`artifact-manifest:${manifest.contentHash}`],
      nodes: records.map((record) => record.ref),
      edges: records.flatMap((record) => record.references.map((reference) => ({ fromRef: record.ref, toRef: reference.ref, necessity: reference.necessity }))),
    };
  }

  async quarantine(ref, options = {}) {
    const hash = assertRef(ref);
    return this.withWrite(async (root) => {
      const manifest = await this.readManifestAt(root);
      if (options.expectedManifestHash !== undefined && options.expectedManifestHash !== manifest.contentHash) throw new ArtifactRepositoryError("conflict", "artifact repository expected manifest hash conflict");
      if (!manifest.records[hash]) return { quarantined: false, reason: "not_found" };
      const stamp = String(options.quarantinedAt ?? this.now()).replace(/[:.]/g, "-");
      const destination = confined(this.paths(root, hash).quarantine, `${stamp}-${randomUUID()}`, hash);
      await ensurePrivateDirectory(destination);
      const paths = this.paths(root, hash);
      await rename(paths.blob, confined(destination, "blob"));
      await rename(paths.metadata, confined(destination, "metadata.json"));
      await atomicWriteJson(confined(destination, "quarantine.json"), {
        schemaVersion: "artifact-quarantine-v1", ref, quarantinedAt: options.quarantinedAt ?? this.now(), reason: options.reason ?? "gc-unreferenced",
      });
      const records = { ...manifest.records };
      delete records[hash];
      const next = await this.writeManifestAt(root, { ...manifest, revision: manifest.revision + 1, records, updatedAt: this.now() });
      return { quarantined: true, quarantinePath: destination, manifestHash: next.contentHash };
    }, options);
  }

  async restoreQuarantined(ref, options = {}) {
    const hash = assertRef(ref);
    return this.withWrite(async (root) => {
      const manifest = await this.readManifestAt(root);
      if (options.expectedManifestHash !== undefined && options.expectedManifestHash !== manifest.contentHash) throw new ArtifactRepositoryError("conflict", "artifact repository expected manifest hash conflict");
      if (manifest.records[hash]) return { restored: false, reason: "already_active" };
      const quarantineRoot = this.paths(root, hash).quarantine;
      const candidates = [];
      if (await pathExists(quarantineRoot)) for (const directory of await readdir(quarantineRoot, { withFileTypes: true })) {
        const candidate = confined(quarantineRoot, directory.name, hash);
        if (directory.isDirectory() && await pathExists(confined(candidate, "metadata.json"))) candidates.push(candidate);
      }
      candidates.sort();
      const source = candidates.at(-1);
      if (!source) return { restored: false, reason: "not_found" };
      const envelope = await readJson(confined(source, "metadata.json"));
      const blob = await readFile(confined(source, "blob"));
      if (envelope?.schemaVersion !== "artifact-metadata-envelope-v1" || envelope.checksum !== metadataChecksum(envelope.record)
        || envelope.record?.ref !== ref || envelope.record?.sha256 !== hash || envelope.record?.byteLength !== blob.length
        || sha256Bytes(blob) !== hash) throw new ArtifactRepositoryError("corrupt_quarantine", "quarantined artifact integrity check failed");
      const paths = this.paths(root, hash);
      await ensurePrivateDirectory(path.dirname(paths.blob));
      await rename(confined(source, "blob"), paths.blob);
      await rename(confined(source, "metadata.json"), paths.metadata);
      const next = await this.writeManifestAt(root, {
        ...manifest, revision: manifest.revision + 1,
        records: { ...manifest.records, [hash]: envelope.checksum }, updatedAt: this.now(),
      });
      await rm(path.dirname(source), { recursive: true, force: true });
      return { restored: true, manifestHash: next.contentHash };
    }, options);
  }

  async inspectAt(root) {
    try {
      const manifest = await this.readManifestAt(root, { initialize: false });
      let bytes = 0;
      for (const hash of Object.keys(manifest.records).sort()) {
        const value = await this.getAt(root, `sha256:${hash}`, { initialize: false });
        if (!value) throw new ArtifactRepositoryError("missing_metadata", "artifact metadata is missing");
        bytes += value.record.byteLength;
      }
      const expectedBlobs = new Set(Object.keys(manifest.records).map((hash) => `blobs/sha256/${hash.slice(0, 2)}/${hash}`));
      const expectedMetadata = new Set(Object.keys(manifest.records).map((hash) => `metadata/${hash}.json`));
      for (const file of await listRegularFiles(root)) {
        if (file.symlink) throw new ArtifactRepositoryError("repository_symlink", "artifact repository contains a symbolic link");
        if (file.logicalPath.startsWith("blobs/") && !expectedBlobs.has(file.logicalPath)) throw new ArtifactRepositoryError("orphan_blob", "artifact repository contains an untracked blob");
        if (file.logicalPath.startsWith("metadata/") && !expectedMetadata.has(file.logicalPath)) throw new ArtifactRepositoryError("orphan_metadata", "artifact repository contains untracked metadata");
      }
      return { ok: true, manifestHash: manifest.contentHash, revision: manifest.revision, recordCount: Object.keys(manifest.records).length, bytes };
    } catch (error) {
      return { ok: false, code: error?.code ?? "repository_error" };
    }
  }

  async inspect() { return this.withRead((root) => this.inspectAt(root)); }
}
