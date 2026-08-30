import type { EvidenceLevel } from "../core/evidence";
import type { NumericRange } from "../thermal/types";

export interface AcousticSourceFact {
  readonly sourceId: string;
  readonly componentInstanceId: string;
  readonly soundPressureDba: NumericRange;
  readonly weighting: "A";
  readonly referenceDistanceM: number;
  readonly loadId: string;
  readonly rpm: NumericRange;
  readonly testMethodId: string;
  readonly sourceRefs: readonly string[];
  readonly evidence: EvidenceLevel;
}

export interface AcousticCurvePoint {
  readonly rpm: number;
  readonly soundPressureDba: NumericRange;
}

export interface AcousticCurve {
  readonly curveId: string;
  readonly componentInstanceId: string;
  readonly weighting: "A";
  readonly referenceDistanceM: number;
  readonly loadId: string;
  readonly testMethodId: string;
  readonly points: readonly AcousticCurvePoint[];
  readonly sourceRefs: readonly string[];
  readonly evidence: EvidenceLevel;
}

export interface NormalizedAcousticSource {
  readonly sourceId: string;
  readonly componentInstanceId: string;
  readonly soundPressureDbaAt1M: NumericRange;
  readonly loadId: string;
  readonly rpm: NumericRange;
  readonly testMethodId: string;
  readonly sourceRefs: readonly string[];
  readonly evidence: EvidenceLevel;
}

export interface CoilWhineRisk {
  readonly componentInstanceId: string;
  readonly risk: "unknown" | "reported" | "observed";
  readonly sourceRefs: readonly string[];
  readonly note: string;
}

export interface AcousticContribution {
  readonly sourceId: string;
  readonly componentInstanceId: string;
  readonly soundPressureDbaAt1M: NumericRange;
  readonly shareOfUpperEnergy: number;
  readonly evidence: EvidenceLevel;
  readonly sourceRefs: readonly string[];
}

export interface AcousticEvaluation {
  readonly schemaVersion: "acoustic-evaluation-v1";
  readonly referenceDistanceM: 1;
  readonly loadId: string;
  readonly testMethodId: string;
  readonly totalDba: NumericRange | null;
  readonly level: "quiet" | "normal" | "audible" | "loud" | "unknown";
  readonly verdict: "pass" | "fail" | "blocked";
  readonly blockedReasonCodes: readonly string[];
  readonly contributions: readonly AcousticContribution[];
  readonly excludedSourceIds: readonly string[];
  readonly coilWhineRisks: readonly CoilWhineRisk[];
  readonly assumptions: readonly string[];
  readonly displayNotice: "标准化硬件声源结果，不代表房间或用户位置的实际噪音";
}
