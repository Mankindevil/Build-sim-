import type { EvidenceLevel } from "../core/evidence";

/** Marketplace platforms we may audit into snapshots. */
export type PricePlatform = "jd" | "tmall" | "taobao" | "pdd" | "amazon" | "official" | "other_cn" | "other";

/**
 * How the listing was matched to a catalog SKU.
 * `mpn` = title/URL contains the manufacturer part number.
 */
export type PriceMatchKind = "mpn" | "listingUrl" | "manual";

export interface PriceQuote {
  skuId: string;
  platform: PricePlatform;
  /** CNY retail quote at audit time. */
  priceCny: number;
  currency: "CNY";
  listingUrl?: string;
  match: PriceMatchKind;
  /** Audited quotes only — never invent. */
  evidence: "audited" | "unknown";
  /** Only a resolved variant may enter an audited snapshot. */
  priceKind?: "variant" | "from";
  variantLabel?: string;
  priceAmount?: number;
  priceCurrency?: string;
  fetchedAt?: string;
  /** Deterministic reference to the captured listing/audit input. */
  provenanceId?: string;
  sourceHash?: string;
  provenance?: PriceProvenance;
  note?: string;
}

export interface PriceProvenance {
  provenanceId: string;
  sourceUrl?: string;
  sourceKind: "marketplace-listing" | "official-price" | "manual";
  fetchedAt: string;
  contentHash?: string;
  inputHash: string;
  variantLabel?: string;
  note?: string;
}

export interface PriceSnapshotFile {
  schemaVersion: "1.0.0" | "1.1.0";
  /** Snapshot calendar date YYYY-MM-DD */
  asOf: string;
  /** Optional human note for the whole file */
  note?: string;
  snapshotId?: string;
  generatedAt?: string;
  catalogVersion?: string;
  inputHash?: string;
  contentHash?: string;
  priceVersion?: string;
  quotes: PriceQuote[];
}

export interface SkuPriceSnapshotMeta {
  platform: PricePlatform;
  asOf: string;
  listingUrl?: string;
  match?: PriceMatchKind;
  variantLabel?: string;
  snapshotId?: string;
  inputHash?: string;
  contentHash?: string;
  catalogVersion?: string;
  provenanceId?: string;
}

/** Display stamp, e.g. `snapshot 2026-08-21 · jd` */
export function formatSnapshotStamp(meta: SkuPriceSnapshotMeta): string {
  return `snapshot ${meta.asOf} · ${meta.platform}`;
}

export function isAuditedQuote(q: PriceQuote): boolean {
  if (q.priceKind === "from") return false;
  if (q.priceKind === "variant" && !String(q.variantLabel ?? "").trim()) return false;
  return q.evidence === "audited" && q.currency === "CNY" && Number.isFinite(q.priceCny) && q.priceCny > 0;
}

/** Map snapshot evidence onto catalog PriceEvidence.currentEvidence. */
export function snapshotToCurrentEvidence(q: PriceQuote): EvidenceLevel {
  return q.evidence === "audited" ? "standard" : "unknown";
}
