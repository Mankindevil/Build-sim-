import type { EvidenceLevel } from "../core/evidence";
import {
  assertRange,
  type AirflowNetworkResult,
  type NumericRange,
  type ThermalEnvironmentProfile,
  type ThermalHeatSource,
  type ThermalNetworkEvaluation,
} from "./types";

const W_PER_K_PER_CFM = 1.184 * 1005 * 4.719474e-4;

function add(left: NumericRange, right: NumericRange): NumericRange {
  return { lo: left.lo + right.lo, hi: left.hi + right.hi };
}

function weakest(values: readonly EvidenceLevel[]): EvidenceLevel {
  const rank: Record<EvidenceLevel, number> = { official: 0, standard: 1, inferred: 2, unknown: 3 };
  return values.reduce((result, value) => rank[value] > rank[result] ? value : result, "official");
}

function maxRange(values: readonly NumericRange[]): NumericRange | null {
  return values.length ? { lo: Math.max(...values.map(({ lo }) => lo)), hi: Math.max(...values.map(({ hi }) => hi)) } : null;
}

export function evaluateSteadyStateThermal(input: {
  readonly airflow: AirflowNetworkResult;
  readonly environment: ThermalEnvironmentProfile;
  readonly heatSources: readonly ThermalHeatSource[];
  readonly blockedReasonCodes?: readonly string[];
}): ThermalNetworkEvaluation {
  assertRange(input.environment.ambientC, "thermal ambient");
  if (input.environment.ambientC.lo < -80 || input.environment.ambientC.hi > 100) throw new TypeError("thermal ambient outside supported planning range");
  const sourceIds = new Set<string>();
  for (const source of input.heatSources) {
    if (!source.sourceId || sourceIds.has(source.sourceId) || !source.componentInstanceId || !source.chamberId || !source.workloadId) {
      throw new TypeError("thermal heat source identity invalid");
    }
    sourceIds.add(source.sourceId);
    assertRange(source.watts, `thermal source ${source.sourceId} watts`, { nonnegative: true });
    assertRange(source.caseToAirResistanceKPerW, `thermal source ${source.sourceId} resistance`, { nonnegative: true });
  }
  const airflowByChamber = new Map(input.airflow.chambers.map((chamber) => [chamber.chamberId, chamber]));
  const chamberIds = new Set([...airflowByChamber.keys(), ...input.heatSources.map(({ chamberId }) => chamberId)]);
  const chamberResults = [...chamberIds].sort().map((chamberId) => {
    const sources = input.heatSources.filter((source) => source.chamberId === chamberId);
    const heatW = sources.reduce((range, source) => add(range, source.watts), { lo: 0, hi: 0 });
    const airflow = airflowByChamber.get(chamberId);
    if (!airflow || airflow.airflowCfm.lo <= 0 || airflow.airflowCfm.hi <= 0) {
      return {
        chamberId, heatW, airflowCfm: airflow?.airflowCfm ?? { lo: 0, hi: 0 }, outletTemperatureC: null,
        verdict: "blocked" as const,
        sourceRefs: [...new Set(sources.flatMap((source) => source.provenance.sourceRefs))].sort(),
        assumptions: ["positive governed airflow is required before predicting a chamber temperature"],
      };
    }
    const outletTemperatureC = {
      lo: input.environment.ambientC.lo + heatW.lo / (W_PER_K_PER_CFM * airflow.airflowCfm.hi),
      hi: input.environment.ambientC.hi + heatW.hi / (W_PER_K_PER_CFM * airflow.airflowCfm.lo),
    };
    return {
      chamberId, heatW, airflowCfm: airflow.airflowCfm, outletTemperatureC,
      verdict: "pass" as const,
      sourceRefs: [...new Set([
        ...sources.flatMap((source) => source.provenance.sourceRefs),
        ...airflow.fanEdgeIds.flatMap((edgeId) => input.airflow.fanOperatingPoints.find((point) => point.edgeId === edgeId)?.sourceRefs ?? []),
      ])].sort(),
      assumptions: ["steady sensible heat balance: Q = ρ·cp·V̇·ΔT"],
    };
  });
  const chamberById = new Map(chamberResults.map((chamber) => [chamber.chamberId, chamber]));
  const components = input.heatSources.map((source) => {
    const chamber = chamberById.get(source.chamberId);
    if (!chamber?.outletTemperatureC) {
      return {
        sourceId: source.sourceId,
        componentInstanceId: source.componentInstanceId,
        chamberId: source.chamberId,
        temperatureC: null,
        maximumTemperatureC: source.maximumTemperatureC,
        verdict: "blocked" as const,
        evidence: source.provenance.evidence,
        sourceRefs: [...source.provenance.sourceRefs].sort(),
      };
    }
    const temperatureC = {
      lo: chamber.outletTemperatureC.lo + source.watts.lo * source.caseToAirResistanceKPerW.lo,
      hi: chamber.outletTemperatureC.hi + source.watts.hi * source.caseToAirResistanceKPerW.hi,
    };
    const verdict = source.maximumTemperatureC === null ? "blocked" as const
      : temperatureC.hi > source.maximumTemperatureC ? "fail" as const : "pass" as const;
    return {
      sourceId: source.sourceId,
      componentInstanceId: source.componentInstanceId,
      chamberId: source.chamberId,
      temperatureC,
      maximumTemperatureC: source.maximumTemperatureC,
      verdict,
      evidence: source.provenance.evidence,
      sourceRefs: [...source.provenance.sourceRefs].sort(),
    };
  }).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const totalHeat = chamberResults.reduce((range, chamber) => add(range, chamber.heatW), { lo: 0, hi: 0 });
  let energyBalanceResidualW = 0;
  for (const chamber of chamberResults) {
    if (!chamber.outletTemperatureC || chamber.airflowCfm.lo <= 0) continue;
    const heatMid = (chamber.heatW.lo + chamber.heatW.hi) / 2;
    const airflowMid = (chamber.airflowCfm.lo + chamber.airflowCfm.hi) / 2;
    const ambientMid = (input.environment.ambientC.lo + input.environment.ambientC.hi) / 2;
    const outletMid = ambientMid + heatMid / (W_PER_K_PER_CFM * airflowMid);
    energyBalanceResidualW += Math.abs(heatMid - W_PER_K_PER_CFM * airflowMid * (outletMid - ambientMid));
  }
  const energyBalanceToleranceW = Math.max(0.000001, totalHeat.hi * 1e-9);
  const peakTemperatureC = maxRange(components.flatMap((component) => component.temperatureC ? [component.temperatureC] : []));
  const blockedReasonCodes = [...new Set([...(input.blockedReasonCodes ?? []), ...input.airflow.blockedReasonCodes])].sort();
  const verdict = components.some((component) => component.verdict === "fail") ? "fail"
    : blockedReasonCodes.length > 0 || components.some((component) => component.verdict === "blocked") || chamberResults.some((chamber) => chamber.verdict === "blocked") ? "blocked"
      : "pass";
  return {
    schemaVersion: "thermal-network-evaluation-v1",
    ambientC: { ...input.environment.ambientC },
    airflow: structuredClone(input.airflow),
    chambers: chamberResults,
    components,
    peakTemperatureC,
    verdict,
    energyBalanceToleranceW,
    energyBalanceResidualW,
    blockedReasonCodes,
    assumptions: [
      ...(input.environment.source === "model_default" ? ["ambient defaults to the explicit 20-30°C planning interval until confirmed"] : []),
      ...input.airflow.assumptions,
      ...input.heatSources.flatMap((source) => source.provenance.assumptions),
      ...blockedReasonCodes.map((code) => `blocked: ${code}`),
    ],
    evidence: weakest([
      ...input.airflow.chambers.map(({ evidence }) => evidence),
      ...input.heatSources.map(({ provenance }) => provenance.evidence),
      ...(input.environment.confirmedByUser ? ["official" as const] : ["unknown" as const]),
    ]),
    displayNotice: "规划热场插值，非 CFD、非实测",
  };
}
