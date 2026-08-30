#!/usr/bin/env -S vite-node
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBackup, persistBackupVerification, restoreBackup, verifyBackup } from "../../src/backup/runtime.mjs";
import { sha256Hex as sha256Utf8 } from "../../src/hash";
import { CurrentPriceSnapshotService } from "../../src/price/snapshot";
import { PriceRepository } from "../../src/price/repository";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import { atomicWriteFile, canonicalJson, confined, pathExists, sha256Bytes, sha256Json } from "../../src/runtime/fs.mjs";
import { persistProductionReferenceGraph } from "../../src/runtime/production-reference-graph.mjs";
import { loadMergedCatalogSync } from "../price-server/catalog/repository.mjs";
import { assertPriceRuntimeAuthority } from "../price-server/store.mjs";
import { fail, parseArguments, readPassword } from "../backup/cli.mjs";

type LatestStatus = "legacy_v1" | "current_v2" | "missing" | "invalid";
type MigrationAction = "archive_and_rebuild" | "rebuild_current" | "no_change" | "blocked";

export interface PriceSnapshotV2MigrationReport {
  readonly schemaVersion: "price-snapshot-v2-migration-report-v1";
  readonly migrationId: "prices-current-v1-to-v2";
  readonly mode: "dry-run" | "apply";
  readonly status: "ready" | "blocked" | "completed";
  readonly runtimeGeneration: number;
  readonly runtimeRevision: number;
  readonly generatedAt: string;
  readonly asOf: string;
  readonly effectiveAt: string;
  readonly sourceManifestHash: string;
  readonly reportHash: string;
  readonly source: {
    readonly latestStatus: LatestStatus;
    readonly latestByteHash: string | null;
    readonly contentHash: string | null;
    readonly schemaVersion: string | null;
    readonly snapshotId: string | null;
    readonly quoteCount: number | null;
    readonly reason: string | null;
  };
  readonly plan: {
    readonly action: MigrationAction;
    readonly archiveRef: string | null;
    readonly governedCaptureCount: number;
    readonly governedObservationCount: number;
    readonly selectedObservationIds: readonly string[];
    readonly omittedObservationIds: readonly string[];
    readonly projectedQuoteCount: number;
  };
  readonly result: null | {
    readonly snapshotId: string;
    readonly contentHash: string;
    readonly quoteCount: number;
    readonly archiveRef: string | null;
  };
  readonly backup: null | {
    readonly backupId: string;
    readonly manifestHash: string;
    readonly verificationResult: "pass";
  };
}

interface Inspection {
  readonly runtimeGeneration: number;
  readonly runtimeRevision: number;
  readonly sourceManifestHash: string;
  readonly source: PriceSnapshotV2MigrationReport["source"];
  readonly plan: PriceSnapshotV2MigrationReport["plan"];
}

function calendarDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new TypeError("price snapshot migration asOf must be a calendar date");
  }
  return value;
}

function reportHash(value: Omit<PriceSnapshotV2MigrationReport, "reportHash">): Promise<string> {
  return sha256Utf8(`buildsim\0price-snapshot-v2-migration-report-v1\0${canonicalJson(value)}`);
}

async function governedFiles(activeRoot: string): Promise<Array<{ logicalPath: string; byteLength: number; sha256: string }>> {
  const priceRoot = confined(activeRoot, "prices");
  const result: Array<{ logicalPath: string; byteLength: number; sha256: string }> = [];
  for (const relativeRoot of ["domain/captures", "domain/observations"]) {
    const directory = confined(priceRoot, ...relativeRoot.split("/"));
    if (!await pathExists(directory)) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("price snapshot migration source contains a symbolic link");
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = confined(directory, entry.name);
      const bytes = await readFile(file);
      result.push({ logicalPath: `${relativeRoot}/${entry.name}`, byteLength: bytes.length, sha256: sha256Bytes(bytes) });
    }
  }
  return result.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
}

async function inspectLatest(activeRoot: string): Promise<{
  source: PriceSnapshotV2MigrationReport["source"];
  bytes: Buffer | null;
  value: Record<string, unknown> | null;
}> {
  const latest = confined(activeRoot, "prices", "latest.json");
  let bytes: Buffer;
  try { bytes = await readFile(latest); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { source: { latestStatus: "missing", latestByteHash: null, contentHash: null, schemaVersion: null, snapshotId: null, quoteCount: null, reason: null }, bytes: null, value: null };
    }
    throw error;
  }
  const byteHash = sha256Bytes(bytes);
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    assertPriceRuntimeAuthority("latest.json", parsed);
    const current = parsed.priceVersion === "price-snapshot-v2";
    return {
      source: {
        latestStatus: current ? "current_v2" : "legacy_v1",
        latestByteHash: byteHash,
        contentHash: typeof parsed.contentHash === "string" ? parsed.contentHash : null,
        schemaVersion: typeof parsed.schemaVersion === "string" ? parsed.schemaVersion : null,
        snapshotId: typeof parsed.snapshotId === "string" ? parsed.snapshotId : null,
        quoteCount: Array.isArray(parsed.quotes) ? parsed.quotes.length : null,
        reason: null,
      },
      bytes,
      value: parsed,
    };
  } catch (error) {
    return {
      source: {
        latestStatus: "invalid", latestByteHash: byteHash, contentHash: null, schemaVersion: null,
        snapshotId: null, quoteCount: null,
        reason: error instanceof Error ? error.message : "current price snapshot is invalid",
      },
      bytes,
      value: null,
    };
  }
}

async function inspectAtRoot(options: {
  activeRoot: string;
  runtimeGeneration: number;
  runtimeRevision: number;
  asOf: string;
  effectiveAt: string;
  coordinator: RuntimeCoordinator;
}): Promise<Inspection> {
  const latest = await inspectLatest(options.activeRoot);
  const catalog = loadMergedCatalogSync({ activeRoot: options.activeRoot, generationAware: true });
  const prices = new PriceRepository({ coordinator: options.coordinator, now: () => options.effectiveAt });
  const snapshots = new CurrentPriceSnapshotService({ coordinator: options.coordinator, prices, catalog: () => catalog, now: () => options.effectiveAt });
  const [projection, captures, observations, files] = await Promise.all([
    snapshots.previewAtRoot(options.activeRoot, options.effectiveAt),
    prices.listListingCapturesAtRoot(options.activeRoot),
    prices.listObservationsAtRoot(options.activeRoot),
    governedFiles(options.activeRoot),
  ]);
  const action: MigrationAction = latest.source.latestStatus === "invalid" ? "blocked"
    : latest.source.latestStatus === "current_v2" ? "no_change"
      : latest.source.latestStatus === "legacy_v1" ? "archive_and_rebuild" : "rebuild_current";
  const archiveRef = latest.source.latestStatus === "legacy_v1" && latest.source.contentHash
    ? `prices/snapshots/legacy-${latest.source.contentHash}.json` : null;
  const plan = {
    action,
    archiveRef,
    governedCaptureCount: captures.length,
    governedObservationCount: observations.length,
    selectedObservationIds: projection.selectedObservationIds,
    omittedObservationIds: projection.omittedObservationIds,
    projectedQuoteCount: projection.quotes.length,
  } as const;
  const sourceManifestHash = await sha256Utf8(`buildsim\0price-snapshot-v2-migration-source-v1\0${canonicalJson({
    schemaVersion: "price-snapshot-v2-migration-source-v1",
    runtimeGeneration: options.runtimeGeneration,
    runtimeRevision: options.runtimeRevision,
    asOf: options.asOf,
    effectiveAt: options.effectiveAt,
    latest: latest.source,
    governedFiles: files,
    catalogHash: sha256Json(catalog),
    projection: {
      selectedObservationIds: projection.selectedObservationIds,
      omittedObservationIds: projection.omittedObservationIds,
      quoteCount: projection.quotes.length,
    },
  })}`);
  return { runtimeGeneration: options.runtimeGeneration, runtimeRevision: options.runtimeRevision, sourceManifestHash, source: latest.source, plan };
}

function reportBase(inspection: Inspection, options: {
  mode: "dry-run" | "apply";
  generatedAt: string;
  asOf: string;
  effectiveAt: string;
  status: "ready" | "blocked" | "completed";
  result?: PriceSnapshotV2MigrationReport["result"];
  backup?: PriceSnapshotV2MigrationReport["backup"];
}): Omit<PriceSnapshotV2MigrationReport, "reportHash"> {
  return {
    schemaVersion: "price-snapshot-v2-migration-report-v1",
    migrationId: "prices-current-v1-to-v2",
    mode: options.mode,
    status: options.status,
    runtimeGeneration: inspection.runtimeGeneration,
    runtimeRevision: inspection.runtimeRevision,
    generatedAt: options.generatedAt,
    asOf: options.asOf,
    effectiveAt: options.effectiveAt,
    sourceManifestHash: inspection.sourceManifestHash,
    source: inspection.source,
    plan: inspection.plan,
    result: options.result ?? null,
    backup: options.backup ?? null,
  };
}

/** Read-only price migration projection. It never initializes or writes the runtime. */
export async function planPriceSnapshotV2Migration(options: {
  runtimeRoot: string;
  asOf?: string;
  now?: () => string;
}): Promise<PriceSnapshotV2MigrationReport> {
  const generatedAt = (options.now ?? (() => new Date().toISOString()))();
  if (!Number.isFinite(Date.parse(generatedAt))) throw new TypeError("price snapshot migration clock is invalid");
  const asOf = calendarDate(options.asOf ?? generatedAt.slice(0, 10));
  const effectiveAt = `${asOf}T12:00:00.000Z`;
  const coordinator = new RuntimeCoordinator({ root: path.resolve(options.runtimeRoot), now: options.now });
  const captured = await coordinator.withReadOnlySnapshot(async ({ state, activeRoot }: {
    state: { runtimeGeneration: number; revision: number };
    activeRoot: string;
  }) => inspectAtRoot({
    activeRoot, runtimeGeneration: state.runtimeGeneration, runtimeRevision: state.revision, asOf, effectiveAt, coordinator,
  }));
  const inspection = captured.result;
  const base = reportBase(inspection, {
    mode: "dry-run", generatedAt, asOf, effectiveAt,
    status: inspection.plan.action === "blocked" ? "blocked" : "ready",
  });
  return { ...base, reportHash: await reportHash(base) };
}

export async function applyPriceSnapshotV2Migration(options: {
  runtimeRoot: string;
  expectedSourceManifestHash: string;
  backupOutput: string;
  password: string;
  asOf?: string;
  now?: () => string;
  injectFailureAt?: "after_archive" | "after_rebuild";
  afterBackup?: () => void | Promise<void>;
}): Promise<PriceSnapshotV2MigrationReport> {
  if (!/^[a-f0-9]{64}$/.test(options.expectedSourceManifestHash)) {
    throw new Error("price snapshot v2 migration apply requires the exact dry-run source manifest hash");
  }
  const preview = await planPriceSnapshotV2Migration(options);
  if (preview.status !== "ready") throw new Error("price snapshot v2 migration is blocked");
  if (preview.sourceManifestHash !== options.expectedSourceManifestHash) {
    throw new Error("price snapshot v2 migration source manifest changed after review");
  }
  if (preview.plan.action === "no_change") {
    const base = reportBase(preview, {
      mode: "apply", generatedAt: preview.generatedAt, asOf: preview.asOf, effectiveAt: preview.effectiveAt,
      status: "completed",
      result: preview.source.snapshotId && preview.source.contentHash ? {
        snapshotId: preview.source.snapshotId,
        contentHash: preview.source.contentHash,
        quoteCount: preview.source.quoteCount ?? 0,
        archiveRef: null,
      } : null,
    });
    return { ...base, reportHash: await reportHash(base) };
  }
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const backupOutput = path.resolve(options.backupOutput);
  const relativeBackup = path.relative(runtimeRoot, backupOutput);
  if (relativeBackup === "" || (relativeBackup !== ".." && !relativeBackup.startsWith(`..${path.sep}`))) {
    throw new Error("price snapshot v2 migration backup output must be outside the runtime root");
  }
  await mkdir(path.dirname(backupOutput), { recursive: true });
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now: options.now });
  const backup = await createBackup({ coordinator, outputFile: backupOutput, password: options.password, now: options.now });
  const verification = await verifyBackup({ inputFile: backupOutput, password: options.password, now: options.now });
  if (!verification.valid || verification.report.result !== "pass") throw new Error("pre-migration backup verification failed");
  await options.afterBackup?.();
  let writesStarted = false;
  try {
    const committed = await coordinator.withWrite(async ({ state, activeRoot }: {
      state: { runtimeGeneration: number; revision: number };
      activeRoot: string;
    }) => {
      const current = await inspectAtRoot({
        activeRoot, runtimeGeneration: state.runtimeGeneration, runtimeRevision: state.revision, asOf: preview.asOf,
        effectiveAt: preview.effectiveAt, coordinator,
      });
      if (current.sourceManifestHash !== preview.sourceManifestHash) {
        throw new Error("price snapshot v2 migration source changed before commit");
      }
      const latest = await inspectLatest(activeRoot);
      let archiveRef: string | null = null;
      if (current.plan.action === "archive_and_rebuild") {
        if (!latest.bytes || !latest.source.contentHash || latest.source.latestByteHash !== preview.source.latestByteHash) {
          throw new Error("legacy current price snapshot changed before archive");
        }
        archiveRef = `prices/snapshots/legacy-${latest.source.contentHash}.json`;
        const archive = confined(activeRoot, ...archiveRef.split("/"));
        assertPriceRuntimeAuthority(`snapshots/legacy-${latest.source.contentHash}.json`, latest.value);
        if (await pathExists(archive)) {
          const existing = await readFile(archive);
          if (!existing.equals(latest.bytes)) throw new Error("legacy price snapshot archive already exists with different bytes");
        } else {
          writesStarted = true;
          await atomicWriteFile(archive, latest.bytes);
        }
        if (options.injectFailureAt === "after_archive") throw new Error("injected price snapshot migration failure after archive");
      }
      writesStarted = true;
      const prices = new PriceRepository({ coordinator, now: () => preview.effectiveAt });
      const snapshots = new CurrentPriceSnapshotService({
        coordinator,
        prices,
        catalog: (root) => loadMergedCatalogSync({ activeRoot: root, generationAware: true }),
        now: () => preview.effectiveAt,
      });
      const rebuilt = await snapshots.rebuildAtRoot(activeRoot, preview.asOf, preview.effectiveAt);
      if (options.injectFailureAt === "after_rebuild") throw new Error("injected price snapshot migration failure after rebuild");
      return { rebuilt, archiveRef };
    });
    await persistBackupVerification({ coordinator, verification });
    await persistProductionReferenceGraph({ coordinator, now: options.now });
    const result = {
      snapshotId: committed.result.rebuilt.snapshot.snapshotId,
      contentHash: committed.result.rebuilt.snapshot.contentHash,
      quoteCount: committed.result.rebuilt.snapshot.quotes.length,
      archiveRef: committed.result.archiveRef,
    };
    const base = reportBase(preview, {
      mode: "apply", generatedAt: (options.now ?? (() => new Date().toISOString()))(),
      asOf: preview.asOf, effectiveAt: preview.effectiveAt, status: "completed", result,
      backup: { backupId: backup.manifest.backupId, manifestHash: backup.manifest.manifestHash, verificationResult: "pass" },
    });
    return { ...base, reportHash: await reportHash(base) };
  } catch (error) {
    if (writesStarted) {
      await restoreBackup({ coordinator, inputFile: backupOutput, password: options.password, now: options.now });
      await persistProductionReferenceGraph({ coordinator, now: options.now });
      throw new Error(`price snapshot v2 migration failed and the verified backup was restored: ${error instanceof Error ? error.message : "unknown failure"}`);
    }
    throw error;
  }
}

export async function runPriceSnapshotV2MigrationCli(
  argv = process.argv.slice(2),
  environment: Record<string, string | undefined> = process.env,
): Promise<PriceSnapshotV2MigrationReport> {
  const args = parseArguments(argv) as Record<string, string | true | undefined>;
  const runtimeRoot = typeof args["runtime-root"] === "string" ? args["runtime-root"] : environment.RUNTIME_ROOT;
  if (!runtimeRoot) throw new Error("--runtime-root is required");
  if (args.apply === true && typeof args["backup-output"] !== "string") throw new Error("--backup-output is required for --apply");
  const shared = {
    runtimeRoot,
    ...(typeof args["as-of"] === "string" ? { asOf: args["as-of"] } : {}),
  };
  const result = args.apply === true
    ? await applyPriceSnapshotV2Migration({
      ...shared,
      expectedSourceManifestHash: String(args["expected-source-manifest-hash"] ?? ""),
      backupOutput: String(args["backup-output"] ?? ""),
      password: await readPassword(args, environment),
    })
    : await planPriceSnapshotV2Migration(shared);
  if (typeof args.output === "string") {
    const output = path.resolve(args.output);
    await mkdir(path.dirname(output), { recursive: true });
    await atomicWriteFile(output, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) runPriceSnapshotV2MigrationCli().then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch(fail);
