import type { SkuCatalog, SkuRecord } from "../sku/types";
import { formatSnapshotStamp } from "../price/types";

export type PriceBand = [number | null, number | null];

/** V1-shaped display DTOs — derived from SKU records for the existing lab renderer. */
export type PsuView = {
  name: string;
  form: "ATX" | "SFX";
  watts: number | null;
  length: number | null;
  price: PriceBand;
  mid: number | null;
  /**
   * Independent leads usable for backplane inlets (SATA + Molex), not the total
   * modular cable count — a 9-cable box with one Molex lead still cannot fill
   * four inlets one-per-lead.
   */
  harness: number | null;
  /** SATA/PATA modular sockets; null when unknown. Caps how many leads can ever be plugged. */
  peripheralSockets: number | null;
  certification: string;
  modular: string;
  official: string;
  source: string;
  mode: string;
  fanOff: number | null;
  /** Open-bench Cybenetics / planning dBA when fan is spinning. */
  noiseDba: number | null;
  /** Average efficiency used for waste-heat estimate (0–1). */
  efficiency: number | null;
  noiseEvidence: string;
  confidence?: string;
};

export type CoolerView = {
  name: string;
  type: string;
  height: number | null;
  idleNoise: number | null;
  maxNoise: number | null;
  price: PriceBand;
  mid: number | null;
  ram: number | null;
  fit: string;
  note: string;
};

export type GpuView = {
  name: string;
  kind: string;
  vram: number | null;
  tgp: number | null;
  idle: number | null;
  length: number | null;
  slots: number | null;
  noise: number | null;
  price: PriceBand;
  mid: number | null;
  official: string;
  cooling: string;
  ai: string;
  specificGeometry: boolean;
  newPrice?: PriceBand;
};

export type RamView = {
  name: string;
  height: number | null;
  modules: number | null;
  capacity: number | null;
  ecc: boolean;
  speed: string;
  xmp: boolean;
  qvl: boolean;
  mpn?: string;
  price: PriceBand;
  mid: number | null;
  priceQuality: string;
  note: string;
};

export type AppearanceRef = {
  image?: string;
  page?: string;
  note?: string;
};

function planningBand(sku: SkuRecord): PriceBand {
  // Prefer audited snapshot current; else paid; never invent historical lows.
  const cur = sku.price.current;
  const paid = sku.price.paid;
  if (typeof cur === "number") return [cur, cur];
  if (typeof paid === "number") return [paid, paid];
  return [null, null];
}

function priceQualityFor(sku: SkuRecord, fallback: string): string {
  if (sku.price.snapshot) {
    const variant = sku.price.snapshot.variantLabel ? ` · ${sku.price.snapshot.variantLabel}` : "";
    const source = sku.price.snapshot.provenanceId ? ` · prov ${sku.price.snapshot.provenanceId.slice(0, 12)}` : "";
    return `${formatSnapshotStamp(sku.price.snapshot)}${variant}${source}`;
  }
  if (typeof sku.price.current === "number" && sku.price.currentEvidence !== "unknown") {
    return `current · ${sku.price.asOf ?? "undated"}`;
  }
  return fallback;
}

/** Snapshot/current overrides planning extras; paid-only stays a single-point band. */
function displayBand(sku: SkuRecord, planning?: PriceBand): PriceBand {
  if (typeof sku.price.current === "number") return [sku.price.current, sku.price.current];
  if (planning) return planning;
  return planningBand(sku);
}

function midOf(band: PriceBand): number | null {
  return band[0] === null || band[1] === null ? null : Math.round((band[0] + band[1]) / 2);
}

/** Extra display fields not yet fully modeled on SkuRecord.attrs */
const COOLER_EXTRAS: Record<string, Partial<CoolerView>> = {
  "cooler.thermalright-axp90-x53-full": {
    type: "下压风冷",
    idleNoise: 18,
    maxNoise: 22.4,
    price: [240, 350],
    mid: 270,
    note: "纯铜、不会大面积压住 DIMM；ATX 路线约留 12mm 进风间隙。",
  },
  "cooler.id-cooling-is-55-black": {
    type: "下压风冷",
    idleNoise: 19,
    maxNoise: 31.2,
    price: [195, 260],
    mid: 219,
    note: "当前官方总高 57mm；ATX 路线只余约 8mm，并要求 ≤33mm 低矮内存。",
  },
  "cooler.noctua-nh-l9x65": {
    type: "下压风冷",
    idleNoise: 17,
    maxNoise: 23.6,
    price: [399, 499],
    mid: 449,
    note: "高度正好等于 65mm 官方上限，公差与进风均无余量；ATX 路线不建议。",
  },
  "cooler.noctua-nh-u9s": {
    type: "塔式风冷",
    idleNoise: 17,
    maxNoise: 22.8,
    price: [449, 599],
    mid: 519,
    note: "仅 SFX 释放 CPU 上方后适合；散热、维护和低噪音最好。",
  },
  "cooler.aio-120-experimental": {
    type: "水冷",
    idleNoise: 25,
    maxNoise: 38,
    price: [399, 699],
    mid: 499,
    note: "N6 官方未列水冷排兼容；后置 120 位可能与 PSU、冷管和主板空间冲突。",
  },
  "cooler.aio-240-front": {
    type: "水冷",
    idleNoise: 24,
    maxNoise: 36,
    price: [299, 799],
    mid: 449,
    note: "N6 手册明确列出前置 240mm radiator；仍需按实物复核冷排厚度、风扇、冷管与 GPU 端部干涉。",
  },
};

const MODULAR_ZH: Record<string, string> = {
  full: "全模组",
  semi: "半模组",
  none: "非模组",
};

const PSU_EXTRAS: Record<string, Partial<PsuView>> = {
  "psu.seasonic-focus-gx-850-v5": {
    price: [899, 999],
    mid: 949,
    source: "拼多多可见 ¥898–999；多 SKU 需核对 850W 选项",
    mode: "ATX 后上置",
  },
  "psu.seasonic-focus-gx-750-v5": {
    price: [849, 949],
    mid: 899,
    source: "拼多多多 SKU 可见约 ¥899；所选功率需复核",
    mode: "ATX 后上置",
  },
  "psu.greatwall-f8-850": {
    price: [459, 599],
    mid: 519,
    source: "京东自营页面可见 ¥459–519；背板线束数量下单前确认",
    mode: "ATX 后上置",
    fanOff: 180,
    noiseDba: 30,
    efficiency: 0.88,
    noiseEvidence: "unknown",
  },
  "psu.corsair-sf750-atx31": {
    price: [1349, 1499],
    mid: 1379,
    source: "京东自营可见 ¥1,376–1,379",
    mode: "SFX 前置 / 下置",
    fanOff: 300,
    noiseDba: 27,
    efficiency: 0.92,
    noiseEvidence: "inferred",
    confidence: "model",
  },
  "psu.sfx-450-unlocked": {
    price: [499, 899],
    mid: 699,
    source: "仅作功率与尺寸保守包络；线束、效率和模组针脚未知",
    mode: "仅第二电源规划",
    fanOff: 0,
    noiseDba: 32,
    efficiency: 0.85,
    noiseEvidence: "unknown",
    confidence: "unknown",
  },
};

const GPU_EXTRAS: Record<string, Partial<GpuView>> = {
  "gpu.rtx-a2000-12gb": {
    kind: "工作站",
    noise: 38,
    price: [2400, 3500],
    mid: 2950,
    cooling: "涡轮 / 紧凑",
    ai: "4B 推理可用；12GB 对 LoRA 偏紧",
    specificGeometry: true,
  },
  "gpu.rtx-a4000-16gb": {
    kind: "工作站",
    noise: 47,
    price: [2950, 4500],
    mid: 3600,
    cooling: "单槽涡轮",
    ai: "本机甜点：16GB、140W、单槽，保留 HBA",
    specificGeometry: true,
    newPrice: [9500, 12800],
  },
  "gpu.rtx-4000-sff-ada-20gb": {
    kind: "工作站",
    noise: 42,
    price: [8500, 11500],
    mid: 9800,
    cooling: "双槽涡轮",
    ai: "低功耗 20GB，适合长期在线；溢价高",
    specificGeometry: true,
  },
  "gpu.rtx-a4500-20gb": {
    kind: "工作站",
    noise: 45,
    price: [4500, 7000],
    mid: 5750,
    cooling: "双槽涡轮",
    ai: "20GB 更适合 LoRA；热量与噪音明显上升",
    specificGeometry: true,
  },
  "gpu.rtx-a5000-24gb": {
    kind: "工作站",
    noise: 47,
    price: [6500, 9000],
    mid: 7750,
    cooling: "双槽涡轮",
    ai: "24GB 最实用，但需要侧风扇与 850W",
    specificGeometry: true,
  },
  "gpu.plan.rtx-5060ti-16": {
    kind: "消费级",
    noise: 35,
    price: [4589, 6399],
    mid: 5799,
    cooling: "双/三风扇轴流",
    ai: "每元算力强；多数 2.5 槽会挡 HBA",
    specificGeometry: false,
  },
  "gpu.none": {
    kind: "—",
    cooling: "—",
    ai: "QuickSync 与 CPU 任务；不适合高频 SD/LoRA",
    specificGeometry: true,
  },
};

const RAM_EXTRAS: Record<string, Partial<RamView>> = {
  "memory.corsair-cmk32gx5m2x6400c38": {
    price: [300, 550],
    mid: 425,
    priceQuality: "规划估算 · 搜料号",
    note: "ASUS QVL 有记录（Ver 5.43.13）。XMP 6400；不开 XMP 回落 JEDEC。高马甲可能挡 IS-55。",
  },
  "memory.kingston-kf564c32rsk2-32": {
    price: [320, 580],
    mid: 450,
    priceQuality: "规划估算 · 搜料号",
    note: "ASUS QVL 有记录。XMP 6400；高 Renegade 马甲可能挡 IS-55。",
  },
  "memory.adata-ax5u6000c4016g-clarbk": {
    price: [280, 520],
    mid: 400,
    priceQuality: "规划估算 · 搜料号",
    note: "ASUS QVL 有记录。同系列颜色变体也在表上；买前再对一次 Part No。",
  },
  "memory.corsair-cmt32gx5m2x6400c38": {
    price: [450, 800],
    mid: 620,
    priceQuality: "规划估算 · 搜料号",
    note: "ASUS QVL 有记录（Ver 5.43.13）。Dominator 很高，不配 IS-55。",
  },
  "memory.kingston-ksm48e40bd8km-32hm-x2": {
    price: [1200, 2200],
    mid: 1700,
    priceQuality: "规划估算 · 搜料号",
    note: "买两条 KSM48E40BD8KM-32HM。JEDEC 4800 ECC UDIMM（非 RDIMM）；网页 QVL 常刷不出 ECC，下单前再核。",
  },
};

function byCategory(catalog: SkuCatalog, category: SkuRecord["category"]): SkuRecord[] {
  return catalog.skus.filter((s) => s.category === category);
}

export function buildLabCatalogs(catalog: SkuCatalog): {
  psus: Record<string, PsuView>;
  coolers: Record<string, CoolerView>;
  gpus: Record<string, GpuView>;
  rams: Record<string, RamView>;
  officialProducts: Record<string, AppearanceRef>;
} {
  const psus: Record<string, PsuView> = {};
  for (const sku of byCategory(catalog, "psu")) {
    const ex = PSU_EXTRAS[sku.id] ?? {};
    const band = displayBand(sku, ex.price as PriceBand | undefined);
    const form = (sku.attrs?.form as "ATX" | "SFX" | undefined) ?? "ATX";
    const noiseFromSku =
      (sku.attrs?.cybeneticsNoiseDba as number | null | undefined) ??
      (sku.attrs?.planningNoiseDba as number | undefined);
    const effFromSku =
      (sku.attrs?.cybeneticsEfficiency as number | null | undefined) ??
      (sku.attrs?.planningEfficiency as number | undefined);
    psus[sku.id] = {
      name: sku.name,
      form,
      watts: sku.power.ratedW ?? null,
      length: sku.dims.lengthMm ?? null,
      price: band,
      mid: typeof sku.price.current === "number" ? sku.price.current : (ex.mid ?? midOf(band)),
      harness:
        typeof sku.harness?.peripheralLeads === "number"
          ? sku.harness.peripheralLeads
          : typeof sku.harness?.sataLeads === "number" && typeof sku.harness?.molexLeads === "number"
            ? sku.harness.sataLeads + sku.harness.molexLeads
            : null,
      peripheralSockets: typeof sku.attrs?.peripheralSockets === "number" ? sku.attrs.peripheralSockets : null,
      certification: (sku.attrs?.certification as string | undefined) ?? "未记录",
      modular: MODULAR_ZH[(sku.attrs?.modular as string | undefined) ?? ""] ?? "未记录",
      official: sku.price.note ?? "—",
      source: ex.source ?? sku.price.note ?? "—",
      mode: ex.mode ?? (form === "SFX" ? "SFX" : "ATX"),
      fanOff: (sku.attrs?.fanOffLoadW as number | undefined) ?? ex.fanOff ?? null,
      noiseDba: (typeof noiseFromSku === "number" ? noiseFromSku : undefined) ?? ex.noiseDba ?? null,
      efficiency: (typeof effFromSku === "number" ? effFromSku : undefined) ?? ex.efficiency ?? null,
      noiseEvidence: (sku.attrs?.noiseEvidence as string | undefined) ?? ex.noiseEvidence ?? "unknown",
      ...(ex.confidence ? { confidence: ex.confidence } : {}),
    };
  }

  const coolers: Record<string, CoolerView> = {};
  for (const sku of byCategory(catalog, "cooler")) {
    const ex = COOLER_EXTRAS[sku.id] ?? {};
    coolers[sku.id] = {
      name: sku.name,
      type: ex.type ?? "散热器",
      height: sku.dims.heightMm ?? null,
      idleNoise: ex.idleNoise ?? null,
      maxNoise: ex.maxNoise ?? null,
      price: displayBand(sku, ex.price),
      mid: typeof sku.price.current === "number" ? sku.price.current : (ex.mid ?? midOf(displayBand(sku, ex.price))),
      ram: (sku.attrs?.maxRamHeightMm as number | undefined) ?? null,
      fit: (sku.attrs?.fitHint as string | undefined) ?? "unknown",
      note: ex.note ?? "",
    };
  }

  const gpus: Record<string, GpuView> = {};
  for (const sku of byCategory(catalog, "gpu")) {
    const ex = GPU_EXTRAS[sku.id] ?? {};
    const band = displayBand(sku, ex.price);
    const capacityText = typeof sku.attrs?.capacity === "string" ? sku.attrs.capacity : "";
    const parsedVram = capacityText.match(/(\d+(?:\.\d+)?)\s*GB\b/i)?.[1];
    const parsedMemoryTechnology = capacityText.match(/\b(GDDR\d+X?|HBM\d*[A-Z]?)\b/i)?.[1]?.toLocaleUpperCase();
    const noiseFromSku = typeof sku.attrs?.noiseDba === "number" ? sku.attrs.noiseDba
      : typeof sku.attrs?.planningNoiseDba === "number" ? sku.attrs.planningNoiseDba
        : null;
    gpus[sku.id] = {
      name: sku.name,
      kind: (sku.attrs?.memoryTechnology as string | undefined) ?? parsedMemoryTechnology ?? ex.kind ?? "—",
      vram: (sku.attrs?.vramGb as number | undefined) ?? (parsedVram ? Number(parsedVram) : null),
      tgp: sku.power.tgpW ?? null,
      idle: sku.power.idleW ?? null,
      length: sku.dims.lengthMm ?? null,
      slots: sku.dims.slots ?? null,
      noise: noiseFromSku ?? ex.noise ?? null,
      price: band,
      mid: typeof sku.price.current === "number" ? sku.price.current : (ex.mid ?? midOf(band)),
      official: sku.price.note ?? "—",
      cooling: (sku.attrs?.cooling as string | undefined) ?? ex.cooling ?? "待官网/实测补充",
      ai: ex.ai ?? "—",
      specificGeometry: ex.specificGeometry ?? Boolean(sku.dims.lengthMm && sku.dims.slots),
      ...(ex.newPrice ? { newPrice: ex.newPrice } : {}),
    };
  }

  const rams: Record<string, RamView> = {};
  for (const sku of byCategory(catalog, "memory")) {
    const ex = RAM_EXTRAS[sku.id] ?? {};
    const band = displayBand(sku, ex.price);
    const attrNote = (sku.attrs?.note as string | undefined) ?? "";
    rams[sku.id] = {
      name: sku.name,
      height: sku.dims.heightMm ?? null,
      modules: (sku.attrs?.modules as number | undefined) ?? null,
      capacity: (sku.attrs?.capacityGb as number | undefined) ?? null,
      ecc: Boolean(sku.attrs?.ecc),
      speed: String(sku.attrs?.speedMt ?? ""),
      xmp: Boolean(sku.attrs?.xmp),
      qvl: Boolean(sku.attrs?.qvl),
      ...(sku.mpn ? { mpn: sku.mpn } : {}),
      price: band,
      mid: typeof sku.price.current === "number" ? sku.price.current : (ex.mid ?? midOf(band)),
      priceQuality: priceQualityFor(sku, ex.priceQuality ?? "unknown"),
      note: ex.note ?? attrNote,
    };
  }

  const officialProducts: Record<string, AppearanceRef> = {};
  for (const sku of catalog.skus) {
    const app = sku.appearance;
    if (!app) continue;
    officialProducts[sku.id] = app;
  }
  // Legacy gallery keys still referenced by runtime product cards
  officialProducts.n6 = officialProducts["case.jonsbo-n6"] ?? {};
  officialProducts.board = officialProducts["board.asus-w680m-ace-se"] ?? {};
  officialProducts.cpu = officialProducts["cpu.i5-14500"] ?? {};
  officialProducts.ssd = officialProducts["storage.samsung-980-pro"] ?? {};
  officialProducts.focus = officialProducts["psu.seasonic-focus-gx-850-v5"] ?? {};
  officialProducts.axp90 = officialProducts["cooler.thermalright-axp90-x53-full"] ?? {};
  officialProducts.a4000 = officialProducts["gpu.rtx-a4000-16gb"] ?? {};
  officialProducts.hdd = officialProducts["storage.seagate-exos-x24-24tb"] ?? {};

  return { psus, coolers, gpus, rams, officialProducts };
}
