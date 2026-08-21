import type { EvidenceLevel } from "../core/evidence";

/** Marketplace platforms we may audit into snapshots. */
export type PricePlatform = "jd" | "taobao" | "pdd" | "amazon" | "official" | "other";

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
  note?: string;
}

export interface PriceSnapshotFile {
  schemaVersion: "1.0.0";
  /** Snapshot calendar date YYYY-MM-DD */
  asOf: string;
  /** Optional human note for the whole file */
  note?: string;
  quotes: PriceQuote[];
}

export interface SkuPriceSnapshotMeta {
  platform: PricePlatform;
  asOf: string;
  listingUrl?: string;
  match?: PriceMatchKind;
}

/** Display stamp, e.g. `snapshot 2026-08-21 · jd` */
export function formatSnapshotStamp(meta: SkuPriceSnapshotMeta): string {
  return `snapshot ${meta.asOf} · ${meta.platform}`;
}

export function isAuditedQuote(q: PriceQuote): boolean {
  return q.evidence === "audited" && Number.isFinite(q.priceCny) && q.priceCny > 0;
}

/** Map snapshot evidence onto catalog PriceEvidence.currentEvidence. */
export function snapshotToCurrentEvidence(q: PriceQuote): EvidenceLevel {
  return q.evidence === "audited" ? "standard" : "unknown";
}
