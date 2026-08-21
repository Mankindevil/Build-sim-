/**
 * Headed Playwright fallback. Login state persists in .cache/price-browser-profile
 * so you sign in once per marketplace; captchas are never bypassed — the window
 * stays open and the caller gets `needsLogin`.
 */

import path from "node:path";
import { searchUrlFor } from "../../../src/price/queries.mjs";
import { root } from "../store.mjs";
import { CARD_SELECTORS, extractCardsInPage } from "./extract-price.mjs";
import { VARIANT_XHR_RE, fetchJdPrice, resolveVariantsOnPage } from "./variant.mjs";

const PROFILE_DIR = path.join(root, ".cache/price-browser-profile");
const SUPPORTED = new Set(["jd", "taobao", "pdd", "amazon", "amazon_cn"]);

let contextPromise = null;

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

export async function availability() {
  const pw = await loadPlaywright();
  if (!pw) {
    return { available: false, reason: "未安装 playwright（npm i -D playwright && npx playwright install chromium）" };
  }
  return { available: true };
}

async function getContext() {
  if (contextPromise) return contextPromise;
  contextPromise = (async () => {
    const pw = await loadPlaywright();
    if (!pw) throw new Error("playwright unavailable");
    return pw.chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      args: ["--disable-blink-features=AutomationControlled"],
    });
  })();
  return contextPromise;
}

/**
 * A page from a context that is certainly alive. The cached context outlives the
 * window: closing the browser by hand (or another process taking the profile lock)
 * left every later request failing with "Target page, context or browser has been
 * closed" until the server was restarted.
 */
async function newPage() {
  try {
    return await (await getContext()).newPage();
  } catch (err) {
    if (!/closed|crash|disconnect/i.test(err.message)) throw err;
    contextPromise = null;
    return (await getContext()).newPage();
  }
}

export async function closeBrowser() {
  if (!contextPromise) return;
  try {
    const ctx = await contextPromise;
    await ctx.close();
  } catch {
    /* already gone */
  }
  contextPromise = null;
}

/**
 * Only a real wall counts. JD's header always renders “请登录” for anonymous
 * visitors while the results are perfectly readable, so generic sign-in wording
 * must not short-circuit a page that did return products.
 */
/**
 * Taobao's anonymous wording is 「亲，请登录」; JD's header says 「你好，请登录」 on
 * every page including served results, so a bare 请登录 must not count.
 */
function looksLikeChallenge(url, bodyText) {
  if (/passport\.|\/login|sec\.taobao\.com|_____tmd_____|captcha|\/verify/i.test(url)) return true;
  return /滑动验证|安全验证|请输入验证码|扫码登录|亲，?\s?请登录|请先登录|环境异常|访问受限/.test(
    bodyText.slice(0, 4000),
  );
}

/** Throttling is not a login wall: retrying later works, signing in does not. */
function looksRateLimited(bodyText) {
  return /访问频繁|请稍后再试|操作太快|系统繁忙/.test(bodyText.slice(0, 4000));
}

function looksEmpty(bodyText) {
  return /没有找到|无搜索结果|未找到相关|抱歉，没有找到/.test(bodyText.slice(0, 4000));
}

/** Words around the results area, so an unexplained miss can still be diagnosed. */
function bodyExcerpt(bodyText) {
  const flat = bodyText.replace(/\s+/g, " ").trim();
  const anchor = flat.search(/抱歉|没有找到|验证|登录后|结果/);
  const start = anchor > 60 ? anchor - 60 : 0;
  return flat.slice(start, start + 200);
}

/**
 * Scrape rendered cards. The extraction itself lives in `extract-price.mjs` so the
 * same function can be run against saved card HTML in tests — the old inline
 * version could only be exercised by hitting a live marketplace, which is why a
 * price/sales concatenation bug survived in it unnoticed.
 */
export async function extractCandidates(page, channel, limit) {
  return page.evaluate(extractCardsInPage, {
    sel: CARD_SELECTORS[channel] ?? CARD_SELECTORS.jd,
    limit,
  });
}

/**
 * Wait for the result cards rather than a fixed sleep. Taobao renders its grid
 * client-side and a 2.5 s pause regularly landed on 「加载中…」, which then looked
 * indistinguishable from a page that returned nothing.
 */
async function waitForCards(page, channel) {
  const selector = (CARD_SELECTORS[channel] ?? CARD_SELECTORS.jd).card;
  await page.waitForSelector(selector, { timeout: 15000 }).catch(() => {});
  // Prices arrive a beat after the anchors on lazily hydrated grids.
  await page.waitForTimeout(1200);
}

/** `npm run price:fixture` — save real card HTML so extraction has regression tests. */
export async function captureCardHtml({ channel, query, limit = 3 }) {
  if (!SUPPORTED.has(channel)) return { status: "unavailable", reason: `不支持渠道 ${channel}` };
  const searchUrl = searchUrlFor(channel, query);
  const page = await newPage();
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await waitForCards(page, channel);
    const cards = await page.evaluate(
      ({ selector, limit }) =>
        Array.from(document.querySelectorAll(selector))
          .slice(0, limit)
          .map((el) => el.outerHTML),
      { selector: (CARD_SELECTORS[channel] ?? CARD_SELECTORS.jd).card, limit },
    );
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
    await page.close();
    if (cards.length === 0) {
      return { status: "unavailable", reason: `未取到卡片，页面显示：${bodyExcerpt(bodyText)}`, searchUrl };
    }
    return { status: "ok", cards, searchUrl };
  } catch (err) {
    await page.close().catch(() => {});
    return { status: "error", reason: err.message, searchUrl };
  }
}

export async function collect({ channel, query, limit = 5 }) {
  if (!SUPPORTED.has(channel)) {
    return { status: "unavailable", reason: `浏览器适配器不支持渠道 ${channel}` };
  }
  const searchUrl = searchUrlFor(channel, query);
  if (!searchUrl) return { status: "unavailable", reason: "无法构造搜索链接" };

  const page = await newPage();
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await waitForCards(page, channel);

    const candidates = await extractCandidates(page, channel, limit);
    if (candidates.length > 0) {
      await page.close();
      return { status: "ok", candidates, searchUrl };
    }

    const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
    if (looksRateLimited(bodyText)) {
      await page.close();
      return { status: "rateLimited", reason: "站点限流（访问频繁）", searchUrl };
    }
    if (looksLikeChallenge(page.url(), bodyText)) {
      // Deliberately leave the tab open so the human can finish the challenge.
      return {
        status: "needsLogin",
        reason: `站点要求登录或验证，浏览器窗口已打开，处理完再抓一次。页面显示：${bodyExcerpt(bodyText)}`,
        searchUrl,
      };
    }

    if (looksEmpty(bodyText)) {
      await page.close();
      return { status: "unavailable", reason: "该搜索词在此站点没有结果", searchUrl };
    }

    await page.close();
    return {
      status: "unavailable",
      reason: `未取到商品卡片，页面显示：${bodyExcerpt(bodyText)}`,
      searchUrl,
    };
  } catch (err) {
    try {
      await page.close();
    } catch {
      /* ignore */
    }
    return { status: "error", reason: err.message, searchUrl };
  }
}

/**
 * Open one listing and read its per-variant prices. The response listener has to
 * be attached before navigation, which is why the capture lives here and the
 * parsing lives in `variant.mjs`.
 */
export async function resolveVariants({ channel, url, limit = 24 }) {
  if (!SUPPORTED.has(channel)) return { status: "unavailable", reason: `不支持渠道 ${channel}` };
  if (!/^https?:\/\//.test(url ?? "")) return { status: "unavailable", reason: "无效链接" };

  const page = await newPage();
  const captured = [];
  const wanted = VARIANT_XHR_RE[channel];
  page.on("response", async (res) => {
    if (!wanted || !wanted.test(res.url())) return;
    try {
      const type = res.headers()["content-type"] ?? "";
      if (!/json|javascript|text/.test(type)) return;
      const body = await res.text();
      // Taobao wraps mtop replies in a JSONP callback.
      const json = body.trim().startsWith("{")
        ? JSON.parse(body)
        : JSON.parse(body.replace(/^[^(]*\(/, "").replace(/\);?\s*$/, ""));
      captured.push(json);
    } catch {
      /* not parseable — the next attempt handles it */
    }
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
    if (looksRateLimited(bodyText)) {
      await page.close();
      return { status: "rateLimited", reason: "站点限流（访问频繁）" };
    }
    if (looksLikeChallenge(page.url(), bodyText)) {
      return {
        status: "needsLogin",
        reason: `详情页要求登录或验证，窗口已打开，处理完再解析一次。页面显示：${bodyExcerpt(bodyText)}`,
      };
    }

    const result = await resolveVariantsOnPage(page, channel, captured);
    if (result.status !== "ok" && (channel === "jd" || channel === "amazon")) {
      const viaApi = channel === "jd" ? await fetchJdPrice(url, await page.title()) : null;
      if (viaApi) {
        await page.close();
        return { status: "ok", ...viaApi, notes: result.notes ?? [] };
      }
    }
    await page.close();
    return { ...result, variants: (result.variants ?? []).slice(0, limit) };
  } catch (err) {
    await page.close().catch(() => {});
    return { status: "error", reason: err.message };
  }
}

/** `npm run price:login` — open each marketplace once and wait for you to sign in. */
export async function openForLogin(channels = ["jd", "taobao", "pdd"]) {
  const ctx = await getContext();
  for (const channel of channels) {
    const url = searchUrlFor(channel, "DDR5");
    if (!url) continue;
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  }
  return ctx;
}
