import type { BuildConfig, BuildConfigDocument } from "./types";
import type { SkuCatalog, SkuCategory, SkuRecord } from "../sku/types";
import type { ComponentKindId } from "../contracts/registries";
import { validateBuildConfigV3 } from "../topology/validation";
import { boardCapabilities, caseCapabilities, orderedFanMounts } from "../core/capabilities";
import { needsHba } from "../core/policy";
import {
  V3_RESOLVED_CATALOG_KIND_MATCHERS,
  validateResolvedV3CatalogBindingsRuntime,
} from "./v3-catalog-runtime.mjs";

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

const selectionCategories = [
  ["psuId", "psu"], ["coolerId", "cooler"], ["gpuId", "gpu"], ["memoryId", "memory"],
] as const satisfies readonly (readonly [keyof BuildConfig["selection"], SkuCategory])[];

export interface BuildReadiness {
  status: "ready" | "incomplete";
  missing: string[];
}

/** Full N6 geometry/wiring only runs after every core identity is explicit. */
export function buildReadiness(config: BuildConfig, catalog: SkuCatalog): BuildReadiness {
  const skuById = new Map(catalog.skus.map((sku) => [sku.id, sku]));
  const missing: string[] = [];
  for (const [field, category] of Object.entries(categories)) {
    const id = config[field as keyof BuildConfig];
    if (typeof id !== "string" || !id || skuById.get(id)?.category !== category) missing.push(field);
  }
  for (const [field, category] of selectionCategories) {
    const id = config.selection?.[field];
    if (typeof id !== "string" || !id || skuById.get(id)?.category !== category) missing.push(`selection.${String(field)}`);
  }
  if (config.caseId && !caseCapabilities(config.caseId)) missing.push("case.adapter");
  if (config.selection?.diskCount > 0 && (!config.selection.diskSkuId || skuById.get(config.selection.diskSkuId)?.category !== "storage")) missing.push("selection.diskSkuId");
  return { status: missing.length ? "incomplete" : "ready", missing };
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateConfigV2(config: BuildConfig, catalog: SkuCatalog): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (config.schemaVersion !== "2.0.0") issues.push({ path: "schemaVersion", message: "必须使用配置 schema 2.0.0", verdict: "bad" });
  if (!config.id || !config.name) issues.push({ path: "id/name", message: "配置必须有 id 和 name", verdict: "bad" });

  const skuById = new Map(catalog.skus.map((sku) => [sku.id, sku]));
  for (const [field, category] of Object.entries(categories)) {
    const id = config[field as keyof BuildConfig];
    const sku = typeof id === "string" ? skuById.get(id) : undefined;
    if (!id) issues.push({ path: field, message: `${field} 尚未选择`, verdict: "warn" });
    else if (!sku) issues.push({ path: field, message: `SKU ${String(id)} 不存在`, verdict: "bad" });
    else if (sku.category !== category) issues.push({ path: field, message: `${field} 必须引用 ${category} SKU`, verdict: "bad" });
  }

  const selection = config.selection;
  if (!selection || typeof selection !== "object") {
    issues.push({ path: "selection", message: "缺少 selection", verdict: "bad" });
    return issues;
  }
  for (const [field, category] of selectionCategories) {
    const id = selection[field];
    const sku = typeof id === "string" ? skuById.get(id) : undefined;
    if (!id) issues.push({ path: `selection.${String(field)}`, message: `${String(field)} 尚未选择`, verdict: "warn" });
    else if (!sku) issues.push({ path: `selection.${String(field)}`, message: `SKU ${String(id)} 不存在`, verdict: "bad" });
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

  const caseCaps = caseCapabilities(config.caseId);
  if (config.caseId && !caseCaps) issues.push({ path: "caseId", message: "当前机箱没有已审核的能力适配器，空间和风扇位置保持 unavailable", verdict: "warn" });
  if (caseCaps && isFiniteInteger(selection.diskCount) && selection.diskCount > caseCaps.trayCount) issues.push({ path: "selection.diskCount", message: `数据盘不能超过机箱 ${caseCaps.trayCount} 个托架`, verdict: "bad" });
  if (caseCaps && selection.boot === "bay" && isFiniteInteger(selection.diskCount) && selection.diskCount >= caseCaps.trayCount) issues.push({ path: "selection.boot", message: "SATA Boot 与占满全部托架冲突", verdict: "bad" });

  const fanMode = selection.fanMode ?? "balanced";
  if (!["quiet", "balanced", "performance"].includes(fanMode)) issues.push({ path: "selection.fanMode", message: "风扇策略无效", verdict: "bad" });
  const groups = selection.fanGroups ?? [];
  const mounts = new Map((caseCaps ? orderedFanMounts(caseCaps) : []).map((mount) => [mount.id, mount]));
  const seenMounts = new Set<string>();
  for (const [index, group] of groups.entries()) {
    const path = `selection.fanGroups.${index}`;
    if (seenMounts.has(group.mountId)) issues.push({ path: `${path}.mountId`, message: "同一安装位只能配置一个风扇组", verdict: "bad" });
    seenMounts.add(group.mountId);
    const mount = mounts.get(group.mountId);
    if (!mount) {
      issues.push({ path: `${path}.mountId`, message: caseCaps ? "安装位不属于当前机箱" : "当前机箱没有可验证的风扇安装位", verdict: "bad" });
      continue;
    }
    if (!mount.supportedSizes.includes(group.sizeMm)) issues.push({ path: `${path}.sizeMm`, message: `${mount.label} 不支持 ${group.sizeMm}mm 风扇`, verdict: "bad" });
    const max = mount.maxCountBySize[group.sizeMm];
    if (!isFiniteInteger(group.count) || group.count < 1 || max === undefined || group.count > max) issues.push({ path: `${path}.count`, message: `${mount.label} 的数量必须在 1–${max ?? 0} 之间`, verdict: "bad" });
  }
  if ((selection.psuTopology === "bottom" || selection.psuTopology === "dual") && groups.some((group) => group.mountId === "left")) issues.push({ path: "selection.fanGroups", message: "下置/双电源会拆除左侧风扇架，不能同时安装左侧盘区风扇", verdict: "bad" });
  const primaryPsu = skuById.get(selection.psuId);
  const primaryForm = primaryPsu?.attrs?.form;
  if (primaryForm === "ATX" && (selection.psuTopology === "auto" || selection.psuTopology === "dual") && groups.some((group) => group.mountId === "rear")) issues.push({ path: "selection.fanGroups", message: "后上 ATX 电源占用后部 120mm 风扇位", verdict: "bad" });
  if (primaryForm === "SFX" && (selection.psuTopology === "auto" || selection.psuTopology === "dual") && groups.some((group) => group.mountId === "front")) issues.push({ path: "selection.fanGroups", message: "前置 SFX 与完整前风扇位没有已确认的共存空间，当前按保守冲突处理", verdict: "bad" });
  const cooler = skuById.get(selection.coolerId);
  if (cooler?.attrs?.fitHint === "front240" && groups.some((group) => group.mountId === "front")) issues.push({ path: "selection.fanGroups", message: "前置 240 冷排已经占用前部风扇位，不能再重复配置机箱风扇", verdict: "bad" });

  const boardCaps = config.boardId ? boardCapabilities(catalog, config.boardId) : null;
  if (boardCaps && (boardCaps.nativeSataPorts === null || boardCaps.slimsasSataPorts === null || boardCaps.m2Slots === null)) issues.push({ path: "board.capabilities", message: "主板 SATA/SlimSAS/M.2 capability 不完整，相关接线保持 unknown", verdict: "warn" });
  if (boardCaps && selection.hbaMode === "auto" && boardCaps.nativeSataPorts !== null && boardCaps.slimsasSataPorts !== null) {
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

export interface ConfigValidationOptions {
  topologyV3Enabled?: boolean;
}

/**
 * Compile-time coverage guard for the shared JS runtime matcher. Adding a new
 * governed component kind cannot silently leave save and production paths with
 * different identity semantics.
 */
const v3CatalogKindCoverage: Readonly<Record<ComponentKindId, (sku: SkuRecord) => boolean>> = V3_RESOLVED_CATALOG_KIND_MATCHERS;
void v3CatalogKindCoverage;

export function validateConfig(config: BuildConfigDocument, catalog: SkuCatalog, options: ConfigValidationOptions = {}): ConfigValidationIssue[] {
  if (config.schemaVersion === "2.0.0") return validateConfigV2(config, catalog);
  if (options.topologyV3Enabled !== true) {
    return [{ path: "schemaVersion", message: "BuildConfig V3 需要启用 BUILD_SIM_TOPOLOGY_V3_ENABLED", verdict: "bad" }];
  }
  const issues: ConfigValidationIssue[] = validateBuildConfigV3(config).map((message) => ({
    path: "topology",
    message,
    verdict: "bad" as const,
  }));
  issues.push(...validateResolvedV3CatalogBindingsRuntime(config, catalog).map((issue) => ({ ...issue, verdict: "bad" as const })));
  return issues;
}

export function assertValidConfig(config: BuildConfigDocument, catalog: SkuCatalog, options: ConfigValidationOptions = {}): void {
  const issues = validateConfig(config, catalog, options).filter((issue) => issue.verdict === "bad");
  if (issues.length > 0) throw new Error(`Invalid BuildConfig: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
}
