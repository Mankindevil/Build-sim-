import { describe, expect, it, vi } from "vitest";
import catalog from "../data/skus/catalog.json";
import {
  analyzeTransactionScreenshot,
  analyzeTransactionText,
  assertTransactionImageDimensions,
  decodeTransactionImage,
} from "../scripts/price-server/transactions/receipt.mjs";
import { selectBestCatalogCandidate } from "../src/lab/transaction-import";

function png(width = 1200, height = 800): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt8(0x89, 0);
  buffer.write("PNG", 1, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe("transaction screenshot receipt agent", () => {
  it("matches an existing exact SKU and keeps only explicit transaction facts", () => {
    const result = analyzeTransactionText("Order 12345678901 Intel Core i5-14500 CPU Qty: 1 Total: ¥1380", catalog, { fileName: "order.png", contentHash: "a".repeat(64) });
    expect(result).toMatchObject({
      status: "matched-catalog",
      detected: { name: "Intel Core i5-14500", qty: 1, unitPriceCny: 1380 },
      catalogMatch: { skuId: "cpu.i5-14500", kind: "exact-mpn", score: 1 },
      evidence: { sourceKind: "transaction-screenshot-ocr", fileName: "order.png" },
    });
    expect(result.evidence.excerpt).not.toContain("12345678901");
  });

  it("infers the category but keeps a cross-generation model fragment unresolved", () => {
    const result = analyzeTransactionText("GX-850 数量 1 实付 ¥400", catalog);
    expect(result).toMatchObject({
      status: "catalog-search-required",
      detected: { name: "GX-850", category: "psu", qty: 1, unitPriceCny: 400 },
      catalogMatch: null,
    });
  });

  it("matches the FX generation only when the revision is present", () => {
    const result = analyzeTransactionText("Seasonic GX-850 FX 数量 1 实付 ¥400", catalog);
    expect(result).toMatchObject({
      status: "matched-catalog",
      detected: { name: "Seasonic FOCUS Plus Gold 850 (SSR-850FX)", category: "psu" },
      catalogMatch: { skuId: "psu.seasonic-focus-plus-gold-850-fx", kind: "brand-model" },
    });
  });

  it("does not guess a SKU from an ambiguous numeric fragment", () => {
    const result = analyzeTransactionText("850 数量 1 实付 ¥400", catalog);
    expect(result.catalogMatch).toBeNull();
    expect(result.status).toBe("identity-review-required");
  });

  it("creates a provisional record and search query for a model absent from the catalog", () => {
    const result = analyzeTransactionText("Seasonic VERTEX-GX-1000 power supply Paid CNY 1299 Qty 1", catalog);
    expect(result.status).toBe("catalog-search-required");
    expect(result.catalogMatch).toBeNull();
    expect(result.detected).toMatchObject({ brand: "Seasonic", model: "VERTEX-GX-1000", category: "psu", unitPriceCny: 1299 });
    expect(result.searchQuery).toContain("VERTEX-GX-1000");
  });

  it("does not invent a price or launch a weak identity search", () => {
    const result = analyzeTransactionText("Thanks for your order. Delivery tomorrow.", catalog);
    expect(result.status).toBe("identity-review-required");
    expect(result.detected.unitPriceCny).toBeNull();
    expect(result.searchQuery).toBeNull();
  });

  it("does not confuse model suffixes with a purchase quantity", () => {
    const result = analyzeTransactionText("Thermalright AXP90-X53 FULL cooler", catalog);
    expect(result.detected.qty).toBe(1);
  });

  it("bounds image type, bytes and pixel dimensions before OCR", () => {
    const encoded = `data:image/png;base64,${png().toString("base64")}`;
    const decoded = decodeTransactionImage(encoded);
    expect(assertTransactionImageDimensions(decoded.buffer, decoded.mimeType)).toEqual({ width: 1200, height: 800 });
    expect(() => decodeTransactionImage("data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==")).toThrow(/PNG、JPEG 或 WebP/);
    expect(() => assertTransactionImageDimensions(png(10_000, 10_000), "image/png")).toThrow(/像素尺寸/);
  });

  it("uses the public DeepSeek vision model by default, prices usage, and never returns the raw screenshot", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: "ocr-fixture",
        model: "deepseek-v4-flash-vision-exp",
        usage: { prompt_tokens: 500, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 400, completion_tokens: 50, total_tokens: 550 },
        choices: [{ message: { content: "Intel i5-14500 CPU Total ¥1380" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const image = png();
    const result = await analyzeTransactionScreenshot({ imageDataUrl: `data:image/png;base64,${image.toString("base64")}`, fileName: "receipt.png" }, {
      catalog,
      apiUrl: "https://api.deepseek.com",
      apiKey: "fixture-key",
      model: "deepseek-v4-flash-vision-exp",
      fetchImpl,
    });
    expect(result).toMatchObject({ status: "matched-catalog", ocrText: "Intel i5-14500 CPU Total ¥1380", image: { mimeType: "image/png", bytes: image.length }, evidence: { ocrEngine: "deepseek-vision:deepseek-v4-flash-vision-exp", ocrConfidence: null }, billing: { status: "priced", pricing: { billedModel: "deepseek-v4-flash-vision-exp" }, cost: { estimated: true } } });
    expect(JSON.stringify(result)).not.toContain("base64");
    expect(JSON.stringify(requestBody)).toContain("data:image/png;base64");
    expect(requestBody).not.toHaveProperty("vllm_xargs");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps self-hosted DeepSeek-OCR as an explicit provider configuration", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ model: "deepseek-ai/DeepSeek-OCR", choices: [{ message: { content: "Intel i5-14500 CPU Total ¥1380" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const image = png();
    const result = await analyzeTransactionScreenshot({ imageDataUrl: `data:image/png;base64,${image.toString("base64")}` }, {
      catalog,
      apiUrl: "http://127.0.0.1:8000/v1",
      model: "deepseek-ai/DeepSeek-OCR",
      fetchImpl,
    });
    expect(result).toMatchObject({ evidence: { ocrEngine: "deepseek-ocr:deepseek-ai/DeepSeek-OCR" }, billing: null });
    expect(requestBody).toHaveProperty("vllm_xargs");
  });

  it("keeps local Tesseract only as an explicit rollback provider", async () => {
    const terminate = vi.fn(async () => undefined);
    const recognize = vi.fn(async () => ({ data: { text: "Intel i5-14500 CPU Total ¥1380", confidence: 92 } }));
    const createWorker = vi.fn(async () => ({ recognize, terminate }));
    const image = png();
    const result = await analyzeTransactionScreenshot({ imageDataUrl: `data:image/png;base64,${image.toString("base64")}`, fileName: "receipt.png" }, {
      catalog,
      provider: "tesseract",
      tesseractModule: { createWorker },
      languageData: { code: "eng", langPath: "/fixture", gzip: true },
    });
    expect(result).toMatchObject({ status: "matched-catalog", image: { mimeType: "image/png", bytes: image.length }, evidence: { ocrConfidence: 92 } });
    expect(JSON.stringify(result)).not.toContain("base64");
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("ranks exact official candidates above weak search pages", () => {
    expect(selectBestCatalogCandidate([
      { candidateId: "weak", match: { kind: "weak", score: 0.3 }, extraction: { status: "not-run", fieldsFound: 0 } },
      { candidateId: "exact", match: { kind: "exact-mpn", score: 1 }, extraction: { status: "ok", fieldsFound: 6 } },
    ])?.candidateId).toBe("exact");
  });

  it("rejects an unrelated extracted page even when it has more fields", () => {
    expect(selectBestCatalogCandidate([
      { candidateId: "seasonic", title: "Seasonic FOCUS GX-850", canonicalUrl: "https://seasonic.com/focus-gx/", match: { kind: "weak", score: 0.2 }, extraction: { status: "failed", fieldsFound: 1 } },
      { candidateId: "case", title: "JONSBO computer case", canonicalUrl: "https://www.jonsbo.com/en/product/ComputerCase.html", match: { kind: "weak", score: 0.2 }, extraction: { status: "partial", fieldsFound: 3 } },
    ], { name: "GX-850", model: "GX-850", brand: "Seasonic" })?.candidateId).toBe("seasonic");
    expect(selectBestCatalogCandidate([
      { candidateId: "case", title: "JONSBO computer case", canonicalUrl: "https://www.jonsbo.com/en/product/ComputerCase.html", match: { kind: "weak", score: 0.2 }, extraction: { status: "partial", fieldsFound: 3 } },
    ], { name: "GX-850", model: "GX-850", brand: "Seasonic" })).toBeNull();
  });

  it("never lets a related candidate override a deterministic variant conflict", () => {
    expect(selectBestCatalogCandidate([
      { candidateId: "wrong-tier", title: "WD Red Pro 8TB", canonicalUrl: "https://www.westerndigital.com/products/internal-drives/wd-red-pro", official: { trustStatus: "trusted", pageKind: "product", reasons: [] }, identity: { verdict: "conflict", score: 0, reasons: ["storageTier conflicts: plus != pro"], unknowns: [], criticalConflicts: [{ field: "storageTier", input: "plus", candidate: "pro" }] }, match: { kind: "weak", score: 0 }, extraction: { status: "ok", fieldsFound: 8 } },
      { candidateId: "same-family", title: "WD Red 8TB", canonicalUrl: "https://www.westerndigital.com/products/internal-drives/wd-red", official: { trustStatus: "trusted", pageKind: "product", reasons: [] }, identity: { verdict: "same-family", score: 0.6, reasons: ["tier unknown"], unknowns: ["storageTier"], criticalConflicts: [] }, match: { kind: "spec-match", score: 0.6 }, extraction: { status: "ok", fieldsFound: 8 } },
    ], { name: "WD Red Plus 8TB", model: "WD Red Plus", brand: "Western Digital" })).toBeNull();
  });
});
