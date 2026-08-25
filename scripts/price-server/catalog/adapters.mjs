import { registryForUrl } from "./registry.mjs";
import { extractOfficialHtml, extractOfficialPdf } from "./extract.mjs";

function extract(fetchResult, id) {
  const parsed = fetchResult.contentType.includes("pdf")
    ? extractOfficialPdf(fetchResult)
    : extractOfficialHtml(fetchResult);
  return { ...parsed, adapter: `${id}/${parsed.adapter}` };
}

function adapterForBrand(brand, id) {
  return {
    id,
    brand,
    domains: registryForUrl(new URL(`https://${brand.toLocaleLowerCase()}.com`))?.domains ?? [],
    canHandle(url) {
      const registry = registryForUrl(url instanceof URL ? url : new URL(url));
      return registry?.brand.toLocaleLowerCase() === brand.toLocaleLowerCase();
    },
    discover(query) {
      const registry = registryForUrl(new URL(`https://${brand.toLocaleLowerCase()}.com`));
      if (!registry) return [];
      return [{
        url: registry.search.urlTemplate.replace("{query}", encodeURIComponent(query.raw)),
        source: { kind: "search", domain: registry.domains[0] },
        adapter: id,
      }];
    },
    extract(fetchResult) {
      return extract(fetchResult, id);
    },
  };
}

export const OFFICIAL_ADAPTERS = [
  adapterForBrand("ASUS", "asus-product-v1"),
  adapterForBrand("Seagate", "seagate-product-v1"),
  adapterForBrand("Corsair", "corsair-product-v1"),
];

export function adapterForUrl(rawUrl) {
  const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  return OFFICIAL_ADAPTERS.find((adapter) => adapter.canHandle(url)) ?? null;
}
