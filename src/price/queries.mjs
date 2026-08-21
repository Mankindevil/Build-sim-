/**
 * Search-query and channel-URL construction, shared by the browser bundle and
 * the Node price scripts (plain ESM, no platform APIs).
 *
 * Part numbers alone are useless on Taobao/PDD — sellers write spec words, not
 * MPNs — so every SKU also gets spec queries built from catalog attributes.
 */

const BRAND_ZH = {
  KINGSTON: "金士顿",
  CORSAIR: "美商海盗船",
  ADATA: "威刚",
  SAMSUNG: "三星",
  "SK HYNIX": "海力士",
  MICRON: "镁光",
  CRUCIAL: "英睿达",
  SEAGATE: "希捷",
  "WESTERN DIGITAL": "西部数据",
  SEASONIC: "海韵",
  THERMALRIGHT: "利民",
  JONSBO: "乔思伯",
  ASUS: "华硕",
  INTEL: "英特尔",
  NVIDIA: "英伟达",
  BROADCOM: "博通",
  LSI: "LSI",
};

const CATEGORY_ZH = {
  memory: "内存",
  psu: "电源",
  cooler: "散热器",
  case: "机箱",
  storage: "硬盘",
  gpu: "显卡",
  board: "主板",
  cpu: "处理器",
  hba: "扩展卡",
};

/** Strip parenthetical notes e.g. `(Ver 5.43.13)` so marketplace search matches titles. */
export function searchQueryFromMpn(mpn) {
  return String(mpn ?? "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function brandZh(brand) {
  if (!brand) return null;
  return BRAND_ZH[String(brand).toUpperCase()] ?? null;
}

function joinTokens(tokens) {
  return tokens.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * ECC server sticks are sold one at a time, so shoppers search the per-module
 * size; consumer XMP kits are boxed and listed at the kit total.
 */
function memoryCapacityToken(attrs) {
  const total = Number(attrs.capacityGb);
  const modules = Number(attrs.modules) || 1;
  if (!Number.isFinite(total) || total <= 0) return null;
  const perModule = Math.round(total / modules);
  return attrs.ecc ? `${perModule}G` : `${total}G`;
}

function memorySpecTokens(sku) {
  const attrs = sku.attrs ?? {};
  const speed = Number(attrs.speedMt) || Number(attrs.jedecMt) || null;
  return [
    "DDR5",
    speed ? String(speed) : null,
    memoryCapacityToken(attrs),
    attrs.ecc ? "ECC" : null,
    attrs.ecc ? "UDIMM" : null,
  ];
}

/** Model words from the product name, minus the brand and the parenthetical suffix. */
function modelTokens(sku) {
  const name = String(sku.name ?? "").replace(/\s*\([^)]*\)\s*/g, " ");
  const brand = String(sku.brand ?? "");
  return name
    .split(/\s+/)
    .filter((w) => w && w.toUpperCase() !== brand.toUpperCase())
    .slice(0, 3)
    .join(" ");
}

function specTokens(sku) {
  if (sku.category === "memory") return memorySpecTokens(sku);
  return [modelTokens(sku), CATEGORY_ZH[sku.category] ?? null];
}

/**
 * Ordered query candidates for a SKU: exact part number first, then spec
 * phrasings (with and without the brand) that Chinese listings actually use.
 * `attrs.searchTerms` overrides the derived spec queries.
 */
export function buildSearchQueries(sku) {
  const exact = searchQueryFromMpn(sku.mpn ?? "");
  const override = Array.isArray(sku.attrs?.searchTerms)
    ? sku.attrs.searchTerms.map((t) => String(t).trim()).filter(Boolean)
    : null;

  if (override?.length) {
    return { exact: exact || null, spec: override };
  }

  const tokens = specTokens(sku);
  const zh = brandZh(sku.brand);
  const withBrand = joinTokens([zh ?? sku.brand, ...tokens]);
  const withoutBrand = joinTokens(tokens);

  const spec = [];
  for (const q of [withBrand, withoutBrand]) {
    if (q && q.length > 1 && !spec.includes(q)) spec.push(q);
  }
  return { exact: exact || null, spec };
}

/** JD and brand sites index part numbers; Taobao and PDD need spec words first. */
export function channelQueries(channel, sku) {
  const { exact, spec } = buildSearchQueries(sku);
  // amazon.com indexes part numbers, not Chinese spec wording, so sending the spec
  // queries there only burns requests on unrelated results.
  if (channel === "amazon") return exact ? [exact] : [];
  const order =
    channel === "taobao" || channel === "pdd" ? [...spec, exact] : [exact, ...spec];
  const seen = new Set();
  return order.filter((q) => q && !seen.has(q) && seen.add(q));
}

export function searchUrlFor(channel, query) {
  const enc = encodeURIComponent(query);
  switch (channel) {
    case "jd":
      return `https://search.jd.com/Search?keyword=${enc}`;
    case "taobao":
      return `https://s.taobao.com/search?q=${enc}`;
    case "pdd":
      return `https://mobile.yangkeduo.com/search_result.html?search_key=${enc}`;
    case "amazon_cn":
      return `https://www.amazon.cn/s?k=${enc}`;
    case "amazon":
      return `https://www.amazon.com/s?k=${enc}`;
    default:
      return null;
  }
}

const CHANNEL_LABELS = {
  jd: "京东",
  taobao: "淘宝",
  pdd: "拼多多",
  amazon_cn: "亚马逊中国",
  amazon: "Amazon",
};

/** Raw-part-number links; used where only an MPN string is at hand. */
export function buildChannelSearchLinks(mpn, officialUrl) {
  const q = searchQueryFromMpn(mpn);
  if (!q) return [];
  const links = Object.keys(CHANNEL_LABELS).map((channel) => ({
    channel,
    label: CHANNEL_LABELS[channel],
    query: q,
    url: searchUrlFor(channel, q),
  }));
  if (officialUrl && /^https?:\/\//i.test(officialUrl)) {
    links.push({ channel: "official", label: "官网", query: q, url: officialUrl });
  }
  return links;
}

/** Per-SKU links using each channel's preferred query. */
export function buildSkuSearchLinks(sku, officialUrl) {
  const links = [];
  for (const channel of Object.keys(CHANNEL_LABELS)) {
    const query = channelQueries(channel, sku)[0];
    if (!query) continue;
    links.push({
      channel,
      label: CHANNEL_LABELS[channel],
      query,
      url: searchUrlFor(channel, query),
    });
  }
  const url = officialUrl ?? pickOfficialUrl(sku);
  if (url && /^https?:\/\//i.test(url)) {
    links.push({ channel: "official", label: "官网", query: searchQueryFromMpn(sku.mpn ?? ""), url });
  }
  return links;
}

/** Prefer appearance page, else catalog listingUrl when it looks like a brand site. */
export function pickOfficialUrl(sku) {
  const page = sku.appearance?.page;
  if (page && /^https?:\/\//i.test(page)) return page;
  const listing = sku.price?.listingUrl;
  if (!listing || !/^https?:\/\//i.test(listing)) return undefined;
  if (/jd\.com|taobao\.com|tmall\.com|pinduoduo\.com|yangkeduo\.com|amazon\./i.test(listing)) {
    return undefined;
  }
  return listing;
}

/**
 * A SKU is fetchable when it has a part number, or hand-written `attrs.searchTerms`.
 * Spec-only SKUs are excluded on purpose so "fetch all" stays bounded.
 */
export function isPriceTrackable(sku) {
  if (searchQueryFromMpn(sku.mpn ?? "")) return true;
  return Array.isArray(sku.attrs?.searchTerms) && sku.attrs.searchTerms.length > 0;
}

export function channelToPlatform(channel) {
  if (channel === "amazon" || channel === "amazon_cn") return "amazon";
  if (channel === "official") return "official";
  if (channel === "jd" || channel === "taobao" || channel === "pdd") return channel;
  return "other";
}
