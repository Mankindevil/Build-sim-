import { createHash } from "node:crypto";
import { fetchOfficial } from "../../scripts/price-server/catalog/fetch.mjs";
import { validateOfficialUrl } from "../../scripts/price-server/catalog/security.mjs";
import { registryForUrl } from "../../scripts/price-server/catalog/registry.mjs";

export const DEFAULT_EVIDENCE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_EVIDENCE_MAX_BYTES = 25_000_000;
export const MAX_EVIDENCE_MAX_BYTES = 50_000_000;

const MAX_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_ERROR_MESSAGE = 240;
const DOCUMENT_KINDS = new Set([
  "manufacturer-manual",
  "datasheet",
  "support-document",
  "official-product-page-snapshot",
]);

function boundedText(value, maxLength) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function errorDetail(error) {
  return boundedText(error instanceof Error ? error.message : error, 140);
}

export class EvidenceAcquisitionError extends Error {
  constructor(code, message, manualAction, cause) {
    const detail = cause ? errorDetail(cause) : "";
    super(boundedText(`${message}${detail ? `: ${detail}` : ""}`, MAX_ERROR_MESSAGE), cause ? { cause } : undefined);
    this.name = "EvidenceAcquisitionError";
    this.code = code;
    this.manualAction = boundedText(manualAction, MAX_ERROR_MESSAGE);
  }
}

function fail(code, message, manualAction, cause) {
  throw new EvidenceAcquisitionError(code, message, manualAction, cause);
}

function validateRepository(repository) {
  for (const method of ["getLatestCaptureForUrl", "getDocument", "readContent", "importBuffer"]) {
    if (!repository || typeof repository[method] !== "function") {
      fail(
        "manual_repository_invalid",
        `Official-manual repository is missing ${method}()`,
        "Configure the local evidence repository before acquiring a manual.",
      );
    }
  }
  return repository;
}

function nowValue(clock) {
  let value;
  try {
    value = (clock ?? (() => new Date()))();
  } catch (error) {
    fail("manual_clock_invalid", "Official-manual acquisition clock failed", "Retry with a valid server clock.", error);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail("manual_clock_invalid", "Official-manual acquisition clock returned an invalid time", "Retry with a valid server clock.");
  }
  return date;
}

function cacheTtl(value) {
  const ttl = value ?? DEFAULT_EVIDENCE_CACHE_TTL_MS;
  if (!Number.isFinite(ttl) || ttl < 0 || ttl > MAX_CACHE_TTL_MS) {
    fail(
      "manual_cache_ttl_invalid",
      "Official-manual cache TTL is outside the supported range",
      "Use a cache TTL between 0 and 30 days.",
    );
  }
  return Number(ttl);
}

function configuredMaxBytes(explicit) {
  const configured = Number(explicit ?? process.env.EVIDENCE_FETCH_MAX_BYTES ?? DEFAULT_EVIDENCE_MAX_BYTES);
  return Number.isInteger(configured) && configured >= 1_000_000 && configured <= MAX_EVIDENCE_MAX_BYTES
    ? configured
    : DEFAULT_EVIDENCE_MAX_BYTES;
}

function trustedUrl(rawUrl) {
  try {
    return validateOfficialUrl(rawUrl).toString();
  } catch (error) {
    fail(
      "manual_url_invalid",
      "Official-manual URL must be an explicit trusted HTTPS URL",
      "Provide a public HTTPS manual URL on an allowlisted manufacturer domain.",
      error,
    );
  }
}

function governedBrand(rawUrl) {
  const entry = registryForUrl(new URL(rawUrl));
  if (!entry || entry.trustStatus !== "trusted") {
    fail("manual_url_invalid", "Official-manual URL has no trusted manufacturer identity", "Use a URL from the governed official-domain registry.");
  }
  return entry.brand;
}

function assertExpectedBrand(value, expected, label) {
  if (value === undefined || value === null || value === "") return;
  if (boundedText(value, 120).toLocaleLowerCase() !== expected.toLocaleLowerCase()) {
    fail("manual_brand_mismatch", `${label} does not match the governed official URL brand`, "Review the exact document and product identity before archiving it.");
  }
}

function assertAcquisitionIdentity(options, brand) {
  assertExpectedBrand(options.officialBrand, brand, "Official-manual brand");
  if (options.productIdentities !== undefined && !Array.isArray(options.productIdentities)) {
    fail("manual_identity_invalid", "Official-manual product identities must be an array", "Use a governed catalog SKU identity or omit the product identity.");
  }
  for (const [index, identity] of (options.productIdentities ?? []).entries()) {
    assertExpectedBrand(identity?.brand, brand, `Official-manual productIdentities[${index}].brand`);
  }
}

function titleFromUrl(rawUrl) {
  const url = new URL(rawUrl);
  const tail = url.pathname.split("/").filter(Boolean).at(-1);
  if (!tail) return url.hostname;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

function headerValue(value, maxLength) {
  const bounded = boundedText(value, maxLength);
  return bounded || undefined;
}

function conditionalHeaders(capture) {
  const etag = headerValue(capture?.etag, 512);
  const lastModified = headerValue(capture?.lastModified, 256);
  return {
    ...(etag ? { "if-none-match": etag } : {}),
    ...(lastModified ? { "if-modified-since": lastModified } : {}),
  };
}

function isFresh(capture, now, ttl) {
  if (!capture || ttl <= 0) return false;
  const retrievedAt = Date.parse(capture.retrievedAt);
  if (!Number.isFinite(retrievedAt)) return false;
  const age = now.getTime() - retrievedAt;
  return age >= 0 && age <= ttl;
}

function documentMetadata(options, previousDocument, previousCapture, requestedUrl, retrievedAt) {
  const requestedKind = options.kind ?? previousCapture?.kind ?? "manufacturer-manual";
  if (!DOCUMENT_KINDS.has(requestedKind)) {
    fail(
      "manual_kind_invalid",
      "Official-manual document kind is invalid",
      "Choose a supported manufacturer-manual, datasheet, support-document, or product-page kind.",
    );
  }
  const title = boundedText(options.title ?? previousCapture?.title ?? titleFromUrl(requestedUrl), 240);
  if (!title) fail("manual_title_invalid", "Official-manual title is empty", "Provide a short document title.");
  return {
    kind: requestedKind,
    title,
    productIdentities: structuredClone(options.productIdentities ?? previousCapture?.productIdentities ?? []).map((identity) => ({
      ...identity,
      basis: identity?.basis ?? (identity?.model || identity?.mpn || identity?.skuId || identity?.category
        ? "governed-sku-user-asserted"
        : "official-domain-only"),
    })),
    createdAt: previousDocument?.createdAt ?? retrievedAt,
  };
}

function captureMetadata(result, previousCapture, requestedUrl, finalUrl, retrievedAt, officialBrand, kindBasis = "user-asserted") {
  return {
    acquisitionMethod: "official-fetch",
    kindBasis,
    requestedUrl,
    finalUrl,
    canonicalUrl: finalUrl,
    retrievedAt,
    status: result.status,
    redirects: Array.isArray(result.redirects) ? result.redirects.map((url) => trustedUrl(url)) : [],
    ...(headerValue(result.etag ?? previousCapture?.etag, 512) ? { etag: headerValue(result.etag ?? previousCapture?.etag, 512) } : {}),
    ...(headerValue(result.lastModified ?? previousCapture?.lastModified, 256) ? { lastModified: headerValue(result.lastModified ?? previousCapture?.lastModified, 256) } : {}),
    officialBrand,
  };
}

async function latestCapture(repository, requestedUrl) {
  try {
    return await repository.getLatestCaptureForUrl(requestedUrl);
  } catch (error) {
    fail(
      "manual_cache_read_failed",
      "Official-manual URL cache could not be read",
      "Check the local evidence store and retry; do not assume the manual is archived.",
      error,
    );
  }
}

async function storedDocument(repository, capture) {
  if (!capture?.documentId) return null;
  try {
    return await repository.getDocument(capture.documentId);
  } catch (error) {
    fail(
      "manual_cache_read_failed",
      "Official-manual cached document could not be read",
      "Check the local evidence store and reacquire the manual.",
      error,
    );
  }
}

async function persist(repository, buffer, input) {
  try {
    const stored = await repository.importBuffer(buffer, input);
    if (!stored?.document?.id || !stored?.capture?.id) throw new Error("repository returned an incomplete record");
    return stored;
  } catch (error) {
    if (error instanceof EvidenceAcquisitionError) throw error;
    fail(
      "manual_persist_failed",
      "Official-manual bytes could not be persisted",
      "Check local evidence storage and retry; do not cite this document as archived.",
      error,
    );
  }
}

function responseStatus(result) {
  const status = Number(result?.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    fail("manual_response_invalid", "Official-manual fetch returned an invalid status", "Retry from the explicit official URL.");
  }
  return status;
}

/**
 * Fetch and archive one explicit official document URL.
 *
 * `options.fetcher` is a trusted high-level test seam only. Production callers
 * must leave it unset so `fetchOfficial` retains DNS, redirect and SSRF checks.
 * No request or API field may select this function.
 */
export async function acquireOfficialEvidence(rawUrl, options = {}) {
  const repository = validateRepository(options.repository);
  const requestedUrl = trustedUrl(rawUrl);
  const requestedBrand = governedBrand(requestedUrl);
  assertAcquisitionIdentity(options, requestedBrand);
  const now = nowValue(options.clock);
  const retrievedAt = now.toISOString();
  const ttl = cacheTtl(options.cacheTtlMs);
  const maxBytes = configuredMaxBytes(options.maxBytes);
  const previousCapture = await latestCapture(repository, requestedUrl);
  const previousDocument = await storedDocument(repository, previousCapture);

  if (previousCapture) assertExpectedBrand(previousCapture.officialBrand, requestedBrand, "Cached official-manual capture brand");

  if (previousCapture && !previousDocument) {
    fail(
      "manual_cached_document_missing",
      "Official-manual URL index points to a missing document",
      "Repair the local evidence store or remove the broken index before retrying.",
    );
  }
  if (isFresh(previousCapture, now, ttl)) {
    return {
      document: previousDocument,
      capture: previousCapture,
      reusedDocument: true,
      reusedCapture: true,
      cacheStatus: "fresh",
    };
  }

  const fetcher = options.fetcher ?? fetchOfficial;
  let result;
  try {
    result = await fetcher(requestedUrl, {
      ...(options.fetchOptions && typeof options.fetchOptions === "object" ? options.fetchOptions : {}),
      includeBody: true,
      extractContent: false,
      maxBytes,
      expectedBrand: requestedBrand,
      requestHeaders: conditionalHeaders(previousCapture),
    });
  } catch (error) {
    if (/size limit|exceeds.*limit/i.test(errorDetail(error))) {
      fail(
        "manual_too_large",
        `Official manual exceeds the ${maxBytes}-byte acquisition limit`,
        "Use a smaller official document or raise EVIDENCE_FETCH_MAX_BYTES within the 50 MB hard limit.",
        error,
      );
    }
    fail(
      "manual_fetch_failed",
      "Official-manual fetch failed",
      "Retry later or review the public official URL manually; this workflow never bypasses access controls.",
      error,
    );
  }

  const status = responseStatus(result);
  const normalizedResult = { ...result, status };
  const finalUrl = trustedUrl(normalizedResult.finalUrl ?? requestedUrl);
  const finalBrand = governedBrand(finalUrl);
  assertExpectedBrand(finalBrand, requestedBrand, "Official-manual final URL brand");
  for (const redirect of normalizedResult.redirects ?? []) {
    const redirectUrl = trustedUrl(redirect);
    assertExpectedBrand(governedBrand(redirectUrl), requestedBrand, "Official-manual redirect brand");
  }
  if (status === 304) {
    if (!previousCapture || !previousDocument) {
      fail(
        "manual_not_modified_without_cache",
        "Official-manual server returned 304 without a cached document",
        "Retry without conditional metadata and archive a complete response first.",
      );
    }
    let buffer;
    try {
      buffer = await repository.readContent(previousDocument.id);
    } catch (error) {
      fail(
        "manual_cache_read_failed",
        "Official-manual cached bytes could not be read after 304",
        "Repair the local evidence store or reacquire a complete response.",
        error,
      );
    }
    const capture = captureMetadata(normalizedResult, previousCapture, requestedUrl, finalUrl, retrievedAt, requestedBrand, options.kindBasis);
    const stored = await persist(repository, buffer, {
      mediaType: previousDocument.mediaType,
      ...documentMetadata(options, previousDocument, previousCapture, requestedUrl, retrievedAt),
      capture,
    });
    return { ...stored, cacheStatus: "revalidated", notModified: true };
  }

  if (status < 200 || status >= 300) {
    fail(
      "manual_http_status",
      `Official-manual fetch returned HTTP ${status}`,
      "Review access on the official site manually or retry later; do not archive the error page as evidence.",
    );
  }
  if (!Buffer.isBuffer(normalizedResult.rawBody)) {
    fail(
      "manual_body_missing",
      "Official-manual fetch did not return the opted-in byte buffer",
      "Use the built-in official fetcher with includeBody enabled before persisting evidence.",
    );
  }
  if (normalizedResult.rawBody.byteLength === 0) {
    fail("manual_body_empty", "Official-manual response body is empty", "Retry the official URL before creating evidence.");
  }
  if (normalizedResult.rawBody.byteLength > maxBytes) {
    fail(
      "manual_too_large",
      `Official manual exceeds the ${maxBytes}-byte acquisition limit`,
      "Use a smaller official document or raise EVIDENCE_FETCH_MAX_BYTES within the 50 MB hard limit.",
    );
  }
  if (normalizedResult.contentHash) {
    const actualHash = createHash("sha256").update(normalizedResult.rawBody).digest("hex");
    if (String(normalizedResult.contentHash).toLowerCase() !== actualHash) {
      fail(
        "manual_hash_mismatch",
        "Official-manual response hash does not match its bytes",
        "Discard this response and retry through the trusted official fetcher.",
      );
    }
  }

  const mediaType = boundedText(String(normalizedResult.contentType ?? "").split(";")[0], 160).toLowerCase() || "application/octet-stream";
  const capture = captureMetadata(normalizedResult, previousCapture, requestedUrl, finalUrl, retrievedAt, requestedBrand, options.kindBasis);
  const stored = await persist(repository, normalizedResult.rawBody, {
    mediaType,
    ...documentMetadata(options, previousDocument, previousCapture, requestedUrl, retrievedAt),
    capture,
  });
  return { ...stored, cacheStatus: previousCapture ? "updated" : "miss", notModified: false };
}
