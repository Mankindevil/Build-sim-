import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { atomicWriteJson } from "../store.mjs";

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

function validateCatalog(document, label) {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error(`${label} must be a JSON object`);
  if (typeof document.schemaVersion !== "string" || !document.schemaVersion) throw new Error(`${label}.schemaVersion is required`);
  if (typeof document.updatedAt !== "string" || !document.updatedAt) throw new Error(`${label}.updatedAt is required`);
  if (!Array.isArray(document.skus)) throw new Error(`${label}.skus must be an array`);
  const ids = new Set();
  for (const sku of document.skus) {
    if (!sku || typeof sku !== "object" || Array.isArray(sku) || typeof sku.id !== "string" || !sku.id) throw new Error(`${label} contains a SKU without a valid id`);
    if (ids.has(sku.id)) throw new Error(`${label} contains duplicate SKU id: ${sku.id}`);
    ids.add(sku.id);
  }
  const metadata = document[RUNTIME_METADATA_KEY];
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error(`${label}.${RUNTIME_METADATA_KEY} must be an object`);
    if (!Array.isArray(metadata.acceptedSkuIds) || metadata.acceptedSkuIds.some((id) => typeof id !== "string" || !id)) {
      throw new Error(`${label}.${RUNTIME_METADATA_KEY}.acceptedSkuIds must be a string array`);
    }
    if (new Set(metadata.acceptedSkuIds).size !== metadata.acceptedSkuIds.length) {
      throw new Error(`${label}.${RUNTIME_METADATA_KEY}.acceptedSkuIds contains duplicates`);
    }
  }
  return document;
}

async function readRequiredJson(file, label) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return validateCatalog(JSON.parse(raw), label);
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
    return validateCatalog(JSON.parse(raw), label);
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

export function resolveCatalogRepositoryPaths(options = {}) {
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

export async function loadMergedCatalog(options = {}) {
  const paths = resolveCatalogRepositoryPaths(options);
  const base = await readRequiredJson(paths.baseCatalogPath, "base catalog");
  const runtime = await exists(paths.runtimeCatalogPath) ? await readRequiredJson(paths.runtimeCatalogPath, "runtime catalog") : null;
  return mergeCatalogDocuments(base, runtime);
}

export function loadMergedCatalogSync(options = {}) {
  const paths = resolveCatalogRepositoryPaths(options);
  const base = readRequiredJsonSync(paths.baseCatalogPath, "base catalog");
  const runtime = existsSync(paths.runtimeCatalogPath) ? readRequiredJsonSync(paths.runtimeCatalogPath, "runtime catalog") : null;
  return mergeCatalogDocuments(base, runtime);
}

function writeOptions(paths, operation) {
  return { operation, rollbackRoot: paths.rollbackRoot, manifestPath: paths.rollbackManifestPath };
}

export async function initializeRuntimeCatalog(options = {}) {
  const paths = resolveCatalogRepositoryPaths(options);
  const merged = await loadMergedCatalog(paths);
  const current = await exists(paths.runtimeCatalogPath) ? await readRequiredJson(paths.runtimeCatalogPath, "runtime catalog") : null;
  if (current && JSON.stringify(current) === JSON.stringify(merged)) return merged;
  await atomicWriteJson(paths.runtimeCatalogPath, merged, writeOptions(paths, "catalog-runtime-initialize"));
  return merged;
}

export async function markRuntimeCatalogSkuAccepted(skuId, options = {}) {
  if (typeof skuId !== "string" || !skuId) throw new Error("accepted SKU id is required");
  const paths = resolveCatalogRepositoryPaths(options);
  if (!await exists(paths.runtimeCatalogPath)) throw new Error("runtime catalog is not initialized");
  const runtime = await readRequiredJson(paths.runtimeCatalogPath, "runtime catalog");
  if (!runtime.skus.some((sku) => sku.id === skuId)) throw new Error(`accepted SKU is missing from runtime catalog: ${skuId}`);
  const priorIds = runtime[RUNTIME_METADATA_KEY]?.acceptedSkuIds ?? [];
  runtime[RUNTIME_METADATA_KEY] = {
    ...(runtime[RUNTIME_METADATA_KEY] ?? {}),
    schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
    acceptedSkuIds: [...new Set([...priorIds, skuId])].sort(),
  };
  const base = await readRequiredJson(paths.baseCatalogPath, "base catalog");
  const merged = mergeCatalogDocuments(base, runtime);
  await atomicWriteJson(paths.runtimeCatalogPath, merged, writeOptions(paths, "catalog-runtime-accept"));
  return merged;
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
  const paths = resolveCatalogRepositoryPaths(options);
  return {
    ...(catalog ? { catalog } : {}),
    catalogPath: paths.runtimeCatalogPath,
    draftRoot: paths.draftRoot,
    auditRoot: paths.auditRoot,
    rollbackRoot: paths.rollbackRoot,
    rollbackManifestPath: paths.rollbackManifestPath,
    retainRuntimeSkuMetadata: true,
  };
}
