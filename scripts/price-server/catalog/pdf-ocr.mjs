import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_WIDTH = 1_600;
const DEFAULT_MAX_PIXELS = 4_000_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function timeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("official PDF OCR timed out")), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

export async function ocrPdfBuffer(buffer, options = {}) {
  const maxPages = Math.min(10, Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES));
  const desiredWidth = Math.min(2_400, Math.max(800, options.desiredWidth ?? DEFAULT_WIDTH));
  const maxPixels = Math.min(8_000_000, Math.max(1_000_000, options.maxPixels ?? DEFAULT_MAX_PIXELS));
  const timeoutMs = Math.min(180_000, Math.max(5_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const pdfModule = options.pdfModule ?? await import("pdf-parse");
  const tesseractModule = options.tesseractModule ?? await import("tesseract.js");
  const languageData = options.languageData ?? require("@tesseract.js-data/eng");
  const parser = new pdfModule.PDFParse({ data: new Uint8Array(buffer) });
  let worker;
  try {
    const screenshot = await timeout(parser.getScreenshot({
      first: maxPages,
      desiredWidth,
      imageDataUrl: false,
      imageBuffer: true,
    }), timeoutMs);
    const pages = (screenshot?.pages ?? []).slice(0, maxPages);
    if (!pages.length) throw new Error("official PDF OCR rendered no pages");
    for (const page of pages) {
      if (!page?.data?.byteLength) throw new Error("official PDF OCR rendered an empty page");
      if (Number(page.width) * Number(page.height) > maxPixels) throw new Error("official PDF OCR page exceeds pixel limit");
    }
    worker = await timeout(tesseractModule.createWorker(languageData.code, 1, {
      langPath: languageData.langPath,
      gzip: languageData.gzip,
      cacheMethod: "none",
    }), timeoutMs);
    const texts = [];
    const confidences = [];
    for (const page of pages) {
      const result = await timeout(worker.recognize(Buffer.from(page.data)), timeoutMs);
      const text = String(result?.data?.text ?? "").trim();
      if (text) texts.push(`--- OCR page ${page.pageNumber ?? texts.length + 1} ---\n${text}`);
      if (Number.isFinite(result?.data?.confidence)) confidences.push(result.data.confidence);
    }
    return {
      text: texts.join("\n"),
      pagesProcessed: pages.length,
      engine: "tesseract.js-7.0.0-eng",
      confidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
    };
  } finally {
    await worker?.terminate?.().catch(() => undefined);
    await parser.destroy();
  }
}
