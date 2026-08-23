import { mkdtemp, readFile, rm } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { normalizeModelQuery } from "../src/catalog-search/normalize";
import { extractOfficialHtml, extractOfficialPdf } from "../scripts/price-server/catalog/extract.mjs";
import { fetchOfficial } from "../scripts/price-server/catalog/fetch.mjs";
import { validateOfficialUrl, validateRedirect } from "../scripts/price-server/catalog/security.mjs";
import { getJob, queueSearch, waitForJob } from "../scripts/price-server/catalog/service.mjs";
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
    await expect(fetchOfficial("https://www.asus.com/start", { timeoutMs: 200 })).rejects.toThrow(/private|local/);
    globalThis.fetch = originalFetch;
    globalThis.fetch = (async () => new Response("x".repeat(120), { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    await expect(fetchOfficial("https://www.asus.com/large", { maxBytes: 32 })).rejects.toThrow(/size limit/);
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
