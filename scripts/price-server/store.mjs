/**
 * Durable price repository.
 *
 * All production reads resolve RuntimeCoordinator's active generation at the
 * moment of the operation.  Never retain a generated absolute price path: a
 * backup restore switches the active pointer and the next request must observe
 * that new generation.
 */

import crypto from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import {
  atomicWriteFile as durableAtomicWriteFile,
  confined,
  ensurePrivateDirectory,
  pathExists,
  sha256Bytes,
  withDirectoryLock,
} from "../../src/runtime/fs.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const seedPricesDir = path.join(root, "data/prices");
export const runtimeRoot = path.resolve(process.env.PRICE_RUNTIME_ROOT ?? process.env.RUNTIME_ROOT ?? path.join(root, "runtime"));
export const catalogPath = path.join(root, "data/skus/catalog.json");

// Compatibility names only. They are deliberately not used as production
// authority; callers must resolve through resolvePriceRepositoryPaths().
export const pricesDir = path.join(runtimeRoot, "prices");
export const latestPath = path.join(pricesDir, "latest.json");
export const manualPath = path.join(pricesDir, "manual-quotes.json");
export const localPath = path.join(pricesDir, "local-quotes.json");
export const snapshotsDir = path.join(pricesDir, "snapshots");
export const candidatesDir = path.join(pricesDir, "candidates");
export const fxPath = path.join(pricesDir, "fx.json");
export const rollbackDir = path.join(pricesDir, "rollback");
export const rollbackManifestPath = path.join(rollbackDir, "manifest.json");
export const priceSnapshotRollbackManifestPath = path.join(rollbackDir, "price-snapshot-manifest.json");
export const priceAuditRoot = path.join(pricesDir, "audit");
export const listingCapturesDir = path.join(pricesDir, "listing-captures");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function jsonHash(value) {
  // Snapshot hashes are historical JSON.stringify hashes; preserve that wire
  // contract rather than silently changing the public snapshot identity.
  return sha256(JSON.stringify(value));
}

function validPriceSnapshot(value, { allowLegacy = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.schemaVersion !== "string" || !Array.isArray(value.quotes)) return false;
  if (value.contentHash === undefined) return allowLegacy;
  if (typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash)) return false;
  const { contentHash, ...material } = value;
  return jsonHash(material) === contentHash;
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function dateKeyValue(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)); }
function invariant(condition, message) { if (!condition) throw new Error(message); }

function assertAuditedQuote(value, label) {
  invariant(isAuditedRow(value), `${label} contains a non-audited or malformed quote`);
}

function assertSnapshot(value, label, expectedAsOf) {
  invariant(validPriceSnapshot(value) && dateKeyValue(value.asOf)
    && (expectedAsOf === undefined || value.asOf === expectedAsOf)
    && value.quotes.every((quote) => { try { assertAuditedQuote(quote, label); return true; } catch { return false; } }), `${label} is invalid`);
  if (value.priceVersion !== undefined || value.snapshotId !== undefined || value.inputHash !== undefined) {
    invariant(value.priceVersion === "price-snapshot-v2" && /^price-snapshot-[a-f0-9]{20}$/.test(String(value.snapshotId ?? ""))
      && /^[a-f0-9]{64}$/.test(String(value.inputHash ?? "")) && value.snapshotId === `price-snapshot-${value.inputHash.slice(0, 20)}`
      && iso(value.generatedAt), `${label} identity binding is invalid`);
  }
  return value;
}

function assertQuoteFile(value, label, { allowUnknown }) {
  invariant(object(value) && value.schemaVersion === "1.0.0" && Array.isArray(value.quotes), `${label} is invalid`);
  for (const quote of value.quotes) {
    invariant(object(quote) && typeof quote.skuId === "string" && quote.skuId
      && ["audited", "unknown"].includes(quote.evidence), `${label} contains a malformed quote`);
    if (quote.evidence === "audited") assertAuditedQuote(quote, label);
    else invariant(allowUnknown, `${label} contains an unaudited quote`);
  }
  return value;
}

function assertListingCapture(value, logicalId) {
  invariant(object(value) && value.schemaVersion === "1.0.0"
    && /^price-candidate-[a-f0-9]{20}$/.test(String(value.candidateId ?? ""))
    && typeof value.skuId === "string" && value.skuId && typeof value.platform === "string" && value.platform
    && typeof value.title === "string" && value.title && iso(value.fetchedAt)
    && /^https:\/\//.test(String(value.canonicalUrl ?? "")) && Array.isArray(value.redirectChain)
    && value.redirectChain.length > 0 && value.redirectChain[0] === value.canonicalUrl
    && Array.isArray(value.variants) && /^[a-f0-9]{64}$/.test(String(value.contentHash ?? "")), "runtime price listing capture is invalid");
  const { contentHash, ...material } = value;
  invariant(contentHash === jsonHash(material) && logicalId === `listing-capture-${contentHash.slice(0, 20)}`, "runtime price listing capture identity/hash is invalid");
  return value;
}

function assertCandidateFile(value, expectedAsOf) {
  invariant(object(value) && typeof value.schemaVersion === "string" && value.schemaVersion
    && (!Object.prototype.hasOwnProperty.call(value, "asOf") || value.asOf === expectedAsOf)
    && Array.isArray(value.candidates), "runtime price candidates file is invalid");
  const ids = new Set();
  for (const candidate of value.candidates) {
    invariant(object(candidate) && typeof candidate.skuId === "string" && candidate.skuId
      && typeof candidate.platform === "string" && candidate.platform && typeof candidate.title === "string" && candidate.title
      && iso(candidate.fetchedAt) && /^https:\/\//.test(String(candidate.canonicalUrl ?? ""))
      && /^price-candidate-[a-f0-9]{20}$/.test(String(candidate.candidateId ?? ""))
      && /^listing-capture-[a-f0-9]{20}$/.test(String(candidate.listingCaptureId ?? ""))
      && /^[a-f0-9]{64}$/.test(String(candidate.captureContentHash ?? "")) && !ids.has(candidate.candidateId), "runtime price candidates file contains an invalid candidate");
    const identity = { skuId: candidate.skuId, platform: candidate.platform, canonicalUrl: candidate.canonicalUrl, fetchedAt: candidate.fetchedAt, title: candidate.title };
    invariant(candidate.candidateId === `price-candidate-${jsonHash(identity).slice(0, 20)}`
      && candidate.listingCaptureId === `listing-capture-${candidate.captureContentHash.slice(0, 20)}`, "runtime price candidate identity/hash is invalid");
    ids.add(candidate.candidateId);
  }
  return value;
}

function assertPriceAudit(value, expectedAsOf) {
  invariant(object(value) && value.schemaVersion === "1.0.0" && Array.isArray(value.events), "runtime price audit file is invalid");
  for (const event of value.events) {
    invariant(object(event) && event.operation === "price-snapshot"
      && /^price-audit-[a-f0-9]{20}$/.test(String(event.eventId ?? ""))
      && /^price-snapshot-[a-f0-9]{20}$/.test(String(event.snapshotId ?? ""))
      && /^[a-f0-9]{64}$/.test(String(event.inputHash ?? "")) && /^[a-f0-9]{64}$/.test(String(event.contentHash ?? ""))
      && event.eventId === `price-audit-${event.inputHash.slice(0, 20)}`
      && event.snapshotId === `price-snapshot-${event.inputHash.slice(0, 20)}`
      && Number.isInteger(event.quoteCount) && event.quoteCount >= 0 && iso(event.createdAt), "runtime price audit event is invalid");
  }
  return value;
}

function assertPriceRollbackManifest(value) {
  invariant(object(value) && value.schemaVersion === "price-rollback-manifest-v2"
    && (value.priceRoot === undefined || value.priceRoot === "..") && Array.isArray(value.entries), "runtime price rollback manifest is invalid");
  for (const entry of value.entries) {
    const safePath = (candidate) => typeof candidate === "string" && candidate
      && !path.isAbsolute(candidate) && candidate.split(/[\\/]/).every((segment) => segment && segment !== "." && segment !== "..");
    invariant(object(entry) && typeof entry.eventId === "string" && entry.eventId
      && typeof entry.operation === "string" && entry.operation && safePath(entry.target)
      && (entry.backup === null || safePath(entry.backup))
      && (entry.previousHash === null || /^[a-f0-9]{64}$/.test(String(entry.previousHash ?? "")))
      && (entry.backup === null) === (entry.previousHash === null)
      && /^[a-f0-9]{64}$/.test(String(entry.nextHash ?? "")) && iso(entry.createdAt), "runtime price rollback entry is invalid");
  }
  return value;
}

/**
 * Semantic inventory for the generation-aware price repository. The production
 * reference graph, backup verifier/restore staging, and Doctor all invoke this
 * function, so unknown governed paths fail closed instead of being accepted as
 * opaque hash-only files.
 */
export function assertPriceRuntimeAuthority(logicalPath, value) {
  if (logicalPath === "latest.json") {
    assertSnapshot(value, "runtime latest price snapshot");
    return { kind: "snapshot", snapshotId: value.snapshotId ?? `legacy-${value.contentHash}`, contentHash: value.contentHash, current: true };
  }
  const snapshot = /^snapshots\/(\d{4}-\d{2}-\d{2})\.json$/.exec(logicalPath);
  if (snapshot) {
    assertSnapshot(value, "runtime dated price snapshot", snapshot[1]);
    return { kind: "snapshot", snapshotId: value.snapshotId ?? `legacy-${value.contentHash}`, contentHash: value.contentHash, current: false };
  }
  if (logicalPath === "manual-quotes.json") {
    assertQuoteFile(value, "runtime manual price quotes", { allowUnknown: true });
    return { kind: "quote-source" };
  }
  if (logicalPath === "local-quotes.json") {
    assertQuoteFile(value, "runtime local price quotes", { allowUnknown: false });
    return { kind: "quote-source" };
  }
  if (logicalPath === "fx.json") {
    invariant(object(value) && value.schemaVersion === "1.0.0" && (value.asOf === null || dateKeyValue(value.asOf))
      && object(value.rates) && Object.values(value.rates).every((rate) => Number.isFinite(rate) && rate > 0), "runtime price FX document is invalid");
    return { kind: "fx" };
  }
  const candidates = /^candidates\/(\d{4}-\d{2}-\d{2})\.json$/.exec(logicalPath);
  if (candidates) {
    assertCandidateFile(value, candidates[1]);
    return {
      kind: "candidates",
      candidates: value.candidates.map((candidate) => ({ candidateId: candidate.candidateId, listingCaptureId: candidate.listingCaptureId })),
    };
  }
  const capture = /^listing-captures\/(listing-capture-[a-f0-9]{20})\.json$/.exec(logicalPath);
  if (capture) {
    assertListingCapture(value, capture[1]);
    return { kind: "listing-capture", listingCaptureId: capture[1] };
  }
  const audit = /^audit\/(\d{4}-\d{2}-\d{2})\.json$/.exec(logicalPath);
  if (audit) {
    assertPriceAudit(value, audit[1]);
    return { kind: "audit", events: value.events.map((event) => ({ eventId: event.eventId, snapshotId: event.snapshotId })) };
  }
  if (/^search\/\d{4}-\d{2}-\d{2}\.json$/.test(logicalPath)) {
    invariant(object(value), "runtime price search artifact is invalid");
    return { kind: "untrusted-search-artifact" };
  }
  if (/^search\/\d{4}-\d{2}-\d{2}\.md$/.test(logicalPath)) return { kind: "untrusted-search-artifact" };
  if (/^rollback\/(?:manifest|[A-Za-z0-9._-]+-manifest)\.json$/.test(logicalPath)) {
    assertPriceRollbackManifest(value);
    return { kind: "rollback-manifest" };
  }
  if (/^rollback\/.+\.bak$/.test(logicalPath)) return { kind: "rollback-bytes" };
  if (/^history\/.+\.json$/.test(logicalPath)) throw new Error("legacy prices/history records have no current authority schema");
  if (/^targets\/.+\.json$/.test(logicalPath)) throw new Error("legacy prices/targets records have no current authority schema");
  throw new Error("prices repository contains an unrecognized runtime authority path");
}

function explicitDirectPaths(options) {
  return ["direct", "pricesDir", "latestPath", "manualPath", "localPath", "snapshotsDir", "auditRoot", "rollbackRoot", "manifestPath", "candidatesDir", "listingCapturesDir", "fxPath"]
    .some((key) => options[key] !== undefined);
}

function useCoordinator(options) {
  if (options.generationAware === true || options.coordinator) return true;
  if (options.generationAware === false || options.direct === true) return false;
  return !explicitDirectPaths(options);
}

function configuredRuntimeRoot(options = {}) {
  return path.resolve(options.runtimeRoot ?? process.env.PRICE_RUNTIME_ROOT ?? process.env.RUNTIME_ROOT ?? path.join(root, "runtime"));
}

function pathsForPriceRoot(priceRoot, options = {}, activeRoot = null) {
  const resolvedPriceRoot = path.resolve(priceRoot);
  const inside = (target) => activeRoot ? confined(activeRoot, "prices", path.relative(resolvedPriceRoot, target)) : path.resolve(target);
  const resolve = (name) => inside(path.join(resolvedPriceRoot, name));
  return Object.freeze({
    runtimeRoot: configuredRuntimeRoot(options),
    activeRoot,
    pricesDir: resolvedPriceRoot,
    seedPricesDir: path.resolve(options.seedPricesDir ?? seedPricesDir),
    latestPath: resolve("latest.json"),
    manualPath: resolve("manual-quotes.json"),
    localPath: resolve("local-quotes.json"),
    snapshotsDir: resolve("snapshots"),
    historyDir: resolve("history"),
    targetsDir: resolve("targets"),
    candidatesDir: resolve("candidates"),
    listingCapturesDir: resolve("listing-captures"),
    searchDir: resolve("search"),
    fxPath: resolve("fx.json"),
    rollbackDir: resolve("rollback"),
    rollbackManifestPath: resolve("rollback/manifest.json"),
    priceSnapshotRollbackManifestPath: resolve("rollback/price-snapshot-manifest.json"),
    priceAuditRoot: resolve("audit"),
    lockDirectory: resolve(".price-write-lock"),
    generationAware: Boolean(activeRoot),
  });
}

/** Return a root configuration, not a generation-specific path cache. */
export function resolvePriceRepositoryPaths(options = {}) {
  return Object.freeze({
    runtimeRoot: configuredRuntimeRoot(options),
    seedPricesDir: path.resolve(options.seedPricesDir ?? seedPricesDir),
    coordinator: options.coordinator,
    generationAware: true,
  });
}

function directPaths(options = {}) {
  const inferred = options.pricesDir
    ?? (options.localPath ? path.dirname(options.localPath) : null)
    ?? (options.latestPath ? path.dirname(options.latestPath) : null)
    ?? path.join(configuredRuntimeRoot(options), "prices");
  const paths = pathsForPriceRoot(inferred, options);
  return Object.freeze({
    ...paths,
    ...(options.latestPath ? { latestPath: path.resolve(options.latestPath) } : {}),
    ...(options.manualPath ? { manualPath: path.resolve(options.manualPath) } : {}),
    ...(options.localPath ? { localPath: path.resolve(options.localPath) } : {}),
    ...(options.snapshotsDir ? { snapshotsDir: path.resolve(options.snapshotsDir) } : {}),
    ...(options.auditRoot ? { priceAuditRoot: path.resolve(options.auditRoot) } : {}),
    ...(options.candidatesDir ? { candidatesDir: path.resolve(options.candidatesDir) } : {}),
    ...(options.listingCapturesDir ? { listingCapturesDir: path.resolve(options.listingCapturesDir) } : {}),
    ...(options.fxPath ? { fxPath: path.resolve(options.fxPath) } : {}),
    ...(options.rollbackRoot ? { rollbackDir: path.resolve(options.rollbackRoot) } : {}),
    ...(options.manifestPath ? { rollbackManifestPath: path.resolve(options.manifestPath) } : {}),
    generationAware: false,
  });
}

function coordinatorFor(options) {
  return options.coordinator ?? new RuntimeCoordinator({ root: configuredRuntimeRoot(options), now: options.now });
}

async function ensurePriceLayout(paths) {
  await Promise.all([
    paths.pricesDir, paths.snapshotsDir, paths.historyDir, paths.targetsDir,
    paths.candidatesDir, paths.listingCapturesDir, paths.searchDir,
    paths.rollbackDir, paths.priceAuditRoot,
  ].map(ensurePrivateDirectory));
}

async function withPriceRead(options, operation) {
  if (useCoordinator(options)) {
    const coordinator = coordinatorFor(options);
    await coordinator.initialize(options.appVersion);
    return (await coordinator.withConsistentSnapshot(async ({ state, activeRoot }) => {
      const paths = pathsForPriceRoot(confined(activeRoot, "prices"), options, activeRoot);
      return operation({ paths, state, coordinator });
    })).result;
  }
  const paths = directPaths(options);
  return operation({ paths, state: null, coordinator: null });
}

async function withPriceWrite(options, operation) {
  if (useCoordinator(options)) {
    const coordinator = coordinatorFor(options);
    await coordinator.initialize(options.appVersion);
    return (await coordinator.withWrite(async ({ state, activeRoot }) => {
      const paths = pathsForPriceRoot(confined(activeRoot, "prices"), options, activeRoot);
      await ensurePriceLayout(paths);
      return operation({ paths, state, coordinator });
    }, {
      ...(options.expectedRuntimeRevision !== undefined ? { expectedRevision: options.expectedRuntimeRevision } : {}),
      ...(options.maintenanceLeaseToken ? { maintenanceLeaseToken: options.maintenanceLeaseToken } : {}),
    })).result;
  }
  const paths = directPaths(options);
  await ensurePriceLayout(paths);
  return withDirectoryLock(paths.lockDirectory, () => operation({ paths, state: null, coordinator: null }), { timeoutMs: options.lockTimeoutMs ?? 5_000 });
}

function assertPricePath(paths, target) {
  const resolved = path.resolve(target);
  const relative = path.relative(paths.pricesDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("price repository write escapes active prices root");
  return resolved;
}

async function rawFile(target) {
  try { return await readFile(target); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function expectedHashCheck(previous, expectedHash) {
  if (expectedHash === undefined) return;
  const actual = previous === null ? null : sha256Bytes(previous);
  if (expectedHash !== actual) throw new Error("price expected hash conflict");
}

async function appendPriceRollbackManifest(paths, manifestPath, entry) {
  const target = assertPricePath(paths, manifestPath);
  const current = await readJson(target, { schemaVersion: "price-rollback-manifest-v2", entries: [] });
  if (!current || !Array.isArray(current.entries)) throw new Error("price rollback manifest is corrupt");
  const next = {
    schemaVersion: "price-rollback-manifest-v2",
    priceRoot: current.priceRoot ?? path.relative(path.dirname(target), paths.pricesDir),
    entries: [...current.entries, entry],
  };
  assertPriceRollbackManifest(next);
  await durableAtomicWriteFile(target, `${JSON.stringify(next, null, 2)}\n`);
}

/** Write bytes within an already-held price generation lock. */
async function writePriceFile(paths, file, bytes, options = {}) {
  const target = assertPricePath(paths, file);
  const manifestPath = assertPricePath(paths, options.manifestPath ?? paths.rollbackManifestPath);
  const rollbackRoot = assertPricePath(paths, options.rollbackRoot ?? paths.rollbackDir);
  const previous = await rawFile(target);
  expectedHashCheck(previous, options.expectedHash);
  const content = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(String(bytes), "utf8");
  let backup = null;
  if (previous !== null) {
    await ensurePrivateDirectory(rollbackRoot);
    backup = path.join(rollbackRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}-${path.basename(target)}.bak`);
    await durableAtomicWriteFile(backup, previous);
  }
  await durableAtomicWriteFile(target, content);
  await appendPriceRollbackManifest(paths, manifestPath, {
    eventId: crypto.randomUUID(),
    operation: options.operation ?? "price-write",
    target: path.relative(paths.pricesDir, target).split(path.sep).join("/"),
    backup: backup ? path.relative(paths.pricesDir, backup).split(path.sep).join("/") : null,
    previousHash: previous === null ? null : sha256Bytes(previous),
    nextHash: sha256Bytes(content),
    createdAt: new Date().toISOString(),
  });
  return { previousHash: previous === null ? null : sha256Bytes(previous), nextHash: sha256Bytes(content) };
}

/** Write JSON within an already-held price generation lock. */
async function writePriceJson(paths, file, data, options = {}) {
  return writePriceFile(paths, file, `${JSON.stringify(data, null, 2)}\n`, options);
}

/**
 * Generic durable JSON SPI retained for catalog/migration callers. Price
 * repository RMW operations use withPriceWrite + writePriceJson instead.
 */
export async function atomicWriteJson(file, data, options = {}) {
  const target = path.resolve(file);
  const rollbackRoot = path.resolve(options.rollbackRoot ?? path.join(path.dirname(target), "rollback"));
  const manifestPath = path.resolve(options.manifestPath ?? path.join(rollbackRoot, "manifest.json"));
  const lock = path.join(path.dirname(manifestPath), ".write-lock");
  return withDirectoryLock(lock, async () => {
    const previous = await rawFile(target);
    expectedHashCheck(previous, options.expectedHash);
    const text = `${JSON.stringify(data, null, 2)}\n`;
    let backup = null;
    if (previous !== null) {
      await ensurePrivateDirectory(rollbackRoot);
      backup = path.join(rollbackRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}-${path.basename(target)}.bak`);
      await durableAtomicWriteFile(backup, previous);
    }
    await durableAtomicWriteFile(target, text);
    const rootForManifest = path.dirname(manifestPath);
    const current = await readJson(manifestPath, { schemaVersion: "rollback-manifest-v2", entries: [] });
    await durableAtomicWriteFile(manifestPath, `${JSON.stringify({ schemaVersion: "rollback-manifest-v2", entries: [...(current?.entries ?? []), {
      eventId: crypto.randomUUID(), operation: options.operation ?? "write",
      target: path.relative(rootForManifest, target), backup: backup ? path.relative(rootForManifest, backup) : null,
      previousHash: previous === null ? null : sha256Bytes(previous), nextHash: sha256Bytes(Buffer.from(text, "utf8")), createdAt: new Date().toISOString(),
    }] }, null, 2)}\n`);
  }, { timeoutMs: options.lockTimeoutMs ?? 5_000 });
}

export async function restoreLatestRollback(file, options = {}) {
  const target = path.resolve(file);
  const manifestPath = path.resolve(options.manifestPath ?? path.join(path.dirname(target), "rollback", "manifest.json"));
  const lock = path.join(path.dirname(manifestPath), ".write-lock");
  return withDirectoryLock(lock, async () => {
    const manifest = await readJson(manifestPath, { entries: [] });
    const rootForManifest = path.dirname(manifestPath);
    const priceRoot = manifest?.schemaVersion === "price-rollback-manifest-v2" && typeof manifest.priceRoot === "string"
      ? path.resolve(rootForManifest, manifest.priceRoot) : rootForManifest;
    const logicalTarget = path.relative(priceRoot, target);
    const entry = [...(manifest?.entries ?? [])].reverse().find((candidate) => candidate.target === logicalTarget && candidate.backup);
    if (!entry?.backup) throw new Error(`No rollback backup for ${logicalTarget}`);
    const current = await rawFile(target);
    const currentHash = current === null ? null : sha256Bytes(current);
    if (options.expectedHash !== undefined && options.expectedHash !== currentHash) throw new Error("rollback current hash conflict");
    if (options.expectedHash === undefined && entry.nextHash !== currentHash) throw new Error("rollback refused because target changed after the recorded write");
    const backup = path.resolve(priceRoot, entry.backup);
    const bytes = await readFile(backup);
    await durableAtomicWriteFile(target, bytes);
    return { target: logicalTarget, backup: entry.backup };
  }, { timeoutMs: options.lockTimeoutMs ?? 5_000 });
}

export async function readJson(file, fallback = null) {
  let bytes;
  try { bytes = await readFile(file, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
  try { return JSON.parse(bytes); }
  catch { throw new Error(`price repository JSON is corrupt: ${path.basename(file)}`); }
}

export function today() { return new Date().toISOString().slice(0, 10); }

async function seedPriceRepository(paths) {
  for (const name of ["manual-quotes.json", "local-quotes.json", "fx.json", "latest.json"]) {
    const target = path.join(paths.pricesDir, name);
    if (await pathExists(target)) {
      const current = await readJson(target, null);
      if (name === "latest.json") {
        if (!validPriceSnapshot(current, { allowLegacy: true })) throw new Error("legacy runtime price snapshot is invalid");
        if (current.contentHash === undefined) {
          const migrated = { ...current, contentHash: jsonHash(current) };
          assertPriceRuntimeAuthority(name, migrated);
          await writePriceJson(paths, target, migrated, { operation: "price-runtime-content-hash-migration" });
        } else assertPriceRuntimeAuthority(name, current);
      } else assertPriceRuntimeAuthority(name, current);
      continue;
    }
    const text = await readFile(path.join(paths.seedPricesDir, name), "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (text !== null) {
      const parsed = JSON.parse(text);
      const seeded = name === "latest.json" && parsed.contentHash === undefined ? { ...parsed, contentHash: jsonHash(parsed) } : parsed;
      assertPriceRuntimeAuthority(name, seeded);
      await writePriceJson(paths, target, seeded, { operation: "price-runtime-seed" });
    }
    else if (name === "local-quotes.json") await writePriceJson(paths, target, { schemaVersion: "1.0.0", quotes: [] }, { operation: "price-runtime-initialize" });
  }
}

/** Initialise packaged seed data once in the currently active generation. */
export async function initializePriceRepository(options = {}) {
  return withPriceWrite(options, async ({ paths, state }) => {
    await seedPriceRepository(paths);
    return { ...paths, runtimeGeneration: state?.runtimeGeneration ?? null, runtimeRevision: state?.revision ?? null };
  });
}

export async function loadFx(options = {}) {
  return withPriceRead(options, async ({ paths }) => {
    const runtimeValue = await readJson(paths.fxPath, null);
    if (runtimeValue) {
      assertPriceRuntimeAuthority("fx.json", runtimeValue);
      return runtimeValue;
    }
    if (options.allowSeedFallback === true || process.env.PRICE_OFFLINE_SEED_FALLBACK === "true") return readJson(path.join(paths.seedPricesDir, "fx.json"), { asOf: null, rates: {}, source: "missing price fx seed" });
    return { asOf: null, rates: {}, source: "missing active runtime price fx" };
  });
}

export function isAuditedRow(q) {
  return q && typeof q.skuId === "string" && q.evidence === "audited" && (!q.currency || q.currency === "CNY")
    && typeof q.priceCny === "number" && Number.isFinite(q.priceCny) && q.priceCny > 0 && Boolean(q.platform)
    && /^https:\/\//i.test(String(q.listingUrl ?? "")) && Boolean(String(q.variantLabel ?? "").trim())
    && (q.priceKind === undefined || q.priceKind === "variant");
}

function normalizeRow(q) {
  const fetchedAt = q.fetchedAt ?? (q.asOf ? `${q.asOf}T00:00:00.000Z` : "unknown");
  const variantLabel = String(q.variantLabel ?? "").trim();
  const provenanceInput = { skuId: q.skuId, platform: q.platform, priceCny: q.priceCny, listingUrl: q.listingUrl ?? null, variantLabel, fetchedAt, match: q.match ?? "manual", sourceHash: q.sourceHash ?? null };
  const inputHash = q.provenance?.inputHash ?? q.provenanceHash ?? jsonHash(provenanceInput);
  const provenanceId = q.provenanceId ?? `price-prov-${inputHash.slice(0, 16)}`;
  return {
    skuId: q.skuId, platform: q.platform, priceCny: q.priceCny, currency: "CNY", match: q.match ?? "manual", evidence: "audited", priceKind: "variant",
    priceAmount: q.priceAmount ?? q.priceCny, priceCurrency: q.priceCurrency ?? "CNY",
    ...(q.listingUrl ? { listingUrl: q.listingUrl } : {}), ...(q.note ? { note: q.note } : {}), ...(q.title ? { title: q.title } : {}), ...(variantLabel ? { variantLabel } : {}),
    fetchedAt, provenanceId, ...(q.sourceHash ? { sourceHash: q.sourceHash } : {}),
    provenance: q.provenance ?? { provenanceId, sourceUrl: q.listingUrl, sourceKind: q.sourceKind ?? "marketplace-listing", fetchedAt, ...(q.sourceHash ? { contentHash: q.sourceHash } : {}), inputHash, variantLabel, note: q.note },
  };
}

export async function loadCatalog() { return readJson(catalogPath, { skus: [] }); }

async function quoteRowsAt(paths, kind, options) {
  const target = kind === "manual" ? paths.manualPath : paths.localPath;
  const file = await readJson(target, null) ?? ((options.allowSeedFallback === true || process.env.PRICE_OFFLINE_SEED_FALLBACK === "true")
    ? await readJson(path.join(paths.seedPricesDir, `${kind}-quotes.json`), { schemaVersion: "1.0.0", quotes: [] }) : { schemaVersion: "1.0.0", quotes: [] });
  assertQuoteFile(file, `runtime ${kind} price quotes`, { allowUnknown: kind === "manual" });
  return (file.quotes ?? []).filter(isAuditedRow).map(normalizeRow);
}

export async function loadManualQuotes(options = {}) { return withPriceRead(options, ({ paths }) => quoteRowsAt(paths, "manual", options)); }
export async function loadLocalQuotes(options = {}) { return withPriceRead(options, ({ paths }) => quoteRowsAt(paths, "local", options)); }

async function saveLocalQuotesAt(paths, quotes, options = {}) {
  const next = { schemaVersion: "1.0.0", note: "Audited quotes captured in active runtime; latest.json is derived.", updatedAt: today(), quotes };
  assertPriceRuntimeAuthority("local-quotes.json", next);
  return writePriceJson(paths, paths.localPath, next, {
    operation: "price-local-quotes", expectedHash: options.expectedHash,
    rollbackRoot: options.rollbackRoot ?? paths.rollbackDir,
    manifestPath: options.manifestPath ?? path.join(options.rollbackRoot ?? paths.rollbackDir, "price-local-manifest.json"),
  });
}

export async function saveLocalQuotes(quotes, options = {}) {
  return withPriceWrite(options, ({ paths }) => saveLocalQuotesAt(paths, quotes, options));
}

async function mergedQuotesAt(paths, options) {
  const merged = new Map();
  for (const quote of await quoteRowsAt(paths, "manual", options)) merged.set(`${quote.skuId}|${quote.platform}|${quote.variantLabel ?? ""}`, quote);
  for (const quote of await quoteRowsAt(paths, "local", options)) merged.set(`${quote.skuId}|${quote.platform}|${quote.variantLabel ?? ""}`, quote);
  return [...merged.values()];
}

export async function mergedQuotes(options = {}) { return withPriceRead(options, ({ paths }) => mergedQuotesAt(paths, options)); }

export async function upsertLocalQuote(quote, options = {}) {
  if (!isAuditedRow(quote)) throw new Error("Quote must have skuId, platform, positive priceCny and evidence=audited");
  const row = normalizeRow(quote);
  return withPriceWrite(options, async ({ paths }) => {
    const quotes = await quoteRowsAt(paths, "local", options);
    const key = `${row.skuId}|${row.platform}|${row.variantLabel ?? ""}`;
    const next = []; let replaced = false;
    for (const previous of quotes) {
      if (`${previous.skuId}|${previous.platform}|${previous.variantLabel ?? ""}` === key) { next.push(row); replaced = true; } else next.push(previous);
    }
    if (!replaced) next.push(row);
    await saveLocalQuotesAt(paths, next, options);
    return row;
  });
}

export async function removeLocalQuote(skuId, platform, variantLabel, options = {}) {
  return withPriceWrite(options, async ({ paths }) => {
    const quotes = await quoteRowsAt(paths, "local", options);
    const next = quotes.filter((quote) => quote.skuId !== skuId || (platform && quote.platform !== platform) || (variantLabel !== undefined && quote.variantLabel !== variantLabel));
    await saveLocalQuotesAt(paths, next, options);
    return quotes.length - next.length;
  });
}

async function restoreRaw(target, bytes) {
  if (bytes === null) await rm(target, { force: true }); else await durableAtomicWriteFile(target, bytes);
}

export async function buildAndWriteLatest(asOf = today(), note, options = {}) {
  return withPriceWrite(options, async ({ paths }) => {
    const quotes = (options.quotes ?? await mergedQuotesAt(paths, options)).filter(isAuditedRow).map(normalizeRow);
    const catalog = options.catalog ?? await readJson(options.catalogPath ?? catalogPath, { schemaVersion: "2.0.0", updatedAt: asOf, skus: [] });
    const catalogVersion = catalog.catalogVersion ?? catalog.schemaVersion ?? null;
    const snapshotNote = note ?? "Derived from active runtime manual/local audited quotes.";
    const inputHash = jsonHash({ asOf, quotes, catalogVersion, note: snapshotNote });
    const snapshotId = `price-snapshot-${inputHash.slice(0, 20)}`;
    const latest = options.latestPath ?? paths.latestPath;
    const snapshots = options.snapshotsDir ?? paths.snapshotsDir;
    const previous = await readJson(latest, null);
    const generatedAt = previous?.inputHash === inputHash && previous?.generatedAt ? previous.generatedAt : new Date().toISOString();
    const snapshot = { schemaVersion: "1.1.0", asOf, note: snapshotNote, snapshotId, generatedAt, catalogVersion, inputHash, priceVersion: "price-snapshot-v2", quotes };
    const next = { ...snapshot, contentHash: jsonHash(snapshot) };
    assertPriceRuntimeAuthority("latest.json", next);
    const dated = path.join(snapshots, `${asOf}.json`);
    const audit = path.join(options.auditRoot ?? paths.priceAuditRoot, `${asOf}.json`);
    const old = await Promise.all([rawFile(latest), rawFile(dated), rawFile(audit)]);
    if ((await readJson(latest, null))?.contentHash === next.contentHash && (await readJson(dated, null))?.contentHash === next.contentHash) return next;
    try {
      const manifest = options.manifestPath ?? paths.priceSnapshotRollbackManifestPath;
      await writePriceJson(paths, latest, next, { operation: "price-snapshot-latest", expectedHash: options.expectedLatestHash, rollbackRoot: options.rollbackRoot ?? paths.rollbackDir, manifestPath: manifest });
      if (options.injectFailureAt === "after-latest") throw new Error("injected price partial-write failure");
      await writePriceJson(paths, dated, next, { operation: "price-snapshot", rollbackRoot: options.rollbackRoot ?? paths.rollbackDir, manifestPath: manifest });
      if (options.injectFailureAt === "after-dated") throw new Error("injected price partial-write failure");
      const existingAudit = await readJson(audit, { schemaVersion: "1.0.0", events: [] });
      const eventId = `price-audit-${inputHash.slice(0, 20)}`;
      const auditDocument = { schemaVersion: "1.0.0", events: [...(existingAudit?.events ?? []).filter((event) => event.eventId !== eventId), { eventId, operation: "price-snapshot", snapshotId, inputHash, contentHash: next.contentHash, catalogVersion, quoteCount: quotes.length, createdAt: generatedAt }] };
      assertPriceRuntimeAuthority(`audit/${asOf}.json`, auditDocument);
      await writePriceJson(paths, audit, auditDocument, {
        operation: "price-snapshot-audit", rollbackRoot: options.rollbackRoot ?? paths.rollbackDir,
        manifestPath: options.auditManifestPath ?? path.join(options.rollbackRoot ?? paths.rollbackDir, "price-audit-manifest.json"),
      });
      return next;
    } catch (error) {
      await Promise.all([restoreRaw(latest, old[0]), restoreRaw(dated, old[1]), restoreRaw(audit, old[2])]);
      throw error;
    }
  });
}

function canonicalListingUrl(value) {
  const parsed = new URL(String(value));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) throw new Error("listing capture URL must be canonical HTTPS without credentials or port");
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) if (/^utm_|^(?:spm|trace|referrer|source)$/i.test(key)) parsed.searchParams.delete(key);
  return parsed.toString();
}

function captureCandidate(candidate) {
  const canonicalUrl = canonicalListingUrl(candidate.url);
  const identity = { skuId: candidate.skuId, platform: candidate.platform, canonicalUrl, fetchedAt: candidate.fetchedAt, title: candidate.title };
  const candidateId = `price-candidate-${jsonHash(identity).slice(0, 20)}`;
  const capture = { schemaVersion: "1.0.0", candidateId, skuId: candidate.skuId, platform: candidate.platform, channel: candidate.channel, title: candidate.title, canonicalUrl, redirectChain: [canonicalUrl], fetchedAt: candidate.fetchedAt,
    variants: Array.isArray(candidate.variants) ? candidate.variants.map((variant) => ({ skuId: String(variant.skuId ?? ""), label: String(variant.label ?? ""), amount: variant.amount, currency: variant.currency ?? null, stock: variant.stock ?? null })) : [],
    variantSource: candidate.variantSource ?? null, source: { priceSource: candidate.priceSource ?? null, query: candidate.query ?? null } };
  const contentHash = jsonHash(capture);
  return { ...candidate, candidateId, listingCaptureId: `listing-capture-${contentHash.slice(0, 20)}`, canonicalUrl, redirectChain: capture.redirectChain, captureContentHash: contentHash, _capture: { ...capture, contentHash } };
}

export async function saveCandidates(payload, asOf = today(), options = {}) {
  return withPriceWrite(options, async ({ paths }) => {
    const candidates = (payload?.candidates ?? []).map(captureCandidate);
    for (const candidate of candidates) {
      const capture = candidate._capture;
      assertPriceRuntimeAuthority(`listing-captures/${candidate.listingCaptureId}.json`, capture);
      await writePriceJson(paths, path.join(paths.listingCapturesDir, `${candidate.listingCaptureId}.json`), capture, { operation: "price-listing-capture", rollbackRoot: paths.rollbackDir, manifestPath: path.join(paths.rollbackDir, "listing-capture-manifest.json") });
      delete candidate._capture;
    }
    const next = { ...payload, schemaVersion: "1.0.0", asOf, candidates };
    assertPriceRuntimeAuthority(`candidates/${asOf}.json`, next);
    await writePriceJson(paths, path.join(paths.candidatesDir, `${asOf}.json`), next, { operation: "price-candidates", expectedHash: options.expectedHash, rollbackRoot: paths.rollbackDir, manifestPath: path.join(paths.rollbackDir, "candidates-manifest.json") });
    return next;
  });
}

export async function loadCandidates(asOf = today(), options = {}) {
  return withPriceRead(options, async ({ paths }) => {
    const value = await readJson(path.join(paths.candidatesDir, `${asOf}.json`), null);
    if (value !== null) assertPriceRuntimeAuthority(`candidates/${asOf}.json`, value);
    return value;
  });
}

export async function loadListingCapture(listingCaptureId, options = {}) {
  if (!/^listing-capture-[a-f0-9]{20}$/.test(String(listingCaptureId))) throw new Error("listingCaptureId is invalid");
  return withPriceRead(options, async ({ paths }) => {
    const capture = await readJson(path.join(paths.listingCapturesDir, `${listingCaptureId}.json`), null);
    if (!capture) throw new Error("listing capture not found or expired");
    assertPriceRuntimeAuthority(`listing-captures/${listingCaptureId}.json`, capture);
    return capture;
  });
}

/** One read barrier for HTTP state and backup/restore coherence checks. */
export async function readActivePriceState(asOf = today(), options = {}) {
  return withPriceRead(options, async ({ paths, state }) => {
    const latest = await readJson(paths.latestPath, null);
    if (latest !== null) assertPriceRuntimeAuthority("latest.json", latest);
    return {
      runtimeGeneration: state?.runtimeGeneration ?? null,
      runtimeRevision: state?.revision ?? null,
      latest,
      manual: await quoteRowsAt(paths, "manual", options),
      local: await quoteRowsAt(paths, "local", options),
      candidates: await readJson(path.join(paths.candidatesDir, `${asOf}.json`), null).then((value) => {
        if (value !== null) assertPriceRuntimeAuthority(`candidates/${asOf}.json`, value);
        return value;
      }),
      fx: await readJson(paths.fxPath, { asOf: null, rates: {}, source: "missing active runtime price fx" }).then((value) => {
        if (value?.schemaVersion !== undefined) assertPriceRuntimeAuthority("fx.json", value);
        return value;
      }),
    };
  });
}

/** Search is an untrusted artifact, kept in the active runtime generation. */
export async function writePriceSearchArtifacts(payload, markdown, asOf = today(), options = {}) {
  return withPriceWrite(options, async ({ paths }) => {
    const jsonFile = path.join(paths.searchDir, `${asOf}.json`);
    const markdownFile = path.join(paths.searchDir, `${asOf}.md`);
    const document = object(payload) ? { ...payload } : payload;
    assertPriceRuntimeAuthority(`search/${asOf}.json`, document);
    await writePriceJson(paths, jsonFile, document, { operation: "price-search-report", rollbackRoot: paths.rollbackDir, manifestPath: path.join(paths.rollbackDir, "search-manifest.json") });
    await writePriceFile(paths, markdownFile, Buffer.from(markdown, "utf8"), {
      operation: "price-search-report-markdown",
      rollbackRoot: paths.rollbackDir,
      manifestPath: path.join(paths.rollbackDir, "search-manifest.json"),
    });
    return { jsonFile, markdownFile };
  });
}
