import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assertPublicHostname, validateOfficialUrlResolved } from "../scripts/price-server/catalog/security.mjs";
import { renderOfficialFallback } from "../scripts/price-server/catalog/browser-fallback.mjs";
import { discoverEmbeddedOfficialPdfUrls, extractExactVariantOfficialPdf } from "../scripts/price-server/catalog/extract.mjs";
import { mergeFallbackExtraction, missingRequiredFields } from "../scripts/price-server/catalog/service.mjs";
import { inspectUrl, queueSearch, waitForJob } from "../scripts/price-server/catalog/service.mjs";

const publicLookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

function fakePlaywright({ finalUrl = "https://www.asus.com/final", body = "<html>ok</html>", status = 200, contentType = "text/html; charset=utf-8" } = {}) {
  let handler: ((route: any) => Promise<void>) | undefined;
  const page: any = {
    route: vi.fn(async (_pattern, callback) => { handler = callback; }),
    goto: vi.fn(async () => ({ status: () => status, headerValue: async (name: string) => name.toLocaleLowerCase() === "content-type" ? contentType : null })),
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
    for (const address of ["::ffff:127.0.0.1", "::ffff:10.0.0.1", "::8.8.8.8", "100.64.0.1", "198.18.0.1", "203.0.113.10", "2001:db8::1", "3fff::1", "ff02::1"]) {
      await expect(assertPublicHostname("www.asus.com", { lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }] }), address).rejects.toThrow(/private|local/);
    }
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

  it("reports the effective navigation status and content hash", async () => {
    const body = "<html><title>Rendered response</title></html>";
    const fake = fakePlaywright({ body, status: 206, contentType: "text/html; charset=utf-8" });
    const rendered = await renderOfficialFallback("https://www.asus.com/product", { playwrightModule: fake.module, lookup: publicLookup });
    expect(rendered).toMatchObject({ status: 206, contentType: "text/html", fallback: "playwright" });
    expect(rendered.contentHash).toBe(crypto.createHash("sha256").update(body).digest("hex"));
  });

  it("uses the same SSRF and content bounds with the CloakBrowser renderer", async () => {
    const body = "<html><title>Stealth rendered response</title></html>";
    const fake = fakePlaywright({ body });
    const cloakModule = { launch: fake.module.chromium.launch };
    const rendered = await renderOfficialFallback("https://www.asus.com/product", { cloakModule, lookup: publicLookup });
    expect(rendered).toMatchObject({ status: 200, contentType: "text/html", fallback: "cloakbrowser" });
    const privateRoute = await fake.page.runRoute("https://127.0.0.1/metadata");
    expect(privateRoute.abort).toHaveBeenCalledWith("blockedbyclient");
  });

  it("falls back to stock Playwright when CloakBrowser is unavailable in auto mode", async () => {
    const fake = fakePlaywright({ body: "<html><title>Stock fallback</title></html>" });
    const rendered = await renderOfficialFallback("https://www.asus.com/product", {
      renderer: "auto",
      cloakModule: { launch: vi.fn(async () => { throw new Error("signed binary unavailable"); }) },
      playwrightModule: fake.module,
      lookup: publicLookup,
    });
    expect(rendered).toMatchObject({ fallback: "playwright", status: 200 });
  });

  it("discovers href and data-url official PDFs in relevance order", () => {
    const html = `<a data-url="/downloads/manual.pdf">User manual</a>
      <button data-url="https://seasonic.com/downloads/focus-specification.pdf">Technical Datasheet</button>
      <a href="javascript:alert(1)">ignore</a>`;
    expect(discoverEmbeddedOfficialPdfUrls(html, "https://seasonic.com/products/focus/")).toEqual([
      "https://seasonic.com/downloads/focus-specification.pdf",
      "https://seasonic.com/downloads/manual.pdf",
    ]);
  });

  it("extracts shared dimensions and rated power only after an exact PDF MPN row", () => {
    const fetchResult = {
      finalUrl: "https://seasonic.com/downloads/focus.pdf",
      status: 200,
      contentType: "application/pdf",
      retrievedAt: "2026-08-31T00:00:00.000Z",
      contentHash: "a".repeat(64),
      body: "Seasonic\nDimensions: 140 mm (L) x 150 mm (W) x 86 mm (H)\nSSR-850FX 20 A 20 A 70 A 0.3 A 3 A 850 W",
    };
    const exact = extractExactVariantOfficialPdf(fetchResult, { mpn: "SSR-850FX", brand: "Seasonic" });
    expect(exact.exactVariant).toBe(true);
    expect(exact.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "mpn", value: "SSR-850FX" }),
      expect.objectContaining({ field: "brand", value: "Seasonic" }),
      expect.objectContaining({ field: "dims.lengthMm", value: 140 }),
      expect.objectContaining({ field: "dims.widthMm", value: 150 }),
      expect.objectContaining({ field: "dims.heightMm", value: 86 }),
      expect.objectContaining({ field: "power.ratedW", value: 850 }),
    ]));
    const wrong = extractExactVariantOfficialPdf(fetchResult, { mpn: "SSR-1000FX", brand: "Seasonic" });
    expect(wrong.exactVariant).toBe(false);
    expect(wrong.fields).toEqual([]);
  });

  it("requests renderer fallback when category-required fields are absent", () => {
    const candidate = { category: "motherboard", query: { mpn: "ASUS-G4-001" } };
    const extracted = { fields: ["brand", "model", "mpn"].map((field) => ({ field })) };
    expect(missingRequiredFields(candidate, extracted)).toEqual(["dims.lengthMm", "dims.widthMm"]);
    const gpu = { category: "gpu", query: {} };
    expect(missingRequiredFields(gpu, { fields: ["brand", "model", "dims.lengthMm", "power.tgpW", "dims.thicknessMm"].map((field) => ({ field })) })).toEqual([]);
    expect(missingRequiredFields(gpu, { fields: ["brand", "model", "dims.lengthMm", "power.tgpW"].map((field) => ({ field })) })).toEqual(["dims.slots|dims.thicknessMm"]);
  });

  it("fetches complete static pages once and preserves partial fields when renderer fails", async () => {
    const stamp = Date.now();
    const mpn = `C1-BOARD-${stamp}`;
    const url = `https://www.asus.com/c1/${stamp}`;
    const catalog = { schemaVersion: "2.0.0", updatedAt: "2026-08-24", skus: [{ id: `c1.${stamp}`, category: "motherboard", brand: "ASUS", model: "C1 Board", name: "ASUS C1 Board", mpn, dims: { evidence: "unknown" }, power: { evidence: "unknown" }, price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" }, appearance: { page: url } }] };
    const html = `<script type="application/ld+json">{"@type":"Product","brand":"ASUS","model":"C1 Board","mpn":"${mpn}"}</script>`;
    const fetcher = vi.fn(async () => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", retrievedAt: "2026-08-24T00:00:00.000Z", body: html, contentHash: String(stamp), redirects: [] }));
    const browserFallback = vi.fn(async () => { throw new Error("fixture renderer unavailable"); });
    const job = await queueSearch({ query: mpn, brand: "ASUS", category: "motherboard" }, { catalog, fetcher, browserFallback });
    const result = await waitForJob(job.jobId);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browserFallback).toHaveBeenCalledOnce();
    expect(result?.candidates[0].extraction.status).toBe("partial");
    expect(result?.candidates[0].fields.map((field: { field: string }) => field.field)).toEqual(expect.arrayContaining(["brand", "model", "mpn"]));
    expect(result?.candidates[0].extraction.error).toContain("renderer unavailable");
  });

  it("merges a sparse rendered field into eight static fields without discarding evidence", async () => {
    const stamp = Date.now();
    const url = `https://www.asus.com/c1/static-rich-${stamp}`;
    const initialBody = `<html><head><script type="application/ld+json">{"@type":"Product","brand":"ASUS","model":"Static Rich Board"}</script></head><body>
      <div><span>Length</span><span>240 mm</span></div>
      <div><span>Height</span><span>40 mm</span></div>
      <div><span>Graphics Power</span><span>120 W</span></div>
      <div><span>Noise Level</span><span>28 dBA</span></div>
      <div><span>Capacity</span><span>16 GB</span></div>
      <div><span>Interface</span><span>PCIe 4.0</span></div>
    </body></html>`;
    const renderedBody = `<html><body><div><span>Width</span><span>244 mm</span></div></body></html>`;
    const fetcher = vi.fn(async () => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", retrievedAt: "2026-08-26T11:00:00.000Z", body: initialBody, contentHash: crypto.createHash("sha256").update(initialBody).digest("hex"), redirects: [] }));
    const browserFallback = vi.fn(async () => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", retrievedAt: "2026-08-26T11:00:01.000Z", body: renderedBody, contentHash: crypto.createHash("sha256").update(renderedBody).digest("hex"), redirects: [], fallback: "playwright" }));

    const result = await inspectUrl({ url, query: "ASUS Static Rich Board", brand: "ASUS", category: "motherboard" }, { fetcher, browserFallback, responseCache: new Map() });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(browserFallback).toHaveBeenCalledOnce();
    expect(result.source).toMatchObject({ httpStatus: 200, fetchMode: "playwright", initialFetch: { httpStatus: 200, retrievedAt: "2026-08-26T11:00:00.000Z" } });
    expect(result.fields).toHaveLength(9);
    expect(result.fields.map((field: { field: string }) => field.field)).toEqual(expect.arrayContaining(["brand", "model", "dims.lengthMm", "dims.heightMm", "power.tgpW", "attrs.noiseDba", "attrs.capacity", "attrs.interface", "dims.widthMm"]));
    expect(result.fields.find((field: { field: string }) => field.field === "power.tgpW")).toMatchObject({ value: 120, sourceKind: "official-page", retrievedAt: "2026-08-26T11:00:00.000Z" });
    expect(result.fields.find((field: { field: string }) => field.field === "dims.widthMm")).toMatchObject({ value: 244, sourceKind: "official-rendered-page", retrievedAt: "2026-08-26T11:00:01.000Z" });
    expect(result.extraction).toMatchObject({ status: "ok", fieldsFound: 9, adapter: expect.stringContaining("playwright-fallback") });
  });

  it("lets rendered fields override by name while retaining both extractors' conflicts and warnings", () => {
    const merged = mergeFallbackExtraction(
      { title: "Static", fields: [{ field: "model", value: "static" }, { field: "power.tgpW", value: 120 }], conflicts: [{ field: "power.tgpW", values: [110, 120], reason: "static conflict" }], warnings: ["static warning"], adapter: "static-v1" },
      { title: "Rendered", fields: [{ field: "model", value: "rendered" }, { field: "dims.widthMm", value: 244 }], conflicts: [{ field: "dims.widthMm", values: [243, 244], reason: "rendered conflict" }], warnings: ["rendered warning"], adapter: "rendered-v1" },
    );
    expect(merged.title).toBe("Rendered");
    expect(merged.fields).toEqual([{ field: "model", value: "rendered" }, { field: "power.tgpW", value: 120 }, { field: "dims.widthMm", value: 244 }]);
    expect(merged.conflicts).toHaveLength(2);
    expect(merged.warnings).toEqual(["static warning", "rendered warning"]);
  });

  it("uses a successful rendered Seasonic response as the effective fetch while auditing the initial 403", async () => {
    const stamp = Date.now();
    const url = `https://seasonic.com/focus-plus-gold-fallback-${stamp}/`;
    const initialBody = "<html><body>Forbidden</body></html>";
    const renderedBody = `<html><head><title>FOCUS Plus Gold 850 FX</title><script type="application/ld+json">{"@type":"Product","brand":"Seasonic","model":"FOCUS Plus Gold 850 FX"}</script></head><body><div><span>Rated Power</span><span>850 W</span></div></body></html>`;
    const initialHash = crypto.createHash("sha256").update(initialBody).digest("hex");
    const renderedHash = crypto.createHash("sha256").update(renderedBody).digest("hex");
    const fetcher = vi.fn(async () => ({ requestedUrl: url, finalUrl: url, status: 403, contentType: "text/html", retrievedAt: "2026-08-26T10:00:00.000Z", body: initialBody, contentHash: initialHash, redirects: [] }));
    const browserFallback = vi.fn(async () => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", retrievedAt: "2026-08-26T10:00:01.000Z", body: renderedBody, contentHash: renderedHash, redirects: [], fallback: "playwright" }));
    const responseCache = new Map();
    const input = { url, query: "Seasonic FOCUS Plus Gold 850 FX", brand: "Seasonic", category: "psu" };

    const first = await inspectUrl(input, { fetcher, browserFallback, responseCache });
    const repeated = await inspectUrl(input, { fetcher, browserFallback, responseCache });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(browserFallback).toHaveBeenCalledOnce();
    expect(first.source).toMatchObject({
      httpStatus: 200,
      finalUrl: url,
      retrievedAt: "2026-08-26T10:00:01.000Z",
      fetchMode: "playwright",
      initialFetch: { httpStatus: 403, finalUrl: url, retrievedAt: "2026-08-26T10:00:00.000Z", contentHash: initialHash },
    });
    expect(first.extraction).toMatchObject({ status: "ok", contentHash: renderedHash });
    expect(first.official).toMatchObject({ pageKind: "product" });
    expect(first.identity).toMatchObject({ verdict: "exact" });
    expect(first.fields.map((field: { field: string }) => field.field)).toEqual(expect.arrayContaining(["brand", "model", "power.ratedW"]));
    expect(first.fields.find((field: { field: string }) => field.field === "power.ratedW")).toMatchObject({ sourceKind: "official-rendered-page", sourceUrl: url, retrievedAt: "2026-08-26T10:00:01.000Z" });
    expect(first.accessBarrier).toBeUndefined();
    expect(repeated.source).toEqual(first.source);
    expect(repeated.extraction.contentHash).toBe(renderedHash);
  });

  it("uses CloakBrowser to reach a family page and follows an exact-variant official PDF", async () => {
    const stamp = Date.now();
    const url = `https://seasonic.com/product/focus-plus-gold-${stamp}/`;
    const pdfUrl = `https://seasonic.com/wp-content/uploads/focus-plus-gold-${stamp}.pdf`;
    const initialBody = "<html><body>Forbidden</body></html>";
    const renderedBody = `<html><head><title>Seasonic Focus Plus Gold High Quality Power Supplies</title></head><body><a data-url="${pdfUrl}">Datasheet</a></body></html>`;
    const pdfBody = "Seasonic\nDimensions: 140 mm (L) x 150 mm (W) x 86 mm (H)\nSSR-850FX 20 A 20 A 70 A 0.3 A 3 A 850 W";
    const hash = (body: string) => crypto.createHash("sha256").update(body).digest("hex");
    const fetcher = vi.fn(async (requestedUrl: string) => requestedUrl === pdfUrl
      ? { requestedUrl, finalUrl: requestedUrl, status: 200, contentType: "application/pdf", retrievedAt: "2026-08-31T16:30:02.000Z", body: pdfBody, contentHash: hash(pdfBody), redirects: [], pdfExtraction: { mode: "text", ocrAttempted: false } }
      : { requestedUrl, finalUrl: requestedUrl, status: 403, contentType: "text/html", retrievedAt: "2026-08-31T16:30:00.000Z", body: initialBody, contentHash: hash(initialBody), redirects: [] });
    const browserFallback = vi.fn(async () => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", retrievedAt: "2026-08-31T16:30:01.000Z", body: renderedBody, contentHash: hash(renderedBody), redirects: [], fallback: "cloakbrowser" }));

    const result = await inspectUrl({ url, query: "Seasonic Focus Plus Gold 850 SSR-850FX", brand: "Seasonic", model: "Focus Plus Gold 850", mpn: "SSR-850FX", category: "psu" }, { fetcher, browserFallback, responseCache: new Map() });

    expect(result.source).toMatchObject({ fetchMode: "cloakbrowser", supportingDocuments: [expect.objectContaining({ finalUrl: pdfUrl, exactVariant: true })] });
    expect(result.identity).toMatchObject({ verdict: "exact", agentReviewRequired: false });
    expect(result.extraction).toMatchObject({ status: "ok", adapter: expect.stringContaining("official-document"), supportingDocuments: [expect.objectContaining({ contentHash: hash(pdfBody) })] });
    expect(result.extraction.contentHash).not.toBe(hash(renderedBody));
    expect(result.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "mpn", value: "SSR-850FX", sourceUrl: pdfUrl }),
      expect.objectContaining({ field: "power.ratedW", value: 850, sourceUrl: pdfUrl }),
      expect.objectContaining({ field: "dims.lengthMm", value: 140, sourceUrl: pdfUrl }),
    ]));
  });

  it("does not merge a same-brand PDF that lacks the requested exact variant", async () => {
    const stamp = Date.now();
    const url = `https://seasonic.com/product/wrong-variant-${stamp}/`;
    const pdfUrl = `https://seasonic.com/downloads/wrong-variant-${stamp}.pdf`;
    const renderedBody = `<html><head><title>Seasonic Focus Plus Gold</title></head><body><a href="${pdfUrl}">Specification</a></body></html>`;
    const pdfBody = "Seasonic\nDimensions: 140 mm (L) x 150 mm (W) x 86 mm (H)\nSSR-1000FX 25 A 25 A 83 A 0.3 A 3 A 1000 W";
    const hash = (body: string) => crypto.createHash("sha256").update(body).digest("hex");
    const fetcher = vi.fn(async (requestedUrl: string) => requestedUrl === pdfUrl
      ? { requestedUrl, finalUrl: requestedUrl, status: 200, contentType: "application/pdf", retrievedAt: "2026-08-31T17:00:02.000Z", body: pdfBody, contentHash: hash(pdfBody), redirects: [], pdfExtraction: { mode: "text", ocrAttempted: false } }
      : { requestedUrl, finalUrl: requestedUrl, status: 403, contentType: "text/html", retrievedAt: "2026-08-31T17:00:00.000Z", body: "Forbidden", contentHash: hash("Forbidden"), redirects: [] });
    const browserFallback = vi.fn(async () => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", retrievedAt: "2026-08-31T17:00:01.000Z", body: renderedBody, contentHash: hash(renderedBody), redirects: [], fallback: "cloakbrowser" }));

    const result = await inspectUrl({ url, query: "Seasonic Focus Plus Gold SSR-850FX", brand: "Seasonic", mpn: "SSR-850FX", category: "psu" }, { fetcher, browserFallback, responseCache: new Map() });

    expect(result.extraction.status).toBe("partial");
    expect(result.fields.some((field: { field: string }) => field.field === "mpn")).toBe(false);
    expect(result.source.supportingDocuments).toEqual([expect.objectContaining({ exactVariant: false })]);
  });

  it("does not retain a failed 403 or its failed renderer attempt in response caches", async () => {
    const stamp = Date.now();
    const url = `https://seasonic.com/focus-plus-gold-blocked-${stamp}/`;
    const body = "<html><body>Forbidden</body></html>";
    const fetcher = vi.fn(async () => ({ requestedUrl: url, finalUrl: url, status: 403, contentType: "text/html", retrievedAt: "2026-08-26T10:01:00.000Z", body, contentHash: crypto.createHash("sha256").update(body).digest("hex"), redirects: [] }));
    const browserFallback = vi.fn(async () => { throw new Error("fixture browser unavailable"); });
    const responseCache = new Map();
    const input = { url, query: "Seasonic FOCUS Plus Gold 850 FX", brand: "Seasonic", category: "psu" };

    const first = await inspectUrl(input, { fetcher, browserFallback, responseCache });
    const repeated = await inspectUrl(input, { fetcher, browserFallback, responseCache });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(browserFallback).toHaveBeenCalledTimes(2);
    expect(responseCache.size).toBe(0);
    expect(first.source.httpStatus).toBe(403);
    expect(repeated.extraction.error).toContain("fixture browser unavailable");
  });
});
