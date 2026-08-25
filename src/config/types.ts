import type { PurchaseBucket } from "../sku/types";

export type BootMode = "bay" | "m2" | "usbssd";
export type HbaMode = "auto" | "always";
export type PsuTopology = "auto" | "bottom" | "dual";
export type DualStart = "sync" | "none" | null;

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

export function serializeConfig(config: BuildConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function parseConfig(raw: string): BuildConfig {
  const input = JSON.parse(raw) as Record<string, unknown>;
  const version = String(input.schemaVersion ?? "");
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
      },
      bom: Array.isArray(input.bom) ? input.bom as BuildLineItem[] : [],
      ...(Array.isArray(input.notes) ? { notes: input.notes.map(String) } : {}),
      migration: { fromSchemaVersion: version, toSchemaVersion: "2.0.0" },
    };
    data = migrated;
  } else {
    throw new Error(`Unsupported config schema: ${version || "missing"}`);
  }
  if (!data.id || !data.name || !data.updatedAt || !data.selection || !Array.isArray(data.bom)) throw new Error("Malformed BuildConfig: missing required fields");
  if (!Number.isInteger(data.selection.diskCount) || data.selection.diskCount < 0) throw new Error("Malformed BuildConfig: diskCount must be a non-negative integer");
  if (!["auto", "bottom", "dual"].includes(data.selection.psuTopology)) throw new Error("Malformed BuildConfig: invalid PSU topology");
  if (!["bay", "m2", "usbssd"].includes(data.selection.boot)) throw new Error("Malformed BuildConfig: invalid boot mode");
  if (!["auto", "always"].includes(data.selection.hbaMode)) throw new Error("Malformed BuildConfig: invalid HBA mode");
  return data;
}
