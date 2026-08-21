#!/usr/bin/env node
/**
 * Local-only price collector. Binds 127.0.0.1 so nothing is exposed to the network;
 * the Vite dev server proxies /api/price here.
 *
 *   npm run price:serve
 */

import http from "node:http";
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
} from "./store.mjs";
import { CHANNELS, browser, channelAvailability, collectForSku } from "./adapters/index.mjs";
import { buildSearchQueries, isPriceTrackable } from "../../src/price/queries.mjs";

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
  const [catalog, latest, manual, local, availability, candidates] = await Promise.all([
    loadCatalog(),
    readJson(latestPath, null),
    loadManualQuotes(),
    loadLocalQuotes(),
    channelAvailability(),
    loadCandidates(today()),
  ]);

  return {
    asOf: latest?.asOf ?? null,
    channels: CHANNELS,
    availability,
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

  const results = [];
  const candidates = [];
  for (const sku of targets) {
    const perChannel = await collectForSku(sku, { channels, limit });
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

async function handleAudit(body) {
  const row = await upsertLocalQuote({ ...body, evidence: "audited" });
  const snapshot = await buildAndWriteLatest(today());
  return { saved: row, asOf: snapshot.asOf, quoteCount: snapshot.quotes.length };
}

async function handleUnaudit(url) {
  const skuId = url.searchParams.get("skuId");
  if (!skuId) throw new Error("skuId is required");
  const removed = await removeLocalQuote(skuId, url.searchParams.get("platform") ?? undefined);
  const snapshot = await buildAndWriteLatest(today());
  return { removed, asOf: snapshot.asOf, quoteCount: snapshot.quotes.length };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === "GET /api/price/health") return send(res, 200, { ok: true, port: PORT });
    if (route === "GET /api/price/state") return send(res, 200, await handleState());
    if (route === "POST /api/price/collect") return send(res, 200, await handleCollect(await readBody(req)));
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
