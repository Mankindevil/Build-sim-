import { detectAccessBarrier } from "./access-barrier.mjs";

const FIELD_ALIASES = [
  ["mpn", /^(mpn|sku|part\s*(number|no\.?)|model\s*(number|no\.?))$/i],
  ["brand", /^brand$/i],
  ["model", /^(model|product\s*name)$/i],
  ["dims.lengthMm", /^(length|depth|长度|深度)$/i],
  ["dims.widthMm", /^(width|宽度)$/i],
  ["dims.heightMm", /^(height|高度)$/i],
  ["dims.slots", /^(slot|slots|pci\s+expansion\s+slot|槽位)$/i],
  ["power.tdpW", /^(tdp|tdp\s*power|热设计功耗)$/i],
  ["power.tgpW", /^(tgp|graphics\s*power|显卡功耗)$/i],
  ["power.ratedW", /^(rated\s*(power|output)|continuous\s*power|output\s*capacity|power\s*output|额定功率)$/i],
  ["attrs.capacity", /^(capacity|容量)$/i],
  ["attrs.interface", /^(interface|接口)$/i],
];

function strip(value) { return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim(); }
function esc(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function numberWithUnit(value) {
  const match = String(value).replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)\s*(mm|cm|w|kw|tb|gb|mb|slot|slots|槽)?/i);
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return undefined;
  const unit = (match[2] ?? "").toLocaleLowerCase();
  if (unit === "cm") return number * 10;
  if (unit === "kw") return number * 1000;
  return number;
}
function fieldValue(field, value) {
  if (field === "dims.lengthMm" || field === "dims.widthMm" || field === "dims.heightMm" || field === "dims.slots" || field === "power.tdpW" || field === "power.tgpW" || field === "power.ratedW") return numberWithUnit(value);
  return strip(value);
}
function addField(fields, conflicts, fetch, field, value, locator, snippet, sourceKind = "official-page") {
  if (value === undefined || value === "") return;
  const prior = fields.find((entry) => entry.field === field);
  if (prior && JSON.stringify(prior.value) !== JSON.stringify(value)) {
    const conflict = conflicts.find((entry) => entry.field === field);
    if (conflict) conflict.values.push(value); else conflicts.push({ field, values: [prior.value, value], reason: "同一来源字段值冲突" });
    return;
  }
  if (prior) return;
  fields.push({
    provenanceId: `prov-${fetch.contentHash.slice(0, 12)}-${fields.length + 1}`,
    field,
    value,
    evidence: "official",
    sourceUrl: fetch.finalUrl,
    sourceKind,
    retrievedAt: fetch.retrievedAt,
    extractor: sourceKind === "official-ocr-pdf" ? "tesseract-js-ocr-v1" : sourceKind === "official-pdf" ? "generic-official-pdf-text-v1" : sourceKind === "official-rendered-page" ? "generic-official-rendered-html-v1" : "generic-official-html-v1",
    locator,
    snippet: String(snippet ?? "").slice(0, 240),
    confidence: sourceKind === "official-ocr-pdf" ? 0.7 : 1,
  });
}

function parseJsonLd(html, fetch, fields, conflicts) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const products = Array.isArray(parsed) ? parsed : parsed?.["@graph"] ? parsed["@graph"] : [parsed];
      for (const product of products) {
        if (!product || (product["@type"] && !String(product["@type"]).toLocaleLowerCase().includes("product"))) continue;
        addField(fields, conflicts, fetch, "brand", typeof product.brand === "string" ? product.brand : product.brand?.name, "JSON-LD Product.brand", match[1]);
        addField(fields, conflicts, fetch, "model", product.model ?? product.name, "JSON-LD Product.model/name", match[1]);
        addField(fields, conflicts, fetch, "mpn", product.mpn ?? product.sku, "JSON-LD Product.mpn/sku", match[1]);
      }
    } catch { /* invalid JSON-LD is a warning, not a guessed field */ }
  }
}

export function extractOfficialHtml(fetch, { sourceKind = "official-page" } = {}) {
  const html = fetch.body;
  const fields = [];
  const conflicts = [];
  const warnings = [];
  const accessBarrier = detectAccessBarrier(fetch);
  if (accessBarrier) warnings.push(`access barrier detected: ${accessBarrier.kind}; ${accessBarrier.manualAction}`);
  if (fetch.status < 200 || fetch.status >= 300 || accessBarrier) {
    if (fetch.status >= 400) warnings.push(`official page returned HTTP ${fetch.status}`);
    return { fields, conflicts, warnings, adapter: "generic-official-html-v1", ...(accessBarrier ? { accessBarrier } : {}) };
  }
  parseJsonLd(html, fetch, fields, conflicts);
  const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]);
  if (title) addField(fields, conflicts, fetch, "model", title, "HTML title", title, sourceKind);
  for (const row of html.matchAll(/<(?:tr|div|li)[^>]*>[\s\S]*?<(?:(?:th|dt)|span)[^>]*>([^<]{1,100})<\/(?:th|dt|span)>[\s\S]*?<(?:(?:td|dd)|span)[^>]*>([^<]{1,240})<\/(?:td|dd|span)>[\s\S]*?<\/(?:tr|div|li)>/gi)) {
    const label = strip(row[1]);
    const alias = FIELD_ALIASES.find(([, pattern]) => pattern.test(label));
    if (!alias) continue;
    const value = fieldValue(alias[0], row[2]);
    addField(fields, conflicts, fetch, alias[0], value, `spec label: ${label}`, `${label}: ${strip(row[2])}`, sourceKind);
  }
  if (fetch.contentType.includes("pdf")) warnings.push("PDF content requires a PDF extractor; HTML field extraction skipped");
  const expected = ["brand", "model", "mpn", "dims.lengthMm", "power.tdpW", "power.tgpW"];
  const missing = expected.filter((field) => !fields.some((entry) => entry.field === field));
  if (missing.length) warnings.push(`missing official fields: ${missing.join(", ")}`);
  return { title: title || undefined, fields, conflicts, warnings, adapter: "generic-official-html-v1", ...(accessBarrier ? { accessBarrier } : {}) };
}

/**
 * Conservative text-PDF extraction hook. The fetch layer keeps the response
 * hash and source URL; this parser only accepts explicit labelled rows from
 * text-bearing PDFs and never infers values from prose or neighbouring models.
 * The fetch layer decodes a bounded binary text layer first. Scanned PDFs and
 * documents without explicit labelled rows remain partial/unknown.
 */
export function extractOfficialPdf(fetch, { sourceKind = fetch.pdfExtraction?.mode === "ocr" ? "official-ocr-pdf" : "official-pdf" } = {}) {
  const fields = [];
  const conflicts = [];
  const warnings = [];
  const text = String(fetch.body ?? "").replace(/\u0000/g, " ");
  const lines = text.split(/\r?\n/).map((line) => line.replace(/[^\x20-\x7E\u4E00-\u9FFF]+/g, " ").trim()).filter(Boolean);
  for (const line of lines) {
    const normalizedLine = line.replace(/^\s*\|\s*/, "").replace(/\s*\|\s*$/, "");
    const dimension = normalizedLine.match(/^(?:dimension|dimensions|size)\s*[:：]\s*(\d+(?:\.\d+)?)\s*mm\s*\(W\)\s*[*x×]\s*(\d+(?:\.\d+)?)\s*mm\s*\((?:D|L)\)\s*[*x×]\s*(\d+(?:\.\d+)?)\s*mm\s*\(H\)/i);
    if (dimension) {
      addField(fields, conflicts, fetch, "dims.widthMm", Number(dimension[1]), "PDF dimension label (W)", normalizedLine, sourceKind);
      addField(fields, conflicts, fetch, "dims.lengthMm", Number(dimension[2]), "PDF dimension label (D/L)", normalizedLine, sourceKind);
      addField(fields, conflicts, fetch, "dims.heightMm", Number(dimension[3]), "PDF dimension label (H)", normalizedLine, sourceKind);
      continue;
    }
    const match = normalizedLine.match(/^([^:：]{1,80})\s*[:：]\s*(.{1,160})$/);
    if (!match) continue;
    const alias = FIELD_ALIASES.find(([, pattern]) => pattern.test(strip(match[1])));
    if (!alias) continue;
    const value = fieldValue(alias[0], match[2]);
    addField(fields, conflicts, fetch, alias[0], value, `PDF text label: ${strip(match[1])}`, `${strip(match[1])}: ${strip(match[2])}`, sourceKind);
  }
  if (!fields.length) warnings.push("PDF text extractor found no explicit labelled fields");
  if (fetch.pdfExtraction?.mode === "ocr") warnings.push(`scanned PDF OCR requires manual review (${fetch.pdfExtraction.pagesProcessed ?? 0} pages, ${fetch.pdfExtraction.engine ?? "unknown engine"})`);
  if (fetch.pdfExtraction?.ocrError) warnings.push(`scanned PDF OCR unavailable: ${fetch.pdfExtraction.ocrError}`);
  const expected = ["brand", "model", "mpn", "dims.lengthMm", "power.tdpW", "power.tgpW"];
  const missing = expected.filter((field) => !fields.some((entry) => entry.field === field));
  if (missing.length) warnings.push(`missing official PDF fields: ${missing.join(", ")}`);
  return { fields, conflicts, warnings, adapter: sourceKind === "official-ocr-pdf" ? "generic-official-pdf-ocr-v1" : "generic-official-pdf-text-v1" };
}

export const genericOfficialAdapter = {
  id: "generic-official",
  domains: [],
  canHandle: () => true,
  extract: extractOfficialHtml,
};
