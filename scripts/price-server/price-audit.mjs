import crypto from "node:crypto";

const PLATFORMS = new Set(["jd", "taobao", "pdd", "amazon", "official", "other"]);
const MARKETPLACE_HOSTS = {
  jd: ["jd.com"],
  taobao: ["taobao.com", "tmall.com"],
  pdd: ["pinduoduo.com", "yangkeduo.com"],
  amazon: ["amazon.com", "amazon.cn", "amazon.co.jp", "amazon.co.uk", "amazon.de"],
};

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function canonicalHttpsUrl(value) {
  const source = new URL(String(value));
  if (source.protocol !== "https:" || source.username || source.password || source.port) throw new Error("listing capture URL must be HTTPS without credentials or port");
  source.hash = "";
  for (const key of [...source.searchParams.keys()]) if (/^utm_|^(?:spm|trace|referrer|source)$/i.test(key)) source.searchParams.delete(key);
  return source;
}

function isPlatformHost(hostname, platform, isOfficialUrl) {
  if (platform === "official") return Boolean(isOfficialUrl?.(new URL(`https://${hostname}`)));
  const allowed = MARKETPLACE_HOSTS[platform] ?? [];
  return allowed.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function assertCaptureRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("audit request must be an object");
  const allowed = new Set(["listingCaptureId", "candidateId", "skuId", "variantLabel"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new Error(`audit request cannot self-report ${key}`);
  if (!/^listing-capture-[a-f0-9]{20}$/.test(String(body.listingCaptureId ?? ""))) throw new Error("listingCaptureId is required");
  if (!/^price-candidate-[a-f0-9]{20}$/.test(String(body.candidateId ?? ""))) throw new Error("candidateId is required");
  if (typeof body.skuId !== "string" || !body.skuId) throw new Error("skuId is required");
  if (!String(body.variantLabel ?? "").trim()) throw new Error("variantLabel is required");
}

/**
 * Convert one immutable server-side listing capture into an auditable quote.
 * The browser may select identity and variant only; URL, price, source hashes,
 * timestamps and redirect chain are all reconstructed from the captured record.
 */
export function buildAuditedQuoteFromCapture(body, catalog, capture, { isOfficialUrl } = {}) {
  assertCaptureRequest(body);
  const sku = catalog.skus.find((entry) => entry.id === body.skuId);
  if (!sku) throw new Error("未知 SKU，不能审计价格");
  if (!capture || capture.schemaVersion !== "1.0.0") throw new Error("listing capture is invalid");
  if (capture.candidateId !== body.candidateId || capture.skuId !== sku.id) throw new Error("listing capture identity does not match selected SKU/candidate");
  if (!PLATFORMS.has(capture.platform) || capture.platform === "other") throw new Error("captured platform is not auditable");
  const canonical = canonicalHttpsUrl(capture.canonicalUrl);
  if (!isPlatformHost(canonical.hostname, capture.platform, isOfficialUrl)) throw new Error("listing capture domain is not approved for its platform");
  const chain = Array.isArray(capture.redirectChain) && capture.redirectChain.length ? capture.redirectChain : null;
  if (!chain) throw new Error("listing capture has no redirect chain");
  const normalizedChain = chain.map((entry) => canonicalHttpsUrl(entry).toString());
  if (normalizedChain.at(-1) !== canonical.toString()) throw new Error("listing capture canonical URL does not terminate its redirect chain");
  if (normalizedChain.some((entry) => !isPlatformHost(new URL(entry).hostname, capture.platform, isOfficialUrl))) throw new Error("listing capture redirect chain leaves the approved platform domain");
  const label = String(body.variantLabel).trim();
  const variant = (capture.variants ?? []).find((entry) => String(entry.label ?? "").trim() === label);
  if (!variant || variant.currency !== "CNY" || !Number.isFinite(variant.amount) || variant.amount <= 0) throw new Error("selected captured variant has no confirmed CNY price");
  const fetchedAt = String(capture.fetchedAt ?? "");
  if (!fetchedAt || Number.isNaN(Date.parse(fetchedAt))) throw new Error("listing capture fetchedAt is invalid");
  const sourceHash = hash(stableJson({ candidateId: capture.candidateId, canonicalUrl: canonical.toString(), redirectChain: normalizedChain, variants: capture.variants, fetchedAt, source: capture.source ?? null }));
  const provenanceInput = { skuId: sku.id, platform: capture.platform, candidateId: capture.candidateId, variantLabel: label, priceCny: variant.amount, canonicalUrl: canonical.toString(), fetchedAt, sourceHash };
  const provenanceHash = hash(stableJson(provenanceInput));
  return {
    skuId: sku.id,
    platform: capture.platform,
    priceCny: variant.amount,
    priceAmount: variant.amount,
    priceCurrency: "CNY",
    currency: "CNY",
    priceKind: "variant",
    variantLabel: label,
    listingUrl: canonical.toString(),
    title: String(capture.title ?? "").slice(0, 240) || undefined,
    match: "listingUrl",
    fetchedAt,
    sourceHash,
    provenanceHash,
    provenanceId: `price-prov-${provenanceHash.slice(0, 16)}`,
    sourceKind: capture.platform === "official" ? "official-price" : "marketplace-listing",
    note: `captured candidate ${capture.candidateId}; variant ${variant.skuId || label}`,
    evidence: "audited",
  };
}

/** Legacy direct-body audit is intentionally disabled at the HTTP trust boundary. */
export function buildAuditedQuote() {
  throw new Error("direct price audit is disabled; submit a server-issued listingCaptureId and candidateId");
}
