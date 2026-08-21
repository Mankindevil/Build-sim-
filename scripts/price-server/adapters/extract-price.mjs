/**
 * Price extraction from a rendered search-results page.
 *
 * Two failure modes drove this module's shape, both observed in real captures:
 *
 * 1. `textContent` concatenates sibling nodes with no separator, so a card whose
 *    price and sales count sit in adjacent spans reads as `¥69948人付款` — the old
 *    greedy regex returned 69948 for a ¥699 case. So the price is located
 *    *structurally*: find the yuan sign, then climb to the largest ancestor whose
 *    entire text is still nothing but a price. The sales count lives in a
 *    different subtree and therefore cannot be reached.
 * 2. A number read this way is still only the card's headline price, which on
 *    Taobao/PDD is the cheapest variant of the listing, not the variant we want.
 *    So this module never claims to return "the price of our SKU": it returns
 *    `kind: "from"` (起价), and variant resolution happens on the detail page.
 *
 * Anything ambiguous is reported as ambiguous. `amount: null` with a reason is a
 * valid, useful result here; a guessed number is not.
 *
 * `extractCardsInPage` is passed to `page.evaluate`, so it must stay entirely
 * self-contained — no imports, no module-scope references. It is exported as a
 * plain function so tests can run it against saved card HTML.
 */

/**
 * `currency` is the site's own currency, used only when the price text carries no
 * symbol (JD renders a bare `2799.00`). It is a property of the storefront, not a
 * guess about the number.
 */
export const CARD_SELECTORS = {
  jd: {
    card: "li.gl-item",
    title: ".p-name em, .p-name a",
    price: ".p-price i, .p-price strong i",
    currency: "CNY",
  },
  taobao: {
    card: 'a[href*="item.taobao.com"], a[href*="detail.tmall.com"]',
    title: '[class*="title"] span, [class*="Title"] span',
    price: '[class*="priceWrapper"], [class*="price"]',
    currency: "CNY",
  },
  pdd: {
    card: 'a[href*="yangkeduo.com/goods"], a[href*="/goods.html"]',
    title: '[class*="goodsName"], [class*="title"]',
    price: '[class*="price"]',
    currency: "CNY",
  },
  amazon: {
    card: "div[data-asin][data-component-type='s-search-result']",
    title: "h2",
    price: ".a-price .a-offscreen, .a-price-whole",
    currency: "USD",
  },
  amazon_cn: {
    card: "div[data-asin][data-component-type='s-search-result']",
    title: "h2",
    price: ".a-price .a-offscreen, .a-price-whole",
    currency: "CNY",
  },
};

/**
 * Runs inside the page. Returns one row per card with the price *and* the text it
 * came from, so a wrong number can be diagnosed instead of guessed at later.
 *
 * @returns {Array<{
 *   title: string, url: string,
 *   amount: number|null, currency: string|null,
 *   priceText: string, priceSource: string,
 *   salesText: string, glued: boolean, gluedAmount: number|null,
 *   reason?: string,
 * }>}
 */
export function extractCardsInPage({ sel, limit }) {
  const SYMBOLS = { "¥": "CNY", "￥": "CNY", "$": "USD", "€": "EUR", "£": "GBP" };
  // A "price cluster" is an element whose entire text is one price and nothing
  // else. `¥` `699` `.00` in three spans is one cluster; add `48人付款` and it
  // stops being one, which is exactly the boundary we need.
  const CLUSTER_RE = /^([¥￥$€£])?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:元)?$/;
  const SALES_RE = /(\d[\d.,]*\s*\+?\s*[万]?)\s*(?:人付款|人收货|人加购|已售|付款人数)/;
  /** An element whose whole text is the sales figure — same boundary idea as the price. */
  const SALES_EXACT_RE = /^\d[\d.,]*\s*\+?\s*[万]?\s*(?:人付款|人收货|人加购|已售|付款人数)$/;
  // Suffixes that mean the digits before them are a sales count, not money.
  const SALES_SUFFIX_RE = /^(?:人付款|人收货|人加购|已售|付款人数|人评价|条评价)/;

  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const toNumber = (digits) => {
    const n = Number(String(digits).replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const abs = (href) => {
    try {
      // JD emits protocol-relative hrefs like //item.jd.com/123.html
      return new URL(href.startsWith("//") ? `https:${href}` : href, location.href).href;
    } catch {
      return href;
    }
  };

  /** Parse an element's own text as a complete price, or return null. */
  const asCluster = (el) => {
    const m = norm(el?.textContent).match(CLUSTER_RE);
    if (!m) return null;
    const amount = toNumber(m[2]);
    if (amount === null) return null;
    return { amount, currency: m[1] ? SYMBOLS[m[1]] ?? null : null, text: norm(el.textContent) };
  };

  /**
   * Climb from a text node to the largest ancestor that is still a pure price.
   * Stops before swallowing neighbouring text such as a sales count, so the
   * `¥699` / `48人付款` concatenation cannot happen.
   */
  const clusterAround = (node, root) => {
    let el = node.parentElement;
    let best = null;
    let hops = 0;
    while (el && hops < 4) {
      const hit = asCluster(el);
      // Keep climbing past a bare `¥` to reach the element that holds the digits.
      if (hit) best = hit;
      else if (best) break;
      else if (!/^[¥￥$€£]?\s*$/.test(norm(el.textContent))) break;
      if (el === root) break;
      el = el.parentElement;
      hops++;
    }
    return best;
  };

  const firstCurrencyTextNode = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node = walker.nextNode();
    while (node) {
      if (/[¥￥$€£]/.test(node.nodeValue ?? "")) return node;
      node = walker.nextNode();
    }
    return null;
  };

  /** Declared selectors are tried first but must still look like a price. */
  const fromSelectors = (card, selector) => {
    if (!selector) return null;
    for (const el of card.querySelectorAll(selector)) {
      const hit = asCluster(el);
      if (hit) return { ...hit, source: `selector:${selector}` };
      const inner = firstCurrencyTextNode(el);
      const climbed = inner ? clusterAround(inner, el) : null;
      if (climbed) return { ...climbed, source: `selector+cluster:${selector}` };
    }
    return null;
  };

  /**
   * Last resort: regex over the whole card. This is the path that produced the
   * bad numbers, so it reports what follows the digits and refuses the value
   * when that is a sales-count suffix.
   */
  const fromCardText = (card) => {
    const text = norm(card.textContent);
    const m = text.match(/([¥￥$€£])\s*(\d[\d,]*(?:\.\d+)?)/);
    if (!m) return null;
    const amount = toNumber(m[2]);
    const after = text.slice((m.index ?? 0) + m[0].length);
    const glued = SALES_SUFFIX_RE.test(after);
    return {
      amount: glued ? null : amount,
      gluedAmount: glued ? amount : null,
      currency: SYMBOLS[m[1]] ?? null,
      text: m[0],
      source: "card-text",
      glued,
      ...(glued
        ? { reason: `卡片文本里价格与销量之间无分隔符（读到 ${m[0]}，紧接「${after.slice(0, 4)}」），拒绝采信` }
        : {}),
    };
  };

  /**
   * The sales figure has to be read structurally too: on a card that concatenates,
   * a regex over the whole text returns `69948人付款` for 48 buyers, which would
   * mislead exactly the person checking whether the price is right.
   */
  const salesOf = (card) => {
    for (const el of card.querySelectorAll("*")) {
      const text = norm(el.textContent);
      if (SALES_EXACT_RE.test(text)) return text;
    }
    return norm(card.textContent).match(SALES_RE)?.[0] ?? "";
  };

  const titleOf = (card, selector) => {
    if (selector) {
      for (const el of card.querySelectorAll(selector)) {
        const t = norm(el.textContent);
        if (t.length >= 8 && !CLUSTER_RE.test(t)) return t.slice(0, 160);
      }
    }
    return norm(card.textContent).slice(0, 160);
  };

  const out = [];
  const cards = Array.from(document.querySelectorAll(sel.card)).slice(0, limit * 4);
  for (const card of cards) {
    const anchor = card.matches("a") ? card : card.querySelector("a[href]");
    const href = anchor?.getAttribute("href");
    if (!href) continue;
    const url = abs(href);
    if (out.some((c) => c.url === url)) continue;

    const title = titleOf(card, sel.title);
    if (!title) continue;

    let hit = fromSelectors(card, sel.price);
    if (!hit) {
      const node = firstCurrencyTextNode(card);
      const climbed = node ? clusterAround(node, card) : null;
      if (climbed) hit = { ...climbed, source: "cluster" };
    }
    let glued = false;
    let gluedAmount = null;
    let reason;
    if (!hit) {
      const loose = fromCardText(card);
      if (loose) {
        glued = Boolean(loose.glued);
        gluedAmount = loose.gluedAmount ?? null;
        reason = loose.reason;
        hit = loose.amount === null ? null : loose;
      }
    }

    const salesText = salesOf(card);
    if (!hit && !reason) reason = "卡片里找不到可信的价格节点";
    out.push({
      title,
      url,
      amount: hit?.amount ?? null,
      currency: hit ? (hit.currency ?? sel.currency ?? null) : null,
      priceText: hit?.text ?? "",
      priceSource: hit?.source ?? "none",
      salesText,
      glued,
      gluedAmount,
      ...(reason ? { reason } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}
