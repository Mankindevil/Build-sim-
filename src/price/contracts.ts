import { hashContent, isSha256Hex } from "../hash";
import { resolveAuthoritativeContext, type AuthoritativeResolver } from "../contracts/trusted-context";

export type ChinaPricePlatform = "jd" | "tmall" | "taobao" | "pdd" | "official" | "other_cn";
export type SellerTier = "S1" | "S2" | "S3" | "S4" | "unknown";

/** An audited server-derived quote bound to an immutable listing capture. */
export interface PriceObservation {
  observationId: string;
  skuId: string;
  variantIdentityFactIds: string[];
  platform: ChinaPricePlatform;
  sellerId?: string;
  sellerName?: string;
  sellerTier: SellerTier;
  condition: "new";
  stockStatus: "in_stock" | "seller_claimed" | "unknown";
  priceCny: number;
  shippingCny?: number;
  comparableTotalCny: number;
  requiredDiscountConditions?: string[];
  invoiceStatus: "yes" | "no" | "unknown";
  warrantyStatus: "mainland" | "seller" | "cross_border" | "unknown";
  canonicalUrl: string;
  listingCaptureId: string;
  capturedAt: string;
  recheckedAt?: string;
}

/** Immutable server-side source record from which a formal observation is projected. */
export interface ImmutableListingCapture {
  schemaVersion: "listing-capture-v1";
  listingCaptureId: string;
  skuId: string;
  variantIdentityFactIds: string[];
  platform: ChinaPricePlatform;
  sellerId?: string;
  sellerName?: string;
  sellerTier: SellerTier;
  condition: "new";
  stockStatus: PriceObservation["stockStatus"];
  priceCny: number;
  shippingCny?: number;
  comparableTotalCny: number;
  requiredDiscountConditions?: string[];
  invoiceStatus: PriceObservation["invoiceStatus"];
  warrantyStatus: PriceObservation["warrantyStatus"];
  canonicalUrl: string;
  capturedAt: string;
  recheckedAt?: string;
  contentHash: string;
}

export interface PriceHistoryPoint {
  historyPointId: string;
  skuId: string;
  variantIdentityFactIds: string[];
  bucketStart: string;
  bucketEnd: string;
  timeZone: "Asia/Shanghai";
  policyHash: string;
  priceBasis: "comparable_total_cny";
  condition: "new";
  region: "CN";
  currency: "CNY";
  minCny: number;
  maxCny: number;
  medianCny?: number;
  sampleCount: number;
  sellerCount: number;
  platformCounts: Record<string, number>;
  observationIds: string[];
  confidence: "low" | "medium" | "high";
  snapshotId: string;
}

export interface PriceTarget {
  targetId: string;
  planId: string;
  instanceId?: string;
  skuId: string;
  variantIdentityFactIds: string[];
  targetTotalCny: number;
  sellerTierMinimum?: Exclude<SellerTier, "unknown">;
  requireMainlandWarranty?: boolean;
  expiresAt?: string;
  enabled: boolean;
  status: "watching" | "met" | "paused" | "unavailable";
  revisionHash: string;
  updatedAt: string;
  nextCheckAt?: string;
  lastEvaluatedSnapshotId?: string;
  lastTriggeredAt?: string;
}

export interface PriceTargetEvent {
  eventId: string;
  targetId: string;
  targetRevisionHash: string;
  priceSnapshotId: string;
  transition: "watching_to_met" | "met_to_watching" | "to_unavailable" | "paused" | "resumed";
  occurredAt: string;
  idempotencyKey: string;
}

export interface JobSchedule {
  scheduleId: string;
  jobType: "price_target_recheck" | "official_update_scan";
  subjectRef: string;
  cadenceSeconds: number;
  nextRunAt: string;
  lastEnqueuedBucket?: string;
  enabled: boolean;
}

export type PriceFreshness = "preferred" | "usable" | "expired";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameStringArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

export function validateImmutableListingCapture(value: unknown): string[] {
  if (!isRecord(value)) return ["listing capture must be an immutable server record"];
  const capture = value as unknown as ImmutableListingCapture;
  const errors: string[] = [];
  const allowed = [
    "schemaVersion", "listingCaptureId", "skuId", "variantIdentityFactIds", "platform", "sellerId", "sellerName", "sellerTier",
    "condition", "stockStatus", "priceCny", "shippingCny", "comparableTotalCny", "requiredDiscountConditions", "invoiceStatus",
    "warrantyStatus", "canonicalUrl", "capturedAt", "recheckedAt", "contentHash",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) errors.push("listing capture contains unknown fields");
  if (capture.schemaVersion !== "listing-capture-v1" || !capture.listingCaptureId || !capture.skuId || !isSha256Hex(capture.contentHash)) errors.push("listing capture identity/content hash invalid");
  if (!Array.isArray(capture.variantIdentityFactIds) || capture.variantIdentityFactIds.length === 0 || capture.variantIdentityFactIds.some((id) => typeof id !== "string" || !id) || new Set(capture.variantIdentityFactIds).size !== capture.variantIdentityFactIds.length) errors.push("listing capture exact variant binding invalid");
  if (!["jd", "tmall", "taobao", "pdd", "official", "other_cn"].includes(String(capture.platform))
    || !["S1", "S2", "S3", "S4", "unknown"].includes(String(capture.sellerTier))
    || capture.condition !== "new"
    || !["in_stock", "seller_claimed", "unknown"].includes(String(capture.stockStatus))
    || !["yes", "no", "unknown"].includes(String(capture.invoiceStatus))
    || !["mainland", "seller", "cross_border", "unknown"].includes(String(capture.warrantyStatus))) errors.push("listing capture governed market fields invalid");
  if ((capture.sellerId !== undefined && (typeof capture.sellerId !== "string" || !capture.sellerId))
    || (capture.sellerName !== undefined && (typeof capture.sellerName !== "string" || !capture.sellerName))) errors.push("listing capture seller fields invalid");
  if (capture.requiredDiscountConditions !== undefined
    && (!Array.isArray(capture.requiredDiscountConditions)
      || capture.requiredDiscountConditions.some((condition) => typeof condition !== "string" || !condition)
      || new Set(capture.requiredDiscountConditions).size !== capture.requiredDiscountConditions.length)) errors.push("listing capture discount conditions invalid");
  if (!Number.isFinite(capture.priceCny) || capture.priceCny < 0 || (capture.shippingCny !== undefined && (!Number.isFinite(capture.shippingCny) || capture.shippingCny < 0)) || !Number.isFinite(capture.comparableTotalCny)) errors.push("listing capture prices invalid");
  if (Number.isFinite(capture.priceCny) && (capture.shippingCny === undefined || Number.isFinite(capture.shippingCny))
    && capture.comparableTotalCny !== capture.priceCny + (capture.shippingCny ?? 0)) errors.push("listing capture comparable total invalid");
  if (!/^https:\/\//.test(String(capture.canonicalUrl)) || !Number.isFinite(Date.parse(capture.capturedAt))) errors.push("listing capture URL/time invalid");
  if (capture.recheckedAt !== undefined && (!Number.isFinite(Date.parse(capture.recheckedAt)) || Date.parse(capture.recheckedAt) < Date.parse(capture.capturedAt))) errors.push("listing capture recheck time invalid");
  return errors;
}

export function priceFreshness(capturedAt: string, now: string): PriceFreshness {
  const ageMs = Date.parse(now) - Date.parse(capturedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "expired";
  if (ageMs <= 72 * 60 * 60 * 1_000) return "preferred";
  if (ageMs <= 7 * 24 * 60 * 60 * 1_000) return "usable";
  return "expired";
}

/** Internal pure helper for tests and already-resolved repository records. */
export function validatePriceObservationWithResolvedCaptures(value: unknown, listingCaptures?: ReadonlyMap<string, ImmutableListingCapture>): string[] {
  if (!isRecord(value)) return ["price observation must be an object"];
  const observation = value as unknown as PriceObservation;
  const errors: string[] = [];
  if (!observation.observationId || !observation.skuId || !Array.isArray(observation.variantIdentityFactIds) || observation.variantIdentityFactIds.length === 0 || observation.variantIdentityFactIds.some((id) => !id) || new Set(observation.variantIdentityFactIds).size !== observation.variantIdentityFactIds.length || !observation.listingCaptureId) errors.push("price observation identity/capture fields missing or invalid");
  const capture = typeof listingCaptures?.get === "function" ? listingCaptures.get(observation.listingCaptureId) : undefined;
  if (!capture) {
    errors.push("price observation is not derived from a saved immutable server listing capture");
  } else {
    errors.push(...validateImmutableListingCapture(capture).map((error) => `listing capture: ${error}`));
    const boundFields: Array<keyof PriceObservation> = [
      "skuId", "platform", "sellerId", "sellerName", "sellerTier", "condition", "stockStatus", "priceCny", "shippingCny",
      "comparableTotalCny", "invoiceStatus", "warrantyStatus", "canonicalUrl", "capturedAt", "recheckedAt",
    ];
    if (capture.listingCaptureId !== observation.listingCaptureId
      || !sameStringArray(capture.variantIdentityFactIds, observation.variantIdentityFactIds)
      || boundFields.some((field) => capture[field as keyof ImmutableListingCapture] !== observation[field])
      || !sameStringArray(capture.requiredDiscountConditions ?? [], observation.requiredDiscountConditions ?? [])) {
      errors.push("price observation fields do not exactly match the immutable listing capture");
    }
  }
  if (observation.condition !== "new") errors.push("formal current-new observation must have new condition");
  if (!Number.isFinite(observation.priceCny) || observation.priceCny < 0 || (observation.shippingCny !== undefined && (!Number.isFinite(observation.shippingCny) || observation.shippingCny < 0))) errors.push("price/shipping invalid");
  const expectedTotal = observation.priceCny + (observation.shippingCny ?? 0);
  if (!Number.isFinite(observation.comparableTotalCny) || observation.comparableTotalCny < 0 || Math.abs(observation.comparableTotalCny - expectedTotal) > Number.EPSILON) errors.push("comparableTotalCny must equal item price plus mandatory shipping after unconditional discounts");
  if (!/^https:\/\//.test(String(observation.canonicalUrl))) errors.push("canonicalUrl must be HTTPS");
  try {
    const url = new URL(observation.canonicalUrl);
    if (url.username || url.password || url.hash) errors.push("canonicalUrl must not contain credentials or fragments");
  } catch {
    errors.push("canonicalUrl invalid");
  }
  const capturedAt = Date.parse(observation.capturedAt);
  const recheckedAt = observation.recheckedAt === undefined ? undefined : Date.parse(observation.recheckedAt);
  if (!Number.isFinite(capturedAt) || (recheckedAt !== undefined && (!Number.isFinite(recheckedAt) || recheckedAt < capturedAt))) errors.push("price observation timestamps invalid");
  return errors;
}

/** @deprecated Server-facing code must use validatePriceObservationAuthoritatively. */
export function validatePriceObservation(value: unknown, listingCaptures?: ReadonlyMap<string, ImmutableListingCapture>): string[] {
  return validatePriceObservationWithResolvedCaptures(value, listingCaptures);
}

/** Server-facing price gate: request JSON supplies only the observation's capture ID. */
export async function validatePriceObservationAuthoritatively(
  value: unknown,
  resolver: AuthoritativeResolver<ImmutableListingCapture, "listing-capture">,
): Promise<string[]> {
  if (!isRecord(value) || typeof value.listingCaptureId !== "string" || value.listingCaptureId.length === 0) {
    return ["price observation listingCaptureId missing for authoritative resolution"];
  }
  const resolved = await resolveAuthoritativeContext<ImmutableListingCapture, "listing-capture">(
    resolver,
    "listing-capture",
    value.listingCaptureId,
  );
  if (!resolved.ok) return [`price observation authoritative capture resolution failed: ${resolved.error}`];
  const capture = resolved.value;
  const errors = validateImmutableListingCapture(capture).map((error) => `listing capture: ${error}`);
  try {
    const expectedHash = await hashContent(capture, { domain: "listing-capture", schemaVersion: "listing-capture-v1" });
    if (capture.contentHash !== expectedHash) errors.push("listing capture contentHash verification failed");
  } catch {
    errors.push("listing capture canonical payload invalid");
  }
  errors.push(...validatePriceObservationWithResolvedCaptures(value, new Map([[value.listingCaptureId, capture]])));
  return [...new Set(errors)];
}

export function validatePriceHistoryPoint(point: PriceHistoryPoint, observations: readonly PriceObservation[]): string[] {
  const errors: string[] = [];
  if (!point.historyPointId || !point.skuId || !point.snapshotId || !isSha256Hex(point.policyHash)) errors.push("history identity/policy hash invalid");
  if (point.timeZone !== "Asia/Shanghai" || point.priceBasis !== "comparable_total_cny" || point.condition !== "new" || point.region !== "CN" || point.currency !== "CNY") errors.push("history grouping policy invalid");
  const bucketStart = Date.parse(point.bucketStart);
  const bucketEnd = Date.parse(point.bucketEnd);
  if (!Number.isFinite(bucketStart) || !Number.isFinite(bucketEnd) || bucketStart >= bucketEnd) errors.push("history bucket interval invalid");
  if (![point.minCny, point.maxCny, ...(point.medianCny === undefined ? [] : [point.medianCny])].every(Number.isFinite) || point.minCny < 0 || point.maxCny < point.minCny || (point.medianCny !== undefined && (point.medianCny < point.minCny || point.medianCny > point.maxCny))) errors.push("history price range invalid");
  if (!Number.isInteger(point.sampleCount) || point.sampleCount <= 0 || point.sampleCount !== point.observationIds.length || new Set(point.observationIds).size !== point.observationIds.length) errors.push("history sample count/IDs invalid");
  const byId = new Map(observations.map((observation) => [observation.observationId, observation]));
  const samples = point.observationIds.map((id) => byId.get(id));
  if (samples.some((sample) => !sample)) errors.push("history references missing observations");
  const variant = [...point.variantIdentityFactIds].sort().join("\u0000");
  if (samples.some((sample) => sample && (sample.skuId !== point.skuId || [...sample.variantIdentityFactIds].sort().join("\u0000") !== variant))) errors.push("history mixes SKU or exact variants");
  const sellers = new Set(samples.map((sample) => sample?.sellerId).filter((id): id is string => Boolean(id)));
  if (!Number.isInteger(point.sellerCount) || point.sellerCount !== sellers.size) errors.push("history sellerCount must count independent seller IDs");
  const completeSamples = samples.filter((sample): sample is PriceObservation => Boolean(sample));
  if (completeSamples.some((sample) => {
    const capturedAt = Date.parse(sample.capturedAt);
    return !Number.isFinite(capturedAt) || capturedAt < bucketStart || capturedAt >= bucketEnd;
  })) errors.push("history contains observation outside its bucket");
  if (completeSamples.length === point.sampleCount) {
    const totals = completeSamples.map((sample) => sample.comparableTotalCny).sort((a, b) => a - b);
    const middle = Math.floor(totals.length / 2);
    const median = totals.length % 2 === 0 ? (totals[middle - 1]! + totals[middle]!) / 2 : totals[middle]!;
    if (point.minCny !== totals[0] || point.maxCny !== totals.at(-1) || (point.medianCny !== undefined && point.medianCny !== median)) errors.push("history aggregates do not match saved observations");
    const actualPlatforms: Record<string, number> = {};
    for (const sample of completeSamples) actualPlatforms[sample.platform] = (actualPlatforms[sample.platform] ?? 0) + 1;
    const expectedPlatformEntries = Object.entries(actualPlatforms).sort();
    const declaredPlatformEntries = Object.entries(point.platformCounts).sort();
    if (JSON.stringify(expectedPlatformEntries) !== JSON.stringify(declaredPlatformEntries)) errors.push("history platformCounts do not match saved observations");
  }
  return errors;
}

export function priceTargetEventIdempotencyKey(event: Pick<PriceTargetEvent, "targetId" | "targetRevisionHash" | "priceSnapshotId" | "transition">): string {
  return [event.targetId, event.targetRevisionHash, event.priceSnapshotId, event.transition].map((part) => `${part.length}:${part}`).join("|");
}

export function validatePriceTargetEvent(event: PriceTargetEvent): string[] {
  const errors: string[] = [];
  if (!event.eventId || !event.targetId || !event.priceSnapshotId || !isSha256Hex(event.targetRevisionHash) || !Number.isFinite(Date.parse(event.occurredAt))) errors.push("price target event identity/hash/timestamp invalid");
  if (event.idempotencyKey !== priceTargetEventIdempotencyKey(event)) errors.push("price target event idempotencyKey invalid");
  return errors;
}

export function validatePriceTarget(target: PriceTarget): string[] {
  const errors: string[] = [];
  if (!target.targetId || !target.planId || !target.skuId || target.variantIdentityFactIds.length === 0 || target.variantIdentityFactIds.some((id) => !id) || new Set(target.variantIdentityFactIds).size !== target.variantIdentityFactIds.length || !isSha256Hex(target.revisionHash)) errors.push("price target identity/revision fields missing or invalid");
  if (!Number.isFinite(target.targetTotalCny) || target.targetTotalCny < 0) errors.push("targetTotalCny invalid");
  if (!target.enabled && target.status !== "paused") errors.push("disabled price target must be paused");
  if (target.enabled && target.status === "paused") errors.push("paused price target must be disabled");
  const updatedAt = Date.parse(target.updatedAt);
  if (!Number.isFinite(updatedAt) || (target.expiresAt !== undefined && (!Number.isFinite(Date.parse(target.expiresAt)) || Date.parse(target.expiresAt) <= updatedAt)) || (target.nextCheckAt !== undefined && !Number.isFinite(Date.parse(target.nextCheckAt)))) errors.push("price target timestamps invalid");
  return errors;
}

export function validateJobSchedule(schedule: JobSchedule): string[] {
  const errors: string[] = [];
  if (!schedule.scheduleId || !schedule.subjectRef) errors.push("schedule identity/subject missing");
  if (!Number.isInteger(schedule.cadenceSeconds) || schedule.cadenceSeconds <= 0) errors.push("schedule cadenceSeconds must be a positive integer");
  if (!Number.isFinite(Date.parse(schedule.nextRunAt))) errors.push("schedule nextRunAt invalid");
  return errors;
}

/** Restart catch-up is capped at one bucket to avoid a backlog storm. */
export function scheduleCatchUpBuckets(schedule: JobSchedule, now: string): 0 | 1 {
  const nextRunAt = Date.parse(schedule.nextRunAt);
  const current = Date.parse(now);
  return schedule.enabled && Number.isFinite(nextRunAt) && Number.isFinite(current) && nextRunAt <= current ? 1 : 0;
}
