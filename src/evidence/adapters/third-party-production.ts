import { createHash } from "node:crypto";
import { extractEvidenceExcerpts } from "../excerpts.mjs";
import type { EvidencePipelineRequest } from "../jobs/contracts";
import {
  extractThirdPartyClaimsWithVendorAdapter,
  type BoundedEvidenceExcerptEntry,
  type BoundedEvidenceExcerptSet,
  type ThirdPartyAdapterAcquisition,
  type ThirdPartyVendorExtraction,
} from "./extractor";
import { evidenceVendorAdapterForSubject, vendorAdapterSearchQueries } from "./registry";

const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_REF = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;
const TEXT_MEDIA_TYPE = /^(?:text\/|application\/(?:json|ld\+json|xml|xhtml\+xml)$)/;
const TEST_METHOD_KINDS = new Set(["measurement", "bench_test", "documented_inspection", "reported"]);
const THIRD_PARTY_METADATA_LABELS = Object.freeze([
  "Product Model:",
  "Product Variant:",
  "Product Revision:",
  "Product Region:",
  "Original Work ID:",
  "Object Revision:",
  "Test Method Kind:",
  "Test Method Description:",
  "Test Sample Size:",
  "Test Equipment:",
  "Test Conditions:",
] as const);

interface BuiltInThirdPartySourcePolicy {
  readonly publisherId: string;
  readonly sourceType: "professional_measurement" | "professional_review" | "technical_database";
  readonly independenceGroupId: string;
  readonly editorialControl: "independent" | "vendor_controlled" | "unknown";
  readonly fundingDisclosure: "independent" | "sponsored" | "undisclosed";
  readonly name?: string;
  readonly domains?: readonly string[];
  readonly enabled?: boolean;
  readonly approvedAt?: string;
}

/** Shape emitted by the built-in approved third-party acquisition service. */
export interface BuiltInThirdPartyAdapterAcquisition {
  readonly source: BuiltInThirdPartySourcePolicy;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly redirects: readonly string[];
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly sourceContentHash: string;
  readonly status?: number;
  readonly retrievedAt: string;
  readonly artifactRef: `sha256:${string}`;
  /** Present in production after the fenced EvidenceRepository archive. */
  readonly captureId?: `capture-sha256-${string}`;
}

export interface ProductionThirdPartyVendorClaimExtractorInput {
  readonly request: EvidencePipelineRequest;
  readonly acquisitions: readonly (ThirdPartyAdapterAcquisition | BuiltInThirdPartyAdapterAcquisition)[];
  readonly assessedAt: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim()
    && value === value.normalize("NFC") && !/[\u0000-\u001f\u007f]/.test(value);
}

function iso(value: unknown): value is string {
  try { return typeof value === "string" && new Date(value).toISOString() === value; } catch { return false; }
}

function canonicalUrl(value: unknown): value is string {
  try {
    if (typeof value !== "string" || value.length > 4_096) return false;
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && url.toString() === value;
  } catch { return false; }
}

function isGovernedAcquisition(value: unknown): value is ThirdPartyAdapterAcquisition {
  return record(value) && record(value.boundedExcerpt) && typeof value.captureId === "string" && record(value.extractionContext);
}

function assertBuiltInAcquisition(value: unknown): asserts value is BuiltInThirdPartyAdapterAcquisition {
  const allowed = [
    "source", "requestedUrl", "finalUrl", "redirects", "mediaType", "bytes", "sourceContentHash", "status", "retrievedAt", "artifactRef", "captureId",
  ];
  if (!record(value)) throw new TypeError("built-in third-party acquisition lacks immutable approved archive closure");
  const status = value.status;
  if (Object.keys(value).some((key) => !allowed.includes(key)) || !record(value.source)
    || !canonicalUrl(value.requestedUrl) || !canonicalUrl(value.finalUrl) || !Array.isArray(value.redirects)
    || value.redirects.length > 16 || value.redirects.some((url) => !canonicalUrl(url))
    || typeof value.mediaType !== "string" || (!TEXT_MEDIA_TYPE.test(value.mediaType) && value.mediaType !== "application/pdf")
    || (!(value.bytes instanceof Uint8Array) && !Buffer.isBuffer(value.bytes)) || value.bytes.byteLength < 1 || value.bytes.byteLength > 25_000_000
    || typeof value.sourceContentHash !== "string" || !SHA256.test(value.sourceContentHash)
    || (status !== undefined && (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status >= 300))
    || (value.captureId !== undefined && (typeof value.captureId !== "string" || !/^capture-sha256-[a-f0-9]{64}$/.test(value.captureId)))
    || createHash("sha256").update(value.bytes).digest("hex") !== value.sourceContentHash
    || !iso(value.retrievedAt) || typeof value.artifactRef !== "string" || !ARTIFACT_REF.test(value.artifactRef)) {
    throw new TypeError("built-in third-party acquisition lacks immutable approved archive closure");
  }
  const source = value.source;
  const sourceFields = [
    "publisherId", "name", "domains", "sourceType", "independenceGroupId", "editorialControl",
    "fundingDisclosure", "enabled", "approvedAt",
  ];
  if (Object.keys(source).some((key) => !sourceFields.includes(key)) || !sourceFields.every((key) => Object.prototype.hasOwnProperty.call(source, key))
    || !canonicalText(source.publisherId, 256) || !canonicalText(source.name, 256)
    || !Array.isArray(source.domains) || source.domains.length < 1 || source.domains.length > 16
    || source.domains.some((domain) => typeof domain !== "string" || domain !== domain.toLocaleLowerCase() || !domain.includes("."))
    || source.enabled !== true || !iso(source.approvedAt)
    || !["professional_measurement", "professional_review", "technical_database"].includes(String(source.sourceType))
    || !canonicalText(source.independenceGroupId, 256)
    || !["independent", "vendor_controlled", "unknown"].includes(String(source.editorialControl))
    || !["independent", "sponsored", "undisclosed"].includes(String(source.fundingDisclosure))) {
    throw new TypeError("built-in third-party source policy is invalid");
  }
}

function valueAfter(text: string, label: string, labels: readonly string[]): string | null {
  const offset = text.indexOf(label);
  if (offset < 0) return null;
  const start = offset + label.length;
  let end = text.length;
  for (const candidate of labels) {
    const next = text.indexOf(candidate, start);
    if (next >= 0 && next < end) end = next;
  }
  const value = text.slice(start, end).replace(/^…|…$/g, "").trim();
  return value || null;
}

function uniqueList(value: string | null, maximum: number): readonly string[] | undefined {
  if (value === null) return undefined;
  const items = value.split(",").map((item) => item.trim());
  if (items.length < 1 || items.length > maximum || items.some((item) => !canonicalText(item, 256)) || new Set(items).size !== items.length) {
    throw new TypeError("third-party test method list is invalid");
  }
  return Object.freeze(items);
}

function parseExtractionContext(
  excerpt: BoundedEvidenceExcerptSet,
  request: EvidencePipelineRequest,
  ruleLabels: readonly string[],
): ThirdPartyAdapterAcquisition["extractionContext"] {
  const labels = [...THIRD_PARTY_METADATA_LABELS, ...ruleLabels];
  const text = excerpt.excerpts.map((entry) => entry.text).join(" ");
  const model = valueAfter(text, "Product Model:", labels);
  const variant = valueAfter(text, "Product Variant:", labels);
  const revision = valueAfter(text, "Product Revision:", labels);
  const region = valueAfter(text, "Product Region:", labels);
  if (model !== request.subject.modelId || variant !== request.subject.variantId || revision !== request.subject.revision
    || (request.subject.region !== undefined && region !== request.subject.region)) {
    throw new TypeError("third-party body does not confirm the exact requested model/variant/revision");
  }
  const originalWorkId = valueAfter(text, "Original Work ID:", labels);
  const objectRevision = valueAfter(text, "Object Revision:", labels);
  const kind = valueAfter(text, "Test Method Kind:", labels);
  const description = valueAfter(text, "Test Method Description:", labels);
  const sampleSizeText = valueAfter(text, "Test Sample Size:", labels);
  if (!originalWorkId || !TOKEN.test(originalWorkId) || objectRevision !== revision || !kind || !TEST_METHOD_KINDS.has(kind)
    || !description || !canonicalText(description, 512) || !sampleSizeText || !/^[1-9]\d{0,5}$/.test(sampleSizeText)) {
    throw new TypeError("third-party body lacks a strict test-method/original-work closure");
  }
  const sampleSize = Number(sampleSizeText);
  const equipment = uniqueList(valueAfter(text, "Test Equipment:", labels), 32);
  const conditions = uniqueList(valueAfter(text, "Test Conditions:", labels), 32);
  return Object.freeze({
    originalWorkId,
    objectRevision,
    testMethod: Object.freeze({
      kind: kind as ThirdPartyAdapterAcquisition["extractionContext"]["testMethod"]["kind"],
      description,
      sampleSize,
      ...(equipment === undefined ? {} : { equipment }),
      ...(conditions === undefined ? {} : { conditions }),
    }),
  });
}

async function boundedExcerptFor(
  acquisition: BuiltInThirdPartyAdapterAcquisition,
  request: EvidencePipelineRequest,
): Promise<{ excerpt: BoundedEvidenceExcerptSet; ruleLabels: readonly string[] }> {
  const manifest = await evidenceVendorAdapterForSubject(request.subject);
  if (!manifest) throw new TypeError("no governed adapter exists for the third-party exact subject");
  const documentId = `doc-sha256-${acquisition.sourceContentHash}`;
  const repository = Object.freeze({
    getDocumentContent: async (id: string) => id === documentId ? {
      document: {
        id: documentId,
        sha256: acquisition.sourceContentHash,
        byteLength: acquisition.bytes.byteLength,
        mediaType: acquisition.mediaType,
      },
      bytes: Buffer.from(acquisition.bytes),
    } : null,
  });
  const queries = [
    "Product Model",
    "Original Work ID",
    "Test Method Kind",
    ...await vendorAdapterSearchQueries(request.subject, request.requestedFieldIds),
  ];
  const windows: BoundedEvidenceExcerptEntry[] = [];
  let truncated = false;
  let totalPages = 0;
  let searchedPageCount = 0;
  for (const query of [...new Set(queries)].slice(0, 32)) {
    const result = await extractEvidenceExcerpts(repository, documentId, { query, limit: 2 });
    truncated ||= result.truncated;
    totalPages = Math.max(totalPages, result.totalPages);
    searchedPageCount = Math.max(searchedPageCount, result.searchedPageCount);
    for (const entry of result.excerpts as BoundedEvidenceExcerptEntry[]) {
      if (!windows.some((prior) => prior.page === entry.page && prior.text === entry.text)) windows.push(entry);
    }
  }
  const excerpts = windows.slice(0, 8);
  if (!excerpts.length) throw new TypeError("third-party archive has no bounded governed excerpt");
  const excerpt: BoundedEvidenceExcerptSet = Object.freeze({
    schemaVersion: "1.0.0",
    documentId,
    contentHash: acquisition.sourceContentHash,
    mediaType: acquisition.mediaType,
    sourceByteLength: acquisition.bytes.byteLength,
    query: "governed third-party adapter query set",
    totalPages,
    searchedPageCount,
    extractionMode: acquisition.mediaType === "application/pdf" ? "pdf-text-layer" : "utf8-text",
    contentTrust: "untrusted-evidence-text",
    returned: excerpts.length,
    excerpts: Object.freeze(excerpts),
    truncated: truncated || windows.length > excerpts.length || excerpts.some((entry) => entry.truncated),
  });
  return { excerpt, ruleLabels: manifest.rules.map((rule) => rule.label) };
}

async function captureIdFor(acquisition: BuiltInThirdPartyAdapterAcquisition): Promise<`capture-sha256-${string}`> {
  const material = JSON.stringify({
    schemaVersion: "third-party-artifact-capture-v1",
    artifactRef: acquisition.artifactRef,
    finalUrl: acquisition.finalUrl,
    publisherId: acquisition.source.publisherId,
    sourceContentHash: acquisition.sourceContentHash,
    retrievedAt: acquisition.retrievedAt,
  });
  return `capture-sha256-${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

export async function prepareBuiltInThirdPartyAdapterAcquisition(
  acquisition: BuiltInThirdPartyAdapterAcquisition,
  request: EvidencePipelineRequest,
): Promise<ThirdPartyAdapterAcquisition> {
  assertBuiltInAcquisition(acquisition);
  const { excerpt, ruleLabels } = await boundedExcerptFor(acquisition, request);
  const extractionContext = parseExtractionContext(excerpt, request, ruleLabels);
  return Object.freeze({
    finalUrl: acquisition.finalUrl,
    sourceContentHash: acquisition.sourceContentHash,
    captureId: acquisition.captureId ?? await captureIdFor(acquisition),
    retrievedAt: acquisition.retrievedAt,
    boundedExcerpt: excerpt,
    source: Object.freeze({
      publisherId: acquisition.source.publisherId,
      sourceType: acquisition.source.sourceType,
      independenceGroupId: acquisition.source.independenceGroupId,
      editorialControl: acquisition.source.editorialControl,
      fundingDisclosure: acquisition.source.fundingDisclosure,
    }),
    extractionContext,
    archiveArtifactRef: acquisition.artifactRef,
  });
}

/**
 * Production-facing seam. Built-in acquisitions are converted from immutable
 * approved bytes; revision and test-method metadata must be present in the
 * bounded body and are never copied from the request.
 */
export async function extractProductionThirdPartyClaimsWithVendorAdapter(
  input: ProductionThirdPartyVendorClaimExtractorInput,
): Promise<ThirdPartyVendorExtraction> {
  if (!Array.isArray(input.acquisitions) || input.acquisitions.length < 1 || input.acquisitions.length > 8) {
    throw new TypeError("third-party production acquisitions are invalid");
  }
  const acquisitions = await Promise.all(input.acquisitions.map((acquisition) => isGovernedAcquisition(acquisition)
    ? acquisition : prepareBuiltInThirdPartyAdapterAcquisition(acquisition, input.request)));
  return extractThirdPartyClaimsWithVendorAdapter({ request: input.request, acquisitions, assessedAt: input.assessedAt });
}
