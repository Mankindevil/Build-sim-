import { describe, expect, it } from "vitest";
import { CatalogDiscoveryRegistry, discoverOfficialUrls, MsiProductDiscoveryProvider } from "../scripts/price-server/catalog/discovery.mjs";
import { normalizeModelQuery } from "../scripts/price-server/catalog/normalize.mjs";
import { queueSearch, waitForJob } from "../scripts/price-server/catalog/service.mjs";
import { registryForBrand } from "../scripts/price-server/catalog/registry.mjs";

const query = normalizeModelQuery("ASUS-G4-001 motherboard", { brand: "ASUS", category: "motherboard" });

describe("C3 provider-neutral catalog discovery", () => {
  it("recognizes MSI GPU queries and restricts discovery to the official MSI domain", () => {
    const normalized = normalizeModelQuery("MSI RTX 3070 Ventus 2X 8GB", { category: "gpu" });
    expect(normalized.brand).toBe("MSI");
    expect(registryForBrand(normalized.brand)?.domains).toContain("msi.com");
  });

  it("derives bounded MSI official product candidates when search engines return nothing", async () => {
    const normalized = normalizeModelQuery("MSI RTX 3070 Ventus 2X OC 8GB", { category: "gpu" });
    const rows = await new MsiProductDiscoveryProvider().discover({ query: normalized, limit: 4 });
    expect(rows[0]?.url).toBe("https://www.msi.com/Graphics-Card/GeForce-RTX-3070-VENTUS-2X-OC/Specification");
    expect(rows).toHaveLength(1);
  });

  it("validates provider registration", () => {
    expect(() => new CatalogDiscoveryRegistry([{ id: "same", discover: async () => [] }, { id: "same", discover: async () => [] }])).toThrow(/duplicate/);
  });

  it("filters untrusted URLs, canonicalizes and deduplicates provider results", async () => {
    const provider = { id: "fixture-discovery", discover: async () => [
      { url: "https://www.asus.com/product/g4#specs", title: "first", snippet: "4096 GB is search text only", retrievedAt: "2026-08-24T00:00:00.000Z", rank: 0 },
      { url: "https://www.asus.com/product/g4", title: "duplicate", retrievedAt: "2026-08-24T00:00:00.000Z", rank: 1 },
      { url: "https://evil.example/product", title: "blocked", retrievedAt: "2026-08-24T00:00:00.000Z", rank: 2 },
    ] };
    const result = await discoverOfficialUrls({ query, providers: [provider] });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].url).toBe("https://www.asus.com/product/g4");
    expect(result.candidates[0].snippet).toContain("search text only");
    expect(result.candidates[0]).not.toHaveProperty("fields");
    expect(result.warnings.join(" ")).toContain("blocked");
  });

  it("isolates provider failure and preserves later provider candidates", async () => {
    const failed = { id: "failed", discover: async () => { throw new Error("fixture timeout"); } };
    const healthy = { id: "healthy", discover: async () => [{ url: "https://www.asus.com/product/one", title: "one", retrievedAt: "2026-08-24T00:00:00.000Z", rank: 0 }] };
    const result = await discoverOfficialUrls({ query, providers: [failed, healthy] });
    expect(result.candidates).toHaveLength(1);
    expect(result.warnings).toEqual(["failed: fixture timeout"]);
  });

  it("includes provider and registry versions in jobs and returns multiple product candidates", async () => {
    const stamp = Date.now();
    const provider = { id: `job-fixture-${stamp}`, discover: async () => [
      { url: `https://www.asus.com/product/${stamp}-a`, title: "A", retrievedAt: "2026-08-24T00:00:00.000Z", rank: 0 },
      { url: `https://www.asus.com/product/${stamp}-b`, title: "B", retrievedAt: "2026-08-24T00:00:00.000Z", rank: 1 },
    ] };
    const job = queueSearch({ query: `ASUS-G4-${stamp}`, brand: "ASUS", category: "motherboard" }, { discoveryProviders: [provider], inspect: false });
    const result = await waitForJob(job.jobId);
    expect(result?.candidates).toHaveLength(2);
    expect(result?.discovery.providerIds).toEqual([provider.id]);
    expect(result?.discovery.registryVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.discovery.queryNormalizationVersion).toBe("1.0.0");
  });
});
