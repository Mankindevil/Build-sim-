import { createRequire } from "node:module";
import { loadImage } from "@napi-rs/canvas";
import { PDFParse } from "pdf-parse";
import Tesseract from "tesseract.js";

const requireFromHere = createRequire(import.meta.url);
const CODES = new Set([
  "attachment_empty", "attachment_too_large", "mime_magic_mismatch", "malformed_attachment",
  "pixel_limit_exceeded", "page_limit_exceeded", "decompression_limit_exceeded", "processing_timeout",
  "decoder_required", "decoder_mismatch", "extracted_text_too_large",
]);

export class ProductionAttachmentAdapterError extends Error {
  constructor(code, message) {
    super(String(message).slice(0, 500));
    this.name = "ProductionAttachmentAdapterError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionAttachmentAdapterError(code, message);
}

function throwIfAborted(signal) {
  if (signal.aborted) fail("processing_timeout", "attachment inspection was cancelled");
}

function assertInput(bytes, mediaType, signal, limits) {
  throwIfAborted(signal);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail("attachment_empty", "attachment body is empty");
  if (bytes.length > limits.maxBytes) fail("attachment_too_large", "attachment body exceeds the bounded byte limit");
  const magicMatches = mediaType === "image/png"
    ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mediaType === "image/jpeg"
      ? bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8
      : mediaType === "application/pdf"
        ? bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-"
        : false;
  if (!magicMatches) fail("mime_magic_mismatch", "attachment media type does not match its encoded bytes");
}

function checkedDecodedBytes(width, height, compressedBytes, limits) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    fail("malformed_attachment", "decoded attachment dimensions are invalid");
  }
  if (width > limits.maxWidthPixels || height > limits.maxHeightPixels || width * height > limits.maxPixels) {
    fail("pixel_limit_exceeded", "decoded attachment exceeds the bounded pixel dimensions");
  }
  const decodedBytes = width * height * 4;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes <= 0 || decodedBytes > limits.maxDecodedBytes) {
    fail("decompression_limit_exceeded", "decoded attachment exceeds the bounded output limit");
  }
  if (decodedBytes / Math.max(1, compressedBytes) > limits.maxDecompressionRatio) {
    fail("decompression_limit_exceeded", "decoded attachment exceeds the bounded decompression ratio");
  }
  return decodedBytes;
}

function boundedText(parts, limits) {
  const text = parts.filter((part) => part.length > 0).join("\n");
  if (Buffer.byteLength(text, "utf8") > limits.maxExtractedTextBytes) {
    fail("extracted_text_too_large", "attachment extraction exceeded its bounded text output");
  }
  return text;
}

function adapterFailure(error, signal, message) {
  if (error instanceof ProductionAttachmentAdapterError || (error && CODES.has(error.code))) throw error;
  if (signal.aborted) fail("processing_timeout", "attachment inspection was cancelled");
  fail("malformed_attachment", message);
}

async function inspectEncodedImage(bytes, signal, limits) {
  throwIfAborted(signal);
  try {
    const image = await loadImage(bytes);
    throwIfAborted(signal);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    return { width, height, decodedBytes: checkedDecodedBytes(width, height, bytes.length, limits) };
  } catch (error) {
    return adapterFailure(error, signal, "attachment image decoder rejected the encoded pixel stream");
  }
}

export async function decodeJpegProduction(input) {
  assertInput(input.bytes, input.mediaType, input.signal, input.limits);
  if (input.mediaType !== "image/jpeg") fail("decoder_mismatch", "JPEG decoder received an unsupported media type");
  return inspectEncodedImage(input.bytes, input.signal, input.limits);
}

function createPdfParser(bytes, limits) {
  return new PDFParse({
    data: new Uint8Array(bytes),
    stopAtErrors: true,
    maxImageSize: limits.maxPixels,
    canvasMaxAreaInBytes: limits.maxDecodedBytes,
    isEvalSupported: false,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
  });
}

async function destroyPdfParser(parser) {
  await parser.destroy().catch(() => undefined);
}

async function pdfPageCount(parser, signal, limits) {
  throwIfAborted(signal);
  const summary = await parser.getInfo();
  throwIfAborted(signal);
  if (!Number.isInteger(summary.total) || summary.total <= 0) fail("malformed_attachment", "PDF page tree is invalid");
  if (summary.total > limits.maxPages) fail("page_limit_exceeded", "PDF page count exceeds the bounded limit");
  return summary.total;
}

export async function inspectPdfProduction(input) {
  assertInput(input.bytes, input.mediaType, input.signal, input.limits);
  if (input.mediaType !== "application/pdf") fail("decoder_mismatch", "PDF inspector received an unsupported media type");
  const parser = createPdfParser(input.bytes, input.limits);
  const abort = () => { void destroyPdfParser(parser); };
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    const pageCount = await pdfPageCount(parser, input.signal, input.limits);
    const pageInfo = await parser.getInfo({ parsePageInfo: true });
    throwIfAborted(input.signal);
    if (pageInfo.pages.length !== pageCount) fail("malformed_attachment", "PDF page metadata is incomplete");
    if (!input.extractText) return { pageCount, decodedBytes: input.bytes.length };

    const parts = [];
    let extractedBytes = 0;
    for (let page = 1; page <= pageCount; page += 1) {
      throwIfAborted(input.signal);
      const result = await parser.getText({ partial: [page], pageJoiner: "" });
      throwIfAborted(input.signal);
      const pageText = result.pages[0]?.text ?? "";
      extractedBytes += (parts.length > 0 && pageText.length > 0 ? 1 : 0) + Buffer.byteLength(pageText, "utf8");
      if (extractedBytes > input.limits.maxExtractedTextBytes || extractedBytes > input.limits.maxDecodedBytes) {
        fail("extracted_text_too_large", "PDF text extraction exceeded its bounded output");
      }
      if (pageText.length > 0) parts.push(pageText);
    }
    const text = boundedText(parts, input.limits);
    const decodedBytes = Math.max(input.bytes.length, Buffer.byteLength(text, "utf8"));
    if (decodedBytes > input.limits.maxDecodedBytes
      || decodedBytes / Math.max(1, input.bytes.length) > input.limits.maxDecompressionRatio) {
      fail("decompression_limit_exceeded", "PDF decoding exceeded the bounded output limit");
    }
    return text.trim().length > 0 ? { pageCount, decodedBytes, text } : { pageCount, decodedBytes };
  } catch (error) {
    return adapterFailure(error, input.signal, "PDF parser rejected the attachment structure or page content");
  } finally {
    input.signal.removeEventListener("abort", abort);
    await destroyPdfParser(parser);
  }
}

function localEnglishLanguageData() {
  const value = requireFromHere("@tesseract.js-data/eng");
  if (value?.code !== "eng" || value.gzip !== true || typeof value.langPath !== "string" || value.langPath.length === 0) {
    fail("decoder_required", "bundled English OCR language data is unavailable");
  }
  return value;
}

async function createLocalOcrWorker(signal) {
  throwIfAborted(signal);
  const language = localEnglishLanguageData();
  const workerPath = requireFromHere.resolve("tesseract.js/src/worker-script/node/index.js");
  const worker = await Tesseract.createWorker(language.code, Tesseract.OEM.LSTM_ONLY, {
    langPath: language.langPath,
    gzip: language.gzip,
    workerPath,
    cacheMethod: "none",
    logger: () => undefined,
    errorHandler: () => undefined,
  });
  if (signal.aborted) {
    await worker.terminate().catch(() => undefined);
    throwIfAborted(signal);
  }
  return worker;
}

async function recognize(worker, bytes, signal) {
  throwIfAborted(signal);
  const result = await worker.recognize(bytes, {}, {
    text: true, blocks: false, layoutBlocks: false, hocr: false, tsv: false, box: false, unlv: false,
    osd: false, pdf: false, imageColor: false, imageGrey: false, imageBinary: false, debug: false,
  });
  throwIfAborted(signal);
  const confidence = Number.isFinite(result.data.confidence)
    ? Math.min(1, Math.max(0, result.data.confidence / 100))
    : 0;
  return { text: result.data.text.trim(), confidence };
}

function pdfRenderScale(width, height, pageCount, limits) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    fail("malformed_attachment", "PDF page dimensions are invalid");
  }
  const perPageDecodedBudget = Math.floor(limits.maxDecodedBytes / pageCount);
  const perPagePixelBudget = Math.min(limits.maxPixels, Math.floor(perPageDecodedBudget / 4));
  if (perPagePixelBudget <= 0) fail("decompression_limit_exceeded", "PDF raster budget is exhausted");
  const scale = Math.min(
    2,
    limits.maxWidthPixels / width,
    limits.maxHeightPixels / height,
    Math.sqrt(perPagePixelBudget / (width * height)),
  );
  if (!Number.isFinite(scale) || scale <= 0) {
    fail("decompression_limit_exceeded", "PDF page cannot be rasterized within the bounded output limit");
  }
  return scale;
}

async function ocrPdf(bytes, signal, limits) {
  const parser = createPdfParser(bytes, limits);
  let worker;
  const abort = () => {
    void destroyPdfParser(parser);
    if (worker) void worker.terminate().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const pageCount = await pdfPageCount(parser, signal, limits);
    const info = await parser.getInfo({ parsePageInfo: true });
    throwIfAborted(signal);
    if (info.pages.length !== pageCount) fail("malformed_attachment", "PDF page metadata is incomplete");
    worker = await createLocalOcrWorker(signal);
    const parts = [];
    const confidences = [];
    const pages = [];
    let totalRasterBytes = 0;
    for (let page = 1; page <= pageCount; page += 1) {
      throwIfAborted(signal);
      const pageInfo = info.pages[page - 1];
      const scale = pdfRenderScale(pageInfo.width, pageInfo.height, pageCount, limits);
      const rendered = await parser.getScreenshot({ partial: [page], scale, imageBuffer: true, imageDataUrl: false });
      throwIfAborted(signal);
      const screenshot = rendered.pages[0];
      if (!screenshot || screenshot.data.byteLength === 0) fail("malformed_attachment", "PDF page rasterization did not produce pixels");
      const rasterBytes = checkedDecodedBytes(
        Math.ceil(screenshot.width),
        Math.ceil(screenshot.height),
        Math.max(1, screenshot.data.byteLength),
        { ...limits, maxDecompressionRatio: Math.max(limits.maxDecompressionRatio, 4) },
      );
      totalRasterBytes += rasterBytes;
      if (totalRasterBytes > limits.maxDecodedBytes) {
        fail("decompression_limit_exceeded", "PDF rasterization exceeded the bounded decoded-byte budget");
      }
      const pageResult = await recognize(worker, Buffer.from(screenshot.data), signal);
      boundedText([...parts, pageResult.text], limits);
      if (pageResult.text.length > 0) parts.push(pageResult.text);
      confidences.push(pageResult.confidence);
      pages.push({ num: page, text: pageResult.text, confidence: pageResult.confidence });
    }
    return {
      text: boundedText(parts, limits),
      pages,
      ...(confidences.length > 0 ? { confidence: confidences.reduce((sum, value) => sum + value, 0) / confidences.length } : {}),
    };
  } catch (error) {
    return adapterFailure(error, signal, "PDF OCR failed to decode a bounded page raster");
  } finally {
    signal.removeEventListener("abort", abort);
    if (worker) await worker.terminate().catch(() => undefined);
    await destroyPdfParser(parser);
  }
}

export async function extractOcrProduction(input) {
  assertInput(input.bytes, input.mediaType, input.signal, input.limits);
  if (input.mediaType === "application/pdf") return ocrPdf(input.bytes, input.signal, input.limits);
  if (input.mediaType !== "image/png" && input.mediaType !== "image/jpeg") {
    fail("decoder_mismatch", "OCR inspector received an unsupported media type");
  }
  let worker;
  const abort = () => { if (worker) void worker.terminate().catch(() => undefined); };
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    await inspectEncodedImage(input.bytes, input.signal, input.limits);
    worker = await createLocalOcrWorker(input.signal);
    const result = await recognize(worker, input.bytes, input.signal);
    return {
      text: boundedText([result.text], input.limits),
      confidence: result.confidence,
      pages: [{ num: 1, text: result.text, confidence: result.confidence }],
    };
  } catch (error) {
    return adapterFailure(error, input.signal, "image OCR failed to decode the bounded attachment");
  } finally {
    input.signal.removeEventListener("abort", abort);
    if (worker) await worker.terminate().catch(() => undefined);
  }
}
