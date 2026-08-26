import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeTransactionImage } from "./receipt.mjs";

const RECEIPT_ID = /^[A-Za-z0-9_-]{1,96}$/;
const MIME_EXTENSION = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

function assertReceiptId(value) {
  const receiptId = String(value ?? "");
  if (!RECEIPT_ID.test(receiptId)) throw new Error("Invalid receiptId");
  return receiptId;
}

function text(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function nullableNumber(value) {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : null;
}

function nullableId(value, max = 180) {
  return value ? text(value, max) : null;
}

function sanitizeLink(raw) {
  const link = raw && typeof raw === "object" ? raw : {};
  const planId = nullableId(link.planId);
  const planItemId = nullableId(link.planItemId);
  const requestedStatus = ["linked", "unlinked", "stale"].includes(link.linkStatus) ? link.linkStatus : "unlinked";
  return {
    schemaVersion: "1.0.0",
    planId,
    planVersionIdAtCapture: nullableId(link.planVersionIdAtCapture),
    planItemId,
    linkStatus: planId && planItemId && requestedStatus === "linked" ? "linked" : requestedStatus === "stale" && planId ? "stale" : "unlinked",
  };
}

function sanitizeItem(raw, receiptId) {
  if (!raw || typeof raw !== "object") throw new Error("交易记录不能为空");
  const evidence = raw.transaction && typeof raw.transaction === "object" ? raw.transaction : {};
  if (String(evidence.receiptId ?? "") !== receiptId) throw new Error("交易记录与截图编号不一致");
  return {
    id: text(raw.id, 180),
    skuId: raw.skuId ? text(raw.skuId, 180) : null,
    name: text(raw.name, 240) || "未命名部件",
    category: text(raw.category, 80) || "其他",
    qty: Math.min(99, Math.max(1, Math.round(Number(raw.qty) || 1))),
    unitPriceCny: nullableNumber(raw.unitPriceCny),
    stage: ["candidate", "locked", "purchased", "installed"].includes(raw.stage) ? raw.stage : "purchased",
    source: raw.source === "catalog" ? "catalog" : "transaction",
    transaction: {
      receiptId,
      fileName: text(evidence.fileName, 160),
      contentHash: text(evidence.contentHash, 64).toLowerCase(),
      capturedAt: text(evidence.capturedAt, 64),
      ocrEngine: text(evidence.ocrEngine, 160),
      ocrConfidence: Number.isFinite(evidence.ocrConfidence) ? Number(evidence.ocrConfidence) : null,
      excerpt: text(evidence.excerpt, 360),
      verification: text(evidence.verification, 80),
      catalogJobId: evidence.catalogJobId ? text(evidence.catalogJobId, 160) : null,
      candidateId: evidence.candidateId ? text(evidence.candidateId, 160) : null,
      draftId: evidence.draftId ? text(evidence.draftId, 160) : null,
      officialUrl: /^https:\/\//.test(String(evidence.officialUrl ?? "")) ? text(evidence.officialUrl, 1_000) : null,
      sourceReview: evidence.sourceReview === "user-confirmed" ? "user-confirmed" : undefined,
    },
  };
}

function metadataPath(root, receiptId) {
  return path.join(root, `${receiptId}.json`);
}

async function atomicJson(file, payload) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

function publicRecord(record) {
  const normalized = {
    ...record,
    schemaVersion: 2,
    link: sanitizeLink(record.link),
  };
  return {
    ...normalized,
    image: normalized.image ? { ...normalized.image, imageUrl: `/api/price/transactions/archive/${encodeURIComponent(normalized.receiptId)}/image` } : null,
  };
}

export async function archiveTransaction(body, options) {
  const root = options.root;
  const receiptId = assertReceiptId(body?.receiptId);
  const item = sanitizeItem(body?.item, receiptId);
  const decoded = decodeTransactionImage(body?.screenshotDataUrl);
  const contentHash = createHash("sha256").update(decoded.buffer).digest("hex");
  if (item.transaction.contentHash !== contentHash) throw new Error("截图内容哈希与 OCR 证据不一致");
  const extension = MIME_EXTENSION.get(decoded.mimeType);
  if (!extension) throw new Error("不支持的截图格式");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const imageName = `${receiptId}.${extension}`;
  const imagePath = path.join(root, imageName);
  const temporaryImage = `${imagePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryImage, decoded.buffer, { mode: 0o600 });
  await rename(temporaryImage, imagePath);
  const storedAt = new Date().toISOString();
  const record = {
    schemaVersion: 2,
    receiptId,
    storedAt,
    updatedAt: storedAt,
    item,
    link: sanitizeLink(body?.link ?? body?.item?.planLink),
    image: {
      fileName: item.transaction.fileName,
      storageName: imageName,
      mimeType: decoded.mimeType,
      bytes: decoded.buffer.byteLength,
      contentHash,
    },
  };
  await atomicJson(metadataPath(root, receiptId), record);
  return publicRecord(record);
}

export async function updateTransactionArchive(receiptIdValue, body, options) {
  const receiptId = assertReceiptId(receiptIdValue);
  const file = metadataPath(options.root, receiptId);
  const existing = JSON.parse(await readFile(file, "utf8"));
  const item = sanitizeItem({ ...existing.item, ...(body?.item ?? {}), transaction: existing.item?.transaction }, receiptId);
  const updatedAt = new Date().toISOString();
  const next = { ...existing, schemaVersion: 2, item, link: sanitizeLink(body?.link ?? existing.link), updatedAt };
  await atomicJson(file, next);
  return publicRecord(next);
}

export async function listTransactionArchives(options) {
  const root = options.root;
  let names = [];
  try {
    names = (await readdir(root)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const name of names) {
    try {
      const record = JSON.parse(await readFile(path.join(root, name), "utf8"));
      records.push(publicRecord(record));
    } catch {
      // A corrupt record is skipped so one damaged file does not hide the archive.
    }
  }
  return records.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function readTransactionImage(receiptIdValue, options) {
  const receiptId = assertReceiptId(receiptIdValue);
  const record = JSON.parse(await readFile(metadataPath(options.root, receiptId), "utf8"));
  if (!record.image?.storageName) return null;
  const expectedName = `${receiptId}.${MIME_EXTENSION.get(record.image.mimeType)}`;
  if (record.image.storageName !== expectedName) throw new Error("Invalid archived image path");
  return { buffer: await readFile(path.join(options.root, expectedName)), mimeType: record.image.mimeType, fileName: record.image.fileName };
}

export async function deleteTransactionImage(receiptIdValue, options) {
  const receiptId = assertReceiptId(receiptIdValue);
  const file = metadataPath(options.root, receiptId);
  const record = JSON.parse(await readFile(file, "utf8"));
  if (record.image?.storageName) {
    const expectedName = `${receiptId}.${MIME_EXTENSION.get(record.image.mimeType)}`;
    if (record.image.storageName !== expectedName) throw new Error("Invalid archived image path");
    await unlink(path.join(options.root, expectedName)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
  record.image = null;
  record.updatedAt = new Date().toISOString();
  await atomicJson(file, record);
  return publicRecord(record);
}

export async function deleteTransactionArchive(receiptIdValue, options) {
  const receiptId = assertReceiptId(receiptIdValue);
  const file = metadataPath(options.root, receiptId);
  let record = null;
  try { record = JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (record?.image?.storageName) {
    const expectedName = `${receiptId}.${MIME_EXTENSION.get(record.image.mimeType)}`;
    if (record.image.storageName === expectedName) await unlink(path.join(options.root, expectedName)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
  await unlink(file).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  return { receiptId, deleted: Boolean(record) };
}
