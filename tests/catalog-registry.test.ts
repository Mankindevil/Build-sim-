import { describe, expect, it } from "vitest";
import catalog from "../data/skus/catalog.json";
import registryData from "../data/catalog/official-domains.json";
import { OFFICIAL_DOMAIN_REGISTRY, loadOfficialRegistry, registryForBrand, registryForUrl } from "../scripts/price-server/catalog/registry.mjs";
import { validateOfficialUrl } from "../scripts/price-server/catalog/security.mjs";

function catalogOfficialUrls() {
  const skus = catalog.skus as Array<{ appearance?: { page?: string }, price?: { listingUrl?: string }, provenance?: Array<{ sourceUrl?: string }> }>;
  return skus.flatMap((sku) => {
    const values = [sku.appearance?.page, sku.price?.listingUrl, ...(sku.provenance ?? []).map((entry) => entry.sourceUrl)];
    return values.filter((value): value is string => typeof value === "string" && value.startsWith("https://"));
  });
}

describe("C2 governed official domain registry", () => {
  it("covers every official URL already referenced by the catalog", () => {
    const urls = catalogOfficialUrls();
    const blocked = urls.filter((url) => !registryForUrl(new URL(url)));
    expect(urls.length).toBeGreaterThan(0);
    expect(blocked).toEqual([]);
    expect(new Set(urls.map((url) => new URL(url).hostname)).size).toBe(13);
  });

  it("normalizes aliases and records regional Intel domains explicitly", () => {
    expect(registryForBrand("CORSAIR")?.brand).toBe("Corsair");
    expect(registryForBrand("corsair")?.brand).toBe("Corsair");
    expect(registryForBrand("Intel")?.domains).toEqual(["intel.com", "intel.co.jp"]);
    expect(registryForBrand("Generic")).toBeNull();
    expect(registryForBrand("Unknown")).toBeNull();
    expect(OFFICIAL_DOMAIN_REGISTRY.version).toMatch(/^[a-f0-9]{64}$/);
  });

  it("allows only trusted registry entries through official validation", () => {
    const proposed = loadOfficialRegistry({ ...registryData, brands: [{ brand: "Example", domains: ["example.com"], trustStatus: "proposed", source: "agent-proposal" }] });
    expect(registryForUrl(new URL("https://docs.example.com/item"), proposed)?.trustStatus).toBe("proposed");
    expect(() => validateOfficialUrl("https://docs.example.com/item", { registry: proposed })).toThrow(/trusted/);
  });

  it.each([
    ["duplicate brand", { ...registryData, brands: [registryData.brands[0], registryData.brands[0]] }],
    ["duplicate domain", { ...registryData, brands: [{ ...registryData.brands[0], domains: ["jonsbo.com", "jonsbo.com"] }] }],
    ["public suffix", { ...registryData, brands: [{ ...registryData.brands[0], domains: ["com"] }] }],
    ["URL as domain", { ...registryData, brands: [{ ...registryData.brands[0], domains: ["https://jonsbo.com/path"] }] }],
  ])("rejects malformed registry data: %s", (_name, input) => {
    expect(() => loadOfficialRegistry(input)).toThrow();
  });
});
