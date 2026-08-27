#!/usr/bin/env node
/**
 * Local-only price collector. Binds 127.0.0.1 so nothing is exposed to the network;
 * the Vite dev server proxies /api/price here.
 *
 *   npm run price:serve
 */

import http from "node:http";
import path from "node:path";
import { decideDomainProposal, listDomainProposals, migrateLegacyDomainRepository } from "./catalog/domain-proposals.mjs";
import { runAutoEnrichment } from "./catalog/auto-enrichment.mjs";
import {
  buildAndWriteLatest,
  readActivePriceState,
  loadCandidates,
  removeLocalQuote,
  saveCandidates,
  today,
  upsertLocalQuote,
  initializePriceRepository,
  loadListingCapture,
  resolvePriceRepositoryPaths,
  loadFx,
} from "./store.mjs";
import {
  CHANNELS,
  browser,
  channelAvailability,
  collectForSku,
  resolveVariants,
} from "./adapters/index.mjs";
import { listingKey } from "./adapters/variant.mjs";
import { buildSearchQueries, isPriceTrackable } from "../../src/price/queries.mjs";
import { getJob, initializeCatalogJobs, inspectUrl, queueSearch } from "./catalog/service.mjs";
import { renderOfficialFallback } from "./catalog/browser-fallback.mjs";
import { acceptOfficial, confirmDraft, createDraft, previewDraft, recoverPendingDrafts, rejectDraft } from "./catalog/write.mjs";
import { loadRuntimeFlags } from "../runtime/flags.mjs";
import { buildAuditedQuoteFromCapture } from "./price-audit.mjs";
import { createAdviceJob, getAdviceBillingSummary, getAdviceJob, resumeAdviceJobs } from "../deepseek/advice.mjs";
import { intEnv, loadEnv } from "./env.mjs";
import { analyzeTransactionScreenshot } from "./transactions/receipt.mjs";
import { transactionCatalogSearchRequest } from "./transactions/catalog-search-request.mjs";
import { CatalogCacheDiscoveryProvider, MsiProductDiscoveryProvider, RegistrySearchDiscoveryProvider } from "./catalog/discovery.mjs";
import { createSearXngDiscoveryProvider } from "./catalog/searxng-discovery.mjs";
import { archiveTransaction, deleteTransactionArchive, deleteTransactionImage, listTransactionArchives, readTransactionImage, updateTransactionArchive } from "./transactions/archive.mjs";
import {
  catalogWriteOptions,
  initializeRuntimeCatalog,
  loadMergedCatalog,
  markRuntimeCatalogSkuAccepted,
  migrateLegacyCatalogRepository,
  resultRequiresRuntimeCatalogRetention,
  resolveCatalogRepositoryPaths,
  sanitizeMergedCatalog,
  withCatalogWrite,
} from "./catalog/repository.mjs";
import { activateOfficialRegistryRepository, activeOfficialRegistry, registryForUrl } from "./catalog/registry.mjs";
import { FileEvidenceRepository } from "../../src/evidence/repository.mjs";
import { checkEvidencePostRequest, handleEvidenceRoute, matchesEvidenceEtag } from "../../src/evidence/http-routes.mjs";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";

const HOST = "127.0.0.1";
const env = await loadEnv();
const PORT = intEnv(env, "PRICE_SERVER_PORT", 5174, { min: 1, max: 65_535 });
const MAX_BODY_BYTES = intEnv(env, "PRICE_REQUEST_BODY_MAX_BYTES", 1_000_000, { min: 1_024, max: 10_000_000 });
const TRANSACTION_BODY_MAX_BYTES = intEnv(env, "TRANSACTION_SCREENSHOT_BODY_MAX_BYTES", 7_000_000, { min: 500_000, max: 12_000_000 });
const TRANSACTION_OCR_TIMEOUT_MS = intEnv(env, "TRANSACTION_SCREENSHOT_OCR_TIMEOUT_MS", 60_000, { min: 5_000, max: 120_000 });
const TRANSACTION_OCR_PROVIDER = env.TRANSACTION_OCR_PROVIDER || "deepseek-ocr";
const DEEPSEEK_OCR_MAX_TOKENS = intEnv(env, "DEEPSEEK_OCR_MAX_TOKENS", 2_048, { min: 128, max: 8_192 });
const RUNTIME_ROOT = env.RUNTIME_ROOT || env.PRICE_RUNTIME_ROOT || `${process.cwd()}/runtime`;
if (env.CATALOG_PERSIST_ROOT && path.resolve(env.CATALOG_PERSIST_ROOT) !== path.resolve(RUNTIME_ROOT)) {
  throw new Error("CATALOG_PERSIST_ROOT must match RUNTIME_ROOT; migrate the legacy catalog before startup");
}
const RUNTIME_COORDINATOR = new RuntimeCoordinator({ root: RUNTIME_ROOT });
await RUNTIME_COORDINATOR.initialize();
const configuredTransactionRoot = env.TRANSACTION_ARCHIVE_ROOT ? path.resolve(env.TRANSACTION_ARCHIVE_ROOT) : null;
const TRANSACTION_ARCHIVE_ROOT = configuredTransactionRoot && configuredTransactionRoot !== path.join(path.resolve(RUNTIME_ROOT), "transactions")
  ? configuredTransactionRoot
  : null;
const CATALOG_REPOSITORY = resolveCatalogRepositoryPaths({ runtimeRoot: RUNTIME_ROOT, coordinator: RUNTIME_COORDINATOR, generationAware: true });
const configuredEvidenceRoot = env.EVIDENCE_REPOSITORY_ROOT ? path.resolve(env.EVIDENCE_REPOSITORY_ROOT) : null;
if (configuredEvidenceRoot && configuredEvidenceRoot !== path.join(path.resolve(RUNTIME_ROOT), "evidence")) {
  throw new Error("EVIDENCE_REPOSITORY_ROOT conflicts with RUNTIME_ROOT; run the explicit evidence migration dry-run before startup");
}
const EVIDENCE_REPOSITORY = new FileEvidenceRepository({ coordinator: RUNTIME_COORDINATOR, runtimeRoot: RUNTIME_ROOT });
const EVIDENCE_FETCH_TIMEOUT_MS = intEnv(env, "EVIDENCE_FETCH_TIMEOUT_MS", 30_000, { min: 1_000, max: 120_000 });
const EVIDENCE_FETCH_MAX_BYTES = intEnv(env, "EVIDENCE_FETCH_MAX_BYTES", 25_000_000, { min: 1_000_000, max: 50_000_000 });
const EVIDENCE_FETCH_MAX_REDIRECTS = intEnv(env, "EVIDENCE_FETCH_MAX_REDIRECTS", 4, { min: 0, max: 8 });
const EVIDENCE_CACHE_TTL_MS = intEnv(env, "EVIDENCE_CACHE_TTL_MS", 86_400_000, { min: 0, max: 2_592_000_000 });
const PRICE_REPOSITORY = resolvePriceRepositoryPaths({ runtimeRoot: env.PRICE_RUNTIME_ROOT || env.RUNTIME_ROOT || `${process.cwd()}/runtime` });
if (!["deepseek-ocr", "tesseract"].includes(TRANSACTION_OCR_PROVIDER)) throw new Error("TRANSACTION_OCR_PROVIDER must be deepseek-ocr or tesseract");
const LEGACY_CATALOG_MIGRATION = await migrateLegacyCatalogRepository(CATALOG_REPOSITORY);
if (LEGACY_CATALOG_MIGRATION.status === "dry_run") throw new Error("Legacy runtime catalog requires explicit catalog-user-data-v1 isolation and active-generation migration apply");
const LEGACY_DOMAIN_MIGRATION = await migrateLegacyDomainRepository({ coordinator: RUNTIME_COORDINATOR, generationAware: true });
if (LEGACY_DOMAIN_MIGRATION.status === "dry_run") throw new Error("Legacy runtime domain registry requires explicit active-generation migration apply with the dry-run source hash");
await initializeRuntimeCatalog(CATALOG_REPOSITORY);
await initializePriceRepository(PRICE_REPOSITORY);
await activateOfficialRegistryRepository({ coordinator: RUNTIME_COORDINATOR, generationAware: true });
const CATALOG_JOB_REPOSITORY = await initializeCatalogJobs({ coordinator: RUNTIME_COORDINATOR });
await resumeAdviceJobs({ coordinator: RUNTIME_COORDINATOR, flags: await loadRuntimeFlags() });
const CATALOG_RECOVERY_RESULTS = await withCatalogWrite(CATALOG_REPOSITORY, async (paths) => recoverPendingDrafts({ ...catalogWriteOptions(paths), catalogWriteEnabled: true }));
const blockedCatalogRecovery = CATALOG_RECOVERY_RESULTS.find((result) => result.status !== "confirmed");
if (blockedCatalogRecovery) throw new Error(`Unable to recover pending catalog confirmation: ${(blockedCatalogRecovery.reasons ?? [blockedCatalogRecovery.status]).join("; ")}`);

async function loadCatalog() {
  return loadMergedCatalog(CATALOG_REPOSITORY);
}

async function retainAcceptedCatalogResult(result, paths) {
  if (resultRequiresRuntimeCatalogRetention(result) && !result.runtimeCatalogRetained) {
    await markRuntimeCatalogSkuAccepted(result.skuId, { ...paths, direct: true, generationAware: false });
  }
  return result;
}

async function withGovernedCatalogMutation(extra, operation, candidateId = null) {
  return withCatalogWrite(CATALOG_REPOSITORY, async (paths) => {
    const catalog = await loadMergedCatalog({ ...paths, direct: true, generationAware: false });
    const candidate = candidateId === null ? undefined
      : /^catalog-candidate-[a-f0-9]{16}$/.test(candidateId) ? await CATALOG_JOB_REPOSITORY.findCandidateAt(paths.activeRoot, candidateId) : null;
    const result = await operation({ ...catalogWriteOptions(paths, catalog), ...extra, ...(candidateId === null ? {} : { candidate }) });
    return retainAcceptedCatalogResult(result, paths);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendImage(res, payload) {
  const safeName = String(payload.fileName ?? "transaction-screenshot").replace(/[\r\n"]/g, "_").slice(0, 160);
  res.writeHead(200, {
    "Content-Type": payload.mimeType,
    "Content-Length": payload.buffer.byteLength,
    "Content-Disposition": `inline; filename="${safeName}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload.buffer);
}

function sendEvidenceContent(req, res, result) {
  if (matchesEvidenceEtag(req.headers["if-none-match"], result.headers.ETag)) {
    res.writeHead(304, { ETag: result.headers.ETag, "Cache-Control": result.headers["Cache-Control"] });
    res.end();
    return;
  }
  res.writeHead(result.status, result.headers);
  res.end(result.binary);
}

async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleState() {
  const [catalog, priceState, availability] = await Promise.all([
    loadCatalog(),
    readActivePriceState(today(), PRICE_REPOSITORY),
    channelAvailability(),
  ]);
  const { latest, manual, local, candidates, fx } = priceState;

  return {
    asOf: latest?.asOf ?? null,
    snapshotMeta: latest ? {
      schemaVersion: latest.schemaVersion,
      snapshotId: latest.snapshotId ?? null,
      inputHash: latest.inputHash ?? null,
      contentHash: latest.contentHash ?? null,
      catalogVersion: latest.catalogVersion ?? null,
      priceVersion: latest.priceVersion ?? null,
      generatedAt: latest.generatedAt ?? null,
    } : null,
    runtimeGeneration: priceState.runtimeGeneration,
    runtimeRevision: priceState.runtimeRevision,
    channels: CHANNELS,
    availability,
    fx,
    counts: { manual: manual.length, local: local.length, latest: latest?.quotes?.length ?? 0 },
    localQuotes: local,
    candidates: candidates?.candidates ?? [],
    trackableSkus: catalog.skus.filter(isPriceTrackable).map((s) => ({
      id: s.id,
      name: s.name,
      mpn: s.mpn,
      category: s.category,
      queries: buildSearchQueries(s),
    })),
  };
}

async function handleCollect(body) {
  const catalog = await loadCatalog();
  const requested = Array.isArray(body.skuIds) ? body.skuIds : null;
  const channels = Array.isArray(body.channels) && body.channels.length ? body.channels : CHANNELS;
  const limit = Number.isFinite(body.limit) ? Math.min(10, Math.max(1, body.limit)) : 5;

  const targets = catalog.skus.filter(
    (s) => isPriceTrackable(s) && (!requested || requested.includes(s.id)),
  );
  if (targets.length === 0) {
    return {
      asOf: today(),
      results: [],
      candidates: [],
      note: "没有可查价的 SKU：需要 mpn 或 attrs.searchTerms",
    };
  }

  const fx = await loadFx(PRICE_REPOSITORY);
  const results = [];
  const candidates = [];
  for (const sku of targets) {
    const perChannel = await collectForSku(sku, { channels, limit, fx });
    for (const r of perChannel) {
      results.push({
        skuId: sku.id,
        channel: r.channel,
        status: r.status,
        via: r.via ?? null,
        reason: r.reason ?? null,
        searchUrl: r.searchUrl ?? null,
        count: r.candidates.length,
      });
      candidates.push(...r.candidates);
    }
  }

  const payload = {
    schemaVersion: "1.0.0",
    asOf: today(),
    note: "抓取候选，evidence 一律 unknown；需在页面核对料号后确认入账。",
    results,
    candidates,
  };
  return saveCandidates(payload, today(), PRICE_REPOSITORY);
}

/**
 * Resolve one listing's variant prices and remember them on the candidate row, so
 * the answer survives a reload and the human can see which option was priced.
 */
async function handleVariants(body) {
  const file = await loadCandidates(today(), PRICE_REPOSITORY);
  const requestedUrl = String(body.url ?? "");
  const requestedChannel = String(body.channel ?? "");
  if (!requestedUrl || !requestedChannel) throw new Error("url 与 channel 必填");
  const key = listingKey(requestedUrl);
  const row = file?.candidates?.find((candidate) => listingKey(candidate.url) === key && candidate.channel === requestedChannel);
  if (!row) throw new Error("variant resolution requires a server-captured listing candidate");
  const result = await resolveVariants({ channel: row.channel, url: row.url, limit: 24 });
  row.variants = result.variants ?? [];
  row.variantSource = result.source ?? null;
  row.variantNotes = result.notes ?? [];
  row.variantStatus = result.status;
  await saveCandidates(file, today(), PRICE_REPOSITORY);
  return result;
}

async function handleAudit(body) {
  const catalog = await loadCatalog();
  const capture = await loadListingCapture(body?.listingCaptureId, PRICE_REPOSITORY);
  const row = await upsertLocalQuote(buildAuditedQuoteFromCapture(body, catalog, capture, {
    isOfficialUrl: (value) => Boolean(registryForUrl(value, activeOfficialRegistry())),
  }), PRICE_REPOSITORY);
  const snapshot = await buildAndWriteLatest(today(), undefined, { ...PRICE_REPOSITORY, catalog });
  return { saved: row, asOf: snapshot.asOf, quoteCount: snapshot.quotes.length };
}

async function handleUnaudit(url) {
  const skuId = url.searchParams.get("skuId");
  if (!skuId) throw new Error("skuId is required");
  const variantLabel = url.searchParams.has("variantLabel") ? url.searchParams.get("variantLabel") ?? "" : undefined;
  const removed = await removeLocalQuote(skuId, url.searchParams.get("platform") ?? undefined, variantLabel, PRICE_REPOSITORY);
  const snapshot = await buildAndWriteLatest(today(), undefined, { ...PRICE_REPOSITORY, catalog: await loadCatalog() });
  return { removed, asOf: snapshot.asOf, quoteCount: snapshot.quotes.length };
}

async function handleDraftConfirmation(draftId, body = {}) {
  const flags = await loadRuntimeFlags();
  const result = await withGovernedCatalogMutation({
    expectedHash: body.expectedHash,
    approved: body.approved,
    catalogWriteEnabled: flags.catalogWriteEnabled,
  }, (options) => confirmDraft(draftId, options));
  return { status: result.status === "blocked" ? 409 : 200, result };
}

async function handleDraftRejection(draftId, body = {}) {
  const result = await withGovernedCatalogMutation({
    expectedHash: body.expectedHash,
    approved: body.approved,
  }, (options) => rejectDraft(draftId, options));
  return { status: result.status === "blocked" ? 409 : 200, result };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === "GET /api/price/health") return send(res, 200, { ok: true, port: PORT });
    if (url.pathname.startsWith("/api/evidence/")) {
      const rejected = req.method === "POST" ? checkEvidencePostRequest(req.headers) : null;
      if (rejected) return send(res, rejected.status, rejected.payload);
      const body = req.method === "POST" ? await readBody(req) : {};
      const result = await handleEvidenceRoute(req.method, url.pathname, body, EVIDENCE_REPOSITORY, {
        catalog: req.method === "POST" ? await loadCatalog() : undefined,
        acquisitionOptions: {
          cacheTtlMs: EVIDENCE_CACHE_TTL_MS,
          maxBytes: EVIDENCE_FETCH_MAX_BYTES,
          fetchOptions: { timeoutMs: EVIDENCE_FETCH_TIMEOUT_MS, maxRedirects: EVIDENCE_FETCH_MAX_REDIRECTS },
        },
        discoveryOptions: {
          fetchOptions: { timeoutMs: EVIDENCE_FETCH_TIMEOUT_MS, maxBytes: EVIDENCE_FETCH_MAX_BYTES, maxRedirects: EVIDENCE_FETCH_MAX_REDIRECTS },
        },
      });
      if (result.binary) return sendEvidenceContent(req, res, result);
      return send(res, result.status, result.payload);
    }
    if (route === "GET /api/price/catalog") {
      const [catalog, flags] = await Promise.all([loadCatalog(), loadRuntimeFlags()]);
      return send(res, 200, { ...sanitizeMergedCatalog(catalog), writeEnabled: flags.catalogWriteEnabled });
    }
    const transactionArchiveOptions = TRANSACTION_ARCHIVE_ROOT ? { root: TRANSACTION_ARCHIVE_ROOT } : { coordinator: RUNTIME_COORDINATOR };
    if (route === "GET /api/price/transactions/archive") return send(res, 200, { records: await listTransactionArchives(transactionArchiveOptions) });
    if (route === "POST /api/price/transactions/archive") {
      const body = await readBody(req, TRANSACTION_BODY_MAX_BYTES);
      return send(res, 201, await archiveTransaction(body, transactionArchiveOptions));
    }
    const transactionImageMatch = url.pathname.match(/^\/api\/price\/transactions\/archive\/([^/]+)\/image$/);
    if (transactionImageMatch && req.method === "GET") {
      const image = await readTransactionImage(decodeURIComponent(transactionImageMatch[1]), transactionArchiveOptions);
      return image ? sendImage(res, image) : send(res, 404, { error: "transaction screenshot not found" });
    }
    if (transactionImageMatch && req.method === "DELETE") return send(res, 200, await deleteTransactionImage(decodeURIComponent(transactionImageMatch[1]), transactionArchiveOptions));
    const transactionArchiveMatch = url.pathname.match(/^\/api\/price\/transactions\/archive\/([^/]+)$/);
    if (transactionArchiveMatch && req.method === "PATCH") return send(res, 200, await updateTransactionArchive(decodeURIComponent(transactionArchiveMatch[1]), await readBody(req), transactionArchiveOptions));
    if (transactionArchiveMatch && req.method === "DELETE") return send(res, 200, await deleteTransactionArchive(decodeURIComponent(transactionArchiveMatch[1]), transactionArchiveOptions));
    if (route === "POST /api/price/transactions/analyze") {
      const body = await readBody(req, TRANSACTION_BODY_MAX_BYTES);
      const catalog = await loadCatalog();
      const analysis = await analyzeTransactionScreenshot(body, {
        catalog,
        provider: TRANSACTION_OCR_PROVIDER,
        timeoutMs: TRANSACTION_OCR_TIMEOUT_MS,
        apiUrl: env.DEEPSEEK_OCR_API_URL || env.DEEPSEEK_API_URL || "https://api.deepseek.com",
        apiKey: env.DEEPSEEK_OCR_API_KEY || env.DEEPSEEK_API_KEY || "",
        model: env.DEEPSEEK_OCR_MODEL || "deepseek-v4-flash-vision-exp",
        maxTokens: DEEPSEEK_OCR_MAX_TOKENS,
      });
      // OCR is deliberately read-only. The client lets the user correct the
      // detected identity/category before starting any external catalog search.
      return send(res, 200, { ...analysis, catalogSearch: null });
    }
    if (route === "POST /api/price/transactions/catalog-search") {
      const body = await readBody(req);
      const catalog = await loadCatalog();
      const transactionDiscoveryMode = env.TRANSACTION_CATALOG_DISCOVERY_PROVIDER || "searxng";
      if (!["registry", "searxng"].includes(transactionDiscoveryMode)) throw new Error("TRANSACTION_CATALOG_DISCOVERY_PROVIDER must be registry or searxng");
      const discoveryProviders = [
        new CatalogCacheDiscoveryProvider(catalog),
        new MsiProductDiscoveryProvider(),
        ...(transactionDiscoveryMode === "searxng" ? [createSearXngDiscoveryProvider(env)] : []),
        new RegistrySearchDiscoveryProvider(),
      ];
      return send(res, 202, await queueSearch(transactionCatalogSearchRequest(body), { discoveryProviders, catalog, coordinator: RUNTIME_COORDINATOR, browserFallback: renderOfficialFallback, browserFallbackLimit: 2 }));
    }
    if (route === "POST /api/catalog/search") {
      const body = await readBody(req);
      const catalog = await loadCatalog();
      const discoveryMode = env.CATALOG_DISCOVERY_PROVIDER || "registry";
      if (!["registry", "searxng"].includes(discoveryMode)) throw new Error("CATALOG_DISCOVERY_PROVIDER must be registry or searxng");
      const discoveryProviders = [
        new CatalogCacheDiscoveryProvider(catalog),
        new MsiProductDiscoveryProvider(),
        ...(discoveryMode === "searxng" ? [createSearXngDiscoveryProvider(env)] : []),
        new RegistrySearchDiscoveryProvider(),
      ];
      return send(res, 202, await queueSearch(body, { discoveryProviders, catalog, coordinator: RUNTIME_COORDINATOR, browserFallback: renderOfficialFallback, browserFallbackLimit: 2 }));
    }
    if (route === "POST /api/advice/build") {
      const flags = await loadRuntimeFlags();
      const job = await createAdviceJob(await readBody(req), { flags, coordinator: RUNTIME_COORDINATOR });
      return send(res, job.status === "advice-unavailable" ? 503 : job.status === "disabled" ? 200 : 202, job);
    }
    if (route === "GET /api/advice/billing") {
      return send(res, 200, await getAdviceBillingSummary({ limit: url.searchParams.get("limit") ?? 100, coordinator: RUNTIME_COORDINATOR }));
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/advice/build/")) {
      const requestId = decodeURIComponent(url.pathname.slice("/api/advice/build/".length));
      const job = await getAdviceJob(requestId, { coordinator: RUNTIME_COORDINATOR });
      return job ? send(res, 200, job) : send(res, 404, { error: "advice job not found" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/catalog/search/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/catalog/search/".length));
      const job = await getJob(id, { coordinator: RUNTIME_COORDINATOR });
      return job ? send(res, 200, job) : send(res, 404, { error: "catalog search job not found" });
    }
    if (route === "POST /api/catalog/inspect") {
      const result = await inspectUrl(await readBody(req), { browserFallback: renderOfficialFallback });
      return send(res, 200, result);
    }
    if (route === "GET /api/catalog/domain-proposals") return send(res, 200, await listDomainProposals({ coordinator: RUNTIME_COORDINATOR, generationAware: true }));
    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/domain-proposals/") && (url.pathname.endsWith("/approve") || url.pathname.endsWith("/reject"))) {
      const approve = url.pathname.endsWith("/approve");
      const suffix = approve ? "/approve" : "/reject";
      const proposalId = decodeURIComponent(url.pathname.slice("/api/catalog/domain-proposals/".length, -suffix.length));
      const body = await readBody(req);
      return send(res, 200, await decideDomainProposal(proposalId, approve ? "approved" : "rejected", body.expectedHash, { coordinator: RUNTIME_COORDINATOR, generationAware: true }));
    }
    const priceCatalogCandidateMatch = url.pathname.match(/^\/api\/price\/catalog\/candidates\/([^/]+)\/(review|draft)$/);
    if (req.method === "POST" && priceCatalogCandidateMatch?.[1] && priceCatalogCandidateMatch[2]) {
      const candidateId = decodeURIComponent(priceCatalogCandidateMatch[1]);
      const body = await readBody(req);
      const flags = await loadRuntimeFlags();
      const result = await withGovernedCatalogMutation({ expectedHash: body.expectedHash, expectedDraftHash: body.expectedDraftHash }, (options) => priceCatalogCandidateMatch[2] === "review"
        ? previewDraft(candidateId, body.selections ?? {}, options)
        : createDraft(candidateId, body.selections ?? {}, options), candidateId);
      return send(res, result.status === "blocked" ? 409 : 200, { ...result, writeEnabled: flags.catalogWriteEnabled });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/candidates/") && url.pathname.endsWith("/review")) {
      const candidateId = decodeURIComponent(url.pathname.slice("/api/catalog/candidates/".length, -"/review".length));
      const body = await readBody(req);
      const flags = await loadRuntimeFlags();
      const result = await withGovernedCatalogMutation({ expectedHash: body.expectedHash }, (options) => previewDraft(candidateId, body.selections ?? {}, options), candidateId);
      return send(res, result.status === "blocked" ? 409 : 200, { ...result, writeEnabled: flags.catalogWriteEnabled });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/candidates/") && url.pathname.endsWith("/enrich")) {
      const candidateId = decodeURIComponent(url.pathname.slice("/api/catalog/candidates/".length, -"/enrich".length));
      const flags = await loadRuntimeFlags();
      const body = await readBody(req);
      const result = await withGovernedCatalogMutation({ expectedHash: body.expectedHash, autoEnrichTrustedOfficial: flags.catalogAutoEnrichTrustedOfficial, autoAcceptExactMpn: flags.catalogAutoAcceptExactMpn, catalogWriteEnabled: flags.catalogWriteEnabled }, (options) => runAutoEnrichment(candidateId, options), candidateId);
      return send(res, result.status === "accepted" || result.status === "draft" ? 200 : 409, result);
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/candidates/") && url.pathname.endsWith("/accept-official")) {
      const candidateId = decodeURIComponent(url.pathname.slice("/api/catalog/candidates/".length, -"/accept-official".length));
      const flags = await loadRuntimeFlags();
      const body = await readBody(req);
      const result = await withGovernedCatalogMutation({ expectedHash: body.expectedHash, approved: body.approved, catalogWriteEnabled: flags.catalogWriteEnabled }, (options) => acceptOfficial(candidateId, options), candidateId);
      return send(res, result.status === "accepted" ? 200 : 409, result);
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/candidates/") && url.pathname.endsWith("/draft")) {
      const candidateId = decodeURIComponent(url.pathname.slice("/api/catalog/candidates/".length, -"/draft".length));
      const body = await readBody(req);
      const result = await withGovernedCatalogMutation({ expectedHash: body.expectedHash, expectedDraftHash: body.expectedDraftHash }, (options) => createDraft(candidateId, body.selections ?? {}, options), candidateId);
      return send(res, result.status === "blocked" ? 409 : 200, result);
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/drafts/") && url.pathname.endsWith("/confirm")) {
      const draftId = decodeURIComponent(url.pathname.slice("/api/catalog/drafts/".length, -"/confirm".length));
      const handled = await handleDraftConfirmation(draftId, await readBody(req));
      return send(res, handled.status, handled.result);
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/drafts/") && url.pathname.endsWith("/reject")) {
      const draftId = decodeURIComponent(url.pathname.slice("/api/catalog/drafts/".length, -"/reject".length));
      const handled = await handleDraftRejection(draftId, await readBody(req));
      return send(res, handled.status, handled.result);
    }
    const transactionDraftMatch = url.pathname.match(/^\/api\/price\/transactions\/catalog-drafts\/([^/]+)\/(confirm|reject)$/);
    if (req.method === "POST" && transactionDraftMatch?.[1] && transactionDraftMatch[2]) {
      const draftId = decodeURIComponent(transactionDraftMatch[1]);
      const body = await readBody(req);
      const handled = transactionDraftMatch[2] === "confirm"
        ? await handleDraftConfirmation(draftId, body)
        : await handleDraftRejection(draftId, body);
      return send(res, handled.status, handled.result);
    }
    const priceDraftMatch = url.pathname.match(/^\/api\/price\/catalog-drafts\/([^/]+)\/(confirm|reject)$/);
    if (req.method === "POST" && priceDraftMatch?.[1] && priceDraftMatch[2]) {
      const draftId = decodeURIComponent(priceDraftMatch[1]);
      const body = await readBody(req);
      const handled = priceDraftMatch[2] === "confirm"
        ? await handleDraftConfirmation(draftId, body)
        : await handleDraftRejection(draftId, body);
      return send(res, handled.status, handled.result);
    }
    if (route === "GET /api/price/state") return send(res, 200, await handleState());
    if (route === "POST /api/price/collect") return send(res, 200, await handleCollect(await readBody(req)));
    if (route === "POST /api/price/variants") return send(res, 200, await handleVariants(await readBody(req)));
    if (route === "POST /api/price/audit") return send(res, 200, await handleAudit(await readBody(req)));
    if (route === "DELETE /api/price/audit") return send(res, 200, await handleUnaudit(url));
    if (route === "POST /api/price/rebuild") {
      const snapshot = await buildAndWriteLatest(today(), undefined, { ...PRICE_REPOSITORY, catalog: await loadCatalog() });
      return send(res, 200, { asOf: snapshot.asOf, quoteCount: snapshot.quotes.length });
    }
    return send(res, 404, { error: `No route for ${route}` });
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`price server → http://${HOST}:${PORT}/api/price/state`);
  console.log("首次抓淘宝/拼多多前先跑：npm run price:login");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await browser.closeBrowser();
    server.close(() => process.exit(0));
  });
}
