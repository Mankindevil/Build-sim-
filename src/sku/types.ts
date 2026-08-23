import type { EvidenceLevel } from "../core/evidence";
import type { SkuPriceSnapshotMeta } from "../price/types";

export type SkuCategory =
  | "case"
  | "motherboard"
  | "cpu"
  | "psu"
  | "cooler"
  | "gpu"
  | "memory"
  | "storage"
  | "hba"
  | "fan"
  | "accessory";

export type PurchaseBucket = "owned" | "buy_now" | "upgrade_later" | "optional";

export interface PriceEvidence {
  currency: "CNY" | "USD";
  /** Official suggested / MSRP when published; else omit. */
  msrp?: number | null;
  /** Currently visible retail quote when audited. */
  current?: number | null;
  /** Trustworthy historical low only when evidenced. */
  historicalLow?: number | null;
  /** User paid / transaction price. */
  paid?: number | null;
  /** Evidence date YYYY-MM-DD */
  asOf?: string;
  /** Product page or listing URL the user (or audit) recorded. */
  listingUrl?: string;
  note?: string;
  /** Missing fields must remain unknown — never fabricate. */
  historicalLowEvidence: EvidenceLevel;
  currentEvidence: EvidenceLevel;
  /** Present when `current` came from data/prices snapshot merge. */
  snapshot?: SkuPriceSnapshotMeta;
}

export interface DimMm {
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  thicknessMm?: number;
  slots?: number;
  evidence: EvidenceLevel;
  note?: string;
}

export interface PowerSpec {
  tdpW?: number;
  tgpW?: number;
  idleW?: number;
  /** Vendor-published worst-case operating draw (drives, HBAs). */
  maxOperatingW?: number;
  ratedW?: number;
  evidence: EvidenceLevel;
  note?: string;
}

/**
 * Cable inventory. Leads and connectors are tracked separately because vendor
 * spec tables usually publish connector totals only, while the N6 backplane rule
 * ("one lead per inlet") is about physically separate cables.
 */
export interface HarnessSpec {
  modularCables?: number;
  /** Physically separate SATA-power cables; `null` when the vendor publishes connector totals only. */
  sataLeads?: number | null;
  /** Physically separate 4-pin peripheral (Molex/PATA) cables. */
  molexLeads?: number | null;
  sataConnectors?: number;
  molexConnectors?: number;
  pciePower?: string[];
  evidence: EvidenceLevel;
  /** Weaker than `evidence` when only connector totals are published. */
  leadEvidence?: EvidenceLevel;
  sourceUrl?: string;
  /** Repo-relative screenshot corroborating the vendor cable table. */
  crossCheck?: string;
  note?: string;
}

export interface AppearanceRef {
  image?: string;
  page?: string;
  note?: string;
}

/**
 * One labelled group of modular sockets on a PSU's cable panel. Counting sockets
 * per group — not just a total — is what makes "can this feed four inlets, one
 * lead each" answerable, since only the peripheral group can serve a backplane.
 */
export interface ModularPanelGroup {
  id: "mb" | "cpu-pcie" | "peripheral" | "sense";
  /** As silkscreened on the panel. */
  label: string;
  pins: number | string;
  sockets: number;
}

export interface ModularPanelSpec {
  groups: ModularPanelGroup[];
  /** `null` when only some groups have been counted. */
  total?: number | null;
  evidence: EvidenceLevel;
  source: string;
  sourceUrl?: string;
  /** Repo-relative panel photo or artwork the count came from. */
  image?: string;
}

export interface SkuRecord {
  id: string;
  category: SkuCategory;
  brand: string;
  model: string;
  /** Marketing / display name */
  name: string;
  /** Exact manufacturer SKU / MPN when known */
  mpn?: string;
  dims: DimMm;
  power: PowerSpec;
  harness?: HarnessSpec;
  modularPanel?: ModularPanelSpec;
  interfaceNotes?: string[];
  warrantyMonths?: number | null;
  price: PriceEvidence;
  tags?: string[];
  /** Official product appearance (not CAD). Missing => unknown in UI. */
  appearance?: AppearanceRef;
  /** Field-level sources from official/catalog inspection; absent on legacy rows. */
  provenance?: import("../catalog-search/types").FieldProvenance[];
  /** Category-specific payload */
  attrs?: Record<string, unknown>;
}

export interface SkuCatalog {
  schemaVersion: string;
  catalogVersion?: string;
  updatedAt: string;
  skus: SkuRecord[];
}
