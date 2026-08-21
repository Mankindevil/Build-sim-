/** Brand site price via schema.org JSON-LD. No guessing when markup is absent. */

export const channel = "official";
export const platform = "official";

export async function availability() {
  return { available: true };
}

function collectJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const body = m[1];
    if (!body) continue;
    try {
      blocks.push(JSON.parse(body.trim()));
    } catch {
      /* malformed block */
    }
  }
  return blocks;
}

function flattenGraph(node, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) flattenGraph(n, out);
    return out;
  }
  if (node && typeof node === "object") {
    out.push(node);
    if (node["@graph"]) flattenGraph(node["@graph"], out);
  }
  return out;
}

function firstOffer(offers) {
  if (!offers) return null;
  if (Array.isArray(offers)) return offers.find((o) => o?.price != null) ?? null;
  if (offers.price != null) return offers;
  if (offers.lowPrice != null) return { price: offers.lowPrice, priceCurrency: offers.priceCurrency };
  return null;
}

/** Only CNY offers become candidate prices; other currencies are reported for review. */
export function extractProductOffer(html) {
  for (const node of flattenGraph(collectJsonLdBlocks(html))) {
    const types = [].concat(node["@type"] ?? []);
    if (!types.includes("Product")) continue;
    const offer = firstOffer(node.offers);
    if (!offer) continue;
    const price = Number(offer.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    return {
      title: typeof node.name === "string" ? node.name : "",
      price,
      currency: offer.priceCurrency ?? null,
    };
  }
  return null;
}

export async function collect({ officialUrl, sku }) {
  const url = officialUrl;
  if (!url) return { status: "unavailable", reason: "该 SKU 没有官网页面" };

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!res.ok) return { status: "error", reason: `HTTP ${res.status}` };

  const offer = extractProductOffer(await res.text());
  if (!offer) {
    return { status: "unavailable", reason: "官网页面没有 JSON-LD 价格" };
  }
  if (offer.currency && offer.currency !== "CNY") {
    return {
      status: "ok",
      candidates: [
        {
          title: offer.title || (sku?.name ?? ""),
          priceCny: null,
          url,
          note: `官网标价 ${offer.currency} ${offer.price}，非人民币，不能直接当 CNY 报价`,
        },
      ],
    };
  }
  return {
    status: "ok",
    candidates: [{ title: offer.title || (sku?.name ?? ""), priceCny: offer.price, url }],
  };
}
