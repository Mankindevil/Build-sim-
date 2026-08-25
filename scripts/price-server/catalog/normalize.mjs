const BRANDS = ["JONSBO", "ASUS", "Seagate", "Corsair", "Intel", "Kingston", "Samsung", "Seasonic", "SilverStone", "FSP", "Thermalright", "Noctua", "ID-COOLING", "LSI", "NVIDIA"];
const CATEGORIES = [["case", ["case", "机箱"]], ["motherboard", ["motherboard", "mainboard", "主板"]], ["cpu", ["cpu", "processor", "处理器"]], ["psu", ["psu", "power supply", "电源"]], ["cooler", ["cooler", "散热器", "水冷"]], ["gpu", ["gpu", "显卡", "graphics"]], ["memory", ["memory", "ram", "内存"]], ["storage", ["ssd", "hdd", "硬盘", "固态", "机械盘"]], ["hba", ["hba", "sas card", "阵列卡"]]];
const INTERFACES = ["slimsas", "sff-8643", "sata", "nvme", "pcie", "ddr5", "ddr4", "ecc", "sfx", "atx"];
const clean = (value) => value.normalize("NFKC").replace(/[‐‑‒–—−]/g, "-").replace(/[，、；]/g, " ").replace(/\s+/g, " ").trim();
export function normalizeModelQuery(raw, overrides = {}) {
  if (typeof raw !== "string" || clean(raw) === "") throw new Error("query must be a non-empty string");
  const normalized = clean(raw), lower = normalized.toLocaleLowerCase();
  const brand = overrides.brand ?? BRANDS.find((item) => lower.includes(item.toLocaleLowerCase()));
  const category = overrides.category ?? CATEGORIES.find(([, words]) => words.some((word) => lower.includes(word.toLocaleLowerCase())))?.[0];
  const capacityMatch = normalized.match(/\b(\d+(?:\.\d+)?)\s*(tb|gb|mb)\b/i);
  const capacity = capacityMatch ? `${capacityMatch[1]}${capacityMatch[2].toUpperCase()}` : undefined;
  const iface = INTERFACES.find((item) => lower.includes(item.toLocaleLowerCase()));
  const tokens = normalized.split(/[^A-Za-z0-9-]+/).filter(Boolean);
  const mpn = tokens.filter((token) => /[A-Za-z]/.test(token) && /\d/.test(token) && (token.includes("-") || token.length >= 8)).sort((a, b) => b.length - a.length)[0];
  const model = normalized.replace(brand ?? "", "").replace(mpn ?? "", "").replace(/\b\d+(?:\.\d+)?\s*(?:tb|gb|mb)\b/ig, "").replace(new RegExp(INTERFACES.join("|"), "ig"), "").replace(/\s+/g, " ").trim() || undefined;
  return { raw, ...(brand ? { brand } : {}), ...(model ? { model } : {}), ...(mpn ? { mpn } : {}), ...(category ? { category } : {}), ...(capacity ? { capacity } : {}), ...(iface ? { interface: iface } : {}), tokens: normalized.toLocaleLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean), locale: overrides.locale ?? "zh-CN" };
}
