import { registryForUrl } from "./registry.mjs";
import { extractOfficialHtml, extractOfficialPdf } from "./extract.mjs";
import { detectAccessBarrier } from "./access-barrier.mjs";

function extract(fetchResult, id) {
  const parsed = fetchResult.contentType.includes("pdf")
    ? extractOfficialPdf(fetchResult)
    : extractOfficialHtml(fetchResult);
  return { ...parsed, adapter: `${id}/${parsed.adapter}` };
}

function cleanHtml(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&trade;/gi, "™").replace(/&reg;/gi, "®").replace(/\s+/g, " ").trim();
}

function msiField(fetchResult, field, value, locator) {
  return {
    provenanceId: `prov-${fetchResult.contentHash.slice(0, 12)}-${field.replace(/[^a-z0-9]/gi, "-")}`,
    field,
    value,
    evidence: "official",
    sourceUrl: fetchResult.finalUrl,
    sourceKind: "official-page",
    retrievedAt: fetchResult.retrievedAt,
    extractor: "msi-gpu-spec-v1",
    locator,
    snippet: `${locator}: ${String(value)}`.slice(0, 240),
    confidence: 1,
  };
}

function extractMsiGpu(fetchResult) {
  const accessBarrier = detectAccessBarrier(fetchResult);
  if (fetchResult.status < 200 || fetchResult.status >= 300 || accessBarrier) {
    return {
      fields: [],
      conflicts: [],
      warnings: [
        ...(accessBarrier ? [`access barrier detected: ${accessBarrier.kind}; ${accessBarrier.manualAction}`] : []),
        ...(fetchResult.status >= 400 ? [`official page returned HTTP ${fetchResult.status}`] : []),
      ],
      adapter: "msi-gpu-spec-v1",
      ...(accessBarrier ? { accessBarrier } : {}),
    };
  }
  const html = fetchResult.body;
  const values = new Map();
  for (const row of html.matchAll(/<div class=["']tr["'][^>]*>[\s\S]*?<li class=["']specName["'][^>]*>\s*([^<]{1,100})<\/li>[\s\S]*?<\/ul>\s*([\s\S]*?)<\/div>\s*<\/div>/gi)) {
    values.set(cleanHtml(row[1]).toLocaleLowerCase(), cleanHtml(row[2]));
  }
  const fields = [];
  const add = (field, value, locator) => { if (value !== undefined && value !== null && value !== "") fields.push(msiField(fetchResult, field, value, locator)); };
  const title = cleanHtml(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  add("brand", "MSI", "official domain");
  add("model", values.get("model name") || title, "Model Name");
  add("attrs.interface", values.get("interface"), "Interface");
  add("attrs.capacity", values.get("memory"), "Memory");
  const power = values.get("power consumption")?.match(/(\d+(?:\.\d+)?)\s*w/i)?.[1];
  add("power.tgpW", power ? Number(power) : undefined, "Power consumption");
  add("harness.pciePower", values.get("power connectors"), "Power connectors");
  const recommendedPsu = values.get("recommended psu")?.match(/(\d+(?:\.\d+)?)\s*w/i)?.[1];
  add("attrs.recommendedPsuW", recommendedPsu ? Number(recommendedPsu) : undefined, "Recommended PSU");
  const noise = (values.get("noise level") || values.get("acoustic noise"))?.match(/(\d+(?:\.\d+)?)\s*dba/i)?.[1];
  add("attrs.noiseDba", noise ? Number(noise) : undefined, "Noise Level");
  const maxTemperature = (values.get("maximum gpu temperature") || values.get("maximum operating temperature"))?.match(/(\d+(?:\.\d+)?)\s*°?c/i)?.[1];
  add("attrs.maxOperatingTempC", maxTemperature ? Number(maxTemperature) : undefined, "Maximum GPU Temperature");
  const dimensionsText = values.get("card dimension (mm)");
  const dimensions = dimensionsText?.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
  if (dimensions) {
    add("dims.lengthMm", Number(dimensions[1]), "Card Dimension (mm) · length");
    add("dims.heightMm", Number(dimensions[2]), "Card Dimension (mm) · height");
    add("dims.thicknessMm", Number(dimensions[3]), "Card Dimension (mm) · thickness");
  }
  add("attrs.outputs", values.get("output"), "Output");
  const warnings = [];
  if (!fields.some((field) => field.field === "dims.slots")) warnings.push("MSI page publishes card thickness but not PCIe slot count; dims.slots remains unknown");
  return { title: title || undefined, fields, conflicts: [], warnings, adapter: "msi-gpu-spec-v1" };
}

const msiGpuAdapter = {
  id: "msi-gpu-spec-v1",
  brand: "MSI",
  domains: ["msi.com"],
  canHandle(url) {
    const parsed = url instanceof URL ? url : new URL(url);
    return registryForUrl(parsed)?.brand === "MSI" && /\/Graphics-Card\//i.test(parsed.pathname);
  },
  extract: extractMsiGpu,
};

function adapterForBrand(brand, id) {
  return {
    id,
    brand,
    domains: registryForUrl(new URL(`https://${brand.toLocaleLowerCase()}.com`))?.domains ?? [],
    canHandle(url) {
      const registry = registryForUrl(url instanceof URL ? url : new URL(url));
      return registry?.brand.toLocaleLowerCase() === brand.toLocaleLowerCase();
    },
    discover(query) {
      const registry = registryForUrl(new URL(`https://${brand.toLocaleLowerCase()}.com`));
      if (!registry) return [];
      return [{
        url: registry.search.urlTemplate.replace("{query}", encodeURIComponent(query.raw)),
        source: { kind: "search", domain: registry.domains[0] },
        adapter: id,
      }];
    },
    extract(fetchResult) {
      return extract(fetchResult, id);
    },
  };
}

export const OFFICIAL_ADAPTERS = [
  msiGpuAdapter,
  adapterForBrand("ASUS", "asus-product-v1"),
  adapterForBrand("Seagate", "seagate-product-v1"),
  adapterForBrand("Corsair", "corsair-product-v1"),
];

export function adapterForUrl(rawUrl) {
  const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  return OFFICIAL_ADAPTERS.find((adapter) => adapter.canHandle(url)) ?? null;
}
