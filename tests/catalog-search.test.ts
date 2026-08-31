import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { normalizeModelQuery } from "../src/catalog-search/normalize";
import { normalizeModelQuery as normalizeServerModelQuery } from "../scripts/price-server/catalog/normalize.mjs";
import { extractOfficialHtml, extractOfficialPdf } from "../scripts/price-server/catalog/extract.mjs";
import { assessCatalogIdentity } from "../scripts/price-server/catalog/identity.mjs";
import { extractPdfText, fetchOfficial } from "../scripts/price-server/catalog/fetch.mjs";
import { validateOfficialUrl, validateRedirect } from "../scripts/price-server/catalog/security.mjs";
import { getJob, queueSearch, waitForJob } from "../scripts/price-server/catalog/service.mjs";
import { OFFICIAL_ADAPTERS, adapterForUrl } from "../scripts/price-server/catalog/adapters.mjs";
import { MsiProductDiscoveryProvider } from "../scripts/price-server/catalog/discovery.mjs";
import { transactionCatalogSearchRequest } from "../scripts/price-server/transactions/catalog-search-request.mjs";
import { acceptOfficial, confirmDraft, createDraft, rejectDraft, rollbackCatalogAcceptance } from "../scripts/price-server/catalog/write.mjs";
import { catalogCandidateInputHash } from "../scripts/price-server/catalog/contracts.mjs";
import { runAutoEnrichment } from "../scripts/price-server/catalog/auto-enrichment.mjs";
import { CatalogSearchJobRepository } from "../scripts/price-server/catalog/catalog-job-repository.mjs";
import type { SkuCatalog } from "../src/sku/types";

const fixturePath = new URL("./fixtures/catalog/official-product.html", import.meta.url);
const html = await readFile(fixturePath, "utf8");
const fetchResult = {
  requestedUrl: "https://www.asus.com/example",
  finalUrl: "https://www.asus.com/example",
  status: 200,
  contentType: "text/html",
  retrievedAt: "2026-08-23T00:00:00.000Z",
  body: html,
  contentHash: crypto.createHash("sha256").update(html).digest("hex"),
  redirects: [],
};
const publicDnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];

afterEach(() => {
  // The fetcher tests temporarily replace the global network primitive.
  vi.unstubAllGlobals();
});

describe("G3 model query normalization", () => {
  it("retains raw input while separating brand, model, MPN, capacity and interface", () => {
    const query = normalizeModelQuery(" Seagate　Exos X24 24TB SATA ");
    expect(query.raw).toBe(" Seagate　Exos X24 24TB SATA ");
    expect(query.brand).toBe("Seagate");
    expect(query.capacity).toBe("24TB");
    expect(query.interface).toBe("sata");
    expect(query.model).toContain("Exos X24");
    expect(query.tokens).toContain("seagate");
  });

  it("preserves an exact punctuation-sensitive MPN instead of guessing a brand", () => {
    const query = normalizeModelQuery("CP‐9020284 850W power supply");
    expect(query.mpn).toBe("CP-9020284");
    expect(query.brand).toBeUndefined();
    expect(query.category).toBe("psu");
  });

  it("recognizes the WD alias without matching it inside unrelated words", () => {
    expect(normalizeModelQuery("WD Red Plus 8TB SATA").brand).toBe("Western Digital");
    expect(normalizeModelQuery("hardware GX-850").brand).toBeUndefined();
  });

  it("keeps Seasonic family models distinct from exact manufacturer part numbers", () => {
    for (const normalize of [normalizeModelQuery, normalizeServerModelQuery]) {
      const family = normalize("Seasonic GX-850 FX", { category: "psu" });
      expect(family).toMatchObject({ brand: "Seasonic", model: "GX-850 FX", category: "psu" });
      expect(family.mpn).toBeUndefined();
      expect(normalize("GX-850", { category: "psu" }).mpn).toBeUndefined();

      const exact = normalize("Seasonic SSR-850FX", { category: "psu" });
      expect(exact.mpn).toBe("SSR-850FX");
    }
  });

  it("keeps GPU chip marketing names out of the MPN field", () => {
    for (const normalize of [normalizeModelQuery, normalizeServerModelQuery]) {
      for (const raw of ["MSI RTX-5060TI 16GB", "AMD RX-7900-XTX 24GB", "Intel ARC-A770 16GB", "NVIDIA GTX1080TI"]) {
        const normalized = normalize(raw, { category: "gpu" });
        expect(normalized.mpn, raw).toBeUndefined();
        expect(normalized.model, raw).toBeTruthy();
      }
      expect(normalize("Seasonic SSR-850FX", { category: "psu" }).mpn).toBe("SSR-850FX");
      expect(normalize("MSI 912-V390-001", { category: "gpu" }).mpn).toBe("912-V390-001");
    }
  });

  it("keeps multi-token product model names out of the inferred MPN field", () => {
    for (const normalize of [normalizeModelQuery, normalizeServerModelQuery]) {
      expect(normalize("ASUS Pro WS W680M-ACE SE", { category: "motherboard" })).toMatchObject({
        brand: "ASUS",
        model: "Pro WS W680M-ACE SE",
        category: "motherboard",
      });
      expect(normalize("ASUS Pro WS W680M-ACE SE", { category: "motherboard" }).mpn).toBeUndefined();
      expect(normalize("ASUS PRIME-B650M-A WIFI", { category: "motherboard" }).mpn).toBeUndefined();
    }
  });

  it("uses caller-supplied model and MPN identities without heuristic rewriting", () => {
    for (const normalize of [normalizeModelQuery, normalizeServerModelQuery]) {
      expect(normalize("ASUS Pro WS W680M-ACE SE", {
        brand: "ASUS",
        category: "motherboard",
        model: "Pro WS W680M-ACE SE",
        mpn: "90MB1A20-M0EAY0",
      })).toMatchObject({ model: "Pro WS W680M-ACE SE", mpn: "90MB1A20-M0EAY0" });
    }
  });
});

describe("G3 official extraction and provenance", () => {
  it("extracts JSON-LD and specification rows with field-level provenance", () => {
    const extracted = extractOfficialHtml(fetchResult);
    expect(extracted.fields.find((field) => field.field === "mpn")?.value).toBe("EX-BOARD-X1");
    expect(extracted.fields.find((field) => field.field === "dims.lengthMm")?.value).toBe(244);
    expect(extracted.fields.every((field) => field.sourceUrl === fetchResult.finalUrl)).toBe(true);
    expect(extracted.fields.every((field) => field.provenanceId.startsWith("prov-"))).toBe(true);
    expect(extracted.fields.every((field) => field.snippet && field.snippet.length <= 240)).toBe(true);
  });

  it("does not promote a JSON-LD site SKU or CMS id to manufacturer MPN", () => {
    const body = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "Pro WS W680M-ACE SE",
      sku: "23762",
      brand: { name: "ASUS" },
    })}</script>`;
    const extracted = extractOfficialHtml({ ...fetchResult, body, contentHash: "asus-site-sku" });
    expect(extracted.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "brand", value: "ASUS" }),
      expect.objectContaining({ field: "model", value: "Pro WS W680M-ACE SE" }),
    ]));
    expect(extracted.fields.some((field) => field.field === "mpn")).toBe(false);
  });

  it("retains an explicitly published JSON-LD manufacturer MPN", () => {
    const body = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "Example Product",
      sku: "internal-23762",
      mpn: "90MB1A20-M0EAY0",
      brand: { name: "ASUS" },
    })}</script>`;
    const extracted = extractOfficialHtml({ ...fetchResult, body, contentHash: "explicit-jsonld-mpn" });
    expect(extracted.fields.find((field) => field.field === "mpn")?.value).toBe("90MB1A20-M0EAY0");
  });

  it("does not treat a generic SKU specification label as MPN evidence", () => {
    const body = `<title>Pro WS W680M-ACE SE</title><div><span>SKU</span><span>23762</span></div>`;
    const extracted = extractOfficialHtml({ ...fetchResult, body, contentHash: "generic-sku-label" });
    expect(extracted.fields.some((field) => field.field === "mpn")).toBe(false);
  });

  it("accepts the ASUS board page when its numeric JSON-LD SKU is only a site id", () => {
    const query = normalizeServerModelQuery("ASUS Pro WS W680M-ACE SE", {
      brand: "ASUS",
      model: "Pro WS W680M-ACE SE",
      mpn: "Pro WS W680M-ACE SE",
      category: "motherboard",
    });
    const body = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product", name: "Pro WS W680M-ACE SE", sku: "23762", brand: { name: "ASUS" },
    })}</script>`;
    const extracted = extractOfficialHtml({ ...fetchResult, body, contentHash: "asus-23762-integration" });
    const identity = assessCatalogIdentity({
      query, category: "motherboard", canonicalUrl: "https://www.asus.com/motherboards-components/motherboards/workstation/pro-ws-w680m-ace-se/",
    }, extracted, { brand: "ASUS" });
    expect(identity).toMatchObject({ verdict: "exact", reasons: ["official brand and model exactly match"] });
    expect(identity.criticalConflicts).toHaveLength(0);
  });

  it("extracts explicit vendor Model Number and Rated Power labels", () => {
    const body = `<title>WD Red Plus 8TB</title><div><span>Model Number</span><span>WD80EFPX</span></div><div><span>Capacity</span><span>8TB</span></div><div><span>Interface</span><span>SATA</span></div><div><span>Rated Power</span><span>850 W</span></div>`;
    const extracted = extractOfficialHtml({ ...fetchResult, body, contentHash: "explicit-model-rated-power" });
    expect(extracted.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "mpn", value: "WD80EFPX" }),
      expect.objectContaining({ field: "power.ratedW", value: 850 }),
    ]));
  });

  it("keeps conflicting field values and missing facts visible", async () => {
    const conflictHtml = await readFile(new URL("./fixtures/catalog/conflict-product.html", import.meta.url), "utf8");
    const extracted = extractOfficialHtml({ ...fetchResult, body: conflictHtml, contentHash: "conflict-hash" });
    expect(extracted.conflicts).toEqual([{ field: "mpn", values: ["EX-CONFLICT-1", "EX-CONFLICT-2"], reason: "同一来源字段值冲突" }]);
    expect(extracted.warnings.join(" ")).toContain("missing official fields");
  });

  it("does not treat an official PDF marker as HTML parameters", async () => {
    const pdf = await readFile(new URL("./fixtures/catalog/official-spec.pdf", import.meta.url), "utf8");
    const extracted = extractOfficialHtml({ ...fetchResult, contentType: "application/pdf", body: pdf, contentHash: "pdf-hash" });
    expect(extracted.fields).toHaveLength(0);
    expect(extracted.warnings.join(" ")).toContain("PDF content requires a PDF extractor");
  });

  it("extracts only explicit labelled values from text-bearing official PDFs", () => {
    const extracted = extractOfficialPdf({ ...fetchResult, contentType: "application/pdf", body: "MPN: EX-PDF-1\nLength: 244 mm" });
    expect(extracted.fields.map((field) => field.field)).toEqual(["mpn", "dims.lengthMm"]);
    expect(extracted.fields.find((field) => field.field === "dims.lengthMm")?.sourceKind).toBe("official-pdf");
    expect(extracted.fields.every((field) => field.extractor === "generic-official-pdf-text-v1")).toBe(true);
  });

  it("extracts a bounded text layer from a real binary official PDF", async () => {
    const bytes = await readFile(new URL("../data/boards/asus-w680m-ace-se/asus-w680m-manual.pdf", import.meta.url));
    const text = await extractPdfText(bytes, { maxBytes: 5_000_000 });
    expect(text).toMatch(/W680M-ACE\s+SE/i);
    expect(Buffer.byteLength(text)).toBeLessThan(5_000_000);
  });
});

describe("G3 official URL safety", () => {
  it("allows only HTTPS allowlisted official domains and rechecks redirects", () => {
    expect(validateOfficialUrl("https://www.asus.com/motherboards/example").hostname).toBe("www.asus.com");
    expect(() => validateOfficialUrl("http://www.asus.com/example")).toThrow(/https/);
    expect(() => validateOfficialUrl("https://127.0.0.1/example")).toThrow(/private|local/);
    expect(() => validateOfficialUrl("https://evil.example/example")).toThrow(/allowlisted/);
    expect(() => validateRedirect("https://localhost/private")).toThrow(/private|local/);
  });

  it("enforces redirect and response-size limits without forwarding credentials", async () => {
    let calls = 0;
    const redirectingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      expect(init?.headers).not.toHaveProperty("authorization");
      return new Response("", { status: 302, headers: { location: calls === 1 ? "https://www.asus.com/next" : "https://127.0.0.1/blocked" } });
    }) as typeof fetch;
    await expect(fetchOfficial("https://www.asus.com/start", { timeoutMs: 200, lookup: publicDnsLookup, fetchImpl: redirectingFetch })).rejects.toThrow(/private|local/);
    const oversizedFetch = (async () => new Response("x".repeat(120), { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    await expect(fetchOfficial("https://www.asus.com/large", { maxBytes: 32, lookup: publicDnsLookup, fetchImpl: oversizedFetch })).rejects.toThrow(/size limit/);
  });
});

describe("G3 catalog search job", () => {
  it("is idempotent and keeps official extraction separate from price candidates", async () => {
    const catalog: SkuCatalog = {
      schemaVersion: "2.0.0",
      updatedAt: "2026-08-23",
      skus: [{
        id: "board.example",
        category: "motherboard",
        brand: "ExampleBrand",
        model: "Pro WS X1",
        name: "ExampleBrand Pro WS X1",
        mpn: "EX-BOARD-X1",
        dims: { evidence: "official" },
        power: { evidence: "official" },
        price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
        appearance: { page: "https://www.asus.com/example" },
      }],
    };
    const options = { catalog, inspect: true, fetcher: async () => fetchResult };
    const first = await queueSearch({ query: "EX-BOARD-X1", category: "motherboard", officialOnly: true }, options);
    const second = await queueSearch({ query: "EX-BOARD-X1", category: "motherboard", officialOnly: true }, options);
    expect(second.jobId).toBe(first.jobId);
    const completed = await waitForJob(first.jobId);
    expect(completed?.status).toBe("partial");
    expect(completed?.candidates[0]?.match.kind).toBe("exact-mpn");
    expect(completed?.candidates[0]?.identity.verdict).toBe("exact");
    expect(completed?.candidates[0]?.official.pageKind).toBe("product");
    expect(completed?.summary).toMatchObject({ exact: 1, productPages: 1 });
    expect(completed?.candidates[0]?.canonicalUrl).toBe("https://www.asus.com/example");
    expect(completed?.candidates[0]?.fields?.some((field: { field: string }) => field.field === "dims.lengthMm")).toBe(true);
    expect(completed?.candidates[0]?.priceCandidates).toBeUndefined();
    expect((await getJob(first.jobId))?.idempotencyKey).toBe(first.idempotencyKey);
    const retried = await queueSearch({ query: "EX-BOARD-X1", category: "motherboard", officialOnly: true, requestId: "transaction-review-retry-0001", trigger: "user-confirmed-review" }, options);
    expect(retried.jobId).not.toBe(first.jobId);
    expect(retried.requestContext).toEqual({ source: "transaction-import", trigger: "user-confirmed-review", requestId: "transaction-review-retry-0001" });
    await waitForJob(retried.jobId);
  });

  it("preserves manual-review request identity across the transaction HTTP boundary", async () => {
    const firstBody = transactionCatalogSearchRequest({
      query: "MSI RTX 3070 Ventus 2X OC 8GB GDDR6",
      model: "RTX 3070 Ventus 2X OC",
      mpn: "912-V390-001",
      category: "gpu",
      requestId: "transaction-route-review-0001",
      trigger: "user-confirmed-review",
      officialOnly: false,
      limit: 100,
    });
    expect(firstBody).toEqual({
      query: "MSI RTX 3070 Ventus 2X OC 8GB GDDR6",
      model: "RTX 3070 Ventus 2X OC",
      mpn: "912-V390-001",
      category: "gpu",
      requestId: "transaction-route-review-0001",
      trigger: "user-confirmed-review",
      officialOnly: true,
      limit: 8,
    });
    const provider = { id: `transaction-route-${Date.now()}`, discover: async () => [] };
    const first = await queueSearch(firstBody, { discoveryProviders: [provider], inspect: false });
    const second = await queueSearch(transactionCatalogSearchRequest({ ...firstBody, requestId: "transaction-route-review-0002" }), { discoveryProviders: [provider], inspect: false });
    expect(first.jobId).not.toBe(second.jobId);
    expect(first.requestContext).toEqual({ source: "transaction-import", trigger: "user-confirmed-review", requestId: "transaction-route-review-0001" });
    expect(second.requestContext).toEqual({ source: "transaction-import", trigger: "user-confirmed-review", requestId: "transaction-route-review-0002" });
    await Promise.all([waitForJob(first.jobId), waitForJob(second.jobId)]);
  });

  it("keeps a matching MSI GPU specification page eligible when memory includes its technology", async () => {
    const url = "https://www.msi.com/Graphics-Card/GeForce-RTX-3070-VENTUS-2X-OC/Specification";
    const body = `<meta property="og:title" content="GeForce RTX 3070 VENTUS 2X OC">
      <div class="tr"><div class="td"><ul><li class="specName">Model Name</li></ul>GeForce RTX 3070 VENTUS 2X OC</div></div>
      <div class="tr"><div class="td"><ul><li class="specName">Memory</li></ul>8GB GDDR6</div></div>
      <div class="tr"><div class="td"><ul><li class="specName">Power consumption</li></ul>220W</div></div>
      <div class="tr"><div class="td"><ul><li class="specName">Card Dimension (mm)</li></ul>232 x 124 x 52 mm</div></div>`;
    const officialResult = {
      ...fetchResult,
      requestedUrl: url,
      finalUrl: url,
      body,
      contentHash: crypto.createHash("sha256").update(body).digest("hex"),
    };
    const queued = await queueSearch({
      query: "MSI RTX 3070 Ventus 2X OC 8GB GDDR6",
      category: "gpu",
      requestId: "transaction-msi-capacity-regression",
      trigger: "user-confirmed-review",
    }, {
      discoveryProviders: [new MsiProductDiscoveryProvider()],
      fetcher: async (requestedUrl: string) => {
        expect(requestedUrl).toBe(url);
        return officialResult;
      },
      inspect: true,
    });
    const completed = await waitForJob(queued.jobId);
    expect(completed?.summary).toMatchObject({ discovered: 1, fetchSucceeded: 1, productPages: 1, exact: 1, conflicts: 0 });
    expect(completed?.candidates[0]).toMatchObject({
      canonicalUrl: url,
      official: { trustStatus: "trusted", pageKind: "spec" },
      identity: { verdict: "exact" },
      extraction: { status: "ok" },
    });
    expect(completed?.candidates[0]?.identity.candidateFingerprint.capacity).toBe("8GB");
    const candidate = completed?.candidates[0];
    if (!candidate) throw new Error("MSI fixture candidate missing");
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-msi-thickness-"));
    const catalogPath = path.join(root, "catalog.json");
    try {
      await writeFile(catalogPath, JSON.stringify({ schemaVersion: "2.0.0", catalogVersion: "2.0.0", updatedAt: "2026-08-26", skus: [] }), "utf8");
      const draft = await runAutoEnrichment(candidate.candidateId, {
        expectedHash: catalogCandidateInputHash(candidate),
        autoEnrichTrustedOfficial: true,
        catalogWriteEnabled: true,
        catalogPath,
        draftRoot: path.join(root, "drafts"),
        auditRoot: path.join(root, "audit"),
        rollbackRoot: path.join(root, "rollback"),
        rollbackManifestPath: path.join(root, "rollback/catalog-manifest.json"),
      });
      expect(draft).toMatchObject({ status: "draft", missing: [], proposed: { dims: { lengthMm: 232, thicknessMm: 52, slots: 3 }, power: { tgpW: 220 } } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists candidates as checksummed private runtime records", async () => {
    const persistRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-g3-"));
    try {
      const query = `EX-PERSIST-${Date.now()}`;
      const job = await queueSearch({ query, officialOnly: true }, { persistRoot, inspect: false });
      await waitForJob(job.jobId);
      const repository = new CatalogSearchJobRepository({ persistRoot });
      await repository.initialize("test");
      const state = await repository.coordinator.readState();
      const recordPath = path.join(repository.coordinator.activeRoot(state), "jobs", "catalog-search", "records", `${job.jobId}.json`);
      const saved = JSON.parse(await readFile(recordPath, "utf8"));
      expect(saved).toMatchObject({ schemaVersion: "catalog-search-store-envelope-v1", kind: "catalog-search-job" });
      expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(persistRoot, { recursive: true, force: true });
    }
  });
});

describe("G4 official adapters and audited writes", () => {
  it("selects vendor adapters and keeps HTML/PDF fixtures vendor-labelled", async () => {
    expect(OFFICIAL_ADAPTERS.map((adapter) => adapter.id)).toEqual(["msi-gpu-spec-v1", "asus-product-v1", "seagate-product-v1", "corsair-product-v1"]);
    for (const [brand, filename, url] of [
      ["ASUS", "asus-product.html", "https://www.asus.com/example/g4"],
      ["Seagate", "seagate-product.html", "https://www.seagate.com/example/g4"],
      ["Corsair", "corsair-product.html", "https://www.corsair.com/example/g4"],
    ] as const) {
      const adapter = adapterForUrl(url);
      expect(adapter?.brand).toBe(brand);
      const body = await readFile(new URL(`./fixtures/catalog/${filename}`, import.meta.url), "utf8");
      const extracted = adapter?.extract({ ...fetchResult, finalUrl: url, body, contentHash: crypto.createHash("sha256").update(body).digest("hex") });
      expect(extracted?.adapter).toContain(brand.toLocaleLowerCase().replace(/^./, (char) => char));
      expect(extracted?.fields.some((field) => field.sourceKind === "official-page")).toBe(true);
      const pdfBody = await readFile(new URL(`./fixtures/catalog/${filename.replace(".html", ".pdf")}`, import.meta.url), "utf8");
      const pdfExtracted = adapter?.extract({ ...fetchResult, finalUrl: url, contentType: "application/pdf", body: pdfBody, contentHash: crypto.createHash("sha256").update(pdfBody).digest("hex") });
      expect(pdfExtracted?.fields.every((field) => field.sourceKind === "official-pdf")).toBe(true);
    }
  });

  it("extracts explicit MSI GPU dimensions, power, memory and connector rows", () => {
    const body = `<meta property="og:title" content="GeForce RTX 3070 VENTUS 2X OC">
      <div class="tr"><div class="td"><ul><li class="specName">Model Name</li></ul>GeForce RTX 3070 VENTUS 2X OC</div></div>
      <div class="tr"><div class="td"><ul><li class="specName">Memory</li></ul>8GB GDDR6</div></div>
      <div class="tr"><div class="td"><ul><li class="specName">Power consumption</li></ul>220W</div></div>
      <div class="tr"><div class="td"><ul><li class="specName">Power connectors</li></ul>8-pin x 2</div></div>
      <div class="tr"><div class="td"><ul><li class="specName">Card Dimension (mm)</li></ul>232 x 124 x 52 mm</div></div>`;
    const url = "https://www.msi.com/Graphics-Card/GeForce-RTX-3070-VENTUS-2X-OC/Specification";
    const extracted = adapterForUrl(url)?.extract({ ...fetchResult, finalUrl: url, body, contentHash: crypto.createHash("sha256").update(body).digest("hex") });
    expect(extracted?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "brand", value: "MSI" }),
      expect.objectContaining({ field: "attrs.capacity", value: "8GB GDDR6" }),
      expect.objectContaining({ field: "power.tgpW", value: 220 }),
      expect.objectContaining({ field: "dims.lengthMm", value: 232 }),
      expect.objectContaining({ field: "dims.thicknessMm", value: 52 }),
    ]));
    expect(extracted?.warnings.join(" ")).toContain("dims.slots remains unknown");
  });

  it("requires the write flag and six direct-accept checks before changing catalog", async () => {
    const body = await readFile(new URL("./fixtures/catalog/asus-product.html", import.meta.url), "utf8");
    const result = { ...fetchResult, finalUrl: "https://www.asus.com/example/g4", body, contentHash: crypto.createHash("sha256").update(body).digest("hex") };
    const catalog: SkuCatalog = { schemaVersion: "2.0.0", updatedAt: "2026-08-23", skus: [{ id: "existing.other", category: "motherboard", brand: "Other", model: "Other", name: "Other", mpn: "OTHER-1", dims: { evidence: "unknown" }, power: { evidence: "unknown" }, price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" } }] };
    const job = await queueSearch({ query: "ASUS-G4-001", category: "motherboard", brand: "ASUS", officialOnly: true }, {
      catalog: { ...catalog, skus: [{ ...catalog.skus[0], id: "asus.g4", brand: "ASUS", model: "Pro WS G4", name: "ASUS Pro WS G4", mpn: "ASUS-G4-001", appearance: { page: result.finalUrl } }] },
      fetcher: async () => result,
      inspect: true,
    });
    const completed = await waitForJob(job.jobId);
    const candidate = completed?.candidates[0];
    expect(candidate?.extraction.status).toBe("ok");
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-g4-"));
    const catalogPath = path.join(root, "catalog.json");
    const rollbackRoot = path.join(root, "rollback");
    const rollbackManifestPath = path.join(rollbackRoot, "catalog-manifest.json");
    const auditRoot = path.join(root, "audit");
    try {
      await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`, "utf8");
      const review = { approved: true, expectedHash: catalogCandidateInputHash(candidate) };
      const noApproval = await acceptOfficial(candidate!.candidateId, { catalogPath, rollbackRoot, rollbackManifestPath, auditRoot, catalogWriteEnabled: true, expectedHash: review.expectedHash });
      expect(noApproval).toMatchObject({ status: "blocked", reasons: ["official acceptance requires approved=true"] });
      const disabled = await acceptOfficial(candidate!.candidateId, { ...review, catalogPath, rollbackRoot, rollbackManifestPath, auditRoot, catalogWriteEnabled: false });
      expect(disabled.status).toBe("blocked");
      const accepted = await acceptOfficial(candidate!.candidateId, { ...review, catalogPath, rollbackRoot, rollbackManifestPath, auditRoot, catalogWriteEnabled: true });
      expect(accepted.status).toBe("accepted");
      expect(accepted.catalogHash).toMatch(/^[a-f0-9]{64}$/);
      const saved = JSON.parse(await readFile(catalogPath, "utf8"));
      const sku = saved.skus.find((entry: { mpn?: string }) => entry.mpn === "ASUS-G4-001");
      expect(sku.provenance.length).toBeGreaterThan(0);
      expect(sku.dims.lengthMm).toBe(244);
      const repeated = await acceptOfficial(candidate!.candidateId, { ...review, catalogPath, rollbackRoot, rollbackManifestPath, auditRoot, catalogWriteEnabled: true });
      expect(repeated).toEqual(accepted);
      const rolledBack = await rollbackCatalogAcceptance(catalogPath, { rollbackManifestPath });
      expect(rolledBack.target).toContain("catalog.json");
      const restored = JSON.parse(await readFile(catalogPath, "utf8"));
      expect(restored.skus.some((entry: { mpn?: string }) => entry.mpn === "ASUS-G4-001")).toBe(false);
      const conflictCandidate = { ...candidate, conflicts: [{ field: "mpn", values: ["ASUS-G4-001", "ASUS-G4-002"], reason: "fixture conflict" }] };
      const conflict = await acceptOfficial(candidate!.candidateId, { approved: true, expectedHash: catalogCandidateInputHash(conflictCandidate), candidate: conflictCandidate, catalogPath, rollbackRoot, rollbackManifestPath, auditRoot, catalogWriteEnabled: true });
      expect(conflict.status).toBe("blocked");
      expect(conflict.reasons.join(" ")).toContain("conflict");
      const missingCandidate = { ...candidate, fields: candidate!.fields.filter((field: { field: string }) => field.field !== "dims.widthMm") };
      const missing = await acceptOfficial(candidate!.candidateId, { approved: true, expectedHash: catalogCandidateInputHash(missingCandidate), candidate: missingCandidate, catalogPath, rollbackRoot, rollbackManifestPath, auditRoot, catalogWriteEnabled: true });
      expect(missing.status).toBe("blocked");
      const nonAllowlistedCandidate = { ...candidate, canonicalUrl: "https://evil.example/g4" };
      const nonAllowlisted = await acceptOfficial(candidate!.candidateId, { approved: true, expectedHash: catalogCandidateInputHash(nonAllowlistedCandidate), candidate: nonAllowlistedCandidate, catalogPath, rollbackRoot, rollbackManifestPath, auditRoot, catalogWriteEnabled: true });
      expect(nonAllowlisted.status).toBe("blocked");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let partial/conflicting search candidates enter the governed draft path", async () => {
    const conflictHtml = await readFile(new URL("./fixtures/catalog/conflict-product.html", import.meta.url), "utf8");
    const conflictResult = { ...fetchResult, finalUrl: "https://www.asus.com/conflict", body: conflictHtml, contentHash: "g4-conflict" };
    const job = await queueSearch({ query: "EX-CONFLICT-1", category: "motherboard", brand: "ASUS", officialOnly: true }, {
      catalog: { schemaVersion: "2.0.0", updatedAt: "2026-08-23", skus: [{ id: "conflict.example", category: "motherboard", brand: "ASUS", model: "Conflict", name: "Conflict", mpn: "EX-CONFLICT-1", dims: { evidence: "manual" }, power: { evidence: "manual" }, price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" }, appearance: { page: conflictResult.finalUrl } }] },
      fetcher: async () => conflictResult,
      inspect: true,
    });
    const completed = await waitForJob(job.jobId);
    const candidate = completed?.candidates[0];
    expect(candidate?.extraction.status).toBe("partial");
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-g4-draft-"));
    try {
      const expectedHash = catalogCandidateInputHash(candidate);
      const draft = await createDraft(candidate!.candidateId, {}, { expectedHash, draftRoot: root, rollbackRoot: path.join(root, "rollback") });
      expect(draft.status).toBe("blocked");
      expect(draft.reasons.join(" ")).toMatch(/extraction status|conflict/i);
      const catalogPath = path.join(root, "catalog.json");
      await writeFile(catalogPath, JSON.stringify({ schemaVersion: "2.0.0", updatedAt: "2026-08-23", skus: [] }), "utf8");
      const manualDraft = await createDraft(candidate!.candidateId, { brand: "ASUS", model: "Manual Board", mpn: "MANUAL-001", "dims.lengthMm": 244, "dims.widthMm": 244 }, { expectedHash, draftRoot: root, rollbackRoot: path.join(root, "rollback"), catalogPath });
      expect(manualDraft.status).toBe("blocked");
      expect(JSON.parse(await readFile(catalogPath, "utf8")).skus).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
