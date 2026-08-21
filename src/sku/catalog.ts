import type { SkuCatalog, SkuRecord } from "./types";

export function indexSkus(catalog: SkuCatalog): Map<string, SkuRecord> {
  return new Map(catalog.skus.map((s) => [s.id, s]));
}

export function requireSku(catalog: SkuCatalog, id: string): SkuRecord {
  const sku = indexSkus(catalog).get(id);
  if (!sku) throw new Error(`Unknown SKU id: ${id}`);
  return sku;
}

export function unknownPrice(): { historicalLowEvidence: "unknown"; currentEvidence: "unknown" } {
  return { historicalLowEvidence: "unknown", currentEvidence: "unknown" };
}
