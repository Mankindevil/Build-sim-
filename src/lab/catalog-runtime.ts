import type { BuildConfig } from "../config/types";
import type { SkuCatalog, SkuCategory, SkuRecord } from "../sku/types";

function catalogOptionLabel(sku: SkuRecord): string {
  const capacity = typeof sku.attrs?.capacity === "string" ? sku.attrs.capacity
    : typeof sku.attrs?.vramGb === "number" ? `${sku.attrs.vramGb}GB`
      : null;
  const powerValue = sku.power.tgpW ?? sku.power.ratedW ?? sku.power.tdpW;
  const power = typeof powerValue === "number" ? `${powerValue}W` : null;
  return [sku.name, capacity, power].filter(Boolean).join(" · ");
}

export function upsertCatalogSku(catalog: SkuCatalog, sku: SkuRecord): SkuCatalog {
  const skus = catalog.skus.some((entry) => entry.id === sku.id)
    ? catalog.skus.map((entry) => entry.id === sku.id ? sku : entry)
    : [...catalog.skus, sku];
  return { ...catalog, skus };
}

/** Keeps a legacy selector (and the workspace editor cloned from it) on the runtime catalog. */
export function syncCatalogCategoryOptions(select: HTMLSelectElement, catalog: SkuCatalog, category: SkuCategory): void {
  for (const sku of catalog.skus.filter((entry) => entry.category === category)) {
    let option = [...select.options].find((entry) => entry.value === sku.id);
    if (!option) {
      option = document.createElement("option");
      option.value = sku.id;
      option.dataset.runtimeCatalog = "true";
      select.append(option);
    }
    // Existing bundled options may be enriched in place. Keep their label on
    // the same runtime record too, rather than only updating newly appended
    // options and leaving stale capacity/power copy in the editor.
    option.textContent = catalogOptionLabel(sku);
  }
}

export function syncGpuCatalogOptions(select: HTMLSelectElement, catalog: SkuCatalog): void {
  syncCatalogCategoryOptions(select, catalog, "gpu");
}

/**
 * Applies an explicitly reviewed SKU only to the plan item the user linked.
 * Returning null means the SKU remains in the formal catalog without silently
 * replacing an unrelated component.
 */
export function applyAcceptedCatalogSkuToPlan(config: BuildConfig, sku: SkuRecord, planItemId: string | null): string | null {
  if (!planItemId) return null;
  if (sku.category === "case" && planItemId === config.caseId) { config.caseId = sku.id; return "机箱"; }
  if (sku.category === "motherboard" && planItemId === config.boardId) { config.boardId = sku.id; return "主板"; }
  if (sku.category === "cpu" && planItemId === config.cpuId) { config.cpuId = sku.id; return "处理器"; }
  if (sku.category === "psu" && planItemId === config.selection.secondaryPsuId) { config.selection.secondaryPsuId = sku.id; return "第二颗电源"; }
  if (sku.category === "psu" && planItemId === config.selection.psuId) { config.selection.psuId = sku.id; return "电源"; }
  if (sku.category === "cooler" && planItemId === config.selection.coolerId) { config.selection.coolerId = sku.id; return "CPU 散热器"; }
  if (sku.category === "gpu" && (planItemId === "gpu.primary" || planItemId === config.selection.gpuId)) { config.selection.gpuId = sku.id; return "GPU"; }
  if (sku.category === "memory" && planItemId === config.selection.memoryId) { config.selection.memoryId = sku.id; return "内存"; }
  if (sku.category === "storage" && planItemId === config.selection.diskSkuId) { config.selection.diskSkuId = sku.id; return "数据硬盘"; }
  if (sku.category === "hba" && planItemId === config.selection.hbaSkuId) { config.selection.hbaMode = "always"; config.selection.hbaSkuId = sku.id; return "存储控制器"; }
  return null;
}
