import crypto from "node:crypto";
import { createRequire } from "node:module";
import { requestDeepSeekOcr } from "./deepseek-ocr.mjs";

const require = createRequire(import.meta.url);
const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_MAX_PIXELS = 24_000_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const ACCEPTED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function timeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("transaction screenshot OCR timed out")), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}
function text(value) { return String(value ?? "").normalize("NFKC").replace(/[‐‑‒–—−]/g, "-").replace(/\s+/g, " ").trim(); }
function comparable(value) { return text(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, ""); }
function boundedNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function decodeTransactionImage(dataUrl, options = {}) {
  const match = String(dataUrl ?? "").match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !ACCEPTED_MIME.has(match[1])) throw new Error("仅支持 PNG、JPEG 或 WebP 交易截图");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) throw new Error("交易截图为空");
  if (buffer.byteLength > boundedNumber(options.maxBytes, 100_000, 10_000_000, DEFAULT_MAX_BYTES)) throw new Error("交易截图超过大小限制");
  return { mimeType: match[1], buffer, contentHash: sha256(buffer) };
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  return null;
}
function webpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const kind = buffer.toString("ascii", 12, 16);
  if (kind === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  return null;
}

export function assertTransactionImageDimensions(buffer, mimeType, options = {}) {
  const dimensions = mimeType === "image/png" ? pngDimensions(buffer) : mimeType === "image/jpeg" ? jpegDimensions(buffer) : webpDimensions(buffer);
  if (!dimensions) return null;
  if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > boundedNumber(options.maxPixels, 1_000_000, 40_000_000, DEFAULT_MAX_PIXELS)) {
    throw new Error("交易截图像素尺寸超过限制");
  }
  return dimensions;
}

async function ocrTransactionImageLocally(buffer, options = {}) {
  const timeoutMs = boundedNumber(options.timeoutMs, 5_000, 120_000, DEFAULT_TIMEOUT_MS);
  const tesseractModule = options.tesseractModule ?? await import("tesseract.js");
  const languageData = options.languageData ?? require("@tesseract.js-data/eng");
  let worker;
  try {
    worker = await timeout(tesseractModule.createWorker(languageData.code, 1, {
      langPath: languageData.langPath,
      gzip: languageData.gzip,
      cacheMethod: "none",
    }), timeoutMs);
    const result = await timeout(worker.recognize(buffer), timeoutMs);
    return {
      text: String(result?.data?.text ?? "").trim(),
      confidence: Number.isFinite(result?.data?.confidence) ? Number(result.data.confidence) : null,
      engine: "tesseract.js-7.0.0-eng",
    };
  } finally {
    await worker?.terminate?.().catch(() => undefined);
  }
}

export async function ocrTransactionImage(buffer, options = {}) {
  const provider = options.provider ?? "deepseek-ocr";
  if (provider === "tesseract") return ocrTransactionImageLocally(buffer, options);
  if (provider !== "deepseek-ocr") throw new Error("TRANSACTION_OCR_PROVIDER must be deepseek-ocr or tesseract");
  return requestDeepSeekOcr(buffer, options.mimeType ?? "image/png", options);
}

const CATEGORY_WORDS = [
  ["motherboard", ["motherboard", "mainboard", "主板"]], ["cpu", ["processor", "cpu", "处理器"]],
  ["psu", ["power supply", "psu", "电源"]], ["cooler", ["cooler", "heatsink", "散热"]],
  ["gpu", ["graphics card", "gpu", "显卡"]], ["memory", ["memory", "ram", "内存"]],
  ["storage", ["ssd", "hdd", "hard drive", "硬盘", "固态"]], ["case", ["computer case", "chassis", "机箱"]],
  ["hba", ["hba", "sas card", "阵列卡"]], ["fan", ["case fan", "cooling fan", "风扇"]],
];

function priceFromText(raw) {
  const patterns = [
    /(?:实付|合计|总计|成交价|paid|payment|total|amount)\s*[:：]?\s*(?:cny|rmb|[¥￥$])?\s*([0-9]{1,7}(?:[.,][0-9]{1,2})?)/iu,
    /(?:cny|rmb|[¥￥])\s*([0-9]{1,7}(?:[.,][0-9]{1,2})?)/iu,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match?.[1]) continue;
    const value = Number(match[1].replace(",", ""));
    if (Number.isFinite(value) && value >= 0 && value <= 10_000_000) return value;
  }
  return null;
}

function quantityFromText(raw) {
  const match = raw.match(/(?:数量|qty|quantity)\s*[:：x×]?\s*(\d{1,2})\b/iu) ?? raw.match(/(?:^|\s)[x×]\s*(\d{1,2})(?=\s|$)/iu);
  return match?.[1] ? Math.min(99, Math.max(1, Number(match[1]))) : 1;
}

function matchCatalog(raw, catalog) {
  const haystack = comparable(raw);
  const rows = (catalog?.skus ?? []).flatMap((sku) => {
    const identities = [sku.mpn, sku.model, sku.name].filter(Boolean).map((value) => comparable(value));
    const exact = identities.find((identity) => identity.length >= 2 && haystack.includes(identity));
    if (!exact) return [];
    const kind = sku.mpn && haystack.includes(comparable(sku.mpn)) ? "exact-mpn" : "brand-model";
    return [{ sku, score: kind === "exact-mpn" ? 1 : Math.min(0.98, 0.72 + exact.length / 100), kind }];
  });
  const exactMatch = rows.sort((a, b) => b.score - a.score)[0];
  if (exactMatch) return exactMatch;

  // Transaction titles often omit a product-family prefix or revision, for
  // example "GX-850" instead of "FOCUS GX-850 V5". Treat a sufficiently
  // specific model fragment as a catalog match only when it identifies one SKU
  // unambiguously; generic fragments such as "850" must remain reviewable.
  const fragments = (text(raw).match(/[A-Za-z0-9]+(?:[-_./][A-Za-z0-9]+)+|[A-Za-z]{1,12}\d{2,}[A-Za-z0-9-]*/g) ?? [])
    .map((value) => comparable(value))
    .filter((value) => value.length >= 5 && /[a-z]{2,}/.test(value) && /\d{2,}/.test(value));
  for (const fragment of [...new Set(fragments)].sort((a, b) => b.length - a.length)) {
    const partial = (catalog?.skus ?? []).filter((sku) => [sku.mpn, sku.model]
      .filter(Boolean)
      .some((identity) => comparable(identity).includes(fragment)));
    if (partial.length === 1) return { sku: partial[0], score: 0.82, kind: "brand-model" };
  }
  return null;
}

function detectIdentity(raw, catalog) {
  const normalized = text(raw);
  const lower = normalized.toLocaleLowerCase();
  const brands = [...new Set((catalog?.skus ?? []).map((sku) => sku.brand).filter((brand) => brand && !["Unknown", "Generic", "—"].includes(brand)))].sort((a, b) => b.length - a.length);
  const brand = brands.find((value) => lower.includes(value.toLocaleLowerCase()));
  const tokens = normalized.match(/[A-Za-z0-9]+(?:[-_./][A-Za-z0-9]+)+|[A-Za-z]{1,12}\d{2,}[A-Za-z0-9-]*/g) ?? [];
  const rejected = /^(?:20\d{2}|\d{8,}|order|total|amount)$/i;
  const model = tokens.filter((token) => !rejected.test(token) && /[A-Za-z]/.test(token) && /\d/.test(token)).sort((a, b) => b.length - a.length)[0];
  const explicitCategory = CATEGORY_WORDS.find(([, words]) => words.some((word) => lower.includes(word)))?.[0];
  const modelFragment = comparable(model);
  const catalogCategories = new Set(modelFragment.length >= 5
    ? (catalog?.skus ?? [])
      .filter((sku) => [sku.mpn, sku.model].filter(Boolean).some((identity) => comparable(identity).includes(modelFragment)))
      .map((sku) => sku.category)
    : []);
  // A model fragment that resolves to one governed catalog category is
  // stronger evidence than unrelated marketplace/navigation copy elsewhere in
  // the OCR text. For example a GX-850 receipt can also contain a "主板" promo
  // label; that must not turn the PSU into a motherboard search.
  const category = catalogCategories.size === 1 ? [...catalogCategories][0] : explicitCategory ?? null;
  return { brand: brand ?? null, model: model ?? null, category: category ?? null, query: [brand, model].filter(Boolean).join(" ") };
}

export function analyzeTransactionText(raw, catalog, meta = {}) {
  const normalized = text(raw);
  if (!normalized) throw new Error("没有从截图中识别到可用文字");
  const catalogMatch = matchCatalog(normalized, catalog);
  const identity = catalogMatch
    ? { brand: catalogMatch.sku.brand, model: catalogMatch.sku.model, category: catalogMatch.sku.category, query: catalogMatch.sku.mpn ?? `${catalogMatch.sku.brand} ${catalogMatch.sku.model}` }
    : detectIdentity(normalized, catalog);
  const receiptId = String(meta.receiptId ?? `receipt-${sha256(normalized).slice(0, 20)}`);
  const fileName = String(meta.fileName ?? "transaction-screenshot").slice(0, 160);
  const price = priceFromText(normalized);
  const qty = quantityFromText(normalized);
  const detectedName = catalogMatch?.sku.name ?? ([identity.brand, identity.model].filter(Boolean).join(" ") || "待确认交易部件");
  return {
    schemaVersion: "1.0.0",
    receiptId,
    status: catalogMatch ? "matched-catalog" : identity.model ? "catalog-search-required" : "identity-review-required",
    detected: {
      name: detectedName,
      brand: identity.brand,
      model: identity.model,
      category: identity.category ?? "accessory",
      qty,
      unitPriceCny: price,
    },
    catalogMatch: catalogMatch ? { skuId: catalogMatch.sku.id, kind: catalogMatch.kind, score: catalogMatch.score } : null,
    searchQuery: !catalogMatch && identity.model ? identity.query || identity.model : null,
    evidence: {
      sourceKind: "transaction-screenshot-ocr",
      fileName,
      contentHash: String(meta.contentHash ?? sha256(normalized)),
      capturedAt: String(meta.capturedAt ?? new Date().toISOString()),
      ocrEngine: String(meta.ocrEngine ?? "fixture"),
      ocrConfidence: Number.isFinite(meta.ocrConfidence) ? Number(meta.ocrConfidence) : null,
      excerpt: `识别结果：${detectedName}；数量 ${qty}；成交价 ${price === null ? "unknown" : `CNY ${price}`}`.slice(0, 360),
    },
  };
}

export async function analyzeTransactionScreenshot(body, options = {}) {
  const decoded = decodeTransactionImage(body?.imageDataUrl, options);
  const dimensions = assertTransactionImageDimensions(decoded.buffer, decoded.mimeType, options);
  const ocr = await ocrTransactionImage(decoded.buffer, { ...options, mimeType: decoded.mimeType });
  const result = analyzeTransactionText(ocr.text, options.catalog, {
    receiptId: `receipt-${decoded.contentHash.slice(0, 20)}`,
    contentHash: decoded.contentHash,
    fileName: body?.fileName,
    capturedAt: body?.capturedAt,
    ocrEngine: ocr.engine,
    ocrConfidence: ocr.confidence,
  });
  return {
    ...result,
    ocrText: ocr.text,
    billing: ocr.billing ?? null,
    image: { mimeType: decoded.mimeType, bytes: decoded.buffer.byteLength, dimensions },
  };
}
