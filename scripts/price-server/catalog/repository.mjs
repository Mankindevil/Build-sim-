import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { atomicWriteJson } from "../store.mjs";
import { RuntimeCoordinator } from "../../../src/runtime/coordinator.mjs";
import {
  atomicWriteJson as durableAtomicWriteJson,
  confined as runtimeConfined,
  ensurePrivateDirectory,
  pathExists,
  sha256Bytes,
} from "../../../src/runtime/fs.mjs";
import { buildMigrationPlan, sanitizeCatalogUserData } from "../../migrations/isolate-user-data-v1.mjs";

const RUNTIME_METADATA_KEY = "runtimeCatalog";
const RUNTIME_METADATA_SCHEMA_VERSION = "1.0.0";
const defaultBaseCatalogPath = path.resolve(process.cwd(), "data/skus/catalog.json");

function clone(value) {
  return structuredClone(value);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function confined(root, target, label) {
  const resolved = path.resolve(target);
  if (!isInside(root, resolved)) throw new Error(`${label} must stay within CATALOG_PERSIST_ROOT`);
  return resolved;
}

function normalizeProductCatalogOverlay(document) {
  if (document?.overlayKind !== "product_catalog_overlay") return document;
  return {
    schemaVersion: document.schemaVersion,
    catalogVersion: document.overlayVersion,
    updatedAt: document.updatedAt,
    skus: document.skus,
    [RUNTIME_METADATA_KEY]: {
      schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
      overlayKind: document.overlayKind,
      overlayVersion: document.overlayVersion,
      acceptedSkuIds: document.acceptedSkuIds,
      baseCatalogVersion: document.baseCatalogVersion,
      baseUpdatedAt: document.baseUpdatedAt,
    },
  };
}

function validateCatalog(document, label) {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error(`${label} must be a JSON object`);
  if (!/^\d+\.\d+\.\d+$/.test(String(document.schemaVersion ?? ""))) throw new Error(`${label}.schemaVersion is invalid`);
  if (document.catalogVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(String(document.catalogVersion))) throw new Error(`${label}.catalogVersion is invalid`);
  if (typeof document.updatedAt !== "string" || !Number.isFinite(Date.parse(document.updatedAt))) throw new Error(`${label}.updatedAt is invalid`);
  if (!Array.isArray(document.skus)) throw new Error(`${label}.skus must be an array`);
  const ids = new Set();
  for (const sku of document.skus) {
    if (!sku || typeof sku !== "object" || Array.isArray(sku) || typeof sku.id !== "string" || !sku.id) throw new Error(`${label} contains a SKU without a valid id`);
    if (ids.has(sku.id)) throw new Error(`${label} contains duplicate SKU id: ${sku.id}`);
    ids.add(sku.id);
    if (sku.price && typeof sku.price === "object" && sku.price.paid !== undefined) throw new Error(`${label} contains user price.paid for ${sku.id}`);
    if (Array.isArray(sku.tags) && sku.tags.some((tag) => /^(?:owned|paid|user|purchase|transaction)(?:$|[-_])/iu.test(String(tag)))) throw new Error(`${label} contains user ownership tag for ${sku.id}`);
  }
  const metadata = document[RUNTIME_METADATA_KEY];
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error(`${label}.${RUNTIME_METADATA_KEY} must be an object`);
    if (metadata.schemaVersion !== RUNTIME_METADATA_SCHEMA_VERSION) throw new Error(`${label}.${RUNTIME_METADATA_KEY}.schemaVersion is invalid`);
    if (!Array.isArray(metadata.acceptedSkuIds) || metadata.acceptedSkuIds.some((id) => typeof id !== "string" || !id)) {
      throw new Error(`${label}.${RUNTIME_METADATA_KEY}.acceptedSkuIds must be a string array`);
    }
    if (new Set(metadata.acceptedSkuIds).size !== metadata.acceptedSkuIds.length) {
      throw new Error(`${label}.${RUNTIME_METADATA_KEY}.acceptedSkuIds contains duplicates`);
    }
    if (metadata.acceptedSkuIds.some((id) => !ids.has(id))) throw new Error(`${label}.${RUNTIME_METADATA_KEY}.acceptedSkuIds references a missing SKU`);
    if (metadata.overlayKind !== undefined && metadata.overlayKind !== "product_catalog_overlay") throw new Error(`${label}.${RUNTIME_METADATA_KEY}.overlayKind is invalid`);
    if (metadata.overlayVersion !== undefined && (typeof metadata.overlayVersion !== "string" || !metadata.overlayVersion)) throw new Error(`${label}.${RUNTIME_METADATA_KEY}.overlayVersion is invalid`);
    if (metadata.baseCatalogVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(String(metadata.baseCatalogVersion))) throw new Error(`${label}.${RUNTIME_METADATA_KEY}.baseCatalogVersion is invalid`);
    if (metadata.baseUpdatedAt !== undefined && !Number.isFinite(Date.parse(metadata.baseUpdatedAt))) throw new Error(`${label}.${RUNTIME_METADATA_KEY}.baseUpdatedAt is invalid`);
  }
  const isolation = buildMigrationPlan(document, { dryRun: true });
  if (isolation.removedFieldCount > 0) throw new Error(`${label} contains user or transaction fields that require catalog-user-data-v1 isolation`);
  return document;
}

export function assertProductCatalogDocument(document, label = "product catalog") {
  return validateCatalog(clone(document), label);
}

function catalogDraftHashValue(draft) {
  return {
    schemaVersion: draft.schemaVersion,
    draftId: draft.draftId,
    operation: draft.operation,
    baseSkuId: draft.baseSkuId,
    baseSkuHash: draft.baseSkuHash,
    baseCatalogVersion: draft.baseCatalogVersion,
    candidateId: draft.candidateId,
    candidateInputHash: draft.candidateInputHash,
    candidateSnapshot: draft.candidateSnapshot,
    proposed: draft.proposed,
    fields: draft.fields,
    conflicts: draft.conflicts,
    missing: draft.missing,
    changedFields: draft.changedFields,
  };
}

function assertCatalogDraftDocument(document, label) {
  if (!document || typeof document !== "object" || Array.isArray(document)
    || document.schemaVersion !== "1.0.0" || !Array.isArray(document.drafts)) {
    throw new Error(`${label} is invalid`);
  }
  const ids = new Set();
  for (const draft of document.drafts) {
    if (!draft || typeof draft !== "object" || Array.isArray(draft)
      || draft.schemaVersion !== "1.0.0" || !/^sku-draft-[a-f0-9]{20}$/.test(String(draft.draftId ?? ""))
      || ids.has(draft.draftId) || !["create", "update"].includes(draft.operation)
      || !["preview", "draft", "confirming", "confirmed", "rejected"].includes(draft.status)
      || !/^[a-f0-9]{64}$/.test(String(draft.candidateInputHash ?? ""))
      || !/^[a-f0-9]{64}$/.test(String(draft.inputHash ?? "")) || draft.expectedHash !== draft.inputHash
      || !draft.candidateSnapshot || !draft.proposed
      || !Array.isArray(draft.fields) || !Array.isArray(draft.conflicts) || !Array.isArray(draft.missing)
      || !Array.isArray(draft.changedFields) || !Number.isFinite(Date.parse(draft.createdAt))
      || !Number.isFinite(Date.parse(draft.updatedAt))) {
      throw new Error(`${label} contains an invalid or hash-mismatched draft`);
    }
    const actualHash = sha256Bytes(Buffer.from(JSON.stringify(catalogDraftHashValue(draft)), "utf8"));
    if (actualHash !== draft.inputHash) throw new Error(`${label} contains an invalid or hash-mismatched draft`);
    ids.add(draft.draftId);
  }
  return document;
}

/**
 * Validates every current authority path owned by ProductCatalogOverlay.
 * Production backup/restore and Doctor call this same repository validator;
 * an unrecognised file can therefore never become authority merely because it
 * happens to contain parseable JSON.
 */
export function assertProductCatalogRuntimeAuthority(logicalPath, document) {
  if (logicalPath === "product-catalog.json") {
    assertProductCatalogDocument(document, "runtime product catalog");
    return { kind: "product-catalog", id: document.catalogVersion ?? document.schemaVersion };
  }
  if (/^drafts\/\d{4}-\d{2}-\d{2}\.json$/.test(logicalPath)) {
    assertCatalogDraftDocument(document, "runtime product catalog draft file");
    return { kind: "catalog-drafts", ids: document.drafts.map((draft) => draft.draftId) };
  }
  throw new Error("catalog-overlays repository contains an unrecognized authority path");
}

async function readRequiredJson(file, label) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return validateCatalog(normalizeProductCatalogOverlay(JSON.parse(raw)), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} contains invalid JSON at ${file}`);
    throw error;
  }
}

function readRequiredJsonSync(file, label) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return validateCatalog(normalizeProductCatalogOverlay(JSON.parse(raw)), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} contains invalid JSON at ${file}`);
    throw error;
  }
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function existsSync(file) {
  try {
    readFileSync(file, { encoding: "utf8", flag: "r" });
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function numericVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

function newerVersion(baseVersion, runtimeVersion) {
  const base = numericVersion(baseVersion);
  const runtime = numericVersion(runtimeVersion);
  if (!runtime) return String(baseVersion);
  if (!base) return String(runtimeVersion);
  for (let index = 0; index < 3; index += 1) {
    if (runtime[index] > base[index]) return String(runtimeVersion);
    if (runtime[index] < base[index]) return String(baseVersion);
  }
  return String(runtimeVersion);
}

function laterDate(baseDate, runtimeDate) {
  const base = Date.parse(baseDate);
  const runtime = Date.parse(runtimeDate);
  if (!Number.isFinite(runtime)) return baseDate;
  if (!Number.isFinite(base)) return runtimeDate;
  return runtime > base ? runtimeDate : baseDate;
}

function runtimeAcceptedIds(base, runtime) {
  if (!runtime) return [];
  const metadata = runtime[RUNTIME_METADATA_KEY];
  if (metadata) return [...metadata.acceptedSkuIds];
  const baseIds = new Set(base.skus.map((sku) => sku.id));
  // Legacy runtime files did not record accepted ids. Preserve rows that can be
  // proved runtime-only; copied base rows remain owned by the new release.
  return runtime.skus.filter((sku) => !baseIds.has(sku.id)).map((sku) => sku.id);
}

function metadataFor(base, acceptedSkuIds) {
  return {
    schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
    overlayKind: "product_catalog_overlay",
    overlayVersion: base.catalogVersion ?? base.schemaVersion,
    acceptedSkuIds: [...acceptedSkuIds].sort(),
    baseCatalogVersion: base.catalogVersion ?? base.schemaVersion,
    baseUpdatedAt: base.updatedAt,
  };
}

export function mergeCatalogDocuments(baseDocument, runtimeDocument = null) {
  const base = validateCatalog(clone(baseDocument), "base catalog");
  const runtime = runtimeDocument === null ? null : validateCatalog(clone(runtimeDocument), "runtime catalog");
  const acceptedSkuIds = runtimeAcceptedIds(base, runtime);
  const runtimeById = new Map((runtime?.skus ?? []).map((sku) => [sku.id, sku]));
  for (const id of acceptedSkuIds) {
    if (!runtimeById.has(id)) throw new Error(`runtime catalog accepted SKU is missing: ${id}`);
  }
  const accepted = new Set(acceptedSkuIds);
  const baseIds = new Set(base.skus.map((sku) => sku.id));
  const skus = base.skus.map((sku) => accepted.has(sku.id) ? clone(runtimeById.get(sku.id)) : clone(sku));
  for (const sku of runtime?.skus ?? []) {
    if (accepted.has(sku.id) && !baseIds.has(sku.id)) skus.push(clone(sku));
  }
  const baseVersion = base.catalogVersion ?? base.schemaVersion;
  const runtimeVersion = runtime?.catalogVersion ?? runtime?.schemaVersion;
  return {
    schemaVersion: base.schemaVersion,
    catalogVersion: runtime && accepted.size ? newerVersion(baseVersion, runtimeVersion) : String(baseVersion),
    updatedAt: runtime && accepted.size ? laterDate(base.updatedAt, runtime.updatedAt) : base.updatedAt,
    skus,
    [RUNTIME_METADATA_KEY]: metadataFor(base, acceptedSkuIds),
  };
}

export function sanitizeMergedCatalog(catalog) {
  const validated = validateCatalog(catalog, "merged catalog");
  return clone({
    schemaVersion: validated.schemaVersion,
    ...(validated.catalogVersion ? { catalogVersion: validated.catalogVersion } : {}),
    updatedAt: validated.updatedAt,
    skus: validated.skus,
  });
}

function directRepositoryPaths(options = {}) {
  const persistRoot = path.resolve(options.persistRoot ?? process.env.CATALOG_PERSIST_ROOT ?? path.join(process.cwd(), "runtime"));
  const baseCatalogPath = path.resolve(options.baseCatalogPath ?? defaultBaseCatalogPath);
  const runtimeCatalogPath = confined(persistRoot, options.runtimeCatalogPath ?? path.join(persistRoot, "data/skus/catalog.json"), "runtime catalog path");
  const draftRoot = confined(persistRoot, options.draftRoot ?? path.join(persistRoot, "data/catalog-drafts"), "catalog draft root");
  const auditRoot = confined(persistRoot, options.auditRoot ?? path.join(persistRoot, "data/audit/catalog-events"), "catalog audit root");
  const rollbackRoot = confined(persistRoot, options.rollbackRoot ?? path.join(persistRoot, "data/audit/rollback"), "catalog rollback root");
  const rollbackManifestPath = confined(persistRoot, options.rollbackManifestPath ?? path.join(rollbackRoot, "catalog-accept-manifest.json"), "catalog rollback manifest");
  if (runtimeCatalogPath === baseCatalogPath) throw new Error("runtime catalog path must not overwrite the bundled base catalog");
  return { persistRoot, baseCatalogPath, runtimeCatalogPath, draftRoot, auditRoot, rollbackRoot, rollbackManifestPath };
}

function explicitDirectPaths(options) {
  return ["runtimeCatalogPath", "draftRoot", "auditRoot", "rollbackRoot", "rollbackManifestPath"]
    .some((key) => options[key] !== undefined);
}

function usesCoordinator(options = {}) {
  if (options.coordinator || options.generationAware === true) return true;
  if (options.direct === true || options.generationAware === false || explicitDirectPaths(options)) return false;
  // A persistRoot has historically denoted the direct test/recovery layout.
  // Production composition opts in explicitly with its shared coordinator.
  return options.persistRoot === undefined && process.env.CATALOG_PERSIST_ROOT === undefined;
}

function coordinatorFor(options = {}) {
  return options.coordinator ?? new RuntimeCoordinator({
    root: options.runtimeRoot ?? process.env.RUNTIME_ROOT ?? process.env.CATALOG_PERSIST_ROOT ?? path.join(process.cwd(), "runtime"),
    now: options.now,
  });
}

function activeRepositoryPaths(activeRoot, options = {}) {
  const catalogRoot = runtimeConfined(activeRoot, "catalog-overlays");
  const auditRoot = runtimeConfined(activeRoot, "audit", "catalog-events");
  const rollbackRoot = runtimeConfined(activeRoot, "audit", "rollback", "catalog");
  return Object.freeze({
    persistRoot: path.resolve(options.runtimeRoot ?? options.persistRoot ?? process.env.RUNTIME_ROOT ?? process.env.CATALOG_PERSIST_ROOT ?? path.join(process.cwd(), "runtime")),
    activeRoot,
    baseCatalogPath: path.resolve(options.baseCatalogPath ?? defaultBaseCatalogPath),
    runtimeCatalogPath: runtimeConfined(catalogRoot, "product-catalog.json"),
    draftRoot: runtimeConfined(catalogRoot, "drafts"),
    auditRoot,
    rollbackRoot,
    rollbackManifestPath: runtimeConfined(rollbackRoot, "catalog-accept-manifest.json"),
    generationAware: true,
  });
}

async function ensureCatalogLayout(paths) {
  await Promise.all([paths.draftRoot, paths.auditRoot, paths.rollbackRoot].map(ensurePrivateDirectory));
}

/** Resolve configuration only. Generation-aware callers must never cache a
 * returned active path; use withCatalogRead/withCatalogWrite for each operation. */
/** @returns {any} */
export function resolveCatalogRepositoryPaths(options = {}) {
  if (!usesCoordinator(options)) return Object.freeze({ ...directRepositoryPaths(options), generationAware: false });
  return Object.freeze({
    persistRoot: path.resolve(options.runtimeRoot ?? options.persistRoot ?? process.env.RUNTIME_ROOT ?? process.env.CATALOG_PERSIST_ROOT ?? path.join(process.cwd(), "runtime")),
    baseCatalogPath: path.resolve(options.baseCatalogPath ?? defaultBaseCatalogPath),
    coordinator: coordinatorFor(options),
    generationAware: true,
  });
}

export async function withCatalogRead(options = {}, operation) {
  if (typeof operation !== "function") throw new TypeError("catalog read operation is required");
  if (!usesCoordinator(options) && !options.generationAware) return operation(directRepositoryPaths(options));
  const coordinator = coordinatorFor(options);
  await coordinator.initialize(options.appVersion);
  return (await coordinator.withConsistentSnapshot(({ activeRoot }) => operation(activeRepositoryPaths(activeRoot, options)))).result;
}

export async function withCatalogWrite(options = {}, operation) {
  if (typeof operation !== "function") throw new TypeError("catalog write operation is required");
  if (!usesCoordinator(options) && !options.generationAware) {
    const paths = directRepositoryPaths(options);
    await ensureCatalogLayout(paths);
    return operation(paths);
  }
  const coordinator = coordinatorFor(options);
  await coordinator.initialize(options.appVersion);
  return (await coordinator.withWrite(async ({ activeRoot }) => {
    const paths = activeRepositoryPaths(activeRoot, options);
    await ensureCatalogLayout(paths);
    return operation(paths);
  }, {
    ...(options.expectedRuntimeRevision !== undefined ? { expectedRevision: options.expectedRuntimeRevision } : {}),
    ...(options.maintenanceLeaseToken ? { maintenanceLeaseToken: options.maintenanceLeaseToken } : {}),
  })).result;
}

function legacyCatalogPath(options = {}) {
  const root = path.resolve(options.runtimeRoot ?? options.persistRoot ?? options.coordinator?.root ?? process.env.RUNTIME_ROOT ?? process.env.CATALOG_PERSIST_ROOT ?? path.join(process.cwd(), "runtime"));
  return path.join(root, "data/skus/catalog.json");
}

/** Safe, idempotent import for the pre-generation catalog. The source is left
 * untouched as recovery evidence; a control marker prevents restore from ever
 * resurrecting it into a later empty generation. */
export async function migrateLegacyCatalogRepository(options = {}) {
  const coordinator = coordinatorFor({ ...options, generationAware: true });
  await coordinator.initialize(options.appVersion);
  const source = legacyCatalogPath(options);
  const marker = path.join(coordinator.controlRoot, "catalog-legacy-migration.json");
  const sourceBytes = await readFile(source).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  const existingMarker = await readFile(marker, "utf8").then(JSON.parse).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!sourceBytes) return { status: "not_found", source };
  const sourceHash = sha256Bytes(sourceBytes);
  if (existingMarker) {
    if (existingMarker.sourceHash !== sourceHash) throw new Error("legacy runtime catalog changed after migration; refusing ambiguous import");
    return { status: "already_migrated", sourceHash };
  }
  const rawLegacy = normalizeProductCatalogOverlay(JSON.parse(sourceBytes.toString("utf8")));
  const isolation = buildMigrationPlan(rawLegacy, { sourceBytes, dryRun: options.dryRun !== false });
  const legacy = validateCatalog(sanitizeCatalogUserData(rawLegacy), "sanitized legacy runtime catalog");
  if (options.dryRun !== false) return { status: "dry_run", sourceHash, skuCount: legacy.skus.length, removedFieldCount: isolation.removedFieldCount, requiresExplicitApply: true };
  if (options.expectedSourceHash !== sourceHash) throw new Error("legacy catalog migration apply requires the dry-run expected source hash");
  const result = await coordinator.withWrite(async ({ activeRoot, state }) => {
    const paths = activeRepositoryPaths(activeRoot, options);
    await ensureCatalogLayout(paths);
    if (await pathExists(paths.runtimeCatalogPath)) throw new Error("active runtime catalog already exists; refusing legacy overwrite");
    await atomicWriteJson(paths.runtimeCatalogPath, legacy, writeOptions(paths, "catalog-legacy-migration"));
    if (isolation.quarantine.length) await durableAtomicWriteJson(runtimeConfined(activeRoot, "migrations", "catalog-user-data-v1", "quarantine.json"), {
      schemaVersion: "catalog-user-data-quarantine-v1", sourceHash, entries: isolation.quarantine,
    });
    await durableAtomicWriteJson(marker, {
      schemaVersion: "catalog-legacy-migration-v1",
      status: "applied",
      source: path.relative(coordinator.root, source).split(path.sep).join("/"),
      target: path.relative(coordinator.root, paths.runtimeCatalogPath).split(path.sep).join("/"),
      sourceHash,
      removedFieldCount: isolation.removedFieldCount,
      targetHash: sha256Bytes(await readFile(paths.runtimeCatalogPath)),
      runtimeGeneration: state.runtimeGeneration,
      migratedAt: new Date().toISOString(),
    });
    return { status: "applied", sourceHash, removedFieldCount: isolation.removedFieldCount, runtimeGeneration: state.runtimeGeneration };
  });
  return result.result;
}

export async function loadMergedCatalog(options = {}) {
  return withCatalogRead(options, async (paths) => {
    const base = await readRequiredJson(paths.baseCatalogPath, "base catalog");
    const runtime = await exists(paths.runtimeCatalogPath) ? await readRequiredJson(paths.runtimeCatalogPath, "runtime catalog") : null;
    return mergeCatalogDocuments(base, runtime);
  });
}

export function loadMergedCatalogSync(options = {}) {
  let paths;
  if (!usesCoordinator(options) && !options.generationAware) paths = directRepositoryPaths(options);
  else if (options.activeRoot) paths = activeRepositoryPaths(path.resolve(options.activeRoot), options);
  else {
    const coordinator = coordinatorFor(options);
    const state = JSON.parse(readFileSync(coordinator.stateFile, "utf8"));
    paths = activeRepositoryPaths(coordinator.activeRoot(state), options);
  }
  const base = readRequiredJsonSync(paths.baseCatalogPath, "base catalog");
  const runtime = existsSync(paths.runtimeCatalogPath) ? readRequiredJsonSync(paths.runtimeCatalogPath, "runtime catalog") : null;
  return mergeCatalogDocuments(base, runtime);
}

function writeOptions(paths, operation) {
  return { operation, rollbackRoot: paths.rollbackRoot, manifestPath: paths.rollbackManifestPath };
}

export async function initializeRuntimeCatalog(options = {}) {
  return withCatalogWrite(options, async (paths) => {
    const base = await readRequiredJson(paths.baseCatalogPath, "base catalog");
    const current = await exists(paths.runtimeCatalogPath) ? await readRequiredJson(paths.runtimeCatalogPath, "runtime catalog") : null;
    const merged = mergeCatalogDocuments(base, current);
    if (current && JSON.stringify(current) === JSON.stringify(merged)) return merged;
    await atomicWriteJson(paths.runtimeCatalogPath, merged, writeOptions(paths, "catalog-runtime-initialize"));
    return merged;
  });
}

export async function markRuntimeCatalogSkuAccepted(skuId, options = {}) {
  if (typeof skuId !== "string" || !skuId) throw new Error("accepted SKU id is required");
  return withCatalogWrite(options, async (paths) => {
    if (!await exists(paths.runtimeCatalogPath)) throw new Error("runtime catalog is not initialized");
    const currentBytes = await readFile(paths.runtimeCatalogPath);
    if (options.expectedHash !== undefined && options.expectedHash !== sha256Bytes(currentBytes)) throw new Error("runtime catalog expected hash conflict");
    const runtime = validateCatalog(normalizeProductCatalogOverlay(JSON.parse(currentBytes.toString("utf8"))), "runtime catalog");
    if (!runtime.skus.some((sku) => sku.id === skuId)) throw new Error(`accepted SKU is missing from runtime catalog: ${skuId}`);
    const priorIds = runtime[RUNTIME_METADATA_KEY]?.acceptedSkuIds ?? [];
    runtime[RUNTIME_METADATA_KEY] = {
      ...(runtime[RUNTIME_METADATA_KEY] ?? {}),
      schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
      acceptedSkuIds: [...new Set([...priorIds, skuId])].sort(),
    };
    const base = await readRequiredJson(paths.baseCatalogPath, "base catalog");
    const merged = mergeCatalogDocuments(base, runtime);
    await atomicWriteJson(paths.runtimeCatalogPath, merged, { ...writeOptions(paths, "catalog-runtime-accept"), expectedHash: sha256Bytes(currentBytes) });
    return merged;
  });
}

export function resultRequiresRuntimeCatalogRetention(result) {
  if (!result?.skuId) return false;
  if (result.status === "accepted") return true;
  if (result.status !== "confirmed") return false;
  if (result.catalogChanged !== undefined) return result.catalogChanged === true;
  if (result.created !== undefined) return result.created === true;
  return Array.isArray(result.changedFields) && result.changedFields.length > 0;
}

export function catalogWriteOptions(options = {}, catalog) {
  const paths = options.runtimeCatalogPath ? options : directRepositoryPaths(options);
  return {
    ...(catalog ? { catalog } : {}),
    catalogPath: paths.runtimeCatalogPath,
    draftRoot: paths.draftRoot,
    auditRoot: paths.auditRoot,
    rollbackRoot: paths.rollbackRoot,
    rollbackManifestPath: paths.rollbackManifestPath,
    validateCatalog: (value) => assertProductCatalogDocument(value, "catalog write"),
    retainRuntimeSkuMetadata: true,
  };
}
