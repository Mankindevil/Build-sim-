import type { SkuCatalog } from "../sku/types";
import {
  DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY,
  type CaseRuntimeAdapterRegistry,
  type CaseRuntimeLookupIdentity,
} from "../adapters/runtime";

export interface FanMountCapability {
  /** Adapter-issued id; other cases may expose top/bottom or split zones. */
  id: string;
  label: string;
  size: 120 | 140;
  count: number;
  supportedSizes: (120 | 140)[];
  maxCountBySize: Partial<Record<120 | 140, number>>;
  direction: "intake" | "exhaust";
  chamber: "upper" | "lower";
  evidence: "official" | "standard" | "inferred" | "unknown";
  source: string;
}

export interface CaseCapabilities {
  caseId: string;
  trayCount: number;
  backplane: { sataPowerInlets: number; molexInlets: number; evidence: "official" | "standard" | "inferred" | "unknown" };
  /** Ordered, case-specific mounts. Core/UI code must not assume fixed positions. */
  fanMounts: FanMountCapability[];
  psuLimits: { atxMaxLengthMm: number | null; sfxMaxLengthMm: number | null };
  coolerLimits: { overheadAtxMm: number | null; openTopMm: number | null };
  gpuLimits: { planningMinMm: number | null; publishedMaxMm: number | null };
}

export interface BoardCapabilities {
  boardId: string;
  nativeSataPorts: number | null;
  slimsasSataPorts: number | null;
  m2Slots: number | null;
  pcie: { x16Slots: number | null; chipsetX4Slots: number | null; x1Slots: number | null };
  evidence: "official" | "standard" | "inferred" | "unknown";
}

export interface PowerProfile {
  boardBaseW: number | null;
  fanBaseW: number | null;
  fan120W: number | null;
  fan140W: number | null;
  dualSyncW: number | null;
  cpuIdleW: number | null;
  cpuReadW: number | null;
  cpuQuickSyncW: number | null;
  hbaW: number | null;
  driveSpinUpExtraW: number | null;
  evidence: "official" | "standard" | "inferred" | "unknown";
  source: string;
}

export interface WorkloadProfile {
  id: "idle" | "work" | "read" | "quicksync" | "cpu" | "ai" | "combined";
  label: string;
  evidence: "official" | "standard" | "inferred" | "unknown";
}

export interface ThermalProfile {
  airDensityKgM3: number;
  airCpJPerKgK: number;
  systemDerate: { lo: number; hi: number };
  passiveCfm: { lo: number; hi: number };
  evidence: "official" | "standard" | "inferred" | "unknown";
}

/** Explicit registry boundary: an unknown case never inherits another adapter's capabilities. */
export function caseCapabilities(
  caseId: string,
  registry: CaseRuntimeAdapterRegistry = DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY,
  identity?: CaseRuntimeLookupIdentity,
): CaseCapabilities | null {
  const adapter = identity?.skuId === caseId ? registry.resolveExact(identity) : registry.resolveLegacySku(caseId);
  return adapter ? structuredClone(adapter.capabilities) : null;
}

export function orderedFanMounts(capabilities: CaseCapabilities): FanMountCapability[] {
  return [...capabilities.fanMounts];
}

function finiteAttr(attrs: Record<string, unknown> | undefined, key: string): number | null {
  const value = attrs?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function boardCapabilities(catalog: SkuCatalog, boardId: string): BoardCapabilities {
  const board = catalog.skus.find((sku) => sku.id === boardId);
  const attrs = board?.attrs;
  return {
    boardId,
    nativeSataPorts: finiteAttr(attrs, "nativeSataPorts"),
    slimsasSataPorts: finiteAttr(attrs, "slimsasSataPorts"),
    m2Slots: finiteAttr(attrs, "m2Slots"),
    pcie: {
      x16Slots: finiteAttr(attrs, "pcieX16Slots"),
      chipsetX4Slots: finiteAttr(attrs, "pcieChipsetX4Slots"),
      x1Slots: finiteAttr(attrs, "pcieX1Slots"),
    },
    evidence: (attrs?.capabilityEvidence === "official" || attrs?.capabilityEvidence === "standard" || attrs?.capabilityEvidence === "inferred" || attrs?.capabilityEvidence === "unknown")
      ? attrs.capabilityEvidence
      : "unknown",
  };
}

export const WORKLOAD_PROFILES: WorkloadProfile[] = [
  { id: "idle", label: "待机", evidence: "inferred" },
  { id: "work", label: "常规工作", evidence: "inferred" },
  { id: "read", label: "硬盘读取", evidence: "inferred" },
  { id: "quicksync", label: "QuickSync", evidence: "inferred" },
  { id: "cpu", label: "CPU PL1", evidence: "inferred" },
  { id: "ai", label: "GPU / AI", evidence: "inferred" },
  { id: "combined", label: "CPU + GPU + 硬盘同时负载", evidence: "inferred" },
];
