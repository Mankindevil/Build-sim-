import type { SkuCategory } from "../sku/types";
import type { NormalizedModelQuery, NormalizedModelQueryOverrides } from "./types";

const BRANDS: Array<[string, string[]]> = [
  ["Western Digital", ["western digital", "wd"]],
  ...["JONSBO", "ASUS", "Seagate", "Corsair", "Intel", "Kingston", "Samsung", "Seasonic", "SilverStone", "FSP", "Thermalright", "Noctua", "ID-COOLING", "LSI", "NVIDIA", "MSI"].map((brand): [string, string[]] => [brand, [brand]]),
];
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
const SEASONIC_PSU_MODEL_TOKEN = /^(?:(?:focus|vertex|prime|core)-)?(?:gx|px|sgx|spx)-\d{3,4}(?:-v\d+)?$/i;
const GPU_CHIP_MODEL_TOKEN = /^(?:(?:geforce|radeon)-?)?(?:(?:rtx|gtx)-?\d{3,4}(?:-?(?:ti|super))?|rx-?\d{3,4}(?:-?(?:xt|xtx|gre))?|arc-?[ab]?\d{3,4})$/i;

function clean(value: string): string {
  return value.normalize("NFKC").replace(/[‐‑‒–—−]/g, "-").replace(/[，、；]/g, " ").replace(/\s+/g, " ").trim();
}

function findBrand(normalized: string): string | undefined {
  const lower = normalized.toLocaleLowerCase();
  for (const [brand, aliases] of BRANDS) {
    if (aliases.some((alias) => new RegExp(`(?:^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`, "i").test(lower))) return brand;
  }
  return undefined;
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

function findMpn(normalized: string, brand?: string, category?: SkuCategory): string | undefined {
  const tokens = normalized.split(/[^A-Za-z0-9-]+/).filter(Boolean);
  const candidates = tokens.filter((token) => /[A-Za-z]/.test(token)
    && /\d/.test(token)
    && (token.includes("-") || token.length >= 8)
    && !((brand?.toLocaleLowerCase() === "seasonic" || category === "psu") && SEASONIC_PSU_MODEL_TOKEN.test(token))
    && !(category === "gpu" && GPU_CHIP_MODEL_TOKEN.test(token)));
  const categoryWords = new Set(CATEGORY_WORDS.flatMap(([, words]) => words.flatMap((word) => word.toLocaleLowerCase().split(/\s+/))));
  const brandWords = new Set((brand ?? "").toLocaleLowerCase().split(/\s+/).filter(Boolean));
  const meaningful = tokens.filter((token) => {
    const lower = token.toLocaleLowerCase();
    return !brandWords.has(lower) && !categoryWords.has(lower) && !INTERFACES.includes(lower)
      && !/^\d+(?:\.\d+)?(?:tb|gb|mb|w)$/i.test(token);
  });
  if (meaningful.length !== 1) return undefined;
  return candidates.includes(meaningful[0]!) ? meaningful[0] : undefined;
}

export function normalizeModelQuery(raw: string, overrides: NormalizedModelQueryOverrides = {}): NormalizedModelQuery {
  if (typeof raw !== "string" || clean(raw) === "") throw new Error("query must be a non-empty string");
  const normalized = clean(raw);
  const brand = overrides.brand ?? findBrand(normalized);
  const category = overrides.category ?? findCategory(normalized);
  const capacity = findCapacity(normalized);
  const iface = findInterface(normalized);
  const mpn = overrides.mpn ?? (overrides.model ? undefined : findMpn(normalized, brand, category));
  const withoutBrand = brand ? normalized.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ") : normalized;
  const withoutMpn = mpn ? withoutBrand.replace(mpn, " ") : withoutBrand;
  const model = overrides.model ?? (withoutMpn.replace(/\b\d+(?:\.\d+)?\s*(?:tb|gb|mb)\b/ig, " ").replace(new RegExp(INTERFACES.join("|"), "ig"), " ").replace(/\s+/g, " ").trim() || undefined);
  const tokens = normalized.toLocaleLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  return { raw, ...(brand ? { brand } : {}), ...(model ? { model } : {}), ...(mpn ? { mpn } : {}), ...(category ? { category } : {}), ...(capacity ? { capacity } : {}), ...(iface ? { interface: iface } : {}), tokens, locale: overrides.locale ?? "zh-CN" };
}
