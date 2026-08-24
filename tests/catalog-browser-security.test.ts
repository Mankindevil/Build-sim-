import { describe, expect, it, vi } from "vitest";
import { assertPublicHostname, validateOfficialUrlResolved } from "../scripts/price-server/catalog/security.mjs";
import { renderOfficialFallback } from "../scripts/price-server/catalog/browser-fallback.mjs";
import { missingRequiredFields } from "../scripts/price-server/catalog/service.mjs";
import { queueSearch, waitForJob } from "../scripts/price-server/catalog/service.mjs";

const publicLookup = vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]);

function fakePlaywright({ finalUrl = "https://www.asus.com/final", body = "<html>ok</html>" } = {}) {
  let handler: ((route: any) => Promise<void>) | undefined;
  const page: any = {
    route: vi.fn(async (_pattern, callback) => { handler = callback; }),
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => finalUrl),
    content: vi.fn(async () => body),
    mainFrame: vi.fn(() => page),
    runRoute: async (url: string, main = false) => {
      const route = { request: () => ({ url: () => url, isNavigationRequest: () => main, frame: () => page }), continue: vi.fn(), abort: vi.fn() };
      await handler?.(route);
      return route;
    },
  };
  const browser = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
  return { module: { chromium: { launch: vi.fn(async () => browser) } }, page };
}

describe("C1 browser and DNS security", () => {
  it("blocks public hostnames that resolve to private addresses", async () => {
    await expect(assertPublicHostname("www.asus.com", { lookup: async () => [{ address: "127.0.0.1", family: 4 }] })).rejects.toThrow(/resolves to a private/);
    await expect(validateOfficialUrlResolved("https://www.asus.com/product", { lookup: publicLookup })).resolves.toHaveProperty("hostname", "www.asus.com");
  });

  it("revalidates the final URL and blocks an allowlisted to untrusted redirect", async () => {
    const fake = fakePlaywright({ finalUrl: "https://evil.example/product" });
    await expect(renderOfficialFallback("https://www.asus.com/product", { playwrightModule: fake.module, lookup: publicLookup })).rejects.toThrow(/allowlisted/);
  });

  it("blocks private subresources and oversized rendered HTML", async () => {
    const fake = fakePlaywright({ body: "x".repeat(64) });
    await expect(renderOfficialFallback("https://www.asus.com/product", { playwrightModule: fake.module, lookup: publicLookup, maxBytes: 32 })).rejects.toThrow(/size limit/);
    const routed = fakePlaywright();
    await renderOfficialFallback("https://www.asus.com/product", { playwrightModule: routed.module, lookup: publicLookup });
    const route = await routed.page.runRoute("https://127.0.0.1/metadata");
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continue).not.toHaveBeenCalled();
  });

  it("requests renderer fallback when category-required fields are absent", () => {
    const candidate = { category: "motherboard", query: { mpn: "ASUS-G4-001" } };
    const extracted = { fields: ["brand", "model", "mpn"].map((field) => ({ field })) };
    expect(missingRequiredFields(candidate, extracted)).toEqual(["dims.lengthMm", "dims.widthMm"]);
  });

  it("fetches complete static pages once and preserves partial fields when renderer fails", async () => {
    const stamp = Date.now();
    const mpn = `C1-BOARD-${stamp}`;
    const url = `https://www.asus.com/c1/${stamp}`;
    const catalog = { schemaVersion: "2.0.0", updatedAt: "2026-08-24", skus: [{ id: `c1.${stamp}`, category: "motherboard", brand: "ASUS", model: "C1 Board", name: "ASUS C1 Board", mpn, dims: { evidence: "unknown" }, power: { evidence: "unknown" }, price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" }, appearance: { page: url } }] };
    const html = `<script type="application/ld+json">{"@type":"Product","brand":"ASUS","model":"C1 Board","mpn":"${mpn}"}</script>`;
    const fetcher = vi.fn(async () => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", retrievedAt: "2026-08-24T00:00:00.000Z", body: html, contentHash: String(stamp), redirects: [] }));
    const browserFallback = vi.fn(async () => { throw new Error("fixture renderer unavailable"); });
    const job = queueSearch({ query: mpn, brand: "ASUS", category: "motherboard" }, { catalog, fetcher, browserFallback });
    const result = await waitForJob(job.jobId);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browserFallback).toHaveBeenCalledOnce();
    expect(result?.candidates[0].extraction.status).toBe("partial");
    expect(result?.candidates[0].fields.map((field: { field: string }) => field.field)).toEqual(expect.arrayContaining(["brand", "model", "mpn"]));
    expect(result?.candidates[0].extraction.error).toContain("renderer unavailable");
  });
});
