import { detectAccessBarrier } from "./access-barrier.mjs";

const FIELD_ALIASES = [
  ["mpn", /^(mpn|manufacturer\s*part\s*(number|no\.?)|part\s*(number|no\.?)|model\s*(number|no\.?)|制造商(?:料号|零件号)|产品料号)$/iu],
  ["brand", /^(brand|品牌|制造商)$/iu],
  ["model", /^(model|product\s*(?:name|model)|产品型号|型号)$/iu],
  ["dims.lengthMm", /^(length|depth|长度|深度)$/i],
  ["dims.widthMm", /^(width|宽度)$/i],
  ["dims.heightMm", /^(height|高度)$/i],
  ["dims.slots", /^(slot|slots|pci\s+expansion\s+slots?|pci扩展槽|槽位)$/iu],
  ["power.tdpW", /^(tdp|tdp\s*power|热设计功耗)$/i],
  ["power.tgpW", /^(tgp|graphics\s*power|显卡功耗)$/i],
  ["power.ratedW", /^(rated\s*(power|output)|continuous\s*power|output\s*capacity|power\s*output|额定功率)$/i],
  ["attrs.noiseDba", /^(noise(\s*level)?|acoustic(\s*noise)?|maximum\s*noise|噪音|噪声)$/i],
  ["attrs.maxOperatingTempC", /^(max(?:imum)?\s*(operating|gpu)?\s*temperature|maximum\s*temperature|最高(?:工作)?温度)$/i],
  ["attrs.capacity", /^(capacity|容量)$/i],
  ["attrs.interface", /^(interface|接口)$/i],
];

const COMBINED_DIMENSION_LABEL = /^(?:dimension|dimensions|product\s*dimensions?|size|产品尺寸|外形尺寸|机身尺寸)$/iu;

function decodeHtmlText(value) {
  return String(value ?? "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}
function strip(value) { return decodeHtmlText(String(value ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim(); }
function esc(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function decodeHtmlAttribute(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}
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
  if (field === "dims.lengthMm" || field === "dims.widthMm" || field === "dims.heightMm" || field === "dims.slots" || field === "power.tdpW" || field === "power.tgpW" || field === "power.ratedW" || field === "attrs.noiseDba" || field === "attrs.maxOperatingTempC") return numberWithUnit(value);
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

function normalizedMeasurementText(value) {
  return strip(value)
    // Real vendor markup sometimes splits one unit over adjacent spans, for
    // example `353m</span><span>m(D)`. Joining only measurement units keeps
    // ordinary word boundaries intact.
    .replace(/(\d)\s*(c|m)\s+m(?=\s*\(?\s*[WDLH])/gi, "$1$2m")
    .replace(/[×＊]/g, "x");
}

function addCombinedDimensions(fields, conflicts, fetch, value, locator, sourceKind) {
  const text = normalizedMeasurementText(value);
  const dimensions = [];
  for (const match of text.matchAll(/(-?\d+(?:\.\d+)?)\s*(mm|cm)\s*\(?\s*([WDLH])\s*\)?/gi)) {
    dimensions.push({ axis: match[3].toLocaleUpperCase(), value: numberWithUnit(`${match[1]} ${match[2]}`) });
  }
  for (const match of text.matchAll(/(?:^|[^A-Z0-9])([WDLH])\s*[:=]?\s*(-?\d+(?:\.\d+)?)\s*(mm|cm)\b/gi)) {
    dimensions.push({ axis: match[1].toLocaleUpperCase(), value: numberWithUnit(`${match[2]} ${match[3]}`) });
  }
  const byAxis = new Map();
  for (const dimension of dimensions) {
    if (dimension.value === undefined) continue;
    const field = dimension.axis === "W" ? "dims.widthMm" : dimension.axis === "H" ? "dims.heightMm" : "dims.lengthMm";
    if (!byAxis.has(field)) byAxis.set(field, dimension.value);
  }
  // At least two explicitly labelled axes are required. Unlabelled triples are
  // deliberately left unknown because vendors disagree on L/W/H ordering.
  if (byAxis.size < 2) return false;
  for (const [field, dimension] of byAxis) addField(fields, conflicts, fetch, field, dimension, locator, text, sourceKind);
  return true;
}

function parseLabeledText(labelValue, rawValue, fetch, fields, conflicts, locator, sourceKind) {
  const label = strip(labelValue).replace(/[：:]$/, "").trim();
  const value = normalizedMeasurementText(rawValue);
  if (!label || !value) return false;
  if (COMBINED_DIMENSION_LABEL.test(label)) return addCombinedDimensions(fields, conflicts, fetch, value, locator, sourceKind);
  const alias = FIELD_ALIASES.find(([, pattern]) => pattern.test(label));
  if (!alias) return false;
  addField(fields, conflicts, fetch, alias[0], fieldValue(alias[0], value), locator, `${label}: ${value}`, sourceKind);
  return true;
}

function parseStructuredHtmlFields(html, fetch, fields, conflicts, sourceKind) {
  // Common two-column specification markup. Only pair simple cells inside one
  // bounded row. The previous cross-layer regex could borrow a later span from
  // a nested filter/list container and turn a category page into a product.
  for (const row of html.matchAll(/<(tr|div|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const rowTag = row[1].toLocaleLowerCase();
    const inner = row[2];
    if (rowTag !== "tr" && new RegExp(`<${rowTag}\\b`, "i").test(inner)) continue;
    const cells = [...inner.matchAll(/<(th|td|dt|dd|span)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
      .filter((cell) => !/<(?:th|td|dt|dd|span|tr|div|li)\b/i.test(cell[2]))
      .map((cell) => strip(cell[2]))
      .filter(Boolean);
    if (cells.length !== 2) continue;
    parseLabeledText(cells[0], cells[1], fetch, fields, conflicts, `spec label: ${cells[0]}`, sourceKind);
  }
  // Real product pages also publish a complete `Label: value` row inside one
  // td/p/li with several nested spans. Parse each bounded semantic block rather
  // than flattening the entire page, which avoids borrowing nearby model data.
  for (const block of html.matchAll(/<(tr|p|li|dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = normalizedMeasurementText(block[2]);
    const pair = text.match(/^([^:：]{1,80})\s*[:：]\s*(.{1,320})$/u);
    if (!pair) continue;
    parseLabeledText(pair[1], pair[2], fetch, fields, conflicts, `${block[1].toLocaleUpperCase()} labelled row: ${strip(pair[1])}`, sourceKind);
  }
}

function exactTextMatch(text, value) {
  const expected = String(value ?? "").normalize("NFKC").trim();
  if (!expected) return null;
  const flexible = expected.split(/[\s_-]+/).filter(Boolean).map(esc).join("[\\s_-]*");
  const match = String(text ?? "").normalize("NFKC").match(new RegExp(`(?:^|[^A-Z0-9])(${flexible})(?=$|[^A-Z0-9])`, "i"));
  return match?.[1] ?? null;
}

/**
 * Discover bounded official PDF links embedded in a rendered product page.
 * Some vendor sites put downloads in data-url/data-href instead of href. This
 * function only discovers candidates; the caller must still apply the official
 * registry, DNS and exact-product checks before trusting any field.
 */
export function discoverEmbeddedOfficialPdfUrls(html, pageUrl, { limit = 3 } = {}) {
  const candidates = [];
  const source = String(html ?? "");
  const attribute = /\b(?:href|data-url|data-href)\s*=\s*(["'])([^"']+)\1/gi;
  for (const match of source.matchAll(attribute)) {
    const raw = decodeHtmlAttribute(match[2]);
    let url;
    try { url = new URL(raw, pageUrl); } catch { continue; }
    if (url.protocol !== "https:" || !/\.pdf$/i.test(url.pathname)) continue;
    url.hash = "";
    const start = Math.max(0, source.lastIndexOf("<", match.index));
    const openingEnd = source.indexOf(">", (match.index ?? 0) + match[0].length);
    const tagName = source.slice(start, openingEnd + 1).match(/^<([a-z][\w:-]*)\b/i)?.[1];
    const closingEnd = tagName ? source.toLocaleLowerCase().indexOf(`</${tagName.toLocaleLowerCase()}>`, openingEnd + 1) : -1;
    const end = closingEnd >= 0 ? closingEnd + tagName.length + 3 : Math.min(source.length, openingEnd + 160);
    const context = strip(source.slice(start, end));
    const searchable = `${url.pathname} ${context}`;
    const score = /data\s*sheet|datasheet|specification|spec\s*sheet|technical\s*data/i.test(searchable) ? 4
      : /product|focus|power|dimension|download/i.test(searchable) ? 3
        : /manual|guide|document/i.test(searchable) ? 2 : 1;
    candidates.push({ url: url.toString(), score, index: match.index ?? 0 });
  }
  const seen = new Set();
  return candidates
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .filter((entry) => !seen.has(entry.url) && seen.add(entry.url))
    .slice(0, Math.min(5, Math.max(0, Number(limit) || 0)))
    .map((entry) => entry.url);
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
        addField(fields, conflicts, fetch, "mpn", product.mpn, "JSON-LD Product.mpn", match[1]);
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
  parseStructuredHtmlFields(html, fetch, fields, conflicts, sourceKind);
  // JSON-LD and explicit Model rows are authoritative. Generic site titles are
  // a last-resort identity hint and must never override an explicit product
  // model such as JONSBO's `Model：N6`.
  if (title && !fields.some((entry) => entry.field === "model")) addField(fields, conflicts, fetch, "model", title, "HTML title fallback", title, sourceKind);
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
    const dimensionLabel = normalizedLine.match(/^(?:dimension|dimensions|size)\s*[:：]/i);
    const dimensionParts = dimensionLabel ? [...normalizedLine.matchAll(/(\d+(?:\.\d+)?)\s*mm\s*\(([WDLH])\)/gi)] : [];
    if (dimensionParts.length >= 2) {
      for (const dimension of dimensionParts) {
        const axis = dimension[2].toLocaleUpperCase();
        const field = axis === "W" ? "dims.widthMm" : axis === "H" ? "dims.heightMm" : "dims.lengthMm";
        addField(fields, conflicts, fetch, field, Number(dimension[1]), `PDF dimension label (${axis})`, normalizedLine, sourceKind);
      }
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

/**
 * Promote fields from a family PDF only when that document explicitly names
 * the requested MPN. Shared labelled dimensions may then apply to that listed
 * variant; rated power is accepted only from the exact MPN's own row.
 */
export function extractExactVariantOfficialPdf(fetch, { mpn, brand } = {}) {
  const extracted = extractOfficialPdf(fetch);
  const sourceKind = fetch.pdfExtraction?.mode === "ocr" ? "official-ocr-pdf" : "official-pdf";
  const text = String(fetch.body ?? "").replace(/\u0000/g, " ");
  const lines = text.split(/\r?\n/).map((line) => line.replace(/[^\x20-\x7E\u4E00-\u9FFF]+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  const variantLines = lines.filter((line) => exactTextMatch(line, mpn));
  if (!variantLines.length) {
    return {
      ...extracted,
      fields: [],
      conflicts: [],
      warnings: [...extracted.warnings, `official PDF does not explicitly name requested MPN: ${String(mpn ?? "missing").slice(0, 80)}`],
      exactVariant: false,
    };
  }
  // A family document may list the requested MPN somewhere while publishing
  // dimensions for a sibling elsewhere. When another explicit part/model code
  // is present, discard document-global fields and keep only evidence on the
  // requested variant's own row. Shared/global fields are retained only for a
  // document that names no competing variant.
  const explicitIdentifiers = new Set();
  for (const line of lines) {
    for (const match of line.matchAll(/\b(?:mpn|manufacturer\s*part\s*(?:number|no\.?)|part\s*(?:number|no\.?)|model)\s*[:：]\s*([A-Z0-9][A-Z0-9._/-]{2,})/gi)) {
      explicitIdentifiers.add(match[1].toLocaleUpperCase());
    }
    for (const match of line.matchAll(/\b([A-Z]{2,}[-_]\d[A-Z0-9._/-]*)\b/g)) explicitIdentifiers.add(match[1].toLocaleUpperCase());
  }
  const requestedIdentity = String(mpn ?? "").toLocaleUpperCase();
  const competingIdentifiers = [...explicitIdentifiers].filter((value) => comparablePdfIdentity(value) !== comparablePdfIdentity(requestedIdentity));
  const scoped = competingIdentifiers.length
    ? extractOfficialPdf({ ...fetch, body: variantLines.join("\n") })
    : extracted;
  if (competingIdentifiers.length) {
    scoped.warnings.push(`family PDF contains competing variants; global fields were not assigned to ${requestedIdentity}`);
  }
  const variantLine = variantLines[0];
  addField(scoped.fields, scoped.conflicts, fetch, "mpn", exactTextMatch(variantLine, mpn), "exact MPN row in official PDF", variantLine, sourceKind);
  const explicitBrand = exactTextMatch(text, brand);
  if (explicitBrand) addField(scoped.fields, scoped.conflicts, fetch, "brand", explicitBrand, "explicit manufacturer name in exact-variant official PDF", explicitBrand, sourceKind);
  const powerRows = variantLines.flatMap((line) => {
    const values = [...line.matchAll(/\b(\d{3,4})\s*W\b/gi)].map((match) => Number(match[1]));
    return [...new Set(values)].length === 1 ? [{ line, value: values[0] }] : [];
  });
  const uniqueWattages = [...new Set(powerRows.map((row) => row.value))];
  if (uniqueWattages.length === 1) {
    const row = powerRows.find((entry) => entry.value === uniqueWattages[0]);
    addField(scoped.fields, scoped.conflicts, fetch, "power.ratedW", uniqueWattages[0], "exact MPN power-distribution row", row?.line ?? variantLine, sourceKind);
  }
  return { ...scoped, exactVariant: true };
}

function comparablePdfIdentity(value) {
  return String(value ?? "").normalize("NFKC").toLocaleUpperCase().replace(/[^A-Z0-9]+/g, "");
}

export const genericOfficialAdapter = {
  id: "generic-official",
  domains: [],
  canHandle: () => true,
  extract: extractOfficialHtml,
};
