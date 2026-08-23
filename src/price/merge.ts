import type { SkuCatalog, SkuRecord } from "../sku/types";
import type { PriceQuote, PriceSnapshotFile, SkuPriceSnapshotMeta } from "./types";
import {
  formatSnapshotStamp,
  isAuditedQuote,
  snapshotToCurrentEvidence,
} from "./types";

function pickBestQuote(quotes: PriceQuote[]): PriceQuote | undefined {
  const audited = quotes.filter(isAuditedQuote);
  if (audited.length === 0) return undefined;
  // Prefer lower CNY among audited quotes for the same SKU.
  return audited.reduce((a, b) => (b.priceCny < a.priceCny ? b : a));
}

/**
 * Apply a price snapshot onto a catalog copy.
 * Audited quotes set `price.current` + stamp metadata; unknowns stay untouched.
 * Never fabricates historicalLow.
 */
export function applyPriceSnapshot(
  catalog: SkuCatalog,
  snapshot: PriceSnapshotFile | null | undefined,
): SkuCatalog {
  if (!snapshot?.quotes?.length) {
    return structuredClone(catalog);
  }

  const bySku = new Map<string, PriceQuote[]>();
  for (const q of snapshot.quotes) {
    const list = bySku.get(q.skuId) ?? [];
    list.push(q);
    bySku.set(q.skuId, list);
  }

  const skus: SkuRecord[] = catalog.skus.map((sku) => {
    const best = pickBestQuote(bySku.get(sku.id) ?? []);
    if (!best) return structuredClone(sku);

    const meta: SkuPriceSnapshotMeta = {
      platform: best.platform,
      asOf: snapshot.asOf,
      match: best.match,
      ...(best.listingUrl ? { listingUrl: best.listingUrl } : {}),
      ...(best.variantLabel ? { variantLabel: best.variantLabel } : {}),
      ...(snapshot.snapshotId ? { snapshotId: snapshot.snapshotId } : {}),
      ...(snapshot.inputHash ? { inputHash: snapshot.inputHash } : {}),
      ...(snapshot.contentHash ? { contentHash: snapshot.contentHash } : {}),
      ...(snapshot.catalogVersion ? { catalogVersion: snapshot.catalogVersion } : {}),
      ...(best.provenanceId ? { provenanceId: best.provenanceId } : {}),
    };

    const next: SkuRecord = structuredClone(sku);
    const listingUrl = best.listingUrl ?? next.price.listingUrl;
    next.price = {
      ...next.price,
      currency: "CNY",
      current: best.priceCny,
      asOf: snapshot.asOf,
      currentEvidence: snapshotToCurrentEvidence(best),
      ...(listingUrl ? { listingUrl } : {}),
      note: [formatSnapshotStamp(meta), best.note, next.price.note].filter(Boolean).join(" · "),
      snapshot: meta,
      ...(best.provenance ? { provenance: best.provenance } : {}),
    };
    return next;
  });

  return {
    ...catalog,
    skus,
    updatedAt: snapshot.asOf,
  };
}

export function snapshotSummary(snapshot: PriceSnapshotFile | null | undefined): {
  asOf: string | null;
  auditedCount: number;
} {
  if (!snapshot) return { asOf: null, auditedCount: 0 };
  return {
    asOf: snapshot.asOf,
    auditedCount: snapshot.quotes.filter(isAuditedQuote).length,
  };
}
