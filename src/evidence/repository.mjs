import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  link,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteFile, atomicWriteJson, confined, ensurePrivateDirectory, sha256Bytes, withDirectoryLock } from "../runtime/fs.mjs";

const SCHEMA_VERSION = "1.0.0";
const DOCUMENT_ID = /^doc-sha256-([a-f0-9]{64})$/;
const CAPTURE_ID = /^capture-sha256-([a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DOCUMENT_KINDS = new Set([
  "manufacturer-manual",
  "datasheet",
  "support-document",
  "official-product-page-snapshot",
]);
const PRODUCT_CATEGORIES = new Set([
  "case",
  "motherboard",
  "cpu",
  "psu",
  "cooler",
  "gpu",
  "memory",
  "storage",
  "hba",
  "fan",
  "accessory",
]);
const ENVELOPE_KINDS = new Set(["evidence-document", "evidence-capture", "evidence-url-index"]);
const ACQUISITION_METHODS = new Set(["official-fetch", "bundled-import"]);
const IDENTITY_BASES = new Set([
  "official-document-explicit",
  "governed-sku-user-asserted",
  "official-domain-only",
  "legacy-unverified",
]);
const KIND_BASES = new Set(["content-verified", "user-asserted", "legacy-unverified"]);

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function recordChecksum(value) {
  return sha256(canonicalJson(value));
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeText(value, label, { max = 500, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new EvidenceRepositoryError("invalid_input", `${label} must be non-empty bounded text`);
  }
  return value;
}

function isoDate(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new EvidenceRepositoryError("invalid_input", `${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function mediaType(value) {
  const normalized = String(value ?? "").split(";", 1)[0].trim().toLocaleLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)) {
    throw new EvidenceRepositoryError("invalid_input", "mediaType is invalid");
  }
  return normalized;
}

function normalizedIdentity(value, index) {
  if (!isRecord(value)) throw new EvidenceRepositoryError("invalid_input", `productIdentities[${index}] must be an object`);
  const brand = safeText(value.brand, `productIdentities[${index}].brand`, { max: 120 });
  const basis = String(value.basis ?? "legacy-unverified");
  if (!IDENTITY_BASES.has(basis)) {
    throw new EvidenceRepositoryError("invalid_input", `productIdentities[${index}].basis is invalid`);
  }
  const model = safeText(value.model, `productIdentities[${index}].model`, { max: 240, optional: true });
  const mpn = safeText(value.mpn, `productIdentities[${index}].mpn`, { max: 160, optional: true });
  const skuId = safeText(value.skuId, `productIdentities[${index}].skuId`, { max: 160, optional: true });
  const category = value.category === undefined ? undefined : String(value.category);
  if (category !== undefined && !PRODUCT_CATEGORIES.has(category)) {
    throw new EvidenceRepositoryError("invalid_input", `productIdentities[${index}].category is invalid`);
  }
  return {
    brand,
    basis,
    ...(model ? { model } : {}),
    ...(mpn ? { mpn } : {}),
    ...(category ? { category } : {}),
    ...(skuId ? { skuId } : {}),
  };
}

function normalizedIdentities(value = []) {
  if (!Array.isArray(value) || value.length > 64) {
    throw new EvidenceRepositoryError("invalid_input", "productIdentities must be a bounded array");
  }
  const byValue = new Map();
  for (const [index, identity] of value.entries()) {
    const normalized = normalizedIdentity(identity, index);
    byValue.set(canonicalJson(normalized), normalized);
  }
  return [...byValue.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, identity]) => identity);
}

function normalizedUrl(raw, label = "URL") {
  let url;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    throw new EvidenceRepositoryError("invalid_input", `${label} is invalid`);
  }
  if (url.protocol !== "https:") throw new EvidenceRepositoryError("invalid_input", `${label} must use HTTPS`);
  if (url.username || url.password) throw new EvidenceRepositoryError("invalid_input", `${label} must not contain credentials`);
  if (url.toString().length > 4_096) throw new EvidenceRepositoryError("invalid_input", `${label} is too long`);
  url.hash = "";
  if (url.port === "443") url.port = "";
  return url.toString();
}

function documentId(hash) {
  return `doc-sha256-${hash}`;
}

function assertDocumentId(value) {
  if (typeof value !== "string" || !DOCUMENT_ID.test(value)) {
    throw new EvidenceRepositoryError("invalid_id", "Invalid evidence document id");
  }
  return value;
}

function assertCaptureId(value) {
  if (typeof value !== "string" || !CAPTURE_ID.test(value)) {
    throw new EvidenceRepositoryError("invalid_id", "Invalid evidence capture id");
  }
  return value;
}

function normalizeBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new EvidenceRepositoryError("invalid_input", "content must be a Buffer, Uint8Array, or ArrayBuffer");
}

function envelope(kind, payload) {
  return { schemaVersion: SCHEMA_VERSION, kind, checksum: recordChecksum(payload), payload };
}

function validatedEnvelope(value, expectedKind, label) {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || value.kind !== expectedKind || !ENVELOPE_KINDS.has(value.kind) || !("payload" in value)) {
    throw new EvidenceRepositoryError("corrupt_data", `${label} envelope is invalid`);
  }
  if (typeof value.checksum !== "string" || !SHA256.test(value.checksum) || value.checksum !== recordChecksum(value.payload)) {
    throw new EvidenceRepositoryError("corrupt_data", `${label} metadata integrity check failed`);
  }
  return value.payload;
}

function validatedDocument(value) {
  if (!isRecord(value)) throw new EvidenceRepositoryError("corrupt_data", "Evidence document is invalid");
  const match = typeof value.id === "string" ? DOCUMENT_ID.exec(value.id) : null;
  if (value.schemaVersion !== SCHEMA_VERSION || !match || value.sha256 !== match[1] || !SHA256.test(String(value.sha256 ?? ""))) {
    throw new EvidenceRepositoryError("corrupt_data", "Evidence document identity is invalid");
  }
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0) throw new EvidenceRepositoryError("corrupt_data", "Evidence document byteLength is invalid");
  mediaType(value.mediaType);
  isoDate(value.createdAt, "Evidence document createdAt");
  return value;
}

function validatedCapture(value) {
  if (!isRecord(value)) throw new EvidenceRepositoryError("corrupt_data", "Evidence capture is invalid");
  if (value.schemaVersion !== SCHEMA_VERSION || typeof value.id !== "string" || !CAPTURE_ID.test(value.id)) {
    throw new EvidenceRepositoryError("corrupt_data", "Evidence capture identity is invalid");
  }
  assertDocumentId(value.documentId);
  if (!DOCUMENT_KINDS.has(value.kind)) throw new EvidenceRepositoryError("corrupt_data", "Evidence capture kind is invalid");
  if (!KIND_BASES.has(value.kindBasis)) throw new EvidenceRepositoryError("corrupt_data", "Evidence capture kindBasis is invalid");
  safeText(value.title, "Evidence capture title", { max: 500 });
  normalizedIdentities(value.productIdentities);
  if (!ACQUISITION_METHODS.has(value.acquisitionMethod)) throw new EvidenceRepositoryError("corrupt_data", "Evidence capture acquisitionMethod is invalid");
  normalizedUrl(value.requestedUrl, "Evidence capture requestedUrl");
  normalizedUrl(value.finalUrl, "Evidence capture finalUrl");
  normalizedUrl(value.canonicalUrl, "Evidence capture canonicalUrl");
  isoDate(value.retrievedAt, "Evidence capture retrievedAt");
  if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599) throw new EvidenceRepositoryError("corrupt_data", "Evidence capture status is invalid");
  if (!Array.isArray(value.redirects) || value.redirects.length > 16) throw new EvidenceRepositoryError("corrupt_data", "Evidence capture redirects are invalid");
  value.redirects.forEach((url, index) => normalizedUrl(url, `Evidence capture redirects[${index}]`));
  safeText(value.etag, "Evidence capture etag", { max: 512, optional: true });
  safeText(value.lastModified, "Evidence capture lastModified", { max: 512, optional: true });
  safeText(value.officialBrand, "Evidence capture officialBrand", { max: 120 });
  const withoutId = { ...value };
  delete withoutId.id;
  const expected = `capture-sha256-${sha256(canonicalJson(withoutId))}`;
  if (value.id !== expected) throw new EvidenceRepositoryError("corrupt_data", "Evidence capture hash binding is invalid");
  return value;
}

function validatedUrlIndex(value) {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) throw new EvidenceRepositoryError("corrupt_data", "Evidence URL index is invalid");
  const url = normalizedUrl(value.url, "Evidence URL index URL");
  assertCaptureId(value.captureId);
  assertDocumentId(value.documentId);
  isoDate(value.retrievedAt, "Evidence URL index retrievedAt");
  if (value.url !== url) throw new EvidenceRepositoryError("corrupt_data", "Evidence URL index is not normalized");
  return value;
}

export class EvidenceRepositoryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "EvidenceRepositoryError";
    this.code = code;
  }
}

export class FileEvidenceRepository {
  constructor(options = {}) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? options.coordinator?.root ?? process.env.RUNTIME_ROOT ?? path.join(process.cwd(), "runtime"));
    this.root = path.resolve(options.root ?? path.join(runtimeRoot, "evidence"));
    this.coordinator = options.root ? null : options.coordinator ?? new RuntimeCoordinator({ root: runtimeRoot, now: options.now });
    this.now = options.now ?? (() => new Date().toISOString());
    this.queues = new Map();
    this.boundary = new AsyncLocalStorage();
  }

  async assertLegacyRootEmpty() {
    if (!this.coordinator) return;
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    if (entries.some((entry) => !entry.name.startsWith("."))) throw new EvidenceRepositoryError("legacy_migration_required", "Legacy runtime/evidence contains data; run the explicit active-generation migration dry-run before startup");
  }

  atActiveRoot(activeRoot) { return new FileEvidenceRepository({ root: confined(activeRoot, "evidence"), now: this.now }); }

  async publicBoundary(write, coordinated, local) {
    if (this.coordinator) {
      await this.coordinator.initialize();
      await this.assertLegacyRootEmpty();
      if (write) return (await this.coordinator.withWrite(({ activeRoot }) => coordinated(this.atActiveRoot(activeRoot)))).result;
      return (await this.coordinator.withConsistentSnapshot(({ activeRoot }) => coordinated(this.atActiveRoot(activeRoot)))).result;
    }
    if (this.boundary.getStore()) return local();
    return withDirectoryLock(confined(this.root, ".locks", "repository-global"), () => this.boundary.run(true, local));
  }

  confined(...parts) {
    const target = path.resolve(this.root, ...parts);
    const relative = path.relative(this.root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new EvidenceRepositoryError("invalid_path", "Evidence storage path escapes the repository root");
    }
    return target;
  }

  blobPath(hash) {
    if (typeof hash !== "string" || !SHA256.test(hash)) throw new EvidenceRepositoryError("invalid_id", "Invalid evidence content hash");
    return this.confined("blobs", "sha256", hash.slice(0, 2), hash);
  }

  documentPath(id) {
    const match = DOCUMENT_ID.exec(assertDocumentId(id));
    return this.confined("documents", match[1].slice(0, 2), `${id}.json`);
  }

  capturePath(id) {
    const match = CAPTURE_ID.exec(assertCaptureId(id));
    return this.confined("captures", match[1].slice(0, 2), `${id}.json`);
  }

  urlIndexPath(url) {
    const normalized = normalizedUrl(url, "Evidence source URL");
    const hash = sha256(normalized);
    return { normalized, file: this.confined("source-index", hash.slice(0, 2), `${hash}.json`) };
  }

  async serialize(key, operation) {
    const prior = this.queues.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    this.queues.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }

  async syncDirectory(directory) {
    const handle = await open(directory, "r").catch(() => null);
    try {
      await handle?.sync();
    } finally {
      await handle?.close();
    }
  }

  async writeTemporary(file, content) {
    await ensurePrivateDirectory(path.dirname(file));
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    let complete = false;
    try {
      await handle.writeFile(content);
      await handle.sync();
      complete = true;
    } finally {
      await handle.close();
      if (!complete) await unlink(temporary).catch(() => undefined);
    }
    return temporary;
  }

  async createImmutable(file, content) {
    const temporary = await this.writeTemporary(file, content);
    try {
      await link(temporary, file);
      await this.syncDirectory(path.dirname(file));
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return false;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async replaceAtomic(file, content) {
    const prior = await readFile(file).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    let backup = null;
    if (prior) {
      backup = this.confined(".rollback", `${Date.now()}-${crypto.randomUUID()}-${path.basename(file)}.bak`);
      await atomicWriteFile(backup, prior);
    }
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const manifestFile = this.confined(".rollback", "manifest.json");
    const manifest = await readFile(manifestFile, "utf8").then((raw) => JSON.parse(raw)).catch((error) => error?.code === "ENOENT" ? { schemaVersion: "evidence-rollback-manifest-v1", entries: [] } : Promise.reject(error));
    const eventId = crypto.randomUUID();
    const prepared = { eventId, operation: "replace-index", target: path.relative(this.root, file), backup: backup ? path.relative(this.root, backup) : null, previousHash: prior ? sha256Bytes(prior) : null, nextHash: sha256Bytes(bytes), status: "prepared", createdAt: this.now() };
    await atomicWriteJson(manifestFile, { ...manifest, entries: [...(manifest.entries ?? []), prepared] });
    await atomicWriteFile(file, bytes);
    await atomicWriteJson(manifestFile, { ...manifest, entries: [...(manifest.entries ?? []), { ...prepared, status: "committed", committedAt: this.now() }] });
  }

  async readEnvelope(file, kind, label, { optional = false } = {}) {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (optional && error?.code === "ENOENT") return null;
      if (error?.code === "ENOENT") throw new EvidenceRepositoryError("not_found", `${label} was not found`);
      throw new EvidenceRepositoryError("corrupt_data", `Unable to read ${label}: ${error?.message ?? error}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new EvidenceRepositoryError("corrupt_data", `${label} contains invalid JSON`);
    }
    return validatedEnvelope(parsed, kind, label);
  }

  async writeImmutableEnvelope(file, kind, payload, validator, options = {}) {
    const body = `${JSON.stringify(envelope(kind, payload), null, 2)}\n`;
    const created = await this.createImmutable(file, body);
    if (created) return { created: true, value: payload };
    const existing = validator(await this.readEnvelope(file, kind, kind));
    const compatible = options.compatible ?? ((left, right) => canonicalJson(left) === canonicalJson(right));
    if (!compatible(existing, payload)) {
      throw new EvidenceRepositoryError("integrity_error", `${kind} id collision or immutable metadata mismatch`);
    }
    return { created: false, value: existing };
  }

  async verifyBlob(document) {
    return this.publicBoundary(false, (repository) => repository.verifyBlob(document), async () => {
    const file = this.blobPath(document.sha256);
    let bytes;
    try {
      bytes = await readFile(file);
    } catch (error) {
      if (error?.code === "ENOENT") throw new EvidenceRepositoryError("integrity_error", "Evidence content blob is missing");
      throw new EvidenceRepositoryError("integrity_error", `Unable to read evidence content blob: ${error?.message ?? error}`);
    }
    if (bytes.byteLength !== document.byteLength || sha256(bytes) !== document.sha256) {
      throw new EvidenceRepositoryError("integrity_error", "Evidence content integrity check failed");
    }
    return bytes;
    });
  }

  async verifyExistingBlob(hash, expectedLength) {
    return this.publicBoundary(false, (repository) => repository.verifyExistingBlob(hash, expectedLength), async () => {
    const file = this.blobPath(hash);
    let info;
    try {
      info = await stat(file);
    } catch (error) {
      if (error?.code === "ENOENT") throw new EvidenceRepositoryError("integrity_error", "Evidence content blob disappeared during import");
      throw error;
    }
    if (!info.isFile() || info.size !== expectedLength) throw new EvidenceRepositoryError("integrity_error", "Existing evidence blob size does not match its hash");
    const bytes = await readFile(file);
    if (sha256(bytes) !== hash) throw new EvidenceRepositoryError("integrity_error", "Existing evidence blob hash is invalid");
    });
  }

  normalizeImport(input, hash, byteLength) {
    if (!isRecord(input)) throw new EvidenceRepositoryError("invalid_input", "Evidence import metadata must be an object");
    const captureInput = input.capture;
    if (!isRecord(captureInput)) throw new EvidenceRepositoryError("invalid_input", "Evidence import capture metadata is required");
    const defaultTime = isoDate(captureInput.retrievedAt ?? input.createdAt ?? this.now(), "Evidence import timestamp");
    const kind = String(input.kind ?? "");
    if (!DOCUMENT_KINDS.has(kind)) throw new EvidenceRepositoryError("invalid_input", "Evidence document kind is invalid");
    const document = {
      schemaVersion: SCHEMA_VERSION,
      id: documentId(hash),
      sha256: hash,
      byteLength,
      mediaType: mediaType(input.mediaType),
      createdAt: isoDate(input.createdAt ?? defaultTime, "Evidence document createdAt"),
    };
    const requestedUrl = normalizedUrl(captureInput.requestedUrl, "Evidence capture requestedUrl");
    const finalUrl = normalizedUrl(captureInput.finalUrl, "Evidence capture finalUrl");
    const canonicalUrl = normalizedUrl(captureInput.canonicalUrl ?? finalUrl, "Evidence capture canonicalUrl");
    const redirects = captureInput.redirects ?? [];
    if (!Array.isArray(redirects) || redirects.length > 16) throw new EvidenceRepositoryError("invalid_input", "Evidence capture redirects must be a bounded array");
    const captureWithoutId = {
      schemaVersion: SCHEMA_VERSION,
      documentId: document.id,
      acquisitionMethod: String(captureInput.acquisitionMethod ?? ""),
      kind,
      kindBasis: String(captureInput.kindBasis ?? "legacy-unverified"),
      title: safeText(input.title, "Evidence capture title", { max: 500 }),
      productIdentities: normalizedIdentities(input.productIdentities),
      requestedUrl,
      finalUrl,
      canonicalUrl,
      retrievedAt: isoDate(captureInput.retrievedAt ?? defaultTime, "Evidence capture retrievedAt"),
      status: Number(captureInput.status),
      redirects: redirects.map((url, index) => normalizedUrl(url, `Evidence capture redirects[${index}]`)),
      ...(captureInput.etag !== undefined ? { etag: safeText(captureInput.etag, "Evidence capture etag", { max: 512 }) } : {}),
      ...(captureInput.lastModified !== undefined ? { lastModified: safeText(captureInput.lastModified, "Evidence capture lastModified", { max: 512 }) } : {}),
      officialBrand: safeText(captureInput.officialBrand, "Evidence capture officialBrand", { max: 120 }),
    };
    if (!ACQUISITION_METHODS.has(captureWithoutId.acquisitionMethod)) {
      throw new EvidenceRepositoryError("invalid_input", "Evidence capture acquisitionMethod is invalid");
    }
    if (!KIND_BASES.has(captureWithoutId.kindBasis)) {
      throw new EvidenceRepositoryError("invalid_input", "Evidence capture kindBasis is invalid");
    }
    if (!Number.isInteger(captureWithoutId.status) || captureWithoutId.status < 100 || captureWithoutId.status > 599) {
      throw new EvidenceRepositoryError("invalid_input", "Evidence capture status is invalid");
    }
    const capture = {
      ...captureWithoutId,
      id: `capture-sha256-${sha256(canonicalJson(captureWithoutId))}`,
    };
    // Keep the public contract order stable and validate its deterministic id.
    const orderedCapture = {
      schemaVersion: capture.schemaVersion,
      id: capture.id,
      documentId: capture.documentId,
      acquisitionMethod: capture.acquisitionMethod,
      kind: capture.kind,
      kindBasis: capture.kindBasis,
      title: capture.title,
      productIdentities: capture.productIdentities,
      requestedUrl: capture.requestedUrl,
      finalUrl: capture.finalUrl,
      canonicalUrl: capture.canonicalUrl,
      retrievedAt: capture.retrievedAt,
      status: capture.status,
      redirects: capture.redirects,
      ...(capture.etag ? { etag: capture.etag } : {}),
      ...(capture.lastModified ? { lastModified: capture.lastModified } : {}),
      officialBrand: capture.officialBrand,
    };
    return { document, capture: orderedCapture };
  }

  async updateUrlIndex(url, capture) {
    return this.publicBoundary(true, (repository) => repository.updateUrlIndex(url, capture), async () => {
    const { normalized, file } = this.urlIndexPath(url);
    return this.serialize(file, async () => {
      const currentPayload = await this.readEnvelope(file, "evidence-url-index", "Evidence URL index", { optional: true });
      const current = currentPayload ? validatedUrlIndex(currentPayload) : null;
      if (current) {
        const currentTime = Date.parse(current.retrievedAt);
        const nextTime = Date.parse(capture.retrievedAt);
        if (currentTime > nextTime || (currentTime === nextTime && current.captureId.localeCompare(capture.id) >= 0)) return current;
      }
      const next = {
        schemaVersion: SCHEMA_VERSION,
        url: normalized,
        captureId: capture.id,
        documentId: capture.documentId,
        retrievedAt: capture.retrievedAt,
      };
      await this.replaceAtomic(file, `${JSON.stringify(envelope("evidence-url-index", next), null, 2)}\n`);
      return next;
    });
    });
  }

  async importBuffer(content, input) {
    return this.publicBoundary(true, (repository) => repository.importBuffer(content, input), async () => {
    const bytes = normalizeBuffer(content);
    const hash = sha256(bytes);
    const normalized = this.normalizeImport(input, hash, bytes.byteLength);

    const blobFile = this.blobPath(hash);
    const createdBlob = await this.createImmutable(blobFile, bytes);
    if (!createdBlob) await this.verifyExistingBlob(hash, bytes.byteLength);

    const writtenDocument = await this.writeImmutableEnvelope(
      this.documentPath(normalized.document.id),
      "evidence-document",
      normalized.document,
      validatedDocument,
      {
        compatible: (existing, incoming) => existing.id === incoming.id
          && existing.sha256 === incoming.sha256
          && existing.byteLength === incoming.byteLength
          && existing.mediaType === incoming.mediaType,
      },
    );
    const persistedDocument = validatedDocument(writtenDocument.value);
    if (persistedDocument.sha256 !== hash || persistedDocument.byteLength !== bytes.byteLength) {
      throw new EvidenceRepositoryError("integrity_error", "Existing evidence document does not match imported content");
    }

    const capture = { ...normalized.capture, documentId: persistedDocument.id };
    const captureWithoutId = { ...capture };
    delete captureWithoutId.id;
    capture.id = `capture-sha256-${sha256(canonicalJson(captureWithoutId))}`;
    const writtenCapture = await this.writeImmutableEnvelope(
      this.capturePath(capture.id),
      "evidence-capture",
      capture,
      validatedCapture,
    );
    const persistedCapture = validatedCapture(writtenCapture.value);
    const aliases = [...new Set([persistedCapture.requestedUrl, persistedCapture.finalUrl, persistedCapture.canonicalUrl])];
    // The rollback manifest is one ordered journal; keep alias replacements in
    // that same order instead of racing independent read-modify-write appends.
    for (const url of aliases) await this.updateUrlIndex(url, persistedCapture);

    return deepFreeze({
      document: clone(persistedDocument),
      capture: clone(persistedCapture),
      reusedDocument: !writtenDocument.created,
      reusedCapture: !writtenCapture.created,
    });
    });
  }

  async importFile(file, input) {
    return this.publicBoundary(true, (repository) => repository.importFile(file, input), async () => {
    if (typeof file !== "string" || !file) throw new EvidenceRepositoryError("invalid_input", "Evidence import file path is required");
    let bytes;
    try {
      bytes = await readFile(file);
    } catch (error) {
      if (error?.code === "ENOENT") throw new EvidenceRepositoryError("not_found", "Evidence import file was not found");
      throw new EvidenceRepositoryError("invalid_input", `Unable to read evidence import file: ${error?.message ?? error}`);
    }
    if (!isRecord(input)) throw new EvidenceRepositoryError("invalid_input", "Evidence import metadata must be an object");
    const capture = isRecord(input.capture) ? input.capture : {};
    return this.importBuffer(bytes, {
      ...input,
      capture: { ...capture, acquisitionMethod: capture.acquisitionMethod ?? "bundled-import" },
    });
    });
  }

  async readDocumentRecord(id) {
    return this.publicBoundary(false, (repository) => repository.readDocumentRecord(id), async () => {
      const payload = await this.readEnvelope(this.documentPath(id), "evidence-document", "Evidence document", { optional: true });
      return payload ? validatedDocument(payload) : null;
    });
  }

  async getDocument(id) {
    return this.publicBoundary(false, (repository) => repository.getDocument(id), async () => {
      const document = await this.readDocumentRecord(id);
      if (!document) return null;
      await this.verifyBlob(document);
      return deepFreeze(clone(document));
    });
  }

  /** Read and integrity-check immutable metadata and bytes in one pass. */
  async getDocumentContent(id) {
    return this.publicBoundary(false, (repository) => repository.getDocumentContent(id), async () => {
      const document = await this.readDocumentRecord(id);
      if (!document) return null;
      const bytes = await this.verifyBlob(document);
      return Object.freeze({ document: deepFreeze(clone(document)), bytes: Buffer.from(bytes) });
    });
  }

  async readCaptureRecord(id) {
    return this.publicBoundary(false, (repository) => repository.readCaptureRecord(id), async () => {
      const payload = await this.readEnvelope(this.capturePath(id), "evidence-capture", "Evidence capture", { optional: true });
      return payload ? validatedCapture(payload) : null;
    });
  }

  async getCapture(id) {
    return this.publicBoundary(false, (repository) => repository.getCapture(id), async () => {
      const capture = await this.readCaptureRecord(id);
      if (!capture) return null;
      if (!await this.readDocumentRecord(capture.documentId)) throw new EvidenceRepositoryError("integrity_error", "Evidence capture refers to a missing document");
      return deepFreeze(clone(capture));
    });
  }

  async readContent(id) {
    return this.publicBoundary(false, (repository) => repository.readContent(id), async () => {
      const document = await this.readDocumentRecord(id);
      if (!document) throw new EvidenceRepositoryError("not_found", "Evidence document was not found");
      return this.verifyBlob(document);
    });
  }

  async listCaptures(id) {
    return this.publicBoundary(false, (repository) => repository.listCaptures(id), async () => {
    assertDocumentId(id);
    if (!await this.readDocumentRecord(id)) throw new EvidenceRepositoryError("not_found", "Evidence document was not found");
    const root = this.confined("captures");
    let buckets;
    try {
      buckets = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const captures = [];
    for (const bucket of buckets) {
      if (!bucket.isDirectory() || !/^[a-f0-9]{2}$/.test(bucket.name)) continue;
      const directory = this.confined("captures", bucket.name);
      const files = await readdir(directory, { withFileTypes: true });
      for (const entry of files) {
        const match = /^(capture-sha256-[a-f0-9]{64})\.json$/.exec(entry.name);
        if (!entry.isFile() || !match) continue;
        const capture = await this.readCaptureRecord(match[1]);
        if (capture?.documentId === id) captures.push(capture);
      }
    }
    captures.sort((left, right) => right.retrievedAt.localeCompare(left.retrievedAt) || left.id.localeCompare(right.id));
    return deepFreeze(clone(captures));
    });
  }

  async getLatestCaptureForUrl(url) {
    return this.publicBoundary(false, (repository) => repository.getLatestCaptureForUrl(url), async () => {
    const { normalized, file } = this.urlIndexPath(url);
    const payload = await this.readEnvelope(file, "evidence-url-index", "Evidence URL index", { optional: true });
    if (!payload) return null;
    const index = validatedUrlIndex(payload);
    if (index.url !== normalized) throw new EvidenceRepositoryError("integrity_error", "Evidence URL index key mismatch");
    const capture = await this.readCaptureRecord(index.captureId);
    if (!capture || capture.documentId !== index.documentId || capture.retrievedAt !== index.retrievedAt) {
      throw new EvidenceRepositoryError("integrity_error", "Evidence URL index refers to an invalid capture");
    }
    const aliases = new Set([capture.requestedUrl, capture.finalUrl, capture.canonicalUrl]);
    if (!aliases.has(normalized)) throw new EvidenceRepositoryError("integrity_error", "Evidence URL index alias does not match its capture");
    if (!await this.readDocumentRecord(capture.documentId)) throw new EvidenceRepositoryError("integrity_error", "Evidence URL index refers to a missing document");
    return deepFreeze(clone(capture));
    });
  }

  async getLatestDocumentForUrl(url) {
    return this.publicBoundary(false, (repository) => repository.getLatestDocumentForUrl(url), async () => {
      const capture = await this.getLatestCaptureForUrl(url);
      return capture ? this.getDocument(capture.documentId) : null;
    });
  }

  /** Root-aware reads for a caller already holding the shared coordinator barrier. */
  async getDocumentAtRoot(activeRoot, id) { return this.atActiveRoot(activeRoot).getDocument(id); }
  async getCaptureAtRoot(activeRoot, id) { return this.atActiveRoot(activeRoot).getCapture(id); }
}

export function normalizeEvidenceUrl(url) {
  return normalizedUrl(url, "Evidence URL");
}
