import type { EvidenceLevel } from "../core/evidence";

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
  ratedW?: number;
  evidence: EvidenceLevel;
  note?: string;
}

export interface HarnessSpec {
  modularCables?: number;
  sataCount?: number;
  molexCount?: number;
  pciePower?: string[];
  evidence: EvidenceLevel;
  note?: string;
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
  interfaceNotes?: string[];
  warrantyMonths?: number | null;
  price: PriceEvidence;
  tags?: string[];
  /** Category-specific payload */
  attrs?: Record<string, unknown>;
}

export interface SkuCatalog {
  schemaVersion: string;
  updatedAt: string;
  skus: SkuRecord[];
}
