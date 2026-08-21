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
}

export function serializeConfig(config: BuildConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function parseConfig(raw: string): BuildConfig {
  const data = JSON.parse(raw) as BuildConfig;
  if (data.schemaVersion !== "2.0.0") {
    throw new Error(`Unsupported config schema: ${String((data as { schemaVersion?: string }).schemaVersion)}`);
  }
  return data;
}
