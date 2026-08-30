import { discoverOfficialDocumentLinks } from "../../../src/evidence/discovery.mjs";
import { acquireOfficialEvidence } from "../../../src/evidence/acquire.mjs";
import { createEvidenceBindingProposalRuntime } from "../../../src/evidence/binding-proposal-runtime.mjs";
import {
  extractDerivedEvidenceExcerpts,
  extractEvidenceExcerpts,
} from "../../../src/evidence/excerpts.mjs";
import {
  extractOcrProduction,
  inspectPdfProduction,
} from "../../../src/attachments/production-inspection-runtime.mjs";
import {
  createEvidenceSearchAttempt,
  createEvidenceSearchOutcome,
} from "../../../src/evidence/search-outcome.mjs";
import { registryForBrand } from "../catalog/registry.mjs";
import { acquireThirdPartyEvidenceBatch } from "./third-party-batch.mjs";
import { resolveThirdPartyRegistry } from "./third-party-registry.mjs";

const OFFICIAL_FAILURE_RESULT = Object.freeze({
  official_not_published: "not_published",
  official_page_found_field_missing: "field_missing",
  official_identity_unresolved: "identity_unresolved",
  official_access_blocked: "access_blocked",
  official_parse_failed: "parse_failed",
  official_sources_conflict: "sources_conflict",
  official_search_exhausted: "exhausted",
});

const DEFAULT_EVIDENCE_OCR_LIMITS = Object.freeze({
  maxBytes: 25_000_000,
  maxWidthPixels: 16_384,
  maxHeightPixels: 16_384,
  maxPixels: 40_000_000,
  maxPages: 64,
  maxDecodedBytes: 160 * 1024 * 1024,
  maxDecompressionRatio: 200,
  maxExtractedTextBytes: 64 * 1024,
  processingTimeoutMs: 15_000,
});

const OCR_ARTIFACT_MEDIA_TYPE = "application/vnd.buildsim.evidence-ocr+json";
const ARTIFACT_REF = /^sha256:([a-f0-9]{64})$/;

export class ProductionEvidenceServiceError extends Error {
  constructor(code, message, options = {}) {
    super(String(message).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 500));
    this.name = "ProductionEvidenceServiceError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.offline = options.offline === true;
    this.retryAt = options.retryAt;
  }
}

function bounded(value, maximum = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function evidenceOcrLimits(options) {
  const limits = { ...DEFAULT_EVIDENCE_OCR_LIMITS, ...(options.evidenceOcrLimits ?? {}) };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`evidence OCR limit ${key} must be a positive integer`);
  }
  return Object.freeze(limits);
}

async function withOcrDeadline(limits, operation) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProductionEvidenceServiceError("official_ocr_timeout", "Bounded PDF/OCR inspection timed out"));
        }, limits.processingTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateOcrPages(value, pageCount, limits) {
  if (!Array.isArray(value) || value.length !== pageCount || value.length < 1 || value.length > limits.maxPages) {
    throw new ProductionEvidenceServiceError("official_ocr_invalid", "Bounded OCR returned an invalid page set");
  }
  let textBytes = 0;
  const pages = value.map((page, index) => {
    if (!page || typeof page !== "object" || Array.isArray(page) || page.num !== index + 1
      || typeof page.text !== "string" || !Number.isFinite(page.confidence) || page.confidence < 0 || page.confidence > 1) {
      throw new ProductionEvidenceServiceError("official_ocr_invalid", "Bounded OCR returned invalid page data");
    }
    textBytes += Buffer.byteLength(page.text, "utf8");
    if (textBytes > limits.maxExtractedTextBytes) {
      throw new ProductionEvidenceServiceError("official_ocr_text_too_large", "Bounded OCR text exceeds its artifact limit");
    }
    return Object.freeze({ num: page.num, text: page.text, confidence: page.confidence });
  });
  if (!pages.some((page) => page.text.trim().length > 0)) {
    throw new ProductionEvidenceServiceError("official_ocr_text_unavailable", "Bounded OCR found no reviewable text");
  }
  return Object.freeze(pages);
}

function parseOcrArtifact(artifact, expected) {
  const match = ARTIFACT_REF.exec(String(expected.ref ?? ""));
  if (!match || !artifact || artifact.record?.ref !== expected.ref
    || artifact.record.kind !== "evidence-ocr-text" || artifact.record.mediaType !== OCR_ARTIFACT_MEDIA_TYPE
    || artifact.record.privacyClass !== "runtime_internal" || artifact.record.byteLength !== artifact.bytes.byteLength
    || !Array.isArray(artifact.record.references) || artifact.record.references.length !== 1
    || artifact.record.references[0]?.ref !== expected.archiveArtifactRef
    || artifact.record.references[0]?.necessity !== "required_for_replay") {
    throw new ProductionEvidenceServiceError("official_ocr_artifact_invalid", "Bounded OCR artifact authority is unavailable");
  }
  let value;
  try { value = JSON.parse(Buffer.from(artifact.bytes).toString("utf8")); }
  catch { throw new ProductionEvidenceServiceError("official_ocr_artifact_invalid", "Bounded OCR artifact is not valid JSON"); }
  const allowed = [
    "schemaVersion", "documentId", "documentSha256", "sourceMediaType", "sourceByteLength", "extractionMode",
    "pages", "averageConfidence", "contentTrust",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))
    || value.schemaVersion !== "evidence-ocr-text-v1" || value.documentId !== expected.documentId
    || value.documentSha256 !== expected.documentSha256 || value.sourceMediaType !== "application/pdf"
    || value.extractionMode !== "pdf-local-ocr" || value.contentTrust !== "untrusted-evidence-ocr"
    || value.sourceByteLength !== expected.sourceByteLength
    || !Number.isFinite(value.averageConfidence) || value.averageConfidence < 0 || value.averageConfidence > 1) {
    throw new ProductionEvidenceServiceError("official_ocr_artifact_invalid", "Bounded OCR artifact binding is invalid");
  }
  const pages = validateOcrPages(value.pages, value.pages?.length, expected.limits);
  const average = pages.reduce((sum, page) => sum + page.confidence, 0) / pages.length;
  if (average !== value.averageConfidence) {
    throw new ProductionEvidenceServiceError("official_ocr_artifact_invalid", "Bounded OCR artifact confidence binding is invalid");
  }
  return { value, contentHash: match[1] };
}

function prior(context, stage) {
  return [...context.priorResults].reverse().find((result) => result.stage === stage) ?? null;
}

function exactProductIdentity(subject) {
  return {
    brand: subject.brand,
    basis: "governed-sku-user-asserted",
    skuId: subject.skuId,
    familyId: subject.familyId,
    ...(subject.modelId ? { model: subject.modelId, modelId: subject.modelId } : {}),
    ...(subject.variantId ? { variantId: subject.variantId } : {}),
    ...(subject.revision ? { revision: subject.revision } : {}),
    ...(subject.region ? { region: subject.region } : {}),
  };
}

function scopeFor(subject) {
  if (subject.variantId && subject.revision) return "revision";
  if (subject.variantId) return "variant";
  return "model";
}

function placeholderOfficialUrl(context) {
  if (context.request.entry.kind === "official_url") return context.request.entry.url;
  return "https://evidence.invalid/unresolved-official-source";
}

async function failureOutcome(context, input) {
  const reason = Object.hasOwn(OFFICIAL_FAILURE_RESULT, input.reason) ? input.reason : "official_search_exhausted";
  let evidenceRefs = [...new Set(input.evidenceRefs ?? [])].sort();
  const required = reason === "official_sources_conflict" ? 2
    : ["official_page_found_field_missing", "official_identity_unresolved", "official_parse_failed"].includes(reason) ? 1 : 0;
  while (evidenceRefs.length < required) {
    const audit = await context.putArtifact({
      kind: "evidence-official-search-audit",
      bytes: Buffer.from(JSON.stringify({
        schemaVersion: "official-search-audit-v1",
        reason,
        sequence: evidenceRefs.length,
        detail: bounded(input.detail),
      }), "utf8"),
      mediaType: "application/json",
      privacyClass: "runtime_internal",
      references: evidenceRefs,
    });
    evidenceRefs = [...evidenceRefs, audit.ref].sort();
  }
  const attemptedAt = context.attemptStartedAt;
  const attempt = createEvidenceSearchAttempt({
    authority: "official",
    stage: input.stage,
    result: OFFICIAL_FAILURE_RESULT[reason],
    officialUrl: input.officialUrl ?? placeholderOfficialUrl(context),
    evidenceRefs,
    ...(input.errorCode ? { errorCode: bounded(input.errorCode, 160) } : {}),
    detail: bounded(input.detail, 1_000) || "Official evidence stage did not establish the requested field.",
    attemptedAt,
  });
  const searchOutcome = createEvidenceSearchOutcome({
    subject: {
      kind: "product",
      skuId: context.request.subject.skuId,
      familyId: context.request.subject.familyId,
      ...(context.request.subject.modelId ? { modelId: context.request.subject.modelId } : {}),
      ...(context.request.subject.variantId ? { variantId: context.request.subject.variantId } : {}),
      ...(context.request.subject.revision ? { revision: context.request.subject.revision } : {}),
      ...(context.request.subject.region ? { region: context.request.subject.region } : {}),
    },
    field: context.request.requestedFieldIds[0],
    attempts: [attempt],
    exhaustive: input.exhaustive === true,
    detail: bounded(input.detail, 1_500) || "Official evidence is unavailable.",
    manualAction: bounded(input.manualAction, 1_000) || "Confirm the exact product revision and provide a reviewed source.",
    searchedAt: attemptedAt,
  });
  return {
    status: "needs_review",
    output: {
      searchOutcome,
      manualAction: searchOutcome.manualAction,
      evidenceRefs,
    },
    resultRefs: evidenceRefs,
    officialSearchReason: searchOutcome.reason,
  };
}

export function createEvidenceDomainRateLimiter(options = {}) {
  const minimumIntervalMs = options.minimumIntervalMs ?? 250;
  if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 0 || minimumIntervalMs > 60_000) {
    throw new TypeError("evidence domain rate limit is invalid");
  }
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  // Operational throttle only; durable job/checkpoint state remains the sole
  // authority. Losing this cache can delay less, never authorize a result.
  const nextAt = new Map();
  return Object.freeze({
    async acquire(key) {
      const current = Number(now());
      const allowedAt = Math.max(current, nextAt.get(key) ?? current);
      nextAt.set(key, allowedAt + minimumIntervalMs);
      if (allowedAt > current) await wait(allowedAt - current);
    },
  });
}

function retryable(error, fallbackCode) {
  if (error?.offline === true) return new ProductionEvidenceServiceError(fallbackCode, "Evidence network is offline", { offline: true });
  const message = bounded(error?.message ?? error, 300);
  const offline = /ENETUNREACH|EAI_AGAIN|network is unreachable|offline/i.test(message);
  return new ProductionEvidenceServiceError(fallbackCode, `${fallbackCode.replaceAll("_", " ")}: ${message}`, {
    offline,
    retryable: !offline,
  });
}

function transientEvidenceError(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  return /(?:fetch_failed|timeout|temporar|rate_limit|service_unavailable)/i.test(code)
    || /ENETUNREACH|EAI_AGAIN|ECONNRESET|ETIMEDOUT|network is unreachable|offline|temporar(?:y|ily)/i.test(message);
}

async function ensureOnline(options) {
  const online = await (options.online ?? (() => false))();
  if (!online) throw new ProductionEvidenceServiceError("network_offline", "Evidence network is offline", { offline: true });
}

function officialStartUrl(request, registry) {
  if (request.entry.kind === "official_url") return request.entry.url;
  const entry = registryForBrand(request.subject.brand, registry);
  if (!entry || entry.trustStatus !== "trusted" || entry.search?.kind !== "site-search" || !entry.search.urlTemplate.includes("{query}")) return null;
  return entry.search.urlTemplate.replace("{query}", encodeURIComponent(request.entry.query));
}

function claimsFrom(context) {
  const official = prior(context, "claim_extraction");
  const thirdParty = prior(context, "third_party_fallback");
  const output = official?.status === "completed" ? official.output : thirdParty?.status === "completed" ? thirdParty.output : null;
  return Array.isArray(output?.claimCandidates) ? output.claimCandidates : [];
}

function normalizedOfficialExtractionFailure(value, requestedFieldIds) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.status !== "needs_review"
    || !Object.hasOwn(OFFICIAL_FAILURE_RESULT, value.reason) || !Array.isArray(value.claimCandidates)
    || value.claimCandidates.length !== 0 || !Array.isArray(value.missingFieldIds)
    || value.missingFieldIds.length > 256 || typeof value.manualAction !== "string") return null;
  const requested = new Set(requestedFieldIds);
  const missingFieldIds = [...value.missingFieldIds];
  if (missingFieldIds.some((fieldId) => typeof fieldId !== "string" || !requested.has(fieldId))
    || new Set(missingFieldIds).size !== missingFieldIds.length
    || missingFieldIds.some((fieldId, index) => index > 0 && missingFieldIds[index - 1].localeCompare(fieldId) >= 0)) return null;
  const manualAction = bounded(value.manualAction, 1_000);
  const detail = value.detail === undefined ? "" : bounded(value.detail, 1_000);
  if (!manualAction || (value.detail !== undefined && !detail)) return null;
  return Object.freeze({ reason: value.reason, missingFieldIds, manualAction, detail });
}

function stageForOfficialFailure(reason) {
  if (reason === "official_sources_conflict") return "comparison";
  if (reason === "official_page_found_field_missing") return "field_lookup";
  if (reason === "official_identity_unresolved") return "identity";
  if (reason === "official_access_blocked" || reason === "official_parse_failed") return "parse";
  return "discovery";
}

/** Real production stage services. Test seams are constructor-only and never read from transport payloads. */
export function createProductionEvidenceStageServices(options) {
  if (!options?.evidenceRepository) throw new TypeError("production evidence services require FileEvidenceRepository");
  const limiter = options.rateLimiter ?? createEvidenceDomainRateLimiter(options.rateLimitOptions);
  const ocrLimits = evidenceOcrLimits(options);
  const thirdPartyRegistry = resolveThirdPartyRegistry(options.thirdPartyRegistry);
  const officialRegistry = options.officialRegistry;
  const evidenceRepository = (context) => options.evidenceRepositoryForContext?.(context) ?? options.evidenceRepository;

  return Object.freeze({
    async officialDiscovery(context) {
      const startUrl = officialStartUrl(context.request, officialRegistry);
      if (!startUrl) return failureOutcome(context, {
        stage: "identity",
        reason: "official_identity_unresolved",
        detail: `No trusted official registry/search entry exists for ${context.request.subject.brand}.`,
        manualAction: "Submit the manufacturer domain for review or provide an explicit trusted official URL.",
      });
      await ensureOnline(options);
      await limiter.acquire(new URL(startUrl).origin);
      try {
        const result = await discoverOfficialDocumentLinks(startUrl, {
          ...(options.officialFetcher ? { fetcher: options.officialFetcher } : {}),
          queryTokens: [context.request.subject.brand, context.request.subject.modelId, context.request.subject.variantId,
            context.request.subject.revision, ...context.request.requestedFieldIds].filter(Boolean),
          limit: 8,
          followPageLimit: 2,
          fetchOptions: options.fetchOptions,
        });
        const candidate = result.candidates[0];
        if (!candidate) return failureOutcome(context, {
          stage: "discovery",
          reason: result.officialFailure?.reason ?? "official_search_exhausted",
          detail: result.officialFailure?.detail ?? "Official discovery returned no usable document.",
          manualAction: result.officialFailure?.manualAction,
          officialUrl: startUrl,
          exhaustive: true,
        });
        return {
          status: "completed",
          output: {
            candidateUrl: candidate.url,
            mediaTypeHint: candidate.mediaTypeHint,
            kindHint: candidate.kindHint,
            officialBrand: result.officialBrand,
          },
        };
      } catch (error) {
        if (transientEvidenceError(error)) throw retryable(error, "official_discovery_failed");
        if (error?.reason) return failureOutcome(context, {
          stage: "discovery", reason: error.reason, detail: error.message, manualAction: error.manualAction,
          officialUrl: startUrl, errorCode: error.code,
        });
        throw retryable(error, "official_discovery_failed");
      }
    },

    async officialAcquire(context) {
      await ensureOnline(options);
      const discovery = prior(context, "official_discovery");
      const url = discovery?.output?.candidateUrl;
      if (typeof url !== "string") throw new ProductionEvidenceServiceError("official_candidate_missing", "Official acquisition candidate is missing");
      await limiter.acquire(new URL(url).origin);
      try {
        const result = await acquireOfficialEvidence(url, {
          // Acquisition is a durable side effect. Production composition
          // supplies a context-bound repository whose import is fenced by the
          // current job revision, lease and runtime generation.
          repository: evidenceRepository(context),
          ...(options.officialFetcher ? { fetcher: options.officialFetcher } : {}),
          clock: () => new Date(context.attemptStartedAt),
          cacheTtlMs: options.cacheTtlMs ?? 86_400_000,
          maxBytes: options.maxBytes ?? 25_000_000,
          fetchOptions: options.fetchOptions,
          kind: discovery.output.kindHint ?? "manufacturer-manual",
          title: `Archived official document for ${context.request.subject.skuId}`,
          officialBrand: context.request.subject.brand,
          productIdentities: [exactProductIdentity(context.request.subject)],
          requiredIdentityScope: scopeFor(context.request.subject),
        });
        return {
          status: "completed",
          output: {
            documentId: result.document.id,
            documentSha256: result.document.sha256,
            captureId: result.capture.id,
            sourceUrl: result.capture.canonicalUrl,
            mediaType: result.document.mediaType,
            reusedDocument: result.reusedDocument,
            reusedCapture: result.reusedCapture,
          },
        };
      } catch (error) {
        if (transientEvidenceError(error)) throw retryable(error, "official_acquisition_failed");
        if (error?.reason) return failureOutcome(context, {
          stage: "acquisition", reason: error.reason, detail: error.message, manualAction: error.manualAction,
          officialUrl: url, errorCode: error.code,
        });
        throw retryable(error, "official_acquisition_failed");
      }
    },

    async archive(context) {
      const acquisition = prior(context, "official_acquisition");
      const documentId = acquisition?.output?.documentId;
      const content = typeof documentId === "string" ? await evidenceRepository(context).getDocumentContent(documentId) : null;
      if (!content) throw new ProductionEvidenceServiceError("official_archive_missing", "Acquired official evidence archive is unavailable");
      const artifact = await context.putArtifact({
        kind: "evidence-official-document",
        bytes: content.bytes,
        mediaType: content.document.mediaType,
        privacyClass: "public_source",
      });
      return {
        status: "completed",
        output: {
          archiveArtifactRef: artifact.ref,
          documentId: content.document.id,
          documentSha256: content.document.sha256,
          captureId: acquisition.output.captureId,
          sourceUrl: acquisition.output.sourceUrl,
          mediaType: content.document.mediaType,
        },
        resultRefs: [artifact.ref],
      };
    },

    async parseOrOcr(context) {
      const archive = prior(context, "archive");
      const mediaType = String(archive?.output?.mediaType ?? "").toLocaleLowerCase();
      if (mediaType.startsWith("text/") || mediaType.includes("json") || mediaType.includes("xml")) {
        return { status: "completed", output: { documentId: archive.output.documentId, parseMode: "bounded_excerpt_parser" } };
      }
      if (mediaType === "application/pdf") {
        const content = await evidenceRepository(context).getDocumentContent(archive?.output?.documentId);
        if (!content || content.document.sha256 !== archive.output.documentSha256 || content.document.mediaType !== "application/pdf") {
          throw new ProductionEvidenceServiceError("official_archive_missing", "Archived PDF authority is unavailable for bounded parsing");
        }
        try {
          const parsed = await withOcrDeadline(ocrLimits, async (signal) => {
            const inspected = await inspectPdfProduction({
              bytes: Buffer.from(content.bytes), mediaType: "application/pdf", extractText: true, signal, limits: ocrLimits,
            });
            if (typeof inspected.text === "string" && inspected.text.trim().length > 0) {
              return { mode: "text", pageCount: inspected.pageCount };
            }
            const ocr = await extractOcrProduction({
              bytes: Buffer.from(content.bytes), mediaType: "application/pdf", signal, limits: ocrLimits,
            });
            return {
              mode: "ocr",
              pageCount: inspected.pageCount,
              pages: validateOcrPages(ocr.pages, inspected.pageCount, ocrLimits),
              confidence: ocr.confidence ?? 0,
            };
          });
          if (parsed.mode === "text") return {
            status: "completed",
            output: { documentId: archive.output.documentId, parseMode: "bounded_pdf_text_layer", pageCount: parsed.pageCount },
          };
          const ocrPayload = Object.freeze({
            schemaVersion: "evidence-ocr-text-v1",
            documentId: content.document.id,
            documentSha256: content.document.sha256,
            sourceMediaType: "application/pdf",
            sourceByteLength: content.document.byteLength,
            extractionMode: "pdf-local-ocr",
            pages: parsed.pages,
            averageConfidence: parsed.confidence,
            contentTrust: "untrusted-evidence-ocr",
          });
          const artifact = await context.putArtifact({
            kind: "evidence-ocr-text",
            bytes: Buffer.from(JSON.stringify(ocrPayload), "utf8"),
            mediaType: OCR_ARTIFACT_MEDIA_TYPE,
            privacyClass: "runtime_internal",
            references: [archive.output.archiveArtifactRef],
          });
          await options.evidenceOcrFaultInjector?.({
            point: "after_ocr_artifact",
            artifactRef: artifact.ref,
            created: artifact.created,
          });
          return {
            status: "completed",
            output: {
              documentId: archive.output.documentId,
              parseMode: "bounded_pdf_local_ocr",
              pageCount: parsed.pageCount,
              ocrArtifactRef: artifact.ref,
            },
            resultRefs: [artifact.ref],
          };
        } catch (error) {
          if (error instanceof ProductionEvidenceServiceError && error.retryable) throw error;
          return failureOutcome(context, {
            stage: "parse",
            reason: "official_parse_failed",
            detail: `Bounded local PDF/OCR inspection failed: ${bounded(error?.message ?? error, 300)}`,
            manualAction: "Inspect the archived PDF manually or provide a smaller readable text-layer PDF.",
            officialUrl: archive?.output?.sourceUrl,
            evidenceRefs: [archive?.output?.archiveArtifactRef].filter(Boolean),
            errorCode: error?.code,
          });
        }
      }
      return {
        status: "needs_review",
        output: {
          reason: "ocr_not_implemented_for_media_type",
          mediaType,
          manualAction: "Provide a reviewed text/PDF source or run an approved bounded OCR adapter.",
        },
      };
    },

    async excerpt(context) {
      const archive = prior(context, "archive");
      const parsed = prior(context, "parse_ocr");
      const query = context.request.requestedFieldIds.join(" ").slice(0, 160);
      try {
        const excerptRequest = { query: query.length >= 2 ? query : "hardware specification", limit: 8 };
        let excerpts;
        let ocrArtifactRef;
        if (parsed?.output?.parseMode === "bounded_pdf_local_ocr") {
          ocrArtifactRef = parsed.output.ocrArtifactRef;
          if (!options.artifactRepository || typeof options.artifactRepository.get !== "function") {
            throw new ProductionEvidenceServiceError("official_ocr_artifact_invalid", "OCR artifact repository is unavailable");
          }
          const source = await evidenceRepository(context).getDocumentContent(archive.output.documentId);
          if (!source || source.document.sha256 !== archive.output.documentSha256 || source.document.mediaType !== "application/pdf") {
            throw new ProductionEvidenceServiceError("official_ocr_artifact_invalid", "OCR source document authority is unavailable");
          }
          const artifact = await options.artifactRepository.get(ocrArtifactRef);
          const validated = parseOcrArtifact(artifact, {
            ref: ocrArtifactRef,
            documentId: archive.output.documentId,
            documentSha256: archive.output.documentSha256,
            sourceByteLength: source.document.byteLength,
            archiveArtifactRef: archive.output.archiveArtifactRef,
            limits: ocrLimits,
          });
          excerpts = extractDerivedEvidenceExcerpts({
            documentId: validated.value.documentId,
            contentHash: validated.value.documentSha256,
            mediaType: validated.value.sourceMediaType,
            sourceByteLength: validated.value.sourceByteLength,
            pages: validated.value.pages,
            derivedArtifactRef: ocrArtifactRef,
            derivedContentHash: validated.contentHash,
          }, excerptRequest, options.excerptOptions);
        } else {
          excerpts = await extractEvidenceExcerpts(
            evidenceRepository(context), archive.output.documentId, excerptRequest, options.excerptOptions,
          );
        }
        const artifact = await context.putArtifact({
          kind: "evidence-bounded-excerpts",
          bytes: Buffer.from(JSON.stringify(excerpts), "utf8"),
          mediaType: "application/json",
          privacyClass: "runtime_internal",
          references: [archive.output.archiveArtifactRef, ocrArtifactRef].filter(Boolean),
        });
        if (!excerpts.returned) return failureOutcome(context, {
          stage: "field_lookup",
          reason: "official_page_found_field_missing",
          detail: "The archived official document did not contain a bounded match for the requested fields.",
          manualAction: "Inspect the exact document section or provide a page locator.",
          officialUrl: archive.output.sourceUrl,
          evidenceRefs: [archive.output.archiveArtifactRef, ocrArtifactRef, artifact.ref].filter(Boolean),
        });
        return {
          status: "completed",
          output: { excerptArtifactRef: artifact.ref, returned: excerpts.returned, documentId: archive.output.documentId },
          resultRefs: [artifact.ref],
        };
      } catch (error) {
        return failureOutcome(context, {
          stage: "parse", reason: error?.reason ?? "official_parse_failed", detail: error?.message,
          manualAction: error?.manualAction ?? "Inspect the archived document manually; no OCR result was fabricated.",
          officialUrl: archive?.output?.sourceUrl,
          evidenceRefs: [archive?.output?.archiveArtifactRef, parsed?.output?.ocrArtifactRef].filter(Boolean),
          errorCode: error?.code,
        });
      }
    },

    async extractClaims(context) {
      const excerpt = prior(context, "excerpt");
      const archive = prior(context, "archive");
      if (!options.officialClaimExtractor) return failureOutcome(context, {
        stage: "field_lookup",
        reason: "official_page_found_field_missing",
        detail: "No approved exact-identity claim extractor is configured for these fields.",
        manualAction: "Review the bounded excerpts and approve a category adapter/extractor before creating claims.",
        officialUrl: archive?.output?.sourceUrl,
        evidenceRefs: [archive?.output?.archiveArtifactRef, excerpt?.output?.excerptArtifactRef].filter(Boolean),
      });
      const excerptArtifact = await options.artifactRepository.get(excerpt.output.excerptArtifactRef);
      if (!excerptArtifact) throw new ProductionEvidenceServiceError("excerpt_artifact_missing", "Bounded excerpt artifact is unavailable");
      const extracted = await options.officialClaimExtractor({
        request: context.request,
        excerpt: JSON.parse(Buffer.from(excerptArtifact.bytes).toString("utf8")),
        documentId: archive.output.documentId,
        documentSha256: archive.output.documentSha256,
        captureId: archive.output.captureId,
        sourceUrl: archive.output.sourceUrl,
        attemptedAt: context.attemptStartedAt,
      });
      if (extracted?.status === "needs_review") {
        const failure = normalizedOfficialExtractionFailure(extracted, context.request.requestedFieldIds);
        if (!failure) return failureOutcome(context, {
          stage: "parse",
          reason: "official_parse_failed",
          detail: "The governed official extractor returned a malformed review result.",
          manualAction: "Inspect the bounded archive manually and repair the governed extractor before retrying.",
          officialUrl: archive.output.sourceUrl,
          evidenceRefs: [archive.output.archiveArtifactRef, excerpt.output.excerptArtifactRef],
        });
        return failureOutcome(context, {
          stage: stageForOfficialFailure(failure.reason),
          reason: failure.reason,
          detail: failure.detail || (failure.missingFieldIds.length
            ? `The governed extractor could not establish: ${failure.missingFieldIds.join(", ")}.`
            : "The governed extractor could not establish the requested official fact."),
          manualAction: failure.manualAction,
          officialUrl: archive.output.sourceUrl,
          evidenceRefs: [archive.output.archiveArtifactRef, excerpt.output.excerptArtifactRef],
        });
      }
      if (!extracted?.claimCandidates?.length || !extracted.officialPromotionInput) return failureOutcome(context, {
        stage: "identity", reason: "official_identity_unresolved", detail: "Extractor did not close exact document identity.",
        manualAction: "Review model, variant and revision tokens in the archived document body.",
        officialUrl: archive.output.sourceUrl,
        evidenceRefs: [archive.output.archiveArtifactRef, excerpt.output.excerptArtifactRef],
      });
      // Only governed claim inputs and the promotion proof cross the job
      // boundary. Extractor diagnostics/body fragments must remain in bounded
      // artifacts or service-local memory, never in the durable job payload.
      return { status: "completed", output: {
        claimCandidates: extracted.claimCandidates,
        officialPromotionInput: extracted.officialPromotionInput,
      } };
    },

    async thirdPartyFallback(context) {
      const official = prior(context, "claim_extraction");
      const searchOutcome = official?.output?.searchOutcome;
      if (!options.thirdPartyDiscovery) return {
        status: "needs_review",
        output: {
          ...(searchOutcome ? { searchOutcome } : {}),
          reason: "third_party_discovery_not_configured",
          manualAction: "Configure a governed professional-source registry/discovery provider or supply official evidence.",
        },
        ...(official?.officialSearchReason ? { officialSearchReason: official.officialSearchReason } : {}),
      };
      await ensureOnline(options);
      let candidates;
      try {
        candidates = await options.thirdPartyDiscovery({ request: context.request, registry: thirdPartyRegistry });
      } catch (error) { throw retryable(error, "third_party_discovery_failed"); }
      let fetched;
      try {
        // The complete approved batch is fetched and validated before the
        // first local side effect. A second-source offline/failure therefore
        // reaches handler.pauseOffline with zero partial artifacts/captures.
        fetched = await acquireThirdPartyEvidenceBatch(candidates ?? [], {
          registry: thirdPartyRegistry,
          ...(options.thirdPartyFetcher ? { fetcher: options.thirdPartyFetcher } : {}),
          ...(options.thirdPartyMaxBytes === undefined ? {} : { maxBytes: options.thirdPartyMaxBytes }),
          ...(options.thirdPartyTimeoutMs === undefined ? {} : { timeoutMs: options.thirdPartyTimeoutMs }),
          retrievedAt: context.attemptStartedAt,
          beforeAcquire: ({ url }) => limiter.acquire(new URL(url).origin),
        });
      } catch (error) { throw retryable(error, "third_party_acquisition_failed"); }
      const acquisitions = [];
      for (const acquired of fetched) {
        const artifact = await context.putArtifact({
          kind: "evidence-third-party-document",
          bytes: acquired.bytes,
          mediaType: acquired.mediaType || "application/octet-stream",
          privacyClass: "public_source",
        });
        // The public artifact supports replay, while this fenced repository
        // write establishes the actual immutable document/capture authority.
        // Identity remains user-asserted until the reviewed third-party body
        // proof is approved; it can never enter the official promotion path.
        const archived = await evidenceRepository(context).importBuffer(acquired.bytes, {
          kind: "support-document",
          mediaType: acquired.mediaType || "application/octet-stream",
          title: `Archived third-party source for ${context.request.subject.skuId}`,
          productIdentities: [exactProductIdentity(context.request.subject)],
          createdAt: acquired.retrievedAt,
          capture: {
            acquisitionMethod: "third-party-fetch",
            kindBasis: "user-asserted",
            requestedUrl: acquired.requestedUrl,
            finalUrl: acquired.finalUrl,
            canonicalUrl: acquired.finalUrl,
            retrievedAt: acquired.retrievedAt,
            status: acquired.status,
            redirects: acquired.redirects,
            officialBrand: context.request.subject.brand,
          },
        });
        acquisitions.push({
          ...acquired,
          bytes: acquired.bytes,
          artifactRef: artifact.ref,
          captureId: archived.capture.id,
        });
      }
      if (!acquisitions.length) return {
        status: "needs_review",
        output: {
          ...(searchOutcome ? { searchOutcome } : {}),
          reason: "third_party_source_unavailable",
          manualAction: "Add a reviewed independent professional source for the exact revision.",
        },
        ...(official?.officialSearchReason ? { officialSearchReason: official.officialSearchReason } : {}),
      };
      if (!options.thirdPartyClaimExtractor) return {
        status: "needs_review",
        output: {
          ...(searchOutcome ? { searchOutcome } : {}),
          thirdPartyArtifactRefs: acquisitions.map((item) => item.artifactRef),
          reason: "third_party_extractor_not_configured",
          manualAction: "Review the professional test method and extract a low-confidence candidate without relabeling it official.",
        },
        resultRefs: acquisitions.map((item) => item.artifactRef),
        ...(official?.officialSearchReason ? { officialSearchReason: official.officialSearchReason } : {}),
      };
      let extracted;
      try {
        extracted = await options.thirdPartyClaimExtractor({ request: context.request, acquisitions, assessedAt: context.attemptStartedAt });
      } catch {
        return {
          status: "needs_review",
          output: {
            ...(searchOutcome ? { searchOutcome } : {}),
            thirdPartyArtifactRefs: acquisitions.map((item) => item.artifactRef),
            reason: "third_party_extractor_not_configured",
            manualAction: "Provide bounded body evidence for the exact model/variant/revision plus reviewed original-work and test-method metadata.",
          },
          resultRefs: acquisitions.map((item) => item.artifactRef),
          ...(official?.officialSearchReason ? { officialSearchReason: official.officialSearchReason } : {}),
        };
      }
      return {
        status: "completed",
        output: {
          claimCandidates: extracted?.claimCandidates,
          thirdPartySources: extracted?.thirdPartySources,
          thirdPartyFindings: extracted?.thirdPartyFindings,
          assessedAt: extracted?.assessedAt ?? context.attemptStartedAt,
        },
        resultRefs: acquisitions.map((item) => item.artifactRef),
      };
    },

    async assessFactImpact(context) {
      const candidates = claimsFrom(context);
      if (!candidates.length) return { status: "blocked", output: { reason: "claim_candidates_unavailable" } };
      const current = typeof options.factRepository?.listCurrentFacts === "function"
        ? await options.factRepository.listCurrentFacts() : [];
      const affectedFieldIds = [...new Set(candidates.map((claim) => claim.fieldId))].sort();
      const currentFactIds = current.filter((fact) => fact.subject?.kind === "product"
        && fact.subject.skuId === context.request.subject.skuId && affectedFieldIds.includes(fact.field)).map((fact) => fact.factId).sort();
      return {
        status: "completed",
        output: {
          affectedFieldIds,
          currentFactIds,
          proposalRequired: true,
          action: "create_fact_update_notice_after_approval",
        },
      };
    },

    async generateAdapterCandidate(context) {
      if (!options.adapterGenerator) return {
        status: "needs_review",
        output: {
          reason: "adapter_generation_not_implemented",
          manualAction: "Approve a governed generic capability adapter; no compatibility rule was fabricated.",
        },
      };
      const generated = await options.adapterGenerator({ request: context.request, claims: claimsFrom(context), priorResults: context.priorResults });
      return generated ? { status: "completed", output: generated } : {
        status: "needs_review",
        output: { reason: "adapter_candidate_unavailable", manualAction: "Create and review an adapter candidate manually." },
      };
    },

    async proposeBinding(context) {
      const custom = options.bindingProposer
        ? await options.bindingProposer({ request: context.request, claims: claimsFrom(context), priorResults: context.priorResults })
        : null;
      if (custom) return { status: "completed", output: custom };
      const claimResult = [...context.priorResults].reverse().find((result) => ["claim_extraction", "third_party_fallback"].includes(result.stage)
        && result.status === "completed" && Array.isArray(result.output.claimCandidateIds));
      const adapterResult = [...context.priorResults].reverse().find((result) => result.stage === "adapter_generation" && result.status === "completed");
      const proposal = context.request.planId && claimResult && adapterResult
        ? createEvidenceBindingProposalRuntime({
          planId: context.request.planId,
          pipelineId: context.request.pipelineId,
          subject: context.request.subject,
          claimCandidateIds: claimResult.output.claimCandidateIds,
          adapterCandidateId: adapterResult.output.candidateId,
          adapterCandidateHash: adapterResult.output.contentHash,
          createdAt: context.attemptStartedAt,
        }) : null;
      return proposal ? { status: "completed", output: proposal } : {
        status: "needs_review",
        output: {
          reason: "binding_proposal_unavailable",
          manualAction: "Create a plan-scoped governed claim and adapter candidate before requesting approval.",
        },
      };
    },
  });
}
