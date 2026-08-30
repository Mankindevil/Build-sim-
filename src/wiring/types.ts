import type { EvidenceLevel } from "../core/evidence";

/** `empty` is intentionally unplanned; `none` is a populated bay with a shortfall. */
export type DataPortKind = "sata" | "slimsas" | "hba" | "nvme" | "usb" | "empty" | "none";

export interface PortAssignment {
  controller: "board" | "hba" | "none";
  connector: "sata" | "slimsas" | "sff-8643" | "none";
  portIndex: number | null;
}

export interface BayDataPath {
  bayId: string;
  /** 1-based index in the active case adapter's bay set. */
  bayIndex: number;
  target: DataPortKind;
  /** Structured controller/connector mapping; labels are presentation only. */
  assignment: PortAssignment;
  /** Human-readable port label, e.g. MB SATA_1 or HBA P0 */
  portLabel: string;
  cableSkuId?: string;
  evidence: EvidenceLevel;
  note?: string;
}

export type BackplaneConnector = "sata" | "molex";

export interface BackplanePowerFeed {
  /** Adapter-declared backplane power input index. */
  inletIndex: number;
  /** Manual p.14 figure: 2× SATA power + 2× PATA/Molex */
  connector: BackplaneConnector;
  psuId: string;
  /** Which modular lead / split, when known */
  leadLabel: string;
  evidence: EvidenceLevel;
  note?: string;
}

/**
 * Worst-case simultaneous spin-up on the 12V rail. This is what turns the
 * manual's one-lead-per-inlet wording into a number: a lead forced to serve two
 * inlets carries double the surge.
 */
export interface BackplaneSpinUpLoad {
  diskCount: number;
  /** Vendor typical 12V startup peak per drive. */
  perDiskA: number | null;
  /** All drives spinning up at once. */
  totalA: number | null;
  /** Even split across the inlets. */
  perInletA: number | null;
  /** What one lead carries when it has to feed two inlets. */
  perSharedLeadA: number | null;
  /** Published per-peripheral-lead ceiling, when the PSU vendor states one. */
  leadLimitW: number | null;
  evidence: EvidenceLevel;
  notes: string[];
}

/**
 * Standalone audit of the backplane harness. Kept separate from the data-path
 * checklist because the case requirement is official while PSU lead inventory
 * is per-SKU and usually unknown until the box is in hand.
 */
export interface BackplaneHarnessCheck {
  /** PSU that must feed all four inlets on its own. */
  feedPsuId: string;
  feedRole: "main" | "backplane-dedicated";
  inlets: number;
  required: Record<BackplaneConnector, number>;
  /** `null` when the SKU has no confirmed lead count for that connector. */
  confirmed: Record<BackplaneConnector, number | null>;
  /** Connector totals, which vendors publish far more often than cable counts. */
  connectors: Record<BackplaneConnector, number | null>;
  /** Physically distinct peripheral cables; mixed SATA+Molex leads count once. */
  uniquePeripheralLeads: number | null;
  /** False when a single lead would have to be daisy-chained across inlets. */
  oneLeadPerInlet: boolean;
  /** True when there are enough connectors but too few cables to avoid a chain. */
  daisyChainOnly: boolean;
  /** SATA/PATA modular sockets on the feeding PSU — the hard ceiling on lead count. */
  peripheralSockets: number | null;
  /** True when the socket count alone makes one lead per inlet impossible. */
  socketLimited: boolean;
  spinUp: BackplaneSpinUpLoad;
  verdict: "ok" | "warn" | "bad" | "unknown";
  evidence: EvidenceLevel;
  notes: string[];
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
  backplaneHarness: BackplaneHarnessCheck;
  checklist: WiringChecklistItem[];
  warnings: string[];
}
