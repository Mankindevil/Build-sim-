import crypto from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { normalizeModelQuery } from "./normalize.mjs";
import { activeOfficialRegistry, registryForBrand, registryForUrl } from "./registry.mjs";
import { fetchOfficial } from "./fetch.mjs";
import { validateOfficialUrl } from "./security.mjs";
import { extractOfficialHtml, extractOfficialPdf } from "./extract.mjs";
import { adapterForUrl } from "./adapters.mjs";
import { discoverOfficialUrls, QUERY_NORMALIZATION_VERSION } from "./discovery.mjs";
import { CatalogCacheDiscoveryProvider, RegistrySearchDiscoveryProvider } from "./discovery.mjs";
import { createSearXngDiscoveryProvider } from "./searxng-discovery.mjs";
import { loadEnv } from "../env.mjs";
import { createDomainProposal } from "./domain-proposals.mjs";
import { catalogCandidateInputHash } from "./contracts.mjs";
import { assessCatalogIdentity, classifyOfficialPage, summarizeCatalogCandidates } from "./identity.mjs";
import { CatalogSearchJobRepository } from "./catalog-job-repository.mjs";

const catalogJson = createRequire(import.meta.url)("../../../data/skus/catalog.json");

const contentCache = new Map();
const fetchCache = new Map();
// These two maps only route a request to the durable store / retain a
// read-through copy for legacy synchronous catalog-write callers. Neither map
// carries lifecycle state or makes an unpersisted candidate authoritative.
const repositoriesByRoot = new Map();
const jobRootHints = new Map();
const candidateReadThroughCache = new Map();
const activeRuns = new Set();

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function now() { return new Date().toISOString(); }
function candidateId(input) { return `catalog-candidate-${sha256(input).slice(0, 16)}`; }
function jobId(input) { return `catalog-search-${sha256(input).slice(0, 20)}`; }
function domainOf(url) { return new URL(url).hostname; }
function safeText(value) { return String(value ?? "").slice(0, 240); }
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

function persistRootFor(options = {}) {
  if (options.coordinator?.root) return path.resolve(options.coordinator.root);
  // The production server always passes its explicit runtime root. The private
  // temporary fallback keeps standalone tooling/tests durable without trying to
  // mutate the read-only release artifact.
  return path.resolve(options.persistRoot ?? process.env.CATALOG_JOB_PERSIST_ROOT ?? path.join(os.tmpdir(), `build-sim-catalog-service-${process.pid}`));
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
    ...(record.catalog.requestContext ? { requestContext: record.catalog.requestContext } : {}),
    limit: record.catalog.limit,
    candidates,
    warnings: record.catalog.warnings ?? [],
    errors: record.catalog.errors ?? [],
    ...(record.catalog.discovery ? { discovery: record.catalog.discovery } : {}),
    ...(record.catalog.domainProposals ? { domainProposals: record.catalog.domainProposals } : {}),
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

/** Rendered values win per field, while static-only evidence and diagnostics survive. */
export function mergeFallbackExtraction(initial, rendered) {
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
    adapter: `${initial.adapter}+${rendered.adapter}+playwright-fallback`,
  };
  // A successful rendered document resolves a barrier on the initial response;
  // the initial warning and fetch audit remain available without blocking it.
  if (!rendered.accessBarrier) delete merged.accessBarrier;
  return merged;
}

async function inspectCandidate(candidate, {
  fetcher = fetchOfficial,
  browserFallback,
  responseCache = fetcher === fetchOfficial ? fetchCache : null,
} = {}) {
  try {
    let fetchResult = responseCache?.get(candidate.url) ?? await fetcher(candidate.url);
    const initialCacheKey = fetchContentCacheKey(fetchResult);
    let extracted = contentCache.get(initialCacheKey);
    if (!extracted) {
      const adapter = adapterForUrl(fetchResult.finalUrl);
      extracted = adapter?.extract(fetchResult) ?? (fetchResult.contentType.includes("pdf") ? extractOfficialPdf(fetchResult) : extractOfficialHtml(fetchResult));
      if (successfulFetch(fetchResult) && !extracted.accessBarrier) contentCache.set(initialCacheKey, extracted);
    }
    if (missingRequiredFields(candidate, extracted).length && browserFallback && !fetchResult.contentType.includes("pdf") && fetchResult.fallback !== "playwright") {
      try {
        const initialFetch = fetchResult.initialFetch ?? fetchAudit(fetchResult);
        const fallbackResult = await browserFallback(fetchResult.finalUrl);
        const fallbackAdapter = adapterForUrl(fallbackResult.finalUrl);
        const fallbackExtracted = renderedExtraction(fallbackAdapter?.extract(fallbackResult) ?? extractOfficialHtml(fallbackResult, { sourceKind: "official-rendered-page" }), fallbackResult);
        extracted = mergeFallbackExtraction(extracted, fallbackExtracted);
        fetchResult = { ...fallbackResult, initialFetch };
        if (successfulFetch(fetchResult) && !extracted.accessBarrier) contentCache.set(fetchContentCacheKey(fetchResult), extracted);
      } catch (error) {
        extracted = { ...extracted, warnings: [...extracted.warnings, `Playwright fallback failed: ${safeText(error?.message ?? error)}`] };
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
    const canonical = canonicalUrl ?? fetchResult.canonicalUrl ?? fetchResult.finalUrl;
    const officialEntry = registryForUrl(new URL(canonical));
    const page = classifyOfficialPage(fetchResult, extracted, canonical);
    const identity = assessCatalogIdentity({ ...candidate, canonicalUrl: canonical }, extracted, officialEntry);
    const inspected = {
      ...candidate,
      canonicalUrl: canonical,
      source: { ...candidate.source, kind: "official", retrievedAt: fetchResult.retrievedAt, httpStatus: fetchResult.status, finalUrl: fetchResult.finalUrl, ...(fetchResult.fallback ? { fetchMode: fetchResult.fallback } : {}), ...(fetchResult.initialFetch ? { initialFetch: fetchResult.initialFetch } : {}), ...(fetchResult.etag ? { etag: fetchResult.etag } : {}), ...(fetchResult.lastModified ? { lastModified: fetchResult.lastModified } : {}) },
      official: { trustStatus: officialEntry?.trustStatus ?? "untrusted", brand: officialEntry?.brand, pageKind: page.kind, reasons: page.reasons },
      identity,
      match: scoreExtracted(identity),
      extraction: { status: extractionStatus(candidate, extracted, fetchResult), fieldsFound: fields.length, fieldsMissing: Math.max(0, 6 - fields.length), adapter: extracted.adapter, ...(fetchResult.contentHash ? { contentHash: fetchResult.contentHash } : {}), ...(extracted.warnings.length ? { error: safeText(extracted.warnings.join("; ")) } : {}) },
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
  const discovery = await discoverOfficialUrls({ query: job.query, catalog: options.catalog ?? catalogJson, providers: discoveryProviders, limit: job.limit, signal: options.signal, registry });
  const discoveryMetadata = { providerIds: discovery.providerIds, registryVersion: discovery.registryVersion, queryNormalizationVersion: discovery.queryNormalizationVersion };
  const warnings = [...(job.warnings ?? []), ...discovery.warnings];
  const domainProposals = [];
  if (options.persistRoot) {
    for (const proposal of discovery.proposals ?? []) {
      const saved = await createDomainProposal({ ...proposal, brand: proposal.brand ?? job.query.brand, mpn: job.query.mpn, reason: "discovery candidate domain is not governed" }, options.coordinator ? { coordinator: options.coordinator, generationAware: true } : { persistRoot: options.persistRoot });
      if (saved?.proposalId) domainProposals.push(saved);
    }
  }
  const candidates = discovery.candidates.map((entry) => ({
    candidateId: candidateId(`${job.query.raw}|${entry.url}`),
    ...(entry.skuId ? { skuId: entry.skuId } : {}),
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
  }));
  ({ record, fence } = await repository.checkpoint(record.job.jobId, fence, {
    stage: "fetch", discovery: discoveryMetadata, warnings, domainProposals,
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
    inspectedCandidates.push(inspectable && options.inspect !== false ? await inspectCandidate(candidate, candidateOptions) : candidate);
    ({ record, fence } = await repository.checkpoint(record.job.jobId, fence, {
      stage: "fetch", progress: { stage: "fetch", completed: inspectedCandidates.length, total: Math.min(job.limit, candidates.length) },
    }));
    claim.fence = fence;
  }
  const status = inspectedCandidates.some((candidate) => candidate.extraction.status === "partial" || candidate.extraction.status === "failed") ? "partial" : "completed";
  const finalWarnings = inspectedCandidates.length === 0 ? [...warnings, "未找到官方候选；第三方价格发现请使用 /api/price/collect，不混入官方参数"] : warnings;
  const completed = await repository.complete(record.job.jobId, fence, {
    status, stage: "score", candidates: inspectedCandidates, warnings: finalWarnings,
    discovery: discoveryMetadata, domainProposals, summary: summarizeCatalogCandidates(inspectedCandidates, discovery.candidates.length),
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
  const query = normalizeModelQuery(String(body.query ?? ""), { brand: body.brand, category: body.category, locale: body.locale ?? "zh-CN" });
  const limit = Math.min(20, Math.max(1, Number(body.limit ?? 10)));
  const providerIds = (options.discoveryProviders ?? []).map((provider) => provider.id);
  const requestId = typeof body.requestId === "string" && /^[A-Za-z0-9._:-]{8,160}$/.test(body.requestId) ? body.requestId : null;
  const trigger = body.trigger === "user-confirmed-review" ? body.trigger : null;
  const requestContext = trigger ? { source: "transaction-import", trigger, ...(requestId ? { requestId } : {}) } : null;
  const registry = options.registry ?? activeOfficialRegistry();
  const key = JSON.stringify({ query, officialOnly: body.officialOnly !== false, limit, providerIds: providerIds.length ? providerIds : ["catalog-cache", "registry-search"], registryVersion: registry.version, queryNormalizationVersion: QUERY_NORMALIZATION_VERSION, ...(requestId ? { requestId } : {}) });
  const id = jobId(key);
  const { repository, persistRoot } = await repositoryFor(options);
  const created = await repository.create({
    jobId: id, idempotencyKey: sha256(key), inputHash: sha256(key), payloadRef: `catalog-search-payload:${sha256(key)}`,
    catalog: { query, ...(requestContext ? { requestContext } : {}), limit, registryVersion: registry.version },
  });
  jobRootHints.set(id, persistRoot);
  if (created.created || ["queued"].includes(created.record.job.status)) {
    void runOne(repository, { ...options, registry, persistRoot, jobId: id }).catch(() => undefined);
  }
  return hydrateJob(created.record, repository);
}

export async function waitForJob(jobId, timeoutMs = 5_000, options = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await getJob(jobId, options);
    if (!job || job.status === "paused_restore_review" || (["completed", "partial", "failed"].includes(job.status) && job.persisted === true)) return job;
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
  const query = normalizeModelQuery(String(body.query ?? new URL(url).pathname), { brand: body.brand, category: body.category, locale: body.locale ?? "zh-CN" });
  const candidate = { candidateId: candidateId(`${query.raw}|${url}`), query, ...(query.brand ? { brand: query.brand } : {}), ...(query.model ? { model: query.model } : {}), ...(query.mpn ? { mpn: query.mpn } : {}), ...(query.category ? { category: query.category } : {}), title: query.raw, url, source: { kind: "official", domain: domainOf(url), retrievedAt: now() }, match: { score: 0, kind: "weak", reasons: ["inspection pending"] }, extraction: { status: "not-run", fieldsFound: 0, fieldsMissing: 0 } };
  const inspected = await inspectCandidate(candidate, options);
  const { repository } = await repositoryFor(options);
  await repository.storeCandidate(inspected);
  candidateReadThroughCache.set(inspected.candidateId, structuredClone(inspected));
  return inspected;
}
