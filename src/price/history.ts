import { hashContent } from "../hash";
import type { PriceHistoryPoint, PriceObservation } from "./contracts";
import { CHINA_CURRENT_PRICE_POLICY } from "./policy";

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** Builds one immutable exact-variant history bucket without deleting sparse or conflicting samples. */
export async function buildPriceHistoryPoint(input: {
  readonly skuId: string;
  readonly variantIdentityFactIds: readonly string[];
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly snapshotId: string;
  readonly observations: readonly PriceObservation[];
}): Promise<PriceHistoryPoint> {
  const start = Date.parse(input.bucketStart); const end = Date.parse(input.bucketEnd);
  if (!input.skuId || input.variantIdentityFactIds.length === 0 || !input.snapshotId || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new TypeError("price history bucket identity invalid");
  }
  const variantKey = [...input.variantIdentityFactIds].sort().join("\0");
  const unique = new Map<string, PriceObservation>();
  for (const observation of input.observations) {
    if (observation.skuId !== input.skuId || [...observation.variantIdentityFactIds].sort().join("\0") !== variantKey
      || observation.condition !== "new" || Date.parse(observation.capturedAt) < start || Date.parse(observation.capturedAt) >= end) continue;
    unique.set(observation.observationId, observation);
  }
  const observations = [...unique.values()].sort((left, right) => left.observationId.localeCompare(right.observationId));
  if (observations.length === 0) throw new TypeError("price history bucket has no exact new observations");
  const totals = observations.map(({ comparableTotalCny }) => comparableTotalCny);
  const platformCounts: Record<string, number> = {};
  for (const observation of observations) platformCounts[observation.platform] = (platformCounts[observation.platform] ?? 0) + 1;
  const policyHash = await hashContent(CHINA_CURRENT_PRICE_POLICY, { domain: "price.policy", schemaVersion: "1.0.0" });
  const identity = {
    skuId: input.skuId, variantIdentityFactIds: [...input.variantIdentityFactIds].sort(), bucketStart: input.bucketStart,
    bucketEnd: input.bucketEnd, policyHash, observationIds: observations.map(({ observationId }) => observationId), snapshotId: input.snapshotId,
  };
  const historyHash = await hashContent(identity, { domain: "price.history-point-id", schemaVersion: "1.0.0" });
  const sellerCount = new Set(observations.flatMap(({ sellerId }) => sellerId ? [sellerId] : [])).size;
  return {
    historyPointId: `history-${historyHash.slice(0, 32)}`,
    skuId: input.skuId,
    variantIdentityFactIds: [...input.variantIdentityFactIds].sort(),
    bucketStart: input.bucketStart,
    bucketEnd: input.bucketEnd,
    timeZone: "Asia/Shanghai",
    policyHash,
    priceBasis: "comparable_total_cny",
    condition: "new",
    region: "CN",
    currency: "CNY",
    minCny: Math.min(...totals),
    maxCny: Math.max(...totals),
    medianCny: median(totals),
    sampleCount: observations.length,
    sellerCount,
    platformCounts: Object.fromEntries(Object.entries(platformCounts).sort()),
    observationIds: observations.map(({ observationId }) => observationId),
    confidence: sellerCount >= 3 ? "high" : sellerCount >= 2 ? "medium" : "low",
    snapshotId: input.snapshotId,
  };
}

/**
 * Immutable rebuilds may supersede a sparse point for the same exact bucket.
 * The current series selects the point with the greatest observation closure;
 * ties use the content-addressed ID. Every older point remains auditable.
 */
export function projectCurrentHistoryPoints(points: readonly PriceHistoryPoint[]): PriceHistoryPoint[] {
  const heads = new Map<string, PriceHistoryPoint>();
  for (const point of points) {
    const key = JSON.stringify([
      point.skuId,
      [...point.variantIdentityFactIds].sort(),
      point.condition,
      point.region,
      point.currency,
      point.priceBasis,
      point.bucketStart,
      point.bucketEnd,
    ]);
    const current = heads.get(key);
    if (!current || point.observationIds.length > current.observationIds.length
      || (point.observationIds.length === current.observationIds.length && point.historyPointId > current.historyPointId)) heads.set(key, point);
  }
  return [...heads.values()].map((point) => structuredClone(point))
    .sort((left, right) => left.bucketStart.localeCompare(right.bucketStart) || left.skuId.localeCompare(right.skuId) || left.historyPointId.localeCompare(right.historyPointId));
}
