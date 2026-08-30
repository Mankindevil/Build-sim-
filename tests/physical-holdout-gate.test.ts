import { describe, expect, it } from "vitest";
import {
  createPhysicalHoldoutDataset,
  validatePhysicalHoldoutDataset,
  validatePhysicalHoldoutReleaseSet,
  type PhysicalHoldoutLayout,
  type PhysicalHoldoutMaterial,
} from "../src/release/physical-holdout";

const hash = (character: string): string => character.repeat(64);

function material(layout: PhysicalHoldoutLayout, index: number): PhysicalHoldoutMaterial {
  return {
    schemaVersion: "physical-holdout-v1",
    holdoutId: `holdout-${layout}-${index}`,
    layout,
    tuningStatus: "not_used_for_tuning",
    caseIdentity: { skuId: `case.fixture-${layout}`, modelId: `fixture-${layout}`, revision: "r1", region: "global" },
    authority: {
      planId: `plan-holdout-${index}`,
      planVersionId: `version-holdout-${index}`,
      configHash: hash("a"),
      evaluationHash: hash("b"),
      adapterSnapshotHash: hash("c"),
      simulationInputHash: hash("d"),
    },
    method: {
      protocolId: "protocol.holdout-v1",
      instrumentId: `instrument-${index}`,
      instrumentCalibrationRef: `calibration-${index}`,
      operatorId: `operator-${index}`,
      capturedAt: "2026-08-30T12:00:00.000Z",
    },
    measurements: {
      clearances: [{
        measurementId: `clearance-${index}`, instanceId: `gpu-${index}`, referenceId: `side-panel-${index}`,
        predictedMm: { lo: 10, hi: 14 }, measuredMm: 12, uncertaintyMm: 1,
      }],
      cableLengths: [{
        measurementId: `cable-${index}`, cableInstanceId: `cable-instance-${index}`,
        fromEndpointId: `source-port-${index}`, toEndpointId: `sink-port-${index}`,
        suggestedMm: 500, measuredRequiredMm: 470, uncertaintyMm: 10,
      }],
      temperatures: [{
        measurementId: `temperature-${index}`, componentInstanceId: `cpu-${index}`, workloadId: `workload-${index}`,
        ambientC: 25, predictedC: { lo: 60, hi: 75 }, measuredC: 68, uncertaintyC: 2,
      }],
      acoustics: [{
        measurementId: `acoustic-${index}`, sourceInstanceId: `system-${index}`, workloadId: `workload-${index}`,
        testMethodId: "method.standardized-hardware", referenceDistanceM: 1,
        predictedDba: { lo: 30, hi: 36 }, measuredDba: 33, uncertaintyDba: 1,
      }],
    },
  };
}

describe("U12 independent physical holdout gate", () => {
  it("requires independent ATX, Mini-ITX, and NAS datasets with complete measured intervals", async () => {
    const datasets = await Promise.all((["atx", "mini_itx", "nas"] as const)
      .map((layout, index) => createPhysicalHoldoutDataset(material(layout, index + 1))));
    await expect(validatePhysicalHoldoutReleaseSet(datasets)).resolves.toMatchObject({
      status: "pass",
      layouts: ["atx", "mini_itx", "nas"],
      errors: [],
    });
  });

  it("fails closed on tuning reuse, forged hashes, optimistic cable length, or out-of-range measurements", async () => {
    const valid = await createPhysicalHoldoutDataset(material("atx", 1));
    const hostile = structuredClone(valid) as unknown as Record<string, any>;
    hostile.tuningStatus = "used_for_tuning";
    hostile.measurements.cableLengths[0].suggestedMm = 450;
    hostile.measurements.temperatures[0].measuredC = 90;
    hostile.measurements.acoustics[0].measuredDba = 45;
    expect(await validatePhysicalHoldoutDataset(hostile)).toEqual(expect.arrayContaining([
      "holdout was used for tuning",
      "holdout contentHash mismatch",
      "holdout cable cable-1 is shorter than the measured requirement",
      "holdout temperature temperature-1 is outside the predicted interval",
      "holdout acoustic acoustic-1 is outside the predicted interval",
    ]));
    await expect(validatePhysicalHoldoutReleaseSet([valid])).resolves.toMatchObject({
      status: "blocked",
      errors: expect.arrayContaining(["missing independent mini_itx holdout", "missing independent nas holdout"]),
    });
  });
});
