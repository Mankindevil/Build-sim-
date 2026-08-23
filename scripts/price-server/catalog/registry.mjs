export const OFFICIAL_REGISTRY = [
  { brand: "JONSBO", domains: ["jonsbo.com", "www.jonsbo.com"], search: { kind: "site-search", urlTemplate: "https://www.jonsbo.com/search?q={query}" } },
  { brand: "ASUS", domains: ["asus.com", "www.asus.com"], search: { kind: "site-search", urlTemplate: "https://www.asus.com/search/result/?searchkey={query}" } },
  { brand: "Seagate", domains: ["seagate.com", "www.seagate.com"], search: { kind: "site-search", urlTemplate: "https://www.seagate.com/search/?q={query}" } },
  { brand: "Corsair", domains: ["corsair.com", "www.corsair.com"], search: { kind: "site-search", urlTemplate: "https://www.corsair.com/search?q={query}" } },
];

export function registryForBrand(brand) {
  if (!brand) return null;
  const lower = brand.toLocaleLowerCase();
  return OFFICIAL_REGISTRY.find((entry) => entry.brand.toLocaleLowerCase() === lower) ?? null;
}

export function registryForUrl(url) {
  const hostname = url.hostname.toLocaleLowerCase();
  return OFFICIAL_REGISTRY.find((entry) => entry.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) ?? null;
}
