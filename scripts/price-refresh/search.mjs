#!/usr/bin/env node
/**
 * Multi-channel MPN web search → candidate quotes (not auto-audited).
 *
 * Usage:
 *   npm run price:search
 *   npm run price:search -- --sku=memory.corsair-cmk32gx5m2x6400c38
 *   npm run price:search -- --category=memory --fetch
 *
 * Channels: 京东 / 淘宝 / 拼多多 / 亚马逊中国 / Amazon / 官网
 * Default: search URLs only. --fetch tries fragile HTML hints (JD / Amazon).
 * Never writes audited prices into latest.json — promote via manual-quotes.json.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializePriceRepository, resolvePriceRepositoryPaths, writePriceSearchArtifacts } from "../price-server/store.mjs";
import {
  buildSearchQueries,
  buildSkuSearchLinks,
  channelToPlatform,
  pickOfficialUrl,
} from "../../src/price/queries.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const catalogPath = path.join(root, "data/skus/catalog.json");

function today() {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const out = { sku: null, asOf: today(), fetch: false, category: null };
  for (const a of argv) {
    if (a.startsWith("--sku=")) out.sku = a.slice("--sku=".length);
    else if (a.startsWith("--asOf=")) out.asOf = a.slice("--asOf=".length);
    else if (a.startsWith("--category=")) out.category = a.slice("--category=".length);
    else if (a === "--fetch") out.fetch = true;
  }
  return out;
}

async function loadJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

async function tryFetchPriceHint(url, channel) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    redirect: "follow",
  });
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  const html = await res.text();
  if (/验证码|captcha|anti-spider|访问受限/i.test(html) && html.length < 12000) {
    return { ok: false, reason: "blocked or login wall" };
  }

  let m = null;
  if (channel === "jd") {
    m =
      html.match(/"p":"(\d+(?:\.\d+)?)"/) ||
      html.match(/data-price="(\d+(?:\.\d+)?)"/) ||
      html.match(/￥\s*(\d+(?:\.\d+)?)/);
  } else if (channel === "amazon" || channel === "amazon_cn") {
    m =
      html.match(/class="a-price-whole"[^>]*>\s*(\d+)/) ||
      html.match(/￥\s*(\d+(?:\.\d+)?)/) ||
      html.match(/\$(\d+(?:\.\d+)?)/);
  } else {
    m = html.match(/￥\s*(\d+(?:\.\d+)?)/);
  }

  if (!m) return { ok: false, reason: "no price pattern" };
  const price = Number(m[1]);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: "invalid price" };
  return { ok: true, priceCny: price };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const priceRepository = resolvePriceRepositoryPaths({ runtimeRoot: process.env.PRICE_RUNTIME_ROOT ?? process.env.RUNTIME_ROOT ?? path.join(root, "runtime") });
  await initializePriceRepository(priceRepository);
  const catalog = await loadJson(catalogPath);
  const targets = catalog.skus.filter((s) => {
    if (!s.mpn) return false;
    if (args.sku && s.id !== args.sku) return false;
    if (args.category && s.category !== args.category) return false;
    return true;
  });

  if (targets.length === 0) {
    console.error("No SKUs with mpn matched filters.");
    process.exit(1);
  }

  const candidates = [];
  const report = [];

  for (const sku of targets) {
    const queries = buildSearchQueries(sku);
    const official = pickOfficialUrl(sku);
    const links = buildSkuSearchLinks(sku, official);
    report.push({ skuId: sku.id, mpn: sku.mpn, queries, links });

    for (const link of links) {
      const base = {
        skuId: sku.id,
        mpn: sku.mpn,
        query: link.query,
        platform: channelToPlatform(link.channel),
        channel: link.channel,
        searchUrl: link.url,
        match: "mpn",
        evidence: "unknown",
        currency: "CNY",
        note: `${link.label} search for “${link.query}” — open URL and verify title before auditing`,
      };

      const canFetch =
        args.fetch &&
        (link.channel === "jd" || link.channel === "amazon" || link.channel === "amazon_cn");

      if (canFetch) {
        try {
          const hint = await tryFetchPriceHint(link.url, link.channel);
          if (hint.ok) {
            candidates.push({
              ...base,
              priceCny: hint.priceCny,
              note: `${base.note}; fetch hint ¥${hint.priceCny} (unverified)`,
            });
            console.log(`[fetch] ${sku.id} ${link.label}: hint ¥${hint.priceCny}`);
          } else {
            candidates.push({
              ...base,
              priceCny: null,
              note: `${base.note}; fetch: ${hint.reason}`,
            });
            console.warn(`[fetch] ${sku.id} ${link.label}: ${hint.reason}`);
          }
        } catch (err) {
          candidates.push({
            ...base,
            priceCny: null,
            note: `${base.note}; fetch error: ${err.message}`,
          });
          console.warn(`[fetch] ${sku.id} ${link.label}: ${err.message}`);
        }
      } else {
        candidates.push({ ...base, priceCny: null });
      }
    }
  }

  const payload = {
    schemaVersion: "1.0.0",
    asOf: args.asOf,
    note:
      "MPN multi-channel search candidates. evidence stays unknown until you paste a verified quote into manual-quotes.json and run price:refresh.",
    fetched: args.fetch,
    candidates,
  };

  const mdLines = [
    `# Price search ${args.asOf}`,
    "",
    "料号搜索词用于京东 / 亚马逊 / 官网；淘宝拼多多按料号搜不到内存，用规格搜索词。",
    "打开链接 → 核对标题的品牌 / 容量 / 频率 / ECC 与料号 → 价格写入 active runtime 的 manual quote 流程 → `npm run price:refresh`。",
    "",
  ];
  for (const row of report) {
    mdLines.push(`## ${row.skuId}`);
    mdLines.push(`- MPN: \`${row.mpn}\``);
    if (row.queries.exact) mdLines.push(`- 料号搜索词: \`${row.queries.exact}\``);
    if (row.queries.spec.length) {
      mdLines.push(`- 规格搜索词: ${row.queries.spec.map((q) => `\`${q}\``).join(" / ")}`);
    }
    for (const link of row.links) {
      mdLines.push(`- [${link.label}](${link.url}) — \`${link.query}\``);
    }
    mdLines.push("");
  }
  const { jsonFile: outPath, markdownFile: mdPath } = await writePriceSearchArtifacts(payload, `${mdLines.join("\n")}\n`, args.asOf, priceRepository);

  console.log(`Wrote ${candidates.length} candidate row(s) → ${path.relative(root, outPath)}`);
  console.log(`Cheat sheet → ${path.relative(root, mdPath)}`);
  console.log("Next: verify listings, fill manual-quotes.json, npm run price:refresh");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
