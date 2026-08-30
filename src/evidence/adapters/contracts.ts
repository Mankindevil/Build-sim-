import { hashContent, isSha256Hex } from "../../hash";
import { factFieldPolicy, validateFactFieldValue, type FactAuthority } from "../../facts/field-registry";
import {
  evaluateOfficialDocumentPromotion,
  validateOfficialDocumentIdentityConfirmation,
  validateThirdPartyEvidenceSource,
  validateThirdPartyIndependenceAssessment,
  type OfficialDocumentPromotionInput,
  type ThirdPartyEvidenceSource,
  type ThirdPartyIndependenceAssessment,
} from "../ladder.mjs";
import type { EvidencePipelineSubject } from "../jobs/contracts";

export const EVIDENCE_EXTRACTION_ADAPTER_SCHEMA_VERSION = "evidence-extraction-adapter-v1" as const;
export const EVIDENCE_ADAPTER_CANDIDATE_SCHEMA_VERSION = "evidence-adapter-candidate-v1" as const;
export const EVIDENCE_EXTRACTION_ADAPTER_MEDIA_TYPE = "application/vnd.buildsim.evidence-extraction-adapter+json" as const;
export const EVIDENCE_ADAPTER_CANDIDATE_MEDIA_TYPE = "application/vnd.buildsim.evidence-adapter-candidate+json" as const;
export const EVIDENCE_ADAPTER_OFFICIAL_PROOF_SCHEMA_VERSION = "evidence-adapter-official-promotion-proof-v1" as const;
export const EVIDENCE_ADAPTER_THIRD_PARTY_PROOF_SCHEMA_VERSION = "evidence-adapter-third-party-proof-v1" as const;

export const EVIDENCE_ADAPTER_DECODERS = Object.freeze([
  "token",
  "string_set",
  "number",
  "boolean",
  "firmware_cpu_support",
  "qvl_entry",
  "fastener_count",
  "tool_required",
  "port_topology",
  "cable_count",
  "fan_curve",
  "system_requirement",
  "psu_pinout",
] as const);

export type EvidenceAdapterDecoderId = (typeof EVIDENCE_ADAPTER_DECODERS)[number];
export type ConfirmableOfficialPageKind = "manual" | "errata" | "support" | "qvl" | "firmware" | "technical_specification" | "product";

export interface EvidenceExtractionRule {
  readonly ruleId: string;
  readonly fieldId: string;
  readonly label: string;
  readonly decoder: EvidenceAdapterDecoderId;
  readonly unit?: string;
}

export interface EvidenceExtractionAdapterManifestMaterial {
  readonly schemaVersion: typeof EVIDENCE_EXTRACTION_ADAPTER_SCHEMA_VERSION;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly brandId: string;
  readonly brandAliases: readonly string[];
  readonly categoryIds: readonly string[];
  readonly officialHosts: readonly string[];
  readonly pageKind: ConfirmableOfficialPageKind;
  readonly identityScope: "revision";
  readonly supportedFieldIds: readonly string[];
  readonly rules: readonly EvidenceExtractionRule[];
  readonly approvalRequired: true;
}

export interface EvidenceExtractionAdapterManifest extends EvidenceExtractionAdapterManifestMaterial {
  readonly manifestRef: `sha256:${string}`;
  readonly contentHash: string;
}

export interface EvidenceAdapterCapability {
  readonly fieldId: string;
  readonly value: unknown;
  readonly unit?: string;
  readonly authority: Extract<FactAuthority, "official" | "third_party">;
  readonly sourceClaimIds: readonly string[];
}

export interface EvidenceAdapterUnresolvedField {
  readonly fieldId: string;
  readonly reason: "claim_missing" | "official_authority_required" | "claim_conflict" | "promotion_proof_missing" | "third_party_proof_missing";
  readonly action: "review_official_excerpt" | "resolve_claim_conflict" | "review_evidence_promotion";
}

export interface EvidenceAdapterClaimSourceClosure {
  readonly claimId: string;
  readonly authority: Extract<FactAuthority, "official" | "third_party">;
  readonly documentId: string;
  readonly documentSha256: string;
  readonly captureId: string;
}

export interface EvidenceAdapterOfficialPromotionProof {
  readonly schemaVersion: typeof EVIDENCE_ADAPTER_OFFICIAL_PROOF_SCHEMA_VERSION;
  readonly proofRef: `sha256:${string}`;
  readonly contentHash: string;
  readonly promotionInput: OfficialDocumentPromotionInput;
}

export interface EvidenceAdapterThirdPartyProof {
  readonly schemaVersion: typeof EVIDENCE_ADAPTER_THIRD_PARTY_PROOF_SCHEMA_VERSION;
  readonly proofRef: `sha256:${string}`;
  readonly contentHash: string;
  readonly sources: readonly ThirdPartyEvidenceSource[];
  readonly assessment: ThirdPartyIndependenceAssessment;
}

export interface EvidenceAdapterCandidateMaterial {
  readonly schemaVersion: typeof EVIDENCE_ADAPTER_CANDIDATE_SCHEMA_VERSION;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly extractionManifestRef: `sha256:${string}`;
  readonly subject: EvidencePipelineSubject;
  readonly requestedFieldIds: readonly string[];
  readonly claimRefs: readonly string[];
  readonly claimSources: readonly EvidenceAdapterClaimSourceClosure[];
  readonly archiveArtifactRefs: readonly `sha256:${string}`[];
  readonly officialPromotionProof: EvidenceAdapterOfficialPromotionProof | null;
  readonly thirdPartyProof: EvidenceAdapterThirdPartyProof | null;
  readonly authorities: readonly Extract<FactAuthority, "official" | "third_party">[];
  readonly capabilities: readonly EvidenceAdapterCapability[];
  readonly unresolved: readonly EvidenceAdapterUnresolvedField[];
  readonly candidateStatus: "ready_for_review" | "needs_review";
  readonly approvalRequired: true;
}

export interface EvidenceAdapterCandidate extends EvidenceAdapterCandidateMaterial {
  readonly candidateId: `evidence-adapter-candidate-sha256-${string}`;
  readonly candidateRef: `sha256:${string}`;
  readonly contentHash: string;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;
const CLAIM_ID = /^claim-sha256-[a-f0-9]{64}$/;
const ARTIFACT_REF = /^sha256:[a-f0-9]{64}$/;
const CANDIDATE_ID = /^evidence-adapter-candidate-sha256-[a-f0-9]{64}$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/;

function total(operation: () => string[]): string[] {
  try { return operation(); } catch { return ["evidence adapter validation failed closed"]; }
}

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every((descriptor) => "value" in descriptor && descriptor.enumerable === true);
}

function exactRecord(value: unknown, fields: readonly string[], required: readonly string[] = fields): value is Record<string, unknown> {
  return plainRecord(value) && Object.keys(value).every((key) => fields.includes(key)) && required.every((key) => own(value, key));
}

function canonicalText(value: unknown, maximum = 512): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || value !== value.normalize("NFC")
    || /[\u0000-\u001f\u007f]/.test(value)) return false;
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

function token(value: unknown): value is string {
  return canonicalText(value) && TOKEN.test(value);
}

function uniqueSortedStrings(value: unknown, predicate: (item: unknown) => boolean = token, allowEmpty = false): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(predicate)
    && new Set(value).size === value.length
    && value.every((item, index) => index === 0 || String(value[index - 1]).localeCompare(String(item)) < 0);
}

function validateSubject(value: unknown): string[] {
  if (!exactRecord(value, ["brand", "category", "skuId", "familyId", "modelId", "variantId", "revision", "region"],
    ["brand", "category", "skuId", "familyId", "modelId", "variantId", "revision"])) return ["evidence adapter subject must be exact revision identity"];
  const errors: string[] = [];
  if (!canonicalText(value.brand, 256) || !canonicalText(value.category, 256)) errors.push("evidence adapter subject brand/category invalid");
  for (const field of ["skuId", "familyId", "modelId", "variantId", "revision", "region"] as const) {
    if (value[field] !== undefined && !token(value[field])) errors.push(`evidence adapter subject ${field} invalid`);
  }
  return errors;
}

function validateRule(value: unknown): string[] {
  if (!exactRecord(value, ["ruleId", "fieldId", "label", "decoder", "unit"], ["ruleId", "fieldId", "label", "decoder"])) {
    return ["evidence adapter rule fields invalid"];
  }
  const errors: string[] = [];
  if (!token(value.ruleId)) errors.push("evidence adapter ruleId invalid");
  const policy = factFieldPolicy(value.fieldId);
  if (!policy) errors.push("evidence adapter rule field is not governed");
  if (!canonicalText(value.label, 120) || !/^[A-Za-z0-9][A-Za-z0-9 /()_.+-]{0,119}:$/.test(value.label)) errors.push("evidence adapter rule label invalid");
  if (!(EVIDENCE_ADAPTER_DECODERS as readonly unknown[]).includes(value.decoder)) errors.push("evidence adapter rule decoder invalid");
  if (policy) {
    const expectedUnit = value.unit === undefined ? undefined : value.unit;
    if (policy.unitIds.length === 0 ? expectedUnit !== undefined : typeof expectedUnit !== "string" || !policy.unitIds.includes(expectedUnit)) {
      errors.push("evidence adapter rule unit does not match field policy");
    }
  }
  return errors;
}

function manifestMaterial(value: EvidenceExtractionAdapterManifest | EvidenceExtractionAdapterManifestMaterial): EvidenceExtractionAdapterManifestMaterial {
  return {
    schemaVersion: value.schemaVersion,
    adapterId: value.adapterId,
    adapterVersion: value.adapterVersion,
    brandId: value.brandId,
    brandAliases: value.brandAliases,
    categoryIds: value.categoryIds,
    officialHosts: value.officialHosts,
    pageKind: value.pageKind,
    identityScope: value.identityScope,
    supportedFieldIds: value.supportedFieldIds,
    rules: value.rules,
    approvalRequired: value.approvalRequired,
  };
}

function artifactHash(artifactId: string, mediaType: string, payload: unknown): Promise<string> {
  return hashContent({
    schemaVersion: "artifact-payload-v1",
    artifactId,
    mediaType,
    payload,
  }, { domain: "artifact", schemaVersion: "artifact-payload-v1" });
}

function officialProofMaterial(input: OfficialDocumentPromotionInput): {
  readonly schemaVersion: typeof EVIDENCE_ADAPTER_OFFICIAL_PROOF_SCHEMA_VERSION;
  readonly promotionInput: OfficialDocumentPromotionInput;
} {
  return { schemaVersion: EVIDENCE_ADAPTER_OFFICIAL_PROOF_SCHEMA_VERSION, promotionInput: input };
}

export async function createEvidenceAdapterOfficialPromotionProof(
  input: OfficialDocumentPromotionInput,
): Promise<EvidenceAdapterOfficialPromotionProof> {
  const promotion = evaluateOfficialDocumentPromotion(input);
  if (!promotion.eligible) throw new TypeError("Evidence adapter official promotion proof is ineligible");
  const material = structuredClone(officialProofMaterial(input));
  const contentHash = await artifactHash(
    `adapter-official-promotion:${input.confirmation.confirmationId}`,
    "application/vnd.buildsim.evidence-adapter-official-promotion-proof+json",
    material,
  );
  return deepFreeze({ ...material, proofRef: `sha256:${contentHash}` as const, contentHash });
}

function thirdPartyProofMaterial(
  sources: readonly ThirdPartyEvidenceSource[],
  assessment: ThirdPartyIndependenceAssessment,
): {
  readonly schemaVersion: typeof EVIDENCE_ADAPTER_THIRD_PARTY_PROOF_SCHEMA_VERSION;
  readonly sources: readonly ThirdPartyEvidenceSource[];
  readonly assessment: ThirdPartyIndependenceAssessment;
} {
  return { schemaVersion: EVIDENCE_ADAPTER_THIRD_PARTY_PROOF_SCHEMA_VERSION, sources, assessment };
}

export async function createEvidenceAdapterThirdPartyProof(input: {
  readonly sources: readonly ThirdPartyEvidenceSource[];
  readonly assessment: ThirdPartyIndependenceAssessment;
}): Promise<EvidenceAdapterThirdPartyProof> {
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 8
    || input.sources.some((source) => validateThirdPartyEvidenceSource(source).length > 0)
    || validateThirdPartyIndependenceAssessment(input.assessment).length > 0 || input.assessment.conflicted
    || input.assessment.confidence === "none" || input.assessment.ladderLevel === null) {
    throw new TypeError("Evidence adapter third-party proof is invalid");
  }
  const byId = new Map(input.sources.map((source) => [source.sourceId, source]));
  const sources = input.assessment.sourceIds.map((sourceId) => byId.get(sourceId));
  if (sources.some((source) => source === undefined) || byId.size !== sources.length) {
    throw new TypeError("Evidence adapter third-party proof source closure is invalid");
  }
  const material = structuredClone(thirdPartyProofMaterial(sources as ThirdPartyEvidenceSource[], input.assessment));
  const contentHash = await artifactHash(
    `adapter-third-party-proof:${input.assessment.assessmentId}`,
    "application/vnd.buildsim.evidence-adapter-third-party-proof+json",
    material,
  );
  return deepFreeze({ ...material, proofRef: `sha256:${contentHash}` as const, contentHash });
}

export function validateEvidenceExtractionAdapterManifest(value: unknown): string[] {
  return total(() => {
    const fields = [
      "schemaVersion", "adapterId", "adapterVersion", "brandId", "brandAliases", "categoryIds", "officialHosts",
      "pageKind", "identityScope", "supportedFieldIds", "rules", "approvalRequired", "manifestRef", "contentHash",
    ];
    if (!plainRecord(value)) return ["evidence adapter manifest must be an object"];
    const errors: string[] = [];
    if (Object.keys(value).some((key) => !fields.includes(key))) errors.push("evidence adapter manifest contains unknown fields");
    if (!fields.every((key) => own(value, key))) errors.push("evidence adapter manifest is missing required fields");
    if (value.schemaVersion !== EVIDENCE_EXTRACTION_ADAPTER_SCHEMA_VERSION) errors.push("evidence adapter manifest schema invalid");
    if (!token(value.adapterId) || !token(value.adapterVersion) || !token(value.brandId)) errors.push("evidence adapter manifest identity invalid");
    if (!uniqueSortedStrings(value.brandAliases, (item) => canonicalText(item, 256))) errors.push("evidence adapter manifest brand aliases invalid");
    if (!uniqueSortedStrings(value.categoryIds)) errors.push("evidence adapter manifest category IDs invalid");
    if (!uniqueSortedStrings(value.officialHosts, (item) => typeof item === "string" && HOST.test(item) && item === item.toLocaleLowerCase())) {
      errors.push("evidence adapter manifest official hosts invalid");
    }
    if (!["manual", "errata", "support", "qvl", "firmware", "technical_specification", "product"].includes(String(value.pageKind))) {
      errors.push("evidence adapter manifest page kind invalid");
    }
    if (value.identityScope !== "revision") errors.push("evidence adapter manifest must require revision identity");
    if (!uniqueSortedStrings(value.supportedFieldIds) || (value.supportedFieldIds as string[]).some((fieldId) => !factFieldPolicy(fieldId))) {
      errors.push("evidence adapter manifest supported fields invalid");
    }
    if (!Array.isArray(value.rules) || value.rules.length === 0 || value.rules.length > 128) errors.push("evidence adapter manifest rules invalid");
    else {
      for (const [index, rule] of value.rules.entries()) errors.push(...validateRule(rule).map((error) => `rules.${index}: ${error}`));
      const rules = value.rules as EvidenceExtractionRule[];
      if (new Set(rules.map((rule) => rule.ruleId)).size !== rules.length) errors.push("evidence adapter manifest rule IDs must be unique");
      if (!rules.every((rule, index) => index === 0 || rules[index - 1]!.ruleId.localeCompare(rule.ruleId) < 0)) errors.push("evidence adapter manifest rules must be sorted");
      const ruleFields = [...new Set(rules.map((rule) => rule.fieldId))].sort();
      if (!Array.isArray(value.supportedFieldIds) || JSON.stringify(ruleFields) !== JSON.stringify(value.supportedFieldIds)) {
        errors.push("evidence adapter manifest rules do not close supported fields");
      }
    }
    if (value.approvalRequired !== true) errors.push("evidence adapter manifest must require approval");
    if (!isSha256Hex(value.contentHash) || value.manifestRef !== `sha256:${String(value.contentHash)}`) errors.push("evidence adapter manifest content reference invalid");
    return errors;
  });
}

export async function createEvidenceExtractionAdapterManifest(
  input: EvidenceExtractionAdapterManifestMaterial,
): Promise<EvidenceExtractionAdapterManifest> {
  const material = structuredClone(input);
  const structural = { ...material, manifestRef: `sha256:${"0".repeat(64)}`, contentHash: "0".repeat(64) };
  const errors = validateEvidenceExtractionAdapterManifest(structural);
  const hashOnlyErrors = errors.filter((error) => error !== "evidence adapter manifest content reference invalid");
  if (hashOnlyErrors.length) throw new TypeError(`Invalid evidence adapter manifest: ${hashOnlyErrors.join("; ")}`);
  const contentHash = await artifactHash(`${material.adapterId}@${material.adapterVersion}`, EVIDENCE_EXTRACTION_ADAPTER_MEDIA_TYPE, material);
  const manifest = deepFreeze({ ...material, manifestRef: `sha256:${contentHash}` as const, contentHash });
  const finalErrors = validateEvidenceExtractionAdapterManifest(manifest);
  if (finalErrors.length) throw new TypeError(`Invalid evidence adapter manifest: ${finalErrors.join("; ")}`);
  return manifest;
}

export async function verifyEvidenceExtractionAdapterManifest(value: unknown): Promise<boolean> {
  if (validateEvidenceExtractionAdapterManifest(value).length) return false;
  const manifest = value as EvidenceExtractionAdapterManifest;
  return manifest.contentHash === await artifactHash(
    `${manifest.adapterId}@${manifest.adapterVersion}`,
    EVIDENCE_EXTRACTION_ADAPTER_MEDIA_TYPE,
    manifestMaterial(manifest),
  );
}

function validateCapability(value: unknown): string[] {
  if (!exactRecord(value, ["fieldId", "value", "unit", "authority", "sourceClaimIds"], ["fieldId", "value", "authority", "sourceClaimIds"])) {
    return ["evidence adapter capability fields invalid"];
  }
  const errors: string[] = [];
  const policy = factFieldPolicy(value.fieldId);
  if (!policy) errors.push("evidence adapter capability field is not governed");
  else errors.push(...validateFactFieldValue(policy, value.value, value.unit));
  if (value.authority !== "official" && value.authority !== "third_party") errors.push("evidence adapter capability authority invalid");
  if (!uniqueSortedStrings(value.sourceClaimIds, (item) => typeof item === "string" && CLAIM_ID.test(item))) {
    errors.push("evidence adapter capability claim refs invalid");
  }
  return errors;
}

function validateClaimSource(value: unknown): string[] {
  if (!exactRecord(value, ["claimId", "authority", "documentId", "documentSha256", "captureId"])) {
    return ["evidence adapter claim source closure fields invalid"];
  }
  const errors: string[] = [];
  if (typeof value.claimId !== "string" || !CLAIM_ID.test(value.claimId)) errors.push("evidence adapter claim source ID invalid");
  if (value.authority !== "official" && value.authority !== "third_party") errors.push("evidence adapter claim source authority invalid");
  if (typeof value.documentSha256 !== "string" || !isSha256Hex(value.documentSha256)
    || value.documentId !== `doc-sha256-${String(value.documentSha256)}`) errors.push("evidence adapter claim document closure invalid");
  if (typeof value.captureId !== "string" || !/^capture-sha256-[a-f0-9]{64}$/.test(value.captureId)) {
    errors.push("evidence adapter claim capture closure invalid");
  }
  return errors;
}

function validateOfficialProof(value: unknown): string[] {
  if (!exactRecord(value, ["schemaVersion", "proofRef", "contentHash", "promotionInput"])) {
    return ["evidence adapter official promotion proof fields invalid"];
  }
  const errors: string[] = [];
  if (value.schemaVersion !== EVIDENCE_ADAPTER_OFFICIAL_PROOF_SCHEMA_VERSION
    || typeof value.contentHash !== "string" || !isSha256Hex(value.contentHash)
    || value.proofRef !== `sha256:${String(value.contentHash)}`) errors.push("evidence adapter official promotion proof identity invalid");
  const promotion = evaluateOfficialDocumentPromotion(value.promotionInput as OfficialDocumentPromotionInput);
  if (!promotion.eligible) errors.push("evidence adapter official promotion proof is ineligible");
  else if (validateOfficialDocumentIdentityConfirmation((value.promotionInput as OfficialDocumentPromotionInput).confirmation).length > 0) {
    errors.push("evidence adapter official promotion confirmation invalid");
  }
  return errors;
}

function validateThirdPartyProof(value: unknown): string[] {
  if (!exactRecord(value, ["schemaVersion", "proofRef", "contentHash", "sources", "assessment"])) {
    return ["evidence adapter third-party proof fields invalid"];
  }
  const errors: string[] = [];
  if (value.schemaVersion !== EVIDENCE_ADAPTER_THIRD_PARTY_PROOF_SCHEMA_VERSION
    || typeof value.contentHash !== "string" || !isSha256Hex(value.contentHash)
    || value.proofRef !== `sha256:${String(value.contentHash)}`) errors.push("evidence adapter third-party proof identity invalid");
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 8) {
    errors.push("evidence adapter third-party proof sources invalid");
  } else {
    for (const [index, source] of value.sources.entries()) {
      errors.push(...validateThirdPartyEvidenceSource(source).map((error) => `thirdPartyProof.sources.${index}: ${error}`));
    }
  }
  errors.push(...validateThirdPartyIndependenceAssessment(value.assessment).map((error) => `thirdPartyProof.assessment: ${error}`));
  if (plainRecord(value.assessment) && (value.assessment.conflicted === true || value.assessment.confidence === "none"
    || value.assessment.ladderLevel === null)) errors.push("evidence adapter third-party proof is not qualifying");
  if (Array.isArray(value.sources) && plainRecord(value.assessment)) {
    const sourceIds = (value.sources as ThirdPartyEvidenceSource[]).map((source) => source.sourceId);
    if (JSON.stringify(sourceIds) !== JSON.stringify(value.assessment.sourceIds)) {
      errors.push("evidence adapter third-party proof source closure invalid");
    }
  }
  return errors;
}

function validateUnresolved(value: unknown): string[] {
  if (!exactRecord(value, ["fieldId", "reason", "action"])) return ["evidence adapter unresolved field invalid"];
  const errors: string[] = [];
  if (!factFieldPolicy(value.fieldId)) errors.push("evidence adapter unresolved field is not governed");
  if (!["claim_missing", "official_authority_required", "claim_conflict", "promotion_proof_missing", "third_party_proof_missing"].includes(String(value.reason))) {
    errors.push("evidence adapter unresolved reason invalid");
  }
  if (!["review_official_excerpt", "resolve_claim_conflict", "review_evidence_promotion"].includes(String(value.action))) {
    errors.push("evidence adapter unresolved action invalid");
  }
  const expectedAction = value.reason === "claim_conflict" ? "resolve_claim_conflict"
    : value.reason === "promotion_proof_missing" || value.reason === "third_party_proof_missing"
      ? "review_evidence_promotion" : "review_official_excerpt";
  if (value.action !== expectedAction) {
    errors.push("evidence adapter unresolved action/reason mismatch");
  }
  return errors;
}

function candidateMaterial(value: EvidenceAdapterCandidate | EvidenceAdapterCandidateMaterial): EvidenceAdapterCandidateMaterial {
  return {
    schemaVersion: value.schemaVersion,
    adapterId: value.adapterId,
    adapterVersion: value.adapterVersion,
    extractionManifestRef: value.extractionManifestRef,
    subject: value.subject,
    requestedFieldIds: value.requestedFieldIds,
    claimRefs: value.claimRefs,
    claimSources: value.claimSources,
    archiveArtifactRefs: value.archiveArtifactRefs,
    officialPromotionProof: value.officialPromotionProof,
    thirdPartyProof: value.thirdPartyProof,
    authorities: value.authorities,
    capabilities: value.capabilities,
    unresolved: value.unresolved,
    candidateStatus: value.candidateStatus,
    approvalRequired: value.approvalRequired,
  };
}

export function validateEvidenceAdapterCandidate(value: unknown): string[] {
  return total(() => {
    const fields = [
      "schemaVersion", "candidateId", "candidateRef", "adapterId", "adapterVersion", "extractionManifestRef", "subject",
      "requestedFieldIds", "claimRefs", "claimSources", "archiveArtifactRefs", "officialPromotionProof", "thirdPartyProof",
      "authorities", "capabilities", "unresolved", "candidateStatus", "approvalRequired", "contentHash",
    ];
    if (!plainRecord(value)) return ["evidence adapter candidate must be an object"];
    const errors: string[] = [];
    if (Object.keys(value).some((key) => !fields.includes(key))) errors.push("evidence adapter candidate contains unknown fields");
    if (!fields.every((key) => own(value, key))) errors.push("evidence adapter candidate is missing required fields");
    if (value.schemaVersion !== EVIDENCE_ADAPTER_CANDIDATE_SCHEMA_VERSION) errors.push("evidence adapter candidate schema invalid");
    if (!token(value.adapterId) || !token(value.adapterVersion) || typeof value.extractionManifestRef !== "string" || !ARTIFACT_REF.test(value.extractionManifestRef)) {
      errors.push("evidence adapter candidate adapter identity invalid");
    }
    errors.push(...validateSubject(value.subject));
    if (!uniqueSortedStrings(value.requestedFieldIds) || (value.requestedFieldIds as string[]).some((fieldId) => !factFieldPolicy(fieldId))) {
      errors.push("evidence adapter candidate requested fields invalid");
    }
    if (!uniqueSortedStrings(value.claimRefs, (item) => typeof item === "string" && CLAIM_ID.test(item), true)) errors.push("evidence adapter candidate claim refs invalid");
    if (!Array.isArray(value.claimSources)) errors.push("evidence adapter candidate claim source closure invalid");
    else {
      for (const [index, source] of value.claimSources.entries()) errors.push(...validateClaimSource(source).map((error) => `claimSources.${index}: ${error}`));
      const sources = value.claimSources as EvidenceAdapterClaimSourceClosure[];
      if (!sources.every((source, index) => index === 0 || sources[index - 1]!.claimId.localeCompare(source.claimId) < 0)) {
        errors.push("evidence adapter candidate claim sources must be sorted and unique");
      }
      if (!Array.isArray(value.claimRefs) || JSON.stringify(sources.map((source) => source.claimId)) !== JSON.stringify(value.claimRefs)) {
        errors.push("evidence adapter candidate claim source/ref closure invalid");
      }
    }
    if (!uniqueSortedStrings(value.archiveArtifactRefs, (item) => typeof item === "string" && ARTIFACT_REF.test(item), true)) {
      errors.push("evidence adapter candidate archive artifact refs invalid");
    }
    if (value.officialPromotionProof !== null) {
      errors.push(...validateOfficialProof(value.officialPromotionProof));
      if (plainRecord(value.officialPromotionProof) && plainRecord(value.officialPromotionProof.promotionInput)) {
        const proof = value.officialPromotionProof as unknown as EvidenceAdapterOfficialPromotionProof;
        const expected = proof.promotionInput.expectedIdentity;
        const subject = value.subject as EvidencePipelineSubject;
        if (expected.brand !== subject.brand || expected.skuId !== subject.skuId || expected.familyId !== subject.familyId
          || expected.modelId !== subject.modelId || expected.variantId !== subject.variantId || expected.revision !== subject.revision
          || expected.region !== subject.region || proof.promotionInput.confirmation.extractor.id !== value.adapterId
          || proof.promotionInput.confirmation.extractor.version !== value.adapterVersion) {
          errors.push("evidence adapter official promotion proof subject/adapter closure invalid");
        }
      }
    }
    if (value.thirdPartyProof !== null) {
      errors.push(...validateThirdPartyProof(value.thirdPartyProof));
      if (plainRecord(value.thirdPartyProof) && Array.isArray(value.thirdPartyProof.sources)) {
        const subject = value.subject as EvidencePipelineSubject;
        if ((value.thirdPartyProof.sources as ThirdPartyEvidenceSource[]).some((source) => source.subject.skuId !== subject.skuId
          || source.subject.familyId !== subject.familyId || source.subject.modelId !== subject.modelId
          || source.subject.variantId !== subject.variantId || source.subject.revision !== subject.revision
          || source.subject.region !== subject.region)) errors.push("evidence adapter third-party proof subject closure invalid");
      }
    }
    if (Array.isArray(value.claimSources)) {
      const sources = value.claimSources as EvidenceAdapterClaimSourceClosure[];
      if (value.officialPromotionProof !== null && !sources.some((source) => source.authority === "official")) {
        errors.push("evidence adapter official promotion proof is unreferenced");
      }
      if (value.thirdPartyProof !== null && !sources.some((source) => source.authority === "third_party")) {
        errors.push("evidence adapter third-party proof is unreferenced");
      }
    }
    if (!uniqueSortedStrings(value.authorities, (item) => item === "official" || item === "third_party", true)) errors.push("evidence adapter candidate authorities invalid");
    if (!Array.isArray(value.capabilities)) errors.push("evidence adapter candidate capabilities invalid");
    else {
      for (const [index, capability] of value.capabilities.entries()) errors.push(...validateCapability(capability).map((error) => `capabilities.${index}: ${error}`));
      const capabilities = value.capabilities as EvidenceAdapterCapability[];
      if (!capabilities.every((capability, index) => index === 0 || capability.fieldId.localeCompare(capabilities[index - 1]!.fieldId) >= 0)) {
        errors.push("evidence adapter candidate capabilities must be sorted");
      }
      if (capabilities.some((capability) => !Array.isArray(value.claimRefs) || capability.sourceClaimIds.some((id) => !(value.claimRefs as string[]).includes(id)))) {
        errors.push("evidence adapter candidate capability claim closure invalid");
      }
      if (capabilities.some((capability) => capability.authority === "official" && value.officialPromotionProof === null
        || capability.authority === "third_party" && value.thirdPartyProof === null)) {
        errors.push("evidence adapter candidate capability promotion proof closure invalid");
      }
      if (Array.isArray(value.claimSources)) {
        const sourceByClaim = new Map((value.claimSources as EvidenceAdapterClaimSourceClosure[]).map((source) => [source.claimId, source]));
        const officialHash = plainRecord(value.officialPromotionProof)
          ? (value.officialPromotionProof as unknown as EvidenceAdapterOfficialPromotionProof).promotionInput.documentSha256 : null;
        const thirdPartyHashes = plainRecord(value.thirdPartyProof) && Array.isArray(value.thirdPartyProof.sources)
          ? new Set((value.thirdPartyProof.sources as ThirdPartyEvidenceSource[]).map((source) => source.sourceContentHash)) : new Set<string>();
        if (capabilities.some((capability) => capability.sourceClaimIds.some((claimId) => {
          const source = sourceByClaim.get(claimId);
          return !source || source.authority !== capability.authority || (capability.authority === "official"
            ? source.documentSha256 !== officialHash : !thirdPartyHashes.has(source.documentSha256));
        }))) errors.push("evidence adapter candidate capability evidence proof does not close its claim sources");
      }
      const actualAuthorities = Array.isArray(value.claimSources)
        ? [...new Set((value.claimSources as EvidenceAdapterClaimSourceClosure[]).map((source) => source.authority))].sort() : [];
      if (!Array.isArray(value.authorities) || JSON.stringify(actualAuthorities) !== JSON.stringify(value.authorities)) {
        errors.push("evidence adapter candidate authority summary invalid");
      }
    }
    if (!Array.isArray(value.unresolved)) errors.push("evidence adapter candidate unresolved fields invalid");
    else {
      for (const [index, unresolved] of value.unresolved.entries()) errors.push(...validateUnresolved(unresolved).map((error) => `unresolved.${index}: ${error}`));
      if (!(value.unresolved as EvidenceAdapterUnresolvedField[]).every((item, index) => index === 0 || item.fieldId.localeCompare((value.unresolved as EvidenceAdapterUnresolvedField[])[index - 1]!.fieldId) >= 0)) {
        errors.push("evidence adapter candidate unresolved fields must be sorted");
      }
    }
    const unresolvedCount = Array.isArray(value.unresolved) ? value.unresolved.length : 0;
    if (value.candidateStatus !== (unresolvedCount === 0 ? "ready_for_review" : "needs_review")) errors.push("evidence adapter candidate status invalid");
    if (value.approvalRequired !== true) errors.push("evidence adapter candidate must require approval");
    if (!isSha256Hex(value.contentHash) || value.candidateRef !== `sha256:${String(value.contentHash)}`
      || value.candidateId !== `evidence-adapter-candidate-sha256-${String(value.contentHash)}` || typeof value.candidateId !== "string"
      || !CANDIDATE_ID.test(value.candidateId)) errors.push("evidence adapter candidate content identity invalid");
    return errors;
  });
}

export async function finalizeEvidenceAdapterCandidate(material: EvidenceAdapterCandidateMaterial): Promise<EvidenceAdapterCandidate> {
  const cloned = structuredClone(material);
  const contentHash = await artifactHash(
    `${cloned.adapterId}@${cloned.adapterVersion}:${cloned.subject.skuId}:${cloned.subject.revision}`,
    EVIDENCE_ADAPTER_CANDIDATE_MEDIA_TYPE,
    cloned,
  );
  const candidate = deepFreeze({
    ...cloned,
    candidateId: `evidence-adapter-candidate-sha256-${contentHash}` as const,
    candidateRef: `sha256:${contentHash}` as const,
    contentHash,
  });
  const errors = validateEvidenceAdapterCandidate(candidate);
  if (errors.length) throw new TypeError(`Invalid evidence adapter candidate: ${errors.join("; ")}`);
  return candidate;
}

export async function verifyEvidenceAdapterCandidate(value: unknown): Promise<boolean> {
  if (validateEvidenceAdapterCandidate(value).length) return false;
  const candidate = value as EvidenceAdapterCandidate;
  if (candidate.officialPromotionProof !== null) {
    const proof = candidate.officialPromotionProof;
    if (proof.contentHash !== await artifactHash(
      `adapter-official-promotion:${proof.promotionInput.confirmation.confirmationId}`,
      "application/vnd.buildsim.evidence-adapter-official-promotion-proof+json",
      officialProofMaterial(proof.promotionInput),
    )) return false;
  }
  if (candidate.thirdPartyProof !== null) {
    const proof = candidate.thirdPartyProof;
    if (proof.contentHash !== await artifactHash(
      `adapter-third-party-proof:${proof.assessment.assessmentId}`,
      "application/vnd.buildsim.evidence-adapter-third-party-proof+json",
      thirdPartyProofMaterial(proof.sources, proof.assessment),
    )) return false;
  }
  return candidate.contentHash === await artifactHash(
    `${candidate.adapterId}@${candidate.adapterVersion}:${candidate.subject.skuId}:${candidate.subject.revision}`,
    EVIDENCE_ADAPTER_CANDIDATE_MEDIA_TYPE,
    candidateMaterial(candidate),
  );
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export function evidenceAdapterCandidateMaterial(value: EvidenceAdapterCandidate): EvidenceAdapterCandidateMaterial {
  return candidateMaterial(value);
}
