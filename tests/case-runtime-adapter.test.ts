import { describe, expect, it } from "vitest";
import genericSeedJson from "./fixtures/adapters/generic-atx-case.json";
import genericRuntimeSeedJson from "./fixtures/adapters/generic-atx-runtime-model.json";
import matrixJson from "./fixtures/adapters/case-layout-matrix.json";
import n6SeedJson from "../data/cases/jonsbo-n6/adapter.json";
import baselineJson from "../data/configs/baseline-atx-1hdd.json";
import {
  CaseRuntimeAdapterRegistry,
  CaseAdapterRegistry,
  caseAdapterSpatialProjectionHash,
  compileCaseAdapterProjectionRuntime,
  compileLockedCaseAdapterManifestRuntime,
  compileLockedCaseAdapterRuntime,
  createCaseRuntimeModel,
  materializeCaseAdapterFixtureSeed,
  verifyCaseAdapterSnapshotPayload,
  type CaseAdapterSeed,
  type CaseRuntimeModelInput,
} from "../src/adapters";
import { evaluateBuild } from "../src/core/evaluate";
import { loadBundledCatalog } from "../src/sku/catalog";
import type { BuildConfig } from "../src/config/types";
import { hashContent } from "../src/hash";
import type { CaseInstanceOverrides } from "../src/adapters/instance-overrides";
import { N6_CASE_RUNTIME_ADAPTER } from "../src/adapters/jonsbo-n6/assembly";
import { seedForMatrixCase, type MatrixCase } from "./helpers/case-adapter-matrix";

const genericSeed = genericSeedJson as unknown as CaseAdapterSeed;

async function measuredOverrides(input: {
  planId: string;
  instanceId: string;
  manifestHash: string;
  projectionHash: string;
  entry: CaseInstanceOverrides["overrides"][number];
}): Promise<CaseInstanceOverrides> {
  const base = {
    schemaVersion: "case-instance-overrides-v1" as const,
    planId: input.planId,
    instanceId: input.instanceId,
    subjectRevisionHash: input.entry.subjectRevisionHash,
    observationSnapshotId: `snapshot-${input.planId}`,
    observationSnapshotHash: "b".repeat(64),
    baseManifestHash: input.manifestHash,
    baseProjectionHash: input.projectionHash,
    overrides: [input.entry],
  };
  const spatialHash = await hashContent({
    schemaVersion: "case-instance-spatial-input-v1",
    planId: base.planId,
    instanceId: base.instanceId,
    subjectRevisionHash: base.subjectRevisionHash,
    observationSnapshotHash: base.observationSnapshotHash,
    baseManifestHash: base.baseManifestHash,
    baseProjectionHash: base.baseProjectionHash,
    overrides: base.overrides,
  }, { domain: "spatial-topology", schemaVersion: "1.0.0" });
  const withSpatial = { ...base, spatialHash };
  return { ...withSpatial, contentHash: await hashContent(withSpatial, { domain: "artifact", schemaVersion: "1.0.0" }) };
}

describe("case runtime adapter registry and projection compiler", () => {
  it("compiles a non-N6 zero-tray primitive model to ready through the same evaluator", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(genericSeed);
    const seed = genericRuntimeSeedJson as unknown as Omit<CaseRuntimeModelInput, "manifestHash" | "schemaVersion"> & {
      schemaVersion: "case-runtime-model-fixture-seed-v1";
    };
    const model = await createCaseRuntimeModel(materialized.manifest, {
      schemaVersion: "case-runtime-model-v1",
      runtimeId: seed.runtimeId,
      runtimeVersion: seed.runtimeVersion,
      interpreterId: seed.interpreterId,
      authorityStatus: seed.authorityStatus,
      authorityRefs: structuredClone(seed.authorityRefs),
      identity: structuredClone(seed.identity),
      manifestHash: materialized.manifest.contentHash,
      documents: structuredClone(seed.documents),
      sourceRefs: [...seed.sourceRefs],
    });
    const adapter = await compileLockedCaseAdapterRuntime(materialized.manifest, model);
    const registry = CaseRuntimeAdapterRegistry.create([adapter]);
    const catalog = loadBundledCatalog();
    const templateCase = catalog.skus.find((sku) => sku.category === "case")!;
    catalog.skus.push({ ...structuredClone(templateCase), id: adapter.identity.skuId, name: "Primitive ATX fixture" });
    const config = structuredClone(baselineJson) as BuildConfig;
    config.caseId = adapter.identity.skuId;
    config.selection.diskCount = 0;
    config.selection.nvmeCount = 0;
    config.selection.boot = "usbssd";
    config.selection.fanGroups = [{ mountId: "mount.fan.front", sizeMm: 120, count: 2 }];

    const evaluation = evaluateBuild(config, catalog, undefined, { registry, caseIdentity: adapter.identity });
    expect(evaluation.caseRuntime).toMatchObject({ status: "ready", safetyStatus: "unknown", authorityStatus: "legacy_unverified" });
    expect(adapter.capabilities).toMatchObject({ trayCount: 0, backplane: { sataPowerInlets: 0, molexInlets: 0 } });
    expect(evaluation.geometry).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "case.shell", kind: "chassis" }),
      expect.objectContaining({ id: "board", kind: "board" }),
      expect.objectContaining({ id: "psu.primary", kind: "psu" }),
    ]));
    expect(evaluation.geometry.some((part) => part.kind === "drive" || part.kind === "m2")).toBe(false);
    expect(evaluation.routing).toEqual({ cables: [], ports: [], findings: [] });
    expect(evaluation.wiring.bayPaths).toEqual([]);
    expect(evaluation.bom.some((line) => line.skuId.startsWith("storage."))).toBe(false);
    expect(evaluation.occupancy.verdict).toBe("warn");
    expect(evaluation.findings.some((finding) => finding.id === "case-runtime.authority:legacy-unverified")).toBe(true);
    expect(evaluation.findings.some((finding) => finding.verdict === "ok")).toBe(false);
    expect(evaluation.wiring.backplaneHarness.verdict).toBe("unknown");
    expect(JSON.stringify(evaluation)).not.toContain("jonsbo");
  });

  it("runs N6, ATX, mATX and Mini-ITX through one registry and evaluator entry", async () => {
    const n6Materialized = await materializeCaseAdapterFixtureSeed(n6SeedJson as unknown as CaseAdapterSeed);
    expect(N6_CASE_RUNTIME_ADAPTER.identity.manifestHash).toBe(n6Materialized.manifest.contentHash);
    expect(N6_CASE_RUNTIME_ADAPTER.identity.projectionHash).toBe(await caseAdapterSpatialProjectionHash(n6Materialized.projection));
    const allEntries = (matrixJson as unknown as { cases: MatrixCase[] }).cases;
    const entries = [
      "mount.motherboard.atx",
      "mount.motherboard.micro-atx",
      "mount.motherboard.mini-itx",
    ].map((standardId) => allEntries.find((entry) => entry.motherboardStandardId === standardId)!);
    const materialized = await Promise.all(entries.map((entry) => materializeCaseAdapterFixtureSeed(seedForMatrixCase(entry))));
    const ordinary = await Promise.all(materialized.map(({ manifest, projection }) => compileCaseAdapterProjectionRuntime(manifest, projection)));
    const registry = CaseRuntimeAdapterRegistry.create([N6_CASE_RUNTIME_ADAPTER, ...ordinary]);
    const catalog = loadBundledCatalog();
    const templateCase = catalog.skus.find((sku) => sku.category === "case")!;
    for (const adapter of ordinary) {
      catalog.skus.push({ ...structuredClone(templateCase), id: adapter.identity.skuId, name: adapter.adapterId });
      const config = structuredClone(baselineJson) as BuildConfig;
      config.caseId = adapter.identity.skuId;
      config.selection.fanGroups = [];
      const evaluation = evaluateBuild(config, catalog, undefined, { registry, caseIdentity: adapter.identity });
      expect(evaluation.caseRuntime.status).toBe("partial");
      expect(evaluation.caseRuntime.domains.geometry.status).toBe("blocked");
      expect(evaluation.geometry).toHaveLength(1);
    }
    expect(new Set(ordinary.map((adapter) => adapter.capabilities.caseId)).size).toBe(3);
    const n6Config = structuredClone(baselineJson) as BuildConfig;
    const n6 = evaluateBuild(n6Config, catalog, undefined, { registry, caseIdentity: N6_CASE_RUNTIME_ADAPTER.identity });
    expect(n6.caseRuntime.status).toBe("ready");
    expect(n6.geometry.length).toBeGreaterThan(1);
  });

  it("projects a root-validated measurement into the exact N6 instance geometry", async () => {
    const config = structuredClone(baselineJson) as BuildConfig;
    config.id = "plan-n6-instance-override";
    const instanceId = "case-instance-n6";
    const overrides = await measuredOverrides({
      planId: config.id,
      instanceId,
      manifestHash: N6_CASE_RUNTIME_ADAPTER.identity.manifestHash,
      projectionHash: N6_CASE_RUNTIME_ADAPTER.identity.projectionHash!,
      entry: {
        observationId: "observation-n6-board-x",
        observationRecordHash: "c".repeat(64),
        subjectRef: { kind: "mount", ownerInstanceId: instanceId, mountId: "mount.board.matx" },
        subjectRevisionHash: "a".repeat(64),
        fieldId: "case.anchor.x",
        targetKind: "anchor",
        property: "x",
        value: 41,
        unit: "mm",
        uncertainty: { plusMinus: 1 },
      },
    });
    const registry = CaseRuntimeAdapterRegistry.create([N6_CASE_RUNTIME_ADAPTER]);
    const evaluation = evaluateBuild(config, loadBundledCatalog(), undefined, {
      registry,
      caseIdentity: N6_CASE_RUNTIME_ADAPTER.identity,
      caseInstanceId: instanceId,
      instanceOverridesByInstanceId: { [instanceId]: overrides },
    });
    expect(evaluation.geometry.find((part) => part.id === "board")?.box.c[0]).toBe(41);
    expect(evaluation.caseRuntime.spatialHash).toBe(overrides.spatialHash);
  });

  it("runs a second case through the same evaluator while blocking only unproved domains", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(genericSeed);
    const adapter = await compileCaseAdapterProjectionRuntime(materialized.manifest, materialized.projection);
    const registry = CaseRuntimeAdapterRegistry.create([adapter]);
    const catalog = loadBundledCatalog();
    const templateCase = catalog.skus.find((sku) => sku.category === "case")!;
    catalog.skus.push({ ...structuredClone(templateCase), id: materialized.manifest.identity.skuId, name: "Governed generic ATX fixture" });
    const config = structuredClone(baselineJson) as BuildConfig;
    config.caseId = materialized.manifest.identity.skuId;
    config.selection.fanGroups = [];

    const evaluation = evaluateBuild(config, catalog, undefined, { registry, caseIdentity: adapter.identity });
    expect(evaluation.readiness.status).toBe("ready");
    expect(evaluation.caseRuntime).toMatchObject({
      status: "partial",
      adapterId: materialized.manifest.adapterId,
      manifestHash: materialized.manifest.contentHash,
      domains: {
        electronics: { status: "ready" },
        geometry: { status: "blocked", reasonCodes: expect.arrayContaining(["mount-pose-unavailable"]) },
        routing: { status: "blocked" },
      },
    });
    expect(evaluation.geometry).toHaveLength(1);
    expect(evaluation.geometry[0]).toMatchObject({ kind: "chassis", skuId: materialized.manifest.identity.skuId });
    expect(evaluation.geometry.some((part) => part.kind === "m2" || part.kind === "drive" || part.kind === "gpu")).toBe(false);
    expect(evaluation.routing).toEqual({ cables: [], ports: [], findings: [] });
    expect(evaluation.wiring.bayPaths).toEqual([]);
    expect(evaluation.physical.provenance).not.toEqual(expect.arrayContaining([expect.stringContaining("jonsbo")]));
    expect(evaluation.calibration.snapshot.caseId).toBe(materialized.manifest.identity.skuId);
    expect(evaluation.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "case-runtime.blocked:geometry", verdict: "warn" }),
      expect.objectContaining({ id: "case-runtime.blocked:routing", verdict: "warn" }),
    ]));
  });

  it("hydrates a verified adapter artifact manifest into an executable honest partial runtime", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(genericSeed);
    const artifact = await (await CaseAdapterRegistry.create([materialized.manifest])).createArtifact();
    await expect(verifyCaseAdapterSnapshotPayload(artifact.payload)).resolves.toBe(true);
    const lockedManifest = artifact.payload.caseManifests[0]!;
    const adapter = await compileLockedCaseAdapterManifestRuntime(lockedManifest);
    const registry = CaseRuntimeAdapterRegistry.create([adapter]);
    const catalog = loadBundledCatalog();
    const templateCase = catalog.skus.find((sku) => sku.category === "case")!;
    catalog.skus.push({ ...structuredClone(templateCase), id: adapter.identity.skuId, name: "Locked artifact case" });
    const config = structuredClone(baselineJson) as BuildConfig;
    config.caseId = adapter.identity.skuId;
    config.selection.fanGroups = [];

    const evaluation = evaluateBuild(config, catalog, undefined, { registry, caseIdentity: adapter.identity });
    expect(evaluation.caseRuntime.status).toBe("partial");
    expect(evaluation.caseRuntime.manifestHash).toBe(lockedManifest.contentHash);
    expect(evaluation.caseRuntime.projectionHash).toBe(await caseAdapterSpatialProjectionHash(lockedManifest));
    expect(adapter.capabilities.coolerLimits.overheadAtxMm).toBeNull();
    expect(adapter.capabilities.gpuLimits.publishedMaxMm).toBeNull();
    expect(evaluation.geometry).toEqual([expect.objectContaining({ skuId: lockedManifest.identity.skuId })]);
    expect(evaluation.routing.cables).toEqual([]);
  });

  it("fails an unavailable case closed without borrowing registered case geometry", () => {
    const catalog = loadBundledCatalog();
    const templateCase = catalog.skus.find((sku) => sku.category === "case")!;
    const caseId = "fixture.case.adapter-unavailable";
    catalog.skus.push({ ...structuredClone(templateCase), id: caseId, name: "Unavailable case fixture" });
    const config = structuredClone(baselineJson) as BuildConfig;
    config.caseId = caseId;
    config.selection.fanGroups = [];
    const evaluation = evaluateBuild(config, catalog, undefined, {
      registry: CaseRuntimeAdapterRegistry.create(),
      legacySkuFallback: true,
    });
    expect(evaluation.readiness).toEqual({ status: "incomplete", missing: ["case.adapter"] });
    expect(evaluation.caseRuntime.status).toBe("blocked");
    expect(evaluation.caseRuntime.domains.geometry.reasonCodes).toContain("case-adapter-unavailable");
    expect(evaluation.geometry).toEqual([]);
    expect(evaluation.bom).toEqual([]);
  });

  it("rejects raw or hash-mismatched projections instead of compiling ungoverned input", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(genericSeed);
    await expect(compileCaseAdapterProjectionRuntime(materialized.manifest, structuredClone(materialized.projection)))
      .rejects.toThrow(/authority-issued frozen projection/i);
    await expect(compileCaseAdapterProjectionRuntime(
      { ...materialized.manifest, contentHash: "0".repeat(64) },
      materialized.projection,
    )).rejects.toThrow(/exact manifest identity\/hash/i);
  });

  it("accepts caller-scoped spatial overrides without mutating the adapter manifest", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(genericSeed);
    const projectionHash = await caseAdapterSpatialProjectionHash(materialized.projection);
    const adapter = await compileCaseAdapterProjectionRuntime(materialized.manifest, materialized.projection, { projectionHash });
    const registry = CaseRuntimeAdapterRegistry.create([adapter]);
    const catalog = loadBundledCatalog();
    const templateCase = catalog.skus.find((sku) => sku.category === "case")!;
    catalog.skus.push({ ...structuredClone(templateCase), id: materialized.manifest.identity.skuId, name: "Override fixture" });
    const config = structuredClone(baselineJson) as BuildConfig;
    config.id = "plan-runtime-override";
    config.caseId = materialized.manifest.identity.skuId;
    config.selection.fanGroups = [];
    const manifestBefore = structuredClone(materialized.manifest);
    const base = {
      schemaVersion: "case-instance-overrides-v1" as const,
      planId: config.id,
      instanceId: "case-instance-a",
      subjectRevisionHash: "a".repeat(64),
      observationSnapshotId: "snapshot-runtime-override",
      observationSnapshotHash: "b".repeat(64),
      baseManifestHash: materialized.manifest.contentHash,
      baseProjectionHash: projectionHash,
      overrides: [{
        observationId: "observation-envelope-width",
        observationRecordHash: "c".repeat(64),
        subjectRef: { kind: "instance" as const, instanceId: "case-instance-a" },
        subjectRevisionHash: "a".repeat(64),
        fieldId: "case.envelope.width" as const,
        targetKind: "envelope" as const,
        property: "width" as const,
        value: 251,
        unit: "mm" as const,
        uncertainty: { plusMinus: 1 },
      }],
    };
    const spatialHash = await hashContent({
      schemaVersion: "case-instance-spatial-input-v1",
      planId: base.planId,
      instanceId: base.instanceId,
      subjectRevisionHash: base.subjectRevisionHash,
      observationSnapshotHash: base.observationSnapshotHash,
      baseManifestHash: base.baseManifestHash,
      baseProjectionHash: base.baseProjectionHash,
      overrides: base.overrides,
    }, { domain: "spatial-topology", schemaVersion: "1.0.0" });
    const withSpatial = { ...base, spatialHash };
    const instanceOverrides: CaseInstanceOverrides = {
      ...withSpatial,
      contentHash: await hashContent(withSpatial, { domain: "artifact", schemaVersion: "1.0.0" }),
    };
    const evaluation = evaluateBuild(config, catalog, undefined, {
      registry,
      caseIdentity: adapter.identity,
      caseInstanceId: "case-instance-a",
      instanceOverrides,
    });
    expect(evaluation.geometry[0]?.box.w).toBe(251);
    expect(evaluation.caseRuntime.spatialHash).toBe(instanceOverrides.spatialHash);
    expect(materialized.manifest).toEqual(manifestBefore);
    expect(adapter.capabilities).not.toHaveProperty("instanceOverrides");
    expect(() => evaluateBuild(config, catalog, undefined, {
      registry,
      caseIdentity: adapter.identity,
      caseInstanceId: "case-instance-b",
      instanceOverrides,
    })).toThrow(/exact plan\/manifest\/projection runtime/i);
  });

  it("validates fan mounts from the exact caller registry rather than a process singleton", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(genericSeed);
    const adapter = await compileCaseAdapterProjectionRuntime(materialized.manifest, materialized.projection);
    const registry = CaseRuntimeAdapterRegistry.create([adapter]);
    const catalog = loadBundledCatalog();
    const templateCase = catalog.skus.find((sku) => sku.category === "case")!;
    catalog.skus.push({ ...structuredClone(templateCase), id: adapter.identity.skuId, name: "Fan mount fixture" });
    const config = structuredClone(baselineJson) as BuildConfig;
    config.caseId = adapter.identity.skuId;
    config.selection.fanGroups = [{ mountId: "mount.fan.front", sizeMm: 120, count: 2 }];

    const valid = evaluateBuild(config, catalog, undefined, { registry, caseIdentity: adapter.identity });
    expect(valid.findings.some((finding) => finding.id.startsWith("fan.config:"))).toBe(false);

    config.selection.fanGroups = [{ mountId: "mount.fan.not-reviewed", sizeMm: 120, count: 1 }];
    const invalid = evaluateBuild(config, catalog, undefined, { registry, caseIdentity: adapter.identity });
    expect(invalid.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringMatching(/^fan\.config:/), verdict: "bad" }),
    ]));
  });

  it("does not draw or buy a default SSD when nvmeCount is explicitly zero", () => {
    const catalog = loadBundledCatalog();
    const config = structuredClone(baselineJson) as BuildConfig;
    config.selection.nvmeCount = 0;
    const evaluation = evaluateBuild(config, catalog);
    expect(evaluation.geometry.filter((part) => part.kind === "m2")).toEqual([]);
    expect(evaluation.bom.some((line) => line.skuId === "storage.samsung-980-pro")).toBe(false);
  });

  it("does not infer GPU coexistence from an SKU name substring", () => {
    const catalog = loadBundledCatalog();
    const source = catalog.skus.find((sku) => sku.id === "gpu.rtx-a4000-16gb")!;
    const nameOnly = {
      ...structuredClone(source),
      id: "gpu.fixture-a4000-name-only",
      name: "Name-only GPU fixture",
      tags: (source.tags ?? []).filter((tag) => tag !== "hba-friendly"),
      attrs: { ...source.attrs, requiresHbaCoexistenceReview: false },
    };
    catalog.skus.push(nameOnly);
    const config = structuredClone(baselineJson) as BuildConfig;
    config.selection.gpuId = nameOnly.id;
    config.selection.hbaMode = "always";
    config.selection.hbaSkuId = "hba.lsi-9300-8i-it";
    const evaluation = evaluateBuild(config, catalog);
    expect(evaluation.findings.some((finding) => finding.id === "n6.gpu-hba-review")).toBe(false);
  });

  it("keys runtime adapters by exact SKU, region and revision and fails legacy ambiguity closed", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(genericSeed);
    const first = await compileCaseAdapterProjectionRuntime(materialized.manifest, materialized.projection);
    const second = Object.freeze({
      ...first,
      adapterId: `${first.adapterId}.region-b`,
      identity: { ...first.identity, region: "region-b", revision: "B", manifestHash: "d".repeat(64) },
    });
    const registry = CaseRuntimeAdapterRegistry.create([first, second]);
    expect(registry.resolveLegacySku(first.identity.skuId)).toBeNull();
    expect(registry.resolveExact(first.identity)).toBe(first);
    expect(registry.resolveExact(second.identity)).toBe(second);
    expect(registry.resolveExact({ ...first.identity, region: "wrong" })).toBeNull();
    expect(registry.resolveExact({ ...first.identity, revision: "wrong" })).toBeNull();
  });

  it("rejects caller-constructed governed authority until v1 has per-field bindings", () => {
    const forged = Object.freeze({
      ...N6_CASE_RUNTIME_ADAPTER,
      authorityStatus: "governed_fact_derivation_bound" as const,
    });
    expect(() => CaseRuntimeAdapterRegistry.create([forged])).toThrow(/per-field authority bindings unavailable/i);
  });
});
