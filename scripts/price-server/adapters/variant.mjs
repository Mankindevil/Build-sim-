/**
 * Variant-level prices from a listing's detail page.
 *
 * A search card shows one number for a listing that may sell four different
 * products. A real capture of `乔思伯 N6 机箱` returned ¥579 for a listing whose
 * variants are N6 nine-bay / N3 eight-bay / N5 twelve-bay / N2 five-bay — ¥579 is
 * the cheapest one (N2), so even a perfectly parsed card price is not our SKU's
 * price. The only place a per-variant price exists is the detail page's variant
 * table, so that is what this module reads.
 *
 * Order of attempts, first hit wins, and each result records which one produced it:
 *   1. the JSON the page itself fetched (Taobao mtop / PDD rawData / JD price API)
 *   2. JSON embedded in the HTML
 *   3. clicking each option like a human and reading the price that appears
 * If all three fail the answer is `unknown`. Nothing here infers a price.
 */

/** Detail-page XHRs worth keeping, per browser channel. */
export const VARIANT_XHR_RE = {
  taobao: /mtop\.(?:taobao|tmall)\.[\w.]*(?:pcdetail|detail)[\w.]*\.data\.get/i,
  pdd: /\/api\/(?:oak|checkout)\/.*goods|goods_detail/i,
  jd: /p\.3\.cn\/prices\/mgets|item-soa\.jd\.com\/getWareBusiness/i,
  amazon: /\/dp\/|\/gp\/product\//i,
  amazon_cn: /\/dp\/|\/gp\/product\//i,
};

/**
 * A price or null. The sign has to be part of the match: JD answers `-1.00` when a
 * price is withheld, and dropping the minus would turn that into a ¥1 product.
 */
const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const m = String(v ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Taobao / Tmall detail payload: `skuBase` names the options, `skuCore.sku2info`
 * prices them. Labels are rebuilt from `propPath` so the caller sees the same
 * wording a shopper sees ("n6 中型钢板机箱9盘位热插拔").
 */
export function parseTaobaoDetail(payload) {
  const data = payload?.data ?? payload;
  const base = data?.skuBase;
  const info = data?.skuCore?.sku2info;
  if (!base?.skus || !info) return null;

  const valueName = new Map();
  for (const prop of base.props ?? []) {
    for (const value of prop.values ?? []) {
      valueName.set(`${prop.pid}:${value.vid}`, value.name ?? value.vid);
    }
  }

  const variants = [];
  for (const sku of base.skus) {
    const entry = info[sku.skuId];
    if (!entry) continue;
    const amount = num(entry.price?.priceText ?? entry.price?.priceMoney ?? entry.price);
    const label = String(sku.propPath ?? "")
      .split(";")
      .filter(Boolean)
      .map((pair) => valueName.get(pair) ?? pair)
      .join(" / ");
    variants.push({
      skuId: String(sku.skuId),
      label: label || `skuId ${sku.skuId}`,
      amount,
      currency: "CNY",
      stock: num(entry.quantity) ?? null,
    });
  }
  return variants.length > 0 ? { variants, source: "taobao:skuCore" } : null;
}

/** PDD embeds the whole goods object; prices are in fen. */
export function parsePddDetail(payload) {
  const goods = payload?.store?.initDataObj?.goods ?? payload?.goods ?? payload;
  const skus = goods?.skus;
  if (!Array.isArray(skus) || skus.length === 0) return null;
  const variants = skus.map((sku) => {
    const fen = num(sku.groupPrice ?? sku.price ?? sku.normalPrice);
    const label = (sku.specs ?? [])
      .map((s) => `${s.spec_key ?? s.specKey ?? ""} ${s.spec_value ?? s.specValue ?? ""}`.trim())
      .filter(Boolean)
      .join(" / ");
    return {
      skuId: String(sku.skuId ?? sku.sku_id ?? ""),
      label: label || `skuId ${sku.skuId ?? ""}`,
      amount: fen === null ? null : fen / 100,
      currency: "CNY",
      stock: num(sku.quantity) ?? null,
    };
  });
  return { variants, source: "pdd:rawData" };
}

/** JD sells each variant as its own skuId, so the price API is the whole answer. */
export function parseJdPrices(payload, label) {
  const rows = Array.isArray(payload) ? payload : payload?.p ? [payload] : null;
  if (!rows) return null;
  const variants = rows
    .map((row) => ({
      skuId: String(row.id ?? "").replace(/^J_/, ""),
      label,
      amount: num(row.p),
      currency: "CNY",
      stock: null,
    }))
    .filter((v) => v.amount !== null);
  return variants.length > 0 ? { variants, source: "jd:prices" } : null;
}

/**
 * Identify a listing independently of tracking parameters. Search results carry a
 * long `spm` / `mi_id` / `priceTId` tail, so two links to the same product rarely
 * match as strings and results must be keyed by the product id instead.
 */
export function listingKey(url) {
  const s = String(url ?? "");
  return (
    s.match(/item\.jd\.com\/(\d+)/)?.[1] ??
    s.match(/[?&](?:id|goods_id)=(\d+)/)?.[1] ??
    s.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/)?.[1] ??
    s
  );
}

/** JD's public price endpoint needs no session, so it runs without the browser. */
export async function fetchJdPrice(url, label = "") {
  const id = String(url).match(/item\.jd\.com\/(\d+)\.html/)?.[1];
  if (!id) return null;
  try {
    const res = await fetch(`https://p.3.cn/prices/mgets?skuIds=J_${id}`, {
      headers: { Referer: url, "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    return parseJdPrices(await res.json(), label || `京东 skuId ${id}`);
  } catch {
    return null;
  }
}

export function parseVariantPayload(channel, payload, label = "") {
  if (channel === "taobao") return parseTaobaoDetail(payload);
  if (channel === "pdd") return parsePddDetail(payload);
  if (channel === "jd") return parseJdPrices(payload, label);
  return null;
}

/**
 * Read JSON the page left in globals. Kept separate from the XHR path because
 * older Taobao pages ship `g_page_config` inline and never fetch anything.
 */
export function readEmbeddedJsonInPage() {
  const globals = ["g_page_config", "g_config", "rawData", "__INITIAL_DATA__", "__NEXT_DATA__"];
  const out = {};
  for (const key of globals) {
    try {
      const value = window[key];
      if (value && typeof value === "object") out[key] = JSON.parse(JSON.stringify(value));
    } catch {
      /* circular or blocked — skip */
    }
  }
  return out;
}

/**
 * Click each option of the first variant dimension and read the price that
 * appears. Slower and it mutates page state, but it survives API changes, and it
 * is the only path that works when the payload is signed or encrypted.
 *
 * Self-contained: this function is serialised into the page.
 */
export function clickVariantsInPage({ optionSelector, limit, settleMs }) {
  const CLUSTER_RE = /^([¥￥$€£])?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:元)?$/;
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const readPrice = () => {
    // Same rule as card extraction: the answer must be an element whose entire
    // text is a price, so a neighbouring sales figure cannot be absorbed.
    const scope =
      document.querySelector('[class*="Price"], [class*="price"], #corePriceDisplay_desktop_feature_div') ??
      document.body;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    let node = walker.nextNode();
    while (node) {
      if (/[¥￥$€£]/.test(node.nodeValue ?? "")) {
        let el = node.parentElement;
        let best = null;
        let hops = 0;
        while (el && hops < 4) {
          const m = norm(el.textContent).match(CLUSTER_RE);
          if (m) best = { amount: Number(m[2].replace(/,/g, "")), symbol: m[1] ?? "", text: norm(el.textContent) };
          else if (best) break;
          el = el.parentElement;
          hops++;
        }
        if (best && best.amount > 0) return best;
      }
      node = walker.nextNode();
    }
    return null;
  };

  /**
   * Class-name selectors match the option *and* the panel that holds it, and a
   * panel's text is every option concatenated — clicking it changes nothing while
   * looking like a variant called "商品规格切换大图模式n6…N3…N5…". Keep only
   * leaf-most, visibly small, plausibly-named nodes.
   */
  const collectOptions = () => {
    const matched = Array.from(document.querySelectorAll(optionSelector));
    const seen = new Set();
    const out = [];
    for (const el of matched) {
      if (matched.some((other) => other !== el && el.contains(other))) continue;
      if (el.offsetParent === null) continue;
      const label = norm(el.getAttribute("title") || el.textContent);
      if (label.length === 0 || label.length > 40) continue;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({ el, label });
      if (out.length >= limit) break;
    }
    return out;
  };

  return (async () => {
    const options = collectOptions();
    const out = [];
    for (const { el: option, label } of options) {
      try {
        option.scrollIntoView({ block: "center" });
        option.click();
      } catch {
        continue;
      }
      await sleep(settleMs);
      const price = readPrice();
      out.push({
        skuId: "",
        label,
        amount: price?.amount ?? null,
        currency: price?.symbol === "$" ? "USD" : price?.symbol ? "CNY" : null,
        priceText: price?.text ?? "",
        stock: null,
      });
    }
    return out;
  })();
}

/** Option elements that carry the variant names, per channel. */
export const OPTION_SELECTOR = {
  taobao:
    '[class*="valueItem"], [class*="skuItem"], [class*="SkuContent"] li, [class*="sku"] [class*="item"]',
  pdd: '[class*="spec"] span, [class*="sku"] li',
  jd: '#choose-attrs .item, [data-sku] .item',
  amazon: "#twister li, #variation_style_name li",
  amazon_cn: "#twister li, #variation_style_name li",
};

/**
 * Orchestrates the three attempts on an already-navigated detail page.
 * `captured` is whatever the response listener collected during navigation.
 */
export async function resolveVariantsOnPage(page, channel, captured = []) {
  const notes = [];
  const title = await page.title().catch(() => "");

  for (const payload of captured) {
    const hit = parseVariantPayload(channel, payload, title);
    if (hit) return { status: "ok", ...hit, notes };
  }
  if (captured.length > 0) notes.push(`拦到 ${captured.length} 个响应但结构不认识`);

  const embedded = await page.evaluate(readEmbeddedJsonInPage).catch(() => ({}));
  for (const [key, value] of Object.entries(embedded)) {
    const hit = parseVariantPayload(channel, value, title);
    if (hit) return { status: "ok", ...hit, source: `${hit.source}(${key})`, notes };
  }
  if (Object.keys(embedded).length > 0) notes.push(`页面内嵌 ${Object.keys(embedded).join("/")} 未命中已知结构`);

  const selector = OPTION_SELECTOR[channel];
  if (selector) {
    const clicked = await page
      .evaluate(clickVariantsInPage, { optionSelector: selector, limit: 12, settleMs: 900 })
      .catch((err) => {
        notes.push(`点选失败：${err.message}`);
        return [];
      });
    const variants = clicked.filter((v) => v.amount !== null);
    if (variants.length > 0) return { status: "ok", variants, source: "click", notes };
    if (clicked.length > 0) notes.push(`点了 ${clicked.length} 个规格但没读到价格`);
  }

  return {
    status: "unknown",
    variants: [],
    source: "none",
    notes: notes.length > 0 ? notes : ["详情页没有可解析的规格价格表"],
  };
}
