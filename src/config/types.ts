import type { PurchaseBucket } from "../sku/types";
import type { BuildConfigV3 } from "../topology/contracts";
import { validateBuildConfigV3 } from "../topology/validation";

export type BootMode = "bay" | "m2" | "usbssd";
export type HbaMode = "auto" | "always";
export type PsuTopology = "auto" | "bottom" | "dual";
export type DualStart = "sync" | "none" | null;
export type FanMode = "quiet" | "balanced" | "performance";

/** A populated fan row on a case mount. Mount ids are issued by the case profile. */
export interface CaseFanGroupSelection {
  mountId: string;
  sizeMm: 120 | 140;
  count: number;
}

export interface BuildSelection {
  psuId: string;
  psuTopology: PsuTopology;
  secondaryPsuId?: string | null;
  dualStart?: DualStart;
  coolerId: string;
  gpuId: string;
  memoryId: string;
  diskCount: number;
  diskSkuId?: string;
  /** NVMe drives installed. Past the board's M.2 slots they claim the SlimSAS port. */
  nvmeCount?: number;
  boot: BootMode;
  hbaMode: HbaMode;
  hbaSkuId?: string | null;
  /** Fan policy is persisted with the plan so local and authoritative evaluations agree. */
  fanMode?: FanMode;
  /** Missing on legacy 2.0 configs means “not recorded”; consumers treat it as empty. */
  fanGroups?: CaseFanGroupSelection[];
}

export interface BuildLineItem {
  skuId: string;
  qty: number;
  bucket: PurchaseBucket;
}

export interface BuildConfig {
  schemaVersion: "2.0.0";
  id: string;
  name: string;
  updatedAt: string;
  caseId: string;
  boardId: string;
  cpuId: string;
  selection: BuildSelection;
  bom: BuildLineItem[];
  notes?: string[];
  migration?: {
    fromSchemaVersion: string;
    toSchemaVersion: "2.0.0";
  };
}

export type ConfigV2 = BuildConfig;
export type BuildConfigDocument = ConfigV2 | BuildConfigV3;
export const TOPOLOGY_V3_FEATURE_FLAG = "BUILD_SIM_TOPOLOGY_V3_ENABLED" as const;

export interface ParseConfigOptions {
  topologyV3Enabled?: boolean;
  /** Exact immutable V2 bytes to read while V3 remains disabled. */
  v2FallbackRaw?: string;
}

function configRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactConfigFields(value: unknown, allowed: readonly string[], required: readonly string[] = []): value is Record<string, unknown> {
  return configRecord(value) && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function serializeConfig(config: BuildConfigDocument): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function parseConfigV2Input(input: Record<string, unknown>, version: string): BuildConfig {
  let data: BuildConfig;
  if (version === "2.0.0") {
    data = input as unknown as BuildConfig;
  } else if (version === "1.0.0" || version === "1") {
    const oldSelection = (input.selection && typeof input.selection === "object" ? input.selection : input) as Record<string, unknown>;
    const migrated: BuildConfig = {
      schemaVersion: "2.0.0",
      id: String(input.id ?? ""),
      name: String(input.name ?? ""),
      updatedAt: String(input.updatedAt ?? ""),
      caseId: String(input.caseId ?? ""),
      boardId: String(input.boardId ?? ""),
      cpuId: String(input.cpuId ?? ""),
      selection: {
        psuId: String(oldSelection.psuId ?? ""),
        psuTopology: (oldSelection.psuTopology ?? "auto") as PsuTopology,
        ...(oldSelection.secondaryPsuId ? { secondaryPsuId: String(oldSelection.secondaryPsuId) } : {}),
        ...(oldSelection.dualStart !== undefined ? { dualStart: (oldSelection.dualStart ?? null) as DualStart } : {}),
        coolerId: String(oldSelection.coolerId ?? ""),
        gpuId: String(oldSelection.gpuId ?? ""),
        memoryId: String(oldSelection.memoryId ?? ""),
        diskCount: Number(oldSelection.diskCount),
        ...(oldSelection.diskSkuId ? { diskSkuId: String(oldSelection.diskSkuId) } : {}),
        ...(oldSelection.nvmeCount !== undefined ? { nvmeCount: Number(oldSelection.nvmeCount) } : {}),
        boot: (oldSelection.boot ?? "bay") as BootMode,
        hbaMode: (oldSelection.hbaMode ?? "auto") as HbaMode,
        ...(oldSelection.hbaSkuId ? { hbaSkuId: String(oldSelection.hbaSkuId) } : {}),
        fanMode: "balanced",
        fanGroups: [],
      },
      bom: Array.isArray(input.bom) ? input.bom as BuildLineItem[] : [],
      ...(Array.isArray(input.notes) ? { notes: input.notes.map(String) } : {}),
      migration: { fromSchemaVersion: version, toSchemaVersion: "2.0.0" },
    };
    data = migrated;
  } else {
    throw new Error(`Unsupported config schema: ${version || "missing"}`);
  }
  const record = data as unknown as Record<string, unknown>;
  const topFields = ["schemaVersion", "id", "name", "updatedAt", "caseId", "boardId", "cpuId", "selection", "bom", "notes", "migration"];
  const topRequired = ["schemaVersion", "id", "name", "updatedAt", "caseId", "boardId", "cpuId", "selection", "bom"];
  if (!exactConfigFields(record, topFields, topRequired)) throw new Error("Malformed BuildConfig: unknown or missing fields");
  if (record.schemaVersion !== "2.0.0" || typeof record.id !== "string" || !record.id || typeof record.name !== "string" || !record.name
    || typeof record.updatedAt !== "string" || !record.updatedAt || typeof record.caseId !== "string" || typeof record.boardId !== "string" || typeof record.cpuId !== "string"
    || !configRecord(record.selection) || !Array.isArray(record.bom)) throw new Error("Malformed BuildConfig: missing required fields");
  const selection = record.selection;
  const selectionFields = ["psuId", "psuTopology", "secondaryPsuId", "dualStart", "coolerId", "gpuId", "memoryId", "diskCount", "diskSkuId", "nvmeCount", "boot", "hbaMode", "hbaSkuId", "fanMode", "fanGroups"];
  const selectionRequired = ["psuId", "psuTopology", "coolerId", "gpuId", "memoryId", "diskCount", "boot", "hbaMode"];
  if (!exactConfigFields(selection, selectionFields, selectionRequired)
    || [selection.psuId, selection.coolerId, selection.gpuId, selection.memoryId].some((value) => typeof value !== "string")
    || (selection.secondaryPsuId !== undefined && selection.secondaryPsuId !== null && typeof selection.secondaryPsuId !== "string")
    || (selection.diskSkuId !== undefined && typeof selection.diskSkuId !== "string")
    || (selection.hbaSkuId !== undefined && selection.hbaSkuId !== null && typeof selection.hbaSkuId !== "string")) throw new Error("Malformed BuildConfig: invalid selection shape");
  if (!Number.isSafeInteger(selection.diskCount) || Number(selection.diskCount) < 0) throw new Error("Malformed BuildConfig: diskCount must be a non-negative integer");
  if (selection.nvmeCount !== undefined && (!Number.isSafeInteger(selection.nvmeCount) || Number(selection.nvmeCount) < 0)) throw new Error("Malformed BuildConfig: nvmeCount must be a non-negative integer");
  if (!["auto", "bottom", "dual"].includes(String(selection.psuTopology))) throw new Error("Malformed BuildConfig: invalid PSU topology");
  if (!["bay", "m2", "usbssd"].includes(String(selection.boot))) throw new Error("Malformed BuildConfig: invalid boot mode");
  if (!["auto", "always"].includes(String(selection.hbaMode))) throw new Error("Malformed BuildConfig: invalid HBA mode");
  if (selection.dualStart !== undefined && selection.dualStart !== null && !["sync", "none"].includes(String(selection.dualStart))) throw new Error("Malformed BuildConfig: invalid dual start mode");
  if (selection.fanMode !== undefined && !["quiet", "balanced", "performance"].includes(String(selection.fanMode))) throw new Error("Malformed BuildConfig: invalid fan mode");
  if (selection.fanGroups !== undefined) {
    if (!Array.isArray(selection.fanGroups) || selection.fanGroups.length > 16) throw new Error("Malformed BuildConfig: invalid fan groups");
    const seen = new Set<string>();
    for (const group of selection.fanGroups) {
      if (!exactConfigFields(group, ["mountId", "sizeMm", "count"], ["mountId", "sizeMm", "count"]) || typeof group.mountId !== "string" || !group.mountId.trim()) throw new Error("Malformed BuildConfig: invalid fan mount id");
      if (seen.has(group.mountId)) throw new Error("Malformed BuildConfig: duplicate fan mount id");
      seen.add(group.mountId);
      if (group.sizeMm !== 120 && group.sizeMm !== 140) throw new Error("Malformed BuildConfig: invalid fan size");
      if (!Number.isSafeInteger(group.count) || Number(group.count) < 1 || Number(group.count) > 16) throw new Error("Malformed BuildConfig: invalid fan count");
    }
  }
  const seenBom = new Set<string>();
  for (const line of record.bom) {
    if (!exactConfigFields(line, ["skuId", "qty", "bucket"], ["skuId", "qty", "bucket"]) || typeof line.skuId !== "string" || !line.skuId.trim()
      || !Number.isSafeInteger(line.qty) || Number(line.qty) <= 0 || !["owned", "buy_now", "upgrade_later", "optional"].includes(String(line.bucket))) throw new Error("Malformed BuildConfig: invalid BOM line");
    if (seenBom.has(line.skuId)) throw new Error("Malformed BuildConfig: duplicate BOM SKU");
    seenBom.add(line.skuId);
  }
  if (record.notes !== undefined && (!Array.isArray(record.notes) || record.notes.some((note) => typeof note !== "string"))) throw new Error("Malformed BuildConfig: invalid notes");
  if (record.migration !== undefined && (!exactConfigFields(record.migration, ["fromSchemaVersion", "toSchemaVersion"], ["fromSchemaVersion", "toSchemaVersion"])
    || typeof record.migration.fromSchemaVersion !== "string" || !record.migration.fromSchemaVersion || record.migration.toSchemaVersion !== "2.0.0")) throw new Error("Malformed BuildConfig: invalid migration metadata");
  return data;
}

export function parseConfig(raw: string): BuildConfig;
export function parseConfig(raw: string, options: ParseConfigOptions & { topologyV3Enabled: false }): BuildConfig;
export function parseConfig(raw: string, options: ParseConfigOptions & { topologyV3Enabled: true }): BuildConfigDocument;
export function parseConfig(raw: string, options: ParseConfigOptions): BuildConfigDocument;
export function parseConfig(raw: string, options: ParseConfigOptions = {}): BuildConfigDocument {
  const input = JSON.parse(raw) as Record<string, unknown>;
  const version = String(input.schemaVersion ?? "");
  if (version !== "3.0.0") return parseConfigV2Input(input, version);
  if (options.topologyV3Enabled !== true) {
    if (options.v2FallbackRaw !== undefined) {
      const fallbackInput = JSON.parse(options.v2FallbackRaw) as Record<string, unknown>;
      const fallbackVersion = String(fallbackInput.schemaVersion ?? "");
      if (fallbackVersion !== "2.0.0") throw new Error(`${TOPOLOGY_V3_FEATURE_FLAG}=false requires immutable schema 2.0.0 fallback bytes`);
      if (typeof input.id !== "string" || fallbackInput.id !== input.id) {
        throw new Error(`${TOPOLOGY_V3_FEATURE_FLAG}=false fallback identity does not match the V3 config`);
      }
      return parseConfigV2Input(fallbackInput, fallbackVersion);
    }
    throw new Error(`BuildConfig V3 is disabled; enable ${TOPOLOGY_V3_FEATURE_FLAG} or provide immutable V2 fallback bytes`);
  }
  const errors = validateBuildConfigV3(input);
  if (errors.length > 0) throw new Error(`Malformed BuildConfigV3: ${errors.join("; ")}`);
  return input as unknown as BuildConfigV3;
}
