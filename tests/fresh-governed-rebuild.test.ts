import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreBackup, verifyBackup } from "../src/backup/runtime.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteJson, confined, listRegularFiles, readJson, sha256Json } from "../src/runtime/fs.mjs";
import {
  FRESH_GOVERNED_REBUILD_CONFIRMATION,
  applyFreshGovernedRebuildPlan,
  createFreshGovernedRebuildPlan,
  validateFreshGovernedRebuildPlan,
  writeFreshGovernedRebuildPlan,
} from "../src/runtime/fresh-governed-rebuild.mjs";
import { validateProductionRuntimeRoot } from "../src/runtime/production-reference-graph.mjs";
import { runFreshGovernedRebuildCli } from "../scripts/runtime/fresh-governed-rebuild.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const now = () => "2026-08-31T09:00:00.000Z";
const password = "fresh rebuild test password";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "buildsim-fresh-rebuild-"));
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const artifactsRoot = path.join(root, "operator-artifacts");
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now });
  const state = await coordinator.initialize("fresh-rebuild-test");
  const legacyFile = confined(coordinator.activeRoot(state), "migrations", "quarantine", "legacy-runtime-v1", "legacy.txt");
  await mkdir(path.dirname(legacyFile), { recursive: true, mode: 0o700 });
  await writeFile(legacyFile, "legacy N6 values must remain backup-only\n", { mode: 0o600 });
  return { root, runtimeRoot, artifactsRoot, coordinator, legacyFile };
}

describe("fresh governed runtime rebuild", () => {
  it("backs up and verifies the old generation, then activates an empty authority generation without legacy imports", async () => {
    const test = await fixture();
    const before = await test.coordinator.readState();
    const plan = await createFreshGovernedRebuildPlan({ coordinator: test.coordinator, now });
    expect(validateFreshGovernedRebuildPlan(plan)).toEqual([]);
    expect(plan).toMatchObject({
      sourceRuntimeGeneration: 1,
      sourceRuntimeRevision: 0,
      legacyDisposition: "backup_only_no_legacy_import",
      preservedAuthorityKinds: ["backup_verification"],
    });
    expect(await test.coordinator.readState()).toEqual(before);

    const planFile = path.join(test.artifactsRoot, "fresh-plan.json");
    await writeFreshGovernedRebuildPlan(planFile, plan, test.runtimeRoot);
    expect((await lstat(planFile)).mode & 0o777).toBe(0o600);
    const backupFile = path.join(test.artifactsRoot, "legacy-runtime.backup");
    const result = await applyFreshGovernedRebuildPlan({
      coordinator: test.coordinator,
      plan,
      expectedPlanHash: plan.contentHash,
      backupOutput: backupFile,
      password,
      confirmation: FRESH_GOVERNED_REBUILD_CONFIRMATION,
      now,
    });
    expect(result).toMatchObject({ runtimeGeneration: 2, runtimeRevision: 2, legacyImported: false });
    expect((await lstat(backupFile)).mode & 0o777).toBe(0o600);
    await expect(verifyBackup({ inputFile: backupFile, password, now })).resolves.toMatchObject({ valid: true });

    const activeState = await test.coordinator.readState();
    const activeRoot = test.coordinator.activeRoot(activeState);
    const files = (await listRegularFiles(activeRoot)).map(({ logicalPath }) => logicalPath).sort();
    expect(files).toEqual([
      `backups/verifications/${result.backupManifestHash}.json`,
      "migrations/fresh-governed-rebuild-v1/manifest.json",
    ]);
    expect(files.some((file) => file.includes("legacy-runtime-v1"))).toBe(false);
    const manifest = await readJson(confined(activeRoot, "migrations", "fresh-governed-rebuild-v1", "manifest.json"));
    expect(manifest).toMatchObject({
      backupManifestHash: result.backupManifestHash,
      legacyDisposition: "backup_only_no_legacy_import",
      targetRuntimeGeneration: 2,
    });
    await expect(validateProductionRuntimeRoot({ state: activeState, activeRoot, now })).resolves.toMatchObject({ runtimeGeneration: 2 });

    await rm(confined(activeRoot, `backups/verifications/${result.backupManifestHash}.json`));
    await expect(validateProductionRuntimeRoot({ state: activeState, activeRoot, now }))
      .rejects.toThrow(/backup verification closure is invalid/);

    const restored = await restoreBackup({ coordinator: test.coordinator, inputFile: backupFile, password, now });
    expect(restored.state.runtimeGeneration).toBe(3);
    const restoredLegacy = confined(test.coordinator.activeRoot(restored.state), "migrations", "quarantine", "legacy-runtime-v1", "legacy.txt");
    expect(await readFile(restoredLegacy, "utf8")).toContain("backup-only");
  });

  it("verifies and restores a backup taken after the fresh authority generation was activated", async () => {
    const test = await fixture();
    const plan = await createFreshGovernedRebuildPlan({ coordinator: test.coordinator, now });
    await applyFreshGovernedRebuildPlan({
      coordinator: test.coordinator,
      plan,
      expectedPlanHash: plan.contentHash,
      backupOutput: path.join(test.artifactsRoot, "legacy-before-rebuild.backup"),
      password,
      confirmation: FRESH_GOVERNED_REBUILD_CONFIRMATION,
      now,
    });
    const freshBackup = path.join(test.artifactsRoot, "fresh-authority.backup");
    const created = await createBackup({
      coordinator: test.coordinator,
      outputFile: freshBackup,
      password,
      now,
    });
    expect(created.manifest.runtimeGeneration).toBe(2);
    await expect(verifyBackup({ inputFile: freshBackup, password, now })).resolves.toMatchObject({
      valid: true,
      report: { temporaryRestore: { runtimeGeneration: 3 } },
    });

    const restoredRoot = path.join(test.root, "restored-runtime");
    const restoredCoordinator = new RuntimeCoordinator({ root: restoredRoot, now });
    await restoredCoordinator.initialize("fresh-authority-restore-test");
    const restored = await restoreBackup({
      coordinator: restoredCoordinator,
      inputFile: freshBackup,
      password,
      now,
    });
    expect(restored.state.runtimeGeneration).toBe(3);
    await expect(validateProductionRuntimeRoot({
      state: restored.state,
      activeRoot: restoredCoordinator.activeRoot(restored.state),
      now,
    })).resolves.toMatchObject({ runtimeGeneration: 3 });
    const manifest = await readJson(confined(
      restoredCoordinator.activeRoot(restored.state),
      "migrations",
      "fresh-governed-rebuild-v1",
      "manifest.json",
    ));
    expect(manifest.targetRuntimeGeneration).toBe(2);
  });

  it("fails closed on stale review, in-runtime artifacts and staged manifest tampering without switching authority", async () => {
    const stale = await fixture();
    const plan = await createFreshGovernedRebuildPlan({ coordinator: stale.coordinator, now });
    await stale.coordinator.withWrite(async () => undefined);
    await expect(applyFreshGovernedRebuildPlan({
      coordinator: stale.coordinator, plan, expectedPlanHash: plan.contentHash,
      backupOutput: path.join(stale.artifactsRoot, "stale.backup"), password,
      confirmation: FRESH_GOVERNED_REBUILD_CONFIRMATION, now,
    })).rejects.toThrow(/source authority changed/);
    expect((await stale.coordinator.readState()).runtimeGeneration).toBe(1);
    await expect(writeFreshGovernedRebuildPlan(path.join(stale.runtimeRoot, "plan.json"), plan, stale.runtimeRoot))
      .rejects.toThrow(/outside the runtime root/);

    const tampered = await fixture();
    const validPlan = await createFreshGovernedRebuildPlan({ coordinator: tampered.coordinator, now });
    await expect(applyFreshGovernedRebuildPlan({
      coordinator: tampered.coordinator, plan: validPlan, expectedPlanHash: validPlan.contentHash,
      backupOutput: path.join(tampered.artifactsRoot, "tampered.backup"), password,
      confirmation: FRESH_GOVERNED_REBUILD_CONFIRMATION, now,
      beforePointerSwitch: async ({ staging }: { staging: string }) => {
        const file = confined(staging, "migrations", "fresh-governed-rebuild-v1", "manifest.json");
        const value = await readJson(file);
        value.legacyDisposition = "legacy_imported";
        const { manifestHash: _ignored, ...material } = value;
        value.manifestHash = sha256Json(material);
        await atomicWriteJson(file, value);
      },
    })).rejects.toThrow(/fresh governed rebuild migration manifest is invalid/);
    expect((await tampered.coordinator.readState()).runtimeGeneration).toBe(1);
    expect(await readFile(tampered.legacyFile, "utf8")).toContain("backup-only");
  });

  it("requires a reviewed exact plan hash and an explicit confirmation in the CLI", async () => {
    const test = await fixture();
    const planFile = path.join(test.artifactsRoot, "cli-plan.json");
    const preview = await runFreshGovernedRebuildCli([
      "--runtime-root", test.runtimeRoot, "--output", planFile,
    ], {}, { now });
    expect(preview).toMatchObject({ mode: "plan", written: true, legacyDisposition: "backup_only_no_legacy_import" });
    await chmod(planFile, 0o600);
    await expect(runFreshGovernedRebuildCli([
      "--apply", "--runtime-root", test.runtimeRoot, "--plan", planFile,
      "--expected-plan-hash", preview.planHash, "--backup-output", path.join(test.artifactsRoot, "cli.backup"),
      "--confirmation", "YES",
    ], { BUILDSIM_BACKUP_PASSWORD: password }, { now })).rejects.toThrow(/confirmation is invalid/);
    expect((await test.coordinator.readState()).runtimeGeneration).toBe(1);
  });

  it("does not invalidate a reviewed source graph merely because wall time advances", async () => {
    const test = await fixture();
    let tick = 0;
    const advancingNow = () => new Date(Date.parse("2026-08-31T11:00:00.000Z") + tick++ * 1_000).toISOString();
    const coordinator = new RuntimeCoordinator({ root: test.runtimeRoot, now: advancingNow });
    const plan = await createFreshGovernedRebuildPlan({ coordinator, now: advancingNow });
    await expect(applyFreshGovernedRebuildPlan({
      coordinator,
      plan,
      expectedPlanHash: plan.contentHash,
      backupOutput: path.join(test.artifactsRoot, "advancing-clock.backup"),
      password,
      confirmation: FRESH_GOVERNED_REBUILD_CONFIRMATION,
      now: advancingNow,
    })).resolves.toMatchObject({ runtimeGeneration: 2, legacyImported: false });
  });
});
