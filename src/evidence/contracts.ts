export const EVIDENCE_SCHEMA_VERSION = "1.0.0" as const;

export type EvidenceSchemaVersion = typeof EVIDENCE_SCHEMA_VERSION;
export type Sha256Hex = string;
export type EvidenceDocumentId = `doc-sha256-${string}`;
export type EvidenceCaptureId = `capture-sha256-${string}`;
export type PlanEvidenceBindingId = `binding-sha256-${string}`;

export type EvidenceAcquisitionMethod = "official-fetch" | "bundled-import";
export type EvidenceIdentityBasis =
  | "official-document-explicit"
  | "governed-sku-user-asserted"
  | "official-domain-only"
  | "legacy-unverified";
export type EvidenceKindBasis = "content-verified" | "user-asserted" | "legacy-unverified";

export type EvidenceDocumentKind =
  | "manufacturer-manual"
  | "datasheet"
  | "support-document"
  | "official-product-page-snapshot";

export type EvidenceProductCategory =
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

/** A product identity asserted by one capture workflow, never by the blob itself. */
export interface EvidenceProductIdentity {
  readonly brand: string;
  /** Why this capture may be associated with this product. */
  readonly basis: EvidenceIdentityBasis;
  readonly model?: string;
  readonly mpn?: string;
  readonly category?: EvidenceProductCategory;
  readonly skuId?: string;
}

/**
 * Immutable content-addressed bytes. Descriptive/product metadata deliberately
 * lives on EvidenceCapture so a first writer cannot poison a global hash id.
 */
export interface EvidenceDocument {
  readonly schemaVersion: EvidenceSchemaVersion;
  readonly id: EvidenceDocumentId;
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly createdAt: string;
}

/** One retrieval of an immutable document from an official source URL. */
export interface EvidenceCapture {
  readonly schemaVersion: EvidenceSchemaVersion;
  readonly id: EvidenceCaptureId;
  readonly documentId: EvidenceDocumentId;
  readonly acquisitionMethod: EvidenceAcquisitionMethod;
  readonly kind: EvidenceDocumentKind;
  /** `user-asserted` kinds are labels, not extracted facts from the bytes. */
  readonly kindBasis: EvidenceKindBasis;
  readonly title: string;
  readonly productIdentities: readonly EvidenceProductIdentity[];
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly canonicalUrl: string;
  readonly retrievedAt: string;
  readonly status: number;
  readonly redirects: readonly string[];
  readonly etag?: string;
  readonly lastModified?: string;
  readonly officialBrand: string;
}

export type PlanEvidenceSubject =
  | { readonly kind: "plan"; readonly id: string }
  | { readonly kind: "sku"; readonly id: string; readonly category?: EvidenceProductCategory }
  | { readonly kind: "case-profile"; readonly id: string }
  | { readonly kind: "component"; readonly id: string; readonly category?: EvidenceProductCategory };

export type PlanEvidencePurpose =
  | "identity"
  | "compatibility"
  | "geometry"
  | "power"
  | "wiring"
  | "thermal"
  | "assembly";

/** A bounded citation into a document. At least one locator field is expected. */
export interface PlanEvidenceLocator {
  readonly page?: number | readonly number[];
  readonly printedPage?: string | readonly string[];
  readonly section?: string;
  readonly field?: string;
  readonly locator?: string;
  readonly snippet?: string;
}

/**
 * A many-to-many plan/document edge. Bindings pin both document id and hash so
 * a saved plan version remains auditable even after newer manual revisions are
 * captured.
 */
export interface PlanEvidenceBinding {
  readonly schemaVersion: EvidenceSchemaVersion;
  readonly id: PlanEvidenceBindingId;
  readonly planId: string;
  readonly planVersionId?: string | null;
  readonly documentId: EvidenceDocumentId;
  readonly contentHash: Sha256Hex;
  readonly captureId?: EvidenceCaptureId;
  readonly subject: PlanEvidenceSubject;
  readonly purposes: readonly PlanEvidencePurpose[];
  readonly locators?: readonly PlanEvidenceLocator[];
  readonly boundAt: string;
  readonly note?: string;
}
