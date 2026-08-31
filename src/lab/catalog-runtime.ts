import type { BuildConfig, BuildConfigDocument } from "../config/types";
import type { SkuCatalog, SkuCategory, SkuRecord } from "../sku/types";

export interface TransactionPlanItem {
  id: string;
  skuId: string;
  name: string;
  category: string;
  placeholder?: boolean;
}

const SLOT_LABELS: Record<SkuCategory, string> = {
  case: "机箱", motherboard: "主板", cpu: "处理器", psu: "电源", cooler: "散热器",
  gpu: "显卡", memory: "内存", storage: "存储", hba: "HBA", fan: "风扇", accessory: "配件",
};

const COMPONENT_CATEGORY: Record<string, SkuCategory> = {
  case: "case", motherboard: "motherboard", cpu: "cpu", memory_module: "memory", gpu: "gpu", psu: "psu",
  cpu_cooler: "cooler", aio: "cooler", radiator: "cooler", pump: "cooler", case_fan: "fan",
  storage_drive: "storage", hba: "hba", raid_controller: "hba", storage_expander: "hba",
  backplane: "accessory", fan_rgb_hub: "accessory", nic: "accessory", capture_card: "accessory",
  expansion_board: "accessory", pcie_card: "accessory", cable: "accessory", adapter: "accessory", bracket: "accessory",
};

function projectedItem(
  catalog: SkuCatalog,
  id: string,
  skuId: string | null | undefined,
  category: SkuCategory,
  emptyLabel = `${SLOT_LABELS[category]}未配置（可关联本次购买）`,
): TransactionPlanItem {
  const normalizedSkuId = skuId?.trim() ?? "";
  const sku = catalog.skus.find((entry) => entry.id === normalizedSkuId && entry.category === category);
  const placeholder = !normalizedSkuId || normalizedSkuId.endsWith(".none");
  return {
    id,
    skuId: normalizedSkuId,
    name: placeholder ? emptyLabel : sku?.name ?? normalizedSkuId,
    category,
    ...(placeholder ? { placeholder: true } : {}),
  };
}

/**
 * Projects stable purchase-link slots from the plan itself. Evaluation BOMs are
 * procurement outputs and can legitimately omit already-owned or unresolved
 * components, so they must not be used as the plan-position index.
 */
export function projectTransactionPlanItems(config: BuildConfigDocument, catalog: SkuCatalog): TransactionPlanItem[] {
  if (config.schemaVersion === "3.0.0") {
    return config.components.map((component) => {
      const category = COMPONENT_CATEGORY[component.kind] ?? "accessory";
      const skuId = component.identity.status === "resolved" ? component.identity.skuId : "";
      const item = projectedItem(catalog, component.instanceId, skuId, category, `${SLOT_LABELS[category]} · ${component.role}（待解析，可关联本次购买）`);
      if (component.identity.status === "unresolved" && component.identity.userText.trim()) return { ...item, name: component.identity.userText.trim(), placeholder: true };
      return item;
    });
  }

  const items: TransactionPlanItem[] = [
    projectedItem(catalog, "case.primary", config.caseId, "case"),
    projectedItem(catalog, "motherboard.primary", config.boardId, "motherboard"),
    projectedItem(catalog, "cpu.primary", config.cpuId, "cpu"),
    projectedItem(catalog, "psu.primary", config.selection.psuId, "psu"),
    projectedItem(catalog, "cooler.primary", config.selection.coolerId, "cooler"),
    projectedItem(catalog, "gpu.primary", config.selection.gpuId, "gpu"),
    projectedItem(catalog, "memory.primary", config.selection.memoryId, "memory"),
    projectedItem(catalog, "storage.primary", config.selection.diskSkuId, "storage"),
    projectedItem(catalog, "hba.primary", config.selection.hbaSkuId, "hba"),
  ];
  if (config.selection.psuTopology === "dual" || config.selection.secondaryPsuId) {
    items.push(projectedItem(catalog, "psu.secondary", config.selection.secondaryPsuId, "psu", "第二颗电源未配置（可关联本次购买）"));
  }
  for (const [index, group] of (config.selection.fanGroups ?? []).entries()) {
    items.push(projectedItem(catalog, `fan.${group.mountId}.${index}`, "", "fan", `${group.mountId} · ${group.sizeMm}mm × ${group.count}（可关联本次购买）`));
  }
  const representedSkuIds = new Set(items.map((item) => item.skuId).filter(Boolean));
  for (const [index, line] of config.bom.entries()) {
    if (representedSkuIds.has(line.skuId)) continue;
    const sku = catalog.skus.find((entry) => entry.id === line.skuId);
    if (!sku) continue;
    items.push({ id: `bom.${index}`, skuId: sku.id, name: `${sku.name} × ${line.qty}`, category: sku.category });
    representedSkuIds.add(sku.id);
  }
  return items;
}

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
  if (sku.category === "case" && (planItemId === "case.primary" || planItemId === config.caseId)) { config.caseId = sku.id; return "机箱"; }
  if (sku.category === "motherboard" && (planItemId === "motherboard.primary" || planItemId === config.boardId)) { config.boardId = sku.id; return "主板"; }
  if (sku.category === "cpu" && (planItemId === "cpu.primary" || planItemId === config.cpuId)) { config.cpuId = sku.id; return "处理器"; }
  if (sku.category === "psu" && (planItemId === "psu.secondary" || planItemId === config.selection.secondaryPsuId)) { config.selection.secondaryPsuId = sku.id; return "第二颗电源"; }
  if (sku.category === "psu" && (planItemId === "psu.primary" || planItemId === config.selection.psuId)) { config.selection.psuId = sku.id; return "电源"; }
  if (sku.category === "cooler" && (planItemId === "cooler.primary" || planItemId === config.selection.coolerId)) { config.selection.coolerId = sku.id; return "CPU 散热器"; }
  if (sku.category === "gpu" && (planItemId === "gpu.primary" || planItemId === config.selection.gpuId)) { config.selection.gpuId = sku.id; return "GPU"; }
  if (sku.category === "memory" && (planItemId === "memory.primary" || planItemId === config.selection.memoryId)) { config.selection.memoryId = sku.id; return "内存"; }
  if (sku.category === "storage" && (planItemId === "storage.primary" || planItemId === config.selection.diskSkuId)) { config.selection.diskSkuId = sku.id; return "数据硬盘"; }
  if (sku.category === "hba" && (planItemId === "hba.primary" || planItemId === config.selection.hbaSkuId)) { config.selection.hbaMode = "always"; config.selection.hbaSkuId = sku.id; return "存储控制器"; }
  return null;
}
