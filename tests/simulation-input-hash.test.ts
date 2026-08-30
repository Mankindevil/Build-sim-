import { describe, expect, it } from "vitest";
import { createSimulationInputHashClosure, logicalLayoutSimulationHash, verifySimulationInputHashClosure, type SourcedSimulationInput } from "../src/simulation/contracts";
import type { LogicalLayoutSelection } from "../src/topology/contracts";
import { createProductionSimulationInput } from "../src/simulation/production";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

function sourced(ambientMax = 30): SourcedSimulationInput {
  return {
    input: {
      workloadMetricRefs: ["requirement:workload:thermal.ambient", "scenario:nas-scrub"],
      ambientC: { min: 20, max: ambientMax },
      fanPolicyId: "balanced-v1",
      storageActivity: [{ logicalLayoutId: "layout-main", dutyCycle: 0.7, concurrentDiskCount: 2 }],
      placementIds: ["placement-disk-2", "placement-disk-1"],
      routeIds: ["route-disk-2", "route-disk-1"],
      modelVersion: "thermal-acoustic-v1",
    },
    sources: [
      "/workloadMetricRefs/0", "/workloadMetricRefs/1", "/ambientC/min", "/ambientC/max", "/fanPolicyId",
      "/storageActivity/0/logicalLayoutId", "/storageActivity/0/dutyCycle", "/storageActivity/0/concurrentDiskCount",
      "/placementIds/0", "/placementIds/1", "/routeIds/0", "/routeIds/1", "/modelVersion",
    ].map((fieldPath) => ({ fieldPath, source: "user" as const, userOverridable: true as const, sourceRef: `plan:${fieldPath}` })),
  };
}

const layout: LogicalLayoutSelection = {
  layoutId: "layout-main",
  bootPoolDiskIds: [],
  vdevs: [{ vdevId: "vdev-main", topology: "mirror", diskInstanceIds: ["disk-1", "disk-2"] }],
  spareDiskIds: [],
};
const paths = { "disk-1": "a".repeat(64), "disk-2": "b".repeat(64) };

describe("U9 frozen simulation input hash", () => {
  it("is order-stable but changes with environment, modelled layout or physical paths", async () => {
    const layoutHash = await logicalLayoutSimulationHash(layout, paths);
    const first = await createSimulationInputHashClosure(sourced(), [{ logicalLayoutId: layout.layoutId, layoutHash }]);
    await expect(verifySimulationInputHashClosure(first)).resolves.toBe(true);
    const reordered = sourced();
    reordered.input.workloadMetricRefs.reverse();
    reordered.input.placementIds.reverse();
    reordered.input.routeIds.reverse();
    reordered.sources.reverse();
    await expect(createSimulationInputHashClosure(reordered, [{ logicalLayoutId: layout.layoutId, layoutHash }]))
      .resolves.toMatchObject({ contentHash: first.contentHash });

    const hotter = await createSimulationInputHashClosure(sourced(35), [{ logicalLayoutId: layout.layoutId, layoutHash }]);
    expect(hotter.contentHash).not.toBe(first.contentHash);

    const raidz = structuredClone(layout);
    raidz.vdevs[0]!.topology = "raidz1";
    const raidzHash = await logicalLayoutSimulationHash(raidz, paths);
    expect(raidzHash).not.toBe(layoutHash);
    const changedLayout = await createSimulationInputHashClosure(sourced(), [{ logicalLayoutId: layout.layoutId, layoutHash: raidzHash }]);
    expect(changedLayout.contentHash).not.toBe(first.contentHash);

    const changedPath = await logicalLayoutSimulationHash(layout, { ...paths, "disk-2": "c".repeat(64) });
    expect(changedPath).not.toBe(layoutHash);
    await expect(verifySimulationInputHashClosure({ ...first, contentHash: "f".repeat(64) })).resolves.toBe(false);
  });

  it("requires every active storage scenario to close one exact logical layout hash", async () => {
    await expect(createSimulationInputHashClosure(sourced(), [])).rejects.toThrow(/lacks an exact logical layout hash/);
  });

  it("derives the production closure from current requirements, topology, placements and connection paths", async () => {
    const config = createEmptyBuildConfigV3("plan-production", "Production", "2026-08-29T00:00:00.000Z");
    config.requirementSpec = {
      requirementSpecId: "requirements-production", schemaVersion: "1.0.0",
      workloads: [{ workloadId: "nas", state: "answered", name: "NAS scrub", source: "user", confirmedByUser: true, evidenceOrBenchmarkRefs: [], metrics: [
        { metricId: "thermal.scenario", operator: "eq", value: "nas-scrub", priority: "must", state: "answered", source: "user", confirmedByUser: true },
        { metricId: "thermal.ambient", operator: "between", value: [22, 28], unitId: "celsius", priority: "must", state: "answered", source: "user", confirmedByUser: true },
      ] }], constraints: [],
    };
    config.components.push(
      { instanceId: "disk-a", kind: "storage_drive", role: "data", state: "planned", identity: { status: "resolved", skuId: "disk.a", identityClaimIds: ["claim-a"] }, source: "user" },
      { instanceId: "disk-b", kind: "storage_drive", role: "data", state: "planned", identity: { status: "resolved", skuId: "disk.b", identityClaimIds: ["claim-b"] }, source: "user" },
      { instanceId: "hba", kind: "hba", role: "storage", state: "planned", identity: { status: "resolved", skuId: "hba.a", identityClaimIds: ["claim-hba"] }, source: "user" },
    );
    config.placements.push(
      { placementId: "place-a", componentInstanceId: "disk-a", mountOwnerInstanceId: "case", mountId: "bay-a" },
      { placementId: "place-b", componentInstanceId: "disk-b", mountOwnerInstanceId: "case", mountId: "bay-b" },
    );
    config.connections.push(
      { connectionId: "path-a", from: { instanceId: "disk-a", portId: "sata" }, to: { instanceId: "hba", portId: "port-a" }, status: "planned" },
      { connectionId: "path-b", from: { instanceId: "disk-b", portId: "sata" }, to: { instanceId: "hba", portId: "port-b" }, status: "planned" },
    );
    config.logicalLayouts.push({
      layoutId: "layout-main", bootPoolDiskIds: [],
      vdevs: [{ vdevId: "vdev-main", topology: "mirror", diskInstanceIds: ["disk-a", "disk-b"] }], spareDiskIds: [],
    });
    const result = await createProductionSimulationInput({ config, simulationModelHash: "d".repeat(64), caseInstanceOverrides: [] });
    expect(result.sourcedInput.input).toMatchObject({
      ambientC: { min: 22, max: 28 },
      workloadMetricRefs: ["requirement:nas:thermal.ambient", "requirement:nas:thermal.scenario"],
      storageActivity: [{ logicalLayoutId: "layout-main", dutyCycle: 0.85, concurrentDiskCount: 2 }],
      placementIds: ["place-a", "place-b"], routeIds: ["path-a", "path-b"],
      modelVersion: `sha256:${"d".repeat(64)}`,
    });
    await expect(verifySimulationInputHashClosure({
      schemaVersion: result.schemaVersion,
      sourcedInput: result.sourcedInput,
      logicalLayouts: result.logicalLayouts,
      contentHash: result.contentHash,
    })).resolves.toBe(true);
    const changed = structuredClone(config);
    changed.logicalLayouts[0]!.vdevs[0]!.topology = "raidz1";
    await expect(createProductionSimulationInput({ config: changed, simulationModelHash: "d".repeat(64), caseInstanceOverrides: [] }))
      .resolves.not.toMatchObject({ contentHash: result.contentHash });

    const displayMetadataOnly = structuredClone(config);
    displayMetadataOnly.name = "Renamed plan with a different displayed budget/price context";
    displayMetadataOnly.updatedAt = "2026-08-30T00:00:00.000Z";
    const displayWorkload = displayMetadataOnly.requirementSpec!.workloads[0]!;
    if (displayWorkload.state !== "answered") throw new TypeError("fixture workload must remain answered");
    displayWorkload.name = "Renamed scenario label";
    await expect(createProductionSimulationInput({ config: displayMetadataOnly, simulationModelHash: "d".repeat(64), caseInstanceOverrides: [] }))
      .resolves.toMatchObject({ contentHash: result.contentHash });
  });
});
