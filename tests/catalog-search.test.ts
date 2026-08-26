import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { normalizeModelQuery } from "../src/catalog-search/normalize";
import { extractOfficialHtml, extractOfficialPdf } from "../scripts/price-server/catalog/extract.mjs";
import { extractPdfText, fetchOfficial } from "../scripts/price-server/catalog/fetch.mjs";
import { validateOfficialUrl, validateRedirect } from "../scripts/price-server/catalog/security.mjs";
import { getJob, queueSearch, waitForJob } from "../scripts/price-server/catalog/service.mjs";
import { OFFICIAL_ADAPTERS, adapterForUrl } from "../scripts/price-server/catalog/adapters.mjs";
import { acceptOfficial, confirmDraft, createDraft, rejectDraft, rollbackCatalogAcceptance } from "../scripts/price-server/catalog/write.mjs";
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
const publicDnsLookup = async () => [{ address: "203.0.113.10", family: 4 }];

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
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input, init) => {
      calls += 1;
      expect(init?.headers).not.toHaveProperty("authorization");
      return new Response("", { status: 302, headers: { location: calls === 1 ? "https://www.asus.com/next" : "https://127.0.0.1/blocked" } });
    }) as typeof fetch;
    await expect(fetchOfficial("https://www.asus.com/start", { timeoutMs: 200, lookup: publicDnsLookup })).rejects.toThrow(/private|local/);
    globalThis.fetch = originalFetch;
    globalThis.fetch = (async () => new Response("x".repeat(120), { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    await expect(fetchOfficial("https://www.asus.com/large", { maxBytes: 32, lookup: publicDnsLookup })).rejects.toThrow(/size limit/);
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
    const first = queueSearch({ query: "EX-BOARD-X1", category: "motherboard", officialOnly: true }, options);
    const second = queueSearch({ query: "EX-BOARD-X1", category: "motherboard", officialOnly: true }, options);
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
    expect(getJob(first.jobId)?.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("persists candidates atomically with an audit manifest", async () => {
    const persistRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-g3-"));
    try {
      const query = `EX-PERSIST-${Date.now()}`;
      const job = queueSearch({ query, officialOnly: true }, { persistRoot, inspect: false });
      await waitForJob(job.jobId);
      const date = new Date().toISOString().slice(0, 10);
      const saved = JSON.parse(await readFile(path.join(persistRoot, "data/catalog-candidates", `${date}.json`), "utf8"));
      const manifest = JSON.parse(await readFile(path.join(persistRoot, "data/audit/rollback/catalog-search-manifest.json"), "utf8"));
      expect(saved.jobs.some((entry: { jobId: string }) => entry.jobId === job.jobId)).toBe(true);
      expect(manifest.entries.some((entry: { operation: string }) => entry.operation === "catalog-search-candidates")).toBe(true);
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
    const job = queueSearch({ query: "ASUS-G4-001", category: "motherboard", brand: "ASUS", officialOnly: true }, {
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
      const disabled = await acceptOfficial(candidate!.candidateId, { catalogPath, rollbackRoot, rollbackManifestPath, auditRoot, catalogWriteEnabled: false });
      expect(disabled.status).toBe("blocked");
      const accepted = await acceptOfficial(candidate!.candidateId, { catalogPath, rollbackRoot, rollbackManifestPath, auditRoot, catalogWriteEnabled: true });
      expect(accepted.status).toBe("accepted");
      expect(accepted.catalogHash).toMatch(/^[a-f0-9]{64}$/);
      const saved = JSON.parse(await readFile(catalogPath, "utf8"));
      const sku = saved.skus.find((entry: { mpn?: string }) => entry.mpn === "ASUS-G4-001");
      expect(sku.provenance.length).toBeGreaterThan(0);
      expect(sku.dims.lengthMm).toBe(244);
      const repeated = await acceptOfficial(candidate!.candidateId, { catalogPath, rollbackRoot, rollbackManifestPath, auditRoot, catalogWriteEnabled: true });
      expect(repeated).toEqual(accepted);
      const rolledBack = await rollbackCatalogAcceptance(catalogPath, { rollbackManifestPath });
      expect(rolledBack.target).toContain("catalog.json");
      const restored = JSON.parse(await readFile(catalogPath, "utf8"));
      expect(restored.skus.some((entry: { mpn?: string }) => entry.mpn === "ASUS-G4-001")).toBe(false);
      const conflict = await acceptOfficial(candidate!.candidateId, { candidate: { ...candidate, conflicts: [{ field: "mpn", values: ["ASUS-G4-001", "ASUS-G4-002"], reason: "fixture conflict" }] }, catalogPath, rollbackRoot, rollbackManifestPath, auditRoot, catalogWriteEnabled: true });
      expect(conflict.status).toBe("blocked");
      expect(conflict.reasons.join(" ")).toContain("conflict");
      const missing = await acceptOfficial(candidate!.candidateId, { candidate: { ...candidate, fields: candidate!.fields.filter((field: { field: string }) => field.field !== "dims.widthMm") }, catalogPath, rollbackRoot, rollbackManifestPath, auditRoot, catalogWriteEnabled: true });
      expect(missing.status).toBe("blocked");
      const nonAllowlisted = await acceptOfficial(candidate!.candidateId, { candidate: { ...candidate, canonicalUrl: "https://evil.example/g4" }, catalogPath, rollbackRoot, rollbackManifestPath, auditRoot, catalogWriteEnabled: true });
      expect(nonAllowlisted.status).toBe("blocked");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps non-direct candidates in drafts and rejection does not touch catalog", async () => {
    const conflictHtml = await readFile(new URL("./fixtures/catalog/conflict-product.html", import.meta.url), "utf8");
    const conflictResult = { ...fetchResult, finalUrl: "https://www.asus.com/conflict", body: conflictHtml, contentHash: "g4-conflict" };
    const job = queueSearch({ query: "EX-CONFLICT-1", category: "motherboard", brand: "ASUS", officialOnly: true }, {
      catalog: { schemaVersion: "2.0.0", updatedAt: "2026-08-23", skus: [{ id: "conflict.example", category: "motherboard", brand: "ASUS", model: "Conflict", name: "Conflict", mpn: "EX-CONFLICT-1", dims: { evidence: "manual" }, power: { evidence: "manual" }, price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" }, appearance: { page: conflictResult.finalUrl } }] },
      fetcher: async () => conflictResult,
      inspect: true,
    });
    const completed = await waitForJob(job.jobId);
    const candidate = completed?.candidates[0];
    expect(candidate?.extraction.status).toBe("partial");
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-g4-draft-"));
    try {
      const draft = await createDraft(candidate!.candidateId, {}, { draftRoot: root, rollbackRoot: path.join(root, "rollback") });
      expect(draft.status).toBe("draft");
      expect(draft.conflicts.length).toBe(1);
      const rejected = await rejectDraft(draft.draftId, { draftRoot: root, rollbackRoot: path.join(root, "rollback") });
      expect(rejected.status).toBe("rejected");
      expect((await readFile(path.join(root, `${new Date().toISOString().slice(0, 10)}.json`), "utf8"))).toContain(draft.draftId);
      const catalogPath = path.join(root, "catalog.json");
      await writeFile(catalogPath, JSON.stringify({ schemaVersion: "2.0.0", updatedAt: "2026-08-23", skus: [] }), "utf8");
      const manualDraft = await createDraft(candidate!.candidateId, { brand: "ASUS", model: "Manual Board", mpn: "MANUAL-001", "dims.lengthMm": 244, "dims.widthMm": 244 }, { draftRoot: root, rollbackRoot: path.join(root, "rollback"), catalogPath });
      expect(manualDraft.conflicts).toHaveLength(0);
      const confirmed = await confirmDraft(manualDraft.draftId, { draftRoot: root, rollbackRoot: path.join(root, "rollback"), auditRoot: path.join(root, "audit"), catalogPath, catalogWriteEnabled: true });
      expect(confirmed.status).toBe("confirmed");
      expect(JSON.parse(await readFile(catalogPath, "utf8")).skus.some((entry: { mpn?: string }) => entry.mpn === "MANUAL-001")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
