import { createHash } from "node:crypto";
import {
  contentHashRuntime,
  finiteCanonicalJsonRuntime,
  isCanonicalUnicodeRuntime,
  isIsoTimestampRuntime,
  isSha256HexRuntime,
  runtimeRecord,
} from "../facts/canonical-runtime.mjs";

const DOCUMENT_ID = /^doc-sha256-([a-f0-9]{64})$/;
const CAPTURE_ID = /^capture-sha256-[a-f0-9]{64}$/;
const CLAIM_ID = /^claim-sha256-[a-f0-9]{64}$/;
const EVIDENCE_SCHEMA_VERSION = "1.0.0";
const DOCUMENT_KINDS = new Set(["manufacturer-manual", "datasheet", "support-document", "official-product-page-snapshot"]);
const PRODUCT_CATEGORIES = new Set(["case", "motherboard", "cpu", "psu", "cooler", "gpu", "memory", "storage", "hba", "fan", "accessory"]);
const IDENTITY_BASES = new Set(["official-document-explicit", "third-party-document-explicit", "governed-sku-user-asserted", "official-domain-only", "legacy-unverified"]);
const KIND_BASES = new Set(["content-verified", "user-asserted", "legacy-unverified"]);
const ACQUISITION_METHODS = new Set(["official-fetch", "third-party-fetch", "bundled-import"]);
const EVIDENCE_IDENTITY_KEYS = ["brand", "basis", "model", "mpn", "category", "skuId", "familyId", "modelId", "variantId", "revision", "region"];
const EVIDENCE_CAPTURE_KEYS = ["schemaVersion", "id", "documentId", "acquisitionMethod", "kind", "kindBasis", "title", "productIdentities", "requestedUrl", "finalUrl", "canonicalUrl", "retrievedAt", "status", "redirects", "etag", "lastModified", "officialBrand"];

function total(operation, fallback) { try { return operation(); } catch { return fallback; } }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function exact(value, allowed, required = allowed) {
  return runtimeRecord(value) && Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => own(value, key));
}

/**
 * Exact canonicalization used by FileEvidenceRepository for its mutable
 * metadata envelopes and capture IDs.  This deliberately differs from the
 * U3 domain-hash canonicalizer: persisted evidence metadata predates it.
 */
function evidenceRepositoryCanonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("evidence number is not finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) throw new TypeError("evidence value is not JSON");
  if (ancestors.has(value)) throw new TypeError("evidence value is cyclic");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new TypeError("evidence array is sparse");
      return `[${value.map((item) => evidenceRepositoryCanonicalJson(item, ancestors)).join(",")}]`;
    }
    if (!runtimeRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("evidence object is invalid");
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${evidenceRepositoryCanonicalJson(child, ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}

export function evidenceRepositoryCanonicalJsonRuntime(value) {
  return total(() => evidenceRepositoryCanonicalJson(value), null);
}

/** SHA-256 record checksum and capture-ID preimage used by FileEvidenceRepository. */
export function evidenceRepositoryChecksumRuntime(value) {
  return total(() => {
    const canonical = evidenceRepositoryCanonicalJson(value);
    return createHash("sha256").update(canonical, "utf8").digest("hex");
  }, null);
}

function evidenceSafeText(value, maxLength) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function evidenceIso(value) {
  return total(() => {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
    return new Date(value).toISOString();
  }, null);
}

function normalizedEvidenceMediaType(value) {
  return total(() => {
    if (typeof value !== "string") return null;
    const normalized = value.split(";", 1)[0].trim().toLocaleLowerCase();
    return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized) ? normalized : null;
  }, null);
}

function normalizedEvidenceUrl(value) {
  return total(() => {
    if (typeof value !== "string") return null;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.toString().length > 4_096) return null;
    url.hash = "";
    if (url.port === "443") url.port = "";
    return url.toString();
  }, null);
}

function normalizedEvidenceIdentity(value) {
  return total(() => {
    if (!exact(value, EVIDENCE_IDENTITY_KEYS, ["brand", "basis"])) return null;
    const brand = evidenceSafeText(value.brand, 120);
    const basis = typeof value.basis === "string" && IDENTITY_BASES.has(value.basis) ? value.basis : null;
    if (!brand || !basis) return null;
    const model = own(value, "model") ? evidenceSafeText(value.model, 240) : undefined;
    const mpn = own(value, "mpn") ? evidenceSafeText(value.mpn, 160) : undefined;
    const skuId = own(value, "skuId") ? evidenceSafeText(value.skuId, 160) : undefined;
    const familyId = own(value, "familyId") ? evidenceSafeText(value.familyId, 256) : undefined;
    const modelId = own(value, "modelId") ? evidenceSafeText(value.modelId, 256) : undefined;
    const variantId = own(value, "variantId") ? evidenceSafeText(value.variantId, 256) : undefined;
    const revision = own(value, "revision") ? evidenceSafeText(value.revision, 256) : undefined;
    const region = own(value, "region") ? evidenceSafeText(value.region, 256) : undefined;
    const category = own(value, "category") && typeof value.category === "string" && PRODUCT_CATEGORIES.has(value.category) ? value.category : undefined;
    if ((own(value, "model") && !model) || (own(value, "mpn") && !mpn) || (own(value, "skuId") && !skuId)
      || (own(value, "familyId") && !familyId) || (own(value, "modelId") && !modelId) || (own(value, "variantId") && !variantId)
      || (own(value, "revision") && !revision) || (own(value, "region") && !region) || (own(value, "category") && !category)) return null;
    const normalized = {
      brand, basis, ...(model ? { model } : {}), ...(mpn ? { mpn } : {}), ...(category ? { category } : {}), ...(skuId ? { skuId } : {}),
      ...(familyId ? { familyId } : {}), ...(modelId ? { modelId } : {}), ...(variantId ? { variantId } : {}), ...(revision ? { revision } : {}), ...(region ? { region } : {}),
    };
    return evidenceRepositoryCanonicalJson(value) === evidenceRepositoryCanonicalJson(normalized) ? normalized : null;
  }, null);
}

function normalizedEvidenceIdentities(value) {
  return total(() => {
    if (!Array.isArray(value) || value.length > 64) return null;
    const byCanonical = new Map();
    for (const identity of value) {
      const normalized = normalizedEvidenceIdentity(identity);
      if (!normalized) return null;
      byCanonical.set(evidenceRepositoryCanonicalJson(normalized), normalized);
    }
    const normalized = [...byCanonical.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, identity]) => identity);
    return evidenceRepositoryCanonicalJson(value) === evidenceRepositoryCanonicalJson(normalized) ? normalized : null;
  }, null);
}

/** Total validator for FileEvidenceRepository's persisted metadata envelope. */
export function validateEvidenceRepositoryEnvelopeRuntime(value, expectedKind) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "kind", "checksum", "payload"])) return ["evidence repository envelope fields invalid"];
    if (value.schemaVersion !== EVIDENCE_SCHEMA_VERSION || value.kind !== expectedKind) return ["evidence repository envelope identity invalid"];
    const checksum = evidenceRepositoryChecksumRuntime(value.payload);
    return isSha256HexRuntime(value.checksum) && checksum !== null && value.checksum === checksum
      ? [] : ["evidence repository envelope checksum invalid"];
  }, ["evidence repository envelope runtime validation failed"]);
}

/** Strict, write-side-compatible validator for immutable evidence documents. */
export function validateEvidenceDocumentRuntime(value) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "id", "sha256", "byteLength", "mediaType", "createdAt"])) return ["evidence document fields invalid"];
    const errors = [];
    const match = typeof value.id === "string" ? DOCUMENT_ID.exec(value.id) : null;
    if (value.schemaVersion !== EVIDENCE_SCHEMA_VERSION || !match || value.sha256 !== match[1] || !isSha256HexRuntime(value.sha256)) errors.push("evidence document identity invalid");
    if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0) errors.push("evidence document byteLength invalid");
    const mediaType = normalizedEvidenceMediaType(value.mediaType);
    if (!mediaType || value.mediaType !== mediaType) errors.push("evidence document mediaType invalid");
    const createdAt = evidenceIso(value.createdAt);
    if (!createdAt || value.createdAt !== createdAt) errors.push("evidence document createdAt invalid");
    return errors;
  }, ["evidence document runtime validation failed"]);
}

/** Strict, write-side-compatible validator for immutable evidence captures. */
export function validateEvidenceCaptureRuntime(value) {
  return total(() => {
    const required = EVIDENCE_CAPTURE_KEYS.filter((key) => key !== "etag" && key !== "lastModified");
    if (!exact(value, EVIDENCE_CAPTURE_KEYS, required)) return ["evidence capture fields invalid"];
    const errors = [];
    if (value.schemaVersion !== EVIDENCE_SCHEMA_VERSION || typeof value.id !== "string" || !CAPTURE_ID.test(value.id)) errors.push("evidence capture identity invalid");
    if (typeof value.documentId !== "string" || !DOCUMENT_ID.test(value.documentId)) errors.push("evidence capture document identity invalid");
    if (!ACQUISITION_METHODS.has(value.acquisitionMethod)) errors.push("evidence capture acquisitionMethod invalid");
    if (!DOCUMENT_KINDS.has(value.kind)) errors.push("evidence capture kind invalid");
    if (!KIND_BASES.has(value.kindBasis)) errors.push("evidence capture kindBasis invalid");
    if (!evidenceSafeText(value.title, 500)) errors.push("evidence capture title invalid");
    if (!normalizedEvidenceIdentities(value.productIdentities)) errors.push("evidence capture product identities invalid");
    for (const field of ["requestedUrl", "finalUrl", "canonicalUrl"]) {
      const normalized = normalizedEvidenceUrl(value[field]);
      if (!normalized || value[field] !== normalized) errors.push(`evidence capture ${field} invalid`);
    }
    const retrievedAt = evidenceIso(value.retrievedAt);
    if (!retrievedAt || value.retrievedAt !== retrievedAt) errors.push("evidence capture retrievedAt invalid");
    if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599) errors.push("evidence capture status invalid");
    if (!Array.isArray(value.redirects) || value.redirects.length > 16 || value.redirects.some((url) => normalizedEvidenceUrl(url) !== url)) errors.push("evidence capture redirects invalid");
    for (const field of ["etag", "lastModified"]) if (own(value, field) && !evidenceSafeText(value[field], 512)) errors.push(`evidence capture ${field} invalid`);
    if (!evidenceSafeText(value.officialBrand, 120)) errors.push("evidence capture officialBrand invalid");
    const material = { ...value }; delete material.id;
    const captureHash = evidenceRepositoryChecksumRuntime(material);
    if (!captureHash || value.id !== `capture-sha256-${captureHash}`) errors.push("evidence capture hash binding invalid");
    return errors;
  }, ["evidence capture runtime validation failed"]);
}

/** Total validator for the normalized URL-to-capture index persisted by FileEvidenceRepository. */
export function validateEvidenceUrlIndexRuntime(value) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "url", "captureId", "documentId", "retrievedAt"])) return ["evidence URL index fields invalid"];
    const errors = [];
    if (value.schemaVersion !== EVIDENCE_SCHEMA_VERSION) errors.push("evidence URL index schema invalid");
    const url = normalizedEvidenceUrl(value.url);
    if (!url || value.url !== url) errors.push("evidence URL index URL invalid");
    if (typeof value.captureId !== "string" || !CAPTURE_ID.test(value.captureId)) errors.push("evidence URL index capture identity invalid");
    if (typeof value.documentId !== "string" || !DOCUMENT_ID.test(value.documentId)) errors.push("evidence URL index document identity invalid");
    const retrievedAt = evidenceIso(value.retrievedAt);
    if (!retrievedAt || value.retrievedAt !== retrievedAt) errors.push("evidence URL index retrievedAt invalid");
    return errors;
  }, ["evidence URL index runtime validation failed"]);
}

/**
 * A capture can support only the governed product identity it explicitly
 * asserted. Optional narrower subject keys are never inferred from a sibling
 * SKU, model, revision, or region.
 */
export function evidenceIdentityMatchesClaimSubjectRuntime(identity, subject, scope) {
  return total(() => {
    if (!runtimeRecord(identity) || !runtimeRecord(subject)
      || identity.skuId !== subject.skuId || identity.familyId !== subject.familyId) return false;
    for (const field of ["modelId", "variantId", "revision", "region"]) {
      if (subject[field] !== undefined && identity[field] !== subject[field]) return false;
    }
    if (scope === "model") return subject.modelId !== undefined && identity.modelId === subject.modelId;
    if (scope === "variant") return subject.modelId !== undefined && subject.variantId !== undefined
      && identity.modelId === subject.modelId && identity.variantId === subject.variantId;
    if (scope === "revision") return subject.modelId !== undefined && subject.variantId !== undefined && subject.revision !== undefined
      && identity.modelId === subject.modelId && identity.variantId === subject.variantId && identity.revision === subject.revision;
    return scope === "family";
  }, false);
}

/** Total JavaScript projection of validateEvidenceClaimLocator(). */
export function validateEvidenceClaimLocatorRuntime(value) {
  return total(() => {
    if (!exact(value, ["page", "printedPage", "section", "field", "locator", "snippet"], [])) return ["claim locator contains unknown fields"];
    const errors = [];
    if (Object.keys(value).length === 0) errors.push("claim locator must identify evidence content");
    if (value.page !== undefined && (!Number.isSafeInteger(value.page) || value.page < 1)) errors.push("claim locator page invalid");
    for (const field of ["printedPage", "section", "field", "locator"]) if (value[field] !== undefined && !isCanonicalUnicodeRuntime(value[field], 512)) errors.push(`claim locator ${field} invalid`);
    if (value.snippet !== undefined && !isCanonicalUnicodeRuntime(value.snippet, 1000)) errors.push("claim locator snippet invalid");
    return errors;
  }, ["claim locator runtime validation failed"]);
}

/** Total JavaScript projection of the immutable EvidenceClaim write contract. */
export function validateEvidenceClaimRuntime(value) {
  return total(() => {
    const allowed = ["schemaVersion", "claimId", "subject", "scope", "fieldId", "value", "unit", "authority", "source", "retrievedAt", "validFrom", "validUntil", "status", "supersedesClaimId", "supersededClaimHash", "contentHash"];
    const required = ["schemaVersion", "claimId", "subject", "scope", "fieldId", "value", "authority", "source", "retrievedAt", "status", "contentHash"];
    if (!exact(value, allowed, required)) return ["evidence claim fields invalid"];
    const errors = [];
    if (value.schemaVersion !== "evidence-claim-v1") errors.push("evidence claim schemaVersion invalid");
    if (!isSha256HexRuntime(value.contentHash)) errors.push("evidence claim contentHash invalid");
    if (typeof value.claimId !== "string" || !CLAIM_ID.test(value.claimId) || value.claimId !== `claim-sha256-${value.contentHash}`) errors.push("evidence claim ID/content hash mismatch");
    if (!isCanonicalUnicodeRuntime(value.fieldId, 256)) errors.push("evidence claim fieldId invalid");
    if (!finiteCanonicalJsonRuntime(value.value)) errors.push("evidence claim value is not finite canonical JSON");
    if (value.unit !== undefined && !isCanonicalUnicodeRuntime(value.unit, 64)) errors.push("evidence claim unit invalid");
    if (!exact(value.subject, ["skuId", "familyId", "modelId", "variantId", "revision", "region"], ["skuId", "familyId"])) {
      errors.push("evidence claim subject invalid");
    } else {
      for (const field of ["skuId", "familyId", "modelId", "variantId", "revision", "region"]) if (value.subject[field] !== undefined && !isCanonicalUnicodeRuntime(value.subject[field], 256)) errors.push(`evidence claim subject ${field} invalid`);
      if (value.scope === "model" && value.subject.modelId === undefined) errors.push("model claim requires model identity");
      if (value.scope === "variant" && (value.subject.modelId === undefined || value.subject.variantId === undefined)) errors.push("variant claim requires model and variant identity");
      if (value.scope === "revision" && (value.subject.modelId === undefined || value.subject.variantId === undefined || value.subject.revision === undefined)) errors.push("revision claim requires exact model, variant and revision identity");
    }
    if (!["family", "model", "variant", "revision"].includes(String(value.scope))) errors.push("evidence claim scope invalid");
    if (value.authority !== "official" && value.authority !== "third_party") errors.push("evidence claim authority invalid");
    if (!exact(value.source, ["documentId", "documentSha256", "captureId", "locator"])) {
      errors.push("evidence claim source invalid");
    } else {
      if (typeof value.source.documentId !== "string" || !DOCUMENT_ID.test(value.source.documentId)) errors.push("evidence claim documentId invalid");
      if (typeof value.source.documentSha256 !== "string" || !isSha256HexRuntime(value.source.documentSha256) || value.source.documentId !== `doc-sha256-${value.source.documentSha256}`) errors.push("evidence claim document hash mismatch");
      if (typeof value.source.captureId !== "string" || !CAPTURE_ID.test(value.source.captureId)) errors.push("evidence claim captureId invalid");
      errors.push(...validateEvidenceClaimLocatorRuntime(value.source.locator));
    }
    if (!isIsoTimestampRuntime(value.retrievedAt)) errors.push("evidence claim retrievedAt invalid");
    if (value.validFrom !== undefined && !isIsoTimestampRuntime(value.validFrom)) errors.push("evidence claim validFrom invalid");
    if (value.validUntil !== undefined && !isIsoTimestampRuntime(value.validUntil)) errors.push("evidence claim validUntil invalid");
    if (isIsoTimestampRuntime(value.validFrom) && isIsoTimestampRuntime(value.validUntil) && Date.parse(value.validUntil) < Date.parse(value.validFrom)) errors.push("evidence claim validity interval invalid");
    if (value.status !== "active" && value.status !== "superseded") errors.push("evidence claim status invalid");
    const supersedesPresent = value.supersedesClaimId !== undefined || value.supersededClaimHash !== undefined;
    if (supersedesPresent) {
      if (value.status !== "active") errors.push("only an active evidence claim may supersede another claim");
      if (typeof value.supersedesClaimId !== "string" || !CLAIM_ID.test(value.supersedesClaimId) || !isSha256HexRuntime(value.supersededClaimHash) || value.supersedesClaimId !== `claim-sha256-${value.supersededClaimHash}`) errors.push("evidence claim supersession closure invalid");
      if (value.supersedesClaimId === value.claimId) errors.push("evidence claim cannot supersede itself");
    }
    return errors;
  }, ["evidence claim runtime validation failed"]);
}

export function verifyEvidenceClaimRuntime(value) {
  return total(() => validateEvidenceClaimRuntime(value).length === 0
    && value.contentHash === contentHashRuntime(value, "evidence-claim", "evidence-claim-v1", "evidenceClaim")
    && value.claimId === `claim-sha256-${value.contentHash}`, false);
}
