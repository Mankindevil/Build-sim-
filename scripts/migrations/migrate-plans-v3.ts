#!/usr/bin/env -S vite-node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBackup, persistBackupVerification, restoreBackup, verifyBackup } from "../../src/backup/runtime.mjs";
import { serializeConfig, type BuildConfigDocument, type ConfigV2 } from "../../src/config/types";
import { sha256Hex as sha256Utf8 } from "../../src/hash";
import { canonicalJson, sha256Hex as legacySha256Hex } from "../../src/plans/canonical";
import { FilePlanRepository } from "../../src/plans/file-repository";
import { migrateBuildConfigV2ToV3 } from "../../src/plans/migration";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import { atomicWriteJson } from "../../src/runtime/fs.mjs";
import { persistProductionReferenceGraph } from "../../src/runtime/production-reference-graph.mjs";
import { loadMergedCatalogSync } from "../price-server/catalog/repository.mjs";
import { fail, parseArguments, readPassword } from "../backup/cli.mjs";

export interface PlanV3MigrationItem {
  readonly planId: string;
  readonly planName: string;
  readonly sourceDraftRevision: number;
  readonly sourceConfigHash: string;
  readonly status: "ready" | "already_v3" | "retained_v2" | "blocked" | "migrated";
  readonly reason: string | null;
  readonly diffCount: number;
  readonly warningCodes: readonly string[];
  readonly rollbackRef: string | null;
}

export interface PlanV3MigrationReport {
  readonly schemaVersion: "plan-v3-migration-report-v1";
  readonly migrationId: "plans-v2-to-v3";
  readonly mode: "dry-run" | "apply";
  readonly status: "ready" | "blocked" | "completed";
  readonly runtimeGeneration: number;
  readonly generatedAt: string;
  readonly sourceManifestHash: string;
  readonly reportHash: string;
  readonly backup: null | {
    readonly backupId: string;
    readonly manifestHash: string;
    readonly verificationResult: "pass";
  };
  readonly plans: readonly PlanV3MigrationItem[];
}

function reportHash(value: Omit<PlanV3MigrationReport, "reportHash">): Promise<string> {
  return sha256Utf8(`buildsim\0plan-v3-migration-report-v1\0${canonicalJson(value)}`);
}

async function sourceManifestHash(runtimeGeneration: number, plans: readonly PlanV3MigrationItem[]): Promise<string> {
  return sha256Utf8(`buildsim\0plan-v3-migration-source-v1\0${canonicalJson({
    schemaVersion: "plan-v3-migration-source-v1",
    runtimeGeneration,
    plans: plans.map(({ planId, sourceDraftRevision, sourceConfigHash, status, reason }) => ({
      planId, sourceDraftRevision, sourceConfigHash, status, reason,
    })),
  })}`);
}

/** Read-only plan projection. It never initializes or writes the runtime. */
export async function planBuildConfigV3Migration(options: {
  runtimeRoot: string;
  now?: () => string;
}): Promise<PlanV3MigrationReport> {
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now: options.now });
  const repository = new FilePlanRepository<BuildConfigDocument>({
    coordinator,
    runtimeRoot,
    topologyV3Enabled: true,
    getCatalogAtRoot: (activeRoot) => loadMergedCatalogSync({ activeRoot, generationAware: true }),
  });
  const snapshot = await coordinator.withReadOnlySnapshot(async ({ state, activeRoot }: {
    state: { runtimeGeneration: number };
    activeRoot: string;
  }) => {
    const catalog = loadMergedCatalogSync({ activeRoot, generationAware: true });
    const items: PlanV3MigrationItem[] = [];
    for (const summary of (await repository.listAtRoot(activeRoot)).sort((left, right) => left.id.localeCompare(right.id))) {
      const plan = await repository.getAtRoot(activeRoot, summary.id);
      const sourceConfigHash = await legacySha256Hex(plan.draft.config);
      if (plan.draft.config.schemaVersion === "3.0.0") {
        items.push({
          planId: plan.id, planName: plan.name, sourceDraftRevision: plan.draftRevision,
          sourceConfigHash, status: "already_v3", reason: null, diffCount: 0, warningCodes: [], rollbackRef: null,
        });
        continue;
      }
      if (plan.status !== "active") {
        items.push({
          planId: plan.id, planName: plan.name, sourceDraftRevision: plan.draftRevision,
          sourceConfigHash, status: "retained_v2", reason: "archived V2 plan retained as immutable legacy history",
          diffCount: 0, warningCodes: [], rollbackRef: null,
        });
        continue;
      }
      const source = plan.draft.config as ConfigV2;
      const sourceBytes = serializeConfig(source);
      const sourceHash = await sha256Utf8(sourceBytes);
      const preview = await migrateBuildConfigV2ToV3(source, { sourceBytes, sourceHash, catalog });
      items.push({
        planId: plan.id, planName: plan.name, sourceDraftRevision: plan.draftRevision,
        sourceConfigHash, status: "ready", reason: null, diffCount: preview.diff.length,
        warningCodes: [...new Set(preview.warnings.map(({ code }) => code))].sort(),
        rollbackRef: preview.rollbackRef.sourceHash,
      });
    }
    return { runtimeGeneration: state.runtimeGeneration, items };
  });
  const { runtimeGeneration, items } = snapshot.result as {
    runtimeGeneration: number;
    items: PlanV3MigrationItem[];
  };
  const manifestHash = await sourceManifestHash(runtimeGeneration, items);
  const base: Omit<PlanV3MigrationReport, "reportHash"> = {
    schemaVersion: "plan-v3-migration-report-v1",
    migrationId: "plans-v2-to-v3",
    mode: "dry-run",
    status: items.some(({ status }) => status === "blocked") ? "blocked" : "ready",
    runtimeGeneration,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    sourceManifestHash: manifestHash,
    backup: null,
    plans: items,
  };
  return { ...base, reportHash: await reportHash(base) };
}

export async function applyBuildConfigV3Migration(options: {
  runtimeRoot: string;
  expectedSourceManifestHash: string;
  backupOutput: string;
  password: string;
  now?: () => string;
}): Promise<PlanV3MigrationReport> {
  if (!/^[a-f0-9]{64}$/.test(options.expectedSourceManifestHash)) {
    throw new Error("plan V3 migration apply requires the exact dry-run source manifest hash");
  }
  const preview = await planBuildConfigV3Migration(options);
  if (preview.status !== "ready") throw new Error("plan V3 migration is blocked by one or more plans");
  if (preview.sourceManifestHash !== options.expectedSourceManifestHash) {
    throw new Error("plan V3 migration source manifest changed after review");
  }
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const backupOutput = path.resolve(options.backupOutput);
  const backupRelative = path.relative(runtimeRoot, backupOutput);
  if (backupRelative === "" || (!backupRelative.startsWith(`..${path.sep}`) && backupRelative !== ".." && !path.isAbsolute(backupRelative))) {
    throw new Error("plan V3 migration backup output must be outside the active runtime root");
  }
  await mkdir(path.dirname(backupOutput), { recursive: true });
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now: options.now });
  const backup = await createBackup({ coordinator, outputFile: backupOutput, password: options.password, now: options.now });
  const verification = await verifyBackup({ inputFile: backupOutput, password: options.password, now: options.now });
  if (!verification.valid || verification.report.result !== "pass") throw new Error("pre-migration backup verification failed");
  const repository = new FilePlanRepository<BuildConfigDocument>({
    coordinator,
    runtimeRoot,
    topologyV3Enabled: true,
    getCatalogAtRoot: (activeRoot) => loadMergedCatalogSync({ activeRoot, generationAware: true }),
  });
  try {
    for (const item of preview.plans.filter(({ status }) => status === "ready")) {
      await repository.migrateDraftToV3(item.planId, {
        expectedRevision: item.sourceDraftRevision,
        idempotencyKey: `plan-v3-migration-${preview.sourceManifestHash.slice(0, 24)}`,
      });
    }
    await persistBackupVerification({ coordinator, verification });
    await persistProductionReferenceGraph({ coordinator, now: options.now });
  } catch (error) {
    await restoreBackup({ coordinator, inputFile: backupOutput, password: options.password, now: options.now });
    await persistProductionReferenceGraph({ coordinator, now: options.now });
    throw new Error(`plan V3 migration failed and the verified backup was restored: ${error instanceof Error ? error.message : "unknown failure"}`);
  }
  const after = await planBuildConfigV3Migration(options);
  const plans = after.plans.map((item) => {
    const before = preview.plans.find(({ planId }) => planId === item.planId);
    return before?.status === "ready" ? { ...item, status: "migrated" as const } : item;
  });
  const base: Omit<PlanV3MigrationReport, "reportHash"> = {
    ...after,
    mode: "apply",
    status: "completed",
    sourceManifestHash: preview.sourceManifestHash,
    backup: {
      backupId: backup.manifest.backupId,
      manifestHash: backup.manifest.manifestHash,
      verificationResult: "pass",
    },
    plans,
  };
  return { ...base, reportHash: await reportHash(base) };
}

export async function runPlanV3MigrationCli(
  argv = process.argv.slice(2),
  environment: Record<string, string | undefined> = process.env,
): Promise<PlanV3MigrationReport> {
  const args = parseArguments(argv) as Record<string, string | true | undefined>;
  const runtimeRoot = typeof args["runtime-root"] === "string" ? args["runtime-root"] : environment.RUNTIME_ROOT;
  if (!runtimeRoot) throw new Error("--runtime-root is required");
  if (args.apply === true && typeof args["backup-output"] !== "string") {
    throw new Error("--backup-output is required for --apply");
  }
  const result = args.apply === true
    ? await applyBuildConfigV3Migration({
      runtimeRoot,
      expectedSourceManifestHash: String(args["expected-source-manifest-hash"] ?? ""),
      backupOutput: String(args["backup-output"] ?? ""),
      password: await readPassword(args, environment),
    })
    : await planBuildConfigV3Migration({ runtimeRoot });
  if (typeof args.output === "string") {
    const output = path.resolve(args.output);
    await mkdir(path.dirname(output), { recursive: true });
    await atomicWriteJson(output, result);
  }
  return result;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) runPlanV3MigrationCli().then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch(fail);
