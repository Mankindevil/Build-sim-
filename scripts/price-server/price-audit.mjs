import crypto from "node:crypto";

const PLATFORMS = new Set(["jd", "taobao", "pdd", "amazon", "official", "other"]);
const MATCHES = new Set(["mpn", "listingUrl", "manual"]);
const SOURCE_KINDS = new Set(["marketplace-listing", "official-price", "manual"]);

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Validate the only payload allowed to cross from a candidate into a price snapshot. */
export function buildAuditedQuote(body, catalog) {
  const sku = catalog.skus.find((entry) => entry.id === body.skuId);
  if (!sku) throw new Error("未知 SKU，不能审计价格");
  if (!PLATFORMS.has(body.platform)) throw new Error("不支持的价格平台");
  if (body.priceKind !== "variant" || !String(body.variantLabel ?? "").trim()) throw new Error("只有已确认 variantLabel 的规格价可以入账");
  if (body.priceCurrency !== "CNY" || body.fxAssumed) throw new Error("外币或含汇率假设的价格不能进入 CNY snapshot");
  if (!Number.isFinite(body.priceAmount) || body.priceAmount <= 0 || !Number.isFinite(body.priceCny) || body.priceCny <= 0 || body.priceAmount !== body.priceCny) throw new Error("价格必须是有效的 CNY 规格价");
  if (!body.listingUrl || !/^https?:\/\//i.test(String(body.listingUrl))) throw new Error("审计价格必须保留商品来源链接");
  const sourceUrl = new URL(String(body.listingUrl));
  if (sourceUrl.username || sourceUrl.password) throw new Error("价格来源 URL 不得包含凭据");
  const fetchedAt = String(body.fetchedAt ?? "");
  if (!fetchedAt || Number.isNaN(Date.parse(fetchedAt))) throw new Error("审计价格必须保留抓取时间");
  if (!MATCHES.has(body.match)) throw new Error("价格匹配类型无效");
  if (body.sourceKind && !SOURCE_KINDS.has(body.sourceKind)) throw new Error("价格来源类型无效");
  const variantLabel = String(body.variantLabel).trim().slice(0, 160);
  const provenanceInput = JSON.stringify({ skuId: body.skuId, platform: body.platform, listingUrl: sourceUrl.toString(), variantLabel, priceCny: body.priceCny, fetchedAt, sourceHash: body.sourceHash ?? null });
  const provenanceHash = body.provenanceHash ?? hash(provenanceInput);
  return {
    skuId: body.skuId,
    platform: body.platform,
    priceCny: body.priceCny,
    priceAmount: body.priceAmount,
    priceCurrency: "CNY",
    currency: "CNY",
    priceKind: "variant",
    variantLabel,
    listingUrl: sourceUrl.toString(),
    title: body.title ? String(body.title).slice(0, 240) : undefined,
    match: body.match,
    fetchedAt,
    sourceHash: body.sourceHash ? String(body.sourceHash) : undefined,
    provenanceHash,
    sourceKind: body.sourceKind ?? "marketplace-listing",
    note: body.note ? String(body.note).slice(0, 500) : undefined,
    evidence: "audited",
  };
}
