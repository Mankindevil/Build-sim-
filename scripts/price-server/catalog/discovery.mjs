import bundledCatalog from "../../../data/skus/catalog.json" with { type: "json" };
import { assertDiscoveryResult } from "./contracts.mjs";
import { activeOfficialRegistry, registryForBrand } from "./registry.mjs";
import { validateOfficialUrl } from "./security.mjs";

export const QUERY_NORMALIZATION_VERSION = "1.1.0";

function now() { return new Date().toISOString(); }
function safeText(value, limit = 240) { return String(value ?? "").slice(0, limit); }

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

export class CatalogCacheDiscoveryProvider {
  id = "catalog-cache";
  constructor(catalog = bundledCatalog) { this.catalog = catalog; }
  async discover({ query, limit }) {
    const wanted = `${query.brand ?? ""} ${query.model ?? ""} ${query.mpn ?? ""}`.trim().toLocaleLowerCase();
    return (this.catalog.skus ?? []).flatMap((sku) => {
      const aliases = Array.isArray(sku.attrs?.searchTerms) ? sku.attrs.searchTerms.join(" ") : "";
      const haystack = `${sku.brand} ${sku.model} ${sku.name} ${sku.mpn ?? ""} ${aliases}`.toLocaleLowerCase();
      const exactMpn = Boolean(query.mpn && sku.mpn && query.mpn.toLocaleLowerCase() === sku.mpn.toLocaleLowerCase());
      const significantTokens = (query.tokens ?? []).filter((token) => token.length >= 2);
      const tokenMatch = significantTokens.length >= 2 && significantTokens.every((token) => haystack.includes(token));
      if (!exactMpn && !tokenMatch && (!wanted || !haystack.includes(wanted))) return [];
      const url = sku.appearance?.page ?? sku.price?.listingUrl;
      if (!url) return [];
      return [{ url, title: sku.name, skuId: sku.id, matchKind: exactMpn ? "exact-mpn" : "brand-model", matchScore: exactMpn ? 1 : 0.85, provider: this.id, retrievedAt: now(), rank: exactMpn ? 0 : 1 }];
    }).slice(0, limit);
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

/** @param {{query:any, catalog?:any, providers?:Array<any>, limit?:number, signal?:AbortSignal, registry?:any}} options */
export async function discoverOfficialUrls({ query, catalog = bundledCatalog, providers, limit = 10, signal = new AbortController().signal, registry }) {
  const resolvedRegistry = registry ?? activeOfficialRegistry();
  const selected = providers ?? [new CatalogCacheDiscoveryProvider(catalog), new RegistrySearchDiscoveryProvider()];
  const providerRegistry = new CatalogDiscoveryRegistry(selected);
  const allowedDomains = allowedDomainsForQuery(query, resolvedRegistry);
  const warnings = allowedDomains.length ? [] : ["品牌未识别或未进入可信域名表；已跳过跨品牌官网搜索"];
  const proposals = [];
  const byCanonical = new Map();
  for (const provider of providerRegistry.providers) {
    let results;
    try {
      results = await provider.discover({ query, allowedDomains, limit, signal, registry: resolvedRegistry });
      if (!Array.isArray(results)) throw new Error("provider result must be an array");
    } catch (error) {
      warnings.push(`${provider.id}: ${safeText(error?.message ?? error)}`);
      continue;
    }
    for (const raw of results) {
      try {
        const result = assertDiscoveryResult({ ...raw, provider: provider.id });
        const url = canonicalizeDiscoveredUrl(result.url, resolvedRegistry);
        const pageHint = discoveredPageHint(url);
        if (provider.id !== "catalog-cache" && provider.id !== "registry-search" && pageHint !== "candidate") {
          warnings.push(`${provider.id}: skipped ${pageHint} page: ${url}`);
          continue;
        }
        if (!byCanonical.has(url)) byCanonical.set(url, { ...result, url, title: safeText(result.title), snippet: safeText(result.snippet), provider: provider.id, pageHint });
      } catch (error) {
        try {
          const proposedUrl = new URL(raw?.url);
          if (proposedUrl.protocol === "https:" && !resolvedRegistry.brands.some((entry) => entry.domains.some((domain) => proposedUrl.hostname === domain || proposedUrl.hostname.endsWith(`.${domain}`)))) {
            proposals.push({ brand: query.brand, domain: proposedUrl.hostname.toLocaleLowerCase(), url: proposedUrl.toString(), title: safeText(raw?.title), snippet: safeText(raw?.snippet), provider: provider.id, retrievedAt: raw?.retrievedAt });
          }
        } catch { /* malformed discovery values are warnings only */ }
        warnings.push(`${provider.id}: candidate blocked: ${safeText(error?.message ?? error)}`);
      }
      if (byCanonical.size >= limit) break;
    }
    if (byCanonical.size >= limit) break;
  }
  return { providerIds: providerRegistry.ids(), registryVersion: resolvedRegistry.version, queryNormalizationVersion: QUERY_NORMALIZATION_VERSION, candidates: [...byCanonical.values()], proposals, warnings };
}
