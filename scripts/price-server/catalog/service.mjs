import crypto from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeModelQuery } from "./normalize.mjs";
import { registryForBrand, registryForUrl } from "./registry.mjs";
import { fetchOfficial } from "./fetch.mjs";
import { validateOfficialUrl } from "./security.mjs";
import { extractOfficialHtml, extractOfficialPdf } from "./extract.mjs";
import { adapterForUrl } from "./adapters.mjs";
import { atomicWriteJson } from "../store.mjs";
import { discoverOfficialUrls, QUERY_NORMALIZATION_VERSION } from "./discovery.mjs";
import { OFFICIAL_REGISTRY_VERSION } from "./registry.mjs";
import { CatalogCacheDiscoveryProvider, RegistrySearchDiscoveryProvider } from "./discovery.mjs";
import { createSearXngDiscoveryProvider } from "./searxng-discovery.mjs";
import { loadEnv } from "../env.mjs";
import { createDomainProposal } from "./domain-proposals.mjs";
import { catalogCandidateInputHash } from "./contracts.mjs";
import { assessCatalogIdentity, classifyOfficialPage, summarizeCatalogCandidates } from "./identity.mjs";

const catalogJson = createRequire(import.meta.url)("../../../data/skus/catalog.json");

const jobs = new Map();
const contentCache = new Map();
const fetchCache = new Map();
const standaloneCandidates = new Map();
const STANDALONE_CANDIDATE_TTL_MS = 30 * 60_000;
const STANDALONE_CANDIDATE_LIMIT = 128;

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

function retainStandaloneCandidate(candidate) {
  const timestamp = Date.now();
  for (const [id, entry] of standaloneCandidates) {
    if (entry.expiresAt <= timestamp) standaloneCandidates.delete(id);
  }
  standaloneCandidates.delete(candidate.candidateId);
  standaloneCandidates.set(candidate.candidateId, { candidate: structuredClone(candidate), expiresAt: timestamp + STANDALONE_CANDIDATE_TTL_MS });
  while (standaloneCandidates.size > STANDALONE_CANDIDATE_LIMIT) {
    standaloneCandidates.delete(standaloneCandidates.keys().next().value);
  }
}

async function persistJob(job, root) {
  if (!root) return;
  const dir = path.join(root, "data/catalog-candidates");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.json`);
  const existing = await readFile(file, "utf8").then((text) => JSON.parse(text)).catch(() => ({ schemaVersion: "1.0.0", jobs: [] }));
  const jobsById = new Map((existing.jobs ?? []).map((entry) => [entry.jobId, entry]));
  jobsById.set(job.jobId, job);
  await atomicWriteJson(file, { ...existing, jobs: [...jobsById.values()] }, {
    operation: "catalog-search-candidates",
    rollbackRoot: path.join(root, "data/audit/rollback"),
    manifestPath: path.join(root, "data/audit/rollback/catalog-search-manifest.json"),
  });
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

async function processJob(job, options) {
  job.status = "running";
  job.stage = "discover";
  await persistJob(job, options.persistRoot);
  let discoveryProviders = options.discoveryProviders;
  if (!discoveryProviders) {
    const env = await loadEnv();
    const mode = env.CATALOG_DISCOVERY_PROVIDER || "registry";
    if (!["registry", "searxng"].includes(mode)) throw new Error("CATALOG_DISCOVERY_PROVIDER must be registry or searxng");
    discoveryProviders = [new CatalogCacheDiscoveryProvider(options.catalog ?? catalogJson), ...(mode === "searxng" ? [createSearXngDiscoveryProvider(env, { cacheRoot: options.discoveryCacheRoot })] : []), new RegistrySearchDiscoveryProvider()];
  }
  const discovery = await discoverOfficialUrls({ query: job.query, catalog: options.catalog ?? catalogJson, providers: discoveryProviders, limit: job.limit, signal: options.signal });
  job.discovery = { providerIds: discovery.providerIds, registryVersion: discovery.registryVersion, queryNormalizationVersion: discovery.queryNormalizationVersion };
  job.warnings.push(...discovery.warnings);
  job.domainProposals = [];
  if (options.persistRoot) {
    for (const proposal of discovery.proposals ?? []) {
      const saved = await createDomainProposal({ ...proposal, brand: proposal.brand ?? job.query.brand, mpn: job.query.mpn, reason: "discovery candidate domain is not governed" }, { persistRoot: options.persistRoot });
      if (saved?.proposalId) job.domainProposals.push(saved);
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
  job.stage = "fetch";
  job.candidates = [];
  let browserFallbackUses = 0;
  const browserFallbackLimit = Math.min(3, Math.max(0, Number(options.browserFallbackLimit ?? 2)));
  for (const candidate of candidates.slice(0, job.limit)) {
    const inspectable = candidate.source.kind === "official" || candidate.source.provider !== "registry-search";
    const candidateOptions = options.browserFallback && browserFallbackUses < browserFallbackLimit
      ? { ...options, browserFallback: async (url) => { browserFallbackUses += 1; return options.browserFallback(url); } }
      : { ...options, browserFallback: undefined };
    job.candidates.push(inspectable && options.inspect !== false ? await inspectCandidate(candidate, candidateOptions) : candidate);
  }
  job.stage = "score";
  job.summary = summarizeCatalogCandidates(job.candidates, discovery.candidates.length);
  job.status = job.candidates.some((candidate) => candidate.extraction.status === "partial" || candidate.extraction.status === "failed") ? "partial" : "completed";
  if (job.candidates.length === 0) job.warnings.push("未找到官方候选；第三方价格发现请使用 /api/price/collect，不混入官方参数");
  await persistJob(job, options.persistRoot);
  job.persisted = true;
  return job;
}

export function queueSearch(body, options = {}) {
  const query = normalizeModelQuery(String(body.query ?? ""), { brand: body.brand, category: body.category, locale: body.locale ?? "zh-CN" });
  const limit = Math.min(20, Math.max(1, Number(body.limit ?? 10)));
  const providerIds = (options.discoveryProviders ?? []).map((provider) => provider.id);
  const requestId = typeof body.requestId === "string" && /^[A-Za-z0-9._:-]{8,160}$/.test(body.requestId) ? body.requestId : null;
  const trigger = body.trigger === "user-confirmed-review" ? body.trigger : null;
  const requestContext = trigger ? { source: "transaction-import", trigger, ...(requestId ? { requestId } : {}) } : null;
  const key = JSON.stringify({ query, officialOnly: body.officialOnly !== false, limit, providerIds: providerIds.length ? providerIds : ["catalog-cache", "registry-search"], registryVersion: OFFICIAL_REGISTRY_VERSION, queryNormalizationVersion: QUERY_NORMALIZATION_VERSION, ...(requestId ? { requestId } : {}) });
  const id = jobId(key);
  const existing = jobs.get(id);
  if (existing) return existing;
  const job = { jobId: id, idempotencyKey: sha256(key), status: "queued", stage: "normalize", query, ...(requestContext ? { requestContext } : {}), limit, candidates: [], warnings: [], errors: [], createdAt: now(), updatedAt: now() };
  jobs.set(id, job);
  void processJob(job, options).catch(async (error) => { job.status = "failed"; job.stage = "score"; job.errors.push(error?.message ?? String(error)); job.updatedAt = now(); await persistJob(job, options.persistRoot); job.persisted = true; });
  return job;
}

export async function waitForJob(jobId, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = jobs.get(jobId);
    if (!job || (["completed", "partial", "failed"].includes(job.status) && job.persisted === true)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return jobs.get(jobId);
}

export function getJob(jobId) { return jobs.get(jobId) ?? null; }

export function findCandidate(candidateId) {
  for (const job of jobs.values()) {
    const candidate = (job.candidates ?? []).find((entry) => entry.candidateId === candidateId);
    if (candidate) return candidate;
  }
  const standalone = standaloneCandidates.get(candidateId);
  if (!standalone) return null;
  if (standalone.expiresAt <= Date.now()) {
    standaloneCandidates.delete(candidateId);
    return null;
  }
  return structuredClone(standalone.candidate);
}

export async function inspectUrl(body, options = {}) {
  const url = validateOfficialUrl(String(body.url ?? "")).toString();
  const query = normalizeModelQuery(String(body.query ?? new URL(url).pathname), { brand: body.brand, category: body.category, locale: body.locale ?? "zh-CN" });
  const candidate = { candidateId: candidateId(`${query.raw}|${url}`), query, ...(query.brand ? { brand: query.brand } : {}), ...(query.model ? { model: query.model } : {}), ...(query.mpn ? { mpn: query.mpn } : {}), ...(query.category ? { category: query.category } : {}), title: query.raw, url, source: { kind: "official", domain: domainOf(url), retrievedAt: now() }, match: { score: 0, kind: "weak", reasons: ["inspection pending"] }, extraction: { status: "not-run", fieldsFound: 0, fieldsMissing: 0 } };
  const inspected = await inspectCandidate(candidate, options);
  retainStandaloneCandidate(inspected);
  return inspected;
}
