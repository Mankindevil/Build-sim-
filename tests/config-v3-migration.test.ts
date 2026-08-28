import { describe, expect, it } from "vitest";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import { readConfigDocument, topologyV3Enabled } from "../src/config/io";
import { parseConfig, serializeConfig, type BuildConfig, type BuildConfigDocument } from "../src/config/types";
import { validateConfig } from "../src/config/validate";
import { sha256Hex } from "../src/hash";
import { migrateBuildConfigV2ToV3 } from "../src/plans/migration";
import { createEmptyBuildConfig } from "../src/plans/default-plan";
import { loadBundledCatalog } from "../src/sku/catalog";

function sourceConfig(): BuildConfig {
  const config = structuredClone(baseline) as BuildConfig;
  config.selection.diskCount = 2;
  config.selection.nvmeCount = 2;
  config.selection.hbaMode = "always";
  config.selection.hbaSkuId = "hba.lsi-9300-8i-it";
  config.selection.fanGroups = [{ mountId: "front", sizeMm: 140, count: 2 }];
  config.bom = [
    { skuId: config.caseId, qty: 1, bucket: "owned" },
    { skuId: config.selection.memoryId, qty: 1, bucket: "buy_now" },
    { skuId: config.selection.diskSkuId!, qty: 2, bucket: "upgrade_later" },
    { skuId: config.selection.hbaSkuId, qty: 1, bucket: "owned" },
    { skuId: "cable.fixture", qty: 4, bucket: "optional" },
  ];
  return config;
}

async function sourceArtifact(source: BuildConfig): Promise<{ sourceBytes: string; sourceHash: string; catalog: ReturnType<typeof loadBundledCatalog> }> {
  const sourceBytes = serializeConfig(source);
  return { sourceBytes, sourceHash: await sha256Hex(sourceBytes), catalog: loadBundledCatalog() };
}

describe("U2 deterministic BuildConfig V2 to V3 migration", () => {
  it("binds a genuinely blank V2 cooler selection without inventing catalog identity", async () => {
    const source = createEmptyBuildConfig("plan-empty-migration", "2026-08-27T00:00:00.000Z");
    const artifact = await sourceArtifact(source);
    const result = await migrateBuildConfigV2ToV3(source, artifact);
    expect(result.catalogBinding.cooler).toEqual({ skuId: "", catalogSkuId: null, category: null, type: null });
    expect(result.config.components.some((component) => component.kind === "cpu_cooler" || component.kind === "aio")).toBe(false);
    await expect(migrateBuildConfigV2ToV3(source, {
      sourceBytes: artifact.sourceBytes,
      sourceHash: artifact.sourceHash,
      catalogBinding: result.catalogBinding,
    })).resolves.toEqual(result);
  });

  it("converts only explicit component facts and preserves the exact source artifact", async () => {
    const source = sourceConfig();
    const { sourceBytes, sourceHash } = await sourceArtifact(source);
    const frozenBefore = structuredClone(source);
    const result = await migrateBuildConfigV2ToV3(source, { sourceBytes, sourceHash, catalog: loadBundledCatalog() });

    expect(source).toEqual(frozenBefore);
    expect(result.source).toEqual({ schemaVersion: "2.0.0", sourceHash, sourceBytes });
    expect(result.rollbackRef).toEqual({
      schemaVersion: "build-config-v2-rollback-ref-v1",
      configId: source.id,
      sourceSchemaVersion: "2.0.0",
      sourceHash,
      sourceByteLength: new TextEncoder().encode(sourceBytes).byteLength,
    });
    expect(result.config).toMatchObject({
      schemaVersion: "3.0.0", id: source.id, name: source.name, updatedAt: "2026-08-21T00:00:00.000Z",
      intent: null, requirementSpec: null, system: null,
      placements: [], connections: [], logicalLayouts: [], firmwareTargets: [],
    });

    const resolvedSkuIds = result.config.components
      .filter((component) => component.identity.status === "resolved")
      .map((component) => component.identity.status === "resolved" ? component.identity.skuId : "");
    expect(resolvedSkuIds).toEqual(expect.arrayContaining([
      source.caseId, source.boardId, source.cpuId, source.selection.psuId,
      source.selection.coolerId, source.selection.memoryId, source.selection.diskSkuId!, source.selection.diskSkuId!,
    ]));
    expect(resolvedSkuIds).not.toContain(source.selection.hbaSkuId);
    expect(resolvedSkuIds).not.toContain("storage.samsung-980-pro-2tb");
    expect(result.config.components.filter((component) => component.kind === "gpu")).toHaveLength(0);
    expect(result.config.roleDecisions).toEqual([{
      roleDecisionId: expect.stringMatching(/^migrd-[a-f0-9]{64}$/), role: "discrete_gpu", decision: "not_needed", source: "migration", confirmedAt: "2026-08-21T00:00:00.000Z",
    }]);
    expect(result.config.components.filter((component) => component.kind === "storage_drive" && component.identity.status === "unresolved"))
      .toHaveLength(2);
    expect(result.config.components.filter((component) => component.kind === "case_fan" && component.identity.status === "unresolved"))
      .toHaveLength(2);
    expect(result.config.components.find((component) => component.identity.status === "resolved" && component.identity.skuId === source.caseId)?.state).toBe("ordered");
    expect(result.config.components.find((component) => component.identity.status === "resolved" && component.identity.skuId === source.selection.memoryId)?.state).toBe("planned");
    expect(result.config.notes).toContain("[migration] Legacy owned BOM entries were mapped to ordered; receipt, possession, installation, and hardware health were not inferred.");
    expect(result.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "nvme_identity_unresolved", "fan_identity_unresolved", "legacy_hba_not_migrated", "legacy_bom_item_not_migrated", "owned_mapped_to_ordered",
    ]));
    expect(result.diff.some((entry) => entry.sourcePath === "/selection/nvmeCount" && entry.targetPath === "/components")).toBe(true);
  });

  it("is deterministic and never invents workloads, budget, system, firmware, topology edges, or storage layouts", async () => {
    const source = sourceConfig();
    const options = await sourceArtifact(source);
    const first = await migrateBuildConfigV2ToV3(source, options);
    const second = await migrateBuildConfigV2ToV3(structuredClone(source), {
      sourceBytes: options.sourceBytes,
      sourceHash: options.sourceHash,
      catalogBinding: first.catalogBinding,
    });
    expect(second).toEqual(first);
    const forgedBinding = structuredClone(first.catalogBinding);
    forgedBinding.cooler.type = forgedBinding.cooler.type === "aio" ? "air" : "aio";
    await expect(migrateBuildConfigV2ToV3(source, {
      sourceBytes: options.sourceBytes,
      sourceHash: options.sourceHash,
      catalogBinding: forgedBinding,
    })).rejects.toThrow(/catalog binding is invalid/);
    expect(first.config.intent).toBeNull();
    expect(first.config.requirementSpec).toBeNull();
    expect(first.config.system).toBeNull();
    expect(first.config.connections).toEqual([]);
    expect(first.config.logicalLayouts).toEqual([]);
    expect(first.config.firmwareTargets).toEqual([]);
    expect(JSON.stringify(first.config)).not.toMatch(/(?:workload|budget|bios|observation|tool|cable|pool|vdev)/i);
  });

  it("derives cooler kind from governed catalog semantics and omits an unprovable kind", async () => {
    const airSource = sourceConfig();
    const air = await migrateBuildConfigV2ToV3(airSource, await sourceArtifact(airSource));
    expect(air.config.components.find((component) => component.identity.status === "resolved"
      && component.identity.skuId === airSource.selection.coolerId)).toMatchObject({ kind: "cpu_cooler", role: "cpu_cooler" });

    const aioSource = sourceConfig();
    aioSource.selection.coolerId = "cooler.aio-240-front";
    const aio = await migrateBuildConfigV2ToV3(aioSource, await sourceArtifact(aioSource));
    expect(aio.config.components.find((component) => component.identity.status === "resolved"
      && component.identity.skuId === aioSource.selection.coolerId)).toMatchObject({ kind: "aio", role: "cpu_cooler" });
    expect(validateConfig(aio.config, loadBundledCatalog(), { topologyV3Enabled: true }).filter((issue) => issue.verdict === "bad")).toEqual([]);

    const unknownCatalog = structuredClone(loadBundledCatalog());
    const unknownCooler = unknownCatalog.skus.find((sku) => sku.id === airSource.selection.coolerId)!;
    unknownCooler.attrs = { ...unknownCooler.attrs, type: "catalog-kind-not-governed" };
    const omitted = await migrateBuildConfigV2ToV3(airSource, { ...await sourceArtifact(airSource), catalog: unknownCatalog });
    expect(omitted.config.components.some((component) => component.identity.status === "resolved"
      && component.identity.skuId === airSource.selection.coolerId)).toBe(false);
    expect(omitted.warnings).toContainEqual(expect.objectContaining({ code: "cooler_kind_unresolved", sourcePath: "/selection/coolerId" }));
    expect(omitted.diff).toContainEqual(expect.objectContaining({ sourcePath: "/selection/coolerId", operation: "omitted", targetPath: null }));
  });

  it("keeps the V2 reader when the topology flag is off and uses an explicit V2 fallback for V3 bytes", async () => {
    const source = sourceConfig();
    const { sourceBytes, sourceHash } = await sourceArtifact(source);
    const migrated = await migrateBuildConfigV2ToV3(source, { sourceBytes, sourceHash, catalog: loadBundledCatalog() });
    const v3Bytes = serializeConfig(migrated.config);

    expect(parseConfig(sourceBytes, { topologyV3Enabled: false })).toEqual(source);
    expect(() => parseConfig(v3Bytes)).toThrow(/BUILD_SIM_TOPOLOGY_V3_ENABLED/);
    expect(parseConfig(v3Bytes, { topologyV3Enabled: false, v2FallbackRaw: sourceBytes })).toEqual(source);
    expect(() => parseConfig(v3Bytes, {
      topologyV3Enabled: false,
      v2FallbackRaw: serializeConfig({ ...source, id: "unrelated-plan", name: "Unrelated fallback" }),
    })).toThrow(/fallback identity does not match/);
    const parsed = parseConfig(v3Bytes, { topologyV3Enabled: true }) as BuildConfigDocument;
    expect(parsed).toEqual(migrated.config);
    expect(validateConfig(parsed, loadBundledCatalog(), { topologyV3Enabled: true }).filter((issue) => issue.verdict === "bad")).toEqual([]);

    expect(topologyV3Enabled({})).toBe(false);
    expect(topologyV3Enabled({ BUILD_SIM_TOPOLOGY_V3_ENABLED: "0" })).toBe(false);
    expect(topologyV3Enabled({ BUILD_SIM_TOPOLOGY_V3_ENABLED: "true" })).toBe(true);
    expect(topologyV3Enabled({ BUILD_SIM_TOPOLOGY_V3_ENABLED: "YES" })).toBe(true);
    expect(() => topologyV3Enabled({ BUILD_SIM_TOPOLOGY_V3_ENABLED: "sometimes" })).toThrow(/true or false/);
    expect(readConfigDocument(v3Bytes, {
      environment: { BUILD_SIM_TOPOLOGY_V3_ENABLED: "false" },
      v2FallbackRaw: sourceBytes,
    })).toEqual(source);
    expect(readConfigDocument(v3Bytes, {
      environment: { BUILD_SIM_TOPOLOGY_V3_ENABLED: "1" },
    })).toEqual(migrated.config);
  });

  it("rejects an ambiguous source artifact and never accepts gpu.none as a V3 component", async () => {
    const source = sourceConfig();
    const { sourceBytes, sourceHash } = await sourceArtifact(source);
    const alteredBytes = sourceBytes.replace(source.id, "different-id");
    await expect(migrateBuildConfigV2ToV3(source, { sourceBytes: alteredBytes, sourceHash: await sha256Hex(alteredBytes) })).rejects.toThrow(/source bytes do not match/);
    await expect(migrateBuildConfigV2ToV3(source, { sourceBytes, sourceHash: "not-a-hash" })).rejects.toThrow(/SHA-256/);
    await expect(migrateBuildConfigV2ToV3(source, { sourceBytes, sourceHash: "b".repeat(64) })).rejects.toThrow(/does not match the exact source bytes/);
    await expect(migrateBuildConfigV2ToV3(source, { sourceBytes, sourceHash })).rejects.toThrow(/exactly one explicit catalog or immutable catalogBinding/);

    const migrated = await migrateBuildConfigV2ToV3(source, { sourceBytes, sourceHash, catalog: loadBundledCatalog() });
    const forged = structuredClone(migrated.config);
    forged.components.push({
      instanceId: "forged-gpu-none", kind: "gpu", role: "gpu", state: "planned", source: "migration",
      identity: { status: "resolved", skuId: "gpu.none", identityClaimIds: [`migration:v2:${sourceHash}:selection/gpuId`] },
    });
    forged.roleDecisions = [];
    expect(validateConfig(forged, loadBundledCatalog(), { topologyV3Enabled: true }))
      .toContainEqual(expect.objectContaining({ path: expect.stringContaining("identity.skuId"), verdict: "bad" }));

    const malformed = structuredClone(migrated.config) as unknown as BuildConfigDocument;
    (malformed as unknown as { components: unknown[] }).components = [{ identity: null }];
    expect(() => validateConfig(malformed, loadBundledCatalog(), { topologyV3Enabled: true })).not.toThrow();
    expect(validateConfig(malformed, loadBundledCatalog(), { topologyV3Enabled: true }))
      .toContainEqual(expect.objectContaining({ path: "topology", verdict: "bad" }));
  });

  it("derives bounded ASCII IDs without embedding hostile or Unicode legacy identifiers", async () => {
    const source = sourceConfig();
    source.id = `../../旧方案/🚨/${"x".repeat(300)}`;
    source.selection.fanGroups = [{ mountId: `../../前风扇/🚨/${"y".repeat(300)}`, sizeMm: 120, count: 2 }];
    const artifact = await sourceArtifact(source);
    const first = await migrateBuildConfigV2ToV3(source, artifact);
    const second = await migrateBuildConfigV2ToV3(structuredClone(source), artifact);

    expect(second).toEqual(first);
    expect(first.config.components.every((component) => /^migci-[a-f0-9]{64}$/.test(component.instanceId))).toBe(true);
    expect(first.config.components.every((component) => /^[a-z0-9_-]{1,72}$/.test(component.role))).toBe(true);
    expect(first.config.roleDecisions.every((decision) => /^migrd-[a-f0-9]{64}$/.test(decision.roleDecisionId))).toBe(true);
    expect(first.config.components.some((component) => component.instanceId.includes(source.id))).toBe(false);
    expect(first.config.components.some((component) => component.role.includes("前风扇"))).toBe(false);
  });

  it("consumes legacy owned quantities instead of promoting every repeated instance", async () => {
    const source = sourceConfig();
    source.selection.diskCount = 3;
    source.bom = source.bom.filter((line) => line.skuId !== source.selection.diskSkuId);
    source.bom.push({ skuId: source.selection.diskSkuId!, qty: 1, bucket: "owned" });
    const migrated = await migrateBuildConfigV2ToV3(source, await sourceArtifact(source));
    const disks = migrated.config.components.filter((component) => component.role === "data_disk");

    expect(disks.map((component) => component.state)).toEqual(["ordered", "planned", "planned"]);
    expect(disks.filter((component) => component.state === "ordered")).toHaveLength(1);
    expect(migrated.warnings).toContainEqual(expect.objectContaining({
      code: "legacy_purchase_bucket_mapped_to_planned",
      message: expect.stringContaining("only 1 explicitly owned unit"),
    }));
  });
});
