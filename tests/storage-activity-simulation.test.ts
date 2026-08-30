import { describe, expect, it } from "vitest";
import { createSimulationInputHashClosure, logicalLayoutSimulationHash, type SourcedSimulationInput } from "../src/simulation/contracts";
import { resolveStorageActivity } from "../src/simulation/storage-activity";
import { evaluateProductionThermalAcoustic } from "../src/simulation/evaluate";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { fact, progressiveInput } from "./helpers/progressive-evaluation-fixture";

async function fixture(concurrentDiskCount: number, dutyCycle: number) {
  const config = createEmptyBuildConfigV3("plan-storage-activity", "Storage activity", "2026-08-29T00:00:00.000Z");
  config.components.push(
    { instanceId: "disk-a", kind: "storage_drive", role: "data", state: "planned", identity: { status: "resolved", skuId: "disk.a", identityClaimIds: ["claim-a"] }, source: "user" },
    { instanceId: "disk-b", kind: "storage_drive", role: "data", state: "planned", identity: { status: "resolved", skuId: "disk.b", identityClaimIds: ["claim-b"] }, source: "user" },
  );
  config.logicalLayouts.push({
    layoutId: "layout-main", bootPoolDiskIds: [],
    vdevs: [{ vdevId: "data", topology: "mirror", diskInstanceIds: ["disk-a", "disk-b"] }], spareDiskIds: [],
  });
  const sourcedInput: SourcedSimulationInput = {
    input: {
      workloadMetricRefs: ["scenario:nas-scrub"], ambientC: { min: 20, max: 30 }, fanPolicyId: "balanced-v1",
      storageActivity: [{ logicalLayoutId: "layout-main", dutyCycle, concurrentDiskCount }],
      placementIds: [], routeIds: [], modelVersion: `sha256:${"d".repeat(64)}`,
    },
    sources: [
      "/workloadMetricRefs/0", "/ambientC/min", "/ambientC/max", "/fanPolicyId",
      "/storageActivity/0/logicalLayoutId", "/storageActivity/0/dutyCycle", "/storageActivity/0/concurrentDiskCount",
      "/placementIds", "/routeIds", "/modelVersion",
    ].map((fieldPath) => ({ fieldPath, source: "system_profile_default" as const, userOverridable: true as const, sourceRef: `fixture:${fieldPath}` })),
  };
  const layoutHash = await logicalLayoutSimulationHash(config.logicalLayouts[0]!, { "disk-a": "a".repeat(64), "disk-b": "b".repeat(64) });
  const closure = await createSimulationInputHashClosure(sourcedInput, [{ logicalLayoutId: "layout-main", layoutHash }]);
  return { config, closure };
}

describe("U9 NAS storage activity projection", () => {
  it("projects exact duty and concurrent-drive count into each drive's thermal/acoustic activity fraction", async () => {
    const one = await fixture(1, 0.8);
    expect(resolveStorageActivity({ ...one, componentInstanceId: "disk-a" })).toMatchObject({
      status: "ready", memberCount: 2, concurrentDiskCount: 1, spinUpDiskCount: 2, dutyCycle: 0.8, activeFraction: 0.4,
    });
    const both = await fixture(2, 0.8);
    expect(resolveStorageActivity({ ...both, componentInstanceId: "disk-a" })).toMatchObject({
      status: "ready", memberCount: 2, concurrentDiskCount: 2, spinUpDiskCount: 2, dutyCycle: 0.8, activeFraction: 0.8,
    });
  });

  it("changes the evaluated equivalent HDD sound level when locked vdev concurrency changes", async () => {
    const evaluate = async (concurrentDiskCount: number) => {
      const value = await fixture(concurrentDiskCount, 0.8);
      value.config.requirementSpec = {
        requirementSpecId: "requirements-storage", schemaVersion: "1.0.0",
        workloads: [{ workloadId: "nas", state: "answered", name: "NAS scrub", source: "user", confirmedByUser: true, evidenceOrBenchmarkRefs: [], metrics: [
          { metricId: "thermal.scenario", operator: "eq", value: "nas-scrub", priority: "must", state: "answered", source: "user", confirmedByUser: true },
        ] }], constraints: [],
      };
      const curveValue = {
        curveId: "curve.hdd.nas-scrub", weighting: "A", referenceDistanceM: 1,
        loadId: "scenario:nas-scrub", testMethodId: "iso-fixture",
        points: [{ rpm: 5400, lo: 30, hi: 30 }, { rpm: 7200, lo: 30, hi: 30 }],
      };
      const governed = await progressiveInput(value.config, value.config.components.map((component) => fact(component, "acoustic.sound_curve", curveValue)));
      const simulationArtifact = {
        schemaVersion: "artifact-payload-v1" as const,
        artifactId: "simulation-input-storage-activity",
        mediaType: "application/vnd.buildsim.simulation-input+json",
        payload: value.closure,
        contentHash: governed.externalInputs.simulationInput.ref.contentHash,
      };
      return evaluateProductionThermalAcoustic({
        ...governed,
        snapshotHashes: { ...governed.snapshotHashes, simulationInputHash: value.closure.contentHash },
        externalInputs: {
          ...governed.externalInputs,
          simulationInput: { ...governed.externalInputs.simulationInput, payload: simulationArtifact },
        },
      });
    };

    const one = await evaluate(1);
    const both = await evaluate(2);
    expect(one.acoustic.verdict).toBe("pass");
    expect(both.acoustic.verdict).toBe("pass");
    expect((both.acoustic.totalDba?.hi ?? 0) - (one.acoustic.totalDba?.hi ?? 0)).toBeCloseTo(3.0103, 3);
    expect(one.acoustic.assumptions).toContain(
      "locked storage activity layout-main: duty 0.8, concurrent 1/2, spin-up 2; hardware sound is reported as an equivalent scenario level",
    );
  });

  it("fails closed when a drive has no unique locked layout activity", async () => {
    const value = await fixture(1, 0.8);
    value.config.logicalLayouts.push({
      layoutId: "layout-copy", bootPoolDiskIds: ["disk-a"], vdevs: [], spareDiskIds: [],
    });
    expect(resolveStorageActivity({ ...value, componentInstanceId: "disk-a" })).toEqual({
      status: "blocked", reasonCode: "storage-layout-membership:disk-a",
    });
  });
});
