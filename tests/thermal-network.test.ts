import { describe, expect, it } from "vitest";
import { solveAirflowNetwork } from "../src/thermal/airflow-graph";
import { inferredPlanningFanCurve, solveFanOperatingPoint } from "../src/thermal/fan-operating-point";
import { evaluateSteadyStateThermal } from "../src/thermal/steady-state";
import type { AirflowNetwork, ThermalHeatSource } from "../src/thermal/types";

const provenance = { evidence: "standard" as const, sourceRefs: ["standard:fixture"], assumptions: [] };

function network(resistance = { lo: 0.004, hi: 0.008 }, fanEnabled = true): AirflowNetwork {
  return {
    schemaVersion: "airflow-network-v1",
    chambers: [{ chamberId: "main", label: "Main", volumeLitres: 42, maximumTemperatureC: 70, provenance }],
    edges: [
      { edgeId: "inlet", fromChamberId: null, toChamberId: "main", kind: "filter", resistancePaPerCfm2: resistance, enabled: true, provenance },
      {
        edgeId: "exhaust", fromChamberId: "main", toChamberId: null, kind: "fan",
        resistancePaPerCfm2: { lo: 0.001, hi: 0.002 }, enabled: fanEnabled, provenance,
        fanCurve: {
          curveId: "curve.fixture.120", uncertaintyFraction: 0.05, provenance,
          points: [
            { airflowCfm: 0, staticPressurePa: 80, rpm: 600 },
            { airflowCfm: 50, staticPressurePa: 40, rpm: 1100 },
            { airflowCfm: 90, staticPressurePa: 0, rpm: 1800 },
          ],
        },
      },
    ],
  };
}

function source(watts: { lo: number; hi: number }, maximumTemperatureC: number | null = 95): ThermalHeatSource {
  return {
    sourceId: "heat.cpu", componentInstanceId: "cpu-1", chamberId: "main", workloadId: "cpu-sustained",
    watts, caseToAirResistanceKPerW: { lo: 0.15, hi: 0.28 }, maximumTemperatureC,
    provenance: { evidence: "inferred", sourceRefs: ["fact:cpu.power"], assumptions: ["power interval comes from the selected workload"] },
  };
}

function evaluate(watts = { lo: 80, hi: 120 }, resistance = { lo: 0.004, hi: 0.008 }) {
  const airflow = solveAirflowNetwork(network(resistance));
  return evaluateSteadyStateThermal({
    airflow,
    environment: { ambientC: { lo: 20, hi: 30 }, source: "model_default", sourceRef: "model:ambient", confirmedByUser: false },
    heatSources: [source(watts)],
  });
}

describe("U9 generic airflow and steady-state thermal network", () => {
  it("closes the sensible-heat balance within the declared tolerance", () => {
    const result = evaluate();
    expect(result.energyBalanceResidualW).toBeLessThanOrEqual(result.energyBalanceToleranceW);
    expect(result.peakTemperatureC?.hi).toBeGreaterThan(result.ambientC.hi);
    expect(result.displayNotice).toBe("规划热场插值，非 CFD、非实测");
  });

  it("is monotonic when heat rises or airflow resistance increases", () => {
    const baseline = evaluate();
    const hotter = evaluate({ lo: 120, hi: 180 });
    const restricted = evaluate({ lo: 80, hi: 120 }, { lo: 0.02, hi: 0.04 });
    expect(hotter.peakTemperatureC!.hi).toBeGreaterThanOrEqual(baseline.peakTemperatureC!.hi);
    expect(restricted.airflow.chambers[0]!.airflowCfm.hi).toBeLessThan(baseline.airflow.chambers[0]!.airflowCfm.hi);
    expect(restricted.peakTemperatureC!.hi).toBeGreaterThanOrEqual(baseline.peakTemperatureC!.hi);
  });

  it("blocks rather than emitting a point temperature when airflow or a component limit is missing", () => {
    const noFan = solveAirflowNetwork(network({ lo: 0.004, hi: 0.008 }, false));
    const blocked = evaluateSteadyStateThermal({
      airflow: noFan,
      environment: { ambientC: { lo: 20, hi: 30 }, source: "model_default", sourceRef: "model:ambient", confirmedByUser: false },
      heatSources: [source({ lo: 80, hi: 120 })],
    });
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.chambers[0]?.outletTemperatureC).toBeNull();

    const missingLimit = evaluateSteadyStateThermal({
      airflow: solveAirflowNetwork(network()),
      environment: { ambientC: { lo: 20, hi: 30 }, source: "model_default", sourceRef: "model:ambient", confirmedByUser: false },
      heatSources: [source({ lo: 80, hi: 120 }, null)],
    });
    expect(missingLimit.components[0]).toMatchObject({ verdict: "blocked", maximumTemperatureC: null });
  });

  it("solves a generic chain containing openings, filters, radiators, heatsinks and leakage", () => {
    const passiveKinds = ["opening", "filter", "radiator", "heatsink", "leak"] as const;
    const chambers = passiveKinds.map((_, index) => ({
      chamberId: `chamber-${index}`, label: `Chamber ${index}`, volumeLitres: 10, maximumTemperatureC: 70, provenance,
    }));
    const edges: AirflowNetwork["edges"][number][] = passiveKinds.map((kind, index) => ({
      edgeId: `passive-${kind}`,
      fromChamberId: index === 0 ? null : `chamber-${index - 1}`,
      toChamberId: `chamber-${index}`,
      kind,
      resistancePaPerCfm2: { lo: 0.001, hi: 0.003 },
      enabled: true,
      provenance,
    }));
    const fanCurve = network().edges.find(({ kind }) => kind === "fan")?.fanCurve;
    if (fanCurve === undefined) throw new TypeError("fixture fan curve missing");
    edges.push({
      edgeId: "generic-exhaust", fromChamberId: chambers.at(-1)!.chamberId, toChamberId: null, kind: "fan",
      resistancePaPerCfm2: { lo: 0, hi: 0 }, enabled: true, provenance,
      fanCurve,
    });
    const result = solveAirflowNetwork({ schemaVersion: "airflow-network-v1", chambers, edges });
    expect(result.blockedReasonCodes).toEqual([]);
    expect(result.fanOperatingPoints).toHaveLength(1);
    expect(result.chambers.every(({ airflowCfm }) => airflowCfm.lo > 0)).toBe(true);
  });

  it("uses an explicit broad unknown interval when an exact fan curve is absent", () => {
    const curve = inferredPlanningFanCurve("fan-without-curve");
    const point = solveFanOperatingPoint("fan-without-curve", curve, { lo: 0.004, hi: 0.02 });
    expect(point.evidence).toBe("unknown");
    expect(point.airflowCfm.lo).toBeLessThan(point.airflowCfm.hi);
    expect(point.rpm.lo).toBeLessThan(point.rpm.hi);
    expect(point.assumptions.join(" ")).toContain("exact fan P-Q evidence is missing");
  });
});
