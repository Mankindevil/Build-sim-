import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionWorkspacePortability } from "../src/server/portability-production";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Json } from "../src/runtime/fs.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import type { WorkspaceBackupSummary } from "../src/server/operations-production";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";

const roots: string[] = [];
const at = "2026-08-30T00:00:00.000Z";
const packagePassword = "production portable password";
const backupSummary: WorkspaceBackupSummary = {
  schemaVersion: "workspace-backup-summary-v1", backupId: "backup-before-replace", manifestHash: "b".repeat(64),
  createdAt: at, verifiedAt: at, runtimeGeneration: 1, entryCount: 1, result: "pass",
};

async function harness(prefix: string, planName?: string): Promise<{ root: string; coordinator: RuntimeCoordinator; service: ProductionWorkspacePortability; backup: ReturnType<typeof vi.fn> }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix)); roots.push(root);
  const coordinator = new RuntimeCoordinator({ root, now: () => at }); const state = await coordinator.initialize("test");
  if (planName) {
    const planId = "plan-portable"; const config = createEmptyBuildConfigV3(planId, planName, at);
    const plan = { schemaVersion: "1.0.0", id: planId, name: planName, status: "active", createdAt: at, updatedAt: at, activeVersionId: null, draftRevision: 0, draft: { schemaVersion: "1.0.0", baseVersionId: null, config, evidenceBindings: [], dirty: true, updatedAt: at }, metadata: {} };
    await atomicWriteJson(confined(coordinator.activeRoot(state), "plans", planId, "plan.json"), { schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(plan), payload: plan });
  }
  const backup = vi.fn(async () => backupSummary);
  return { root, coordinator, backup, service: new ProductionWorkspacePortability({ coordinator, runtimeRoot: root, operations: { createFullBackup: backup }, now: () => at }) };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U12 production portability composition", () => {
  it("creates opaque downloads, stages a server-owned upload, and imports through the production service", async () => {
    const source = await harness("buildsim-portability-production-source-", "Portable source");
    const exported = await source.service.createExport({ planId: "plan-portable", portableProfile: "slim", redacted: true, password: packagePassword, confirmation: true });
    expect(exported).toMatchObject({ planId: "plan-portable", resultMode: "reevaluate_with_current_runtime", downloadUrl: expect.stringContaining(exported.exportId) });
    const download = await source.service.download(exported.exportId); expect(download.bytes.length).toBeGreaterThan(100);
    const target = await harness("buildsim-portability-production-target-");
    const preview = await target.service.stageImport(download.bytes, { password: packagePassword, strategy: "reject" });
    expect(preview).toMatchObject({ sourcePlanId: "plan-portable", importPlan: { action: "copy_as_new_plan", conflicts: [] } });
    const result = await target.service.applyImport({ uploadId: preview.uploadId, password: packagePassword, expectedManifestHash: preview.manifestHash, strategy: "reject", confirmation: true });
    expect(result).toMatchObject({ action: "copy_as_new_plan", importedPlanId: "plan-portable", runtimeGeneration: 2 });
    expect(target.backup).not.toHaveBeenCalled();
  });

  it("requires and records a verified full backup before replacement", async () => {
    const source = await harness("buildsim-portability-replace-source-", "Incoming");
    const exported = await source.service.createExport({ planId: "plan-portable", portableProfile: "slim", redacted: true, password: packagePassword, confirmation: true });
    const packageBytes = (await source.service.download(exported.exportId)).bytes;
    const target = await harness("buildsim-portability-replace-target-", "Existing");
    const preview = await target.service.stageImport(packageBytes, { password: packagePassword, strategy: "replace_after_backup" });
    expect(preview.importPlan).toMatchObject({ action: "replace_after_backup", conflicts: [{ existingId: "plan-portable" }] });
    const result = await target.service.applyImport({ uploadId: preview.uploadId, password: packagePassword, expectedManifestHash: preview.manifestHash, strategy: "replace_after_backup", confirmation: true, backupPassword: "replacement backup password" });
    expect(target.backup).toHaveBeenCalledWith({ password: "replacement backup password", confirmation: true });
    expect(result).toMatchObject({ action: "replace_after_backup", rollbackRef: `backup:${backupSummary.manifestHash}` });
  });

  it("publishes only gated JSON route actions", async () => {
    const portability = { createExport: vi.fn(async () => ({ ok: "export" })), applyImport: vi.fn(async () => ({ ok: "apply" })) };
    await expect(handleWorkspaceRoute("POST", "/api/workspace/portability/exports", {}, {} as never, { portability: portability as never, portabilityEnabled: false }))
      .resolves.toEqual({ status: 404, payload: { error: "portability_disabled" } });
    await expect(handleWorkspaceRoute("POST", "/api/workspace/portability/exports", {}, {} as never, { portability: portability as never, portabilityEnabled: true }))
      .resolves.toEqual({ status: 201, payload: { ok: "export" } });
    await expect(handleWorkspaceRoute("POST", "/api/workspace/portability/imports/apply", {}, {} as never, { portability: portability as never, portabilityEnabled: true }))
      .resolves.toEqual({ status: 200, payload: { ok: "apply" } });
  });
});
