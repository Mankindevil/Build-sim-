import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { ProductionWorkspaceOperations } from "../src/server/operations-production";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U11 production local operations projection", () => {
  it("creates, verifies, persists, lists, and diagnoses one local full backup without returning a filesystem path", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "buildsim-workspace-operations-"));
    roots.push(runtimeRoot);
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot });
    await coordinator.initialize("workspace-operations-test");
    const operations = new ProductionWorkspaceOperations({
      coordinator, runtimeRoot, now: () => "2026-08-30T00:00:00.000Z",
    });

    const created = await operations.createFullBackup({ password: "local-backup-passphrase", confirmation: true });
    expect(created).toMatchObject({ schemaVersion: "workspace-backup-summary-v1", result: "pass", runtimeGeneration: 1 });
    expect(created).not.toHaveProperty("outputFile");
    await expect(operations.listBackups()).resolves.toEqual([created]);
    const doctor = await operations.doctor();
    expect(doctor.checks.find(({ checkId }) => checkId === "backup.recent_verified")?.status).toBe("pass");
    const diagnostic = await operations.createDiagnostic({ confirmation: true });
    expect(diagnostic).toMatchObject({ schemaVersion: "workspace-diagnostic-summary-v1", runtimeGeneration: 1, downloadUrl: expect.stringContaining(diagnostic.diagnosticId) });
    expect(diagnostic).not.toHaveProperty("outputFile");
    const download = await operations.downloadDiagnostic(diagnostic.diagnosticId);
    expect(download.fileName).toMatch(/\.buildsim-diagnostic\.json$/);
    expect(JSON.parse(download.bytes.toString("utf8"))).toMatchObject({ bundleHash: diagnostic.bundleHash, privacy: { redacted: true } });
  }, 30_000);

  it("previews a permission repair only after a verified backup, then requires an exact second confirmation", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "buildsim-workspace-repair-"));
    roots.push(runtimeRoot);
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now: () => "2026-08-30T00:00:00.000Z" });
    await coordinator.initialize("workspace-repair-test");
    await chmod(runtimeRoot, 0o755);
    const operations = new ProductionWorkspaceOperations({
      coordinator, runtimeRoot, now: () => "2026-08-30T00:00:00.000Z",
    });
    const before = await coordinator.readState();
    const inspectionResponse = await handleWorkspaceRoute("POST", "/api/workspace/doctor/repairs/inspect", {
      actionIds: ["restrict-runtime-permissions"],
    }, {} as never, { operations, doctorEnabled: true, backupRestoreEnabled: false });
    expect(inspectionResponse).toMatchObject({
      status: 200,
      payload: {
        schemaVersion: "workspace-repair-inspection-v1",
        inspectionStatus: "ready",
        actionIds: ["restrict-runtime-permissions"],
        affectedDirectoryCount: expect.any(Number),
        affectedFileCount: expect.any(Number),
        writesPerformed: false,
        requiresVerifiedBackup: true,
        requiresExplicitPreparationConfirmation: true,
        requiresSecondConfirmation: true,
      },
    });
    expect((inspectionResponse.payload as { affectedDirectoryCount: number }).affectedDirectoryCount).toBeGreaterThan(0);
    expect(await coordinator.readState()).toEqual(before);
    await expect(stat(path.join(runtimeRoot, "exports"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(operations.inspectRepair({
      actionIds: ["restrict-runtime-permissions"], password: "must-not-be-accepted",
    })).rejects.toThrow(/fields are invalid/);

    const previewResponse = await handleWorkspaceRoute("POST", "/api/workspace/doctor/repairs/preview", {
      actionIds: ["restrict-runtime-permissions"], password: "doctor repair password", confirmation: true,
    }, {} as never, { operations, doctorEnabled: true, backupRestoreEnabled: true });
    expect(previewResponse.status).toBe(201);
    const preview = previewResponse.payload as Awaited<ReturnType<ProductionWorkspaceOperations["prepareRepair"]>>;
    expect(preview).toMatchObject({
      schemaVersion: "workspace-repair-preview-v1",
      actionIds: ["restrict-runtime-permissions"],
      requiresSecondConfirmation: true,
    });
    expect(await coordinator.readState()).toMatchObject({ activeRoot: before.activeRoot, runtimeGeneration: before.runtimeGeneration });
    expect(await operations.listBackups()).toContainEqual(expect.objectContaining({ backupId: preview.backupId, result: "pass" }));
    expect((await stat(runtimeRoot)).mode & 0o777).toBe(0o755);

    await expect(operations.applyRepair({
      repairPlanId: preview.repairPlanId,
      planHash: "0".repeat(64),
      password: "doctor repair password",
      confirmation: true,
    })).rejects.toThrow("changed after preview");
    expect((await stat(runtimeRoot)).mode & 0o777).toBe(0o755);

    const applyResponse = await handleWorkspaceRoute("POST", "/api/workspace/doctor/repairs/apply", {
      repairPlanId: preview.repairPlanId,
      planHash: preview.planHash,
      password: "doctor repair password",
      confirmation: true,
    }, {} as never, { operations, doctorEnabled: true, backupRestoreEnabled: true });
    expect(applyResponse).toMatchObject({ status: 200, payload: { applied: true, rolledBack: false } });
    expect((await stat(runtimeRoot)).mode & 0o777).toBe(0o700);
    await expect(operations.doctor()).resolves.toMatchObject({
      checks: expect.arrayContaining([expect.objectContaining({ checkId: "runtime.permissions", status: "pass" })]),
    });

    const replay = await operations.applyRepair({
      repairPlanId: preview.repairPlanId,
      planHash: preview.planHash,
      password: "doctor repair password",
      confirmation: true,
    });
    expect(replay).toMatchObject({ applied: false, idempotentReplay: true, rolledBack: false });
  }, 30_000);

  it("reports an unreadable ownership boundary without creating a backup or repair plan", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "buildsim-workspace-repair-unreadable-"));
    roots.push(runtimeRoot);
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now: () => "2026-08-30T00:00:00.000Z" });
    await coordinator.initialize("workspace-repair-unreadable-test");
    const before = await coordinator.readState();
    const unreadable = path.join(coordinator.activeRoot(before), "legacy-owned");
    await mkdir(unreadable, { recursive: true, mode: 0o700 });
    await chmod(unreadable, 0o000);
    try {
      const operations = new ProductionWorkspaceOperations({
        coordinator, runtimeRoot, now: () => "2026-08-30T00:00:00.000Z",
      });
      await expect(operations.inspectRepair({ actionIds: ["restrict-runtime-permissions"] })).resolves.toMatchObject({
        schemaVersion: "workspace-repair-inspection-v1",
        inspectionStatus: "blocked_unreadable",
        targetFileCount: null,
        targetDirectoryCount: null,
        affectedFileCount: null,
        affectedDirectoryCount: null,
        currentFileModes: [],
        currentDirectoryModes: [],
        writesPerformed: false,
      });
      expect(await coordinator.readState()).toEqual(before);
      await expect(stat(path.join(runtimeRoot, "exports"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(unreadable, 0o700);
    }
  });
});
