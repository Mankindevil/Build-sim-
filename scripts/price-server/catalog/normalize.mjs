const BRANDS = [
  ["Western Digital", ["western digital", "wd"]],
  ...["JONSBO", "ASUS", "Seagate", "Corsair", "Intel", "Kingston", "Samsung", "Seasonic", "SilverStone", "FSP", "Thermalright", "Noctua", "ID-COOLING", "LSI", "NVIDIA", "MSI"].map((brand) => [brand, [brand]]),
];
const CATEGORIES = [["case", ["case", "机箱"]], ["motherboard", ["motherboard", "mainboard", "主板"]], ["cpu", ["cpu", "processor", "处理器"]], ["psu", ["psu", "power supply", "电源"]], ["cooler", ["cooler", "散热器", "水冷"]], ["gpu", ["gpu", "显卡", "graphics"]], ["memory", ["memory", "ram", "内存"]], ["storage", ["ssd", "hdd", "硬盘", "固态", "机械盘"]], ["hba", ["hba", "sas card", "阵列卡"]]];
const INTERFACES = ["slimsas", "sff-8643", "sata", "nvme", "pcie", "ddr5", "ddr4", "ecc", "sfx", "atx"];
const SEASONIC_PSU_MODEL_TOKEN = /^(?:(?:focus|vertex|prime|core)-)?(?:gx|px|sgx|spx)-\d{3,4}(?:-v\d+)?$/i;
const GPU_CHIP_MODEL_TOKEN = /^(?:(?:geforce|radeon)-?)?(?:(?:rtx|gtx)-?\d{3,4}(?:-?(?:ti|super))?|rx-?\d{3,4}(?:-?(?:xt|xtx|gre))?|arc-?[ab]?\d{3,4})$/i;
const clean = (value) => value.normalize("NFKC").replace(/[‐‑‒–—−]/g, "-").replace(/[，、；]/g, " ").replace(/\s+/g, " ").trim();
const comparableIdentity = (value) => clean(String(value ?? "")).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function inferredBrand(value) {
  for (const [brand, aliases] of BRANDS) {
    if (aliases.some((alias) => new RegExp(`(?:^|[^a-z0-9])${escaped(alias)}(?:$|[^a-z0-9])`, "i").test(value))) return brand;
  }
  return undefined;
}
export function normalizeModelQuery(raw, overrides = {}) {
  if (typeof raw !== "string" || clean(raw) === "") throw new Error("query must be a non-empty string");
  const normalized = clean(raw), lower = normalized.toLocaleLowerCase();
  const brand = overrides.brand ?? inferredBrand(lower);
  const category = overrides.category ?? CATEGORIES.find(([, words]) => words.some((word) => lower.includes(word.toLocaleLowerCase())))?.[0];
  const capacityMatch = normalized.match(/\b(\d+(?:\.\d+)?)\s*(tb|gb|mb)\b/i);
  const capacity = capacityMatch ? `${capacityMatch[1]}${capacityMatch[2].toUpperCase()}` : undefined;
  const iface = INTERFACES.find((item) => lower.includes(item.toLocaleLowerCase()));
  const tokens = normalized.split(/[^A-Za-z0-9-]+/).filter(Boolean);
  const candidates = tokens.filter((token) => /[A-Za-z]/.test(token)
    && /\d/.test(token)
    && (token.includes("-") || token.length >= 8)
    && !((brand?.toLocaleLowerCase() === "seasonic" || category === "psu") && SEASONIC_PSU_MODEL_TOKEN.test(token))
    && !(category === "gpu" && GPU_CHIP_MODEL_TOKEN.test(token)));
  const categoryWords = new Set(CATEGORIES.flatMap(([, words]) => words.flatMap((word) => word.toLocaleLowerCase().split(/\s+/))));
  const brandWords = new Set((brand ?? "").toLocaleLowerCase().split(/\s+/).filter(Boolean));
  const meaningful = tokens.filter((token) => {
    const tokenLower = token.toLocaleLowerCase();
    return !brandWords.has(tokenLower) && !categoryWords.has(tokenLower) && !INTERFACES.includes(tokenLower)
      && !/^\d+(?:\.\d+)?(?:tb|gb|mb|w)$/i.test(token);
  });
  const inferredMpn = meaningful.length === 1 && candidates.includes(meaningful[0]) ? meaningful[0] : undefined;
  const suppliedMpn = overrides.mpn ?? (overrides.model ? undefined : inferredMpn);
  const inferredModel = normalized.replace(brand ?? "", "").replace(suppliedMpn ?? "", "").replace(/\b\d+(?:\.\d+)?\s*(?:tb|gb|mb)\b/ig, "").replace(new RegExp(INTERFACES.join("|"), "ig"), "").replace(/\s+/g, " ").trim() || undefined;
  const model = overrides.model ?? inferredModel;
  // A model duplicated into a historical catalog MPN field is not an
  // independent identity claim and must not trigger exact-variant lookup.
  const mpn = suppliedMpn && comparableIdentity(suppliedMpn) !== comparableIdentity(model) ? suppliedMpn : undefined;
  return { raw, ...(brand ? { brand } : {}), ...(model ? { model } : {}), ...(mpn ? { mpn } : {}), ...(category ? { category } : {}), ...(capacity ? { capacity } : {}), ...(iface ? { interface: iface } : {}), tokens: normalized.toLocaleLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean), locale: overrides.locale ?? "zh-CN" };
}
