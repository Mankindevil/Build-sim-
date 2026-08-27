import { createHash, randomUUID } from "node:crypto";
import { open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../plans/canonical";
import type { ObservationAttachment } from "../observations/contracts";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteFile, confined, sha256Json, withDirectoryLock } from "../runtime/fs.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;

export class AttachmentRepositoryError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "corrupt_data" | "invalid_input", message: string) {
    super(message);
    this.name = "AttachmentRepositoryError";
  }
}

interface StoredAttachment extends ObservationAttachment {
  planId: string;
  revision: number;
  metadataHash: string;
  createdAt: string;
}

interface Envelope<T> { schemaVersion: "attachment-repository-v1"; kind: "attachment"; checksum: string; payload: T; }
interface RollbackRecord { schemaVersion: "attachment-rollback-v1"; kind: "attachment-rollback"; checksum: string; payload: { attachmentId: string; fromRevision: number; toRevision: number; previousHash: string; previous: StoredAttachment; createdAt: string; }; }

export interface PutAttachmentInput {
  attachmentId?: string;
  planId: string;
  content: Buffer | Uint8Array | ArrayBuffer;
  mediaType: string;
  deletionPolicy: ObservationAttachment["deletionPolicy"];
  /** Pin an import/caller to the actual raw-byte SHA-256. */
  expectedHash?: string;
  maintenanceLeaseToken?: string;
}

export interface DeleteAttachmentInput { expectedRevision: number; expectedHash: string; maintenanceLeaseToken?: string; }
export interface RollbackAttachmentInput { expectedRevision: number; expectedHash: string; maintenanceLeaseToken?: string; }

export interface AttachmentRepositoryOptions { root?: string; runtimeRoot?: string; coordinator?: RuntimeCoordinator; now?: () => string; id?: () => string; }

function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function clone<T>(value: T): T { return structuredClone(value); }
function metadataHash(value: Omit<StoredAttachment, "metadataHash">): string { return digest(canonicalJson(value)); }

/**
 * Keeps private user bytes in content-addressed blobs and the queryable metadata
 * in separate, checksummed records. Metadata never contains the blob body.
 */
export class AttachmentRepository {
  private root: string;
  private readonly coordinator: RuntimeCoordinator | undefined;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: AttachmentRepositoryOptions = {}) {
    this.root = path.resolve(options.root ?? "runtime/attachments");
    this.coordinator = options.root ? undefined : options.coordinator ?? new RuntimeCoordinator({ root: options.runtimeRoot, now: options.now });
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => `attachment-${randomUUID()}`);
  }

  private metadataFileAt(root: string, id: string): string { this.assertId(id); return confined(root, "metadata", `${id}.json`); }
  private metadataFile(id: string): string { return this.metadataFileAt(this.root, id); }
  private rollbackFileAt(root: string, id: string, revision: number): string { this.assertId(id); if (!Number.isInteger(revision) || revision < 0) throw new AttachmentRepositoryError("invalid_input", "attachment rollback revision invalid"); return confined(root, "rollback", id, `${String(revision).padStart(12, "0")}.json`); }
  private blobFileAt(root: string, hash: string): string {
    if (!SHA256.test(hash)) throw new AttachmentRepositoryError("invalid_input", "attachment content hash invalid");
    return confined(root, "blobs", "sha256", hash.slice(0, 2), hash);
  }
  private blobFile(hash: string): string { return this.blobFileAt(this.root, hash); }
  private assertId(id: string): void { if (!SAFE_ID.test(id)) throw new AttachmentRepositoryError("invalid_input", "attachment id invalid"); }
  private async serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(key, current);
    try { return await current; } finally { if (this.queues.get(key) === current) this.queues.delete(key); }
  }
  private async withRoot<T>(key: string, write: boolean, operation: () => Promise<T>, maintenanceLeaseToken?: string): Promise<T> {
    const invoke = async (root: string) => { const previous = this.root; this.root = root; try { return await operation(); } finally { this.root = previous; } };
    if (this.coordinator) {
      await this.coordinator.initialize();
      if (write) return (await this.coordinator.withWrite(({ activeRoot }: { activeRoot: string }) => invoke(confined(activeRoot, "attachments")), { maintenanceLeaseToken })).result as T;
      return (await this.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => invoke(confined(activeRoot, "attachments")))).result as T;
    }
    return withDirectoryLock(confined(this.root, ".locks", digest(key)), operation);
  }
  private async atomicWrite(file: string, bytes: Buffer | string): Promise<void> {
    await atomicWriteFile(file, bytes);
  }
  private async readStoredAt(root: string, id: string): Promise<StoredAttachment> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.metadataFileAt(root, id), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AttachmentRepositoryError("not_found", "attachment was not found");
      throw new AttachmentRepositoryError("corrupt_data", "attachment metadata cannot be read");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AttachmentRepositoryError("corrupt_data", "attachment metadata envelope invalid");
    const envelope = parsed as Partial<Envelope<StoredAttachment>>;
    if (envelope.schemaVersion !== "attachment-repository-v1" || envelope.kind !== "attachment" || !envelope.payload || envelope.checksum !== digest(canonicalJson(envelope.payload))) {
      throw new AttachmentRepositoryError("corrupt_data", "attachment metadata checksum invalid");
    }
    const value = envelope.payload;
    if (!SAFE_ID.test(value.attachmentId) || !value.planId || !SHA256.test(value.contentHash) || value.privacyClass !== "private_user"
      || !["retain_until_user_deletes", "delete_after_extraction"].includes(value.deletionPolicy)
      || !["available", "deleted_tombstone"].includes(value.status) || !Number.isInteger(value.revision) || value.revision < 0
      || (() => { const { metadataHash: _metadataHash, ...base } = value; return value.metadataHash !== metadataHash(base); })()) {
      throw new AttachmentRepositoryError("corrupt_data", "attachment metadata binding invalid");
    }
    return clone(value);
  }
  private async readStored(id: string): Promise<StoredAttachment> { return this.readStoredAt(this.root, id); }
  private async writeRollback(previous: StoredAttachment, nextRevision: number): Promise<void> {
    const payload = { attachmentId: previous.attachmentId, fromRevision: previous.revision, toRevision: nextRevision, previousHash: previous.metadataHash, previous: clone(previous), createdAt: this.now() };
    const envelope: RollbackRecord = { schemaVersion: "attachment-rollback-v1", kind: "attachment-rollback", checksum: digest(canonicalJson(payload)), payload };
    await this.atomicWrite(this.rollbackFileAt(this.root, previous.attachmentId, previous.revision), `${JSON.stringify(envelope)}\n`);
    const manifestFile = confined(this.root, "rollback", "manifest.json");
    let manifest: { schemaVersion: "attachment-rollback-manifest-v1"; entries: unknown[]; checksum?: string } = { schemaVersion: "attachment-rollback-manifest-v1", entries: [] };
    try {
      manifest = JSON.parse(await readFile(manifestFile, "utf8")) as typeof manifest;
      const { checksum: _checksum, ...body } = manifest;
      if (manifest.schemaVersion !== "attachment-rollback-manifest-v1" || !Array.isArray(manifest.entries) || manifest.checksum !== digest(canonicalJson(body))) throw new Error("invalid manifest");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AttachmentRepositoryError("corrupt_data", "attachment rollback manifest cannot be read");
    }
    const body = { schemaVersion: "attachment-rollback-manifest-v1" as const, entries: [...manifest.entries, { attachmentId: previous.attachmentId, fromRevision: previous.revision, toRevision: nextRevision, previousHash: previous.metadataHash, createdAt: payload.createdAt }] };
    await this.atomicWrite(manifestFile, `${JSON.stringify({ ...body, checksum: digest(canonicalJson(body)) })}\n`);
  }
  private public(value: StoredAttachment): ObservationAttachment & { planId: string; revision: number; metadataHash: string; createdAt: string } { return clone(value); }
  private async removeBlobWhenUnreferenced(contentHash: string): Promise<void> {
    const metadataRoot = confined(this.root, "metadata");
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(metadataRoot, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
      else throw error;
    }
    if (entries.some((entry) => entry.isSymbolicLink())) throw new AttachmentRepositoryError("corrupt_data", "attachment metadata contains a symlink");
    for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
      const record = await this.readStoredAt(this.root, entry.name.slice(0, -5));
      if (record.status === "available" && record.contentHash === contentHash) return;
    }
    const blob = this.blobFile(contentHash);
    try {
      await rm(blob);
      const directory = await open(path.dirname(blob), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async put(input: PutAttachmentInput): Promise<ObservationAttachment & { planId: string; revision: number; metadataHash: string; createdAt: string }> {
    if (!input.planId || !/^[-a-zA-Z0-9._]{1,160}$/.test(input.planId)) throw new AttachmentRepositoryError("invalid_input", "plan id invalid");
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(input.mediaType)) throw new AttachmentRepositoryError("invalid_input", "media type invalid");
    const content = Buffer.isBuffer(input.content) ? Buffer.from(input.content) : input.content instanceof ArrayBuffer ? Buffer.from(input.content) : Buffer.from(input.content);
    const contentHash = digest(content);
    if (input.expectedHash !== undefined && input.expectedHash !== contentHash) throw new AttachmentRepositoryError("conflict", "attachment expected hash mismatch");
    const attachmentId = input.attachmentId ?? this.id(); this.assertId(attachmentId);
    return this.withRoot("repository", true, () => this.serial(attachmentId, async () => {
      try {
        const existing = await this.readStored(attachmentId);
        if (existing.planId !== input.planId || existing.contentHash !== contentHash || existing.mediaType !== input.mediaType || existing.deletionPolicy !== input.deletionPolicy) {
          throw new AttachmentRepositoryError("conflict", "attachment id is already bound to different metadata");
        }
        return this.public(existing);
      } catch (error) {
        if (!(error instanceof AttachmentRepositoryError) || error.code !== "not_found") throw error;
      }
      const blob = this.blobFile(contentHash);
      try {
        const current = await readFile(blob);
        if (digest(current) !== contentHash) throw new AttachmentRepositoryError("corrupt_data", "attachment blob hash mismatch");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.atomicWrite(blob, content);
      }
      const base: Omit<StoredAttachment, "metadataHash"> = {
        attachmentId, planId: input.planId, contentHash, mediaType: input.mediaType.toLowerCase(), privacyClass: "private_user",
        deletionPolicy: input.deletionPolicy, status: "available", revision: 0, createdAt: this.now(),
      };
      const value: StoredAttachment = { ...base, metadataHash: metadataHash(base) };
      const envelope: Envelope<StoredAttachment> = { schemaVersion: "attachment-repository-v1", kind: "attachment", checksum: digest(canonicalJson(value)), payload: value };
      await this.atomicWrite(this.metadataFile(attachmentId), `${JSON.stringify(envelope)}\n`);
      return this.public(value);
    }), input.maintenanceLeaseToken);
  }

  async get(attachmentId: string): Promise<ObservationAttachment & { planId: string; revision: number; metadataHash: string; createdAt: string }> {
    return this.withRoot(attachmentId, false, async () => {
    const value = await this.readStored(attachmentId);
    if (value.status === "available") {
      let data: Buffer;
      try { data = await readFile(this.blobFile(value.contentHash)); } catch { throw new AttachmentRepositoryError("corrupt_data", "attachment blob missing"); }
      if (digest(data) !== value.contentHash) throw new AttachmentRepositoryError("corrupt_data", "attachment blob hash mismatch");
    }
    return this.public(value);
    });
  }

  async hasAvailable(attachmentId: string, planId: string): Promise<boolean> {
    try { const value = await this.get(attachmentId); return value.planId === planId && value.status === "available"; } catch { return false; }
  }

  /** Read-only lookup for callers already holding RuntimeCoordinator's barrier. */
  async hasAvailableAtRoot(activeRoot: string, attachmentId: string, planId: string): Promise<boolean> {
    try {
      const repositoryRoot = confined(activeRoot, "attachments");
      const value = await this.readStoredAt(repositoryRoot, attachmentId);
      if (value.planId !== planId || value.status !== "available") return false;
      const bytes = await readFile(this.blobFileAt(repositoryRoot, value.contentHash));
      return digest(bytes) === value.contentHash;
    } catch {
      return false;
    }
  }

  /** Called inside a consistent-snapshot barrier; never reacquires it or writes. */
  async snapshotReferences(activeRoot: string): Promise<{
    providerId: "attachments";
    revision: number;
    manifestHash: string;
    snapshotPointers: string[];
    nodes: string[];
    edges: Array<{ fromRef: string; toRef: string; necessity: "required_for_replay" }>;
  }> {
    const repositoryRoot = confined(activeRoot, "attachments");
    const metadataRoot = confined(repositoryRoot, "metadata");
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(metadataRoot, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
      else throw error;
    }
    if (entries.some((entry) => entry.isSymbolicLink())) throw new AttachmentRepositoryError("corrupt_data", "attachment metadata contains a symlink");
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => this.readStoredAt(repositoryRoot, entry.name.slice(0, -5))));
    const available = records.filter((record) => record.status === "available");
    // Tombstones remain in the provider manifest for audit, but are not
    // replayable attachment nodes. A still-active observation referencing a
    // deleted body must become dangling and fail the closure gate.
    const attachmentNodes = available.map((record) => `attachment:${record.attachmentId}`);
    const blobNodes = [...new Set(available.map((record) => `attachment-blob:sha256:${record.contentHash}`))].sort();
    const edges = available.map((record) => ({
      fromRef: `attachment:${record.attachmentId}`,
      toRef: `attachment-blob:sha256:${record.contentHash}`,
      necessity: "required_for_replay" as const,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return {
      providerId: "attachments",
      revision: records.reduce((total, record) => total + record.revision + 1, 0),
      manifestHash: sha256Json(records.map((record) => ({ attachmentId: record.attachmentId, metadataHash: record.metadataHash }))),
      snapshotPointers: attachmentNodes.sort(),
      nodes: [...attachmentNodes, ...blobNodes].sort(),
      edges,
    };
  }

  async readBlob(attachmentId: string): Promise<Buffer> {
    return this.withRoot(attachmentId, false, async () => {
      const value = await this.readStored(attachmentId);
      if (value.status !== "available") throw new AttachmentRepositoryError("not_found", "attachment body was deleted");
      const bytes = await readFile(this.blobFile(value.contentHash));
      if (digest(bytes) !== value.contentHash) throw new AttachmentRepositoryError("corrupt_data", "attachment blob hash mismatch");
      return Buffer.from(bytes);
    });
  }

  async delete(attachmentId: string, input: DeleteAttachmentInput): Promise<ObservationAttachment & { planId: string; revision: number; metadataHash: string; createdAt: string }> {
    return this.withRoot("repository", true, () => this.serial(attachmentId, async () => {
      const existing = await this.readStored(attachmentId);
      if (existing.revision !== input.expectedRevision || existing.metadataHash !== input.expectedHash) throw new AttachmentRepositoryError("conflict", "attachment revision/hash conflict");
      if (existing.status === "deleted_tombstone") {
        await this.removeBlobWhenUnreferenced(existing.contentHash);
        return this.public(existing);
      }
      const { metadataHash: _previousMetadataHash, ...withoutMetadataHash } = existing;
      const base: Omit<StoredAttachment, "metadataHash"> = { ...withoutMetadataHash, status: "deleted_tombstone", deletedAt: this.now(), revision: existing.revision + 1 };
      const value: StoredAttachment = { ...base, metadataHash: metadataHash(base) };
      const envelope: Envelope<StoredAttachment> = { schemaVersion: "attachment-repository-v1", kind: "attachment", checksum: digest(canonicalJson(value)), payload: value };
      // The rollback record is durable before the metadata authority changes.
      // It is audit/recovery evidence only: a user deletion is never undone by
      // restoring metadata after the tombstone has been committed.
      await this.writeRollback(existing, value.revision);
      await this.atomicWrite(this.metadataFile(attachmentId), `${JSON.stringify(envelope)}\n`);
      // Tombstone is the commit point. Raw bytes are removed only after no
      // available attachment metadata references the shared content hash.
      await this.removeBlobWhenUnreferenced(existing.contentHash);
      return this.public(value);
    }), input.maintenanceLeaseToken);
  }

  /** Roll back a recoverable metadata transition; never resurrects a deleted body. */
  async rollback(attachmentId: string, input: RollbackAttachmentInput): Promise<ObservationAttachment & { planId: string; revision: number; metadataHash: string; createdAt: string }> {
    if (this.coordinator && !input.maintenanceLeaseToken) throw new AttachmentRepositoryError("invalid_input", "attachment rollback requires a maintenance lease");
    return this.withRoot("repository", true, () => this.serial(attachmentId, async () => {
      const current = await this.readStored(attachmentId);
      if (current.revision !== input.expectedRevision || current.metadataHash !== input.expectedHash) throw new AttachmentRepositoryError("conflict", "attachment rollback revision/hash conflict");
      if (current.status === "deleted_tombstone") throw new AttachmentRepositoryError("conflict", "deleted attachment tombstones cannot be rolled back");
      let parsed: RollbackRecord;
      try { parsed = JSON.parse(await readFile(this.rollbackFileAt(this.root, attachmentId, Math.max(0, current.revision - 1)), "utf8")) as RollbackRecord; }
      catch { throw new AttachmentRepositoryError("not_found", "attachment rollback history was not found"); }
      if (parsed.schemaVersion !== "attachment-rollback-v1" || parsed.kind !== "attachment-rollback" || parsed.checksum !== digest(canonicalJson(parsed.payload)) || parsed.payload.attachmentId !== attachmentId || parsed.payload.toRevision !== current.revision || parsed.payload.previousHash !== parsed.payload.previous.metadataHash || parsed.payload.previous.status === "deleted_tombstone") throw new AttachmentRepositoryError("corrupt_data", "attachment rollback history is invalid");
      const previous = parsed.payload.previous;
      const bytes = await readFile(this.blobFile(previous.contentHash)).catch(() => { throw new AttachmentRepositoryError("conflict", "attachment rollback would require deleted raw bytes"); });
      if (digest(bytes) !== previous.contentHash) throw new AttachmentRepositoryError("corrupt_data", "attachment rollback raw bytes hash mismatch");
      const { metadataHash: _oldHash, ...base } = previous;
      const restoredBase = { ...base, revision: current.revision + 1 };
      const restored: StoredAttachment = { ...restoredBase, metadataHash: metadataHash(restoredBase) };
      await this.writeRollback(current, restored.revision);
      const envelope: Envelope<StoredAttachment> = { schemaVersion: "attachment-repository-v1", kind: "attachment", checksum: digest(canonicalJson(restored)), payload: restored };
      await this.atomicWrite(this.metadataFile(attachmentId), `${JSON.stringify(envelope)}\n`);
      return this.public(restored);
    }), input.maintenanceLeaseToken);
  }

  /** Content blobs are deliberately retained; reference-graph GC owns eventual removal. */
  async inspectBlob(contentHash: string): Promise<{ exists: boolean; valid: boolean; bytes?: number }> {
    return this.withRoot(contentHash, false, async () => { try { const file = this.blobFile(contentHash); const [info, data] = await Promise.all([stat(file), readFile(file)]); return { exists: true, valid: digest(data) === contentHash, bytes: info.size }; }
    catch { return { exists: false, valid: false }; }
    });
  }
}
