import { describe, expect, it } from "vitest";
import type { AcousticEvaluation } from "../src/acoustics";
import { createSimulationInputHashClosure, logicalLayoutSimulationHash, type SourcedSimulationInput } from "../src/simulation/contracts";
import { compareSimulationWhatIf } from "../src/simulation/what-if";
import type { ThermalNetworkEvaluation } from "../src/thermal";

function sourced(ambient = { min: 20, max: 30 }): SourcedSimulationInput {
  const input = {
    workloadMetricRefs: ["scenario:nas-scrub"], ambientC: ambient, fanPolicyId: "balanced-v1",
    storageActivity: [{ logicalLayoutId: "layout", dutyCycle: 0.8, concurrentDiskCount: 2 }],
    placementIds: ["disk-a", "disk-b"], routeIds: ["path-a", "path-b"], modelVersion: "thermal-acoustic-v1",
  };
  const fields = [
    "/workloadMetricRefs/0", "/ambientC/min", "/ambientC/max", "/fanPolicyId",
    "/storageActivity/0/logicalLayoutId", "/storageActivity/0/dutyCycle", "/storageActivity/0/concurrentDiskCount",
    "/placementIds/0", "/placementIds/1", "/routeIds/0", "/routeIds/1", "/modelVersion",
  ];
  return { input, sources: fields.map((fieldPath) => ({ fieldPath, source: "user" as const, userOverridable: true as const, sourceRef: `plan:${fieldPath}` })) };
}

function thermal(peak: { lo: number; hi: number }): ThermalNetworkEvaluation {
  return {
    schemaVersion: "thermal-network-evaluation-v1", ambientC: { lo: 20, hi: 30 },
    airflow: { schemaVersion: "airflow-network-result-v1", fanOperatingPoints: [], chambers: [], blockedReasonCodes: [], assumptions: [] },
    chambers: [], components: [{ sourceId: "disk-heat", componentInstanceId: "disk-a", chamberId: "main", temperatureC: peak, maximumTemperatureC: 60, verdict: "pass", evidence: "inferred", sourceRefs: ["fact:disk-heat"] }],
    peakTemperatureC: peak, verdict: "pass", energyBalanceToleranceW: 0.001, energyBalanceResidualW: 0,
    blockedReasonCodes: [], assumptions: [], evidence: "inferred", displayNotice: "规划热场插值，非 CFD、非实测",
  };
}

function acoustic(total: { lo: number; hi: number }): AcousticEvaluation {
  return {
    schemaVersion: "acoustic-evaluation-v1", referenceDistanceM: 1, loadId: "nas-scrub", testMethodId: "standardized",
    totalDba: total, level: "normal", verdict: "pass", blockedReasonCodes: [],
    contributions: [{ sourceId: "disk-noise", componentInstanceId: "disk-a", soundPressureDbaAt1M: total, shareOfUpperEnergy: 1, evidence: "inferred", sourceRefs: ["fact:disk-noise"] }],
    excludedSourceIds: [], coilWhineRisks: [], assumptions: [],
    displayNotice: "标准化硬件声源结果，不代表房间或用户位置的实际噪音",
  };
}

const layout = (topology: "mirror" | "raidz1") => ({
  layoutId: "layout", bootPoolDiskIds: [], vdevs: [{ vdevId: "data", topology, diskInstanceIds: ["disk-a", "disk-b"] }], spareDiskIds: [],
});

describe("U9 thermal/acoustic what-if", () => {
  it("keeps environment/workload fixed while attributing layout-driven interval changes", async () => {
    const paths = { "disk-a": "a".repeat(64), "disk-b": "b".repeat(64) };
    const before = await createSimulationInputHashClosure(sourced(), [{ logicalLayoutId: "layout", layoutHash: await logicalLayoutSimulationHash(layout("mirror"), paths) }]);
    const after = await createSimulationInputHashClosure(sourced(), [{ logicalLayoutId: "layout", layoutHash: await logicalLayoutSimulationHash(layout("raidz1"), paths) }]);
    const diff = compareSimulationWhatIf({ beforeInput: before, afterInput: after, beforeThermal: thermal({ lo: 35, hi: 45 }), afterThermal: thermal({ lo: 38, hi: 50 }), beforeAcoustic: acoustic({ lo: 28, hi: 32 }), afterAcoustic: acoustic({ lo: 30, hi: 35 }) });
    expect(diff.changedInputPaths).toEqual(["/logicalLayouts/layout"]);
    expect(diff.changeSources).toEqual(["layout:layout"]);
    expect(diff.peakTemperatureC.delta).toEqual({ lo: -7, hi: 15 });
    expect(diff.totalDbaAt1M.delta).toEqual({ lo: -2, hi: 7 });
    expect(diff.lockedInputPaths).toContain("/ambientC");
  });

  it("rejects a comparison that silently changes the environment basis", async () => {
    const layoutHash = "a".repeat(64);
    const before = await createSimulationInputHashClosure(sourced(), [{ logicalLayoutId: "layout", layoutHash }]);
    const after = await createSimulationInputHashClosure(sourced({ min: 24, max: 34 }), [{ logicalLayoutId: "layout", layoutHash }]);
    expect(() => compareSimulationWhatIf({ beforeInput: before, afterInput: after, beforeThermal: thermal({ lo: 35, hi: 45 }), afterThermal: thermal({ lo: 39, hi: 49 }), beforeAcoustic: acoustic({ lo: 28, hi: 32 }), afterAcoustic: acoustic({ lo: 28, hi: 32 }) }))
      .toThrow(/changed the locked environment/);
  });
});
