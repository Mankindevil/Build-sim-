import { createRequire } from "node:module";
import { assertDiscoveryResult } from "./contracts.mjs";
import { OFFICIAL_DOMAIN_REGISTRY, OFFICIAL_REGISTRY_VERSION, registryForBrand } from "./registry.mjs";
import { validateOfficialUrl } from "./security.mjs";

const bundledCatalog = createRequire(import.meta.url)("../../../data/skus/catalog.json");
export const QUERY_NORMALIZATION_VERSION = "1.0.0";

function now() { return new Date().toISOString(); }
function safeText(value, limit = 240) { return String(value ?? "").slice(0, limit); }

export function canonicalizeDiscoveredUrl(raw) {
  const url = validateOfficialUrl(raw);
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
      const haystack = `${sku.brand} ${sku.model} ${sku.name} ${sku.mpn ?? ""}`.toLocaleLowerCase();
      const exactMpn = Boolean(query.mpn && sku.mpn && query.mpn.toLocaleLowerCase() === sku.mpn.toLocaleLowerCase());
      if (!exactMpn && (!wanted || !haystack.includes(wanted))) return [];
      const url = sku.appearance?.page ?? sku.price?.listingUrl;
      if (!url) return [];
      return [{ url, title: sku.name, provider: this.id, retrievedAt: now(), rank: exactMpn ? 0 : 1 }];
    }).slice(0, limit);
  }
}

export class RegistrySearchDiscoveryProvider {
  id = "registry-search";
  async discover({ query }) {
    const entry = registryForBrand(query.brand);
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

export function allowedDomainsForQuery(query, registry = OFFICIAL_DOMAIN_REGISTRY) {
  const brand = registryForBrand(query.brand, registry);
  if (brand?.trustStatus === "trusted") return [...brand.domains];
  return registry.brands.filter((entry) => entry.trustStatus === "trusted").flatMap((entry) => entry.domains);
}

/** @param {{query:any, catalog?:any, providers?:Array<any>, limit?:number, signal?:AbortSignal, registry?:any}} options */
export async function discoverOfficialUrls({ query, catalog = bundledCatalog, providers, limit = 10, signal = new AbortController().signal, registry = OFFICIAL_DOMAIN_REGISTRY }) {
  const selected = providers ?? [new CatalogCacheDiscoveryProvider(catalog), new RegistrySearchDiscoveryProvider()];
  const providerRegistry = new CatalogDiscoveryRegistry(selected);
  const allowedDomains = allowedDomainsForQuery(query, registry);
  const warnings = [];
  const proposals = [];
  const byCanonical = new Map();
  for (const provider of providerRegistry.providers) {
    let results;
    try {
      results = await provider.discover({ query, allowedDomains, limit, signal });
      if (!Array.isArray(results)) throw new Error("provider result must be an array");
    } catch (error) {
      warnings.push(`${provider.id}: ${safeText(error?.message ?? error)}`);
      continue;
    }
    for (const raw of results) {
      try {
        const result = assertDiscoveryResult({ ...raw, provider: provider.id });
        const url = canonicalizeDiscoveredUrl(result.url);
        if (!byCanonical.has(url)) byCanonical.set(url, { ...result, url, title: safeText(result.title), snippet: safeText(result.snippet), provider: provider.id });
      } catch (error) {
        try {
          const proposedUrl = new URL(raw?.url);
          if (proposedUrl.protocol === "https:" && !registry.brands.some((entry) => entry.domains.some((domain) => proposedUrl.hostname === domain || proposedUrl.hostname.endsWith(`.${domain}`)))) {
            proposals.push({ brand: query.brand, domain: proposedUrl.hostname.toLocaleLowerCase(), url: proposedUrl.toString(), title: safeText(raw?.title), snippet: safeText(raw?.snippet), provider: provider.id, retrievedAt: raw?.retrievedAt });
          }
        } catch { /* malformed discovery values are warnings only */ }
        warnings.push(`${provider.id}: candidate blocked: ${safeText(error?.message ?? error)}`);
      }
      if (byCanonical.size >= limit) break;
    }
    if (byCanonical.size >= limit) break;
  }
  return { providerIds: providerRegistry.ids(), registryVersion: registry.version ?? OFFICIAL_REGISTRY_VERSION, queryNormalizationVersion: QUERY_NORMALIZATION_VERSION, candidates: [...byCanonical.values()], proposals, warnings };
}
