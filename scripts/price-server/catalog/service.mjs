import crypto from "node:crypto";
import catalogJson from "../../../data/skus/catalog.json" with { type: "json" };
import os from "node:os";
import path from "node:path";
import { normalizeModelQuery } from "./normalize.mjs";
import { activeOfficialRegistry, registryForBrand, registryForUrl } from "./registry.mjs";
import { fetchOfficial } from "./fetch.mjs";
import { validateOfficialUrl } from "./security.mjs";
import { discoverEmbeddedOfficialPdfUrls, extractExactVariantOfficialPdf, extractOfficialHtml, extractOfficialPdf } from "./extract.mjs";
import { adapterForUrl } from "./adapters.mjs";
import { discoverOfficialUrls, QUERY_NORMALIZATION_VERSION } from "./discovery.mjs";
import { CatalogCacheDiscoveryProvider, RegistrySearchDiscoveryProvider, SubmittedOfficialUrlDiscoveryProvider, normalizeProposedOfficialUrl } from "./discovery.mjs";
import { createSearXngDiscoveryProvider } from "./searxng-discovery.mjs";
import { loadEnv } from "../env.mjs";
import { createDomainProposal } from "./domain-proposals.mjs";
import { catalogCandidateInputHash } from "./contracts.mjs";
import { assessCatalogIdentity, classifyOfficialPage, summarizeCatalogCandidates } from "./identity.mjs";
import { CatalogSearchJobRepository } from "./catalog-job-repository.mjs";

class BoundedTtlCache {
  constructor({ maxEntries, maxBytes, ttlMs }) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.totalBytes = 0;
  }
  sizeOf(value) {
    try {
      if (typeof value?.body === "string") return Buffer.byteLength(value.body);
      return Buffer.byteLength(JSON.stringify(value));
    } catch { return this.maxBytes + 1; }
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) { this.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value) {
    const bytes = this.sizeOf(value);
    this.delete(key);
    if (bytes > this.maxBytes) return this;
    this.entries.set(key, { value, bytes, expiresAt: Date.now() + this.ttlMs });
    this.totalBytes += bytes;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    return this;
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.totalBytes -= entry.bytes;
    return this.entries.delete(key);
  }
}

const cacheTtlMs = Number.isInteger(Number(process.env.CATALOG_FETCH_CACHE_TTL_MS))
  ? Math.min(3_600_000, Math.max(10_000, Number(process.env.CATALOG_FETCH_CACHE_TTL_MS)))
  : 900_000;
const contentCache = new BoundedTtlCache({ maxEntries: 256, maxBytes: 8_000_000, ttlMs: cacheTtlMs });
const fetchCache = new BoundedTtlCache({ maxEntries: 64, maxBytes: 40_000_000, ttlMs: cacheTtlMs });
// These two maps only route a request to the durable store / retain a
// read-through copy for legacy synchronous catalog-write callers. Neither map
// carries lifecycle state or makes an unpersisted candidate authoritative.
const repositoriesByRoot = new Map();
const jobRootHints = new Map();
const candidateReadThroughCache = new Map();
const activeRuns = new Set();
let officialDocumentQueue = Promise.resolve();
// Production always supplies an explicit runtime root. Standalone/test calls
// share one private root for this process, but a startup nonce prevents PID
// reuse from resurrecting stale jobs left by an unrelated prior process.
const processFallbackRoot = path.join(os.tmpdir(), `build-sim-catalog-service-${process.pid}-${crypto.randomUUID()}`);

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function now() { return new Date().toISOString(); }
function candidateId(input) { return `catalog-candidate-${sha256(input).slice(0, 16)}`; }
function jobId(input) { return `catalog-search-${sha256(input).slice(0, 20)}`; }
function domainOf(url) { return new URL(url).hostname; }
function safeText(value) { return String(value ?? "").slice(0, 240); }
function comparableCatalogIdentity(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
function catalogBrandsMatch(left, right, registry = activeOfficialRegistry()) {
  const leftEntry = registryForBrand(left, registry);
  const rightEntry = registryForBrand(right, registry);
  if (leftEntry && rightEntry) return leftEntry.brand === rightEntry.brand;
  return comparableCatalogIdentity(left) === comparableCatalogIdentity(right);
}
function expectedCatalogSku(body, query, catalog) {
  if (!Object.prototype.hasOwnProperty.call(body, "expectedSkuId")) return null;
  if (typeof body.expectedSkuId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(body.expectedSkuId)) {
    throw new Error("expectedSkuId must be a valid catalog SKU id");
  }
  const expected = (catalog.skus ?? []).find((sku) => sku.id === body.expectedSkuId);
  if (!expected) throw new Error("expectedSkuId does not exist in the active catalog");
  const conflicts = ["brand", "model", "category", "mpn"].filter((field) => query[field] !== undefined
    && comparableCatalogIdentity(query[field]) !== comparableCatalogIdentity(expected[field]));
  if (conflicts.length) throw new Error(`expectedSkuId conflicts with query ${conflicts.join(", ")}`);
  return expected;
}
function boundedOfficialDocumentBytes(value) {
  const parsed = Number(value ?? process.env.CATALOG_OFFICIAL_DOCUMENT_MAX_BYTES ?? 15_000_000);
  return Number.isInteger(parsed) && parsed >= 5_000_000 && parsed <= 25_000_000 ? parsed : 15_000_000;
}
function successfulFetch(fetchResult) {
  const status = Number(fetchResult?.status ?? 0);
  return status >= 200 && status < 300;
}
function fetchContentCacheKey(fetchResult) { return `${fetchResult.finalUrl}|${fetchResult.contentHash}`; }
function fetchAudit(fetchResult) {
  return {
    requestedUrl: fetchResult.requestedUrl,
    finalUrl: fetchResult.finalUrl,
    httpStatus: fetchResult.status,
    retrievedAt: fetchResult.retrievedAt,
    contentHash: fetchResult.contentHash,
    redirects: fetchResult.redirects ?? [],
  };
}

async function serializedOfficialDocument(task) {
  const previous = officialDocumentQueue;
  let release;
  officialDocumentQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try { return await task(); } finally { release(); }
}

function persistRootFor(options = {}) {
  if (options.coordinator?.root) return path.resolve(options.coordinator.root);
  // The production server always passes its explicit runtime root. The private
  // temporary fallback keeps standalone tooling/tests durable without trying to
  // mutate the read-only release artifact.
  return path.resolve(options.persistRoot ?? process.env.CATALOG_JOB_PERSIST_ROOT ?? processFallbackRoot);
}

async function repositoryFor(options = {}) {
  const persistRoot = persistRootFor(options);
  let repository = repositoriesByRoot.get(persistRoot);
  if (!repository) {
    // A normal process restart must recover durable work, not quarantine it.
    // Restore quarantine is enabled only by the explicit backup-restore path.
    repository = new CatalogSearchJobRepository({ persistRoot, ...(options.coordinator ? { coordinator: options.coordinator } : {}) });
    await repository.initialize("price-server");
    repositoriesByRoot.set(persistRoot, repository);
  }
  return { repository, persistRoot };
}

async function hydrateJob(record, repository) {
  const candidateIds = record.catalog.candidateIds ?? [];
  const candidates = await Promise.all(candidateIds.map((id) => repository.findCandidate(id)));
  for (const candidate of candidates.filter(Boolean)) candidateReadThroughCache.set(candidate.candidateId, structuredClone(candidate));
  const lifecycle = record.job.status;
  const status = lifecycle === "succeeded" ? record.catalog.status : lifecycle;
  return {
    jobId: record.job.jobId,
    idempotencyKey: record.job.idempotencyKey,
    status,
    backgroundStatus: lifecycle,
    stage: record.catalog.stage,
    query: record.catalog.query,
    ...(record.catalog.expectedSkuId ? { expectedSkuId: record.catalog.expectedSkuId } : {}),
    ...(record.catalog.requestContext ? { requestContext: record.catalog.requestContext } : {}),
    limit: record.catalog.limit,
    candidates,
    warnings: record.catalog.warnings ?? [],
    errors: record.catalog.errors ?? [],
    ...(record.catalog.discovery ? { discovery: record.catalog.discovery } : {}),
    ...(record.catalog.domainProposals ? { domainProposals: record.catalog.domainProposals } : {}),
    ...(record.catalog.officialSiteSuggestions ? { officialSiteSuggestions: record.catalog.officialSiteSuggestions } : {}),
    ...(record.catalog.summary ? { summary: record.catalog.summary } : {}),
    revision: record.job.revision,
    runtimeGeneration: record.job.runtimeGeneration,
    ...(record.job.progress ? { progress: record.job.progress } : {}),
    createdAt: record.job.createdAt,
    updatedAt: record.job.updatedAt,
    persisted: ["succeeded", "failed", "cancelled", "dead_letter"].includes(lifecycle),
  };
}

function catalogCandidates(query, catalog) {
  const lower = `${query.brand ?? ""} ${query.model ?? ""} ${query.mpn ?? ""}`.toLocaleLowerCase();
  return (catalog.skus ?? []).flatMap((sku) => {
    const haystack = `${sku.brand} ${sku.model} ${sku.name} ${sku.mpn ?? ""}`.toLocaleLowerCase();
    const exactMpn = Boolean(query.mpn && sku.mpn && query.mpn.toLocaleLowerCase() === sku.mpn.toLocaleLowerCase());
    const brandModel = Boolean(query.brand && query.model && haystack.includes(query.brand.toLocaleLowerCase()) && haystack.includes(query.model.toLocaleLowerCase()));
    if (!exactMpn && !brandModel && !haystack.includes(lower.trim())) return [];
    const url = sku.appearance?.page ?? sku.price?.listingUrl;
    if (!url || !registryForUrl(new URL(url))) return [];
    return [{
      candidateId: candidateId(`${query.raw}|${url}`),
      query,
      brand: sku.brand,
      model: sku.model,
      ...(sku.mpn ? { mpn: sku.mpn } : {}),
      category: sku.category,
      title: sku.name,
      url,
      source: { kind: "official", domain: domainOf(url), retrievedAt: now() },
      match: { score: exactMpn ? 1 : brandModel ? 0.85 : 0.5, kind: exactMpn ? "exact-mpn" : brandModel ? "brand-model" : "weak", reasons: exactMpn ? ["catalog MPN exact match"] : ["catalog brand/model match"] },
      extraction: { status: "not-run", fieldsFound: 0, fieldsMissing: 0 },
    }];
  });
}

function registryCandidate(query) {
  const registry = registryForBrand(query.brand);
  if (!registry) return null;
  const url = registry.search.urlTemplate.replace("{query}", encodeURIComponent(query.raw));
  return {
    candidateId: candidateId(`${query.raw}|${url}`),
    query,
    ...(query.brand ? { brand: query.brand } : {}),
    ...(query.model ? { model: query.model } : {}),
    ...(query.mpn ? { mpn: query.mpn } : {}),
    ...(query.category ? { category: query.category } : {}),
    title: `${registry.brand} site search · ${query.raw}`,
    url,
    source: { kind: "search", domain: domainOf(url), retrievedAt: now() },
    match: { score: 0.3, kind: "weak", reasons: ["official registry search link; exact page not discovered"] },
    extraction: { status: "not-run", fieldsFound: 0, fieldsMissing: 0 },
  };
}

function scoreExtracted(identity) {
  if (identity.verdict === "exact") {
    const exactMpn = identity.reasons.includes("official MPN exactly matches");
    return { score: identity.score, kind: exactMpn ? "exact-mpn" : "brand-model", reasons: identity.reasons };
  }
  if (identity.verdict === "same-family") return { score: identity.score, kind: "spec-match", reasons: identity.reasons };
  return { score: identity.score, kind: "weak", reasons: identity.reasons };
}

const REQUIRED_FIELDS_BY_CATEGORY = {
  case: ["dims.lengthMm", "dims.widthMm", "dims.heightMm"],
  motherboard: ["dims.lengthMm", "dims.widthMm"],
  cpu: ["power.tdpW"],
  psu: ["power.ratedW"],
  cooler: ["dims.heightMm"],
  gpu: ["dims.lengthMm", "power.tgpW"],
  memory: ["attrs.capacity"],
  storage: ["attrs.capacity", "attrs.interface"],
  hba: ["attrs.interface"],
  fan: ["dims.lengthMm"],
  accessory: [],
};
const REQUIRED_FIELD_ALTERNATIVES_BY_CATEGORY = {
  gpu: [["dims.slots", "dims.thicknessMm"]],
};

function requiredFieldGroups(candidate) {
  const category = candidate.category ?? candidate.query?.category;
  return [
    ["brand"],
    ["model"],
    ...(candidate.query?.mpn || candidate.mpn ? [["mpn"]] : []),
    ...(REQUIRED_FIELDS_BY_CATEGORY[category] ?? []).map((field) => [field]),
    ...(REQUIRED_FIELD_ALTERNATIVES_BY_CATEGORY[category] ?? []),
  ];
}

function extractionStatus(candidate, extracted, fetchResult) {
  if (fetchResult.status >= 400) return "failed";
  if (extracted.accessBarrier || fetchResult.pdfExtraction?.mode === "ocr") return "partial";
  return extracted.fields.length && !missingRequiredFields(candidate, extracted).length && !extracted.conflicts.length ? "ok" : "partial";
}

export function missingRequiredFields(candidate, extracted) {
  return requiredFieldGroups(candidate)
    .filter((alternatives) => !alternatives.some((field) => extracted.fields.some((entry) => entry.field === field)))
    .map((alternatives) => alternatives.join("|"));
}

function uniqueRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = JSON.stringify(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderedExtraction(extracted, fetchResult) {
  return {
    ...extracted,
    fields: (extracted.fields ?? []).map((field) => ({
      ...field,
      sourceKind: "official-rendered-page",
      sourceUrl: fetchResult.finalUrl,
      retrievedAt: fetchResult.retrievedAt,
    })),
  };
}

function withOfficialDomainBrand(extracted, fetchResult, expectedBrand, registry) {
  const entry = registryForUrl(new URL(fetchResult.finalUrl), registry);
  if (entry?.trustStatus !== "trusted" || extracted.fields?.some((field) => field.field === "brand")) return extracted;
  if (expectedBrand && !catalogBrandsMatch(expectedBrand, entry.brand, registry)) {
    return { ...extracted, warnings: [...(extracted.warnings ?? []), `official domain brand ${entry.brand} conflicts with requested brand ${expectedBrand}`] };
  }
  const sourceKind = fetchResult.fallback ? "official-rendered-page" : fetchResult.contentType?.includes("pdf") ? "official-pdf" : "official-page";
  return {
    ...extracted,
    fields: [{
      provenanceId: `prov-${fetchResult.contentHash.slice(0, 12)}-official-domain-brand`,
      field: "brand",
      value: entry.brand,
      evidence: "official",
      sourceUrl: fetchResult.finalUrl,
      sourceKind,
      retrievedAt: fetchResult.retrievedAt,
      extractor: "official-domain-registry-v1",
      locator: `trusted official domain: ${new URL(fetchResult.finalUrl).hostname}`,
      snippet: entry.brand,
      confidence: 1,
    }, ...(extracted.fields ?? [])],
  };
}

/** Rendered values win per field, while static-only evidence and diagnostics survive. */
export function mergeFallbackExtraction(initial, rendered, renderer = "playwright") {
  const fields = [...(initial.fields ?? [])];
  const indexByField = new Map(fields.map((field, index) => [field.field, index]));
  for (const field of rendered.fields ?? []) {
    const index = indexByField.get(field.field);
    if (index === undefined) {
      indexByField.set(field.field, fields.length);
      fields.push(field);
    } else {
      fields[index] = field;
    }
  }
  const merged = {
    ...initial,
    ...rendered,
    title: rendered.title ?? initial.title,
    fields,
    conflicts: uniqueRecords([...(initial.conflicts ?? []), ...(rendered.conflicts ?? [])]),
    warnings: [...new Set([...(initial.warnings ?? []), ...(rendered.warnings ?? [])])],
    adapter: `${initial.adapter}+${rendered.adapter}+${renderer}-fallback`,
  };
  // A successful rendered document resolves a barrier on the initial response;
  // the initial warning and fetch audit remain available without blocking it.
  if (!rendered.accessBarrier) delete merged.accessBarrier;
  return merged;
}

function officialDocumentUrls(fetchResult, expectedBrand, limit = 3) {
  return discoverEmbeddedOfficialPdfUrls(fetchResult.body, fetchResult.finalUrl, { limit: Math.min(3, Math.max(0, Number(limit) || 0)) })
    .filter((url) => {
      try {
        const validated = validateOfficialUrl(url);
        const entry = registryForUrl(validated);
        return entry?.trustStatus === "trusted" && (!expectedBrand || entry.brand.toLocaleLowerCase() === expectedBrand.toLocaleLowerCase());
      } catch { return false; }
    });
}

function extractionEvidenceHash(fetchResult, supportingDocuments) {
  if (!supportingDocuments.length) return fetchResult.contentHash;
  return sha256(JSON.stringify({
    schemaVersion: "catalog-extraction-evidence-v1",
    page: { url: fetchResult.finalUrl, contentHash: fetchResult.contentHash },
    documents: supportingDocuments.map(({ finalUrl, contentHash }) => ({ url: finalUrl, contentHash })),
  }));
}

async function inspectCandidate(candidate, {
  fetcher = fetchOfficial,
  browserFallback,
  officialDocumentLimit = 3,
  officialDocumentMaxBytes,
  registry = activeOfficialRegistry(),
  responseCache = fetcher === fetchOfficial ? fetchCache : null,
} = {}) {
  try {
    const supportingDocuments = [];
    let fetchResult = responseCache?.get(candidate.url) ?? await fetcher(candidate.url);
    const initialCacheKey = fetchContentCacheKey(fetchResult);
    let extracted = contentCache.get(initialCacheKey);
    if (!extracted) {
      const adapter = adapterForUrl(fetchResult.finalUrl);
      extracted = adapter?.extract(fetchResult) ?? (fetchResult.contentType.includes("pdf") ? extractOfficialPdf(fetchResult) : extractOfficialHtml(fetchResult));
      if (successfulFetch(fetchResult) && !extracted.accessBarrier) contentCache.set(initialCacheKey, extracted);
    }
    const requestedBrand = candidate.query?.brand ?? candidate.brand;
    extracted = withOfficialDomainBrand(extracted, fetchResult, requestedBrand, registry);
    if (missingRequiredFields(candidate, extracted).length && browserFallback && !fetchResult.contentType.includes("pdf") && !fetchResult.fallback) {
      try {
        const initialFetch = fetchResult.initialFetch ?? fetchAudit(fetchResult);
        const fallbackResult = await browserFallback(fetchResult.finalUrl);
        const fallbackAdapter = adapterForUrl(fallbackResult.finalUrl);
        const fallbackExtracted = withOfficialDomainBrand(renderedExtraction(fallbackAdapter?.extract(fallbackResult) ?? extractOfficialHtml(fallbackResult, { sourceKind: "official-rendered-page" }), fallbackResult), fallbackResult, requestedBrand, registry);
        extracted = mergeFallbackExtraction(extracted, fallbackExtracted, fallbackResult.fallback ?? "browser");
        fetchResult = { ...fallbackResult, initialFetch };
        if (successfulFetch(fetchResult) && !extracted.accessBarrier) contentCache.set(fetchContentCacheKey(fetchResult), extracted);
      } catch (error) {
        extracted = { ...extracted, warnings: [...extracted.warnings, `browser fallback failed: ${safeText(error?.message ?? error)}`] };
      }
    }
    const expectedBrand = registryForUrl(new URL(fetchResult.finalUrl), registry)?.brand;
    const requestedMpn = candidate.query?.mpn ?? candidate.mpn;
    if (requestedMpn && missingRequiredFields(candidate, extracted).length && !fetchResult.contentType.includes("pdf")) {
      for (const documentUrl of officialDocumentUrls(fetchResult, expectedBrand, officialDocumentLimit)) {
        try {
          const { documentFetch, documentExtracted } = await serializedOfficialDocument(async () => {
            const boundedFetch = responseCache?.get(documentUrl) ?? await fetcher(documentUrl, { expectedBrand, maxBytes: boundedOfficialDocumentBytes(officialDocumentMaxBytes) });
            if (!successfulFetch(boundedFetch) || !boundedFetch.contentType.includes("pdf")) throw new Error("embedded official document is not a successful PDF response");
            return { documentFetch: boundedFetch, documentExtracted: extractExactVariantOfficialPdf(boundedFetch, { mpn: requestedMpn, brand: expectedBrand }) };
          });
          const audit = { ...fetchAudit(documentFetch), exactVariant: documentExtracted.exactVariant === true };
          supportingDocuments.push(audit);
          if (responseCache) responseCache.set(documentUrl, documentFetch);
          if (!documentExtracted.exactVariant) {
            extracted = { ...extracted, warnings: [...extracted.warnings, ...documentExtracted.warnings] };
            continue;
          }
          extracted = mergeFallbackExtraction(extracted, documentExtracted, "official-document");
          if (!missingRequiredFields(candidate, extracted).length) break;
        } catch (error) {
          extracted = { ...extracted, warnings: [...extracted.warnings, `embedded official PDF failed: ${safeText(error?.message ?? error)}`] };
        }
      }
    }
    if (responseCache) {
      if (successfulFetch(fetchResult) && !extracted.accessBarrier) responseCache.set(candidate.url, fetchResult);
      else responseCache.delete(candidate.url);
    }
    const canonicalMatch = fetchResult.body.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i) ?? fetchResult.body.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
    let canonicalUrl;
    if (canonicalMatch?.[1]) canonicalUrl = validateOfficialUrl(new URL(canonicalMatch[1], fetchResult.finalUrl).toString()).toString();
    const fields = extracted.fields;
    const finalWarnings = !extracted.accessBarrier && !missingRequiredFields(candidate, extracted).length
      ? extracted.warnings.filter((warning) => !/^missing official (?:PDF )?fields:|^access barrier detected:/i.test(warning))
      : extracted.warnings;
    const canonical = canonicalUrl ?? fetchResult.canonicalUrl ?? fetchResult.finalUrl;
    const finalOfficialEntry = registryForUrl(new URL(fetchResult.finalUrl), registry);
    const canonicalOfficialEntry = registryForUrl(new URL(canonical), registry);
    const officialEntry = finalOfficialEntry ?? canonicalOfficialEntry;
    const page = classifyOfficialPage(fetchResult, extracted, canonical);
    const identity = assessCatalogIdentity({
      ...candidate,
      canonicalUrl: canonical,
      officialDomainBrands: [...new Set([finalOfficialEntry?.brand, canonicalOfficialEntry?.brand].filter(Boolean))],
    }, extracted, officialEntry);
    const inspected = {
      ...candidate,
      canonicalUrl: canonical,
      source: { ...candidate.source, kind: "official", retrievedAt: fetchResult.retrievedAt, httpStatus: fetchResult.status, finalUrl: fetchResult.finalUrl, ...(fetchResult.fallback ? { fetchMode: fetchResult.fallback } : {}), ...(fetchResult.rendererAttempts?.length ? { rendererAttempts: fetchResult.rendererAttempts } : {}), ...(fetchResult.initialFetch ? { initialFetch: fetchResult.initialFetch } : {}), ...(supportingDocuments.length ? { supportingDocuments } : {}), ...(fetchResult.etag ? { etag: fetchResult.etag } : {}), ...(fetchResult.lastModified ? { lastModified: fetchResult.lastModified } : {}) },
      official: { trustStatus: officialEntry?.trustStatus ?? "untrusted", brand: officialEntry?.brand, pageKind: page.kind, reasons: page.reasons },
      identity,
      match: scoreExtracted(identity),
      extraction: { status: extractionStatus(candidate, extracted, fetchResult), fieldsFound: fields.length, fieldsMissing: missingRequiredFields(candidate, extracted).length, adapter: extracted.adapter, ...(fetchResult.contentHash ? { contentHash: extractionEvidenceHash(fetchResult, supportingDocuments) } : {}), ...(supportingDocuments.length ? { supportingDocuments } : {}), ...(finalWarnings.length ? { error: safeText(finalWarnings.join("; ")) } : {}) },
      fields,
      ...(extracted.accessBarrier ? { accessBarrier: extracted.accessBarrier } : {}),
      ...(extracted.conflicts.length ? { conflicts: extracted.conflicts } : {}),
    };
    return { ...inspected, expectedHash: catalogCandidateInputHash(inspected) };
  } catch (error) {
    return { ...candidate, extraction: { status: "partial", fieldsFound: 0, fieldsMissing: 6, error: error?.message ?? String(error) }, source: { ...candidate.source, retrievedAt: now() } };
  }
}

async function processClaim(claim, repository, options) {
  let record = claim.record;
  let fence = claim.fence;
  let job = record.catalog;
  const registry = options.registry ?? activeOfficialRegistry();
  if (job.registryVersion !== registry.version) throw new Error("official registry changed after catalog job creation; enqueue a new search");
  let discoveryProviders = options.discoveryProviders;
  if (!discoveryProviders) {
    const env = await loadEnv();
    const mode = env.CATALOG_DISCOVERY_PROVIDER || "registry";
    if (!["registry", "searxng"].includes(mode)) throw new Error("CATALOG_DISCOVERY_PROVIDER must be registry or searxng");
    discoveryProviders = [new CatalogCacheDiscoveryProvider(options.catalog ?? catalogJson), ...(mode === "searxng" ? [createSearXngDiscoveryProvider(env, { cacheRoot: options.discoveryCacheRoot, registryVersion: registry.version })] : []), new RegistrySearchDiscoveryProvider()];
  }
  if (job.requestedOfficialUrl) {
    discoveryProviders = [new SubmittedOfficialUrlDiscoveryProvider(job.requestedOfficialUrl), ...discoveryProviders.filter((provider) => provider.id !== "user-submitted-url")];
  }
  const discovery = await discoverOfficialUrls({ query: job.query, catalog: options.catalog ?? catalogJson, providers: discoveryProviders, limit: job.limit, signal: options.signal, registry, expectedSkuId: job.expectedSkuId });
  const discoveryMetadata = { providerIds: discovery.providerIds, registryVersion: discovery.registryVersion, queryNormalizationVersion: discovery.queryNormalizationVersion };
  const warnings = [...(job.warnings ?? []), ...discovery.warnings];
  const domainProposals = [];
  const officialSiteSuggestions = [];
  if (options.persistRoot) {
    for (const proposal of discovery.proposals ?? []) {
      const proposalBrand = proposal.brand ?? job.query.brand;
      if (!proposalBrand) {
        warnings.push(`${proposal.provider}: skipped ungoverned domain ${proposal.domain}; manufacturer brand is required for approval`);
        continue;
      }
      try {
        const saved = await createDomainProposal({ ...proposal, brand: proposalBrand, mpn: job.query.mpn, reason: "discovery candidate domain is not governed" }, options.coordinator ? { coordinator: options.coordinator, generationAware: true } : { persistRoot: options.persistRoot });
        if (saved?.proposalId) {
          domainProposals.push(saved);
          if (saved.trustStatus === "proposed") {
            officialSiteSuggestions.push({
              proposalId: saved.proposalId,
              inputHash: saved.inputHash,
              brand: saved.brand,
              domain: saved.domain,
              url: proposal.url,
              title: proposal.title || saved.domain,
              snippet: proposal.snippet || "",
              matchScore: Number(proposal.matchScore ?? 0),
              reasons: Array.isArray(proposal.reasons) ? proposal.reasons : ["待用户核对是否为制造商官网"],
              submittedByUser: proposal.submittedByUser === true,
            });
          }
        }
      } catch (error) {
        warnings.push(`${proposal.provider}: domain proposal rejected: ${safeText(error?.message ?? error)}`);
      }
    }
  }
  const candidates = discovery.candidates.map((entry) => {
    const boundSkuId = entry.skuId ?? (entry.provider === "user-submitted-url" ? job.expectedSkuId : null);
    return {
      // Candidate records live in one durable namespace. Include the owning job
      // so two concurrent searches for the same URL cannot overwrite each
      // other's inspected/not-run lifecycle state.
      candidateId: candidateId(`${record.job.jobId}|${entry.url}`),
      ...(boundSkuId ? { skuId: boundSkuId } : {}),
      query: job.query,
      ...(job.query.brand ? { brand: job.query.brand } : {}),
      ...(job.query.model ? { model: job.query.model } : {}),
      ...(job.query.mpn ? { mpn: job.query.mpn } : {}),
      ...(job.query.category ? { category: job.query.category } : {}),
      title: entry.title || job.query.raw,
      url: entry.url,
      discovery: entry,
      source: { kind: entry.provider === "catalog-cache" ? "official" : "search", provider: entry.provider, domain: domainOf(entry.url), retrievedAt: entry.retrievedAt },
      official: { trustStatus: "trusted", brand: registryForUrl(new URL(entry.url))?.brand, pageKind: entry.provider === "registry-search" ? "search" : "unknown", reasons: [entry.provider === "registry-search" ? "official site-search link" : "official page inspection pending"] },
      match: { score: entry.matchScore ?? 0.3, kind: entry.matchKind ?? "weak", reasons: [entry.provider === "catalog-cache" ? "catalog candidate" : "discovery candidate; inspection required"] },
      extraction: { status: "not-run", fieldsFound: 0, fieldsMissing: 0 },
    };
  });
  if (job.expectedSkuId) candidates.sort((left, right) => {
    const priority = (candidate) => candidate.discovery?.provider === "user-submitted-url" ? 2 : candidate.skuId === job.expectedSkuId ? 1 : 0;
    return priority(right) - priority(left);
  });
  ({ record, fence } = await repository.checkpoint(record.job.jobId, fence, {
    stage: "fetch", discovery: discoveryMetadata, warnings, domainProposals, officialSiteSuggestions,
    progress: { stage: "fetch", completed: 0, total: Math.min(job.limit, candidates.length) },
  }));
  claim.fence = fence;
  job = record.catalog;
  const inspectedCandidates = [];
  let browserFallbackUses = 0;
  const browserFallbackLimit = Math.min(3, Math.max(0, Number(options.browserFallbackLimit ?? 2)));
  for (const candidate of candidates.slice(0, job.limit)) {
    const inspectable = candidate.source.kind === "official" || candidate.source.provider !== "registry-search";
    const candidateOptions = options.browserFallback && browserFallbackUses < browserFallbackLimit
      ? { ...options, browserFallback: async (url) => { browserFallbackUses += 1; return options.browserFallback(url); } }
      : { ...options, browserFallback: undefined };
    const inspected = inspectable && options.inspect !== false ? await inspectCandidate(candidate, candidateOptions) : candidate;
    inspectedCandidates.push(inspected);
    ({ record, fence } = await repository.checkpoint(record.job.jobId, fence, {
      stage: "fetch", progress: { stage: "fetch", completed: inspectedCandidates.length, total: Math.min(job.limit, candidates.length) },
    }));
    claim.fence = fence;
    const expectedCatalogMatch = job.expectedSkuId
      && inspected.skuId === job.expectedSkuId
      && inspected.discovery?.provider === "catalog-cache";
    const requestedOfficialMatch = job.requestedOfficialUrl && inspected.discovery?.provider === "user-submitted-url";
    if ((requestedOfficialMatch || expectedCatalogMatch || (!job.expectedSkuId && job.requestContext?.source === "transaction-import"))
      && inspected.identity?.verdict === "exact"
      && ["product", "spec", "datasheet", "support"].includes(inspected.official?.pageKind)
      && inspected.extraction?.status === "ok") break;
  }
  const status = inspectedCandidates.some((candidate) => candidate.extraction.status === "partial" || candidate.extraction.status === "failed") ? "partial" : "completed";
  const finalWarnings = inspectedCandidates.length === 0 ? [...warnings, "未找到官方候选；第三方价格发现请使用 /api/price/collect，不混入官方参数"] : warnings;
  const completed = await repository.complete(record.job.jobId, fence, {
    status, stage: "score", candidates: inspectedCandidates, warnings: finalWarnings,
    discovery: discoveryMetadata, domainProposals, officialSiteSuggestions, summary: { ...summarizeCatalogCandidates(inspectedCandidates, discovery.candidates.length), suggestedSites: officialSiteSuggestions.length },
    progress: { stage: "score", completed: inspectedCandidates.length, total: Math.min(job.limit, candidates.length) },
  });
  return hydrateJob(completed, repository);
}

async function runOne(repository, options) {
  const runKey = `${options.persistRoot ?? "default"}:${options.jobId ?? "next"}`;
  if (activeRuns.has(runKey)) return null;
  activeRuns.add(runKey);
  try {
    const claim = await repository.claimNext(`catalog-price-worker-${process.pid}`, { jobId: options.jobId });
    if (!claim) return null;
    try {
      return await processClaim(claim, repository, options);
    } catch (error) {
      await repository.fail(claim.record.job.jobId, claim.fence, error).catch(() => undefined);
      throw error;
    }
  } finally {
    activeRuns.delete(runKey);
  }
}

export async function queueSearch(body, options = {}) {
  let query = normalizeModelQuery(String(body.query ?? ""), { brand: body.brand, model: body.model, mpn: body.mpn, category: body.category, locale: body.locale ?? "zh-CN" });
  const catalog = options.catalog ?? catalogJson;
  const expectedSku = expectedCatalogSku(body, query, catalog);
  if (expectedSku && !query.brand) query = { ...query, brand: expectedSku.brand };
  const expectedSkuId = expectedSku?.id ?? null;
  const limit = Math.min(20, Math.max(1, Number(body.limit ?? 10)));
  const providerIds = (options.discoveryProviders ?? []).map((provider) => provider.id);
  const requestId = typeof body.requestId === "string" && /^[A-Za-z0-9._:-]{8,160}$/.test(body.requestId) ? body.requestId : null;
  const trigger = body.trigger === "user-confirmed-review" ? body.trigger : null;
  const requestContext = trigger ? { source: "transaction-import", trigger, ...(requestId ? { requestId } : {}) } : null;
  const requestedOfficialUrl = body.officialUrl ? normalizeProposedOfficialUrl(String(body.officialUrl)) : null;
  const registry = options.registry ?? activeOfficialRegistry();
  const key = JSON.stringify({ query, officialOnly: body.officialOnly !== false, limit, providerIds: providerIds.length ? providerIds : ["catalog-cache", "registry-search"], registryVersion: registry.version, queryNormalizationVersion: QUERY_NORMALIZATION_VERSION, ...(expectedSkuId ? { expectedSkuId } : {}), ...(requestedOfficialUrl ? { requestedOfficialUrl } : {}), ...(requestId ? { requestId } : {}) });
  const id = jobId(key);
  const { repository, persistRoot } = await repositoryFor(options);
  const created = await repository.create({
    jobId: id, idempotencyKey: sha256(key), inputHash: sha256(key), payloadRef: `catalog-search-payload:${sha256(key)}`,
    catalog: { query, ...(expectedSkuId ? { expectedSkuId } : {}), ...(requestedOfficialUrl ? { requestedOfficialUrl } : {}), ...(requestContext ? { requestContext } : {}), limit, registryVersion: registry.version },
  });
  jobRootHints.set(id, persistRoot);
  if (created.created || ["queued"].includes(created.record.job.status)) {
    void runOne(repository, { ...options, registry, persistRoot, jobId: id }).catch(() => undefined);
  }
  return hydrateJob(created.record, repository);
}

export async function waitForJob(jobId, timeoutMs = 5_000, options = {}) {
  const started = Date.now();
  const root = options.persistRoot ? persistRootFor(options) : (jobRootHints.get(jobId) ?? persistRootFor(options));
  const localRunKey = `${root}:${jobId}`;
  while (Date.now() - started < timeoutMs) {
    const job = await getJob(jobId, options);
    const terminal = job?.status === "paused_restore_review" || (["completed", "partial", "failed"].includes(job?.status) && job?.persisted === true);
    // A durable terminal record is externally visible just before the local
    // worker releases its final read/lock scope. Local waiters must not tear
    // down a temporary repository while that epilogue is still running.
    if (!job || (terminal && !activeRuns.has(localRunKey))) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getJob(jobId, options);
}

export async function getJob(jobId, options = {}) {
  const root = options.persistRoot ? persistRootFor(options) : (jobRootHints.get(jobId) ?? persistRootFor(options));
  const repository = repositoriesByRoot.get(root) ?? new CatalogSearchJobRepository({ persistRoot: root, ...(options.coordinator ? { coordinator: options.coordinator } : {}) });
  if (!repositoriesByRoot.has(root)) {
    await repository.initialize("price-server");
    repositoriesByRoot.set(root, repository);
  }
  try { return await hydrateJob(await repository.get(jobId), repository); } catch (error) {
    if (error?.code === "not_found") return null;
    throw error;
  }
}

/** Compatibility cache only. Durable callers must use findCandidateDurable. */
export function findCandidate(candidateId) {
  const candidate = candidateReadThroughCache.get(candidateId);
  return candidate ? structuredClone(candidate) : null;
}

export async function findCandidateDurable(candidateId, options = {}) {
  const { repository } = await repositoryFor(options);
  const candidate = await repository.findCandidate(candidateId);
  if (candidate) candidateReadThroughCache.set(candidateId, structuredClone(candidate));
  return candidate;
}

/** Preload the non-authoritative compatibility cache from durable records on server boot. */
export async function initializeCatalogJobs(options = {}) {
  const { repository } = await repositoryFor(options);
  for (const candidate of await repository.listCandidates()) candidateReadThroughCache.set(candidate.candidateId, structuredClone(candidate));
  return repository;
}

export async function inspectUrl(body, options = {}) {
  const url = validateOfficialUrl(String(body.url ?? "")).toString();
  const query = normalizeModelQuery(String(body.query ?? new URL(url).pathname), { brand: body.brand, model: body.model, mpn: body.mpn, category: body.category, locale: body.locale ?? "zh-CN" });
  const candidate = { candidateId: candidateId(`${query.raw}|${url}`), query, ...(query.brand ? { brand: query.brand } : {}), ...(query.model ? { model: query.model } : {}), ...(query.mpn ? { mpn: query.mpn } : {}), ...(query.category ? { category: query.category } : {}), title: query.raw, url, source: { kind: "official", domain: domainOf(url), retrievedAt: now() }, match: { score: 0, kind: "weak", reasons: ["inspection pending"] }, extraction: { status: "not-run", fieldsFound: 0, fieldsMissing: 0 } };
  const inspected = await inspectCandidate(candidate, options);
  const { repository } = await repositoryFor(options);
  await repository.storeCandidate(inspected);
  candidateReadThroughCache.set(inspected.candidateId, structuredClone(inspected));
  return inspected;
}
