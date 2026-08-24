#!/usr/bin/env node
/**
 * Local-only price collector. Binds 127.0.0.1 so nothing is exposed to the network;
 * the Vite dev server proxies /api/price here.
 *
 *   npm run price:serve
 */

import http from "node:http";
import { decideDomainProposal, listDomainProposals } from "./catalog/domain-proposals.mjs";
import { runAutoEnrichment } from "./catalog/auto-enrichment.mjs";
import {
  buildAndWriteLatest,
  loadCandidates,
  loadCatalog,
  loadLocalQuotes,
  loadManualQuotes,
  readJson,
  removeLocalQuote,
  saveCandidates,
  today,
  upsertLocalQuote,
  latestPath,
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
import { getJob, inspectUrl, queueSearch } from "./catalog/service.mjs";
import { renderOfficialFallback } from "./catalog/browser-fallback.mjs";
import { acceptOfficial, confirmDraft, createDraft, rejectDraft } from "./catalog/write.mjs";
import { loadRuntimeFlags } from "../runtime/flags.mjs";
import { buildAuditedQuote } from "./price-audit.mjs";
import { createAdviceJob, getAdviceBillingSummary, getAdviceJob } from "../deepseek/advice.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PRICE_SERVER_PORT ?? 5174);

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleState() {
  const [catalog, latest, manual, local, availability, candidates, fx] = await Promise.all([
    loadCatalog(),
    readJson(latestPath, null),
    loadManualQuotes(),
    loadLocalQuotes(),
    channelAvailability(),
    loadCandidates(today()),
    loadFx(),
  ]);

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

  const fx = await loadFx();
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
  await saveCandidates(payload);
  return payload;
}

/**
 * Resolve one listing's variant prices and remember them on the candidate row, so
 * the answer survives a reload and the human can see which option was priced.
 */
async function handleVariants(body) {
  const url = String(body.url ?? "");
  const channel = String(body.channel ?? "");
  if (!url || !channel) throw new Error("url 与 channel 必填");

  const result = await resolveVariants({ channel, url, limit: 24 });
  const file = await loadCandidates(today());
  const key = listingKey(url);
  if (file?.candidates) {
    for (const row of file.candidates) {
      if (listingKey(row.url) !== key) continue;
      row.variants = result.variants ?? [];
      row.variantSource = result.source ?? null;
      row.variantNotes = result.notes ?? [];
      row.variantStatus = result.status;
    }
    await saveCandidates(file);
  }
  return result;
}

async function handleAudit(body) {
  const catalog = await loadCatalog();
  const row = await upsertLocalQuote(buildAuditedQuote(body, catalog));
  const snapshot = await buildAndWriteLatest(today());
  return { saved: row, asOf: snapshot.asOf, quoteCount: snapshot.quotes.length };
}

async function handleUnaudit(url) {
  const skuId = url.searchParams.get("skuId");
  if (!skuId) throw new Error("skuId is required");
  const variantLabel = url.searchParams.has("variantLabel") ? url.searchParams.get("variantLabel") ?? "" : undefined;
  const removed = await removeLocalQuote(skuId, url.searchParams.get("platform") ?? undefined, variantLabel);
  const snapshot = await buildAndWriteLatest(today());
  return { removed, asOf: snapshot.asOf, quoteCount: snapshot.quotes.length };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === "GET /api/price/health") return send(res, 200, { ok: true, port: PORT });
    if (route === "POST /api/catalog/search") {
      const body = await readBody(req);
      return send(res, 202, queueSearch(body, { persistRoot: process.env.CATALOG_CANDIDATES_ROOT ?? process.cwd() }));
    }
    if (route === "POST /api/advice/build") {
      const flags = await loadRuntimeFlags();
      const job = await createAdviceJob(await readBody(req), { flags });
      return send(res, job.status === "advice-unavailable" ? 503 : job.status === "disabled" ? 200 : 202, job);
    }
    if (route === "GET /api/advice/billing") {
      return send(res, 200, await getAdviceBillingSummary({ limit: url.searchParams.get("limit") ?? 100 }));
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/advice/build/")) {
      const requestId = decodeURIComponent(url.pathname.slice("/api/advice/build/".length));
      const job = await getAdviceJob(requestId);
      return job ? send(res, 200, job) : send(res, 404, { error: "advice job not found" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/catalog/search/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/catalog/search/".length));
      const job = getJob(id);
      return job ? send(res, 200, job) : send(res, 404, { error: "catalog search job not found" });
    }
    if (route === "POST /api/catalog/inspect") {
      const result = await inspectUrl(await readBody(req), { browserFallback: renderOfficialFallback });
      return send(res, 200, result);
    }
    if (route === "GET /api/catalog/domain-proposals") return send(res, 200, await listDomainProposals({ persistRoot: process.cwd() }));
    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/domain-proposals/") && (url.pathname.endsWith("/approve") || url.pathname.endsWith("/reject"))) {
      const approve = url.pathname.endsWith("/approve");
      const suffix = approve ? "/approve" : "/reject";
      const proposalId = decodeURIComponent(url.pathname.slice("/api/catalog/domain-proposals/".length, -suffix.length));
      const body = await readBody(req);
      return send(res, 200, await decideDomainProposal(proposalId, approve ? "approved" : "rejected", body.expectedHash, { persistRoot: process.cwd() }));
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/candidates/") && url.pathname.endsWith("/enrich")) {
      const candidateId = decodeURIComponent(url.pathname.slice("/api/catalog/candidates/".length, -"/enrich".length));
      const flags = await loadRuntimeFlags();
      const result = await runAutoEnrichment(candidateId, { autoEnrichTrustedOfficial: flags.catalogAutoEnrichTrustedOfficial, autoAcceptExactMpn: flags.catalogAutoAcceptExactMpn, catalogWriteEnabled: flags.catalogWriteEnabled });
      return send(res, result.status === "accepted" || result.status === "draft" ? 200 : 409, result);
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/candidates/") && url.pathname.endsWith("/accept-official")) {
      const candidateId = decodeURIComponent(url.pathname.slice("/api/catalog/candidates/".length, -"/accept-official".length));
      const flags = await loadRuntimeFlags();
      const result = await acceptOfficial(candidateId, { ...(await readBody(req)), catalogWriteEnabled: flags.catalogWriteEnabled });
      return send(res, result.status === "accepted" ? 200 : 409, result);
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/candidates/") && url.pathname.endsWith("/draft")) {
      const candidateId = decodeURIComponent(url.pathname.slice("/api/catalog/candidates/".length, -"/draft".length));
      return send(res, 200, await createDraft(candidateId, (await readBody(req)).selections ?? {}));
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/drafts/") && url.pathname.endsWith("/confirm")) {
      const draftId = decodeURIComponent(url.pathname.slice("/api/catalog/drafts/".length, -"/confirm".length));
      const flags = await loadRuntimeFlags();
      return send(res, 200, await confirmDraft(draftId, { catalogWriteEnabled: flags.catalogWriteEnabled }));
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/drafts/") && url.pathname.endsWith("/reject")) {
      const draftId = decodeURIComponent(url.pathname.slice("/api/catalog/drafts/".length, -"/reject".length));
      return send(res, 200, await rejectDraft(draftId));
    }
    if (route === "GET /api/price/state") return send(res, 200, await handleState());
    if (route === "POST /api/price/collect") return send(res, 200, await handleCollect(await readBody(req)));
    if (route === "POST /api/price/variants") return send(res, 200, await handleVariants(await readBody(req)));
    if (route === "POST /api/price/audit") return send(res, 200, await handleAudit(await readBody(req)));
    if (route === "DELETE /api/price/audit") return send(res, 200, await handleUnaudit(url));
    if (route === "POST /api/price/rebuild") {
      const snapshot = await buildAndWriteLatest(today());
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
