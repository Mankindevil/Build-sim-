import { createHash } from "node:crypto";
import { factFieldPolicy, validateFactFieldValue } from "../../facts/field-registry";
import { hashContent } from "../../hash";
import type { EvidenceClaimInput } from "../claims";
import { createEvidenceClaim } from "../claims";
import type { EvidencePipelineRequest } from "../jobs/contracts";
import {
  assessThirdPartySourceIndependence,
  createOfficialDocumentIdentityConfirmation,
  createThirdPartyEvidenceSource,
  type OfficialDocumentPromotionInput,
  type ThirdPartyEvidenceFinding,
  type ThirdPartyEvidenceSource,
  type ThirdPartyIndependenceAssessment,
} from "../ladder.mjs";
import type { EvidenceSearchReason } from "../search-outcome.mjs";
import type { EvidenceExtractionAdapterManifest, EvidenceExtractionRule } from "./contracts";
import { deepFreeze } from "./contracts";
import { evidenceVendorAdapterForSubject } from "./registry";

const DOCUMENT_ID = /^doc-sha256-[a-f0-9]{64}$/;
const CAPTURE_ID = /^capture-sha256-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;

export interface BoundedEvidenceExcerptEntry {
  readonly page: number;
  readonly matchType: "exact" | "terms";
  readonly matchedTerms: readonly string[];
  readonly text: string;
  readonly truncated: boolean;
}

export interface BoundedEvidenceExcerptSet {
  readonly schemaVersion: "1.0.0";
  readonly documentId: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly sourceByteLength: number;
  readonly query: string;
  readonly requestedPage?: number;
  readonly totalPages: number;
  readonly searchedPageCount: number;
  readonly extractionMode: "utf8-text" | "pdf-text-layer";
  readonly contentTrust: "untrusted-evidence-text";
  readonly returned: number;
  readonly excerpts: readonly BoundedEvidenceExcerptEntry[];
  readonly truncated: boolean;
}

export interface OfficialVendorClaimExtractorInput {
  readonly request: EvidencePipelineRequest;
  readonly excerpt: unknown;
  readonly documentId: string;
  readonly documentSha256: string;
  readonly captureId: string;
  readonly sourceUrl: string;
  readonly attemptedAt: string;
}

export interface CompletedOfficialVendorExtraction {
  readonly status: "completed";
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly manifestRef: string;
  readonly claimCandidates: readonly EvidenceClaimInput[];
  readonly officialPromotionInput: OfficialDocumentPromotionInput;
  readonly missingFieldIds: readonly [];
}

export interface IncompleteOfficialVendorExtraction {
  readonly status: "needs_review";
  readonly reason: EvidenceSearchReason;
  readonly adapterId?: string;
  readonly adapterVersion?: string;
  readonly manifestRef?: string;
  readonly claimCandidates: readonly [];
  readonly missingFieldIds: readonly string[];
  readonly detail: string;
  readonly manualAction: string;
}

export type OfficialVendorExtraction = CompletedOfficialVendorExtraction | IncompleteOfficialVendorExtraction;

interface ExtractedValue {
  readonly fieldId: string;
  readonly value: unknown;
  readonly unit?: string;
  readonly page: number;
  readonly snippet: string;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor && descriptor.enumerable);
}

function exactRecord(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): value is Record<string, unknown> {
  return plainRecord(value) && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function canonicalText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.normalize("NFC")
    && value === value.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function validateBoundedExcerpt(value: unknown, documentId: string, documentSha256: string): value is BoundedEvidenceExcerptSet {
  try {
    const fields = [
      "schemaVersion", "documentId", "contentHash", "mediaType", "sourceByteLength", "query", "requestedPage", "totalPages",
      "searchedPageCount", "extractionMode", "contentTrust", "returned", "excerpts", "truncated",
    ];
    if (!exactRecord(value, fields, fields.filter((field) => field !== "requestedPage"))) return false;
    if (value.schemaVersion !== "1.0.0" || value.documentId !== documentId || value.contentHash !== documentSha256
      || value.documentId !== `doc-sha256-${value.contentHash}` || !canonicalText(value.mediaType, 160)
      || !Number.isSafeInteger(value.sourceByteLength) || Number(value.sourceByteLength) < 1 || Number(value.sourceByteLength) > 25_000_000
      || !canonicalText(value.query, 512) || !Number.isSafeInteger(value.totalPages) || Number(value.totalPages) < 1
      || !Number.isSafeInteger(value.searchedPageCount) || Number(value.searchedPageCount) < 1 || Number(value.searchedPageCount) > Number(value.totalPages)
      || !["utf8-text", "pdf-text-layer"].includes(String(value.extractionMode)) || value.contentTrust !== "untrusted-evidence-text"
      || !Number.isSafeInteger(value.returned) || Number(value.returned) < 1 || Number(value.returned) > 8
      || !Array.isArray(value.excerpts) || value.excerpts.length !== value.returned || typeof value.truncated !== "boolean"
      || (value.requestedPage !== undefined && (!Number.isSafeInteger(value.requestedPage) || Number(value.requestedPage) < 1))) return false;
    for (const entry of value.excerpts) {
      if (!exactRecord(entry, ["page", "matchType", "matchedTerms", "text", "truncated"])
        || !Number.isSafeInteger(entry.page) || Number(entry.page) < 1 || Number(entry.page) > Number(value.totalPages)
        || !["exact", "terms"].includes(String(entry.matchType)) || !Array.isArray(entry.matchedTerms)
        || entry.matchedTerms.some((term) => !canonicalText(term, 160)) || new Set(entry.matchedTerms).size !== entry.matchedTerms.length
        || !canonicalText(entry.text, 2_000) || Buffer.byteLength(entry.text) > 1_200 || typeof entry.truncated !== "boolean") return false;
    }
    return Buffer.byteLength(JSON.stringify(value)) <= 12_000;
  } catch { return false; }
}

function incomplete(
  reason: EvidenceSearchReason,
  missingFieldIds: readonly string[],
  manualAction: string,
  manifest?: EvidenceExtractionAdapterManifest | null,
  detail = manualAction,
): IncompleteOfficialVendorExtraction {
  return deepFreeze({
    status: "needs_review",
    reason,
    ...(manifest ? { adapterId: manifest.adapterId, adapterVersion: manifest.adapterVersion, manifestRef: manifest.manifestRef } : {}),
    claimCandidates: [],
    missingFieldIds: [...new Set(missingFieldIds)].sort(),
    detail,
    manualAction,
  });
}

function safeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && url.toString() === raw ? url : null;
  } catch { return null; }
}

function officialHostMatches(url: URL, manifest: EvidenceExtractionAdapterManifest): boolean {
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  return manifest.officialHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function pageFailure(text: string): EvidenceSearchReason | null {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("en-US");
  if (/\b(?:captcha|verify you are human|human verification|access denied)\b/.test(normalized)) return "official_access_blocked";
  if (/\b(?:error\s*(?:4\d\d|5\d\d)|service unavailable|page not found|internal server error)\b/.test(normalized)) return "official_parse_failed";
  if (/\b(?:series overview|choose a model|select (?:a|your) model)\b/.test(normalized)) return "official_identity_unresolved";
  return null;
}

function allLabels(manifest: EvidenceExtractionAdapterManifest): readonly string[] {
  return Object.freeze([
    "Product Model:", "Product Variant:", "Product Revision:", "Product Region:",
    ...manifest.rules.map((rule) => rule.label),
  ]);
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  while (found.length < 128) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    found.push(index);
    from = index + needle.length;
  }
  return found;
}

function valueAfter(text: string, label: string, offset: number, labels: readonly string[]): string {
  const start = offset + label.length;
  let end = text.length;
  for (const candidate of labels) {
    const next = text.indexOf(candidate, start);
    if (next >= 0 && next < end) end = next;
  }
  return text.slice(start, end).replace(/^\s+|\s+$/g, "").replace(/^…|…$/g, "").trim();
}

function extractedIdentity(excerpts: BoundedEvidenceExcerptSet, manifest: EvidenceExtractionAdapterManifest): {
  readonly model: string;
  readonly variant: string;
  readonly revision: string;
  readonly region?: string;
  readonly page: number;
  readonly excerpt: string;
} | null {
  const labels = allLabels(manifest);
  for (const entry of excerpts.excerpts) {
    const modelOffset = entry.text.indexOf("Product Model:");
    const variantOffset = entry.text.indexOf("Product Variant:");
    const revisionOffset = entry.text.indexOf("Product Revision:");
    if (modelOffset < 0 || variantOffset < 0 || revisionOffset < 0) continue;
    const regionOffset = entry.text.indexOf("Product Region:");
    const model = valueAfter(entry.text, "Product Model:", modelOffset, labels);
    const variant = valueAfter(entry.text, "Product Variant:", variantOffset, labels);
    const revision = valueAfter(entry.text, "Product Revision:", revisionOffset, labels);
    const region = regionOffset < 0 ? undefined : valueAfter(entry.text, "Product Region:", regionOffset, labels);
    if (![model, variant, revision].every((item) => TOKEN.test(item)) || (region !== undefined && !TOKEN.test(region))) continue;
    return { model, variant, revision, ...(region === undefined ? {} : { region }), page: entry.page, excerpt: entry.text };
  }
  return null;
}

function keyValues(raw: string, required: readonly string[], optional: readonly string[] = []): Record<string, string> {
  const allowed = new Set([...required, ...optional]);
  const values: Record<string, string> = {};
  for (const field of raw.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0) throw new TypeError("structured evidence field is malformed");
    const key = field.slice(0, separator).trim();
    const value = field.slice(separator + 1).trim();
    if (!allowed.has(key) || Object.prototype.hasOwnProperty.call(values, key) || !value) throw new TypeError("structured evidence keys are invalid");
    values[key] = value;
  }
  if (required.some((key) => values[key] === undefined)) throw new TypeError("structured evidence field is incomplete");
  return values;
}

function governedToken(value: string): string {
  if (!TOKEN.test(value)) throw new TypeError("evidence token is invalid");
  return value;
}

function strictNumber(value: string): number {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new TypeError("evidence number is invalid");
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError("evidence number is invalid");
  return number;
}

function strictInteger(value: string): number {
  const number = strictNumber(value);
  if (!Number.isSafeInteger(number)) throw new TypeError("evidence integer is invalid");
  return number;
}

function strictBoolean(value: string): boolean {
  if (value !== "true" && value !== "false") throw new TypeError("evidence boolean is invalid");
  return value === "true";
}

function decode(rule: EvidenceExtractionRule, raw: string): unknown {
  if (rule.decoder === "token") return governedToken(raw);
  if (rule.decoder === "string_set") {
    const values = raw.split(",").map((item) => governedToken(item.trim())).sort();
    if (values.length === 0 || new Set(values).size !== values.length) throw new TypeError("evidence string set is invalid");
    return values;
  }
  if (rule.decoder === "number") return strictNumber(raw);
  if (rule.decoder === "boolean") return strictBoolean(raw);
  if (rule.decoder === "firmware_cpu_support") {
    const value = keyValues(raw, ["cpuSkuId", "boardRevision", "region", "sinceVersion"]);
    return {
      cpuSkuId: governedToken(value.cpuSkuId!),
      boardRevision: governedToken(value.boardRevision!),
      region: governedToken(value.region!),
      sinceVersion: governedToken(value.sinceVersion!),
    };
  }
  if (rule.decoder === "qvl_entry") {
    const value = keyValues(raw, ["componentSkuId", "boardRevision", "region", "sinceVersion", "status"]);
    return {
      componentSkuId: governedToken(value.componentSkuId!),
      boardRevision: governedToken(value.boardRevision!),
      region: governedToken(value.region!),
      sinceVersion: governedToken(value.sinceVersion!),
      status: governedToken(value.status!),
    };
  }
  if (rule.decoder === "fastener_count") {
    const value = keyValues(raw, ["fastenerId", "quantity"]);
    return { fastenerId: governedToken(value.fastenerId!), quantity: strictInteger(value.quantity!) };
  }
  if (rule.decoder === "tool_required") {
    const value = keyValues(raw, ["toolId", "required"]);
    return { toolId: governedToken(value.toolId!), required: strictBoolean(value.required!) };
  }
  if (rule.decoder === "port_topology") {
    const value = keyValues(raw, ["endpointId", "connectorType", "location", "controllerId", "pathId", "quantity"]);
    return {
      endpointId: governedToken(value.endpointId!),
      connectorType: governedToken(value.connectorType!),
      location: governedToken(value.location!),
      controllerId: governedToken(value.controllerId!),
      pathId: governedToken(value.pathId!),
      quantity: strictInteger(value.quantity!),
    };
  }
  if (rule.decoder === "cable_count") {
    const value = keyValues(raw, ["cableId", "connectorFamily", "quantity"]);
    return {
      cableId: governedToken(value.cableId!),
      connectorFamily: governedToken(value.connectorFamily!),
      quantity: strictInteger(value.quantity!),
    };
  }
  if (rule.decoder === "fan_curve") {
    const value = keyValues(raw, ["curveId", "input", "output", "points"]);
    const points = value.points!.split(",").map((point) => {
      const [input, output, ...rest] = point.split(":");
      if (input === undefined || output === undefined || rest.length) throw new TypeError("fan curve point is invalid");
      return { input: strictNumber(input), output: strictNumber(output) };
    });
    return {
      curveId: governedToken(value.curveId!),
      input: governedToken(value.input!),
      output: governedToken(value.output!),
      points,
    };
  }
  if (rule.decoder === "system_requirement") {
    const value = keyValues(raw, ["systemProfileId", "releaseId", "requirementId", "operator", "valueType", "value"], ["unit"]);
    const valueType = governedToken(value.valueType!);
    const decoded = valueType === "number" ? strictNumber(value.value!)
      : valueType === "boolean" ? strictBoolean(value.value!) : valueType === "string" ? governedToken(value.value!)
        : (() => { throw new TypeError("system requirement value type is invalid"); })();
    return {
      systemProfileId: governedToken(value.systemProfileId!),
      releaseId: governedToken(value.releaseId!),
      requirementId: governedToken(value.requirementId!),
      operator: governedToken(value.operator!),
      valueType,
      value: decoded,
      ...(value.unit === undefined ? {} : { unit: governedToken(value.unit) }),
    };
  }
  if (rule.decoder === "psu_pinout") {
    const value = keyValues(raw, ["connectorFamily", "revision", "pinCount", "pinMapHash"]);
    if (!SHA256.test(value.pinMapHash!)) throw new TypeError("pinout hash is invalid");
    return {
      connectorFamily: governedToken(value.connectorFamily!),
      revision: governedToken(value.revision!),
      pinCount: strictInteger(value.pinCount!),
      pinMapHash: value.pinMapHash!,
    };
  }
  throw new TypeError("evidence decoder is not governed");
}

function extractValues(excerpts: BoundedEvidenceExcerptSet, manifest: EvidenceExtractionAdapterManifest, requested: ReadonlySet<string>): ExtractedValue[] {
  const labels = allLabels(manifest);
  const values: ExtractedValue[] = [];
  const dedup = new Set<string>();
  for (const rule of manifest.rules) {
    if (!requested.has(rule.fieldId)) continue;
    for (const entry of excerpts.excerpts) for (const offset of occurrences(entry.text, rule.label)) {
      const raw = valueAfter(entry.text, rule.label, offset, labels);
      let value: unknown;
      try { value = decode(rule, raw); } catch { continue; }
      const policy = factFieldPolicy(rule.fieldId);
      if (!policy || validateFactFieldValue(policy, value, rule.unit).length) continue;
      const key = JSON.stringify([rule.fieldId, value, rule.unit]);
      if (dedup.has(key)) continue;
      dedup.add(key);
      values.push({
        fieldId: rule.fieldId,
        value,
        ...(rule.unit === undefined ? {} : { unit: rule.unit }),
        page: entry.page,
        snippet: `${rule.label} ${raw}`.slice(0, 1_000),
      });
    }
  }
  return values.sort((left, right) => left.fieldId.localeCompare(right.fieldId) || JSON.stringify(left.value).localeCompare(JSON.stringify(right.value)));
}

function exactRequestIdentity(request: EvidencePipelineRequest): request is EvidencePipelineRequest & {
  subject: EvidencePipelineRequest["subject"] & { modelId: string; variantId: string; revision: string };
} {
  const subject = request.subject;
  return [subject.skuId, subject.familyId, subject.modelId, subject.variantId, subject.revision].every((value) => typeof value === "string" && TOKEN.test(value));
}

export async function extractOfficialClaimsWithVendorAdapter(
  input: OfficialVendorClaimExtractorInput,
): Promise<OfficialVendorExtraction> {
  let manifest: EvidenceExtractionAdapterManifest | null = null;
  try {
    manifest = await evidenceVendorAdapterForSubject(input.request.subject);
    if (!manifest) return incomplete("official_identity_unresolved", input.request.requestedFieldIds,
      "No governed vendor/category extraction adapter matches the exact subject.");
    if (!exactRequestIdentity(input.request)) return incomplete("official_identity_unresolved", input.request.requestedFieldIds,
      "Exact model, variant, and revision identity is required before extraction.", manifest);
    const unsupported = input.request.requestedFieldIds.filter((fieldId) => !manifest!.supportedFieldIds.includes(fieldId));
    if (unsupported.length) return incomplete("official_page_found_field_missing", unsupported,
      "The governed adapter has no approved decoder for one or more requested fields.", manifest);
    const url = safeUrl(input.sourceUrl);
    if (!url || !officialHostMatches(url, manifest)) return incomplete("official_identity_unresolved", input.request.requestedFieldIds,
      "The evidence URL is outside the adapter's governed official host registry.", manifest);
    if (!DOCUMENT_ID.test(input.documentId) || !SHA256.test(input.documentSha256) || input.documentId !== `doc-sha256-${input.documentSha256}`
      || !CAPTURE_ID.test(input.captureId) || new Date(input.attemptedAt).toISOString() !== input.attemptedAt
      || !validateBoundedExcerpt(input.excerpt, input.documentId, input.documentSha256)) {
      return incomplete("official_parse_failed", input.request.requestedFieldIds,
        "The bounded excerpt is not closed over the immutable document/capture bytes.", manifest);
    }
    const excerpts = input.excerpt;
    const negative = pageFailure(excerpts.excerpts.map((entry) => entry.text).join(" "));
    if (negative) return incomplete(negative, input.request.requestedFieldIds,
      "The archived page is an access/error/series surface and cannot establish an exact product fact.", manifest);
    const identity = extractedIdentity(excerpts, manifest);
    const subject = input.request.subject;
    if (!identity || identity.model !== subject.modelId || identity.variant !== subject.variantId || identity.revision !== subject.revision
      || (subject.region !== undefined && identity.region !== subject.region)) {
      return incomplete("official_identity_unresolved", input.request.requestedFieldIds,
        "The bounded document body does not confirm the requested model, variant, revision, and region.", manifest);
    }
    const requested = new Set(input.request.requestedFieldIds);
    const extracted = extractValues(excerpts, manifest, requested);
    const valuesByField = new Map<string, Set<string>>();
    for (const item of extracted) {
      const valueType = factFieldPolicy(item.fieldId)?.valueType;
      // Structured fields (QVL entries, requirements, ports, package rows,
      // curves) and string sets are repeatable collections. Distinct scalar
      // statements for one exact-revision field are contradictory.
      if (!(["string", "number", "boolean"] as const).includes(valueType as "string" | "number" | "boolean")) continue;
      const values = valuesByField.get(item.fieldId) ?? new Set<string>();
      values.add(JSON.stringify([item.value, item.unit ?? null]));
      valuesByField.set(item.fieldId, values);
    }
    const conflicting = [...valuesByField.entries()]
      .filter(([, values]) => values.size > 1)
      .map(([fieldId]) => fieldId)
      .sort();
    if (conflicting.length) return incomplete("official_sources_conflict", conflicting,
      "Compare the conflicting official statements for the exact revision before activating a fact.", manifest,
      `The archived official evidence contains conflicting governed values for: ${conflicting.join(", ")}.`);
    const missing = input.request.requestedFieldIds.filter((fieldId) => !extracted.some((item) => item.fieldId === fieldId));
    if (missing.length) return incomplete("official_page_found_field_missing", missing,
      "One or more requested fields were absent or failed their exact governed value schema.", manifest);

    const selectedManifest = manifest;
    const claimCandidates: EvidenceClaimInput[] = extracted.map((item) => ({
      schemaVersion: "evidence-claim-v1",
      subject: {
        skuId: subject.skuId,
        familyId: subject.familyId,
        modelId: subject.modelId,
        variantId: subject.variantId,
        revision: subject.revision,
        ...(subject.region === undefined ? {} : { region: subject.region }),
      },
      scope: "revision",
      fieldId: item.fieldId,
      value: item.value,
      ...(item.unit === undefined ? {} : { unit: item.unit }),
      authority: "official",
      source: {
        documentId: input.documentId as `doc-sha256-${string}`,
        documentSha256: input.documentSha256,
        captureId: input.captureId as `capture-sha256-${string}`,
        locator: { page: item.page, section: selectedManifest.adapterId, field: item.fieldId, snippet: item.snippet },
      },
      retrievedAt: input.attemptedAt,
      status: "active",
    }));
    await Promise.all(claimCandidates.map((claim) => createEvidenceClaim(claim)));
    const confirmation = createOfficialDocumentIdentityConfirmation({
      authority: "official",
      documentSha256: input.documentSha256,
      pageKind: manifest.pageKind,
      scope: "revision",
      identity: {
        brand: subject.brand,
        skuId: subject.skuId,
        familyId: subject.familyId,
        modelId: subject.modelId,
        variantId: subject.variantId,
        revision: subject.revision,
        ...(subject.region === undefined ? {} : { region: subject.region }),
      },
      locator: { page: identity.page, section: "Product identity", excerpt: identity.excerpt },
      matchedTokens: { model: subject.modelId, variant: subject.variantId, revision: subject.revision },
      extractor: { id: manifest.adapterId, version: manifest.adapterVersion },
      confirmedAt: input.attemptedAt,
    });
    const officialPromotionInput: OfficialDocumentPromotionInput = {
      registryTrust: "trusted",
      documentSha256: input.documentSha256,
      requiredScope: "revision",
      expectedIdentity: {
        kind: "product",
        brand: subject.brand,
        skuId: subject.skuId,
        familyId: subject.familyId,
        modelId: subject.modelId,
        variantId: subject.variantId,
        revision: subject.revision,
        ...(subject.region === undefined ? {} : { region: subject.region }),
      },
      confirmation,
    };
    return deepFreeze({
      status: "completed",
      adapterId: manifest.adapterId,
      adapterVersion: manifest.adapterVersion,
      manifestRef: manifest.manifestRef,
      claimCandidates,
      officialPromotionInput,
      missingFieldIds: [],
    });
  } catch {
    return incomplete("official_parse_failed", input.request?.requestedFieldIds ?? [],
      "The governed vendor extractor failed closed; inspect the bounded archive manually.", manifest);
  }
}

export interface ThirdPartyAdapterAcquisition {
  readonly finalUrl: string;
  readonly sourceContentHash: string;
  readonly captureId: string;
  readonly retrievedAt: string;
  readonly boundedExcerpt: BoundedEvidenceExcerptSet;
  /** Content-addressed production artifact containing the approved source bytes. */
  readonly archiveArtifactRef?: `sha256:${string}`;
  readonly source: {
    readonly publisherId: string;
    readonly sourceType: "professional_measurement" | "professional_review" | "technical_database";
    readonly independenceGroupId: string;
    readonly editorialControl: "independent" | "vendor_controlled" | "unknown";
    readonly fundingDisclosure: "independent" | "sponsored" | "undisclosed";
  };
  readonly extractionContext: {
    readonly originalWorkId: string;
    readonly objectRevision: string;
    readonly testMethod: {
      readonly kind: "measurement" | "bench_test" | "documented_inspection" | "reported";
      readonly description: string;
      readonly sampleSize: number;
      readonly equipment?: readonly string[];
      readonly conditions?: readonly string[];
    };
  };
}

export interface ThirdPartyVendorClaimExtractorInput {
  readonly request: EvidencePipelineRequest;
  readonly acquisitions: readonly ThirdPartyAdapterAcquisition[];
  readonly assessedAt: string;
}

export interface ThirdPartyVendorExtraction {
  readonly claimCandidates: readonly EvidenceClaimInput[];
  readonly thirdPartySources: readonly ThirdPartyEvidenceSource[];
  readonly thirdPartyFindings: readonly ThirdPartyEvidenceFinding[];
  readonly assessedAt: string;
  readonly independenceAssessment: ThirdPartyIndependenceAssessment;
}

async function normalizedFindingHash(fieldId: string, value: unknown, unit: string | undefined): Promise<string> {
  return hashContent({
    schemaVersion: "artifact-payload-v1",
    artifactId: `third-party-finding:${fieldId}`,
    mediaType: "application/vnd.buildsim.third-party-finding+json",
    payload: { fieldId, value, ...(unit === undefined ? {} : { unit }) },
  }, { domain: "artifact", schemaVersion: "artifact-payload-v1" });
}

/**
 * Optional production seam for providers that already archived and bounded
 * each third-party source. Raw acquisition bytes alone are intentionally not
 * accepted here and can never fall through to the official promotion API.
 */
export async function extractThirdPartyClaimsWithVendorAdapter(
  input: ThirdPartyVendorClaimExtractorInput,
): Promise<ThirdPartyVendorExtraction> {
  const manifest = await evidenceVendorAdapterForSubject(input.request.subject);
  if (!manifest || !exactRequestIdentity(input.request) || !Array.isArray(input.acquisitions) || input.acquisitions.length < 1 || input.acquisitions.length > 8
    || new Date(input.assessedAt).toISOString() !== input.assessedAt) throw new TypeError("third-party adapter extraction input is invalid");
  const subject = input.request.subject;
  const sources: ThirdPartyEvidenceSource[] = [];
  const claims: EvidenceClaimInput[] = [];
  const findings: ThirdPartyEvidenceFinding[] = [];
  for (const acquisition of input.acquisitions) {
    if (!SHA256.test(acquisition.sourceContentHash) || !CAPTURE_ID.test(acquisition.captureId)
      || acquisition.extractionContext.objectRevision !== subject.revision
      || !validateBoundedExcerpt(acquisition.boundedExcerpt, `doc-sha256-${acquisition.sourceContentHash}`, acquisition.sourceContentHash)) {
      throw new TypeError("third-party source lacks exact revision bounded archive closure");
    }
    const values = extractValues(acquisition.boundedExcerpt, manifest, new Set(input.request.requestedFieldIds));
    if (input.request.requestedFieldIds.some((fieldId) => !values.some((value) => value.fieldId === fieldId))) {
      throw new TypeError("third-party bounded source does not establish every requested field");
    }
    const source = createThirdPartyEvidenceSource({
      authority: "third_party",
      sourceType: acquisition.source.sourceType,
      canonicalUrl: acquisition.finalUrl,
      publisherId: acquisition.source.publisherId,
      originalWorkId: acquisition.extractionContext.originalWorkId,
      independenceGroupId: acquisition.source.independenceGroupId,
      editorialControl: acquisition.source.editorialControl,
      fundingDisclosure: acquisition.source.fundingDisclosure,
      subject: {
        skuId: subject.skuId,
        familyId: subject.familyId,
        modelId: subject.modelId,
        variantId: subject.variantId,
        revision: subject.revision,
        ...(subject.region === undefined ? {} : { region: subject.region }),
      },
      objectRevision: acquisition.extractionContext.objectRevision,
      testMethod: acquisition.extractionContext.testMethod,
      sourceContentHash: acquisition.sourceContentHash,
      retrievedAt: acquisition.retrievedAt,
    });
    sources.push(source);
    for (const item of values) {
      const claim: EvidenceClaimInput = {
        schemaVersion: "evidence-claim-v1",
        subject: {
          skuId: subject.skuId,
          familyId: subject.familyId,
          modelId: subject.modelId,
          variantId: subject.variantId,
          revision: subject.revision,
          ...(subject.region === undefined ? {} : { region: subject.region }),
        },
        scope: "revision",
        fieldId: item.fieldId,
        value: item.value,
        ...(item.unit === undefined ? {} : { unit: item.unit }),
        authority: "third_party",
        source: {
          documentId: `doc-sha256-${acquisition.sourceContentHash}`,
          documentSha256: acquisition.sourceContentHash,
          captureId: acquisition.captureId as `capture-sha256-${string}`,
          locator: { page: item.page, section: manifest.adapterId, field: item.fieldId, snippet: item.snippet },
        },
        retrievedAt: acquisition.retrievedAt,
        status: "active",
      };
      await createEvidenceClaim(claim);
      claims.push(claim);
      findings.push({
        sourceId: source.sourceId,
        fieldId: item.fieldId,
        normalizedValueHash: await normalizedFindingHash(item.fieldId, item.value, item.unit),
        ...(item.unit === undefined ? {} : { unit: item.unit }),
      });
    }
  }
  const independenceAssessment = assessThirdPartySourceIndependence(sources, { findings, assessedAt: input.assessedAt });
  if (independenceAssessment.conflicted || independenceAssessment.confidence === "none") {
    throw new TypeError("third-party sources are conflicting or do not qualify independently");
  }
  return deepFreeze({
    claimCandidates: claims,
    thirdPartySources: sources,
    thirdPartyFindings: findings,
    assessedAt: input.assessedAt,
    independenceAssessment,
  });
}

export function thirdPartyFindingHashForTest(fieldId: string, value: unknown, unit?: string): Promise<string> {
  return normalizedFindingHash(fieldId, value, unit);
}
