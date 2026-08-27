import { createHash } from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { decodeTransactionImage } from "./receipt.mjs";
import { atomicWriteJson, atomicWriteFile, ensurePrivateDirectory, pathExists, withDirectoryLock } from "../../../src/runtime/fs.mjs";

const RECEIPT_ID = /^[A-Za-z0-9_-]{1,96}$/;
const MOBILE_PHONE = /(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}/gu;
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const CHINESE_ID = /(?<!\d)\d{17}[\dX](?!\d)/giu;
const LABELED_PERSONAL = /(?:姓名|收货人|联系人|电话|手机|邮箱|电子邮件|地址|住址)\s*[:：]?\s*[^，,;；\n]{1,80}/giu;
const POSTAL_ADDRESS = /[\p{Script=Han}A-Za-z0-9]{2,40}(?:省|自治区|市|自治州|区|县)[^，,;；\n]{2,80}(?:路|街|巷|弄|号|栋|室)/gu;
const SHA256 = /^[a-f0-9]{64}$/u;
const GENERIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/u;
const PLAN_ID = /^plan-[A-Za-z0-9][A-Za-z0-9-]{0,79}$/u;
const PLAN_VERSION_ID = /^version-[A-Za-z0-9][A-Za-z0-9-]{0,119}$/u;
const CATALOG_JOB_ID = /^catalog-search-[a-f0-9]{20}$/u;
const CANDIDATE_ID = /^(?:catalog-candidate-[a-f0-9]{16}|price-candidate-[a-f0-9]{20})$/u;
const DRAFT_ID = /^sku-draft-[a-f0-9]{20}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MIME_EXTENSION = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

function assertReceiptId(value) {
  const receiptId = String(value ?? "");
  if (!RECEIPT_ID.test(receiptId)) throw new Error("Invalid receiptId");
  if (/(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}/u.test(receiptId)) throw new Error("receiptId must not contain a phone number");
  return receiptId;
}

function text(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function redactPrivateTransactionText(value, max = 360) {
  const source = text(value, max);
  const redact = (input) => input
    .replace(MOBILE_PHONE, "[REDACTED-PHONE]")
    .replace(EMAIL_ADDRESS, "[REDACTED-EMAIL]")
    .replace(CHINESE_ID, "[REDACTED-ID]")
    .replace(LABELED_PERSONAL, "[REDACTED-PERSONAL]")
    .replace(POSTAL_ADDRESS, "[REDACTED-ADDRESS]");
  const redacted = redact(source);
  if (redacted !== source) return redacted;
  try {
    const decoded = decodeURIComponent(source);
    if (decoded !== source && redact(decoded) !== decoded) return "[REDACTED-ENCODED-PERSONAL]";
  } catch { /* Malformed escapes contain no decodable private text. */ }
  return source;
}

function safeOfficialUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const decodedPath = decodeURIComponent(url.pathname);
    if (redactPrivateTransactionText(decodedPath, decodedPath.length) !== decodedPath) return null;
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 1_000);
  } catch { return null; }
}

function nullableNumber(value) {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : null;
}

function governedId(value, pattern, label, { nullable = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (nullable) return null;
    throw new Error(`${label} is required`);
  }
  const candidate = String(value).trim();
  if (!pattern.test(candidate) || redactPrivateTransactionText(candidate, candidate.length) !== candidate) {
    throw new Error(`${label} is invalid or contains private data`);
  }
  return candidate;
}

function governedIso(value, label, fallback) {
  const candidate = value ?? fallback;
  if (typeof candidate !== "string" || !ISO_DATE.test(candidate) || !Number.isFinite(Date.parse(candidate))) throw new Error(`${label} is invalid`);
  return candidate;
}

function sanitizeLink(raw) {
  const link = raw && typeof raw === "object" ? raw : {};
  const planId = governedId(link.planId, PLAN_ID, "planId");
  const planItemId = governedId(link.planItemId, GENERIC_ID, "planItemId");
  const requestedStatus = ["linked", "unlinked", "stale"].includes(link.linkStatus) ? link.linkStatus : "unlinked";
  return {
    schemaVersion: "1.0.0",
    planId,
    planVersionIdAtCapture: governedId(link.planVersionIdAtCapture, PLAN_VERSION_ID, "planVersionIdAtCapture"),
    planItemId,
    linkStatus: planId && planItemId && requestedStatus === "linked" ? "linked" : requestedStatus === "stale" && planId ? "stale" : "unlinked",
  };
}

function sanitizeItem(raw, receiptId, options = {}) {
  if (!raw || typeof raw !== "object") throw new Error("交易记录不能为空");
  const evidence = raw.transaction && typeof raw.transaction === "object" ? raw.transaction : {};
  if (String(evidence.receiptId ?? "") !== receiptId) throw new Error("交易记录与截图编号不一致");
  const contentHash = String(evidence.contentHash ?? options.imageEvidence?.contentHash ?? "").toLowerCase();
  if (!SHA256.test(contentHash)) throw new Error("transaction contentHash is invalid");
  return {
    id: governedId(raw.id, GENERIC_ID, "item.id", { nullable: false }),
    skuId: governedId(raw.skuId, GENERIC_ID, "item.skuId"),
    name: redactPrivateTransactionText(raw.name, 240) || "未命名部件",
    category: redactPrivateTransactionText(raw.category, 80) || "其他",
    qty: Math.min(99, Math.max(1, Math.round(Number(raw.qty) || 1))),
    unitPriceCny: nullableNumber(raw.unitPriceCny),
    stage: ["candidate", "locked", "purchased", "installed"].includes(raw.stage) ? raw.stage : "purchased",
    source: raw.source === "catalog" ? "catalog" : "transaction",
    transaction: {
      receiptId,
      fileName: evidence.fileName ? "transaction-screenshot" : "",
      contentHash,
      capturedAt: governedIso(evidence.capturedAt, "transaction capturedAt", options.legacy ? options.storedAt : undefined),
      ocrEngine: redactPrivateTransactionText(evidence.ocrEngine, 160),
      ocrConfidence: Number.isFinite(evidence.ocrConfidence) ? Number(evidence.ocrConfidence) : null,
      excerpt: redactPrivateTransactionText(evidence.excerpt),
      verification: redactPrivateTransactionText(evidence.verification, 80),
      catalogJobId: governedId(evidence.catalogJobId, CATALOG_JOB_ID, "catalogJobId"),
      candidateId: governedId(evidence.candidateId, CANDIDATE_ID, "candidateId"),
      draftId: governedId(evidence.draftId, DRAFT_ID, "draftId"),
      officialUrl: safeOfficialUrl(evidence.officialUrl),
      sourceReview: evidence.sourceReview === "user-confirmed" ? "user-confirmed" : undefined,
    },
  };
}

function sanitizeImageEvidence(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== "object" || !/^image\/(?:png|jpeg|webp|gif)$/u.test(String(raw.mimeType ?? ""))
    || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0 || !SHA256.test(String(raw.contentHash ?? ""))
    || !["discarded_after_verification", "legacy_source_retained_not_copied"].includes(raw.persistence)) {
    throw new Error("transaction image evidence is invalid");
  }
  return {
    ...(raw.fileName ? { fileName: "transaction-screenshot" } : {}),
    mimeType: raw.mimeType,
    bytes: raw.bytes,
    contentHash: raw.contentHash,
    persistence: raw.persistence,
  };
}

function assertNoResidualPrivateData(value, key = "") {
  if (typeof value === "string") {
    if (!/(?:hash|checksum)$/iu.test(key) && redactPrivateTransactionText(value, value.length) !== value) {
      throw new Error("transaction record contains residual private data");
    }
    return;
  }
  if (Array.isArray(value)) { for (const entry of value) assertNoResidualPrivateData(entry, key); return; }
  if (!value || typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(value)) assertNoResidualPrivateData(child, childKey);
}

/** Strict allowlist serializer shared by live writes and legacy migration. */
export function sanitizeTransactionRecordForPersistence(raw, options = {}) {
  if (!raw || typeof raw !== "object") throw new Error("transaction record is invalid");
  const receiptId = assertReceiptId(raw.receiptId);
  const storedAt = governedIso(raw.storedAt, "transaction storedAt", options.storedAt);
  const updatedAt = governedIso(raw.updatedAt, "transaction updatedAt", storedAt);
  const imageEvidence = sanitizeImageEvidence(raw.imageEvidence);
  const record = {
    schemaVersion: 2,
    receiptId,
    storedAt,
    updatedAt,
    item: sanitizeItem(raw.item, receiptId, { legacy: options.legacy === true, storedAt, imageEvidence }),
    link: sanitizeLink(raw.link),
    image: null,
    ...(imageEvidence ? { imageEvidence } : {}),
    ...(raw.deleted === true ? { deleted: true, deletedAt: governedIso(raw.deletedAt, "transaction deletedAt", updatedAt) } : {}),
  };
  assertNoResidualPrivateData(record);
  return record;
}

function metadataPath(root, receiptId) {
  return path.join(root, `${receiptId}.json`);
}

function digest(value) {
  return value == null ? null : createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function relativeTarget(root, target) {
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) throw new Error("transaction journal target escapes archive root");
  return relative;
}

async function readArchiveJournal(file) {
  let payload;
  try { payload = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return { schemaVersion: "transactions-rollback-v2", entries: [] }; throw error; }
  const unsigned = { schemaVersion: payload.schemaVersion, entries: payload.entries };
  if (payload.schemaVersion !== "transactions-rollback-v2" || !Array.isArray(payload.entries) || payload.checksum !== digest(unsigned)) throw new Error("transaction rollback journal is corrupt");
  return payload;
}

async function writeArchiveJournal(file, payload) {
  const unsigned = { schemaVersion: "transactions-rollback-v2", entries: payload.entries };
  await atomicJson(file, { ...unsigned, checksum: digest(unsigned) });
}

async function prepareArchiveJournal(root, entry) {
  const manifest = path.join(root, "rollback", "transactions-manifest.json");
  const payload = await readArchiveJournal(manifest);
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeArchiveJournal(manifest, { entries: [...payload.entries, { ...entry, id, state: "prepared", createdAt: new Date().toISOString() }] });
  return { manifest, id };
}

async function commitArchiveJournal(journal) {
  const payload = await readArchiveJournal(journal.manifest);
  const index = payload.entries.findIndex((entry) => entry.id === journal.id);
  if (index < 0 || payload.entries[index].state !== "prepared") throw new Error("transaction journal CAS conflict");
  const entries = payload.entries.slice(); entries[index] = { ...entries[index], state: "committed", committedAt: new Date().toISOString() };
  await writeArchiveJournal(journal.manifest, { entries });
}

function settledJournalEntry(entry) {
  const {
    source: _source,
    preparedTargets: _preparedTargets,
    cleanupTargets: _cleanupTargets,
    previousBase64: _previousBase64,
    ...settled
  } = entry;
  return settled;
}

async function settleArchiveJournal(journal) {
  const payload = await readArchiveJournal(journal.manifest);
  const index = payload.entries.findIndex((entry) => entry.id === journal.id);
  if (index < 0 || payload.entries[index].state !== "committed") throw new Error("transaction journal settlement conflict");
  const entries = payload.entries.slice();
  entries[index] = settledJournalEntry(entries[index]);
  await writeArchiveJournal(journal.manifest, { entries });
}

async function recoverArchiveJournal(root) {
  const manifest = path.join(root, "rollback", "transactions-manifest.json");
  const payload = await readArchiveJournal(manifest);
  let changed = false;
  const entries = [];
  for (const entry of payload.entries) {
    if (!entry || typeof entry.id !== "string" || !["prepared", "committed", "rolled_back"].includes(entry.state)
      || typeof entry.target !== "string" || entry.target.startsWith("/") || entry.target.includes("..")) throw new Error("transaction rollback journal entry is corrupt");
    if (Object.prototype.hasOwnProperty.call(entry, "previousBase64")) {
      throw new Error("legacy reversible transaction journal payload requires explicit runtime migration quarantine");
    }
    const safeEntry = { ...entry };
    const target = path.resolve(root, entry.target);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("transaction rollback journal target escapes archive root");
    const confinedTargets = (values) => (values ?? []).map((value) => {
      if (typeof value !== "string" || value.startsWith("/") || value.includes("..")) throw new Error("transaction rollback journal cleanup target is corrupt");
      const resolved = path.resolve(root, value);
      if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("transaction rollback journal cleanup target escapes archive root");
      return resolved;
    });
    const preparedTargets = confinedTargets(entry.preparedTargets);
    const cleanupTargets = confinedTargets(entry.cleanupTargets);
    if (entry.state === "rolled_back") { entries.push(settledJournalEntry(safeEntry)); changed ||= canonicalJournalEntryChanged(entry); continue; }
    if (entry.state === "prepared") {
      if (entry.source && entry.source !== entry.target) {
        await unlink(target).catch((error) => { if (error?.code !== "ENOENT") throw error; });
      } else {
        let currentHash = null;
        try { currentHash = digest(JSON.parse(await readFile(target, "utf8"))); }
        catch (error) { if (error?.code !== "ENOENT") throw new Error("transaction rollback target is corrupt"); }
        if (currentHash === entry.nextHash) {
          for (const cleanup of cleanupTargets) await unlink(cleanup).catch((error) => { if (error?.code !== "ENOENT") throw error; });
          entries.push(settledJournalEntry({ ...safeEntry, state: "committed", committedAt: new Date().toISOString(), recoveredAt: new Date().toISOString() }));
          changed = true;
          continue;
        }
        if (currentHash !== (entry.previousHash ?? null)) throw new Error("transaction rollback target does not match previous or next hash");
      }
      for (const prepared of preparedTargets) await unlink(prepared).catch((error) => { if (error?.code !== "ENOENT") throw error; });
      entries.push(settledJournalEntry({ ...safeEntry, state: "rolled_back", rolledBackAt: new Date().toISOString() }));
      changed = true;
      continue;
    }
    if (entry.source && entry.source !== entry.target) {
      const source = path.resolve(root, entry.source);
      if (!source.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("transaction rollback journal source escapes archive root");
      await unlink(source).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    }
    for (const cleanup of cleanupTargets) await unlink(cleanup).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    const settled = settledJournalEntry(safeEntry);
    entries.push(settled);
    changed ||= canonicalJournalEntryChanged(entry);
  }
  if (changed) await writeArchiveJournal(manifest, { entries });
}

function canonicalJournalEntryChanged(entry) {
  return ["source", "preparedTargets", "cleanupTargets", "previousBase64"]
    .some((field) => Object.prototype.hasOwnProperty.call(entry, field));
}

async function assertArchiveJournalSettled(root) {
  const payload = await readArchiveJournal(path.join(root, "rollback", "transactions-manifest.json"));
  for (const entry of payload.entries) {
    if (!entry || typeof entry.id !== "string" || !["prepared", "committed", "rolled_back"].includes(entry.state)
      || canonicalJournalEntryChanged(entry)) throw new Error("transaction rollback journal requires write-side settlement");
    if (entry.state === "prepared") throw new Error("transaction archive requires write-side journal recovery");
    const pending = [
      ...(entry.source && entry.source !== entry.target ? [entry.source] : []),
      ...(entry.cleanupTargets ?? []),
    ];
    for (const relative of pending) if (await pathExists(path.resolve(root, relative))) throw new Error("transaction archive requires write-side cleanup recovery");
  }
}

async function atomicJson(file, payload) {
  await atomicWriteJson(file, payload);
}

function explicitRoot(options = {}) {
  if (options.root) return path.resolve(options.root);
  return null;
}

async function coordinatorFor(options = {}) {
  if (options.coordinator) return options.coordinator;
  return null;
}

function scopeRoot(base, link) {
  const linked = link?.linkStatus === "linked" && typeof link.planId === "string" && link.planId;
  // Plan ids are data, not paths. Encoding keeps transaction records confined
  // to one plan directory while preserving an inspectable archive layout.
  return path.join(base, linked ? "plans" : "quarantine", ...(linked ? [encodeURIComponent(link.planId)] : []));
}

async function withArchiveWrite(options, operation) {
  const root = explicitRoot(options);
  if (root) return withDirectoryLock(path.join(root, ".locks", "transactions"), async () => { await recoverArchiveJournal(root); return operation(root, false); });
  const coordinator = await coordinatorFor(options);
  if (coordinator) return (await coordinator.withWrite(async ({ activeRoot }) => { const root = path.join(activeRoot, "transactions"); await recoverArchiveJournal(root); return operation(root, true); }, options)).result;
  const fallback = path.resolve(process.cwd(), "runtime/transactions");
  return withDirectoryLock(path.join(fallback, ".locks", "transactions"), async () => { await recoverArchiveJournal(fallback); return operation(fallback, false); });
}

async function withArchiveRead(options, operation) {
  const root = explicitRoot(options);
  if (root) { await assertArchiveJournalSettled(root); return operation(root); }
  const coordinator = await coordinatorFor(options);
  if (coordinator) return (await coordinator.withConsistentSnapshot(async ({ activeRoot }) => { const root = path.join(activeRoot, "transactions"); await assertArchiveJournalSettled(root); return operation(root); })).result;
  const fallback = path.resolve(process.cwd(), "runtime/transactions"); await assertArchiveJournalSettled(fallback); return operation(fallback);
}

async function findMetadata(root, receiptId) {
  const candidates = [path.join(root, `${receiptId}.json`), path.join(root, "quarantine", `${receiptId}.json`)];
  try {
    for (const plan of await readdir(path.join(root, "plans"), { withFileTypes: true })) {
      if (plan.isDirectory()) candidates.push(path.join(root, "plans", plan.name, `${receiptId}.json`));
    }
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
  return path.join(root, "quarantine", `${receiptId}.json`);
}

async function readRecord(file) {
  const record = JSON.parse(await readFile(file, "utf8"));
  if (!record || typeof record !== "object" || typeof record.receiptId !== "string") throw new Error("交易归档记录损坏");
  return record;
}

async function verifyImage(root, record, metadataFile) {
  if (!record.image) return;
  const image = record.image;
  const expectedName = `${record.receiptId}.${MIME_EXTENSION.get(image.mimeType)}`;
  if (!MIME_EXTENSION.has(image.mimeType) || image.storageName !== expectedName) throw new Error("Invalid archived image path");
  const bytes = await readFile(path.join(path.dirname(metadataFile), expectedName));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== image.contentHash || bytes.byteLength !== image.bytes) throw new Error("归档截图完整性校验失败");
}

function publicRecord(record) {
  const normalized = sanitizeTransactionRecordForPersistence(record, { legacy: record?.schemaVersion === 1 });
  return {
    ...normalized,
    image: normalized.image ? { ...normalized.image, imageUrl: `/api/price/transactions/archive/${encodeURIComponent(normalized.receiptId)}/image` } : null,
  };
}

export async function archiveTransaction(body, options) {
  const receiptId = assertReceiptId(body?.receiptId);
  const item = sanitizeItem(body?.item, receiptId);
  const decoded = decodeTransactionImage(body?.screenshotDataUrl);
  const contentHash = createHash("sha256").update(decoded.buffer).digest("hex");
  if (item.transaction.contentHash !== contentHash) throw new Error("截图内容哈希与 OCR 证据不一致");
  const extension = MIME_EXTENSION.get(decoded.mimeType);
  if (!extension) throw new Error("不支持的截图格式");
  return withArchiveWrite(options, async (root, scoped) => {
    const existingFile = await findMetadata(root, receiptId);
    if (await pathExists(existingFile)) {
      const existing = await readRecord(existingFile);
      await verifyImage(root, existing, existingFile);
      return publicRecord(existing);
    }
    const link = sanitizeLink(body?.link ?? body?.item?.planLink);
    const targetRoot = scoped ? scopeRoot(root, link) : root;
    await ensurePrivateDirectory(targetRoot);
    const storedAt = new Date().toISOString();
    const record = sanitizeTransactionRecordForPersistence({
      schemaVersion: 2,
      receiptId,
      storedAt,
      updatedAt: storedAt,
      item,
      link,
      // Order screenshots are untrusted private input and can contain names,
      // phone numbers or delivery addresses outside the OCR excerpt. U1 keeps
      // only non-reversible verification metadata; raw pixels are discarded.
      image: null,
      imageEvidence: { fileName: item.transaction.fileName, mimeType: decoded.mimeType, bytes: decoded.buffer.byteLength, contentHash, persistence: "discarded_after_verification" },
    });
    const metadata = path.join(targetRoot, `${receiptId}.json`);
    const journal = await prepareArchiveJournal(root, { operation: "transaction-archive", target: relativeTarget(root, metadata), previousHash: null, nextHash: digest(record), preparedTargets: [], cleanupTargets: [] });
    await atomicJson(metadata, record);
    await commitArchiveJournal(journal);
    await settleArchiveJournal(journal);
    return publicRecord(record);
  });
}

export async function updateTransactionArchive(receiptIdValue, body, options) {
  const receiptId = assertReceiptId(receiptIdValue);
  return withArchiveWrite(options, async (root, scoped) => {
    const file = await findMetadata(root, receiptId);
    const existing = await readRecord(file);
    await verifyImage(root, existing, file);
    const item = sanitizeItem({ ...existing.item, ...(body?.item ?? {}), transaction: existing.item?.transaction }, receiptId);
    const updatedAt = new Date().toISOString();
    const nextLink = sanitizeLink(body?.link ?? existing.link);
    const next = sanitizeTransactionRecordForPersistence({ ...existing, schemaVersion: 2, item, link: nextLink, updatedAt, deleted: undefined, deletedAt: undefined }, { legacy: existing.schemaVersion === 1 });
    const targetBase = scoped ? scopeRoot(root, nextLink) : root;
    await ensurePrivateDirectory(targetBase);
    const target = path.join(targetBase, `${receiptId}.json`);
    const moved = target !== file;
    const journal = await prepareArchiveJournal(root, {
      operation: "transaction-update", target: relativeTarget(root, target),
      ...(moved ? { source: relativeTarget(root, file) } : {}),
      previousHash: digest(existing), nextHash: digest(next),
      preparedTargets: moved && existing.image?.storageName ? [relativeTarget(root, path.join(targetBase, existing.image.storageName))] : [],
      cleanupTargets: moved && existing.image?.storageName ? [relativeTarget(root, path.join(path.dirname(file), existing.image.storageName))] : [],
    });
    if (existing.image?.storageName && path.dirname(file) !== targetBase) {
      const imageBytes = await readFile(path.join(path.dirname(file), existing.image.storageName));
      await atomicWriteFile(path.join(targetBase, existing.image.storageName), imageBytes);
    }
    await atomicJson(target, next);
    // The old source remains authoritative until the new metadata is durable.
    await commitArchiveJournal(journal);
    if (target !== file) await unlink(file).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    if (target !== file && existing.image?.storageName) await unlink(path.join(path.dirname(file), existing.image.storageName)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await settleArchiveJournal(journal);
    return publicRecord(next);
  });
}

export async function listTransactionArchives(options) {
  return withArchiveRead(options, async (root) => {
    const records = [];
    async function visit(directory) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "rollback") await visit(file);
        }
        else if (entry.isFile() && entry.name.endsWith(".json")) {
          const record = await readRecord(file); // Corruption is fail-closed.
          await verifyImage(root, record, file);
          if (!record.deleted) records.push(publicRecord(record));
        }
      }
    }
    await visit(root);
    return records.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  });
}

export async function readTransactionImage(receiptIdValue, options) {
  const receiptId = assertReceiptId(receiptIdValue);
  return withArchiveRead(options, async (root) => {
    const file = await findMetadata(root, receiptId);
    const record = await readRecord(file);
    await verifyImage(root, record, file);
    if (!record.image?.storageName) return null;
    return { buffer: await readFile(path.join(path.dirname(file), record.image.storageName)), mimeType: record.image.mimeType, fileName: record.image.fileName };
  });
}

export async function deleteTransactionImage(receiptIdValue, options) {
  const receiptId = assertReceiptId(receiptIdValue);
  return withArchiveWrite(options, async (root) => {
    const file = await findMetadata(root, receiptId);
    const record = await readRecord(file);
    await verifyImage(root, record, file);
    const cleanupTargets = record.image?.storageName ? [relativeTarget(root, path.join(path.dirname(file), record.image.storageName))] : [];
    const previousHash = digest(record);
    record.image = null;
    record.updatedAt = new Date().toISOString();
    const next = sanitizeTransactionRecordForPersistence(record, { legacy: record.schemaVersion === 1 });
    const journal = await prepareArchiveJournal(root, { operation: "transaction-image-delete", target: relativeTarget(root, file), previousHash, nextHash: digest(next), preparedTargets: [], cleanupTargets });
    await atomicJson(file, next);
    await commitArchiveJournal(journal);
    for (const target of cleanupTargets) await unlink(path.resolve(root, target)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await settleArchiveJournal(journal);
    return publicRecord(next);
  });
}

export async function deleteTransactionArchive(receiptIdValue, options) {
  const receiptId = assertReceiptId(receiptIdValue);
  return withArchiveWrite(options, async (root) => {
    const file = await findMetadata(root, receiptId);
    if (!await pathExists(file)) return { receiptId, deleted: false };
    const record = await readRecord(file);
    await verifyImage(root, record, file);
    const cleanupTargets = record.image?.storageName ? [relativeTarget(root, path.join(path.dirname(file), record.image.storageName))] : [];
    const previousHash = digest(record);
    record.image = null;
    record.deleted = true;
    record.deletedAt = new Date().toISOString();
    record.updatedAt = record.deletedAt;
    const next = sanitizeTransactionRecordForPersistence(record, { legacy: record.schemaVersion === 1 });
    const journal = await prepareArchiveJournal(root, { operation: "transaction-delete", target: relativeTarget(root, file), previousHash, nextHash: digest(next), preparedTargets: [], cleanupTargets });
    await atomicJson(file, next);
    await commitArchiveJournal(journal);
    for (const target of cleanupTargets) await unlink(path.resolve(root, target)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await settleArchiveJournal(journal);
    return { receiptId, deleted: true };
  });
}
