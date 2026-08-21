/** Typed facade over `sanity.mjs`, shared by the price server and the lab panel. */

import * as impl from "./sanity.mjs";

export type SuspectCode = "glued" | "magnitude" | "no-price";

export interface PriceSuspect {
  code: SuspectCode;
  message: string;
}

/** What one captured row looks like before a human confirms it. */
export interface PriceCandidate {
  skuId: string;
  mpn: string;
  query: string;
  channel: string;
  platform: string;
  title: string;
  url: string;
  fetchedAt: string;
  evidence: "unknown";
  /** Comparable CNY value; converted (and flagged) when the listing is not in CNY. */
  priceCny: number | null;
  priceAmount: number | null;
  priceCurrency: string | null;
  /** `from` is a listing headline price of undetermined variant; `variant` is resolved. */
  priceKind: "from" | "variant";
  /** The exact substring the number was read from, for diagnosis. */
  priceText: string;
  priceSource: string;
  salesText: string;
  glued: boolean;
  gluedAmount: number | null;
  suspect: PriceSuspect | null;
  fxAssumed?: { rate: number; asOf: string; source: string } | null;
  variantLabel?: string;
  variantSkuId?: string;
  reason?: string;
  note?: string;
}

export const SUSPECT_RATIO: number = impl.SUSPECT_RATIO;

export function median(values: Array<number | null | undefined>): number | null {
  return impl.median(values) as number | null;
}

/** `null` means the row may be audited; otherwise the sentence explaining why not. */
export function auditBlockReason(candidate: PriceCandidate): string | null {
  return impl.auditBlockReason(candidate) as string | null;
}

export function isAuditable(candidate: PriceCandidate): boolean {
  return impl.isAuditable(candidate) as boolean;
}

export function flagCandidates(
  candidates: PriceCandidate[],
  options?: { reference?: (row: PriceCandidate) => boolean },
): PriceCandidate[] {
  return impl.flagCandidates(candidates, options ?? {}) as PriceCandidate[];
}
