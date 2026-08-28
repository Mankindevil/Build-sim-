import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildConfigDocument } from "../src/config/types";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { FilePlanRepository } from "../src/plans/file-repository";
import { hashPlanConfig, sha256Hex } from "../src/plans/canonical";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";
import { configV3Hash } from "../src/topology/hash";
import { validatePlanConfigMigrationRuntime, validatePlanRuntime, validatePlanVersionRuntime } from "../src/plans/canonical-runtime.mjs";
import { loadBundledCatalog } from "../src/sku/catalog";

const roots: string[] = [];
let sequence = 0;

async function rootFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-plan-v3-"));
  roots.push(root);
  return root;
}

function ids(prefix: "plan" | "version"): string {
  sequence += 1;
  return `${prefix}-${String(sequence).padStart(8, "0")}`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  sequence = 0;
});

describe("U2 Plan V3 persistence", () => {
  it("keeps flag-off V2 persistence and legacy version hashes byte-compatible", async () => {
    const root = await rootFixture();
    const repository = new FilePlanRepository({ root, id: ids, topologyV3Enabled: false, now: () => "2026-08-27T13:00:00.000Z" });
    const plan = await repository.create({ name: "Legacy", config: createDefaultN6Config("draft", "2026-08-27T13:00:00.000Z") });
    const expectedHash = await sha256Hex(plan.draft.config);
    const version = await repository.saveVersion(plan.id, { expectedRevision: 0, expectedConfigHash: expectedHash, reason: "initial" });
    const versionFile = path.join(root, plan.id, "versions", `${version.id}.json`);
    const originalBytes = await readFile(versionFile);

    expect(version.configHash).toBe(expectedHash);
    expect(await hashPlanConfig(version.config)).toBe(expectedHash);
    await expect(new FilePlanRepository({ root, topologyV3Enabled: false }).listVersions(plan.id)).resolves.toHaveLength(1);
    expect(await readFile(versionFile)).toEqual(originalBytes);
  });

  it("uses the BuildConfig V3 domain hash for draft CAS, versions and restart verification", async () => {
    const root = await rootFixture();
    const config = createEmptyBuildConfigV3("draft", "V3", "2026-08-27T13:05:00.000Z");
    const disabled = new FilePlanRepository<BuildConfigDocument>({ root, id: ids, topologyV3Enabled: false, now: () => "2026-08-27T13:05:00.000Z" });
    await expect(disabled.create({ name: "V3 disabled", config })).rejects.toThrow(/BUILD_SIM_TOPOLOGY_V3_ENABLED/);

    const repository = new FilePlanRepository<BuildConfigDocument>({ root, id: ids, topologyV3Enabled: true, now: () => "2026-08-27T13:05:00.000Z" });
    const plan = await repository.create({ name: "V3", config });
    const expectedHash = await configV3Hash(plan.draft.config as BuildConfigV3);
    expect(await hashPlanConfig(plan.draft.config)).toBe(expectedHash);
    expect(expectedHash).not.toBe(await sha256Hex(plan.draft.config));
    const version = await repository.saveVersion(plan.id, { expectedRevision: 0, expectedConfigHash: expectedHash, reason: "initial" });
    expect(version.configHash).toBe(expectedHash);
    await expect(new FilePlanRepository<BuildConfigDocument>({ root, topologyV3Enabled: true }).listVersions(plan.id))
      .resolves.toMatchObject([{ configHash: expectedHash, config: { schemaVersion: "3.0.0" } }]);
  });

  it("migrates on first edit with an immutable V2 source version and explicit read-only fallback", async () => {
    const root = await rootFixture();
    const repository = new FilePlanRepository<BuildConfigDocument>({ root, id: ids, topologyV3Enabled: true, now: () => "2026-08-27T13:10:00.000Z" });
    const created = await repository.create({ name: "Migrate", config: createDefaultN6Config("draft", "2026-08-27T13:09:00.000Z") });
    const editedV2 = structuredClone(created.draft.config);
    if (editedV2.schemaVersion !== "2.0.0") throw new Error("fixture must begin as V2");
    editedV2.selection.diskCount = 2;
    const edited = await repository.updateDraft(created.id, { expectedRevision: 0, config: editedV2 });
    expect(edited.draft.config.schemaVersion).toBe("2.0.0");
    const migrated = await repository.migrateDraftToV3(created.id, { expectedRevision: edited.draftRevision });

    expect(migrated.draft.config.schemaVersion).toBe("3.0.0");
    expect(migrated.draft.configMigration).toMatchObject({
      schemaVersion: "plan-config-migration-v1",
      sourceSchemaVersion: "2.0.0",
      targetSchemaVersion: "3.0.0",
      sourceVersionId: expect.stringMatching(/^version-/),
      rollbackRef: { schemaVersion: "build-config-v2-rollback-ref-v1" },
      diff: expect.any(Array),
      warnings: expect.any(Array),
    });
    const sourceVersionId = migrated.draft.configMigration!.sourceVersionId;
    const sourceFile = path.join(root, created.id, "versions", `${sourceVersionId}.json`);
    const sourceBytesBefore = await readFile(sourceFile);
    const sourceVersion = (await repository.listVersions(created.id)).find((version) => version.id === sourceVersionId)!;
    const catalog = loadBundledCatalog();
    expect(sourceVersion).toMatchObject({ reason: "migration-source", config: { schemaVersion: "2.0.0", selection: { diskCount: 2 } } });
    expect(sourceVersion.configHash).toBe(await sha256Hex(sourceVersion.config));
    expect(validatePlanVersionRuntime(sourceVersion)).toEqual([]);
    expect(validatePlanConfigMigrationRuntime(migrated.draft.configMigration, { planId: migrated.id, config: migrated.draft.config, sourceVersion, catalog })).toEqual([]);
    expect(validatePlanRuntime(migrated, { topologyV3Enabled: true, sourceVersion, catalog })).toEqual([]);
    expect(validatePlanConfigMigrationRuntime({ ...migrated.draft.configMigration, sourceConfigHash: "0".repeat(64) }, { planId: migrated.id, config: migrated.draft.config, sourceVersion, catalog }))
      .toContain("config migration source version closure invalid");
    expect(validatePlanConfigMigrationRuntime({ ...migrated.draft.configMigration, diff: [{ hacked: true }], warnings: [42] }, { planId: migrated.id, config: migrated.draft.config, sourceVersion, catalog }))
      .toContain("config migration record invalid");
    const forgedAudit = structuredClone(migrated.draft.configMigration!);
    forgedAudit.diff[0] = { ...forgedAudit.diff[0]!, before: "forged but structurally valid" };
    expect(validatePlanConfigMigrationRuntime(forgedAudit, { planId: migrated.id, config: migrated.draft.config, sourceVersion, catalog }))
      .toContain("config migration audit does not match immutable source");
    const forgedBinding = structuredClone(migrated.draft.configMigration!);
    forgedBinding.catalogBinding.cooler.type = forgedBinding.catalogBinding.cooler.type === "aio" ? "air" : "aio";
    expect(validatePlanConfigMigrationRuntime(forgedBinding, { planId: migrated.id, config: migrated.draft.config, sourceVersion, catalog }))
      .toContain("config migration record invalid");

    const v3Hash = await hashPlanConfig(migrated.draft.config);
    await repository.saveVersion(created.id, { expectedRevision: migrated.draftRevision, expectedConfigHash: v3Hash, reason: "manual-save" });
    expect(await readFile(sourceFile)).toEqual(sourceBytesBefore);

    await expect(new FilePlanRepository<BuildConfigDocument>({ root, topologyV3Enabled: false }).get(created.id))
      .rejects.toThrow(/BUILD_SIM_TOPOLOGY_V3_ENABLED/);
    const fallback = new FilePlanRepository<BuildConfigDocument>({ root, topologyV3Enabled: false, v3ReadFallback: "migration_source" });
    await expect(fallback.get(created.id)).resolves.toMatchObject({
      draft: { config: { schemaVersion: "2.0.0", selection: { diskCount: 2 } }, configAccess: { mode: "v2_fallback", sourceVersionId } },
    });
    await expect(fallback.updateDraft(created.id, { expectedRevision: migrated.draftRevision, config: sourceVersion.config }))
      .rejects.toThrow(/read-only fallback/);
    const planFile = path.join(root, created.id, "plan.json");
    expect(await readFile(planFile, "utf8")).toContain('"schemaVersion": "3.0.0"');
    const envelope = JSON.parse(await readFile(planFile, "utf8"));
    envelope.payload.draft.configMigration.diff[0].before = "forged with a valid envelope checksum";
    envelope.checksum = await sha256Hex(envelope.payload);
    await writeFile(planFile, `${JSON.stringify(envelope, null, 2)}\n`);
    await expect(new FilePlanRepository<BuildConfigDocument>({ root, topologyV3Enabled: true }).get(created.id))
      .rejects.toThrow(/migration source\/hash\/rollback closure is invalid/);
  });

  it("reuses an exact immutable V2 base version as the migration source", async () => {
    const root = await rootFixture();
    const repository = new FilePlanRepository<BuildConfigDocument>({ root, id: ids, topologyV3Enabled: true, now: () => "2026-08-27T13:15:00.000Z" });
    const created = await repository.create({ name: "Reuse source", config: createDefaultN6Config("draft", "2026-08-27T13:15:00.000Z") });
    const source = await repository.saveVersion(created.id, {
      expectedRevision: created.draftRevision,
      expectedConfigHash: await hashPlanConfig(created.draft.config),
      reason: "initial",
    });
    const migrated = await repository.migrateDraftToV3(created.id, { expectedRevision: created.draftRevision });

    expect(migrated.draft.configMigration?.sourceVersionId).toBe(source.id);
    expect(migrated.activeVersionId).toBe(source.id);
    expect(await repository.listVersions(created.id)).toHaveLength(1);
  });

  it("keeps migration replay closed over its immutable catalog input after the active catalog changes", async () => {
    const root = await rootFixture();
    const catalogA = structuredClone(loadBundledCatalog());
    const sourceConfig = createDefaultN6Config("draft", "2026-08-27T13:16:00.000Z");
    const cooler = structuredClone(catalogA.skus.find((sku) => sku.id === sourceConfig.selection.coolerId)!);
    cooler.id = "cooler.catalog-a-only";
    cooler.attrs = { ...cooler.attrs, type: "down-draft" };
    catalogA.skus.push(cooler);
    sourceConfig.selection.coolerId = cooler.id;
    const repositoryA = new FilePlanRepository<BuildConfigDocument>({
      root, id: ids, topologyV3Enabled: true, now: () => "2026-08-27T13:16:00.000Z", getCatalog: () => catalogA,
    });
    const created = await repositoryA.create({ name: "Catalog-closed migration", config: sourceConfig });
    const migrated = await repositoryA.migrateDraftToV3(created.id, { expectedRevision: created.draftRevision });
    expect((migrated.draft.config as BuildConfigV3).components).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "cpu_cooler", role: "cpu_cooler", identity: expect.objectContaining({ skuId: cooler.id }) }),
    ]));
    const migratedVersion = await repositoryA.saveVersion(created.id, {
      expectedRevision: migrated.draftRevision,
      expectedConfigHash: await hashPlanConfig(migrated.draft.config),
      reason: "manual-save",
    });

    const immutableAudit = structuredClone(migrated.draft.configMigration!);
    const repositoryB = new FilePlanRepository<BuildConfigDocument>({
      root, topologyV3Enabled: true, getCatalog: loadBundledCatalog,
    });
    const reloaded = await repositoryB.get(created.id);
    expect(reloaded.draft.configMigration).toEqual(immutableAudit);
    const reloadedVersions = await repositoryB.listVersions(created.id);
    expect(reloadedVersions.find((version) => version.id === migratedVersion.id)?.config).toEqual(migrated.draft.config);
    const sourceVersion = reloadedVersions.find((version) => version.id === immutableAudit.sourceVersionId)!;
    expect(validatePlanConfigMigrationRuntime(immutableAudit, {
      planId: reloaded.id, config: reloaded.draft.config, sourceVersion, catalog: loadBundledCatalog(),
    })).toEqual([]);
  });

  it("restores an immutable V3 version as a new draft without rewriting history", async () => {
    const root = await rootFixture();
    const repository = new FilePlanRepository<BuildConfigDocument>({ root, id: ids, topologyV3Enabled: true, now: () => "2026-08-27T13:20:00.000Z" });
    const created = await repository.create({ name: "Rollback V3", config: createEmptyBuildConfigV3("draft", "Rollback V3", "2026-08-27T13:20:00.000Z") });
    const version1 = await repository.saveVersion(created.id, { expectedRevision: 0, expectedConfigHash: await hashPlanConfig(created.draft.config), reason: "initial" });
    const changed = structuredClone(created.draft.config) as BuildConfigV3;
    changed.components.push({
      instanceId: "gpu-instance-1", kind: "gpu", role: "discrete_gpu", state: "planned",
      identity: { status: "unresolved", userText: "GPU to decide" }, source: "user",
    });
    const updated = await repository.updateDraft(created.id, { expectedRevision: 0, config: changed });
    await repository.saveVersion(created.id, { expectedRevision: 1, expectedConfigHash: await hashPlanConfig(updated.draft.config), reason: "manual-save" });
    const restored = await repository.updateDraft(created.id, { expectedRevision: 1, config: structuredClone(version1.config) });
    expect((restored.draft.config as BuildConfigV3).components).toEqual([]);
    const versions = await repository.listVersions(created.id);
    expect(versions[0]).toEqual(version1);
    expect((versions[1]!.config as BuildConfigV3).components).toHaveLength(1);
  });

  it("fails closed on cross-plan version ownership and broken parent lineage", async () => {
    const root = await rootFixture();
    const repository = new FilePlanRepository({ root, id: ids, topologyV3Enabled: false, now: () => "2026-08-27T13:25:00.000Z" });
    const first = await repository.create({ name: "Owner A", config: createDefaultN6Config("draft-a", "2026-08-27T13:25:00.000Z") });
    const firstVersion = await repository.saveVersion(first.id, { expectedRevision: 0, expectedConfigHash: await hashPlanConfig(first.draft.config), reason: "initial" });
    const second = await repository.create({ name: "Owner B", config: createDefaultN6Config("draft-b", "2026-08-27T13:25:00.000Z") });
    const secondVersion = await repository.saveVersion(second.id, { expectedRevision: 0, expectedConfigHash: await hashPlanConfig(second.draft.config), reason: "initial" });

    const foreignVersionFile = path.join(root, second.id, "versions", `${secondVersion.id}.json`);
    const injectedVersionFile = path.join(root, first.id, "versions", `${secondVersion.id}.json`);
    await writeFile(injectedVersionFile, await readFile(foreignVersionFile));
    const firstPlanFile = path.join(root, first.id, "plan.json");
    const planEnvelope = JSON.parse(await readFile(firstPlanFile, "utf8"));
    planEnvelope.payload.activeVersionId = secondVersion.id;
    planEnvelope.payload.draft.baseVersionId = secondVersion.id;
    planEnvelope.checksum = await sha256Hex(planEnvelope.payload);
    await writeFile(firstPlanFile, `${JSON.stringify(planEnvelope, null, 2)}\n`);
    const restarted = new FilePlanRepository({ root, topologyV3Enabled: false });
    await expect(restarted.get(first.id)).rejects.toThrow(/owner\/path identity mismatch/);
    await expect(restarted.listVersions(first.id)).rejects.toThrow(/owner\/path identity mismatch/);

    await rm(injectedVersionFile);
    planEnvelope.payload.activeVersionId = firstVersion.id;
    planEnvelope.payload.draft.baseVersionId = secondVersion.id;
    planEnvelope.checksum = await sha256Hex(planEnvelope.payload);
    await writeFile(firstPlanFile, `${JSON.stringify(planEnvelope, null, 2)}\n`);
    await expect(restarted.get(first.id)).rejects.toThrow(/draft\.baseVersionId does not resolve/);
    planEnvelope.payload.activeVersionId = secondVersion.id;
    planEnvelope.payload.draft.baseVersionId = firstVersion.id;
    planEnvelope.checksum = await sha256Hex(planEnvelope.payload);
    await writeFile(firstPlanFile, `${JSON.stringify(planEnvelope, null, 2)}\n`);
    await expect(restarted.get(first.id)).rejects.toThrow(/activeVersionId does not resolve/);

    planEnvelope.payload.activeVersionId = firstVersion.id;
    planEnvelope.payload.draft.baseVersionId = firstVersion.id;
    planEnvelope.checksum = await sha256Hex(planEnvelope.payload);
    await writeFile(firstPlanFile, `${JSON.stringify(planEnvelope, null, 2)}\n`);
    const ownVersionFile = path.join(root, first.id, "versions", `${firstVersion.id}.json`);
    const versionEnvelope = JSON.parse(await readFile(ownVersionFile, "utf8"));
    versionEnvelope.payload.parentVersionId = secondVersion.id;
    versionEnvelope.checksum = await sha256Hex(versionEnvelope.payload);
    await writeFile(ownVersionFile, `${JSON.stringify(versionEnvelope, null, 2)}\n`);
    await expect(restarted.get(first.id)).rejects.toThrow(/parent does not resolve/);
    versionEnvelope.payload.parentVersionId = firstVersion.id;
    versionEnvelope.checksum = await sha256Hex(versionEnvelope.payload);
    await writeFile(ownVersionFile, `${JSON.stringify(versionEnvelope, null, 2)}\n`);
    await expect(restarted.get(first.id)).rejects.toThrow(/lineage cannot reference itself/);
  });
});
