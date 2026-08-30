import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteFile, atomicWriteJson, confined, sha256Json } from "../runtime/fs.mjs";
import type { StagedAttachmentUpload } from "./agent-actions";
import { validateStagedUploadEnvelopeRuntime } from "./runtime-validation.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const MEDIA_TYPE = /^(?:image\/png|image\/jpeg|application\/pdf)$/;
const HASH = /^[a-f0-9]{64}$/;

interface StagedUploadRecord {
  schemaVersion: "staged-user-attachment-v2";
  uploadId: string;
  sessionId: string;
  mediaType: string;
  byteLength: number;
  contentHash: string;
  status: "available" | "claimed" | "consumed";
  revision: number;
  consumerHash?: string;
  attachmentId?: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

interface StagedUploadEnvelope {
  schemaVersion: "staged-user-attachment-envelope-v1";
  kind: "staged-user-attachment";
  checksum: string;
  payload: StagedUploadRecord;
}

export interface StagedAttachmentUploadReceipt {
  schemaVersion: "staged-user-attachment-v2";
  uploadId: string;
  mediaType: string;
  byteLength: number;
  status: "available";
  createdAt: string;
  expiresAt: string;
}

export class StagedAttachmentUploadError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "corrupt_data", message: string) {
    super(message);
    this.name = "StagedAttachmentUploadError";
  }
}

export interface StagedAttachmentUploadRepositoryOptions {
  coordinator: RuntimeCoordinator;
  maxBytes?: number;
  retentionMs?: number;
  now?: () => string;
  id?: () => string;
  /** Test-only crash seam. A thrown error leaves an unclaimable content-addressed GC leaf. */
  faultInjector?: (point: "after_blob_write") => void | Promise<void>;
}

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Durable, private hand-off from the binary upload route to approval-bound Agent tools. */
export class StagedAttachmentUploadRepository {
  private readonly coordinator: RuntimeCoordinator;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly faultInjector: StagedAttachmentUploadRepositoryOptions["faultInjector"];

  constructor(options: StagedAttachmentUploadRepositoryOptions) {
    this.coordinator = options.coordinator;
    this.maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
    this.retentionMs = options.retentionMs ?? 60 * 60_000;
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => `upload-${randomUUID()}`);
    this.faultInjector = options.faultInjector;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 100 * 1024 * 1024) {
      throw new TypeError("staged attachment byte limit is invalid");
    }
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 60_000 || this.retentionMs > 24 * 60 * 60_000) {
      throw new TypeError("staged attachment retention is invalid");
    }
  }

  private assertId(value: string, label: string): void {
    if (!SAFE_ID.test(value)) throw new StagedAttachmentUploadError("invalid_input", `${label} is invalid`);
  }

  private metadataFile(activeRoot: string, uploadId: string): string {
    this.assertId(uploadId, "uploadId");
    return confined(activeRoot, "attachments", "staged", "metadata", `${uploadId}.json`);
  }

  private blobFile(activeRoot: string, contentHash: string): string {
    if (!HASH.test(contentHash)) throw new StagedAttachmentUploadError("corrupt_data", "staged upload hash is invalid");
    return confined(activeRoot, "attachments", "staged", "blobs", "sha256", contentHash.slice(0, 2), contentHash);
  }

  private async readAt(activeRoot: string, uploadId: string): Promise<StagedUploadRecord> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.metadataFile(activeRoot, uploadId), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StagedAttachmentUploadError("not_found", "staged upload was not found");
      throw new StagedAttachmentUploadError("corrupt_data", "staged upload metadata cannot be read");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new StagedAttachmentUploadError("corrupt_data", "staged upload envelope is invalid");
    const envelope = parsed as Partial<StagedUploadEnvelope>;
    const errors = validateStagedUploadEnvelopeRuntime(envelope, { uploadId, maxBytes: this.maxBytes });
    if (errors.length) throw new StagedAttachmentUploadError("corrupt_data", `staged upload metadata integrity is invalid: ${errors.join("; ")}`);
    const record = envelope.payload!;
    return structuredClone(record);
  }

  async put(input: { sessionId: string; bytes: Buffer | Uint8Array | ArrayBuffer; mediaType: string }): Promise<StagedAttachmentUploadReceipt> {
    this.assertId(input.sessionId, "sessionId");
    if (!MEDIA_TYPE.test(input.mediaType)) throw new StagedAttachmentUploadError("invalid_input", "staged upload media type is not allowlisted");
    const bytes = Buffer.isBuffer(input.bytes)
      ? Buffer.from(input.bytes)
      : input.bytes instanceof ArrayBuffer
        ? Buffer.from(input.bytes)
        : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
    if (bytes.length < 1 || bytes.length > this.maxBytes) throw new StagedAttachmentUploadError("invalid_input", "staged upload byte length is invalid");
    const uploadId = this.id();
    this.assertId(uploadId, "generated uploadId");
    const contentHash = digest(bytes);
    const createdAt = this.now();
    if (!Number.isFinite(Date.parse(createdAt))) throw new StagedAttachmentUploadError("invalid_input", "staged upload clock is invalid");
    const record: StagedUploadRecord = {
      schemaVersion: "staged-user-attachment-v2",
      uploadId,
      sessionId: input.sessionId,
      mediaType: input.mediaType,
      byteLength: bytes.length,
      contentHash,
      status: "available",
      revision: 0,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + this.retentionMs).toISOString(),
    };
    await this.coordinator.initialize();
    await this.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      const blob = this.blobFile(activeRoot, contentHash);
      try {
        const existing = await readFile(blob);
        if (digest(existing) !== contentHash) throw new StagedAttachmentUploadError("corrupt_data", "staged upload blob hash mismatch");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await atomicWriteFile(blob, bytes);
      }
      await this.faultInjector?.("after_blob_write");
      const envelope: StagedUploadEnvelope = {
        schemaVersion: "staged-user-attachment-envelope-v1",
        kind: "staged-user-attachment",
        checksum: sha256Json(record),
        payload: record,
      };
      await atomicWriteJson(this.metadataFile(activeRoot, uploadId), envelope);
    });
    return {
      schemaVersion: record.schemaVersion,
      uploadId: record.uploadId,
      mediaType: record.mediaType,
      byteLength: record.byteLength,
      status: "available",
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }

  private async bytesAt(activeRoot: string, record: StagedUploadRecord): Promise<Buffer> {
    let bytes: Buffer;
    try { bytes = await readFile(this.blobFile(activeRoot, record.contentHash)); }
    catch { throw new StagedAttachmentUploadError("corrupt_data", "staged upload body is missing"); }
    if (bytes.length !== record.byteLength || digest(bytes) !== record.contentHash) {
      throw new StagedAttachmentUploadError("corrupt_data", "staged upload body integrity is invalid");
    }
    return bytes;
  }

  private async writeRecord(activeRoot: string, record: StagedUploadRecord): Promise<void> {
    const envelope: StagedUploadEnvelope = {
      schemaVersion: "staged-user-attachment-envelope-v1",
      kind: "staged-user-attachment",
      checksum: sha256Json(record),
      payload: record,
    };
    await atomicWriteJson(this.metadataFile(activeRoot, record.uploadId), envelope);
  }

  async resolve(uploadId: string, sessionId: string): Promise<StagedAttachmentUpload | null> {
    this.assertId(uploadId, "uploadId");
    this.assertId(sessionId, "sessionId");
    await this.coordinator.initialize();
    return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => {
      let record: StagedUploadRecord;
      try { record = await this.readAt(activeRoot, uploadId); }
      catch (error) { if (error instanceof StagedAttachmentUploadError && error.code === "not_found") return null; throw error; }
      // Deliberately indistinguishable from missing: a session cannot probe another session's private uploads.
      if (record.sessionId !== sessionId || record.status !== "available" || Date.parse(record.expiresAt) <= Date.parse(this.now())) return null;
      const bytes = await this.bytesAt(activeRoot, record);
      return { bytes, declaredMediaType: record.mediaType };
    })).result;
  }

  /** Claims an upload for one exact approved Tool execution; same-consumer crash retries remain readable. */
  async claim(uploadId: string, sessionId: string, consumerKey: string): Promise<StagedAttachmentUpload | null> {
    this.assertId(uploadId, "uploadId");
    this.assertId(sessionId, "sessionId");
    if (!consumerKey || consumerKey.length > 1_024) throw new StagedAttachmentUploadError("invalid_input", "staged upload consumer key is invalid");
    const consumerHash = digest(Buffer.from(consumerKey));
    await this.coordinator.initialize();
    return (await this.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      let record: StagedUploadRecord;
      try { record = await this.readAt(activeRoot, uploadId); }
      catch (error) { if (error instanceof StagedAttachmentUploadError && error.code === "not_found") return null; throw error; }
      if (record.sessionId !== sessionId || Date.parse(record.expiresAt) <= Date.parse(this.now())) return null;
      if (record.status !== "available" && record.consumerHash !== consumerHash) return null;
      if (record.status === "available") {
        record = { ...record, status: "claimed", revision: record.revision + 1, consumerHash };
        await this.writeRecord(activeRoot, record);
      }
      const bytes = await this.bytesAt(activeRoot, record);
      return { bytes, declaredMediaType: record.mediaType };
    })).result;
  }

  /** Marks the claim consumed only after the content-addressed Attachment write succeeds. */
  async consume(uploadId: string, sessionId: string, consumerKey: string, attachmentId: string): Promise<void> {
    this.assertId(uploadId, "uploadId");
    this.assertId(sessionId, "sessionId");
    this.assertId(attachmentId, "attachmentId");
    if (!consumerKey || consumerKey.length > 1_024) throw new StagedAttachmentUploadError("invalid_input", "staged upload consumer key is invalid");
    const consumerHash = digest(Buffer.from(consumerKey));
    await this.coordinator.initialize();
    await this.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      const record = await this.readAt(activeRoot, uploadId);
      if (record.sessionId !== sessionId || record.consumerHash !== consumerHash || record.status === "available") {
        throw new StagedAttachmentUploadError("not_found", "staged upload claim was not found");
      }
      if (record.status === "consumed") {
        if (record.attachmentId !== attachmentId) throw new StagedAttachmentUploadError("corrupt_data", "staged upload was consumed by another attachment");
        return;
      }
      await this.writeRecord(activeRoot, {
        ...record,
        status: "consumed",
        revision: record.revision + 1,
        attachmentId,
        consumedAt: this.now(),
      });
    });
  }
}
