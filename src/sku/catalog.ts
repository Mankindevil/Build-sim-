import type { SkuCatalog, SkuRecord } from "./types";
import catalogJson from "../../data/skus/catalog.json";
import latestPrices from "../../data/prices/latest.json";
import { applyPriceSnapshot, snapshotSummary } from "../price/merge";
import type { PriceSnapshotFile } from "../price/types";

export function indexSkus(catalog: SkuCatalog): Map<string, SkuRecord> {
  return new Map(catalog.skus.map((s) => [s.id, s]));
}

export function requireSku(catalog: SkuCatalog, id: string): SkuRecord {
  const sku = indexSkus(catalog).get(id);
  if (!sku) throw new Error(`Unknown SKU id: ${id}`);
  return sku;
}

export function unknownPrice(): {
  historicalLowEvidence: "unknown";
  currentEvidence: "unknown";
} {
  return { historicalLowEvidence: "unknown", currentEvidence: "unknown" };
}

export function loadBundledPriceSnapshot(): PriceSnapshotFile {
  return latestPrices as PriceSnapshotFile;
}

/** Catalog with audited price snapshots merged in (never fabricates missing quotes). */
export function loadBundledCatalog(): SkuCatalog {
  return applyPriceSnapshot(catalogJson as SkuCatalog, loadBundledPriceSnapshot());
}

/** Raw catalog JSON without price overlay (tests / refresh tooling). */
export function loadRawCatalog(): SkuCatalog {
  return catalogJson as SkuCatalog;
}

export function bundledPriceSummary(): { asOf: string | null; auditedCount: number } {
  return snapshotSummary(loadBundledPriceSnapshot());
}

export function skusByCategory(catalog: SkuCatalog, category: SkuRecord["category"]): SkuRecord[] {
  return catalog.skus.filter((s) => s.category === category);
}

export function resolveSelectionIds(config: {
  caseId: string;
  boardId: string;
  cpuId: string;
  selection: {
    psuId: string;
    secondaryPsuId?: string | null;
    coolerId: string;
    gpuId: string;
    memoryId: string;
    diskSkuId?: string;
    hbaSkuId?: string | null;
  };
}): string[] {
  const ids = [
    config.caseId,
    config.boardId,
    config.cpuId,
    config.selection.psuId,
    config.selection.coolerId,
    config.selection.gpuId,
    config.selection.memoryId,
  ];
  if (config.selection.secondaryPsuId) ids.push(config.selection.secondaryPsuId);
  if (config.selection.diskSkuId) ids.push(config.selection.diskSkuId);
  if (config.selection.hbaSkuId) ids.push(config.selection.hbaSkuId);
  return ids;
}
