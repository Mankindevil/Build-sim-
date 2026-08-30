import { describe, expect, it } from "vitest";
import { calibrateThermalEvaluation, type ThermalCalibrationObservation } from "../src/thermal/calibration";
import { solveAirflowNetwork } from "../src/thermal/airflow-graph";
import { evaluateSteadyStateThermal } from "../src/thermal/steady-state";

function baseline() {
  const provenance = { evidence: "standard" as const, sourceRefs: ["standard:test"], assumptions: [] };
  return evaluateSteadyStateThermal({
    airflow: solveAirflowNetwork({
      schemaVersion: "airflow-network-v1",
      chambers: [{ chamberId: "main", label: "Main", volumeLitres: 30, maximumTemperatureC: 70, provenance }],
      edges: [
        { edgeId: "inlet", fromChamberId: null, toChamberId: "main", kind: "opening", enabled: true, resistancePaPerCfm2: { lo: 0.002, hi: 0.004 }, provenance },
        {
          edgeId: "fan-1", fromChamberId: "main", toChamberId: null, kind: "fan", enabled: true,
          resistancePaPerCfm2: { lo: 0.004, hi: 0.008 }, provenance,
          fanCurve: { curveId: "curve", uncertaintyFraction: 0.1, provenance, points: [
            { airflowCfm: 0, staticPressurePa: 60, rpm: 500 },
            { airflowCfm: 70, staticPressurePa: 0, rpm: 1600 },
          ] },
        },
      ],
    }),
    environment: { ambientC: { lo: 20, hi: 30 }, source: "model_default", sourceRef: "model:ambient", confirmedByUser: false },
    heatSources: [{
      sourceId: "cpu-heat", componentInstanceId: "cpu-1", chamberId: "main", workloadId: "balanced",
      watts: { lo: 60, hi: 100 }, caseToAirResistanceKPerW: { lo: 0.1, hi: 0.2 }, maximumTemperatureC: 95,
      provenance: { evidence: "inferred", sourceRefs: ["fact:cpu-power"], assumptions: [] },
    }],
  });
}

function observation(overrides: Partial<ThermalCalibrationObservation> = {}): ThermalCalibrationObservation {
  return {
    observationId: "obs-ambient", planId: "plan-a", componentInstanceId: null, workloadId: "balanced",
    kind: "ambient_c", value: 24, uncertaintyPlusMinus: 1, method: "calibrated-sensor",
    observedAt: "2026-08-29T10:00:00.000Z", status: "active", ...overrides,
  };
}

describe("U9 plan-scoped thermal calibration", () => {
  it("narrows only matching active plan/workload observations", () => {
    const original = baseline();
    const calibrated = calibrateThermalEvaluation({
      evaluation: original, planId: "plan-a", workloadId: "balanced",
      observations: [observation(), observation({ observationId: "other-plan", planId: "plan-b" })],
    });
    expect(calibrated.evaluation.ambientC).toEqual({ lo: 23, hi: 25 });
    expect(calibrated.evaluation.peakTemperatureC!.hi).toBeLessThan(original.peakTemperatureC!.hi);
    expect(calibrated.appliedObservationIds).toEqual(["obs-ambient"]);
    expect(calibrated.rejectedObservationIds).toEqual(["other-plan"]);
  });

  it("restores the uncalibrated interval after the observation is retracted", () => {
    const original = baseline();
    const result = calibrateThermalEvaluation({
      evaluation: original, planId: "plan-a", workloadId: "balanced",
      observations: [observation({ status: "retracted" })],
    });
    expect(result.evaluation).toEqual(original);
    expect(result.appliedObservationIds).toEqual([]);
    expect(result.rejectedObservationIds).toEqual(["obs-ambient"]);
  });
});
