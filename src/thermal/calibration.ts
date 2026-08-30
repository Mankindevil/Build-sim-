import type { NumericRange, ThermalNetworkEvaluation } from "./types";

export interface ThermalCalibrationObservation {
  readonly observationId: string;
  readonly planId: string;
  readonly componentInstanceId: string | null;
  readonly workloadId: string;
  readonly kind: "ambient_c" | "fan_rpm" | "component_temperature_c";
  readonly value: number;
  readonly uncertaintyPlusMinus: number;
  readonly method: string;
  readonly observedAt: string;
  readonly status: "active" | "retracted";
}

export interface ThermalCalibrationResult {
  readonly schemaVersion: "thermal-calibration-result-v1";
  readonly planId: string;
  readonly workloadId: string;
  readonly evaluation: ThermalNetworkEvaluation;
  readonly appliedObservationIds: readonly string[];
  readonly rejectedObservationIds: readonly string[];
}

function observationRange(observation: ThermalCalibrationObservation): NumericRange {
  if (!Number.isFinite(observation.value) || !Number.isFinite(observation.uncertaintyPlusMinus) || observation.uncertaintyPlusMinus < 0) {
    throw new TypeError("thermal calibration observation value invalid");
  }
  return { lo: observation.value - observation.uncertaintyPlusMinus, hi: observation.value + observation.uncertaintyPlusMinus };
}

function intersection(left: NumericRange, right: NumericRange): NumericRange | null {
  const lo = Math.max(left.lo, right.lo);
  const hi = Math.min(left.hi, right.hi);
  return lo <= hi ? { lo, hi } : null;
}

export function calibrateThermalEvaluation(input: {
  readonly evaluation: ThermalNetworkEvaluation;
  readonly planId: string;
  readonly workloadId: string;
  readonly observations: readonly ThermalCalibrationObservation[];
}): ThermalCalibrationResult {
  const appliedObservationIds: string[] = [];
  const rejectedObservationIds: string[] = [];
  const active = input.observations.filter((observation) => {
    if (!observation.observationId || !observation.method || !Number.isFinite(Date.parse(observation.observedAt))) {
      throw new TypeError("thermal calibration observation identity invalid");
    }
    const applicable = observation.status === "active" && observation.planId === input.planId && observation.workloadId === input.workloadId;
    if (!applicable) rejectedObservationIds.push(observation.observationId);
    return applicable;
  });
  const evaluation = structuredClone(input.evaluation);
  for (const observation of active.filter(({ kind }) => kind === "ambient_c")) {
    const narrowed = intersection(evaluation.ambientC, observationRange(observation));
    if (!narrowed) { rejectedObservationIds.push(observation.observationId); continue; }
    const oldAmbient = evaluation.ambientC;
    for (const chamber of evaluation.chambers) if (chamber.outletTemperatureC) {
      const rise = { lo: chamber.outletTemperatureC.lo - oldAmbient.lo, hi: chamber.outletTemperatureC.hi - oldAmbient.hi };
      (chamber as { outletTemperatureC: NumericRange }).outletTemperatureC = { lo: narrowed.lo + rise.lo, hi: narrowed.hi + rise.hi };
    }
    for (const component of evaluation.components) if (component.temperatureC) {
      const rise = { lo: component.temperatureC.lo - oldAmbient.lo, hi: component.temperatureC.hi - oldAmbient.hi };
      (component as { temperatureC: NumericRange }).temperatureC = { lo: narrowed.lo + rise.lo, hi: narrowed.hi + rise.hi };
    }
    (evaluation as { ambientC: NumericRange }).ambientC = narrowed;
    appliedObservationIds.push(observation.observationId);
  }
  for (const observation of active.filter(({ kind }) => kind === "fan_rpm")) {
    const point = evaluation.airflow.fanOperatingPoints.find(({ edgeId }) => edgeId === observation.componentInstanceId);
    const narrowed = point ? intersection(point.rpm, observationRange(observation)) : null;
    if (!point || !narrowed) { rejectedObservationIds.push(observation.observationId); continue; }
    (point as { rpm: NumericRange }).rpm = narrowed;
    appliedObservationIds.push(observation.observationId);
  }
  for (const observation of active.filter(({ kind }) => kind === "component_temperature_c")) {
    const component = evaluation.components.find(({ componentInstanceId }) => componentInstanceId === observation.componentInstanceId);
    const narrowed = component?.temperatureC ? intersection(component.temperatureC, observationRange(observation)) : null;
    if (!component || !narrowed) { rejectedObservationIds.push(observation.observationId); continue; }
    (component as { temperatureC: NumericRange }).temperatureC = narrowed;
    appliedObservationIds.push(observation.observationId);
  }
  const ranges = evaluation.components.flatMap((component) => component.temperatureC ? [component.temperatureC] : []);
  (evaluation as { peakTemperatureC: NumericRange | null }).peakTemperatureC = ranges.length
    ? { lo: Math.max(...ranges.map(({ lo }) => lo)), hi: Math.max(...ranges.map(({ hi }) => hi)) } : null;
  (evaluation as { assumptions: readonly string[] }).assumptions = [
    ...evaluation.assumptions,
    ...appliedObservationIds.map((id) => `plan-scoped calibration observation ${id}`),
  ];
  return {
    schemaVersion: "thermal-calibration-result-v1",
    planId: input.planId,
    workloadId: input.workloadId,
    evaluation,
    appliedObservationIds: [...new Set(appliedObservationIds)].sort(),
    rejectedObservationIds: [...new Set(rejectedObservationIds)].sort(),
  };
}
