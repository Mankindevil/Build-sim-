import { assertRange, type NumericRange } from "../thermal/types";
import type { AcousticSourceFact, NormalizedAcousticSource } from "./types";

/** Free-field distance normalization only; no room or case attenuation model. */
export function normalizeSoundPressureDistance(levelDba: NumericRange, fromDistanceM: number, toDistanceM = 1): NumericRange {
  assertRange(levelDba, "sound pressure");
  if (![fromDistanceM, toDistanceM].every((value) => Number.isFinite(value) && value > 0)) throw new TypeError("acoustic reference distance invalid");
  const adjustment = 20 * Math.log10(fromDistanceM / toDistanceM);
  return { lo: levelDba.lo + adjustment, hi: levelDba.hi + adjustment };
}

export function normalizeAcousticSource(source: AcousticSourceFact): NormalizedAcousticSource {
  if (!source.sourceId || !source.componentInstanceId || source.weighting !== "A" || !source.loadId || !source.testMethodId
    || source.sourceRefs.length === 0 || new Set(source.sourceRefs).size !== source.sourceRefs.length) throw new TypeError("acoustic source identity invalid");
  assertRange(source.rpm, "acoustic source rpm", { nonnegative: true });
  return {
    sourceId: source.sourceId,
    componentInstanceId: source.componentInstanceId,
    soundPressureDbaAt1M: normalizeSoundPressureDistance(source.soundPressureDba, source.referenceDistanceM, 1),
    loadId: source.loadId,
    rpm: { ...source.rpm },
    testMethodId: source.testMethodId,
    sourceRefs: [...source.sourceRefs].sort(),
    evidence: source.evidence,
  };
}
