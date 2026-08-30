import type { ImmutableListingCapture, PriceObservation } from "../../src/price/contracts";

export function canonicalizeListingUrl(rawUrl: string): string;
export function derivePriceObservationFromCapture(
  capture: ImmutableListingCapture,
  options?: { readonly sellerTierEvidenceRefs?: readonly string[]; readonly recheckedAt?: string },
): Readonly<PriceObservation>;
