import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { detectAccessBarrier } from "../scripts/price-server/catalog/access-barrier.mjs";
import { extractOfficialHtml, extractOfficialPdf } from "../scripts/price-server/catalog/extract.mjs";
import { extractPdfContent } from "../scripts/price-server/catalog/fetch.mjs";
import { inspectUrl } from "../scripts/price-server/catalog/service.mjs";
import { acceptOfficial } from "../scripts/price-server/catalog/write.mjs";

const fetchResult = {
  requestedUrl: "https://www.asus.com/example",
  finalUrl: "https://www.asus.com/example",
  status: 200,
  contentType: "text/html",
  retrievedAt: "2026-08-24T00:00:00.000Z",
  body: "",
  contentHash: "a".repeat(64),
  redirects: [],
};

describe("official access barriers", () => {
  it.each([
    ["captcha", '<title>Verify you are human</title><div class="hcaptcha"></div>'],
    ["login-wall", '<form><input type="password">Please log in to continue</form>'],
    ["paywall", '<section class="paywall">Subscribe to continue</section>'],
  ])("detects %s without attempting a bypass", (kind, body) => {
    const barrier = detectAccessBarrier({ ...fetchResult, body });
    expect(barrier?.kind).toBe(kind);
    expect(barrier?.manualAction).toMatch(/manual|browser|does not bypass/i);
    const extracted = extractOfficialHtml({ ...fetchResult, body });
    expect(extracted.accessBarrier?.kind).toBe(kind);
    expect(extracted.warnings.join(" ")).toContain("access barrier detected");
  });

  it("maps HTTP access controls even when no HTML body is available", () => {
    expect(detectAccessBarrier({ ...fetchResult, status: 429, contentType: "" })?.kind).toBe("rate-limit");
    expect(detectAccessBarrier({ ...fetchResult, status: 403, contentType: "" })?.kind).toBe("access-denied");
  });

  it("keeps an otherwise parseable CAPTCHA response partial in the inspection pipeline", async () => {
    const body = '<title>Verify you are human</title><div class="hcaptcha"></div><script type="application/ld+json">{"@type":"Product","brand":"ASUS","model":"Barrier Board","mpn":"BARRIER-1"}</script>';
    const candidate = await inspectUrl({ url: fetchResult.finalUrl, query: "BARRIER-1", brand: "ASUS", category: "accessory" }, {
      fetcher: async () => ({ ...fetchResult, body }),
    });
    expect(candidate.extraction.status).toBe("partial");
    expect(candidate.accessBarrier?.kind).toBe("captcha");
    expect(candidate.extraction.error).toContain("do not automate or bypass");
  });
});

describe("bounded scanned-PDF OCR", () => {
  it("uses local OCR only when the text layer is sparse and labels provenance as review-required OCR", async () => {
    const destroy = vi.fn(async () => undefined);
    class PDFParse {
      async getText() { return { text: "" }; }
      async getScreenshot() { return { pages: [{ data: new Uint8Array([1, 2, 3]), pageNumber: 1, width: 1_200, height: 1_600 }] }; }
      destroy = destroy;
    }
    const terminate = vi.fn(async () => undefined);
    const recognize = vi.fn(async () => ({ data: { text: "MPN: OCR-1\nLength: 244 mm", confidence: 91 } }));
    const createWorker = vi.fn(async () => ({ recognize, terminate }));
    const result = await extractPdfContent(Buffer.from("fixture"), {
      ocrEnabled: true,
      minTextChars: 80,
      pdfModule: { PDFParse },
      ocrOptions: {
        pdfModule: { PDFParse },
        tesseractModule: { createWorker },
        languageData: { code: "eng", langPath: "/fixture", gzip: true },
        timeoutMs: 5_000,
      },
    });
    expect(result.extraction).toMatchObject({ mode: "ocr", ocrAttempted: true, pagesProcessed: 1, engine: "tesseract.js-7.0.0-eng" });
    const extracted = extractOfficialPdf({ ...fetchResult, contentType: "application/pdf", body: result.text, pdfExtraction: result.extraction });
    expect(extracted.fields.map((field) => field.field)).toEqual(["mpn", "dims.lengthMm"]);
    expect(extracted.fields.every((field) => field.sourceKind === "official-ocr-pdf")).toBe(true);
    expect(extracted.fields.every((field) => field.confidence === 0.7)).toBe(true);
    expect(extracted.warnings.join(" ")).toContain("requires manual review");
    expect(createWorker).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("does not invoke OCR for a usable text layer", async () => {
    class PDFParse {
      async getText() { return { text: "MPN: TEXT-1\n".repeat(20) }; }
      async destroy() {}
    }
    const createWorker = vi.fn();
    const result = await extractPdfContent(Buffer.from("fixture"), {
      ocrEnabled: true,
      pdfModule: { PDFParse },
      ocrOptions: { pdfModule: { PDFParse }, tesseractModule: { createWorker } },
    });
    expect(result.extraction).toEqual({ mode: "text", ocrAttempted: false });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("extracts only explicitly labelled W-D-H dimensions from OCR text", () => {
    const extracted = extractOfficialPdf({
      ...fetchResult,
      contentType: "application/pdf",
      body: '| Dimension: 305mm(W)*353mm(D)*318mm(H) |\n| PCI Expansion Slot: 4 |',
      pdfExtraction: { mode: "ocr", ocrAttempted: true, pagesProcessed: 1, engine: "fixture" },
    });
    expect(Object.fromEntries(extracted.fields.map((field) => [field.field, field.value]))).toEqual({
      "dims.widthMm": 305,
      "dims.lengthMm": 353,
      "dims.heightMm": 318,
      "dims.slots": 4,
    });
    expect(extracted.fields.every((field) => field.sourceKind === "official-ocr-pdf")).toBe(true);
  });

  it("blocks OCR provenance at the direct-accept gate even if a caller forges status ok", async () => {
    const field = (name: string, value: unknown) => ({
      provenanceId: `ocr-${name}`,
      field: name,
      value,
      evidence: "official",
      sourceUrl: fetchResult.finalUrl,
      sourceKind: "official-ocr-pdf",
      retrievedAt: fetchResult.retrievedAt,
      extractor: "tesseract-js-ocr-v1",
      locator: `OCR ${name}`,
      snippet: `${name}: ${value}`,
      confidence: 0.7,
    });
    const candidate = {
      candidateId: "ocr-direct-accept",
      query: { raw: "OCR-1", brand: "ASUS", model: "OCR Board", mpn: "OCR-1", category: "accessory", locale: "en", tokens: ["ocr-1"] },
      category: "accessory",
      canonicalUrl: fetchResult.finalUrl,
      source: { kind: "official", domain: "asus.com", retrievedAt: fetchResult.retrievedAt, httpStatus: 200, finalUrl: fetchResult.finalUrl },
      match: { score: 1, kind: "exact-mpn", reasons: ["fixture"] },
      extraction: { status: "ok", fieldsFound: 3, fieldsMissing: 0, adapter: "fixture-ocr", contentHash: fetchResult.contentHash },
      fields: [field("brand", "ASUS"), field("model", "OCR Board"), field("mpn", "OCR-1")],
      conflicts: [],
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-ocr-gate-"));
    try {
      const result = await acceptOfficial(candidate.candidateId, {
        candidate,
        catalogWriteEnabled: true,
        catalogPath: path.join(root, "catalog.json"),
        auditRoot: path.join(root, "audit"),
        rollbackRoot: path.join(root, "rollback"),
      });
      expect(result.status).toBe("blocked");
      expect(result.reasons).toContain("OCR-derived fields require manual draft confirmation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
