import { contentHashRuntime } from "../facts/canonical-runtime.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const GRAPH_REF = /^[A-Za-z][A-Za-z0-9._-]{0,63}:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PLATFORMS = Object.freeze(["jd", "tmall", "taobao", "pdd", "official", "other_cn"]);
const SELLER_TIERS = Object.freeze(["S1", "S2", "S3", "S4", "unknown"]);
const STOCK = Object.freeze(["in_stock", "seller_claimed", "unknown"]);
const INVOICE = Object.freeze(["yes", "no", "unknown"]);
const WARRANTY = Object.freeze(["mainland", "seller", "cross_border", "unknown"]);
const TARGET_STATUS = Object.freeze(["watching", "met", "paused", "unavailable"]);
const TARGET_TRANSITIONS = Object.freeze(["watching_to_met", "met_to_watching", "to_unavailable", "paused", "resumed"]);

function total(operation, fallback = ["price authority validation failed"]) {
  try { return operation(); } catch { return fallback; }
}

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, required, optional = []) {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}
function string(value) { return typeof value === "string" && value.length > 0 && value === value.normalize("NFC"); }
function id(value) { return typeof value === "string" && SAFE_ID.test(value); }
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function finiteNonNegative(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function strings(value, { nonEmpty = false, graphRefs = false } = {}) {
  return Array.isArray(value) && (!nonEmpty || value.length > 0)
    && value.every((item) => string(item) && (!graphRefs || GRAPH_REF.test(item)))
    && new Set(value).size === value.length;
}
function validHttps(value) {
  return total(() => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  }, false);
}
function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}
function sameOptional(left, right) { return left === right; }

export function validateImmutableListingCaptureRuntime(value) {
  return total(() => {
    const errors = [];
    const required = ["schemaVersion", "listingCaptureId", "skuId", "variantIdentityFactIds", "platform", "sellerTier", "condition", "stockStatus", "priceCny", "comparableTotalCny", "invoiceStatus", "warrantyStatus", "canonicalUrl", "capturedAt", "contentHash"];
    const optional = ["sellerId", "sellerName", "shippingCny", "requiredDiscountConditions", "recheckedAt", "sourceListingCaptureId", "sourceListingCaptureContentHash"];
    if (!exact(value, required, optional)) return ["price listing capture fields invalid"];
    if (value.schemaVersion !== "listing-capture-v1" || !id(value.listingCaptureId) || !string(value.skuId)
      || !strings(value.variantIdentityFactIds, { nonEmpty: true }) || !PLATFORMS.includes(value.platform)
      || !SELLER_TIERS.includes(value.sellerTier) || value.condition !== "new" || !STOCK.includes(value.stockStatus)
      || !INVOICE.includes(value.invoiceStatus) || !WARRANTY.includes(value.warrantyStatus)) errors.push("price listing capture identity/market fields invalid");
    if ((value.sellerId !== undefined && !string(value.sellerId)) || (value.sellerName !== undefined && !string(value.sellerName))
      || (value.requiredDiscountConditions !== undefined && !strings(value.requiredDiscountConditions))) errors.push("price listing capture seller/condition fields invalid");
    if (!finiteNonNegative(value.priceCny) || (value.shippingCny !== undefined && !finiteNonNegative(value.shippingCny))
      || !finiteNonNegative(value.comparableTotalCny) || value.comparableTotalCny !== value.priceCny + (value.shippingCny ?? 0)) errors.push("price listing capture total invalid");
    if (!validHttps(value.canonicalUrl) || !iso(value.capturedAt)
      || (value.recheckedAt !== undefined && (!iso(value.recheckedAt) || Date.parse(value.recheckedAt) < Date.parse(value.capturedAt)))) errors.push("price listing capture URL/time invalid");
    if ((value.sourceListingCaptureId === undefined) !== (value.sourceListingCaptureContentHash === undefined)
      || (value.sourceListingCaptureId !== undefined && !/^listing-capture-[a-f0-9]{20}$/.test(value.sourceListingCaptureId))
      || (value.sourceListingCaptureContentHash !== undefined && !SHA256.test(value.sourceListingCaptureContentHash))) errors.push("price listing capture source closure invalid");
    const contentHash = contentHashRuntime(value, "listing-capture", "listing-capture-v1", "listingCapture");
    if (!SHA256.test(String(value.contentHash)) || contentHash !== value.contentHash) errors.push("price listing capture content hash invalid");
    return errors;
  });
}

export function validatePriceObservationRuntime(value) {
  return total(() => {
    const required = ["observationId", "skuId", "variantIdentityFactIds", "platform", "sellerTier", "sellerTierEvidenceRefs", "condition", "stockStatus", "priceCny", "comparableTotalCny", "invoiceStatus", "warrantyStatus", "canonicalUrl", "listingCaptureId", "capturedAt"];
    const optional = ["sellerId", "sellerName", "shippingCny", "requiredDiscountConditions", "recheckedAt"];
    if (!exact(value, required, optional)) return ["price observation fields invalid"];
    const errors = [];
    if (!id(value.observationId) || !string(value.skuId) || !id(value.listingCaptureId)
      || !strings(value.variantIdentityFactIds, { nonEmpty: true }) || !PLATFORMS.includes(value.platform)
      || !SELLER_TIERS.includes(value.sellerTier) || value.condition !== "new" || !STOCK.includes(value.stockStatus)
      || !INVOICE.includes(value.invoiceStatus) || !WARRANTY.includes(value.warrantyStatus)) errors.push("price observation identity/market fields invalid");
    if (!strings(value.sellerTierEvidenceRefs, { graphRefs: true })
      || (value.sellerTier === "unknown" ? value.sellerTierEvidenceRefs.length !== 0 : value.sellerTierEvidenceRefs.length === 0)) errors.push("price observation seller tier evidence refs invalid");
    if ((value.sellerId !== undefined && !string(value.sellerId)) || (value.sellerName !== undefined && !string(value.sellerName))
      || (value.requiredDiscountConditions !== undefined && !strings(value.requiredDiscountConditions))) errors.push("price observation seller/condition fields invalid");
    if (!finiteNonNegative(value.priceCny) || (value.shippingCny !== undefined && !finiteNonNegative(value.shippingCny))
      || !finiteNonNegative(value.comparableTotalCny) || value.comparableTotalCny !== value.priceCny + (value.shippingCny ?? 0)) errors.push("price observation total invalid");
    if (!validHttps(value.canonicalUrl) || !iso(value.capturedAt)
      || (value.recheckedAt !== undefined && (!iso(value.recheckedAt) || Date.parse(value.recheckedAt) < Date.parse(value.capturedAt)))) errors.push("price observation URL/time invalid");
    return errors;
  });
}

export function validatePriceObservationClosureRuntime(value, capture) {
  return total(() => {
    const errors = [...validatePriceObservationRuntime(value), ...validateImmutableListingCaptureRuntime(capture)];
    const bound = ["skuId", "platform", "sellerId", "sellerName", "sellerTier", "condition", "stockStatus", "priceCny", "shippingCny", "comparableTotalCny", "invoiceStatus", "warrantyStatus", "canonicalUrl", "capturedAt", "recheckedAt"];
    if (!record(capture) || capture.listingCaptureId !== value?.listingCaptureId
      || !sameArray(capture.variantIdentityFactIds, value?.variantIdentityFactIds)
      || !sameArray(capture.requiredDiscountConditions ?? [], value?.requiredDiscountConditions ?? [])
      || bound.some((field) => !sameOptional(capture[field], value?.[field]))) errors.push("price observation does not exactly match its listing capture");
    return [...new Set(errors)];
  });
}

export function validatePriceHistoryPointRuntime(value) {
  return total(() => {
    const required = ["historyPointId", "skuId", "variantIdentityFactIds", "bucketStart", "bucketEnd", "timeZone", "policyHash", "priceBasis", "condition", "region", "currency", "minCny", "maxCny", "sampleCount", "sellerCount", "platformCounts", "observationIds", "confidence", "snapshotId"];
    if (!exact(value, required, ["medianCny"])) return ["price history fields invalid"];
    const errors = [];
    if (!id(value.historyPointId) || !string(value.skuId) || !strings(value.variantIdentityFactIds, { nonEmpty: true }) || !strings(value.observationIds, { nonEmpty: true })
      || !string(value.snapshotId) || !SHA256.test(String(value.policyHash))) errors.push("price history identity fields invalid");
    if (value.timeZone !== "Asia/Shanghai" || value.priceBasis !== "comparable_total_cny" || value.condition !== "new" || value.region !== "CN" || value.currency !== "CNY"
      || !["low", "medium", "high"].includes(value.confidence)) errors.push("price history policy fields invalid");
    if (!iso(value.bucketStart) || !iso(value.bucketEnd) || Date.parse(value.bucketStart) >= Date.parse(value.bucketEnd)) errors.push("price history interval invalid");
    if (!finiteNonNegative(value.minCny) || !finiteNonNegative(value.maxCny) || value.maxCny < value.minCny
      || (value.medianCny !== undefined && (!finiteNonNegative(value.medianCny) || value.medianCny < value.minCny || value.medianCny > value.maxCny))) errors.push("price history totals invalid");
    if (!Number.isInteger(value.sampleCount) || value.sampleCount !== value.observationIds.length || value.sampleCount < 1
      || !Number.isInteger(value.sellerCount) || value.sellerCount < 0 || value.sellerCount > value.sampleCount
      || !record(value.platformCounts) || Object.keys(value.platformCounts).some((platform) => !PLATFORMS.includes(platform))
      || Object.values(value.platformCounts).some((count) => !Number.isInteger(count) || count < 0)
      || Object.values(value.platformCounts).reduce((sum, count) => sum + count, 0) !== value.sampleCount) errors.push("price history counts invalid");
    return errors;
  });
}

export function validatePriceHistoryClosureRuntime(value, observations) {
  return total(() => {
    const errors = [...validatePriceHistoryPointRuntime(value)];
    const byId = new Map((observations ?? []).map((observation) => [observation.observationId, observation]));
    const samples = (value?.observationIds ?? []).map((observationId) => byId.get(observationId));
    if (samples.some((sample) => !sample)) return [...errors, "price history references a missing observation"];
    const variant = [...value.variantIdentityFactIds].sort().join("\0");
    if (samples.some((sample) => sample.skuId !== value.skuId || [...sample.variantIdentityFactIds].sort().join("\0") !== variant
      || Date.parse(sample.capturedAt) < Date.parse(value.bucketStart) || Date.parse(sample.capturedAt) >= Date.parse(value.bucketEnd))) errors.push("price history observation scope invalid");
    const totals = samples.map((sample) => sample.comparableTotalCny).sort((left, right) => left - right);
    const middle = Math.floor(totals.length / 2);
    const median = totals.length % 2 === 0 ? (totals[middle - 1] + totals[middle]) / 2 : totals[middle];
    const sellers = new Set(samples.map((sample) => sample.sellerId).filter(Boolean));
    const platformCounts = {};
    for (const sample of samples) platformCounts[sample.platform] = (platformCounts[sample.platform] ?? 0) + 1;
    if (value.minCny !== totals[0] || value.maxCny !== totals.at(-1) || (value.medianCny !== undefined && value.medianCny !== median)
      || value.sellerCount !== sellers.size || JSON.stringify(Object.entries(value.platformCounts).sort()) !== JSON.stringify(Object.entries(platformCounts).sort())) errors.push("price history aggregate closure invalid");
    return [...new Set(errors)];
  });
}

export function validatePriceTargetRuntime(value) {
  return total(() => {
    const required = ["targetId", "planId", "skuId", "variantIdentityFactIds", "targetTotalCny", "enabled", "status", "revisionHash", "updatedAt"];
    const optional = ["instanceId", "sellerTierMinimum", "requireMainlandWarranty", "expiresAt", "nextCheckAt", "lastEvaluatedSnapshotId", "lastTriggeredAt"];
    if (!exact(value, required, optional)) return ["price target fields invalid"];
    const errors = [];
    if (!id(value.targetId) || !string(value.planId) || !string(value.skuId) || !strings(value.variantIdentityFactIds, { nonEmpty: true })
      || (value.instanceId !== undefined && !string(value.instanceId)) || !SHA256.test(String(value.revisionHash))) errors.push("price target identity fields invalid");
    if (!finiteNonNegative(value.targetTotalCny) || typeof value.enabled !== "boolean" || !TARGET_STATUS.includes(value.status)
      || (value.enabled && value.status === "paused") || (!value.enabled && value.status !== "paused")) errors.push("price target state invalid");
    if (value.sellerTierMinimum !== undefined && !["S1", "S2", "S3", "S4"].includes(value.sellerTierMinimum)) errors.push("price target seller tier invalid");
    if (value.requireMainlandWarranty !== undefined && typeof value.requireMainlandWarranty !== "boolean") errors.push("price target warranty flag invalid");
    if (!iso(value.updatedAt) || (value.expiresAt !== undefined && (!iso(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.updatedAt)))
      || (value.nextCheckAt !== undefined && !iso(value.nextCheckAt)) || (value.lastTriggeredAt !== undefined && !iso(value.lastTriggeredAt))
      || (value.lastEvaluatedSnapshotId !== undefined && !string(value.lastEvaluatedSnapshotId))) errors.push("price target time/snapshot fields invalid");
    return errors;
  });
}

export function priceTargetEventIdempotencyKeyRuntime(value) {
  return [value.targetId, value.targetRevisionHash, value.priceSnapshotId, value.transition]
    .map((part) => `${String(part).length}:${part}`).join("|");
}

export function validatePriceTargetEventRuntime(value) {
  return total(() => {
    if (!exact(value, ["eventId", "targetId", "targetRevisionHash", "priceSnapshotId", "transition", "occurredAt", "idempotencyKey"])) return ["price target event fields invalid"];
    const errors = [];
    if (!id(value.eventId) || !id(value.targetId) || !SHA256.test(String(value.targetRevisionHash)) || !string(value.priceSnapshotId)
      || !TARGET_TRANSITIONS.includes(value.transition) || !iso(value.occurredAt)) errors.push("price target event identity fields invalid");
    if (value.idempotencyKey !== priceTargetEventIdempotencyKeyRuntime(value)) errors.push("price target event idempotency key invalid");
    return errors;
  });
}

export function validateJobScheduleRuntime(value) {
  return total(() => {
    const required = ["scheduleId", "jobType", "subjectRef", "cadenceSeconds", "nextRunAt", "enabled"];
    if (!exact(value, required, ["lastEnqueuedBucket"])) return ["price schedule fields invalid"];
    const errors = [];
    if (!id(value.scheduleId) || !["price_target_recheck", "price_history_rebuild", "official_update_scan"].includes(value.jobType)
      || !GRAPH_REF.test(String(value.subjectRef)) || (value.jobType === "price_target_recheck" && !String(value.subjectRef).startsWith("price-target:"))) errors.push("price schedule identity/subject invalid");
    if (!Number.isInteger(value.cadenceSeconds) || value.cadenceSeconds <= 0 || typeof value.enabled !== "boolean" || !iso(value.nextRunAt)
      || (value.lastEnqueuedBucket !== undefined && !iso(value.lastEnqueuedBucket))) errors.push("price schedule cadence/time invalid");
    return errors;
  });
}
