import type { SkuCategory } from "../sku/types";
import type { NormalizedModelQuery } from "./types";

const BRANDS = ["JONSBO", "ASUS", "Seagate", "Corsair", "Intel", "Kingston", "Samsung", "Seasonic", "SilverStone", "FSP", "Thermalright", "Noctua", "ID-COOLING", "LSI", "NVIDIA"];
const CATEGORY_WORDS: [SkuCategory, string[]][] = [
  ["case", ["case", "机箱"]],
  ["motherboard", ["motherboard", "mainboard", "主板"]],
  ["cpu", ["cpu", "processor", "处理器"]],
  ["psu", ["psu", "power supply", "电源"]],
  ["cooler", ["cooler", "散热器", "水冷"]],
  ["gpu", ["gpu", "显卡", "graphics"]],
  ["memory", ["memory", "ram", "内存"]],
  ["storage", ["ssd", "hdd", "硬盘", "固态", "机械盘"]],
  ["hba", ["hba", "sas card", "阵列卡"]],
];
const INTERFACES = ["slimsas", "sff-8643", "sata", "nvme", "pcie", "ddr5", "ddr4", "ecc", "sfx", "atx"];

function clean(value: string): string {
  return value.normalize("NFKC").replace(/[‐‑‒–—−]/g, "-").replace(/[，、；]/g, " ").replace(/\s+/g, " ").trim();
}

function findBrand(normalized: string): string | undefined {
  const lower = normalized.toLocaleLowerCase();
  return BRANDS.find((brand) => lower.includes(brand.toLocaleLowerCase()));
}

function findCategory(normalized: string): SkuCategory | undefined {
  const lower = normalized.toLocaleLowerCase();
  return CATEGORY_WORDS.find(([, words]) => words.some((word) => lower.includes(word.toLocaleLowerCase())))?.[0];
}

function findCapacity(normalized: string): string | undefined {
  const match = normalized.match(/\b(\d+(?:\.\d+)?)\s*(tb|gb|mb)\b/i);
  return match?.[1] && match[2] ? `${match[1]}${match[2].toUpperCase()}` : undefined;
}

function findInterface(normalized: string): string | undefined {
  const lower = normalized.toLocaleLowerCase();
  const found = INTERFACES.find((item) => lower.includes(item.toLocaleLowerCase()));
  return found;
}

function findMpn(normalized: string): string | undefined {
  const tokens = normalized.split(/[^A-Za-z0-9-]+/).filter(Boolean);
  const candidates = tokens.filter((token) => /[A-Za-z]/.test(token) && /\d/.test(token) && (token.includes("-") || token.length >= 8));
  return candidates.sort((a, b) => b.length - a.length)[0];
}

export function normalizeModelQuery(raw: string, overrides: Partial<Pick<NormalizedModelQuery, "brand" | "category" | "locale">> = {}): NormalizedModelQuery {
  if (typeof raw !== "string" || clean(raw) === "") throw new Error("query must be a non-empty string");
  const normalized = clean(raw);
  const brand = overrides.brand ?? findBrand(normalized);
  const category = overrides.category ?? findCategory(normalized);
  const capacity = findCapacity(normalized);
  const iface = findInterface(normalized);
  const mpn = findMpn(normalized);
  const withoutBrand = brand ? normalized.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ") : normalized;
  const withoutMpn = mpn ? withoutBrand.replace(mpn, " ") : withoutBrand;
  const model = withoutMpn.replace(/\b\d+(?:\.\d+)?\s*(?:tb|gb|mb)\b/ig, " ").replace(new RegExp(INTERFACES.join("|"), "ig"), " ").replace(/\s+/g, " ").trim() || undefined;
  const tokens = normalized.toLocaleLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  return { raw, ...(brand ? { brand } : {}), ...(model ? { model } : {}), ...(mpn ? { mpn } : {}), ...(category ? { category } : {}), ...(capacity ? { capacity } : {}), ...(iface ? { interface: iface } : {}), tokens, locale: overrides.locale ?? "zh-CN" };
}
