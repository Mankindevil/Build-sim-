import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRuntimeCatalog } from "../scripts/price-server/catalog/repository.mjs";
import {
  applyBuildConfigV3Migration,
  planBuildConfigV3Migration,
} from "../scripts/migrations/migrate-plans-v3";
import { verifyBackup } from "../src/backup/runtime.mjs";
import { FilePlanRepository } from "../src/plans/file-repository";
import { createEmptyBuildConfig } from "../src/plans/default-plan";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U12 V2 to V3 production-shaped migration rehearsal", () => {
  it("dry-runs without writes, requires the reviewed manifest, backs up, migrates, and preserves a verified rollback", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "buildsim-plan-v3-rehearsal-"));
    roots.push(runtimeRoot);
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now: () => "2026-08-30T10:00:00.000Z" });
    await coordinator.initialize("0.2.0-alpha");
    await initializeRuntimeCatalog({ coordinator, generationAware: true });
    const repository = new FilePlanRepository({ coordinator, runtimeRoot });
    const created = await repository.create({
      name: "Migration rehearsal",
      config: createEmptyBuildConfig("plan-migration-rehearsal", "2026-08-30T10:00:00.000Z"),
    });
    const beforeState = await coordinator.readState();
    const beforeGraph = await createProductionReferenceGraph({
      coordinator,
      now: () => "2026-08-30T10:00:30.000Z",
    });

    const preview = await planBuildConfigV3Migration({
      runtimeRoot,
      now: () => "2026-08-30T10:01:00.000Z",
    });
    expect(preview).toMatchObject({
      mode: "dry-run",
      status: "ready",
      backup: null,
      plans: [{ planId: created.id, status: "ready", sourceDraftRevision: created.draftRevision }],
    });
    expect(await coordinator.readState()).toEqual(beforeState);
    expect(await createProductionReferenceGraph({
      coordinator,
      now: () => "2026-08-30T10:00:30.000Z",
    })).toEqual(beforeGraph);

    const backupRoot = await mkdtemp(path.join(os.tmpdir(), "buildsim-plan-v3-backup-"));
    roots.push(backupRoot);
    await expect(applyBuildConfigV3Migration({
      runtimeRoot,
      expectedSourceManifestHash: "0".repeat(64),
      backupOutput: path.join(backupRoot, "wrong-source.backup"),
      password: "migration rehearsal password",
      now: () => "2026-08-30T10:02:00.000Z",
    })).rejects.toThrow(/source manifest changed/);
    expect((await repository.get(created.id)).draft.config.schemaVersion).toBe("2.0.0");

    const backupOutput = path.join(backupRoot, `plan-v3-${preview.sourceManifestHash.slice(0, 12)}.backup`);
    const applied = await applyBuildConfigV3Migration({
      runtimeRoot,
      expectedSourceManifestHash: preview.sourceManifestHash,
      backupOutput,
      password: "migration rehearsal password",
      now: () => "2026-08-30T10:03:00.000Z",
    });
    expect(applied).toMatchObject({
      mode: "apply",
      status: "completed",
      backup: { verificationResult: "pass" },
      plans: [{ planId: created.id, status: "migrated" }],
    });
    const migrated = await new FilePlanRepository({ coordinator, runtimeRoot, topologyV3Enabled: true }).get(created.id);
    expect(migrated.draft.config.schemaVersion).toBe("3.0.0");
    expect(migrated.draft.configMigration).toMatchObject({
      sourceSchemaVersion: "2.0.0",
      targetSchemaVersion: "3.0.0",
      sourceConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(verifyBackup({ inputFile: backupOutput, password: "migration rehearsal password" }))
      .resolves.toMatchObject({ valid: true, report: { result: "pass" } });
  }, 30_000);

  it("retains archived V2 plans as readable legacy history without blocking active-plan migration", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "buildsim-plan-v3-archived-"));
    roots.push(runtimeRoot);
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now: () => "2026-08-30T11:00:00.000Z" });
    await coordinator.initialize("0.2.0-alpha");
    await initializeRuntimeCatalog({ coordinator, generationAware: true });
    const repository = new FilePlanRepository({ coordinator, runtimeRoot });
    const active = await repository.create({
      name: "Active V2",
      config: createEmptyBuildConfig("plan-active-v2", "2026-08-30T11:00:00.000Z"),
    });
    const archived = await repository.create({
      name: "Archived V2",
      config: createEmptyBuildConfig("plan-archived-v2", "2026-08-30T11:00:00.000Z"),
    });
    await repository.archive(archived.id);

    const preview = await planBuildConfigV3Migration({ runtimeRoot, now: () => "2026-08-30T11:01:00.000Z" });
    expect(preview.status).toBe("ready");
    expect(preview.plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ planId: active.id, status: "ready" }),
      expect.objectContaining({ planId: archived.id, status: "retained_v2" }),
    ]));
  });
});
