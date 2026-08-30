import type { PriceHistoryPoint } from "../price/contracts";

export interface MarketCycleAssessment {
  readonly schemaVersion: "market-cycle-assessment-v1";
  readonly basis: "local_history" | "same_generation_alternatives" | "release_cycle" | "agent_inference" | "insufficient";
  readonly confidence: "high" | "medium" | "low" | "unavailable";
  readonly status: "normal" | "abnormal" | "unknown";
  readonly evidenceRefs: readonly string[];
  readonly coverage: { readonly sampleCount: number; readonly coverageDays: number };
  readonly explanation: string;
}

export function assessMarketCycle(input: {
  readonly history: readonly PriceHistoryPoint[];
  readonly currentPriceCny: number | null;
  readonly sameGenerationAlternativeRefs?: readonly string[];
  readonly releaseCycleRefs?: readonly string[];
  readonly agentInferenceRef?: string;
}): MarketCycleAssessment {
  const sampleCount = input.history.reduce((sum, point) => sum + point.sampleCount, 0);
  const start = input.history.length ? Math.min(...input.history.map((point) => Date.parse(point.bucketStart))) : Number.NaN;
  const end = input.history.length ? Math.max(...input.history.map((point) => Date.parse(point.bucketEnd))) : Number.NaN;
  const coverageDays = Number.isFinite(start) && Number.isFinite(end) ? Math.ceil((end - start) / 86_400_000) : 0;
  if (input.currentPriceCny !== null && sampleCount >= 6 && coverageDays >= 30) {
    const low = Math.min(...input.history.map(({ minCny }) => minCny));
    const high = Math.max(...input.history.map(({ maxCny }) => maxCny));
    const abnormal = input.currentPriceCny < low * 0.7 || input.currentPriceCny > high * 1.3;
    return { schemaVersion: "market-cycle-assessment-v1", basis: "local_history", confidence: "high", status: abnormal ? "abnormal" : "normal", evidenceRefs: input.history.map(({ historyPointId }) => `price-history:${historyPointId}`).sort(), coverage: { sampleCount, coverageDays }, explanation: abnormal ? "current exact-variant price lies outside the governed historical band by more than 30%" : "current exact-variant price lies within the governed historical band" };
  }
  if ((input.sameGenerationAlternativeRefs?.length ?? 0) >= 2) return { schemaVersion: "market-cycle-assessment-v1", basis: "same_generation_alternatives", confidence: "medium", status: "unknown", evidenceRefs: [...input.sameGenerationAlternativeRefs!].sort(), coverage: { sampleCount, coverageDays }, explanation: "local history is sparse; same-generation alternatives are shown without declaring a market cycle" };
  if ((input.releaseCycleRefs?.length ?? 0) > 0) return { schemaVersion: "market-cycle-assessment-v1", basis: "release_cycle", confidence: "medium", status: "unknown", evidenceRefs: [...input.releaseCycleRefs!].sort(), coverage: { sampleCount, coverageDays }, explanation: "release-cycle evidence is available but does not prove the exact variant's historical price position" };
  if (input.agentInferenceRef) return { schemaVersion: "market-cycle-assessment-v1", basis: "agent_inference", confidence: "low", status: "unknown", evidenceRefs: [input.agentInferenceRef], coverage: { sampleCount, coverageDays }, explanation: "explicit inference only; no abnormal-cycle or best-time claim is made" };
  return { schemaVersion: "market-cycle-assessment-v1", basis: "insufficient", confidence: "unavailable", status: "unknown", evidenceRefs: [], coverage: { sampleCount, coverageDays }, explanation: "insufficient governed evidence for a market-cycle statement" };
}
