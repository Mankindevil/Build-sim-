/**
 * File-backed price store. `local-quotes.json` and `manual-quotes.json` are the
 * inputs a human curates; `latest.json` plus dated snapshots are derived so the
 * browser bundle keeps reading a single committed file.
 */

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const pricesDir = path.join(root, "data/prices");
export const catalogPath = path.join(root, "data/skus/catalog.json");
export const latestPath = path.join(pricesDir, "latest.json");
export const manualPath = path.join(pricesDir, "manual-quotes.json");
export const localPath = path.join(pricesDir, "local-quotes.json");
export const snapshotsDir = path.join(pricesDir, "snapshots");
export const candidatesDir = path.join(pricesDir, "candidates");
export const fxPath = path.join(pricesDir, "fx.json");
export const rollbackDir = path.join(root, "data/audit/rollback");
export const rollbackManifestPath = path.join(rollbackDir, "manifest.json");

/**
 * Hand-maintained exchange rates. Only used to give a foreign listing a
 * comparable CNY magnitude — rows carrying this assumption cannot be audited,
 * so a stale rate can never become a recorded transaction price.
 */
export async function loadFx() {
  return readJson(fxPath, { asOf: null, rates: {}, source: "缺少 data/prices/fx.json" });
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function appendRollbackManifest(entry, manifestPath = rollbackManifestPath) {
  const current = (await readJson(manifestPath, { schemaVersion: "1.0.0", entries: [] })) ?? {
    schemaVersion: "1.0.0",
    entries: [],
  };
  const next = { ...current, entries: [...(current.entries ?? []), entry] };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const temp = `${manifestPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(temp, text, "utf8");
  await rename(temp, manifestPath);
}

/** Atomic JSON write with an immutable old-value backup and rollback manifest. */
export async function atomicWriteJson(file, data, { operation = "write", rollbackRoot = rollbackDir, manifestPath = rollbackManifestPath } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const existed = await readFile(file, "utf8").catch(() => null);
  let backupPath = null;
  if (existed !== null) {
    await mkdir(rollbackRoot, { recursive: true });
    backupPath = path.join(rollbackRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${path.basename(file)}.bak`);
    await copyFile(file, backupPath);
  }
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, file);
  await appendRollbackManifest({
    eventId: crypto.randomUUID(),
    operation,
    target: path.relative(root, file),
    backup: backupPath ? path.relative(root, backupPath) : null,
    previousHash: existed === null ? null : sha256(existed),
    nextHash: sha256(text),
    createdAt: new Date().toISOString(),
  }, manifestPath);
}

/** Restore the most recent immutable backup for a target through the same atomic path. */
export async function restoreLatestRollback(file, { manifestPath = rollbackManifestPath } = {}) {
  const manifest = await readJson(manifestPath, { entries: [] });
  const target = path.relative(root, file);
  const entry = [...(manifest?.entries ?? [])].reverse().find((candidate) => candidate.target === target && candidate.backup);
  if (!entry?.backup) throw new Error(`No rollback backup for ${target}`);
  const backup = path.resolve(root, entry.backup);
  const text = await readFile(backup, "utf8");
  const previous = await readFile(file, "utf8").catch(() => null);
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, file);
  await appendRollbackManifest({
    eventId: crypto.randomUUID(),
    operation: "rollback",
    target,
    backup: entry.backup,
    previousHash: previous === null ? null : sha256(previous),
    nextHash: sha256(text),
    createdAt: new Date().toISOString(),
  }, manifestPath);
  return { target, backup: entry.backup };
}

export function isAuditedRow(q) {
  return (
    q &&
    typeof q.skuId === "string" &&
    q.evidence === "audited" &&
    typeof q.priceCny === "number" &&
    Number.isFinite(q.priceCny) &&
    q.priceCny > 0 &&
    Boolean(q.platform)
  );
}

function normalizeRow(q) {
  return {
    skuId: q.skuId,
    platform: q.platform,
    priceCny: q.priceCny,
    currency: "CNY",
    match: q.match ?? "manual",
    evidence: "audited",
    ...(q.listingUrl ? { listingUrl: q.listingUrl } : {}),
    ...(q.note ? { note: q.note } : {}),
    ...(q.title ? { title: q.title } : {}),
    // Which option on the listing this price belongs to. Without it a recorded
    // price cannot be re-checked, because the listing sells several products.
    ...(q.variantLabel ? { variantLabel: q.variantLabel } : {}),
    ...(q.fetchedAt ? { fetchedAt: q.fetchedAt } : {}),
  };
}

export async function loadCatalog() {
  return readJson(catalogPath, { skus: [] });
}

export async function loadManualQuotes() {
  const file = await readJson(manualPath, { quotes: [] });
  return (file.quotes ?? []).filter(isAuditedRow).map(normalizeRow);
}

export async function loadLocalQuotes() {
  const file = await readJson(localPath, { quotes: [] });
  return (file.quotes ?? []).filter(isAuditedRow).map(normalizeRow);
}

export async function saveLocalQuotes(quotes) {
  await atomicWriteJson(localPath, {
    schemaVersion: "1.0.0",
    note: "Audited quotes captured from the price panel. Commit this file; latest.json is derived.",
    updatedAt: today(),
    quotes,
  });
}

/** Local quotes win over manual rows for the same SKU + platform. */
export async function mergedQuotes() {
  const merged = new Map();
  for (const q of await loadManualQuotes()) merged.set(`${q.skuId}|${q.platform}`, q);
  for (const q of await loadLocalQuotes()) merged.set(`${q.skuId}|${q.platform}`, q);
  return [...merged.values()];
}

export async function buildAndWriteLatest(asOf = today(), note) {
  const quotes = await mergedQuotes();
  const snapshot = {
    schemaVersion: "1.0.0",
    asOf,
    note: note ?? "Derived from manual-quotes.json + local-quotes.json (audited rows only).",
    quotes,
  };
  await atomicWriteJson(latestPath, snapshot, { operation: "price-snapshot-latest" });
  await atomicWriteJson(path.join(snapshotsDir, `${asOf}.json`), snapshot, { operation: "price-snapshot" });
  return snapshot;
}

export async function upsertLocalQuote(quote) {
  if (!isAuditedRow(quote)) {
    throw new Error("Quote must have skuId, platform, positive priceCny and evidence=audited");
  }
  const row = normalizeRow(quote);
  const quotes = await loadLocalQuotes();
  const key = `${row.skuId}|${row.platform}`;
  const next = quotes.filter((q) => `${q.skuId}|${q.platform}` !== key);
  next.push(row);
  await saveLocalQuotes(next);
  return row;
}

export async function removeLocalQuote(skuId, platform) {
  const quotes = await loadLocalQuotes();
  const next = quotes.filter((q) => (platform ? !(q.skuId === skuId && q.platform === platform) : q.skuId !== skuId));
  await saveLocalQuotes(next);
  return quotes.length - next.length;
}

export async function saveCandidates(payload, asOf = today()) {
  await atomicWriteJson(path.join(candidatesDir, `${asOf}.json`), payload, { operation: "price-candidates" });
}

export async function loadCandidates(asOf = today()) {
  return readJson(path.join(candidatesDir, `${asOf}.json`), null);
}
