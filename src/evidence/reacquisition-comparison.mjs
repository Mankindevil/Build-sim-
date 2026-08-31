import { sha256Json } from "../runtime/fs.mjs";

export const EVIDENCE_REACQUISITION_COMPARISON_SCHEMA_VERSION = "evidence-reacquisition-comparison-v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const DOCUMENT_ID = /^doc-sha256-[a-f0-9]{64}$/u;
const CAPTURE_ID = /^capture-sha256-[a-f0-9]{64}$/u;

function exact(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function canonicalText(value, maximum = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.normalize("NFC") && value === value.trim();
}

function iso(value) {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function material(value) {
  const { contentHash: _ignored, ...rest } = value;
  return rest;
}

export function validateEvidenceReacquisitionComparison(value) {
  const fields = ["schemaVersion", "subject", "officialSource", "sourceAssessment", "legacyFields", "reacquiredFields", "comparisons", "summary", "createdAt", "contentHash"];
  if (!exact(value, fields)) return ["evidence reacquisition comparison fields are invalid"];
  const errors = [];
  if (value.schemaVersion !== EVIDENCE_REACQUISITION_COMPARISON_SCHEMA_VERSION) errors.push("evidence reacquisition comparison schema is invalid");
  if (!exact(value.subject, ["skuId", "brand", "category", "modelId"])
    || !Object.values(value.subject).every((item) => canonicalText(item, 256))) errors.push("evidence reacquisition comparison subject is invalid");
  const sourceFields = ["documentId", "documentSha256", "captureId", "requestedUrl", "finalUrl", "officialBrand", "acquisitionMethod", "kindBasis", "identityBases", "retrievedAt"];
  if (!exact(value.officialSource, sourceFields) || !DOCUMENT_ID.test(String(value.officialSource?.documentId))
    || !SHA256.test(String(value.officialSource?.documentSha256))
    || value.officialSource?.documentId !== `doc-sha256-${value.officialSource?.documentSha256}`
    || !CAPTURE_ID.test(String(value.officialSource?.captureId))
    || ![value.officialSource?.requestedUrl, value.officialSource?.finalUrl].every((url) => {
      try { return new URL(url).protocol === "https:"; } catch { return false; }
    })
    || value.officialSource?.acquisitionMethod !== "official-fetch"
    || !["user-asserted", "content-verified"].includes(value.officialSource?.kindBasis)
    || !Array.isArray(value.officialSource?.identityBases)
    || value.officialSource.identityBases.some((basis) => !["official-domain-only", "governed-sku-user-asserted", "official-document-explicit"].includes(basis))
    || !iso(value.officialSource?.retrievedAt)) errors.push("evidence reacquisition official source is invalid");
  if (!["official_archive_identity_unverified", "official_exact_identity_verified"].includes(value.sourceAssessment)) errors.push("evidence reacquisition source assessment is invalid");
  const legacyFields = Array.isArray(value.legacyFields) ? value.legacyFields : [];
  const reacquiredFields = Array.isArray(value.reacquiredFields) ? value.reacquiredFields : [];
  const comparisons = Array.isArray(value.comparisons) ? value.comparisons : [];
  if (!Array.isArray(value.legacyFields) || legacyFields.some((entry) => !exact(entry, ["fieldId", "valueHash", "classification", "sourceFactId"])
    || !canonicalText(entry.fieldId, 256) || !SHA256.test(String(entry.valueHash))
    || !["legacy_unverified", "planning_or_inferred"].includes(entry.classification) || !canonicalText(entry.sourceFactId, 256))) {
    errors.push("evidence reacquisition legacy fields are invalid");
  }
  if (!Array.isArray(value.reacquiredFields) || reacquiredFields.some((entry) => !exact(entry, ["fieldId", "valueHash", "authority", "candidateId"])
    || !canonicalText(entry.fieldId, 256) || !SHA256.test(String(entry.valueHash)) || entry.authority !== "official"
    || !/^claim-candidate-sha256-[a-f0-9]{64}$/u.test(String(entry.candidateId)))) errors.push("evidence reacquisition governed fields are invalid");
  if (!Array.isArray(value.comparisons) || comparisons.some((entry) => !exact(entry, ["fieldId", "status", "legacyValueHash", "reacquiredValueHash"])
    || !canonicalText(entry.fieldId, 256) || !["matched", "changed", "legacy_only", "reacquired_only"].includes(entry.status)
    || (entry.legacyValueHash !== null && !SHA256.test(String(entry.legacyValueHash)))
    || (entry.reacquiredValueHash !== null && !SHA256.test(String(entry.reacquiredValueHash))))) errors.push("evidence reacquisition field comparisons are invalid");
  if ((value.officialSource?.kindBasis === "content-verified") !== (value.sourceAssessment === "official_exact_identity_verified")
    || (value.officialSource?.kindBasis === "content-verified" && !value.officialSource.identityBases.includes("official-document-explicit"))) {
    errors.push("evidence reacquisition identity assessment does not match its archived source");
  }
  const legacyByField = new Map(legacyFields.map((entry) => [entry.fieldId, entry]));
  const reacquiredByField = new Map(reacquiredFields.map((entry) => [entry.fieldId, entry]));
  const expectedFields = [...new Set([...legacyByField.keys(), ...reacquiredByField.keys()])].sort();
  if (legacyByField.size !== legacyFields.length || reacquiredByField.size !== reacquiredFields.length
    || comparisons.length !== expectedFields.length || comparisons.some((entry, index) => {
      const fieldId = expectedFields[index];
      const legacy = legacyByField.get(fieldId);
      const current = reacquiredByField.get(fieldId);
      const status = legacy && current ? (legacy.valueHash === current.valueHash ? "matched" : "changed")
        : legacy ? "legacy_only" : "reacquired_only";
      return entry.fieldId !== fieldId || entry.status !== status
        || entry.legacyValueHash !== (legacy?.valueHash ?? null)
        || entry.reacquiredValueHash !== (current?.valueHash ?? null);
    })) errors.push("evidence reacquisition comparison coverage is invalid");
  if (!exact(value.summary, ["matched", "changed", "legacyOnly", "reacquiredOnly", "activeFactsCreated"])
    || ![value.summary.matched, value.summary.changed, value.summary.legacyOnly, value.summary.reacquiredOnly].every((count) => Number.isInteger(count) && count >= 0)
    || value.summary.activeFactsCreated !== 0
    || value.summary.matched !== comparisons.filter(({ status }) => status === "matched").length
    || value.summary.changed !== comparisons.filter(({ status }) => status === "changed").length
    || value.summary.legacyOnly !== comparisons.filter(({ status }) => status === "legacy_only").length
    || value.summary.reacquiredOnly !== comparisons.filter(({ status }) => status === "reacquired_only").length) errors.push("evidence reacquisition summary is invalid");
  if (!iso(value.createdAt)) errors.push("evidence reacquisition comparison time is invalid");
  if (!SHA256.test(String(value.contentHash))
    || value.contentHash !== sha256Json({ domain: "evidence-reacquisition-comparison", material: material(value) })) errors.push("evidence reacquisition comparison hash is invalid");
  return errors;
}

export function createEvidenceReacquisitionComparison(input) {
  const legacyFields = [...(input.legacyFields ?? [])].map((entry) => ({
    fieldId: entry.fieldId,
    valueHash: sha256Json(entry.value),
    classification: entry.classification,
    sourceFactId: entry.sourceFactId,
  })).sort((left, right) => left.fieldId.localeCompare(right.fieldId));
  const reacquiredFields = [...(input.reacquiredFields ?? [])].map((entry) => ({
    fieldId: entry.fieldId,
    valueHash: sha256Json(entry.value),
    authority: "official",
    candidateId: entry.candidateId,
  })).sort((left, right) => left.fieldId.localeCompare(right.fieldId));
  const legacyByField = new Map(legacyFields.map((entry) => [entry.fieldId, entry]));
  const currentByField = new Map(reacquiredFields.map((entry) => [entry.fieldId, entry]));
  const comparisons = [...new Set([...legacyByField.keys(), ...currentByField.keys()])].sort().map((fieldId) => {
    const legacy = legacyByField.get(fieldId);
    const current = currentByField.get(fieldId);
    const status = legacy && current ? (legacy.valueHash === current.valueHash ? "matched" : "changed")
      : legacy ? "legacy_only" : "reacquired_only";
    return { fieldId, status, legacyValueHash: legacy?.valueHash ?? null, reacquiredValueHash: current?.valueHash ?? null };
  });
  const materialValue = {
    schemaVersion: EVIDENCE_REACQUISITION_COMPARISON_SCHEMA_VERSION,
    subject: { ...input.subject },
    officialSource: {
      documentId: input.document.id,
      documentSha256: input.document.sha256,
      captureId: input.capture.id,
      requestedUrl: input.capture.requestedUrl,
      finalUrl: input.capture.finalUrl,
      officialBrand: input.capture.officialBrand,
      acquisitionMethod: input.capture.acquisitionMethod,
      kindBasis: input.capture.kindBasis,
      identityBases: [...new Set(input.capture.productIdentities.map((identity) => identity.basis))].sort(),
      retrievedAt: input.capture.retrievedAt,
    },
    sourceAssessment: input.capture.kindBasis === "content-verified"
      ? "official_exact_identity_verified" : "official_archive_identity_unverified",
    legacyFields,
    reacquiredFields,
    comparisons,
    summary: {
      matched: comparisons.filter(({ status }) => status === "matched").length,
      changed: comparisons.filter(({ status }) => status === "changed").length,
      legacyOnly: comparisons.filter(({ status }) => status === "legacy_only").length,
      reacquiredOnly: comparisons.filter(({ status }) => status === "reacquired_only").length,
      activeFactsCreated: 0,
    },
    createdAt: input.createdAt,
  };
  const result = { ...materialValue, contentHash: sha256Json({ domain: "evidence-reacquisition-comparison", material: materialValue }) };
  const errors = validateEvidenceReacquisitionComparison(result);
  if (errors.length) throw new TypeError(errors.join("; "));
  return Object.freeze(result);
}
