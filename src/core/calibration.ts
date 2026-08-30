import type { EvidenceLevel } from "./evidence";

/** Calibration can be captured manually without upgrading official/catalog evidence. */
export type CalibrationEvidence = EvidenceLevel | "manual";

export interface CalibrationMeasurement {
  value?: number | null;
  min?: number | null;
  max?: number | null;
  evidence: CalibrationEvidence;
  unit: string;
  source?: string | null;
}

export interface FanCurveCalibration {
  mode?: string | null;
  rpm?: number | null;
  cfm?: number | null;
  evidence: CalibrationEvidence;
  source?: string | null;
}

export interface CalibrationSnapshot {
  schemaVersion: "1.0.0";
  calibrationVersion: string;
  caseId: string;
  capturedAt?: string | null;
  source: string;
  provenance: string[];
  wallPowerW: CalibrationMeasurement;
  smartTemperatureC: CalibrationMeasurement;
  cpuTemperatureC: CalibrationMeasurement;
  gpuTemperatureC: CalibrationMeasurement;
  noiseDba: CalibrationMeasurement;
  fanCurve: FanCurveCalibration;
}

export interface CalibrationEvaluation {
  snapshot: CalibrationSnapshot;
  unknown: string[];
  provenance: string[];
  /** Raw planning ranges remain untouched; these are optional narrowed views. */
  narrowedRanges: Record<string, { lo: number; hi: number }>;
  hash: string;
}

export const CALIBRATION_RULESET_VERSION = "calibration-rules-1.0.0";

function tinyHash(value: unknown): string {
  const text = JSON.stringify(value, Object.keys(value as object).sort());
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Narrow a planning band only when both measured endpoints are present. */
export function narrowPlanningRange(
  key: string,
  planning: { lo: number; hi: number },
  measurement: CalibrationMeasurement | undefined,
): { lo: number; hi: number } {
  if (!measurement || measurement.evidence === "unknown") return planning;
  const measuredLo = measurement.min ?? measurement.value ?? null;
  const measuredHi = measurement.max ?? measurement.value ?? null;
  if (typeof measuredLo !== "number" || typeof measuredHi !== "number" || !Number.isFinite(measuredLo) || !Number.isFinite(measuredHi)) return planning;
  const lo = Math.max(planning.lo, Math.min(measuredLo, measuredHi));
  const hi = Math.min(planning.hi, Math.max(measuredLo, measuredHi));
  return lo <= hi ? { lo, hi } : planning;
}

export function evaluateCalibration(snapshot: CalibrationSnapshot): CalibrationEvaluation {
  const unknown: string[] = [];
  const measurements: [string, CalibrationMeasurement | undefined][] = [
    ["wallPowerW", snapshot.wallPowerW],
    ["smartTemperatureC", snapshot.smartTemperatureC],
    ["cpuTemperatureC", snapshot.cpuTemperatureC],
    ["gpuTemperatureC", snapshot.gpuTemperatureC],
    ["noiseDba", snapshot.noiseDba],
  ];
  for (const [key, measurement] of measurements) {
    if (!measurement || measurement.evidence === "unknown" || (measurement.value == null && measurement.min == null && measurement.max == null)) unknown.push(key);
  }
  if (snapshot.fanCurve.evidence === "unknown" || snapshot.fanCurve.cfm == null || snapshot.fanCurve.rpm == null) unknown.push("fanCurve");
  return {
    snapshot,
    unknown,
    provenance: snapshot.provenance,
    narrowedRanges: {},
    hash: tinyHash({ calibrationVersion: snapshot.calibrationVersion, snapshot }),
  };
}

export function calibrationWithRange(
  evaluation: CalibrationEvaluation,
  key: string,
  planning: { lo: number; hi: number },
  measurement: CalibrationMeasurement | undefined,
): CalibrationEvaluation {
  return {
    ...evaluation,
    narrowedRanges: { ...evaluation.narrowedRanges, [key]: narrowPlanningRange(key, planning, measurement) },
  };
}
