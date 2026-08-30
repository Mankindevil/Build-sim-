import type { PriceFreshness, PriceObservation, SellerTier } from "./contracts";

export type CurrentPriceConfidence = "unavailable" | "low" | "medium" | "high";

export interface PriceConfidenceInput {
  readonly observations: readonly PriceObservation[];
  readonly freshnessByObservationId: Readonly<Record<string, PriceFreshness>>;
  readonly evidencedTierBySellerId: Readonly<Record<string, Exclude<SellerTier, "unknown">>>;
}

export function currentPriceConfidence(input: PriceConfidenceInput): CurrentPriceConfidence {
  if (input.observations.length === 0) return "unavailable";
  const sellers = new Set(input.observations.flatMap(({ sellerId }) => sellerId ? [sellerId] : []));
  if (sellers.size < 2) return "low";
  const preferred = input.observations.filter(({ observationId }) => input.freshnessByObservationId[observationId] === "preferred").length;
  const evidencedTopTier = input.observations
    .filter(({ sellerId }) => sellerId !== undefined)
    .filter(({ sellerId }) => ["S1", "S2"].includes(input.evidencedTierBySellerId[sellerId!] ?? "unknown")).length;
  return sellers.size >= 3 && preferred >= 3 && evidencedTopTier >= 2 ? "high" : "medium";
}
