import { assertRange, type NumericRange } from "../thermal/types";
import { normalizeSoundPressureDistance } from "./normalize";
import type { AcousticCurve, NormalizedAcousticSource } from "./types";

function interpolate(left: NumericRange, right: NumericRange, fraction: number): NumericRange {
  return { lo: left.lo + (right.lo - left.lo) * fraction, hi: left.hi + (right.hi - left.hi) * fraction };
}

export function acousticSourceAtOperatingPoint(curve: AcousticCurve, rpm: NumericRange): NormalizedAcousticSource {
  assertRange(rpm, "acoustic operating rpm", { nonnegative: true });
  if (!curve.curveId || !curve.componentInstanceId || curve.weighting !== "A" || curve.points.length < 2
    || !curve.loadId || !curve.testMethodId || curve.sourceRefs.length === 0) throw new TypeError("acoustic curve invalid");
  curve.points.forEach((point, index) => {
    assertRange(point.soundPressureDba, "acoustic curve point");
    if (!Number.isFinite(point.rpm) || point.rpm < 0 || (index > 0 && point.rpm <= curve.points[index - 1]!.rpm)) throw new TypeError("acoustic curve rpm invalid");
  });
  const at = (value: number): NumericRange => {
    if (value <= curve.points[0]!.rpm) return curve.points[0]!.soundPressureDba;
    if (value >= curve.points.at(-1)!.rpm) return curve.points.at(-1)!.soundPressureDba;
    for (let index = 1; index < curve.points.length; index += 1) {
      const left = curve.points[index - 1]!;
      const right = curve.points[index]!;
      if (value <= right.rpm) return interpolate(left.soundPressureDba, right.soundPressureDba, (value - left.rpm) / (right.rpm - left.rpm));
    }
    throw new TypeError("acoustic curve interpolation failed");
  };
  const low = at(rpm.lo);
  const high = at(rpm.hi);
  return {
    sourceId: curve.curveId,
    componentInstanceId: curve.componentInstanceId,
    soundPressureDbaAt1M: normalizeSoundPressureDistance({ lo: Math.min(low.lo, high.lo), hi: Math.max(low.hi, high.hi) }, curve.referenceDistanceM, 1),
    loadId: curve.loadId,
    rpm: { ...rpm },
    testMethodId: curve.testMethodId,
    sourceRefs: [...curve.sourceRefs].sort(),
    evidence: curve.evidence,
  };
}
