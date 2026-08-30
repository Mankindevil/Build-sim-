import type { EvidenceLevel } from "../core/evidence";
import { assertRange, type FanCurve, type FanOperatingPoint, type NumericRange } from "./types";

/**
 * Broad model-default curve used only to expose an explicit planning interval
 * when an installed fan has no governed P-Q curve. Callers must retain a
 * blocked reason; this curve is never evidence that the cooling target passes.
 */
export function inferredPlanningFanCurve(edgeId: string): FanCurve {
  if (!edgeId) throw new TypeError("inferred fan edge identity required");
  return {
    curveId: `inferred-planning:${edgeId}`,
    uncertaintyFraction: 0.45,
    points: [
      { airflowCfm: 0, staticPressurePa: 80, rpm: 500 },
      { airflowCfm: 45, staticPressurePa: 28, rpm: 1_200 },
      { airflowCfm: 110, staticPressurePa: 0, rpm: 2_400 },
    ],
    provenance: {
      evidence: "unknown",
      sourceRefs: [],
      assumptions: ["broad planning fan curve from the locked simulation model; exact fan P-Q evidence is missing"],
    },
  };
}

function validateCurve(curve: FanCurve): void {
  if (!curve.curveId || curve.points.length < 2 || !Number.isFinite(curve.uncertaintyFraction)
    || curve.uncertaintyFraction < 0 || curve.uncertaintyFraction >= 1) throw new TypeError("fan curve invalid");
  for (let index = 0; index < curve.points.length; index += 1) {
    const point = curve.points[index]!;
    if (![point.airflowCfm, point.staticPressurePa, point.rpm].every((value) => Number.isFinite(value) && value >= 0)) {
      throw new TypeError("fan curve point invalid");
    }
    if (index > 0) {
      const previous = curve.points[index - 1]!;
      if (point.airflowCfm <= previous.airflowCfm || point.staticPressurePa > previous.staticPressurePa || point.rpm < previous.rpm) {
        throw new TypeError("fan curve must have increasing airflow and nonincreasing pressure");
      }
    }
  }
}

function interpolate(curve: FanCurve, airflowCfm: number): { pressurePa: number; rpm: number } {
  const points = curve.points;
  if (airflowCfm <= points[0]!.airflowCfm) return { pressurePa: points[0]!.staticPressurePa, rpm: points[0]!.rpm };
  if (airflowCfm >= points.at(-1)!.airflowCfm) return { pressurePa: points.at(-1)!.staticPressurePa, rpm: points.at(-1)!.rpm };
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1]!;
    const right = points[index]!;
    if (airflowCfm > right.airflowCfm) continue;
    const fraction = (airflowCfm - left.airflowCfm) / (right.airflowCfm - left.airflowCfm);
    return {
      pressurePa: left.staticPressurePa + (right.staticPressurePa - left.staticPressurePa) * fraction,
      rpm: left.rpm + (right.rpm - left.rpm) * fraction,
    };
  }
  throw new TypeError("fan curve interpolation failed");
}

function intersect(curve: FanCurve, resistance: number): { airflowCfm: number; pressurePa: number; rpm: number } {
  const maximum = curve.points.at(-1)!.airflowCfm;
  let low = 0;
  let high = maximum;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const mid = (low + high) / 2;
    const point = interpolate(curve, mid);
    const systemPressure = resistance * mid * mid;
    if (point.pressurePa > systemPressure) low = mid;
    else high = mid;
  }
  const airflowCfm = (low + high) / 2;
  const point = interpolate(curve, airflowCfm);
  return { airflowCfm, pressurePa: point.pressurePa, rpm: point.rpm };
}

function evidence(curve: FanCurve): EvidenceLevel {
  return curve.provenance.evidence;
}

export function solveFanOperatingPoint(edgeId: string, curve: FanCurve, systemResistance: NumericRange): FanOperatingPoint {
  validateCurve(curve);
  assertRange(systemResistance, "system resistance", { nonnegative: true });
  const best = intersect(curve, systemResistance.lo);
  const worst = intersect(curve, systemResistance.hi);
  const uncertainty = curve.uncertaintyFraction;
  const airflowCfm = {
    lo: Math.max(0, worst.airflowCfm * (1 - uncertainty)),
    hi: best.airflowCfm * (1 + uncertainty),
  };
  const pressurePa = {
    lo: Math.min(worst.pressurePa, best.pressurePa) * (1 - uncertainty),
    hi: Math.max(worst.pressurePa, best.pressurePa) * (1 + uncertainty),
  };
  const rpm = {
    lo: Math.min(worst.rpm, best.rpm) * (1 - uncertainty),
    hi: Math.max(worst.rpm, best.rpm) * (1 + uncertainty),
  };
  return {
    schemaVersion: "fan-operating-point-v1",
    edgeId,
    airflowCfm,
    staticPressurePa: pressurePa,
    rpm,
    evidence: evidence(curve),
    sourceRefs: [...curve.provenance.sourceRefs].sort(),
    assumptions: [...curve.provenance.assumptions, `system resistance ${systemResistance.lo}-${systemResistance.hi} Pa/CFM²`],
  };
}
