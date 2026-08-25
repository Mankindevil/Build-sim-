import type { SkuCatalog } from "../sku/types";
import n6Profile from "../../data/cases/jonsbo-n6/profile.json";

export interface FanMountCapability {
  size: 120 | 140;
  count: number;
  evidence: "official" | "standard" | "inferred" | "unknown";
}

export interface CaseCapabilities {
  caseId: string;
  trayCount: number;
  backplane: { sataPowerInlets: number; molexInlets: number; evidence: "official" | "standard" | "inferred" | "unknown" };
  fanMounts: { front: FanMountCapability; rear: FanMountCapability; left: FanMountCapability; right: FanMountCapability };
  psuLimits: { atxMaxLengthMm: number; sfxMaxLengthMm: number };
  coolerLimits: { overheadAtxMm: number; openTopMm: number };
  gpuLimits: { planningMinMm: number; publishedMaxMm: number };
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

export function n6CaseCapabilities(): CaseCapabilities {
  const p = n6Profile;
  const evidence = (value: unknown): FanMountCapability["evidence"] =>
    value === "official" || value === "standard" || value === "inferred" || value === "unknown" ? value : "inferred";
  const fanSize = (value: unknown): 120 | 140 => value === 140 ? 140 : 120;
  return {
    caseId: p.caseId,
    trayCount: p.trayCount,
    backplane: {
      sataPowerInlets: p.backplanePower.connectors.sataPower,
      molexInlets: p.backplanePower.connectors.molex,
      evidence: evidence(p.backplanePower.evidence),
    },
    fanMounts: {
      front: { size: fanSize(p.fanMounts.front.altSize), count: p.fanMounts.front.altCount, evidence: evidence(p.fanMounts.evidence) },
      rear: { size: fanSize(p.fanMounts.rear.size), count: p.fanMounts.rear.count, evidence: evidence(p.fanMounts.evidence) },
      left: { size: fanSize(p.fanMounts.left.size), count: p.fanMounts.left.count, evidence: evidence(p.fanMounts.evidence) },
      right: { size: fanSize(p.fanMounts.right.size), count: p.fanMounts.right.count, evidence: evidence(p.fanMounts.evidence) },
    },
    psuLimits: p.psuLimits,
    coolerLimits: p.coolerLimits,
    gpuLimits: p.gpuLimits,
  };
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

export function n6PowerProfile(): PowerProfile {
  const p = n6Profile.powerProfile;
  const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    boardBaseW: numberOrNull(p?.boardBaseW),
    fanBaseW: numberOrNull(p?.fanBaseW),
    fan120W: numberOrNull(p?.fan120W),
    fan140W: numberOrNull(p?.fan140W),
    dualSyncW: numberOrNull(p?.dualSyncW),
    cpuIdleW: numberOrNull(p?.cpuIdleW),
    cpuReadW: numberOrNull(p?.cpuReadW),
    cpuQuickSyncW: numberOrNull(p?.cpuQuickSyncW),
    hbaW: numberOrNull(p?.hbaW),
    driveSpinUpExtraW: numberOrNull(p?.driveSpinUpExtraW),
    evidence: p?.evidence === "official" || p?.evidence === "standard" || p?.evidence === "inferred" || p?.evidence === "unknown" ? p.evidence : p?.evidence === "planning" ? "inferred" : "unknown",
    source: typeof p?.source === "string" ? p.source : "unknown",
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

export const THERMAL_PROFILE: ThermalProfile = {
  airDensityKgM3: n6Profile.thermalProfile.airDensityKgM3,
  airCpJPerKgK: n6Profile.thermalProfile.airCpJPerKgK,
  systemDerate: n6Profile.thermalProfile.systemDerate,
  passiveCfm: n6Profile.thermalProfile.passiveCfm,
  evidence: n6Profile.thermalProfile.evidence === "official" || n6Profile.thermalProfile.evidence === "standard" || n6Profile.thermalProfile.evidence === "inferred" || n6Profile.thermalProfile.evidence === "unknown" ? n6Profile.thermalProfile.evidence : "unknown",
};
