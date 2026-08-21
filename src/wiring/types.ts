import type { EvidenceLevel } from "../core/evidence";

export type DataPortKind = "sata" | "slimsas" | "hba" | "nvme" | "usb";

export interface BayDataPath {
  bayId: string;
  /** 1–9 for N6 trays */
  bayIndex: number;
  target: DataPortKind;
  /** Human-readable port label, e.g. MB SATA_1 or HBA P0 */
  portLabel: string;
  cableSkuId?: string;
  evidence: EvidenceLevel;
  note?: string;
}

export interface BackplanePowerFeed {
  /** N6 official: 4 backplane power inputs */
  inletIndex: 1 | 2 | 3 | 4;
  psuId: string;
  /** Which modular lead / split, when known */
  leadLabel: string;
  evidence: EvidenceLevel;
  note?: string;
}

export interface WiringChecklistItem {
  id: string;
  kind: "data" | "power" | "fan" | "sync" | "gpu" | "other";
  requiredQty: number;
  haveQty?: number;
  label: string;
  evidence: EvidenceLevel;
  purchaseHint?: string;
}

export interface WiringPlan {
  caseId: string;
  bayPaths: BayDataPath[];
  backplanePower: BackplanePowerFeed[];
  checklist: WiringChecklistItem[];
  warnings: string[];
}
