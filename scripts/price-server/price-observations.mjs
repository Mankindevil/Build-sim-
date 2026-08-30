import { createHash } from "node:crypto";

const TRACKING_KEYS = /^(?:utm_.+|spm|scm|aff|affiliate|ref|ref_|source|campaign|campaign_id)$/iu;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function canonicalizeListingUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new TypeError("listing URL must be credential-free HTTPS");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING_KEYS.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}

/** Derives formal observation fields from one already persisted server capture. */
export function derivePriceObservationFromCapture(capture, options = {}) {
  if (!capture || capture.schemaVersion !== "listing-capture-v1" || !capture.listingCaptureId
    || !Array.isArray(capture.variantIdentityFactIds) || capture.variantIdentityFactIds.length === 0
    || capture.condition !== "new" || !["in_stock", "seller_claimed"].includes(capture.stockStatus)) {
    throw new TypeError("listing capture cannot produce a current-new price observation");
  }
  if (capture.sellerTier !== "unknown" && (!Array.isArray(options.sellerTierEvidenceRefs) || options.sellerTierEvidenceRefs.length === 0)) {
    throw new TypeError("seller tier requires persisted evidence references");
  }
  const canonicalUrl = canonicalizeListingUrl(capture.canonicalUrl);
  const material = {
    skuId: capture.skuId,
    variantIdentityFactIds: [...capture.variantIdentityFactIds].sort(),
    platform: capture.platform,
    ...(capture.sellerId === undefined ? {} : { sellerId: capture.sellerId }),
    ...(capture.sellerName === undefined ? {} : { sellerName: capture.sellerName }),
    sellerTier: capture.sellerTier,
    sellerTierEvidenceRefs: [...(options.sellerTierEvidenceRefs ?? [])].sort(),
    condition: "new",
    stockStatus: capture.stockStatus,
    priceCny: capture.priceCny,
    ...(capture.shippingCny === undefined ? {} : { shippingCny: capture.shippingCny }),
    comparableTotalCny: capture.comparableTotalCny,
    ...(capture.requiredDiscountConditions === undefined ? {} : { requiredDiscountConditions: [...capture.requiredDiscountConditions].sort() }),
    invoiceStatus: capture.invoiceStatus,
    warrantyStatus: capture.warrantyStatus,
    canonicalUrl,
    listingCaptureId: capture.listingCaptureId,
    capturedAt: capture.capturedAt,
    ...(options.recheckedAt === undefined ? capture.recheckedAt === undefined ? {} : { recheckedAt: capture.recheckedAt } : { recheckedAt: options.recheckedAt }),
  };
  const hash = createHash("sha256").update(`price-observation-v1\0${canonicalJson(material)}`, "utf8").digest("hex");
  return Object.freeze({ observationId: `price-observation-${hash.slice(0, 32)}`, ...material });
}
