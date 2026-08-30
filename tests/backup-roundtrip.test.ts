import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreBackup, verifyBackup } from "../src/backup/runtime.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Json } from "../src/runtime/fs.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

const roots: string[] = [];
const now = "2026-08-30T00:00:00.000Z";

async function writePlan(coordinator: RuntimeCoordinator): Promise<Buffer> {
  const state = await coordinator.readState();
  const config = createEmptyBuildConfigV3("plan-backup-roundtrip", "Backup roundtrip", now);
  const plan = {
    schemaVersion: "1.0.0", id: config.id, name: config.name, status: "active",
    createdAt: now, updatedAt: now, activeVersionId: null, draftRevision: 0,
    draft: { schemaVersion: "1.0.0", baseVersionId: null, config, evidenceBindings: [], dirty: true, updatedAt: now },
    metadata: { tags: ["roundtrip-marker"] },
  };
  const envelope = { schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(plan), payload: plan };
  await atomicWriteJson(confined(coordinator.activeRoot(state), "plans", config.id, "plan.json"), envelope);
  return Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U12 full backup roundtrip", () => {
  it("restores an authenticated backup into an empty runtime with exact plan bytes and closure", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "buildsim-backup-roundtrip-source-"));
    const targetRoot = await mkdtemp(path.join(tmpdir(), "buildsim-backup-roundtrip-target-"));
    roots.push(sourceRoot, targetRoot);
    const source = new RuntimeCoordinator({ root: sourceRoot, now: () => now });
    await source.initialize("test");
    const expectedPlan = await writePlan(source);
    const outputFile = path.join(sourceRoot, "roundtrip.buildsim-backup");
    const password = "roundtrip backup password";

    const created = await createBackup({ coordinator: source, outputFile, password, now: () => now });
    const verified = await verifyBackup({ inputFile: outputFile, password, now: () => now });
    expect(verified).toMatchObject({ valid: true, report: { result: "pass" } });
    expect(verified.manifest.manifestHash).toBe(created.manifest.manifestHash);

    const target = new RuntimeCoordinator({ root: targetRoot, now: () => now });
    const restored = await restoreBackup({ coordinator: target, inputFile: outputFile, password, now: () => now });
    const restoredPlan = await readFile(confined(target.activeRoot(restored.state), "plans", "plan-backup-roundtrip", "plan.json"));
    expect(restoredPlan).toEqual(expectedPlan);
    expect(restored.verification).toMatchObject({ result: "pass", manifestHash: created.manifest.manifestHash });
    expect(restored.state.runtimeGeneration).toBe(created.manifest.runtimeGeneration + 1);

    const postRestore = path.join(targetRoot, "post-restore.buildsim-backup");
    await createBackup({ coordinator: target, outputFile: postRestore, password, now: () => now });
    await expect(verifyBackup({ inputFile: postRestore, password, now: () => now }))
      .resolves.toMatchObject({ valid: true, report: { result: "pass" } });
  });
});
