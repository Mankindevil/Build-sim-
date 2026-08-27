import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  atomicWriteFile,
  atomicWriteJson,
  privateMode,
  sha256Bytes,
  sha256Json,
  withDirectoryLock,
} from "../../src/runtime/fs.mjs";

export const MIGRATION_ID = "catalog-user-data-v1";
const USER_TAG = /^(?:owned|paid|user|purchase|transaction)(?:$|[-_])/iu;
// Only classify text that carries an explicit user/order provenance marker.
// Marketplace names, “purchase-ready”, price-planning notes, and an unknown
// current price are product-data quality notes, not private user records.
const USER_NOTE = /(?:\buser\b|用户|成交|实付|\bpaid\b|\bowned\b|\btransaction\b|\border(?:\s*(?:id|no\.?|number)|#)|\breceipt\b|订单|收货|截图)/iu;
const USER_NAME = /\(\s*(?:owned|user|已有|自有)/iu;

function clone(value) { return structuredClone(value); }
function timestamp() { return new Date().toISOString(); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function hasOwn(value, key) { return value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key); }

function userFields(sku) {
  const fields = [];
  if (hasOwn(sku?.price, "paid")) fields.push("price.paid");
  if (Array.isArray(sku?.tags)) for (const tag of sku.tags) if (USER_TAG.test(String(tag))) fields.push(`tags.${tag}`);
  if (typeof sku?.name === "string" && USER_NAME.test(sku.name)) fields.push("name.user-marker");
  if (typeof sku?.price?.note === "string" && USER_NOTE.test(sku.price.note)) fields.push("price.user-note");
  if (typeof sku?.harness?.note === "string" && USER_NOTE.test(sku.harness.note)) fields.push("harness.note.user-observation");
  if (typeof sku?.harness?.crossCheck === "string" && USER_NOTE.test(sku.harness.crossCheck)) fields.push("harness.crossCheck.user-attachment");
  if (typeof sku?.attrs?.peripheralSocketsNote === "string" && USER_NOTE.test(sku.attrs.peripheralSocketsNote)) fields.push("attrs.peripheralSocketsNote.user-observation");
  if (typeof sku?.portMap?.source === "string" && USER_NOTE.test(sku.portMap.source)) fields.push("portMap.source.user-observation");
  return [...new Set(fields)];
}

function fieldValue(sku, field) {
  if (field === "price.paid") return sku.price?.paid;
  if (field.startsWith("tags.")) return field.slice(5);
  if (field === "name.user-marker") return sku.name;
  if (field === "price.user-note") return sku.price?.note;
  if (field === "harness.note.user-observation") return sku.harness?.note;
  if (field === "harness.crossCheck.user-attachment") return sku.harness?.crossCheck;
  if (field === "attrs.peripheralSocketsNote.user-observation") return sku.attrs?.peripheralSocketsNote;
  if (field === "portMap.source.user-observation") return sku.portMap?.source;
  throw new Error(`unsupported migration field: ${field}`);
}

function sanitizeSku(sku) {
  const next = clone(sku);
  if (next.price && typeof next.price === "object") {
    delete next.price.paid;
    if (typeof next.price.note === "string" && USER_NOTE.test(next.price.note)) delete next.price.note;
  }
  if (Array.isArray(next.tags)) next.tags = next.tags.filter((tag) => !USER_TAG.test(String(tag)));
  if (typeof next.name === "string" && USER_NAME.test(next.name)) next.name = next.name.replace(/\s*\(\s*(?:owned|user|已有|自有)[^)]*\)\s*/giu, "").trim();
  if (typeof next.harness?.note === "string" && USER_NOTE.test(next.harness.note)) delete next.harness.note;
  if (typeof next.harness?.crossCheck === "string" && USER_NOTE.test(next.harness.crossCheck)) delete next.harness.crossCheck;
  if (typeof next.attrs?.peripheralSocketsNote === "string" && USER_NOTE.test(next.attrs.peripheralSocketsNote)) delete next.attrs.peripheralSocketsNote;
  if (typeof next.portMap?.source === "string" && USER_NOTE.test(next.portMap.source)) delete next.portMap.source;
  return next;
}

export function sanitizeCatalogUserData(catalog) {
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.skus)) throw new TypeError("catalog.skus must be an array");
  return { ...clone(catalog), skus: catalog.skus.map(sanitizeSku) };
}

export function buildMigrationPlan(catalog, options = {}) {
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.skus)) throw new TypeError("catalog.skus must be an array");
  const entries = [];
  const quarantine = [];
  const skus = catalog.skus.map((sku) => {
    if (!sku || typeof sku.id !== "string" || !sku.id) throw new Error("every legacy SKU requires an id");
    const sourceFields = userFields(sku);
    entries.push({
      legacySkuId: sku.id,
      sourceFields,
      destination: sourceFields.length ? "quarantine" : "none",
      reason: sourceFields.length ? "user data is not attributable to a plan" : "no user fields found",
    });
    if (sourceFields.length) {
      quarantine.push({
        quarantineId: `catalog-user-${crypto.createHash("sha256").update(`${sku.id}|${sourceFields.join(",")}`).digest("hex").slice(0, 20)}`,
        skuId: sku.id,
        sourceFields,
        values: Object.fromEntries(sourceFields.map((field) => [field, fieldValue(sku, field)])),
        planId: null,
        status: "unattributed",
        reason: "requires explicit plan attribution",
      });
    }
    return sanitizeSku(sku);
  });
  const nextCatalog = { ...clone(catalog), skus };
  const sourceBytes = options.sourceBytes ?? jsonBytes(catalog);
  const nextBytes = jsonBytes(nextCatalog);
  const quarantineDocument = { schemaVersion: "1.0.0", migrationId: MIGRATION_ID, entries: quarantine };
  const createdAt = options.createdAt ?? timestamp();
  return {
    schemaVersion: "catalog-user-data-migration-v1",
    migrationId: MIGRATION_ID,
    createdAt,
    updatedAt: createdAt,
    mode: options.dryRun === false ? "apply" : "dry-run",
    status: "planned",
    source: options.catalogPath ?? "data/skus/catalog.json",
    sourceHashBefore: sha256Bytes(sourceBytes),
    sourceHashAfter: sha256Bytes(nextBytes),
    removedFieldCount: entries.reduce((sum, entry) => sum + entry.sourceFields.length, 0),
    entries,
    quarantine,
    output: {
      catalogHash: sha256Bytes(nextBytes),
      quarantineCount: quarantine.length,
      quarantineHash: sha256Json(quarantineDocument),
    },
    audit: {
      status: "planned",
      entriesExpected: catalog.skus.length,
      entriesObserved: entries.length,
      sourceHashBefore: sha256Bytes(sourceBytes),
      sourceHashAfter: sha256Bytes(nextBytes),
      quarantineHash: sha256Json(quarantineDocument),
    },
    rollback: {
      required: true,
      backupPath: null,
      backupHash: null,
      originalBackupHash: null,
      sanitizedRollbackHash: null,
      manifestPath: options.manifestPath ?? "data/migrations/catalog-user-data-v1-run.json",
    },
    policy: {
      neverDeleteSourceAutomatically: true,
      unattributedDestination: options.quarantinePath ?? "runtime/quarantine/catalog-user-data-v1",
      requiresPlanAttribution: true,
    },
  };
}

async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }

function resolvePaths(options = {}) {
  const catalogPath = path.resolve(options.catalogPath ?? path.join(process.cwd(), "data/skus/catalog.json"));
  const manifestPath = path.resolve(options.manifestPath ?? path.join(process.cwd(), "data/migrations/catalog-user-data-v1-run.json"));
  const quarantineDefault = options.manifestPath
    ? path.join(path.dirname(manifestPath), "quarantine/catalog-user-data-v1")
    : path.join(process.cwd(), "runtime/quarantine/catalog-user-data-v1");
  const quarantinePath = path.resolve(options.quarantinePath ?? quarantineDefault);
  const lockPath = path.resolve(options.lockPath ?? `${manifestPath}.lock`);
  return { catalogPath, manifestPath, quarantinePath, lockPath };
}

async function existingManifest(manifestPath) {
  try { return await readJson(manifestPath); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function verifyPrivateOutput(paths) {
  for (const file of paths.files) if (await privateMode(file) !== PRIVATE_FILE_MODE) throw new Error(`migration output is not mode 0600: ${path.basename(file)}`);
  for (const directory of paths.directories) if (await privateMode(directory) !== PRIVATE_DIRECTORY_MODE) throw new Error(`migration directory is not mode 0700: ${path.basename(directory)}`);
}

/** Execute the isolation migration. Dry-run is the default and never mutates the catalog. */
export async function runMigration(options = {}) {
  const paths = resolvePaths(options);
  return withDirectoryLock(paths.lockPath, async () => {
    const priorManifest = await existingManifest(paths.manifestPath);
    const catalogBytes = await readFile(paths.catalogPath);
    const currentHash = sha256Bytes(catalogBytes);
    if (priorManifest?.migrationId === MIGRATION_ID && priorManifest.status === "applied") {
      if (currentHash !== priorManifest.sourceHashAfter) throw new Error("applied migration catalog changed; refusing to overwrite a newer write");
      return priorManifest;
    }
    if (priorManifest?.migrationId === MIGRATION_ID && priorManifest.status === "applying" && currentHash === priorManifest.sourceHashAfter) {
      const backupHash = sha256Bytes(await readFile(priorManifest.rollback.backupPath));
      const quarantineFile = path.join(paths.quarantinePath, "catalog-user-data.json");
      const quarantineHash = sha256Json(await readJson(quarantineFile));
      if (backupHash !== priorManifest.rollback.backupHash || quarantineHash !== priorManifest.output.quarantineHash) throw new Error("partial migration recovery hash mismatch");
      const recovered = {
        ...priorManifest,
        status: "applied",
        updatedAt: timestamp(),
        audit: { ...priorManifest.audit, status: "applied", recoveredFromPartialCommit: true, backupHash, quarantineHash, catalogHash: currentHash },
      };
      await atomicWriteJson(paths.manifestPath, recovered);
      return recovered;
    }
    if (priorManifest?.migrationId === MIGRATION_ID && priorManifest.status === "applying" && currentHash !== priorManifest.sourceHashBefore) throw new Error("partial migration has an unrecognized catalog hash");
    const expectedSourceHash = options.expectedSourceHash ?? (["dry_run", "applying"].includes(priorManifest?.status) ? priorManifest.sourceHashBefore : null);
    if (options.dryRun === false && !expectedSourceHash) throw new Error("migration apply requires an expected source hash or matching dry-run manifest");
    if (expectedSourceHash && expectedSourceHash !== currentHash) throw new Error("migration source hash mismatch");
    const catalog = JSON.parse(catalogBytes.toString("utf8"));
    const plan = buildMigrationPlan(catalog, {
      ...options,
      catalogPath: paths.catalogPath,
      manifestPath: paths.manifestPath,
      quarantinePath: paths.quarantinePath,
      sourceBytes: catalogBytes,
      dryRun: options.dryRun !== false,
    });
    if (options.dryRun !== false) {
      plan.status = "dry_run";
      plan.audit.status = "dry_run";
      plan.updatedAt = timestamp();
      await atomicWriteJson(paths.manifestPath, plan);
      await verifyPrivateOutput({ files: [paths.manifestPath], directories: [path.dirname(paths.manifestPath)] });
      return plan;
    }

    const backupPath = path.join(path.dirname(paths.manifestPath), "rollback", `${path.basename(paths.catalogPath)}.${Date.now()}.${currentHash.slice(0, 12)}.bak`);
    const quarantineFile = path.join(paths.quarantinePath, "catalog-user-data.json");
    const nextCatalog = { ...catalog, skus: catalog.skus.map(sanitizeSku) };
    const nextBytes = jsonBytes(nextCatalog);
    const quarantineDocument = { schemaVersion: "1.0.0", migrationId: MIGRATION_ID, entries: plan.quarantine };
    const applying = {
      ...plan,
      mode: "apply",
      status: "applying",
      updatedAt: timestamp(),
      audit: { ...plan.audit, status: "applying" },
      rollback: { ...plan.rollback, backupPath, backupHash: currentHash, originalBackupHash: currentHash, sanitizedRollbackHash: plan.sourceHashAfter },
    };
    await atomicWriteJson(paths.manifestPath, applying);
    await atomicWriteFile(backupPath, catalogBytes);
    await atomicWriteJson(quarantineFile, quarantineDocument);
    if (sha256Bytes(await readFile(paths.catalogPath)) !== currentHash) throw new Error("migration source changed concurrently before commit");
    await atomicWriteFile(paths.catalogPath, nextBytes);
    const committedHash = sha256Bytes(await readFile(paths.catalogPath));
    if (committedHash !== plan.sourceHashAfter) throw new Error("migration catalog commit hash mismatch");
    const applied = {
      ...applying,
      status: "applied",
      updatedAt: timestamp(),
      audit: {
        ...applying.audit,
        status: "applied",
        originalBackupHash: sha256Bytes(await readFile(backupPath)),
        sanitizedRollbackHash: plan.sourceHashAfter,
        quarantineHash: sha256Json(await readJson(quarantineFile)),
        catalogHash: committedHash,
      },
    };
    await atomicWriteJson(paths.manifestPath, applied);
    await verifyPrivateOutput({
      files: [paths.catalogPath, paths.manifestPath, backupPath, quarantineFile],
      directories: [path.dirname(paths.manifestPath), path.dirname(backupPath), paths.quarantinePath],
    });
    return applied;
  }, { timeoutMs: options.lockTimeoutMs, staleMs: options.lockStaleMs });
}

export async function rollbackMigration(manifestPath, options = {}) {
  const resolvedManifest = path.resolve(manifestPath);
  const lockPath = path.resolve(options.lockPath ?? `${resolvedManifest}.lock`);
  return withDirectoryLock(lockPath, async () => {
    const manifest = await readJson(resolvedManifest);
    if (manifest?.migrationId !== MIGRATION_ID || !manifest?.rollback?.backupPath) throw new Error("migration has no rollback backup");
    const target = path.resolve(manifest.source);
    const backup = path.resolve(manifest.rollback.backupPath);
    const currentHash = sha256Bytes(await readFile(target));
    const backupBytes = await readFile(backup);
    const originalBackupHash = sha256Bytes(backupBytes);
    if (originalBackupHash !== manifest.rollback.backupHash || originalBackupHash !== manifest.rollback.originalBackupHash || originalBackupHash !== manifest.sourceHashBefore) throw new Error("rollback backup hash mismatch");
    let originalCatalog;
    try { originalCatalog = JSON.parse(backupBytes.toString("utf8")); } catch { throw new Error("rollback backup catalog is invalid"); }
    if (!originalCatalog || !Array.isArray(originalCatalog.skus)) throw new Error("rollback backup catalog schema is invalid");
    const sanitizedRollbackBytes = jsonBytes({ ...originalCatalog, skus: originalCatalog.skus.map(sanitizeSku) });
    const sanitizedRollbackHash = sha256Bytes(sanitizedRollbackBytes);
    if (manifest.rollback.sanitizedRollbackHash && manifest.rollback.sanitizedRollbackHash !== sanitizedRollbackHash) throw new Error("sanitized rollback hash mismatch");
    if (manifest.status === "rolled_back") {
      if (currentHash !== sanitizedRollbackHash) throw new Error("rolled-back product catalog changed unexpectedly");
      return { target, backup, restoredProductOnly: true, status: "already_rolled_back", originalBackupHash, sanitizedRollbackHash };
    }
    if (!["applied", "rolling_back"].includes(manifest.status)) throw new Error(`migration is not rollback-ready: ${manifest.status}`);
    const allowedCurrentHashes = manifest.status === "rolling_back" ? [manifest.sourceHashAfter, sanitizedRollbackHash] : [manifest.sourceHashAfter];
    if (!allowedCurrentHashes.includes(currentHash)) throw new Error("rollback refused because catalog has a newer write");
    const rollbackStartedAt = manifest.rollback.rollbackStartedAt ?? timestamp();
    const rollingBack = {
      ...manifest,
      status: "rolling_back",
      updatedAt: timestamp(),
      audit: { ...manifest.audit, status: "rolling_back", originalBackupHash, sanitizedRollbackHash },
      rollback: { ...manifest.rollback, rollbackStartedAt, originalBackupHash, sanitizedRollbackHash },
    };
    await atomicWriteJson(resolvedManifest, rollingBack);
    if (currentHash !== sanitizedRollbackHash) await atomicWriteFile(target, sanitizedRollbackBytes);
    const committedRollbackHash = sha256Bytes(await readFile(target));
    if (committedRollbackHash !== sanitizedRollbackHash) throw new Error("product-only rollback commit hash mismatch");
    const rolledBack = {
      ...rollingBack,
      status: "rolled_back",
      updatedAt: timestamp(),
      audit: { ...rollingBack.audit, status: "rolled_back", originalBackupHash, sanitizedRollbackHash, catalogHash: committedRollbackHash },
      rollback: { ...rollingBack.rollback, restoredAt: timestamp() },
    };
    await atomicWriteJson(resolvedManifest, rolledBack);
    return { target, backup, restoredProductOnly: true, status: "rolled_back", originalBackupHash, sanitizedRollbackHash };
  }, { timeoutMs: options.lockTimeoutMs, staleMs: options.lockStaleMs });
}

/**
 * Keep the migration CLI inert when this module is bundled into a server
 * entrypoint. Rollup preserves `import.meta.url` as the generated server URL,
 * so an URL-only main check would execute the migration during server startup.
 */
export function isCatalogUserDataMigrationCliEntry(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1 || path.basename(argv1) !== "isolate-user-data-v1.mjs") return false;
  try {
    return path.resolve(fileURLToPath(metaUrl)) === path.resolve(argv1);
  } catch {
    return false;
  }
}

if (isCatalogUserDataMigrationCliEntry()) {
  const args = new Set(process.argv.slice(2));
  const valueAfter = (flag, fallback) => { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] ?? fallback : fallback; };
  const options = {
    dryRun: !args.has("--apply"),
    catalogPath: valueAfter("--catalog", undefined),
    manifestPath: valueAfter("--manifest", undefined),
    quarantinePath: valueAfter("--quarantine", undefined),
    expectedSourceHash: valueAfter("--expected-source-hash", undefined),
  };
  runMigration(options).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
