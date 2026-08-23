import type { BuildConfig } from "./types";
import type { SkuCatalog, SkuCategory } from "../sku/types";
import { boardCapabilities, n6CaseCapabilities } from "../core/capabilities";
import { needsHba } from "../core/policy";

export interface ConfigValidationIssue {
  path: string;
  message: string;
  verdict: "bad" | "warn";
}

const categories: Record<string, SkuCategory> = {
  caseId: "case",
  boardId: "motherboard",
  cpuId: "cpu",
};

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function validateConfig(config: BuildConfig, catalog: SkuCatalog): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (config.schemaVersion !== "2.0.0") issues.push({ path: "schemaVersion", message: "必须使用配置 schema 2.0.0", verdict: "bad" });
  if (!config.id || !config.name) issues.push({ path: "id/name", message: "配置必须有 id 和 name", verdict: "bad" });

  const skuById = new Map(catalog.skus.map((sku) => [sku.id, sku]));
  for (const [field, category] of Object.entries(categories)) {
    const id = config[field as keyof BuildConfig];
    const sku = typeof id === "string" ? skuById.get(id) : undefined;
    if (!sku) issues.push({ path: field, message: `SKU ${String(id)} 不存在`, verdict: "bad" });
    else if (sku.category !== category) issues.push({ path: field, message: `${field} 必须引用 ${category} SKU`, verdict: "bad" });
  }

  const selection = config.selection;
  if (!selection || typeof selection !== "object") {
    issues.push({ path: "selection", message: "缺少 selection", verdict: "bad" });
    return issues;
  }
  const requiredSelections: [keyof typeof selection, SkuCategory][] = [
    ["psuId", "psu"], ["coolerId", "cooler"], ["gpuId", "gpu"], ["memoryId", "memory"],
  ];
  for (const [field, category] of requiredSelections) {
    const id = selection[field];
    const sku = typeof id === "string" ? skuById.get(id) : undefined;
    if (!sku) issues.push({ path: `selection.${String(field)}`, message: `SKU ${String(id)} 不存在`, verdict: "bad" });
    else if (sku.category !== category) issues.push({ path: `selection.${String(field)}`, message: `${String(field)} 必须引用 ${category} SKU`, verdict: "bad" });
  }
  if (selection.secondaryPsuId) {
    const secondary = skuById.get(selection.secondaryPsuId);
    if (!secondary || secondary.category !== "psu") issues.push({ path: "selection.secondaryPsuId", message: "secondaryPsuId 必须引用 PSU SKU", verdict: "bad" });
  }
  if (selection.diskSkuId) {
    const disk = skuById.get(selection.diskSkuId);
    if (!disk || disk.category !== "storage") issues.push({ path: "selection.diskSkuId", message: "diskSkuId 必须引用 storage SKU", verdict: "bad" });
  }
  if (selection.hbaSkuId) {
    const hba = skuById.get(selection.hbaSkuId);
    if (!hba || hba.category !== "hba") issues.push({ path: "selection.hbaSkuId", message: "hbaSkuId 必须引用 HBA SKU", verdict: "bad" });
  }
  if (!["auto", "bottom", "dual"].includes(selection.psuTopology)) issues.push({ path: "selection.psuTopology", message: "PSU 拓扑无效", verdict: "bad" });
  if (!["bay", "m2", "usbssd"].includes(selection.boot)) issues.push({ path: "selection.boot", message: "启动盘模式无效", verdict: "bad" });
  if (!["auto", "always"].includes(selection.hbaMode)) issues.push({ path: "selection.hbaMode", message: "HBA 模式无效", verdict: "bad" });
  if (selection.psuTopology === "dual" && !selection.secondaryPsuId) issues.push({ path: "selection.secondaryPsuId", message: "dual 拓扑必须锁定 secondary PSU SKU", verdict: "bad" });
  if (selection.psuTopology !== "dual" && (selection.secondaryPsuId || selection.dualStart)) issues.push({ path: "selection.secondaryPsuId", message: "非 dual 拓扑不能携带 secondary PSU/dualStart", verdict: "bad" });
  if (selection.psuTopology === "dual" && !["sync", "none"].includes(selection.dualStart ?? "")) issues.push({ path: "selection.dualStart", message: "dual 拓扑必须明确 sync 或 none", verdict: "bad" });
  if (!isFiniteInteger(selection.diskCount) || selection.diskCount < 0) issues.push({ path: "selection.diskCount", message: "diskCount 必须是非负整数", verdict: "bad" });
  if (selection.nvmeCount !== undefined && (!isFiniteInteger(selection.nvmeCount) || selection.nvmeCount < 0)) issues.push({ path: "selection.nvmeCount", message: "nvmeCount 必须是非负整数", verdict: "bad" });

  const caseCaps = n6CaseCapabilities();
  if (isFiniteInteger(selection.diskCount) && selection.diskCount > caseCaps.trayCount) issues.push({ path: "selection.diskCount", message: `数据盘不能超过 N6 ${caseCaps.trayCount} 个托架`, verdict: "bad" });
  if (selection.boot === "bay" && isFiniteInteger(selection.diskCount) && selection.diskCount >= caseCaps.trayCount) issues.push({ path: "selection.boot", message: "SATA Boot 与占满全部托架冲突", verdict: "bad" });
  const boardCaps = boardCapabilities(catalog, config.boardId);
  if (boardCaps.nativeSataPorts === null || boardCaps.slimsasSataPorts === null || boardCaps.m2Slots === null) issues.push({ path: "board.capabilities", message: "主板 SATA/SlimSAS/M.2 capability 不完整，相关接线保持 unknown", verdict: "warn" });
  if (selection.hbaMode === "auto" && boardCaps.nativeSataPorts !== null && boardCaps.slimsasSataPorts !== null) {
    const hba = needsHba(selection, { nativeSata: boardCaps.nativeSataPorts, slimsasSata: boardCaps.slimsasSataPorts });
    if (hba && !selection.hbaSkuId) issues.push({ path: "selection.hbaSkuId", message: "当前盘位需要 HBA，但没有锁定 HBA SKU", verdict: "bad" });
  }

  const seenBom = new Set<string>();
  for (const [index, line] of (config.bom ?? []).entries()) {
    const sku = skuById.get(line.skuId);
    if (!sku) issues.push({ path: `bom.${index}.skuId`, message: `BOM SKU ${line.skuId} 不存在`, verdict: "bad" });
    if (seenBom.has(line.skuId)) issues.push({ path: `bom.${index}.skuId`, message: "BOM SKU 不能重复，需先聚合数量", verdict: "bad" });
    seenBom.add(line.skuId);
    if (!isFiniteInteger(line.qty) || line.qty <= 0) issues.push({ path: `bom.${index}.qty`, message: "BOM qty 必须是正整数", verdict: "bad" });
    if (!["owned", "buy_now", "upgrade_later", "optional"].includes(line.bucket)) issues.push({ path: `bom.${index}.bucket`, message: "BOM bucket 无效", verdict: "bad" });
  }
  return issues;
}

export function assertValidConfig(config: BuildConfig, catalog: SkuCatalog): void {
  const issues = validateConfig(config, catalog).filter((issue) => issue.verdict === "bad");
  if (issues.length > 0) throw new Error(`Invalid BuildConfig: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
}
