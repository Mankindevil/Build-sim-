import { acquireOfficialEvidence, EvidenceAcquisitionError } from "./acquire.mjs";
import { discoverOfficialDocumentLinks, EvidenceDiscoveryError } from "./discovery.mjs";
import { extractEvidenceExcerpts, EvidenceExcerptError } from "./excerpts.mjs";
import { EvidenceRepositoryError } from "./repository.mjs";
import { registryForBrand, registryForUrl } from "../../scripts/price-server/catalog/registry.mjs";
import { validateOfficialUrl } from "../../scripts/price-server/catalog/security.mjs";

const DOCUMENT_KINDS = new Set([
  "manufacturer-manual",
  "datasheet",
  "support-document",
  "official-product-page-snapshot",
]);
function inputObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EvidenceHttpError("invalid_request", "Request body must be an object", 400);
  return value;
}

function boundedText(value, label, { required = false, max = 500 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new EvidenceHttpError("invalid_request", `${label} is required`, 400);
    return undefined;
  }
  if (typeof value !== "string" || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new EvidenceHttpError("invalid_request", `${label} must be bounded text`, 400);
  }
  return value;
}

function knownSku(catalog, skuId) {
  const id = boundedText(skuId, "skuId", { required: true, max: 160 });
  const sku = catalog?.skus?.find((entry) => entry.id === id);
  if (!sku) throw new EvidenceHttpError("unknown_sku", `Unknown SKU: ${id}`, 404);
  return sku;
}

function officialUrl(raw) {
  try {
    return validateOfficialUrl(boundedText(raw, "url", { required: true, max: 4_096 })).toString();
  } catch (error) {
    throw new EvidenceHttpError("invalid_official_url", error?.message ?? "Official URL is invalid", 400);
  }
}

function officialBrand(url) {
  const entry = registryForUrl(new URL(url));
  if (!entry || entry.trustStatus !== "trusted") throw new EvidenceHttpError("invalid_official_url", "Official URL is not governed as trusted", 400);
  return entry.brand;
}

function identityFromSku(sku) {
  return {
    brand: sku.brand,
    model: sku.model,
    ...(sku.mpn ? { mpn: sku.mpn } : {}),
    category: sku.category,
    skuId: sku.id,
    familyId: sku.familyId ?? sku.id,
    modelId: sku.modelId ?? sku.model,
    variantId: sku.variantId ?? sku.id,
    ...(sku.revision ? { revision: sku.revision } : {}),
    ...(sku.region ? { region: sku.region } : {}),
    basis: "governed-sku-user-asserted",
  };
}

function assertedIdentity(value, brand) {
  if (value === undefined) return { brand, basis: "official-domain-only" };
  const input = inputObject(value);
  const assertedBrand = boundedText(input.brand, "identity.brand", { required: true, max: 120 });
  if (assertedBrand.toLocaleLowerCase() !== brand.toLocaleLowerCase()) throw new EvidenceHttpError("identity_brand_mismatch", "Identity brand does not match the governed official URL", 409);
  if (["model", "mpn", "category", "skuId", "familyId", "modelId", "variantId", "revision", "region"]
    .some((field) => input[field] !== undefined)) {
    throw new EvidenceHttpError("ungoverned_product_identity", "Precise product identity requires an exact governed skuId", 422);
  }
  return { brand, basis: "official-domain-only" };
}

function acquisitionRequest(value, catalog) {
  const body = inputObject(value);
  const url = officialUrl(body.url);
  const brand = officialBrand(url);
  const sku = body.skuId ? knownSku(catalog, body.skuId) : null;
  if (sku && sku.brand.toLocaleLowerCase() !== brand.toLocaleLowerCase()) throw new EvidenceHttpError("identity_brand_mismatch", "SKU brand does not match the governed official URL", 409);
  const kind = body.kind ?? "manufacturer-manual";
  if (!DOCUMENT_KINDS.has(kind)) throw new EvidenceHttpError("invalid_request", "kind is invalid", 400);
  const identities = [sku ? identityFromSku(sku) : assertedIdentity(body.identity, brand)];
  const title = boundedText(body.title, "title", { max: 500 }) ?? `${sku?.name ?? identities[0].model ?? brand} — official document`;
  return { url, kind, title, productIdentities: identities, officialBrand: brand };
}

function officialSearchUrl(sku) {
  const registry = registryForBrand(sku?.brand);
  if (!registry || registry.trustStatus !== "trusted" || registry.search?.kind !== "site-search" || !registry.search.urlTemplate.includes("{query}")) return undefined;
  const query = [sku.brand, sku.model, sku.mpn, "manual", "user guide", "datasheet"].filter(Boolean).join(" ");
  return registry.search.urlTemplate.replace("{query}", encodeURIComponent(query));
}

function discoveryRequest(value, catalog) {
  const body = inputObject(value);
  const sku = body.skuId ? knownSku(catalog, body.skuId) : null;
  const seed = body.url ?? sku?.appearance?.page ?? sku?.price?.listingUrl ?? officialSearchUrl(sku);
  if (!seed) throw new EvidenceHttpError("document_start_url_missing", "No governed official start URL is available for this SKU", 422, "Use official catalog search to find and inspect the product/support page, then retry with its explicit URL.");
  const url = officialUrl(seed);
  const brand = officialBrand(url);
  if (sku && sku.brand.toLocaleLowerCase() !== brand.toLocaleLowerCase()) throw new EvidenceHttpError("identity_brand_mismatch", "SKU brand does not match the governed official URL", 409);
  const query = boundedText(body.query, "query", { max: 240 });
  return {
    url,
    title: boundedText(body.title, "title", { max: 500 }),
    queryTokens: [sku?.brand, sku?.model, sku?.mpn, query].filter(Boolean),
    limit: body.limit,
    followPageLimit: body.followPageLimit,
  };
}

function safeId(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new EvidenceHttpError("invalid_id", "Evidence id is not valid URL encoding", 400);
  }
}

const ACQUISITION_ERROR_STATUS = new Map([
  ["manual_url_invalid", 400],
  ["manual_identity_invalid", 400],
  ["manual_kind_invalid", 400],
  ["manual_title_invalid", 400],
  ["manual_brand_mismatch", 409],
  ["manual_cached_document_missing", 409],
  ["manual_too_large", 413],
  ["manual_http_status", 502],
  ["manual_fetch_failed", 502],
  ["manual_response_invalid", 502],
  ["manual_not_modified_without_cache", 409],
  ["manual_body_missing", 502],
  ["manual_body_empty", 502],
  ["manual_hash_mismatch", 502],
  ["manual_repository_invalid", 500],
  ["manual_clock_invalid", 500],
  ["manual_cache_ttl_invalid", 500],
  ["manual_cache_read_failed", 500],
  ["manual_persist_failed", 500],
]);

const DISCOVERY_ERROR_STATUS = new Map([
  ["document_discovery_url_invalid", 400],
  ["document_discovery_options_invalid", 400],
  ["document_discovery_brand_mismatch", 409],
  ["document_discovery_too_large", 413],
  ["document_discovery_http_status", 502],
  ["document_discovery_fetch_failed", 502],
  ["document_discovery_response_invalid", 502],
  ["document_discovery_timeout", 504],
]);

function errorResult(error) {
  if (error instanceof EvidenceHttpError) return { handled: true, status: error.status, payload: { error: error.code, message: error.message, ...(error.manualAction ? { manualAction: error.manualAction } : {}) } };
  if (error instanceof EvidenceExcerptError) return { handled: true, status: error.status, payload: { error: error.code, message: error.message, ...(error.manualAction ? { manualAction: error.manualAction } : {}) } };
  if (error instanceof EvidenceAcquisitionError) {
    const status = ACQUISITION_ERROR_STATUS.get(error.code) ?? 500;
    return { handled: true, status, payload: { error: error.code, message: error.message, manualAction: error.manualAction } };
  }
  if (error instanceof EvidenceDiscoveryError) {
    const status = DISCOVERY_ERROR_STATUS.get(error.code) ?? 500;
    return { handled: true, status, payload: { error: error.code, message: error.message, manualAction: error.manualAction } };
  }
  if (error instanceof EvidenceRepositoryError) {
    const status = error.code === "not_found"
      ? 404
      : error.code === "invalid_input" || error.code === "invalid_id"
          ? 400
          : 500;
    return { handled: true, status, payload: { error: error.code, message: error.message } };
  }
  return { handled: true, status: 500, payload: { error: "evidence_internal_error", message: "Evidence service failed" } };
}

function requestHeader(headers, name) {
  const match = Object.entries(headers ?? {}).find(([key]) => key.toLocaleLowerCase() === name);
  return typeof match?.[1] === "string" ? match[1].trim() : undefined;
}

function loopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function assertEvidencePostRequest(headers) {
  const contentType = requestHeader(headers, "content-type")?.split(";", 1)[0].trim().toLocaleLowerCase();
  if (contentType !== "application/json") {
    throw new EvidenceHttpError("evidence_content_type_required", "Evidence POST requests require Content-Type: application/json", 415);
  }

  const fetchSite = requestHeader(headers, "sec-fetch-site")?.toLocaleLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    throw new EvidenceHttpError("evidence_cross_site_forbidden", "Cross-site evidence POST requests are forbidden", 403);
  }

  const origin = requestHeader(headers, "origin");
  if (!origin) return;
  const host = requestHeader(headers, "host");
  const forwardedProto = requestHeader(headers, "x-forwarded-proto")?.toLocaleLowerCase();
  let parsedOrigin;
  let parsedHost;
  try {
    parsedOrigin = new URL(origin);
    const protocol = forwardedProto || (loopbackHostname(parsedOrigin.hostname) ? "http" : "");
    if (!protocol || !["http", "https"].includes(protocol)) throw new Error("request protocol is not trusted");
    parsedHost = new URL(`${protocol}://${host ?? ""}`);
  } catch {
    throw new EvidenceHttpError("evidence_origin_forbidden", "Evidence POST request Origin is not trusted", 403);
  }
  const cleanOrigin = parsedOrigin.origin === origin
    && ["http:", "https:"].includes(parsedOrigin.protocol)
    && parsedOrigin.protocol === parsedHost.protocol
    && !parsedOrigin.username
    && !parsedOrigin.password;
  if (!cleanOrigin || parsedOrigin.host.toLocaleLowerCase() !== parsedHost.host.toLocaleLowerCase()) {
    throw new EvidenceHttpError("evidence_origin_forbidden", "Evidence POST request Origin is not trusted", 403);
  }
}

function splitEtags(value) {
  const tokens = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (character === '"') quoted = !quoted;
    if ((character === "," && !quoted) || index === value.length) {
      tokens.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  return quoted ? [] : tokens;
}

function opaqueEtag(value) {
  const normalized = String(value ?? "").trim().replace(/^W\//, "");
  return /^"[^"\r\n]*"$/.test(normalized) ? normalized : null;
}

/** Weak comparison for GET/HEAD If-None-Match, including lists and `*`. */
export function matchesEvidenceEtag(ifNoneMatch, currentEtag) {
  if (typeof ifNoneMatch !== "string" || typeof currentEtag !== "string") return false;
  const expected = opaqueEtag(currentEtag);
  if (!expected) return false;
  return splitEtags(ifNoneMatch).some((candidate) => candidate === "*" || opaqueEtag(candidate) === expected);
}

/** Returns null when a local evidence POST may proceed, otherwise a route-style error response. */
export function checkEvidencePostRequest(headers = {}) {
  try {
    assertEvidencePostRequest(headers);
    return null;
  } catch (error) {
    return errorResult(error);
  }
}

export class EvidenceHttpError extends Error {
  constructor(code, message, status = 400, manualAction) {
    super(String(message).slice(0, 500));
    this.name = "EvidenceHttpError";
    this.code = code;
    this.status = status;
    this.manualAction = manualAction;
  }
}

/** Pure route adapter shared by the price server and focused tests. */
export async function handleEvidenceRoute(method, pathname, body, repository, options = {}) {
  if (!String(pathname).startsWith("/api/evidence/")) return { handled: false };
  try {
    if (method === "POST" && pathname === "/api/evidence/acquisitions") {
      const input = acquisitionRequest(body, options.catalog);
      const acquire = options.acquire ?? acquireOfficialEvidence;
      const result = await acquire(input.url, { repository, ...options.acquisitionOptions, kind: input.kind, title: input.title, productIdentities: input.productIdentities, officialBrand: input.officialBrand });
      return { handled: true, status: result.reusedCapture ? 200 : 201, payload: result };
    }
    if (method === "POST" && pathname === "/api/evidence/discover") {
      const input = discoveryRequest(body, options.catalog);
      const discover = options.discover ?? discoverOfficialDocumentLinks;
      return { handled: true, status: 200, payload: await discover(input.url, { ...options.discoveryOptions, title: input.title, queryTokens: input.queryTokens, limit: input.limit, followPageLimit: input.followPageLimit }) };
    }
    const excerptMatch = pathname.match(/^\/api\/evidence\/documents\/([^/]+)\/excerpts$/);
    if (method === "POST" && excerptMatch?.[1]) {
      const extract = options.extractExcerpts ?? extractEvidenceExcerpts;
      return {
        handled: true,
        status: 200,
        payload: await extract(repository, safeId(excerptMatch[1]), body, options.excerptOptions),
      };
    }
    const contentMatch = pathname.match(/^\/api\/evidence\/documents\/([^/]+)\/content$/);
    if (method === "GET" && contentMatch?.[1]) {
      const id = safeId(contentMatch[1]);
      let document;
      let binary;
      if (typeof repository.getDocumentContent === "function") {
        const content = await repository.getDocumentContent(id);
        document = content?.document;
        binary = content?.bytes;
      } else {
        document = await repository.getDocument(id);
        if (document) binary = await repository.readContent(id);
      }
      if (!document) throw new EvidenceHttpError("not_found", "Evidence document was not found", 404);
      if (!Buffer.isBuffer(binary)) throw new EvidenceHttpError("integrity_error", "Evidence document content is missing", 500);
      return {
        handled: true,
        status: 200,
        binary,
        headers: {
          "Content-Type": document.mediaType,
          "Content-Length": String(binary.byteLength),
          "Content-Disposition": `attachment; filename="${document.id}${document.mediaType === "application/pdf" ? ".pdf" : ".bin"}"`,
          ETag: `"${document.sha256}"`,
          "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
        },
      };
    }
    const documentMatch = pathname.match(/^\/api\/evidence\/documents\/([^/]+)$/);
    if (method === "GET" && documentMatch?.[1]) {
      const id = safeId(documentMatch[1]);
      const document = await repository.getDocument(id);
      if (!document) throw new EvidenceHttpError("not_found", "Evidence document was not found", 404);
      return { handled: true, status: 200, payload: { document, captures: await repository.listCaptures(id) } };
    }
    const captureMatch = pathname.match(/^\/api\/evidence\/captures\/([^/]+)$/);
    if (method === "GET" && captureMatch?.[1]) {
      const capture = await repository.getCapture(safeId(captureMatch[1]));
      if (!capture) throw new EvidenceHttpError("not_found", "Evidence capture was not found", 404);
      const document = await repository.getDocument(capture.documentId);
      if (!document) throw new EvidenceHttpError("integrity_error", "Evidence capture refers to a missing document", 500);
      return { handled: true, status: 200, payload: { capture, document } };
    }
    return { handled: true, status: 404, payload: { error: "route_not_found", route: `${method} ${pathname}` } };
  } catch (error) {
    return errorResult(error);
  }
}
