/**
 * Channel orchestration: official API first, headed browser as fallback.
 * Every candidate comes back unaudited — scoring and confirmation happen in the UI.
 */

import { channelQueries, channelToPlatform, pickOfficialUrl } from "../../../src/price/queries.mjs";
import * as apiJd from "./api-jd.mjs";
import * as apiTaobao from "./api-taobao.mjs";
import * as apiPdd from "./api-pdd.mjs";
import * as officialPage from "./official-page.mjs";
import * as browser from "./browser.mjs";

export const CHANNELS = ["jd", "taobao", "pdd", "amazon", "official"];

/** Marketplaces throttle aggressively; one search every few seconds keeps pages served. */
const MIN_GAP_MS = 3000;
const COOLDOWN_MS = 5 * 60 * 1000;
const lastCallAt = new Map();
const cooldownUntil = new Map();

async function throttle(channel) {
  const prev = lastCallAt.get(channel) ?? 0;
  const wait = MIN_GAP_MS - (Date.now() - prev);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt.set(channel, Date.now());
}

function cooldownLeftMs(channel) {
  return Math.max(0, (cooldownUntil.get(channel) ?? 0) - Date.now());
}

/** Amazon has no usable official API here: Creators API needs an Associates account
 *  with recent qualifying sales, so the browser profile is the only route. */
const PLAN = {
  jd: { api: apiJd, browserChannel: "jd" },
  taobao: { api: apiTaobao, browserChannel: "taobao" },
  pdd: { api: apiPdd, browserChannel: "pdd" },
  amazon: { api: null, browserChannel: "amazon_cn", apiReason: "Amazon Creators API 需 Associates 资质，未接入" },
  official: { api: officialPage, browserChannel: null },
};

export async function channelAvailability() {
  const out = {};
  for (const channel of CHANNELS) {
    const plan = PLAN[channel];
    const api = plan.api ? await plan.api.availability() : { available: false, reason: plan.apiReason };
    const via = plan.browserChannel ? await browser.availability() : { available: false, reason: "该渠道不走浏览器" };
    out[channel] = {
      api,
      browser: via,
      available: api.available || via.available,
    };
  }
  return out;
}

function decorate(rows, { channel, sku, query }) {
  const fetchedAt = new Date().toISOString();
  return (rows ?? [])
    .filter((r) => r && r.title)
    .map((r) => ({
      skuId: sku.id,
      mpn: sku.mpn ?? "",
      query,
      channel,
      platform: channelToPlatform(channel),
      title: r.title,
      priceCny: typeof r.priceCny === "number" && r.priceCny > 0 ? r.priceCny : null,
      url: r.url ?? "",
      fetchedAt,
      evidence: "unknown",
      ...(r.note ? { note: r.note } : {}),
    }));
}

async function runChannel(channel, sku, limit) {
  const plan = PLAN[channel];
  if (!plan) return { channel, status: "unavailable", reason: `未知渠道 ${channel}`, candidates: [] };

  // Part number first on JD/official, spec words first on Taobao/PDD where MPNs
  // return unrelated industrial parts.
  const left = cooldownLeftMs(channel);
  if (left > 0) {
    return {
      channel,
      status: "unavailable",
      reason: `该渠道限流冷却中，还需 ${Math.ceil(left / 1000)} 秒`,
      candidates: [],
    };
  }

  // Two keyword variants at most: marketplaces throttle on search volume.
  const queries = channelQueries(channel, sku).slice(0, 2);
  if (queries.length === 0) {
    return { channel, status: "unavailable", reason: "该 SKU 缺少料号与规格，无法构造搜索词", candidates: [] };
  }

  const attempts = [];
  if (plan.api) {
    const av = await plan.api.availability();
    if (av.available) {
      attempts.push({
        via: "api",
        run: (query) => plan.api.collect({ query, limit, sku, officialUrl: pickOfficialUrl(sku) }),
        // Brand pages are a single URL; extra keyword variants would just refetch it.
        once: channel === "official",
      });
    } else {
      attempts.push({ via: "api", skip: av.reason });
    }
  } else if (plan.apiReason) {
    attempts.push({ via: "api", skip: plan.apiReason });
  }

  if (plan.browserChannel) {
    const av = await browser.availability();
    if (av.available) {
      attempts.push({
        via: "browser",
        run: (query) => browser.collect({ channel: plan.browserChannel, query, limit }),
      });
    } else {
      attempts.push({ via: "browser", skip: av.reason });
    }
  }

  const skipped = [];
  for (const attempt of attempts) {
    if (attempt.skip) {
      skipped.push(`${attempt.via}: ${attempt.skip}`);
      continue;
    }
    for (const query of attempt.once ? queries.slice(0, 1) : queries) {
      await throttle(channel);
      let result;
      try {
        result = await attempt.run(query);
      } catch (err) {
        skipped.push(`${attempt.via} «${query}»: ${err.message}`);
        continue;
      }
      if (result.status === "ok" && result.candidates?.length) {
        return {
          channel,
          status: "ok",
          via: attempt.via,
          query,
          candidates: decorate(result.candidates, { channel, sku, query }),
          ...(result.searchUrl ? { searchUrl: result.searchUrl } : {}),
        };
      }
      if (result.status === "rateLimited") {
        cooldownUntil.set(channel, Date.now() + COOLDOWN_MS);
        return {
          channel,
          status: "unavailable",
          via: attempt.via,
          query,
          reason: `${result.reason}，已暂停该渠道 5 分钟`,
          candidates: [],
          ...(result.searchUrl ? { searchUrl: result.searchUrl } : {}),
        };
      }
      if (result.status === "needsLogin") {
        return {
          channel,
          status: "needsLogin",
          via: attempt.via,
          query,
          reason: result.reason,
          candidates: [],
          ...(result.searchUrl ? { searchUrl: result.searchUrl } : {}),
        };
      }
      skipped.push(`${attempt.via} «${query}»: ${result.reason ?? result.status}`);
    }
  }

  return {
    channel,
    status: "unavailable",
    query: queries[0],
    reason: skipped.join("；") || "无可用适配器",
    candidates: [],
  };
}

export async function collectForSku(sku, { channels = CHANNELS, limit = 5 } = {}) {
  const results = [];
  for (const channel of channels) {
    results.push(await runChannel(channel, sku, limit));
  }
  return results;
}

export { browser };
