import type { EvidenceLevel } from "../core/evidence";
import type { NumericRange } from "../thermal/types";
import type { AcousticEvaluation, CoilWhineRisk, NormalizedAcousticSource } from "./types";

function energeticSum(values: readonly number[]): number {
  return 10 * Math.log10(values.reduce((sum, value) => sum + 10 ** (value / 10), 0));
}

function level(total: NumericRange | null): AcousticEvaluation["level"] {
  if (!total) return "unknown";
  if (total.hi < 25) return "quiet";
  if (total.hi < 35) return "normal";
  if (total.hi < 45) return "audible";
  return "loud";
}

function weakest(values: readonly EvidenceLevel[]): EvidenceLevel {
  const rank: Record<EvidenceLevel, number> = { official: 0, standard: 1, inferred: 2, unknown: 3 };
  return values.reduce((result, value) => rank[value] > rank[result] ? value : result, "official");
}

export function aggregateAcousticSources(input: {
  readonly sources: readonly NormalizedAcousticSource[];
  readonly loadId: string;
  readonly testMethodId: string;
  readonly maximumDba?: number;
  readonly coilWhineRisks?: readonly CoilWhineRisk[];
  readonly blockedReasonCodes?: readonly string[];
  readonly assumptions?: readonly string[];
}): AcousticEvaluation {
  if (!input.loadId || !input.testMethodId || (input.maximumDba !== undefined && !Number.isFinite(input.maximumDba))) {
    throw new TypeError("acoustic aggregate context invalid");
  }
  const comparable = input.sources.filter((source) => source.loadId === input.loadId && source.testMethodId === input.testMethodId);
  const excludedSourceIds = input.sources.filter((source) => !comparable.includes(source)).map(({ sourceId }) => sourceId).sort();
  const totalDba = comparable.length ? {
    lo: energeticSum(comparable.map(({ soundPressureDbaAt1M }) => soundPressureDbaAt1M.lo)),
    hi: energeticSum(comparable.map(({ soundPressureDbaAt1M }) => soundPressureDbaAt1M.hi)),
  } : null;
  const totalUpperEnergy = comparable.reduce((sum, source) => sum + 10 ** (source.soundPressureDbaAt1M.hi / 10), 0);
  const contributions = comparable.map((source) => ({
    sourceId: source.sourceId,
    componentInstanceId: source.componentInstanceId,
    soundPressureDbaAt1M: { ...source.soundPressureDbaAt1M },
    shareOfUpperEnergy: totalUpperEnergy > 0 ? 10 ** (source.soundPressureDbaAt1M.hi / 10) / totalUpperEnergy : 0,
    evidence: source.evidence,
    sourceRefs: [...source.sourceRefs],
  })).sort((left, right) => right.shareOfUpperEnergy - left.shareOfUpperEnergy || left.sourceId.localeCompare(right.sourceId));
  const blockedReasonCodes = [...new Set(input.blockedReasonCodes ?? [])].sort();
  const verdict = blockedReasonCodes.length > 0 || totalDba === null || comparable.some(({ evidence }) => evidence === "unknown") ? "blocked"
    : input.maximumDba !== undefined && totalDba.hi > input.maximumDba ? "fail" : "pass";
  return {
    schemaVersion: "acoustic-evaluation-v1",
    referenceDistanceM: 1,
    loadId: input.loadId,
    testMethodId: input.testMethodId,
    totalDba,
    level: level(totalDba),
    verdict,
    blockedReasonCodes,
    contributions,
    excludedSourceIds,
    coilWhineRisks: structuredClone(input.coilWhineRisks ?? []),
    assumptions: [
      "only A-weighted hardware sources normalized to 1 metre with the same load and test method are energetically summed",
      `aggregate evidence: ${weakest(comparable.map(({ evidence }) => evidence))}`,
      "room response, case attenuation, resonance and listener position are excluded",
      ...[...new Set(input.assumptions ?? [])].sort(),
      ...blockedReasonCodes.map((code) => `blocked: ${code}`),
    ],
    displayNotice: "标准化硬件声源结果，不代表房间或用户位置的实际噪音",
  };
}
