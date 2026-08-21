/**
 * Headed Playwright fallback. Login state persists in .cache/price-browser-profile
 * so you sign in once per marketplace; captchas are never bypassed — the window
 * stays open and the caller gets `needsLogin`.
 */

import path from "node:path";
import { searchUrlFor } from "../../../src/price/queries.mjs";
import { root } from "../store.mjs";

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

/** Scrape rendered cards: anchor to a product page plus the nearest yuan figure. */
export async function extractCandidates(page, channel, limit) {
  const selectorSets = {
    jd: { card: "li.gl-item", title: ".p-name em, .p-name a", price: ".p-price i, .p-price strong i" },
    taobao: { card: 'a[href*="item.taobao.com"], a[href*="detail.tmall.com"]', title: null, price: null },
    pdd: { card: 'a[href*="yangkeduo.com/goods"], a[href*="/goods.html"]', title: null, price: null },
    amazon: { card: "div[data-asin][data-component-type='s-search-result']", title: "h2", price: ".a-price .a-offscreen, .a-price-whole" },
    amazon_cn: { card: "div[data-asin][data-component-type='s-search-result']", title: "h2", price: ".a-price .a-offscreen, .a-price-whole" },
  };

  return page.evaluate(
    ({ sel, limit }) => {
      const parsePrice = (text) => {
        const m = String(text).replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
        return m ? Number(m[1]) : null;
      };
      const abs = (href) => {
        try {
          // JD emits protocol-relative hrefs like //item.jd.com/123.html
          return new URL(href.startsWith("//") ? `https:${href}` : href, location.href).href;
        } catch {
          return href;
        }
      };

      const out = [];
      const cards = Array.from(document.querySelectorAll(sel.card)).slice(0, limit * 4);
      for (const card of cards) {
        const anchor = card.matches("a") ? card : card.querySelector("a[href]");
        const url = anchor?.getAttribute("href") ? abs(anchor.getAttribute("href")) : "";
        if (!url) continue;

        let title = "";
        if (sel.title) title = card.querySelector(sel.title)?.textContent?.trim() ?? "";
        if (!title) title = (card.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160);

        let priceText = "";
        if (sel.price) priceText = card.querySelector(sel.price)?.textContent ?? "";
        if (!priceText) {
          const host = card.closest("div, li") ?? card;
          const m = (host.textContent ?? "").match(/[￥¥]\s*\d+(?:[.,]\d+)?/);
          priceText = m ? m[0] : "";
        }

        const priceCny = priceText ? parsePrice(priceText) : null;
        if (!title) continue;
        if (out.some((c) => c.url === url)) continue;
        out.push({ title, priceCny, url });
        if (out.length >= limit) break;
      }
      return out;
    },
    { sel: selectorSets[channel] ?? selectorSets.jd, limit },
  );
}

export async function collect({ channel, query, limit = 5 }) {
  if (!SUPPORTED.has(channel)) {
    return { status: "unavailable", reason: `浏览器适配器不支持渠道 ${channel}` };
  }
  const searchUrl = searchUrlFor(channel, query);
  if (!searchUrl) return { status: "unavailable", reason: "无法构造搜索链接" };

  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);

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
