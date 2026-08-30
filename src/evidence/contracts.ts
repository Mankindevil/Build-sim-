export const EVIDENCE_SCHEMA_VERSION = "1.0.0" as const;

export type EvidenceSchemaVersion = typeof EVIDENCE_SCHEMA_VERSION;
export type Sha256Hex = string;
export type EvidenceDocumentId = `doc-sha256-${string}`;
export type EvidenceCaptureId = `capture-sha256-${string}`;
export type PlanEvidenceBindingId = `binding-sha256-${string}`;

export type EvidenceAcquisitionMethod = "official-fetch" | "third-party-fetch" | "bundled-import";
export type EvidenceIdentityBasis =
  | "official-document-explicit"
  | "third-party-document-explicit"
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
  /** Governed identity keys asserted by this exact capture workflow. */
  readonly familyId?: string;
  readonly modelId?: string;
  readonly variantId?: string;
  readonly revision?: string;
  readonly region?: string;
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

export const EVIDENCE_CLAIM_SCHEMA_VERSION = "evidence-claim-v1" as const;
export type EvidenceClaimId = `claim-sha256-${string}`;
export type EvidenceClaimScope = "family" | "model" | "variant" | "revision";

/** Exact product identity to which one extracted claim applies. */
export interface EvidenceClaimSubject {
  readonly skuId: string;
  readonly familyId: string;
  readonly modelId?: string;
  readonly variantId?: string;
  readonly revision?: string;
  readonly region?: string;
}

/** A bounded locator into immutable evidence bytes; at least one locator is required. */
export interface EvidenceClaimLocator {
  readonly page?: number;
  readonly printedPage?: string;
  readonly section?: string;
  readonly field?: string;
  readonly locator?: string;
  readonly snippet?: string;
}

export interface EvidenceClaimSource {
  readonly documentId: EvidenceDocumentId;
  readonly documentSha256: Sha256Hex;
  readonly captureId: EvidenceCaptureId;
  readonly locator: EvidenceClaimLocator;
}

/**
 * One immutable source claim. It is not a resolved FactRecord and never carries
 * a caller-selected safety class. Field policy and conflict resolution happen
 * in the fact layer.
 */
export interface EvidenceClaim {
  readonly schemaVersion: typeof EVIDENCE_CLAIM_SCHEMA_VERSION;
  readonly claimId: EvidenceClaimId;
  readonly subject: EvidenceClaimSubject;
  readonly scope: EvidenceClaimScope;
  readonly fieldId: string;
  readonly value: unknown;
  readonly unit?: string;
  readonly authority: "official" | "third_party";
  readonly source: EvidenceClaimSource;
  readonly retrievedAt: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly status: "active" | "superseded";
  readonly supersedesClaimId?: EvidenceClaimId;
  readonly supersededClaimHash?: Sha256Hex;
  /** SHA-256 of the canonical claim material with `/claimId` and `/contentHash` excluded. */
  readonly contentHash: Sha256Hex;
}

const SHA256 = /^[a-f0-9]{64}$/;
const DOCUMENT_ID = /^doc-sha256-[a-f0-9]{64}$/;
const CAPTURE_ID = /^capture-sha256-[a-f0-9]{64}$/;
const CLAIM_ID = /^claim-sha256-[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

function claimObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function claimExact(value: unknown, keys: readonly string[], required: readonly string[] = keys): value is Record<string, unknown> {
  return claimObject(value)
    && Object.keys(value).every((key) => keys.includes(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function unicodeScalar(value: unknown, maxLength = 512): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value !== value.normalize("NFC")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function finiteJson(value: unknown, depth = 0): boolean {
  if (depth > 16 || value === undefined) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return unicodeScalar(value, 4096);
  if (Array.isArray(value)) return value.length <= 1024 && value.every((item) => finiteJson(item, depth + 1));
  if (!claimObject(value) || Object.keys(value).length > 256) return false;
  return Object.entries(value).every(([key, item]) => unicodeScalar(key, 256) && finiteJson(item, depth + 1));
}

export function validateEvidenceClaimLocator(value: unknown): string[] {
  if (!claimExact(value, ["page", "printedPage", "section", "field", "locator", "snippet"], [])) return ["claim locator contains unknown fields"];
  const errors: string[] = [];
  if (Object.keys(value).length === 0) errors.push("claim locator must identify evidence content");
  if (value.page !== undefined && (!Number.isSafeInteger(value.page) || (value.page as number) < 1)) errors.push("claim locator page invalid");
  for (const field of ["printedPage", "section", "field", "locator"] as const) {
    if (value[field] !== undefined && !unicodeScalar(value[field], 512)) errors.push(`claim locator ${field} invalid`);
  }
  if (value.snippet !== undefined && !unicodeScalar(value.snippet, 1000)) errors.push("claim locator snippet invalid");
  return errors;
}

export function validateEvidenceClaim(value: unknown): string[] {
  const allowed = [
    "schemaVersion", "claimId", "subject", "scope", "fieldId", "value", "unit", "authority", "source",
    "retrievedAt", "validFrom", "validUntil", "status", "supersedesClaimId", "supersededClaimHash", "contentHash",
  ];
  const required = [
    "schemaVersion", "claimId", "subject", "scope", "fieldId", "value", "authority", "source", "retrievedAt", "status", "contentHash",
  ];
  if (!claimExact(value, allowed, required)) return ["evidence claim fields invalid"];
  const errors: string[] = [];
  if (value.schemaVersion !== EVIDENCE_CLAIM_SCHEMA_VERSION) errors.push("evidence claim schemaVersion invalid");
  if (typeof value.contentHash !== "string" || !SHA256.test(value.contentHash)) errors.push("evidence claim contentHash invalid");
  if (typeof value.claimId !== "string" || !CLAIM_ID.test(value.claimId) || value.claimId !== `claim-sha256-${value.contentHash}`) errors.push("evidence claim ID/content hash mismatch");
  if (!unicodeScalar(value.fieldId, 256)) errors.push("evidence claim fieldId invalid");
  if (!finiteJson(value.value)) errors.push("evidence claim value is not finite canonical JSON");
  if (value.unit !== undefined && !unicodeScalar(value.unit, 64)) errors.push("evidence claim unit invalid");
  if (!claimExact(value.subject, ["skuId", "familyId", "modelId", "variantId", "revision", "region"], ["skuId", "familyId"])) {
    errors.push("evidence claim subject invalid");
  } else {
    for (const field of ["skuId", "familyId", "modelId", "variantId", "revision", "region"] as const) {
      if (value.subject[field] !== undefined && !unicodeScalar(value.subject[field], 256)) errors.push(`evidence claim subject ${field} invalid`);
    }
    if (value.scope === "model" && value.subject.modelId === undefined) errors.push("model claim requires model identity");
    if (value.scope === "variant" && (value.subject.modelId === undefined || value.subject.variantId === undefined)) errors.push("variant claim requires model and variant identity");
    if (value.scope === "revision" && (value.subject.modelId === undefined || value.subject.variantId === undefined || value.subject.revision === undefined)) errors.push("revision claim requires exact model, variant and revision identity");
  }
  if (!["family", "model", "variant", "revision"].includes(String(value.scope))) errors.push("evidence claim scope invalid");
  if (value.authority !== "official" && value.authority !== "third_party") errors.push("evidence claim authority invalid");
  if (!claimExact(value.source, ["documentId", "documentSha256", "captureId", "locator"])) {
    errors.push("evidence claim source invalid");
  } else {
    if (typeof value.source.documentId !== "string" || !DOCUMENT_ID.test(value.source.documentId)) errors.push("evidence claim documentId invalid");
    if (typeof value.source.documentSha256 !== "string" || !SHA256.test(value.source.documentSha256)
      || value.source.documentId !== `doc-sha256-${value.source.documentSha256}`) errors.push("evidence claim document hash mismatch");
    if (typeof value.source.captureId !== "string" || !CAPTURE_ID.test(value.source.captureId)) errors.push("evidence claim captureId invalid");
    errors.push(...validateEvidenceClaimLocator(value.source.locator));
  }
  if (!isoTimestamp(value.retrievedAt)) errors.push("evidence claim retrievedAt invalid");
  if (value.validFrom !== undefined && !isoTimestamp(value.validFrom)) errors.push("evidence claim validFrom invalid");
  if (value.validUntil !== undefined && !isoTimestamp(value.validUntil)) errors.push("evidence claim validUntil invalid");
  if (isoTimestamp(value.validFrom) && isoTimestamp(value.validUntil) && Date.parse(value.validUntil) < Date.parse(value.validFrom)) errors.push("evidence claim validity interval invalid");
  if (value.status !== "active" && value.status !== "superseded") errors.push("evidence claim status invalid");
  const supersedesPresent = value.supersedesClaimId !== undefined || value.supersededClaimHash !== undefined;
  if (supersedesPresent) {
    if (value.status !== "active") errors.push("only an active evidence claim may supersede another claim");
    if (typeof value.supersedesClaimId !== "string" || !CLAIM_ID.test(value.supersedesClaimId)
      || typeof value.supersededClaimHash !== "string" || !SHA256.test(value.supersededClaimHash)
      || value.supersedesClaimId !== `claim-sha256-${value.supersededClaimHash}`) errors.push("evidence claim supersession closure invalid");
    if (value.supersedesClaimId === value.claimId) errors.push("evidence claim cannot supersede itself");
  }
  return errors;
}
