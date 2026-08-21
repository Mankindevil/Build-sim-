/**
 * File-backed price store. `local-quotes.json` and `manual-quotes.json` are the
 * inputs a human curates; `latest.json` plus dated snapshots are derived so the
 * browser bundle keeps reading a single committed file.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
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

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
  await writeJson(localPath, {
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
  await writeJson(latestPath, snapshot);
  await writeJson(path.join(snapshotsDir, `${asOf}.json`), snapshot);
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
  await writeJson(path.join(candidatesDir, `${asOf}.json`), payload);
}

export async function loadCandidates(asOf = today()) {
  return readJson(path.join(candidatesDir, `${asOf}.json`), null);
}
