import type { PriceHistoryPoint } from "./contracts";
import type { CurrentPriceProjection } from "./policy";

export interface BuyWaitAdvice {
  readonly schemaVersion: "buy-wait-advice-v1";
  readonly recommendation: "buy" | "wait" | "buy_if_needed" | "unavailable";
  readonly confidence: "low" | "medium" | "high" | "unavailable";
  readonly currentPriceCny: number | null;
  readonly historicalPosition: number | null;
  readonly historyWindow: { readonly start: string; readonly end: string; readonly coverageDays: number; readonly sampleCount: number } | null;
  readonly validUntil: string | null;
  readonly triggerConditions: readonly string[];
  readonly counterEvidence: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly uncertainty: string;
}

export function adviseBuyOrWait(input: {
  readonly projection: CurrentPriceProjection;
  readonly history: readonly PriceHistoryPoint[];
  readonly replacementFriction: "low" | "medium" | "high";
}): BuyWaitAdvice {
  const current = input.projection.minCny;
  if (current === null) return {
    schemaVersion: "buy-wait-advice-v1", recommendation: "unavailable", confidence: "unavailable", currentPriceCny: null,
    historicalPosition: null, historyWindow: null, validUntil: null,
    triggerConditions: ["wait for a rechecked exact-variant new listing"], counterEvidence: [],
    evidenceRefs: [], uncertainty: "no current exact-variant new price is available; alternatives should be searched",
  };
  const points = input.history.filter((point) => point.skuId === input.projection.skuId
    && point.variantIdentityFactIds.join("\0") === input.projection.variantIdentityFactIds.join("\0"));
  const sampleCount = points.reduce((sum, point) => sum + point.sampleCount, 0);
  const start = points.length ? Math.min(...points.map((point) => Date.parse(point.bucketStart))) : Number.NaN;
  const end = points.length ? Math.max(...points.map((point) => Date.parse(point.bucketEnd))) : Number.NaN;
  const coverageDays = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.ceil((end - start) / 86_400_000)) : 0;
  const historicalMin = points.length ? Math.min(...points.map(({ minCny }) => minCny)) : null;
  const historicalMax = points.length ? Math.max(...points.map(({ maxCny }) => maxCny)) : null;
  const sufficient = sampleCount >= 3 && coverageDays >= 14 && historicalMin !== null && historicalMax !== null;
  const position = sufficient ? historicalMax === historicalMin ? 0.5 : Math.max(0, Math.min(1, (current - historicalMin) / (historicalMax - historicalMin))) : null;
  const recommendation = !sufficient ? "buy_if_needed"
    : position! <= 0.25 ? "buy"
      : position! >= 0.75 && input.replacementFriction !== "high" ? "wait" : "buy_if_needed";
  return {
    schemaVersion: "buy-wait-advice-v1",
    recommendation,
    confidence: sufficient ? input.projection.confidence === "high" ? "high" : "medium" : "low",
    currentPriceCny: current,
    historicalPosition: position,
    historyWindow: points.length ? { start: new Date(start).toISOString(), end: new Date(end).toISOString(), coverageDays, sampleCount } : null,
    validUntil: input.projection.validUntil,
    triggerConditions: recommendation === "wait" ? ["buy if the exact-variant current price enters the lower 25% of the observed window"]
      : ["recheck exact variant, stock, warranty and seller tier before purchase"],
    counterEvidence: [
      ...(input.projection.riskTags.length ? [`current listings carry: ${input.projection.riskTags.join(", ")}`] : []),
      ...(input.replacementFriction === "high" ? ["delaying a stable skeleton component may increase replacement friction"] : []),
    ],
    evidenceRefs: points.map(({ historyPointId }) => `price-history:${historyPointId}`).sort(),
    uncertainty: sufficient
      ? "historical position describes only the observed exact variant and window; it is not a forecast"
      : "history coverage is insufficient; no historical-low or abnormal-cycle claim is made",
  };
}
