function accessoryKind(sku, ...kinds) {
  return sku.category === "accessory" && typeof sku.attrs?.kind === "string" && kinds.includes(sku.attrs.kind);
}

/**
 * The exhaustive governed mapping used by both the TypeScript save path and
 * the JavaScript-only production backup/Doctor/restore path. A broad catalog
 * category is never enough to relabel an accessory or cooler as an arbitrary
 * V3 component kind.
 */
export const V3_RESOLVED_CATALOG_KIND_MATCHERS = Object.freeze({
  case: (sku) => sku.category === "case",
  motherboard: (sku) => sku.category === "motherboard",
  cpu: (sku) => sku.category === "cpu",
  memory_module: (sku) => sku.category === "memory",
  gpu: (sku) => sku.category === "gpu",
  psu: (sku) => sku.category === "psu",
  cpu_cooler: (sku) => sku.category === "cooler" && ["down-draft", "tower", "air"].includes(String(sku.attrs?.type)),
  aio: (sku) => sku.category === "cooler" && sku.attrs?.type === "aio",
  radiator: (sku) => accessoryKind(sku, "radiator"),
  pump: (sku) => accessoryKind(sku, "pump"),
  case_fan: (sku) => sku.category === "fan" && (!sku.attrs?.kind || sku.attrs.kind === "case-fan"),
  fan_rgb_hub: (sku) => accessoryKind(sku, "fan-hub", "rgb-hub", "fan-rgb-hub"),
  storage_drive: (sku) => sku.category === "storage",
  hba: (sku) => sku.category === "hba" && !["raid", "raid-controller"].includes(String(sku.attrs?.kind ?? sku.attrs?.mode)),
  raid_controller: (sku) => sku.category === "hba" && ["raid", "raid-controller"].includes(String(sku.attrs?.kind ?? sku.attrs?.mode)),
  storage_expander: (sku) => accessoryKind(sku, "storage-expander", "sas-expander"),
  backplane: (sku) => accessoryKind(sku, "backplane"),
  nic: (sku) => accessoryKind(sku, "nic", "network-card"),
  capture_card: (sku) => accessoryKind(sku, "capture-card"),
  expansion_board: (sku) => accessoryKind(sku, "expansion-board"),
  pcie_card: (sku) => accessoryKind(sku, "pcie-card"),
  cable: (sku) => accessoryKind(sku, "cable", "data-cable", "psu-peripheral-cable"),
  adapter: (sku) => accessoryKind(sku, "adapter"),
  bracket: (sku) => accessoryKind(sku, "bracket"),
});

/**
 * Validate only the resolved identity -> merged catalog boundary. Structural
 * topology validation remains the responsibility of the governed V3 contract.
 * This function is deliberately total so malformed documents produce issues
 * instead of making backup/Doctor throw an unrelated JavaScript TypeError.
 */
export function validateResolvedV3CatalogBindingsRuntime(config, catalog) {
  if (config?.schemaVersion !== "3.0.0") return [];
  if (!Array.isArray(catalog?.skus)) return [{ path: "catalog.skus", message: "活动合并目录无效" }];
  const skuById = new Map(catalog.skus
    .filter((sku) => sku && typeof sku === "object" && typeof sku.id === "string")
    .map((sku) => [sku.id, sku]));
  const components = Array.isArray(config.components) ? config.components : [];
  const issues = [];
  for (const [index, component] of components.entries()) {
    if (!component || typeof component !== "object" || !component.identity || typeof component.identity !== "object"
      || component.identity.status !== "resolved") continue;
    const { skuId } = component.identity;
    const { kind } = component;
    if (typeof skuId !== "string" || typeof kind !== "string") continue;
    if (skuId === "gpu.none") {
      issues.push({ path: `components.${index}.identity.skuId`, message: "gpu.none 必须迁为 not_needed RoleDecision，不能作为 V3 组件实例" });
      continue;
    }
    const sku = skuById.get(skuId);
    if (!sku) {
      issues.push({ path: `components.${index}.identity.skuId`, message: `SKU ${skuId} 不存在` });
      continue;
    }
    const matcher = V3_RESOLVED_CATALOG_KIND_MATCHERS[kind];
    if (!matcher || !matcher(sku)) issues.push({
      path: `components.${index}.kind`,
      message: `${kind} 与 SKU ${skuId} 的治理类别/身份不匹配；目录不能证明时必须保留 unresolved`,
    });
  }
  return issues;
}

/** Catalog closure for legacy V2 authorities. Empty optional selections stay
 * progressive; every non-empty identity and BOM row must resolve to the exact
 * governed category in the active merged catalog. */
export function validateResolvedV2CatalogBindingsRuntime(config, catalog) {
  if (config?.schemaVersion !== "2.0.0") return [];
  if (!Array.isArray(catalog?.skus)) return [{ path: "catalog.skus", message: "活动合并目录无效" }];
  const skuById = new Map(catalog.skus
    .filter((sku) => sku && typeof sku === "object" && typeof sku.id === "string")
    .map((sku) => [sku.id, sku]));
  const issues = [];
  const bindings = [
    ["caseId", config.caseId, "case"], ["boardId", config.boardId, "motherboard"], ["cpuId", config.cpuId, "cpu"],
    ["selection.psuId", config.selection?.psuId, "psu"], ["selection.secondaryPsuId", config.selection?.secondaryPsuId, "psu"],
    ["selection.coolerId", config.selection?.coolerId, "cooler"], ["selection.gpuId", config.selection?.gpuId, "gpu"],
    ["selection.memoryId", config.selection?.memoryId, "memory"], ["selection.diskSkuId", config.selection?.diskSkuId, "storage"],
    ["selection.hbaSkuId", config.selection?.hbaSkuId, "hba"],
  ];
  for (const [path, skuId, category] of bindings) {
    if (typeof skuId !== "string" || skuId.length === 0) continue;
    const sku = skuById.get(skuId);
    if (!sku) issues.push({ path, message: `SKU ${skuId} 不存在` });
    else if (sku.category !== category) issues.push({ path, message: `${path} 必须引用 ${category} SKU` });
  }
  const seen = new Set();
  for (const [index, line] of (Array.isArray(config.bom) ? config.bom : []).entries()) {
    if (!line || typeof line !== "object" || typeof line.skuId !== "string") continue;
    if (!skuById.has(line.skuId)) issues.push({ path: `bom.${index}.skuId`, message: `BOM SKU ${line.skuId} 不存在` });
    if (seen.has(line.skuId)) issues.push({ path: `bom.${index}.skuId`, message: "BOM SKU 不能重复" });
    seen.add(line.skuId);
  }
  return issues;
}

export function validateResolvedPlanCatalogBindingsRuntime(config, catalog) {
  return config?.schemaVersion === "2.0.0"
    ? validateResolvedV2CatalogBindingsRuntime(config, catalog)
    : validateResolvedV3CatalogBindingsRuntime(config, catalog);
}
