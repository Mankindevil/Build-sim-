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
export const priceSnapshotRollbackManifestPath = path.join(rollbackDir, "price-snapshot-manifest.json");
export const priceAuditRoot = path.join(root, "data/audit/price-events");

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

function jsonHash(value) {
  return sha256(JSON.stringify(value));
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
    (!q.currency || q.currency === "CNY") &&
    typeof q.priceCny === "number" &&
    Number.isFinite(q.priceCny) &&
    q.priceCny > 0 &&
    Boolean(q.platform) &&
    /^https?:\/\//i.test(String(q.listingUrl ?? "")) &&
    Boolean(String(q.variantLabel ?? "").trim()) &&
    (q.priceKind === undefined || q.priceKind === "variant")
  );
}

function normalizeRow(q) {
  // Legacy curated rows may predate fetchedAt; use a deterministic marker rather
  // than `now()` so rebuilding the same snapshot remains idempotent.
  const fetchedAt = q.fetchedAt ?? (q.asOf ? `${q.asOf}T00:00:00.000Z` : "unknown");
  const variantLabel = String(q.variantLabel ?? "").trim();
  const provenanceInput = {
    skuId: q.skuId,
    platform: q.platform,
    priceCny: q.priceCny,
    listingUrl: q.listingUrl ?? null,
    variantLabel,
    fetchedAt,
    match: q.match ?? "manual",
    sourceHash: q.sourceHash ?? null,
  };
  const inputHash = q.provenance?.inputHash ?? q.provenanceHash ?? jsonHash(provenanceInput);
  const provenanceId = q.provenanceId ?? `price-prov-${inputHash.slice(0, 16)}`;
  return {
    skuId: q.skuId,
    platform: q.platform,
    priceCny: q.priceCny,
    currency: "CNY",
    match: q.match ?? "manual",
    evidence: "audited",
    priceKind: "variant",
    priceAmount: q.priceAmount ?? q.priceCny,
    priceCurrency: q.priceCurrency ?? "CNY",
    ...(q.listingUrl ? { listingUrl: q.listingUrl } : {}),
    ...(q.note ? { note: q.note } : {}),
    ...(q.title ? { title: q.title } : {}),
    // Which option on the listing this price belongs to. Without it a recorded
    // price cannot be re-checked, because the listing sells several products.
    ...(variantLabel ? { variantLabel } : {}),
    fetchedAt,
    provenanceId,
    ...(q.sourceHash ? { sourceHash: q.sourceHash } : {}),
    provenance: q.provenance ?? {
      provenanceId,
      sourceUrl: q.listingUrl,
      sourceKind: q.sourceKind ?? "marketplace-listing",
      fetchedAt,
      ...(q.sourceHash ? { contentHash: q.sourceHash } : {}),
      inputHash,
      variantLabel,
      note: q.note,
    },
  };
}

export async function loadCatalog() {
  return readJson(catalogPath, { skus: [] });
}

export async function loadManualQuotes(options = {}) {
  const file = await readJson(options.manualPath ?? manualPath, { quotes: [] });
  return (file.quotes ?? []).filter(isAuditedRow).map(normalizeRow);
}

export async function loadLocalQuotes(options = {}) {
  const file = await readJson(options.localPath ?? localPath, { quotes: [] });
  return (file.quotes ?? []).filter(isAuditedRow).map(normalizeRow);
}

export async function saveLocalQuotes(quotes, options = {}) {
  const target = options.localPath ?? localPath;
  await atomicWriteJson(target, {
    schemaVersion: "1.0.0",
    note: "Audited quotes captured from the price panel. Commit this file; latest.json is derived.",
    updatedAt: today(),
    quotes,
  }, { operation: "price-local-quotes", rollbackRoot: options.rollbackRoot ?? rollbackDir, manifestPath: options.manifestPath ?? path.join(options.rollbackRoot ?? rollbackDir, "price-local-manifest.json") });
}

/** Local quotes win over manual rows for the same SKU + platform. */
export async function mergedQuotes(options = {}) {
  const merged = new Map();
  for (const q of await loadManualQuotes(options)) merged.set(`${q.skuId}|${q.platform}|${q.variantLabel ?? ""}`, q);
  for (const q of await loadLocalQuotes(options)) merged.set(`${q.skuId}|${q.platform}|${q.variantLabel ?? ""}`, q);
  return [...merged.values()];
}

export async function buildAndWriteLatest(asOf = today(), note, options = {}) {
  const quotes = (options.quotes ?? await mergedQuotes(options)).filter(isAuditedRow).map(normalizeRow);
  const catalog = options.catalog ?? await readJson(options.catalogPath ?? catalogPath, { schemaVersion: "2.0.0", updatedAt: asOf, skus: [] });
  const catalogVersion = catalog.catalogVersion ?? catalog.schemaVersion ?? null;
  const snapshotNote = note ?? "Derived from manual-quotes.json + local-quotes.json (audited rows only).";
  const inputHash = jsonHash({ asOf, quotes, catalogVersion, note: snapshotNote });
  const snapshotId = `price-snapshot-${inputHash.slice(0, 20)}`;
  const targetLatestPath = options.latestPath ?? latestPath;
  const targetSnapshotsDir = options.snapshotsDir ?? snapshotsDir;
  const previous = await readJson(targetLatestPath, null);
  const generatedAt = previous?.inputHash === inputHash && previous?.generatedAt ? previous.generatedAt : new Date().toISOString();
  const snapshot = {
    schemaVersion: "1.1.0",
    asOf,
    note: snapshotNote,
    snapshotId,
    generatedAt,
    catalogVersion,
    inputHash,
    priceVersion: "price-snapshot-v2",
    quotes,
  };
  const contentHash = jsonHash(snapshot);
  const nextSnapshot = { ...snapshot, contentHash };
  const snapshotManifestPath = options.manifestPath ?? priceSnapshotRollbackManifestPath;
  const datedPath = path.join(targetSnapshotsDir, `${asOf}.json`);
  const previousDated = await readJson(datedPath, null);
  if (previous?.contentHash === contentHash && previousDated?.contentHash === contentHash) return nextSnapshot;
  try {
    await atomicWriteJson(targetLatestPath, nextSnapshot, { operation: "price-snapshot-latest", rollbackRoot: options.rollbackRoot ?? rollbackDir, manifestPath: snapshotManifestPath });
    await atomicWriteJson(datedPath, nextSnapshot, { operation: "price-snapshot", rollbackRoot: options.rollbackRoot ?? rollbackDir, manifestPath: snapshotManifestPath });
    const auditRoot = options.auditRoot ?? priceAuditRoot;
    const auditFile = path.join(auditRoot, `${asOf}.json`);
    const existingAudit = await readJson(auditFile, { schemaVersion: "1.0.0", events: [] });
    const eventId = `price-audit-${inputHash.slice(0, 20)}`;
    await atomicWriteJson(auditFile, {
      schemaVersion: "1.0.0",
      events: [...(existingAudit?.events ?? []).filter((event) => event.eventId !== eventId), {
        eventId,
        operation: "price-snapshot",
        snapshotId,
        inputHash,
        contentHash,
        catalogVersion,
        quoteCount: quotes.length,
        createdAt: nextSnapshot.generatedAt,
      }],
    }, { operation: "price-snapshot-audit", rollbackRoot: options.rollbackRoot ?? rollbackDir, manifestPath: options.auditManifestPath ?? path.join(options.rollbackRoot ?? rollbackDir, "price-audit-manifest.json") });
    return nextSnapshot;
  } catch (error) {
    // If the second write fails, restore any prior snapshot files through their
    // dedicated manifest so a partial price refresh cannot look successful.
    await restoreLatestRollback(targetLatestPath, { manifestPath: snapshotManifestPath }).catch(() => {});
    await restoreLatestRollback(datedPath, { manifestPath: snapshotManifestPath }).catch(() => {});
    throw error;
  }
}

export async function upsertLocalQuote(quote, options = {}) {
  if (!isAuditedRow(quote)) {
    throw new Error("Quote must have skuId, platform, positive priceCny and evidence=audited");
  }
  const row = normalizeRow(quote);
  const quotes = await loadLocalQuotes(options);
  const key = `${row.skuId}|${row.platform}|${row.variantLabel ?? ""}`;
  const next = [];
  let replaced = false;
  for (const quote of quotes) {
    if (`${quote.skuId}|${quote.platform}|${quote.variantLabel ?? ""}` === key) {
      next.push(row);
      replaced = true;
    } else next.push(quote);
  }
  if (!replaced) next.push(row);
  await saveLocalQuotes(next, options);
  return row;
}

export async function removeLocalQuote(skuId, platform, variantLabel, options = {}) {
  const quotes = await loadLocalQuotes(options);
  const next = quotes.filter((q) => {
    if (q.skuId !== skuId) return true;
    if (!platform) return false;
    if (q.platform !== platform) return true;
    return variantLabel !== undefined && q.variantLabel !== variantLabel;
  });
  await saveLocalQuotes(next, options);
  return quotes.length - next.length;
}

export async function saveCandidates(payload, asOf = today()) {
  await atomicWriteJson(path.join(candidatesDir, `${asOf}.json`), payload, { operation: "price-candidates" });
}

export async function loadCandidates(asOf = today()) {
  return readJson(path.join(candidatesDir, `${asOf}.json`), null);
}
