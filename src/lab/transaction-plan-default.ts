import type { BuildConfig } from "../config/types";
import type { SkuCatalog } from "../sku/types";
import type { BuildProgressItem } from "./build-progress";

export function applyArchivedPurchasesAsDefaults(config: BuildConfig, items: BuildProgressItem[], planId: string, catalog: SkuCatalog): string[] {
  const changed: string[] = [];
  for (const item of items) {
    if (!item.skuId || !["purchased", "installed"].includes(item.stage) || item.planLink?.linkStatus !== "linked" || item.planLink.planId !== planId) continue;
    const sku = catalog.skus.find((entry) => entry.id === item.skuId);
    if (!sku) continue;
    const previous = item.planLink.planItemId;
    let updated = false;
    if (sku.category === "case") { updated = config.caseId !== sku.id; config.caseId = sku.id; }
    else if (sku.category === "motherboard") { updated = config.boardId !== sku.id; config.boardId = sku.id; }
    else if (sku.category === "cpu") { updated = config.cpuId !== sku.id; config.cpuId = sku.id; }
    else if (sku.category === "psu" && config.selection.secondaryPsuId === previous) { updated = config.selection.secondaryPsuId !== sku.id; config.selection.secondaryPsuId = sku.id; }
    else if (sku.category === "psu") { updated = config.selection.psuId !== sku.id; config.selection.psuId = sku.id; }
    else if (sku.category === "cooler") { updated = config.selection.coolerId !== sku.id; config.selection.coolerId = sku.id; }
    else if (sku.category === "gpu") { updated = config.selection.gpuId !== sku.id; config.selection.gpuId = sku.id; }
    else if (sku.category === "memory") { updated = config.selection.memoryId !== sku.id; config.selection.memoryId = sku.id; }
    else if (sku.category === "storage") { updated = config.selection.diskSkuId !== sku.id; config.selection.diskSkuId = sku.id; }
    else if (sku.category === "hba") { updated = config.selection.hbaSkuId !== sku.id; config.selection.hbaSkuId = sku.id; }
    if (updated) changed.push(sku.name);
  }
  if (changed.length) config.updatedAt = new Date().toISOString();
  return changed;
}
