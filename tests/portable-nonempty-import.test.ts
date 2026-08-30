import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPortablePlanPackage, openPortablePlanPackage, planPortableImport } from "../src/portability";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Json } from "../src/runtime/fs.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

const roots: string[] = [];
const password = "portable fixture password";
const at = "2026-08-30T00:00:00.000Z";

async function runtime(prefix: string): Promise<{ root: string; coordinator: RuntimeCoordinator }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix)); roots.push(root);
  const coordinator = new RuntimeCoordinator({ root, now: () => at }); await coordinator.initialize("test");
  return { root, coordinator };
}

async function putPlan(coordinator: RuntimeCoordinator, planId: string, name: string): Promise<void> {
  const state = await coordinator.readState(); const config = createEmptyBuildConfigV3(planId, name, at);
  const plan = {
    schemaVersion: "1.0.0", id: planId, name, status: "active", createdAt: at, updatedAt: at,
    activeVersionId: null, draftRevision: 0,
    draft: { schemaVersion: "1.0.0", baseVersionId: null, config, evidenceBindings: [], dirty: true, updatedAt: at },
    metadata: {},
  };
  await atomicWriteJson(confined(coordinator.activeRoot(state), "plans", planId, "plan.json"), {
    schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(plan), payload: plan,
  });
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U12 non-empty portable plan import", () => {
  it("dry-runs, imports into an empty repository, and repeats as an exact no-op", async () => {
    const source = await runtime("buildsim-portable-source-"); await putPlan(source.coordinator, "plan-source", "Portable source");
    const packageFile = path.join(source.root, "source.buildsim");
    const created = await createPortablePlanPackage({
      coordinator: source.coordinator, outputFile: packageFile, password, planId: "plan-source", portableProfile: "slim", redacted: true, now: () => at,
    });
    expect(created.exactReplayReady).toBe(false);
    await expect(openPortablePlanPackage(packageFile, password)).resolves.toMatchObject({ exactReplayReady: false, payload: { sourcePlanId: "plan-source" } });

    const target = await runtime("buildsim-portable-target-");
    const preview = await planPortableImport({ coordinator: target.coordinator, inputFile: packageFile, password, mode: "dry_run" });
    expect(preview.plan).toMatchObject({ action: "copy_as_new_plan", resultMode: "reevaluate_with_current_runtime", conflicts: [] });
    const applied = await planPortableImport({ coordinator: target.coordinator, inputFile: packageFile, password, mode: "apply", expectedManifestHash: preview.plan.manifestHash });
    expect(applied.state?.runtimeGeneration).toBe(2);
    const imported = JSON.parse(await readFile(confined(target.coordinator.activeRoot(applied.state!), "plans", "plan-source", "plan.json"), "utf8"));
    expect(imported.payload).toMatchObject({ id: "plan-source", name: "Portable source" });

    const beforeRepeat = await target.coordinator.readState();
    const repeated = await planPortableImport({ coordinator: target.coordinator, inputFile: packageFile, password, mode: "apply" });
    expect(repeated.plan.action).toBe("no_op_same_hash");
    expect(await target.coordinator.readState()).toEqual(beforeRepeat);
  });

  it("never overwrites a different plan silently and can copy with an explicit ID remap", async () => {
    const source = await runtime("buildsim-portable-conflict-source-"); await putPlan(source.coordinator, "plan-source", "Incoming");
    const packageFile = path.join(source.root, "source.buildsim");
    await createPortablePlanPackage({ coordinator: source.coordinator, outputFile: packageFile, password, planId: "plan-source", portableProfile: "slim", now: () => at });

    const target = await runtime("buildsim-portable-conflict-target-"); await putPlan(target.coordinator, "plan-source", "Existing");
    const before = await target.coordinator.readState();
    const rejected = await planPortableImport({ coordinator: target.coordinator, inputFile: packageFile, password, mode: "dry_run" });
    expect(rejected.plan).toMatchObject({ action: "reject", conflicts: [{ existingId: "plan-source" }] });
    await expect(planPortableImport({ coordinator: target.coordinator, inputFile: packageFile, password, mode: "apply" })).rejects.toThrow("rejected import cannot be applied");
    expect(await target.coordinator.readState()).toEqual(before);

    const copyPreview = await planPortableImport({ coordinator: target.coordinator, inputFile: packageFile, password, mode: "dry_run", strategy: "copy_as_new_plan", newPlanId: "plan-imported" });
    expect(copyPreview.plan).toMatchObject({ action: "copy_as_new_plan", idRemap: { "plan-source": "plan-imported" }, resultMode: "reevaluate_with_current_runtime" });
    const copied = await planPortableImport({ coordinator: target.coordinator, inputFile: packageFile, password, mode: "apply", strategy: "copy_as_new_plan", newPlanId: "plan-imported", expectedManifestHash: copyPreview.plan.manifestHash });
    const state = await target.coordinator.readState();
    expect(copied).toMatchObject({ importedPlanId: "plan-imported", state: { runtimeGeneration: state.runtimeGeneration } });
    const existing = JSON.parse(await readFile(confined(target.coordinator.activeRoot(state), "plans", "plan-source", "plan.json"), "utf8"));
    const imported = JSON.parse(await readFile(confined(target.coordinator.activeRoot(state), "plans", "plan-imported", "plan.json"), "utf8"));
    expect(existing.payload.name).toBe("Existing");
    expect(imported.payload).toMatchObject({ id: "plan-imported", name: "Incoming", activeVersionId: null, draft: { config: { id: "plan-imported" } } });
  });

  it("keeps the active pointer unchanged when staged validation or the commit hook fails", async () => {
    const source = await runtime("buildsim-portable-failure-source-"); await putPlan(source.coordinator, "plan-source", "Incoming");
    const packageFile = path.join(source.root, "source.buildsim");
    await createPortablePlanPackage({ coordinator: source.coordinator, outputFile: packageFile, password, planId: "plan-source", portableProfile: "slim", now: () => at });
    const target = await runtime("buildsim-portable-failure-target-"); const before = await target.coordinator.readState();
    await expect(planPortableImport({
      coordinator: target.coordinator, inputFile: packageFile, password, mode: "apply",
      beforePointerSwitch: () => { throw new Error("injected portable failure"); },
    })).rejects.toThrow("injected portable failure");
    expect(await target.coordinator.readState()).toEqual(before);
  });
});
