import { priceFreshness, type ChinaPricePlatform, type PriceFreshness, type PriceObservation, type SellerTier } from "./contracts";
import { currentPriceConfidence, type CurrentPriceConfidence } from "./confidence";

export const CHINA_CURRENT_PRICE_POLICY = Object.freeze({
  policyId: "china-current-new-price-v1" as const,
  preferredMaxAgeHours: 72,
  usableMaxAgeDays: 7,
  conflictRatio: 1.5,
  affiliateLinksEnabled: false,
});

export interface SellerTierEvidence {
  readonly sellerId: string;
  readonly sellerTier: Exclude<SellerTier, "unknown">;
  readonly evidenceRefs: readonly string[];
  readonly verifiedAt: string;
}

export interface CurrentPriceProjection {
  readonly schemaVersion: "current-price-projection-v1";
  readonly skuId: string;
  readonly variantIdentityFactIds: readonly string[];
  readonly status: "unavailable" | "single" | "range" | "conflict";
  readonly confidence: CurrentPriceConfidence;
  readonly minCny: number | null;
  readonly maxCny: number | null;
  readonly sampleCount: number;
  readonly sellerCount: number;
  readonly preferredObservationIds: readonly string[];
  readonly usableObservationIds: readonly string[];
  readonly expiredObservationIds: readonly string[];
  readonly selectedObservationIds: readonly string[];
  readonly platformCounts: Readonly<Record<string, number>>;
  readonly riskTags: readonly string[];
  readonly conflict: { readonly minObservationId: string; readonly maxObservationId: string; readonly ratio: number } | null;
  readonly alternativesRequired: boolean;
  readonly validUntil: string | null;
}

const PLATFORM_HOSTS: Readonly<Record<ChinaPricePlatform, readonly RegExp[]>> = Object.freeze({
  jd: [/\.(?:jd\.com)$/u, /^(?:item\.)?jd\.com$/u],
  tmall: [/\.(?:tmall\.com)$/u, /^tmall\.com$/u],
  taobao: [/\.(?:taobao\.com)$/u, /^taobao\.com$/u],
  pdd: [/\.(?:pinduoduo\.com)$/u, /^pinduoduo\.com$/u],
  official: [/.+/u],
  other_cn: [/.+/u],
});

function sameVariant(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function hostMatches(observation: PriceObservation): boolean {
  try {
    const host = new URL(observation.canonicalUrl).hostname.toLowerCase();
    return PLATFORM_HOSTS[observation.platform].some((pattern) => pattern.test(host));
  } catch {
    return false;
  }
}

function recencyTime(observation: PriceObservation): string {
  return observation.recheckedAt ?? observation.capturedAt;
}

function latestBySeller(observations: readonly PriceObservation[]): PriceObservation[] {
  const bySeller = new Map<string, PriceObservation>();
  for (const observation of [...observations].sort((left, right) => recencyTime(right).localeCompare(recencyTime(left)) || left.observationId.localeCompare(right.observationId))) {
    const key = observation.sellerId ?? `unknown:${observation.observationId}`;
    if (!bySeller.has(key)) bySeller.set(key, observation);
  }
  return [...bySeller.values()].sort((left, right) => left.observationId.localeCompare(right.observationId));
}

function validUntil(observations: readonly PriceObservation[]): string | null {
  if (observations.length === 0) return null;
  return new Date(Math.min(...observations.map((observation) => Date.parse(recencyTime(observation)) + CHINA_CURRENT_PRICE_POLICY.usableMaxAgeDays * 86_400_000))).toISOString();
}

/** Builds the only current-new projection used by budget, UI and Agent. */
export function projectCurrentChinaPrice(input: {
  readonly skuId: string;
  readonly variantIdentityFactIds: readonly string[];
  readonly observations: readonly PriceObservation[];
  readonly sellerTierEvidence?: readonly SellerTierEvidence[];
  readonly now: string;
}): CurrentPriceProjection {
  if (!input.skuId || input.variantIdentityFactIds.length === 0 || !Number.isFinite(Date.parse(input.now))) {
    throw new TypeError("current price projection identity/time invalid");
  }
  const tierEvidence = new Map((input.sellerTierEvidence ?? []).map((entry) => {
    if (!entry.sellerId || entry.evidenceRefs.length === 0 || !Number.isFinite(Date.parse(entry.verifiedAt))) throw new TypeError("seller tier evidence invalid");
    return [entry.sellerId, entry.sellerTier] as const;
  }));
  const relevant = input.observations.filter((observation) => observation.skuId === input.skuId
    && sameVariant(observation.variantIdentityFactIds, input.variantIdentityFactIds));
  const expiredObservationIds: string[] = [];
  const eligible = relevant.filter((observation) => {
    const freshness = priceFreshness(recencyTime(observation), input.now);
    if (freshness === "expired") { expiredObservationIds.push(observation.observationId); return false; }
    if (observation.condition !== "new" || observation.stockStatus === "unknown" || !hostMatches(observation)) return false;
    if (observation.sellerTier !== "unknown") {
      if (observation.sellerId === undefined || observation.sellerTierEvidenceRefs.length === 0) return false;
      const separatelyResolvedTier = tierEvidence.get(observation.sellerId);
      if (separatelyResolvedTier !== undefined && separatelyResolvedTier !== observation.sellerTier) return false;
    }
    return true;
  });
  const selected = latestBySeller(eligible);
  const freshnessByObservationId = Object.fromEntries(selected.map((observation) => [observation.observationId, priceFreshness(recencyTime(observation), input.now)]));
  const preferredObservationIds = selected.filter(({ observationId }) => freshnessByObservationId[observationId] === "preferred").map(({ observationId }) => observationId).sort();
  const usableObservationIds = selected.filter(({ observationId }) => freshnessByObservationId[observationId] === "usable").map(({ observationId }) => observationId).sort();
  const values = selected.map(({ comparableTotalCny }) => comparableTotalCny);
  const minimum = selected.reduce<PriceObservation | null>((result, item) => result === null || item.comparableTotalCny < result.comparableTotalCny ? item : result, null);
  const maximum = selected.reduce<PriceObservation | null>((result, item) => result === null || item.comparableTotalCny > result.comparableTotalCny ? item : result, null);
  const ratio = minimum && maximum && minimum.comparableTotalCny > 0 ? maximum.comparableTotalCny / minimum.comparableTotalCny : 1;
  const conflict = minimum && maximum && minimum.observationId !== maximum.observationId && ratio >= CHINA_CURRENT_PRICE_POLICY.conflictRatio
    ? { minObservationId: minimum.observationId, maxObservationId: maximum.observationId, ratio } : null;
  const platformCounts: Record<string, number> = {};
  for (const observation of selected) platformCounts[observation.platform] = (platformCounts[observation.platform] ?? 0) + 1;
  const riskTags = [...new Set(selected.flatMap((observation) => [
    ...(observation.invoiceStatus !== "yes" ? [`invoice:${observation.invoiceStatus}`] : []),
    ...(observation.warrantyStatus !== "mainland" ? [`warranty:${observation.warrantyStatus}`] : []),
    ...(observation.requiredDiscountConditions ?? []).map((condition) => `discount-condition:${condition}`),
    ...(observation.sellerTier === "S4" || observation.sellerTier === "unknown" ? [`seller-tier:${observation.sellerTier}`] : []),
  ]))].sort();
  return {
    schemaVersion: "current-price-projection-v1",
    skuId: input.skuId,
    variantIdentityFactIds: [...input.variantIdentityFactIds].sort(),
    status: selected.length === 0 ? "unavailable" : conflict ? "conflict" : selected.length === 1 ? "single" : "range",
    confidence: currentPriceConfidence({ observations: selected, freshnessByObservationId, evidencedTierBySellerId: Object.fromEntries(tierEvidence) }),
    minCny: values.length ? Math.min(...values) : null,
    maxCny: values.length ? Math.max(...values) : null,
    sampleCount: selected.length,
    sellerCount: new Set(selected.flatMap(({ sellerId }) => sellerId ? [sellerId] : [])).size,
    preferredObservationIds,
    usableObservationIds,
    expiredObservationIds: [...new Set(expiredObservationIds)].sort(),
    selectedObservationIds: selected.map(({ observationId }) => observationId).sort(),
    platformCounts: Object.fromEntries(Object.entries(platformCounts).sort()),
    riskTags,
    conflict,
    alternativesRequired: selected.length === 0,
    validUntil: validUntil(selected),
  };
}
