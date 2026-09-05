import bundledCatalog from "../../../data/skus/catalog.json" with { type: "json" };
import { assertDiscoveryResult } from "./contracts.mjs";
import { activeOfficialRegistry, registryForBrand, registryForUrl } from "./registry.mjs";
import { isPrivateHostname, validateOfficialUrl } from "./security.mjs";

export const QUERY_NORMALIZATION_VERSION = "1.3.0";

function now() { return new Date().toISOString(); }
function safeText(value, limit = 240) { return String(value ?? "").slice(0, limit); }
function comparableBrand(value) { return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); }
function comparableText(value) { return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim(); }
function registryBrandMatches(expectedBrand, domainEntry, registry) {
  if (!expectedBrand || !domainEntry) return false;
  const expectedEntry = registryForBrand(expectedBrand, registry);
  return expectedEntry
    ? expectedEntry.brand === domainEntry.brand
    : comparableBrand(expectedBrand) === comparableBrand(domainEntry.brand);
}

export function discoveredPageHint(rawUrl) {
  const url = new URL(rawUrl);
  const path = url.pathname.toLocaleLowerCase();
  if (path === "/" || path === "") return "root";
  if (/(?:forum|community)/.test(url.hostname) || /\/(?:forum|community|t5)\//.test(path)) return "forum";
  if (/\/(?:news|blog|insights|press)(?:\/|$)/.test(path)) return "article";
  if (/\/(?:search|search-result)(?:\/|$)/.test(path)) return "search";
  return "candidate";
}

export function canonicalizeDiscoveredUrl(raw, registry) {
  const url = validateOfficialUrl(raw, registry === undefined ? {} : { registry });
  url.hash = "";
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  return url.toString();
}

/** A user/search supplied URL may be proposed before it is trusted, but it
 * must still pass the non-network URL safety boundary. It is not fetched until
 * the user approves its domain into the governed registry. */
export function normalizeProposedOfficialUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value || value.length > 2_048) throw new Error("proposed official URL is invalid");
  let url;
  try { url = new URL(value); } catch { throw new Error("proposed official URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("proposed official URL must use canonical HTTPS");
  if (isPrivateHostname(url.hostname)) throw new Error("private or local URL is blocked");
  url.hash = "";
  return url.toString();
}

function officialSiteFit(query, result, url) {
  const queryTokens = [...new Set([query.brand, query.model, query.mpn, ...(query.tokens ?? [])]
    .flatMap((value) => comparableText(value).split(" "))
    .filter((token) => token.length >= 2))];
  const haystack = comparableText(`${url.hostname} ${url.pathname} ${result.title ?? ""} ${result.snippet ?? ""}`);
  const hits = queryTokens.filter((token) => haystack.includes(token));
  const coverage = queryTokens.length ? hits.length / queryTokens.length : 0;
  const brand = comparableText(query.brand).replace(/\s+/g, "");
  const hostname = comparableText(url.hostname).replace(/\s+/g, "");
  const brandSignal = Boolean(brand && (hostname.includes(brand) || comparableText(result.title).includes(comparableText(query.brand))));
  const productPath = /\/(?:product|products|spec|specification|support|download)(?:\/|s|$)/i.test(url.pathname);
  const marketplace = /(?:amazon|aliexpress|alibaba|ebay|jd\.com|taobao|tmall|newegg|walmart)/i.test(url.hostname)
    || /\b(?:shop|store|retailer|review|price)\b/i.test(String(result.title ?? ""));
  const score = Math.max(0, Math.min(1, coverage * 0.6 + (brandSignal ? 0.25 : 0) + (productPath ? 0.1 : 0) + (result.submittedByUser ? 0.2 : 0) - (marketplace ? 0.45 : 0)));
  const reasons = [
    ...(result.submittedByUser ? ["用户提供了这个官网入口"] : []),
    ...(brandSignal ? ["域名或标题包含制造商品牌"] : []),
    ...(hits.length ? [`命中 ${hits.length} 个型号/关键词`] : []),
    ...(productPath ? ["URL 看起来是产品、规格或支持页面"] : []),
    ...(marketplace ? ["页面具有商城或第三方特征，已降权"] : []),
  ];
  return { score, reasons: reasons.length ? reasons : ["搜索引擎返回的待核对站点"] };
}

export class SubmittedOfficialUrlDiscoveryProvider {
  id = "user-submitted-url";
  constructor(rawUrl) { this.url = normalizeProposedOfficialUrl(rawUrl); }
  async discover({ query }) {
    return [{
      url: this.url,
      title: `${safeText(query.brand ?? query.raw)} · 用户输入官网`,
      provider: this.id,
      retrievedAt: now(),
      rank: 0,
      submittedByUser: true,
    }];
  }
}

export class CatalogCacheDiscoveryProvider {
  id = "catalog-cache";
  /** @param {any} catalog */
  constructor(catalog = bundledCatalog) { this.catalog = catalog; }
  async discover({ query, limit, expectedSkuId = undefined, registry = activeOfficialRegistry() }) {
    const expected = expectedSkuId ? (this.catalog.skus ?? []).find((sku) => sku.id === expectedSkuId) : null;
    const expectedBrand = expected?.brand ?? query.brand;
    const wanted = `${query.brand ?? ""} ${query.model ?? ""} ${query.mpn ?? ""}`.trim().toLocaleLowerCase();
    const rows = [...(this.catalog.skus ?? [])].flatMap((sku) => {
      const aliases = Array.isArray(sku.attrs?.searchTerms) ? sku.attrs.searchTerms.join(" ") : "";
      const haystack = `${sku.brand} ${sku.model} ${sku.name} ${sku.mpn ?? ""} ${aliases}`.toLocaleLowerCase();
      const exactMpn = Boolean(query.mpn && sku.mpn && query.mpn.toLocaleLowerCase() === sku.mpn.toLocaleLowerCase());
      const significantTokens = (query.tokens ?? []).filter((token) => token.length >= 2);
      const tokenMatch = significantTokens.length >= 2 && significantTokens.every((token) => haystack.includes(token));
      if (sku.id !== expected?.id && !exactMpn && !tokenMatch && (!wanted || !haystack.includes(wanted))) return [];
      const url = sku.appearance?.page ?? sku.price?.listingUrl;
      if (!url) return [];
      let officialEntry;
      try { officialEntry = registryForUrl(new URL(url), registry); } catch { return []; }
      if (expectedBrand && !registryBrandMatches(expectedBrand, officialEntry, registry)) return [];
      const expectedMatch = sku.id === expected?.id;
      return [{ url, title: sku.name, skuId: sku.id, matchKind: exactMpn ? "exact-mpn" : "brand-model", matchScore: exactMpn || expectedMatch ? 1 : 0.85, provider: this.id, retrievedAt: now(), rank: exactMpn || expectedMatch ? 0 : 1 }];
    });
    // A server-validated SKU is a stronger identity signal than fuzzy query
    // matching. Keep its governed official URL deterministic and ahead of
    // sibling/family catalog hits while retaining later fallbacks if it fails.
    return rows.sort((left, right) => Number(right.skuId === expected?.id) - Number(left.skuId === expected?.id)).slice(0, limit);
  }
}

export class RegistrySearchDiscoveryProvider {
  id = "registry-search";
  async discover({ query, registry = undefined }) {
    const entry = registry === undefined ? registryForBrand(query.brand) : registryForBrand(query.brand, registry);
    if (!entry?.search || entry.trustStatus !== "trusted") return [];
    return [{
      url: entry.search.urlTemplate.replace("{query}", encodeURIComponent(query.raw)),
      title: `${entry.brand} site search · ${safeText(query.raw)}`,
      provider: this.id,
      retrievedAt: now(),
      rank: 0,
    }];
  }
}

export class MsiProductDiscoveryProvider {
  id = "msi-product-pattern";
  async discover({ query, limit, registry = undefined }) {
    const entry = registry === undefined ? registryForBrand(query.brand) : registryForBrand(query.brand, registry);
    if (entry?.brand !== "MSI" || query.category !== "gpu") return [];
    const text = String(query.raw ?? "").normalize("NFKC");
    const chip = text.match(/\b(RTX|GTX)\s*([0-9]{3,4})(?:\s*(Ti|SUPER))?/i);
    const ventus = text.match(/\bVENTUS\s*([23]X)\b/i);
    if (!chip || !ventus) return [];
    const chipSlug = `${chip[1].toUpperCase()}-${chip[2]}${chip[3] ? `-${chip[3].toUpperCase()}` : ""}`;
    const familySlug = `VENTUS-${ventus[1].toUpperCase()}`;
    const base = `GeForce-${chipSlug}-${familySlug}`;
    const memory = text.match(/\b(\d+)\s*GB\b/i)?.[1];
    const slug = /\bLHR\b/i.test(text) && memory ? `${base}-${memory}G-OC-LHR` : /\bOC\b/i.test(text) ? `${base}-OC` : base;
    return [{
      url: `https://www.msi.com/Graphics-Card/${slug}/Specification`,
      title: slug.replace(/-/g, " "),
      provider: this.id,
      retrievedAt: now(),
      rank: 0,
    }];
  }
}

export class CatalogDiscoveryRegistry {
  constructor(providers = []) {
    this.providers = [];
    const ids = new Set();
    for (const provider of providers) {
      if (!provider || typeof provider.id !== "string" || !provider.id || typeof provider.discover !== "function") throw new Error("invalid catalog discovery provider");
      if (ids.has(provider.id)) throw new Error(`duplicate catalog discovery provider: ${provider.id}`);
      ids.add(provider.id);
      this.providers.push(provider);
    }
  }
  ids() { return this.providers.map((provider) => provider.id); }
}

export function allowedDomainsForQuery(query, registry) {
  const resolvedRegistry = registry ?? activeOfficialRegistry();
  const brand = registryForBrand(query.brand, resolvedRegistry);
  if (brand?.trustStatus === "trusted") return [...brand.domains];
  return [];
}

/** @param {{query:any, catalog?:any, providers?:Array<any>, limit?:number, signal?:AbortSignal, registry?:any, expectedSkuId?:string}} options */
export async function discoverOfficialUrls({ query, catalog = bundledCatalog, providers, limit = 10, signal = new AbortController().signal, registry, expectedSkuId }) {
  const resolvedRegistry = registry ?? activeOfficialRegistry();
  const selected = providers ?? [new CatalogCacheDiscoveryProvider(catalog), new RegistrySearchDiscoveryProvider()];
  const providerRegistry = new CatalogDiscoveryRegistry(selected);
  const expectedSku = expectedSkuId ? (catalog.skus ?? []).find((sku) => sku.id === expectedSkuId) : null;
  const expectedBrand = expectedSku?.brand ?? query.brand;
  const allowedDomains = allowedDomainsForQuery(query, resolvedRegistry);
  const warnings = allowedDomains.length ? [] : ["品牌未识别或尚未进入可信域名表；开放搜索结果只会作为待确认官网，不会在用户批准前读取"];
  const proposalsByDomain = new Map();
  const byCanonical = new Map();
  const providerPriority = (provider) => provider.id === "user-submitted-url" ? 2 : provider.id === "catalog-cache" ? 1 : 0;
  const executionProviders = expectedSkuId
    ? [...providerRegistry.providers].sort((left, right) => providerPriority(right) - providerPriority(left))
    : providerRegistry.providers;
  for (const provider of executionProviders) {
    let results;
    try {
      results = await provider.discover({ query, allowedDomains, limit, signal, registry: resolvedRegistry, expectedSkuId });
      if (!Array.isArray(results)) throw new Error("provider result must be an array");
    } catch (error) {
      warnings.push(`${provider.id}: ${safeText(error?.message ?? error)}`);
      continue;
    }
    for (const raw of results) {
      try {
        const result = assertDiscoveryResult({ ...raw, provider: provider.id });
        const url = canonicalizeDiscoveredUrl(result.url, resolvedRegistry);
        const domainEntry = registryForUrl(new URL(url), resolvedRegistry);
        if (expectedBrand && !registryBrandMatches(expectedBrand, domainEntry, resolvedRegistry)) {
          warnings.push(`${provider.id}: skipped cross-brand official domain ${new URL(url).hostname} for ${safeText(expectedBrand)}`);
          continue;
        }
        const pageHint = discoveredPageHint(url);
        if (provider.id !== "catalog-cache" && provider.id !== "registry-search" && pageHint !== "candidate") {
          warnings.push(`${provider.id}: skipped ${pageHint} page: ${url}`);
          continue;
        }
        const discovered = { ...result, url, title: safeText(result.title), snippet: safeText(result.snippet), provider: provider.id, pageHint };
        if (!byCanonical.has(url) || (result.skuId === expectedSkuId && byCanonical.get(url)?.skuId !== expectedSkuId)) byCanonical.set(url, discovered);
      } catch (error) {
        try {
          const proposed = normalizeProposedOfficialUrl(raw?.url);
          const proposedUrl = new URL(proposed);
          if (!resolvedRegistry.brands.some((entry) => entry.domains.some((domain) => proposedUrl.hostname === domain || proposedUrl.hostname.endsWith(`.${domain}`)))) {
            const fit = officialSiteFit(query, raw ?? {}, proposedUrl);
            const proposal = {
              brand: query.brand,
              domain: proposedUrl.hostname.toLocaleLowerCase(),
              url: proposed,
              title: safeText(raw?.title),
              snippet: safeText(raw?.snippet),
              provider: provider.id,
              retrievedAt: raw?.retrievedAt,
              rank: Number.isInteger(raw?.rank) ? raw.rank : 0,
              matchScore: fit.score,
              reasons: fit.reasons,
              submittedByUser: raw?.submittedByUser === true,
            };
            const prior = proposalsByDomain.get(proposal.domain);
            if (!prior || proposal.matchScore > prior.matchScore || (proposal.matchScore === prior.matchScore && proposal.rank < prior.rank)) proposalsByDomain.set(proposal.domain, proposal);
          }
        } catch { /* malformed discovery values are warnings only */ }
        warnings.push(`${provider.id}: candidate blocked: ${safeText(error?.message ?? error)}`);
      }
      if (byCanonical.size >= limit) break;
    }
    if (byCanonical.size >= limit) break;
  }
  const candidates = [...byCanonical.values()];
  if (expectedSkuId) candidates.sort((left, right) => {
    const priority = (entry) => entry.provider === "user-submitted-url" ? 2 : entry.skuId === expectedSkuId ? 1 : 0;
    return priority(right) - priority(left);
  });
  const proposals = [...proposalsByDomain.values()]
    .sort((left, right) => right.matchScore - left.matchScore || left.rank - right.rank || left.domain.localeCompare(right.domain))
    .slice(0, Math.min(5, limit));
  return { providerIds: providerRegistry.ids(), registryVersion: resolvedRegistry.version, queryNormalizationVersion: QUERY_NORMALIZATION_VERSION, candidates, proposals, warnings };
}
