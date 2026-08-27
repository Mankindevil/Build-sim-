import type { EvidenceLevel } from "../core/evidence";
import type { PriceProvenance, SkuPriceSnapshotMeta } from "../price/types";

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
  /** A listing headline/`from` value is visible context, never part of totals. */
  from?: {
    amount: number | null;
    currency: string | null;
    listingUrl?: string;
    fetchedAt?: string;
    evidence: "unknown";
    note?: string;
  };
  provenance?: PriceProvenance;
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
  /**
   * Physically distinct peripheral cables in the box. This is the count that
   * can be compared with a one-cable-per-inlet rule. It is not necessarily
   * `sataLeads + molexLeads`: a mixed cable can carry both connector types.
   */
  peripheralLeads?: number | null;
  /** Mixed SATA+Molex cables already included in both typed lead counts. */
  mixedPeripheralLeads?: number;
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

/**
 * The immutable product-only portion of the catalog.  A seed may describe
 * stable identity and product facts, but never a user's transaction,
 * ownership, or purchase state.
 */
export interface ProductCatalogSeed extends SkuCatalog {
  readonly seedKind: "product_catalog_seed";
  readonly seedVersion: string;
}

/** Runtime product overlay. It is persisted separately and merged with the
 * bundled seed by the catalog repository; it is not a user inventory store. */
export interface ProductCatalogOverlay {
  readonly schemaVersion: string;
  readonly overlayKind: "product_catalog_overlay";
  readonly overlayVersion: string;
  readonly baseCatalogVersion: string;
  readonly baseUpdatedAt: string;
  readonly updatedAt: string;
  readonly skus: SkuRecord[];
  readonly acceptedSkuIds: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function userFieldIssues(sku: Record<string, unknown>, prefix: string): string[] {
  const issues: string[] = [];
  const price = isObject(sku.price) ? sku.price : undefined;
  if (price?.paid !== undefined) issues.push(`${prefix}.price.paid is user data and must be plan-scoped`);
  if (typeof price?.note === "string" && /(?:\buser\b|用户|成交|实付|\bpaid\b|\bowned\b|\btransaction\b|\border(?:\s*(?:id|no\.?|number)|#)|\breceipt\b|订单|收货|截图)/iu.test(price.note)) {
    issues.push(`${prefix}.price.note contains user/order provenance and must be plan-scoped`);
  }
  const tags = sku.tags;
  if (Array.isArray(tags) && tags.some((tag) => typeof tag === "string" && /^(?:owned|paid|user|purchase|transaction)(?:$|[-_])/iu.test(tag))) {
    issues.push(`${prefix}.tags contains a user ownership/purchase label`);
  }
  if (Object.keys(sku).some((key) => /^(?:owned|purchase|transaction|userInventory|userNotes?)$/iu.test(key))) {
    issues.push(`${prefix} contains a user-owned field`);
  }
  return issues;
}

/** Structural + isolation validation for a product seed. */
export function validateProductCatalogSeed(value: unknown): string[] {
  if (!isObject(value)) return ["product catalog seed must be an object"];
  const seed = value;
  const issues: string[] = [];
  if (typeof seed.schemaVersion !== "string" || !seed.schemaVersion) issues.push("product catalog seed schemaVersion is required");
  if (seed.seedKind !== "product_catalog_seed") issues.push("product catalog seed seedKind is invalid");
  if (typeof seed.seedVersion !== "string" || !seed.seedVersion) issues.push("product catalog seed seedVersion is required");
  if (typeof seed.updatedAt !== "string" || !Number.isFinite(Date.parse(seed.updatedAt))) issues.push("product catalog seed updatedAt is invalid");
  if (!Array.isArray(seed.skus)) return [...issues, "product catalog seed skus must be an array"];
  const ids = new Set<string>();
  for (const [index, valueSku] of seed.skus.entries()) {
    if (!isObject(valueSku) || typeof valueSku.id !== "string" || !valueSku.id) {
      issues.push(`product catalog seed sku ${index} identity is invalid`);
      continue;
    }
    if (ids.has(valueSku.id)) issues.push(`product catalog seed contains duplicate SKU id: ${valueSku.id}`);
    ids.add(valueSku.id);
    issues.push(...userFieldIssues(valueSku, `product catalog seed sku ${valueSku.id}`));
  }
  return issues;
}

/** Structural + isolation validation for a runtime product overlay. */
export function validateProductCatalogOverlay(value: unknown): string[] {
  if (!isObject(value)) return ["product catalog overlay must be an object"];
  const overlay = value;
  const issues: string[] = [];
  if (typeof overlay.schemaVersion !== "string" || !overlay.schemaVersion) issues.push("product catalog overlay schemaVersion is required");
  if (overlay.overlayKind !== "product_catalog_overlay") issues.push("product catalog overlay overlayKind is invalid");
  for (const field of ["overlayVersion", "baseCatalogVersion", "baseUpdatedAt", "updatedAt"] as const) {
    if (typeof overlay[field] !== "string" || !overlay[field]) issues.push(`product catalog overlay ${field} is required`);
  }
  if (typeof overlay.baseUpdatedAt === "string" && !Number.isFinite(Date.parse(overlay.baseUpdatedAt))) issues.push("product catalog overlay baseUpdatedAt is invalid");
  if (typeof overlay.updatedAt === "string" && !Number.isFinite(Date.parse(overlay.updatedAt))) issues.push("product catalog overlay updatedAt is invalid");
  if (!Array.isArray(overlay.skus)) issues.push("product catalog overlay skus must be an array");
  if (!Array.isArray(overlay.acceptedSkuIds) || overlay.acceptedSkuIds.some((id) => typeof id !== "string" || !id)) issues.push("product catalog overlay acceptedSkuIds must be a string array");
  const skus = Array.isArray(overlay.skus) ? overlay.skus : [];
  const ids = new Set<string>();
  for (const [index, valueSku] of skus.entries()) {
    if (!isObject(valueSku) || typeof valueSku.id !== "string" || !valueSku.id) {
      issues.push(`product catalog overlay sku ${index} identity is invalid`);
      continue;
    }
    if (ids.has(valueSku.id)) issues.push(`product catalog overlay contains duplicate SKU id: ${valueSku.id}`);
    ids.add(valueSku.id);
    issues.push(...userFieldIssues(valueSku, `product catalog overlay sku ${valueSku.id}`));
  }
  if (Array.isArray(overlay.acceptedSkuIds)) {
    if (new Set(overlay.acceptedSkuIds).size !== overlay.acceptedSkuIds.length) issues.push("product catalog overlay acceptedSkuIds contains duplicates");
    for (const id of overlay.acceptedSkuIds) if (!ids.has(id)) issues.push(`product catalog overlay accepted SKU is missing: ${id}`);
  }
  return issues;
}

export function isProductCatalogSeed(value: unknown): value is ProductCatalogSeed {
  return validateProductCatalogSeed(value).length === 0;
}

export function isProductCatalogOverlay(value: unknown): value is ProductCatalogOverlay {
  return validateProductCatalogOverlay(value).length === 0;
}

export function assertProductCatalogSeed(value: unknown): asserts value is ProductCatalogSeed {
  const issues = validateProductCatalogSeed(value);
  if (issues.length) throw new TypeError(issues.join("; "));
}

export function assertProductCatalogOverlay(value: unknown): asserts value is ProductCatalogOverlay {
  const issues = validateProductCatalogOverlay(value);
  if (issues.length) throw new TypeError(issues.join("; "));
}
