import crypto from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CatalogCacheDiscoveryProvider, discoverOfficialUrls } from "../scripts/price-server/catalog/discovery.mjs";
import { normalizeModelQuery } from "../scripts/price-server/catalog/normalize.mjs";
import { queueSearch, waitForJob } from "../scripts/price-server/catalog/service.mjs";
import { transactionCatalogSearchRequest } from "../scripts/price-server/transactions/catalog-search-request.mjs";

const expectedSku = {
  id: "board.example",
  category: "motherboard",
  brand: "ASUS",
  model: "Pro WS X1",
  name: "ASUS Pro WS X1",
  mpn: "EX-BOARD-X1",
  dims: { evidence: "official" },
  power: { evidence: "official" },
  price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
  appearance: { page: "https://www.asus.com/example" },
};

const catalog = {
  schemaVersion: "2.0.0",
  updatedAt: "2026-09-01",
  skus: [
    {
      ...expectedSku,
      id: "board.example-sibling",
      name: "ASUS Pro WS X1 sibling",
      appearance: { page: "https://www.asus.com/example-sibling" },
    },
    expectedSku,
  ],
};

describe("expected catalog SKU official discovery", () => {
  it("validates the transaction boundary instead of silently discarding an invalid expectedSkuId", () => {
    expect(transactionCatalogSearchRequest({
      query: "ASUS Pro WS X1",
      expectedSkuId: expectedSku.id,
      category: "motherboard",
    })).toMatchObject({ expectedSkuId: expectedSku.id, officialOnly: true, limit: 8 });
    expect(() => transactionCatalogSearchRequest({ query: "x", category: "accessory", expectedSkuId: "" })).toThrow(/expectedSkuId/);
    expect(() => transactionCatalogSearchRequest({ query: "x", category: "accessory", expectedSkuId: "../escape" })).toThrow(/expectedSkuId/);
    expect(() => transactionCatalogSearchRequest({ query: "x", category: "accessory", expectedSkuId: 42 })).toThrow(/expectedSkuId/);
  });

  it("puts the exact catalog URL first even when catalog-cache was registered after another provider", async () => {
    const query = normalizeModelQuery("ASUS Pro WS X1", { brand: "ASUS", model: "Pro WS X1", category: "motherboard" });
    let observedExpectedSkuId: string | undefined;
    const earlierProvider = {
      id: "earlier-search",
      discover: async ({ expectedSkuId }: { expectedSkuId?: string }) => {
        observedExpectedSkuId = expectedSkuId;
        return [{ url: "https://www.asus.com/unrelated", title: "unrelated", retrievedAt: "2026-09-01T00:00:00.000Z", rank: 0 }];
      },
    };
    const result = await discoverOfficialUrls({
      query,
      catalog,
      providers: [earlierProvider, new CatalogCacheDiscoveryProvider(catalog)],
      expectedSkuId: expectedSku.id,
      limit: 8,
    });

    expect(observedExpectedSkuId).toBe(expectedSku.id);
    expect(result.providerIds).toEqual(["earlier-search", "catalog-cache"]);
    expect(result.candidates[0]).toMatchObject({
      skuId: expectedSku.id,
      url: expectedSku.appearance.page,
      provider: "catalog-cache",
      matchScore: 1,
      rank: 0,
    });
  });

  it("prioritizes a user-replaced trusted URL and keeps it bound to the existing SKU", async () => {
    const persistRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-replaced-official-url-"));
    try {
      const queued = await queueSearch({
        query: "ASUS Pro WS X1",
        brand: "ASUS",
        model: "Pro WS X1",
        mpn: "EX-BOARD-X1",
        expectedSkuId: expectedSku.id,
        category: "motherboard",
        officialUrl: "https://www.asus.com/new-official-product-page",
        trigger: "user-confirmed-review",
      }, {
        catalog,
        persistRoot,
        discoveryProviders: [new CatalogCacheDiscoveryProvider(catalog)],
        inspect: false,
      });
      const completed = await waitForJob(queued.jobId, 5_000, { persistRoot });
      expect(completed?.candidates[0]).toMatchObject({
        skuId: expectedSku.id,
        url: "https://www.asus.com/new-official-product-page",
        discovery: { provider: "user-submitted-url", submittedByUser: true },
      });
      expect(completed?.candidates[1]).toMatchObject({ skuId: expectedSku.id, url: expectedSku.appearance.page });
    } finally {
      await rm(persistRoot, { recursive: true, force: true });
    }
  });

  it("rejects unknown or query-conflicting expected SKU ids at the service boundary", async () => {
    const base = { query: "ASUS Pro WS X1", brand: "ASUS", model: "Pro WS X1", category: "motherboard" };
    await expect(queueSearch({ ...base, expectedSkuId: "board.unknown" }, { catalog, inspect: false })).rejects.toThrow(/does not exist/);
    await expect(queueSearch({ ...base, expectedSkuId: "../escape" }, { catalog, inspect: false })).rejects.toThrow(/valid catalog SKU id/);
    await expect(queueSearch({ ...base, brand: "OtherBrand", expectedSkuId: expectedSku.id }, { catalog, inspect: false })).rejects.toThrow(/brand/);
    await expect(queueSearch({ ...base, model: "Pro WS X2", expectedSkuId: expectedSku.id }, { catalog, inspect: false })).rejects.toThrow(/model/);
    await expect(queueSearch({ ...base, category: "gpu", expectedSkuId: expectedSku.id }, { catalog, inspect: false })).rejects.toThrow(/category/);
    await expect(queueSearch({ ...base, mpn: "EX-BOARD-X2", expectedSkuId: expectedSku.id }, { catalog, inspect: false })).rejects.toThrow(/mpn/);
  });

  it("does not admit or prioritize an expected SKU whose URL belongs to another trusted brand", async () => {
    const poisonedCatalog = {
      ...catalog,
      skus: [{ ...expectedSku, id: "board.cross-brand", brand: "JONSBO", name: "JONSBO Pro WS X1" }],
    };
    const query = normalizeModelQuery("JONSBO Pro WS X1", { brand: "JONSBO", model: "Pro WS X1", category: "motherboard" });
    const crossBrandProvider = {
      id: "cross-brand-search",
      discover: async () => [{ url: "https://www.asus.com/cross-brand", title: "wrong brand", retrievedAt: "2026-09-01T00:00:00.000Z", rank: 0 }],
    };
    const result = await discoverOfficialUrls({
      query,
      catalog: poisonedCatalog,
      providers: [crossBrandProvider, new CatalogCacheDiscoveryProvider(poisonedCatalog)],
      expectedSkuId: "board.cross-brand",
      limit: 8,
    });
    expect(result.candidates).toEqual([]);
    expect(result.warnings.join(" ")).toContain("cross-brand official domain");
  });

  it("persists expectedSkuId, includes it in the job key, and stops after its usable exact catalog page", async () => {
    const persistRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-expected-sku-"));
    const fixturePath = new URL("./fixtures/catalog/official-product.html", import.meta.url);
    const html = (await readFile(fixturePath, "utf8")).replaceAll("ExampleBrand", "ASUS").replace(
      '"name":"ExampleBoard Pro WS X1","brand"',
      '"name":"ExampleBoard Pro WS X1","model":"Pro WS X1","brand"',
    );
    const fetched: string[] = [];
    const fallbackProvider = {
      id: "expected-sku-fallback",
      discover: async () => [{ url: "https://www.asus.com/fallback", title: "fallback", retrievedAt: "2026-09-01T00:00:00.000Z", rank: 0 }],
    };
    const options = {
      catalog,
      persistRoot,
      discoveryProviders: [fallbackProvider, new CatalogCacheDiscoveryProvider(catalog)],
      inspect: true,
      fetcher: async (url: string) => {
        fetched.push(url);
        return {
          requestedUrl: url,
          finalUrl: url,
          status: 200,
          contentType: "text/html",
          retrievedAt: "2026-09-01T00:00:00.000Z",
          body: html,
          contentHash: crypto.createHash("sha256").update(html).digest("hex"),
          redirects: [],
        };
      },
    };
    const body = {
      query: "ASUS Pro WS X1",
      brand: "ASUS",
      model: "Pro WS X1",
      mpn: "EX-BOARD-X1",
      category: "motherboard",
      trigger: "user-confirmed-review",
    };

    try {
      const targeted = await queueSearch({ ...body, expectedSkuId: expectedSku.id }, options);
      const untargeted = await queueSearch(body, { ...options, inspect: false });
      expect(targeted.jobId).not.toBe(untargeted.jobId);
      expect(targeted.expectedSkuId).toBe(expectedSku.id);

      const completed = await waitForJob(targeted.jobId, 5_000, { persistRoot });
      await waitForJob(untargeted.jobId, 5_000, { persistRoot });
      expect(completed?.expectedSkuId).toBe(expectedSku.id);
      expect(completed?.status).toBe("completed");
      expect(completed?.candidates).toHaveLength(1);
      expect(completed?.candidates[0]).toMatchObject({
        skuId: expectedSku.id,
        url: expectedSku.appearance.page,
        identity: { verdict: "exact" },
        extraction: { status: "ok" },
      });
      expect(fetched).toEqual([expectedSku.appearance.page]);
    } finally {
      await rm(persistRoot, { recursive: true, force: true });
    }
  });
});
