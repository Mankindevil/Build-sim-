import type { BuildConfig, BuildLineItem } from "../config/types";
import type { SkuCatalog } from "../sku/types";
import { requireSku } from "../sku/catalog";
import { evaluateOccupancy, type EngineFinding, type EngineResult } from "./engine";
import {
  buildN6Occupancy,
  conflictMarkerParts,
  n6DomainFindings,
} from "../adapters/jonsbo-n6/occupancy";
import type { GeometryEnv } from "../adapters/jonsbo-n6/geometry";
import { N6_DECK_Y, buildN6Geometry } from "../adapters/jonsbo-n6/geometry";
import { buildN6Routing, type N6Routing } from "../adapters/jonsbo-n6/routing";
import { buildN6Assembly } from "../adapters/jonsbo-n6/assembly";
import type { AssemblyPlan } from "./assembly";
import type { PlacedPart } from "./geometry";
import { buildFieldBounds, type FieldBounds } from "./thermal-field";
import { planN6Wiring } from "../wiring/plan";
import type { WiringPlan } from "../wiring/types";
import { buildSataPorts, needsHba } from "./policy";
import {
  PLANNING_THETA,
  computeThermal,
  leftFanMountAvailable,
  type ComponentInput,
  type FanGroupInput,
  type FanMode,
  type Range,
  type ThermalResult,
} from "./thermal";
import n6Profile from "../../data/cases/jonsbo-n6/profile.json";
import { n6PowerProfile } from "./capabilities";

/**
 * User-side knobs the SKU catalog cannot supply: ambient, fan policy, which fan
 * mounts are actually populated, and the power split the load model produced.
 */
export interface ThermalEnv {
  ambientC: number;
  fanMode: FanMode;
  fans: {
    front?: FanGroupInput | null;
    rear?: FanGroupInput | null;
    left?: FanGroupInput | null;
    right?: FanGroupInput | null;
  };
  /** Dissipation in the board chamber (CPU + board + fans + HBA + GPU). */
  upperWatts: number;
  /** DC load carried by the PSU that sits in the lower chamber. */
  psuDcWatts: number;
  workload?: "idle" | "work" | "read" | "quicksync" | "cpu" | "ai" | "combined";
  /** Optional CPU power limits used by the deterministic power profile. */
  cpuPl1W?: number;
  cpuPl2W?: number;
  /**
   * Per-part dissipation, so component temperatures rest on the same load split
   * the power model already produced rather than a second estimate.
   */
  loads?: { cpuW: number | null; gpuW: number | null; hbaW: number | null; psuDcW: number | null };
  /** Keep the chipset x4 envelope in the model before an HBA is bought. */
  reserveHbaSlot?: boolean;
  /** User-entered card envelope for the lab's "custom GPU" path (no SKU exists). */
  gpuOverride?: GeometryEnv["gpuOverride"];
  /** The exact power object used to build this thermal input, preventing a second estimate. */
  power?: PowerEvaluation;
}

export interface PsuLoad {
  psuId: string;
  role: "primary" | "secondary";
  chamber: "upper" | "lower";
  capacityW: number | null;
  dcLoadW: number | null;
  wallW: number | null;
  wasteHeatW: number | null;
  efficiency: number | null;
  evidence: "official" | "standard" | "inferred" | "unknown";
}

export interface PowerEvaluation {
  workload: NonNullable<ThermalEnv["workload"]>;
  baseW: number | null;
  cpuW: number | null;
  gpuW: number | null;
  hddW: number | null;
  hbaW: number | null;
  fanW: number | null;
  mainDcW: number | null;
  driveDcW: number | null;
  dcW: number | null;
  wallW: number | null;
  pathologicalDcW: number | null;
  pathologicalWallW: number | null;
  headroomRatio: number | null;
  psuWasteW: number | null;
  upperDcW: number | null;
  lowerDcW: number | null;
  loads: { cpuW: number | null; gpuW: number | null; hbaW: number | null; psuDcW: number | null };
  psus: PsuLoad[];
  scenarios: { label: string; wallW: number | null }[];
  unknown: string[];
}

export interface PriceLine {
  skuId: string;
  qty: number;
  priceCny: number | null;
  msrpCny: number | null;
  currentCny: number | null;
  paidCny: number | null;
  historicalLowCny: number | null;
  priceKind: "msrp" | "current" | "paid" | "unknown";
  evidence: string;
  asOf?: string;
  snapshot?: { platform: string; asOf: string; listingUrl?: string; match?: string };
  source?: string;
}

export interface PriceEvaluation {
  knownCny: number;
  unknownSkuIds: string[];
  items: PriceLine[];
  catalogUpdatedAt: string;
}

export interface NoiseEvaluation {
  totalDba: number | null;
  evidence: "official" | "standard" | "inferred" | "unknown";
  parts: Record<string, number | null>;
  unknown: string[];
}

/**
 * Which fan mounts are populated is already in `ThermalEnv.fans`, so the geometry
 * model reads the same field rather than keeping a second copy that could drift.
 */
export function geometryEnvFrom(env?: ThermalEnv): GeometryEnv {
  if (!env) return {};
  return {
    frontFans: env.fans.front ? (env.fans.front.size === 140 ? "140x2" : "120x2") : "none",
    rearFan: Boolean(env.fans.rear?.count),
    driveFans: Boolean(env.fans.left?.count),
    sideFans: Boolean(env.fans.right?.count),
    ...(env.reserveHbaSlot ? { reserveHbaSlot: true } : {}),
    ...(env.gpuOverride ? { gpuOverride: env.gpuOverride } : {}),
  };
}

export interface BuildEvaluation {
  config: BuildConfig;
  occupancy: EngineResult;
  wiring: WiringPlan;
  findings: EngineFinding[];
  bom: BuildLineItem[];
  /** The millimetre geometry every consumer shares — preview, collisions, heat field. */
  geometry: PlacedPart[];
  /** Cable runs resolved over that geometry: ports, polylines, required lengths. */
  routing: N6Routing;
  /** Assembly order derived from the mounting tree, install corridors and cables. */
  assembly: AssemblyPlan;
  /** Present only when the caller supplies airflow inputs. */
  thermal?: ThermalResult;
  /** Heat sources placed at real centroids. Present whenever `thermal` is. */
  heatField?: FieldBounds;
  /** Single deterministic power fact source for every page KPI and thermal input. */
  power: PowerEvaluation;
  /** Price summary derived from this evaluation's BOM and catalog snapshot. */
  price: PriceEvaluation;
  /** Noise is explicit unknown until fan/noise evidence is available. */
  noise: NoiseEvaluation;
}

function isSfx(psuId: string, catalog: SkuCatalog): boolean {
  try {
    return requireSku(catalog, psuId).attrs?.form === "SFX";
  } catch {
    return false;
  }
}

type Workload = NonNullable<ThermalEnv["workload"]>;

function evidenceOf(value: unknown): PsuLoad["evidence"] {
  return value === "official" || value === "standard" || value === "inferred" || value === "unknown"
    ? value
    : "unknown";
}

function numericAttr(sku: ReturnType<typeof requireSku> | undefined, key: string): number | null {
  const value = sku?.attrs?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumNullable(values: (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/**
 * Deterministic electrical envelope. It intentionally returns null plus an
 * unknown reason when a catalog/profile fact is missing; callers must not turn
 * that absence into a plausible-looking wattage.
 */
export function derivePower(
  config: BuildConfig,
  catalog: SkuCatalog,
  env: Partial<Pick<ThermalEnv, "workload" | "cpuPl1W" | "cpuPl2W" | "fans">> = {},
): PowerEvaluation {
  const profile = n6PowerProfile();
  const workload: Workload = env.workload ?? "idle";
  const unknown: string[] = [];
  const base = profile.boardBaseW;
  const fanBase = profile.fanBaseW;
  const fanGroups = [env.fans?.front, env.fans?.rear, env.fans?.left, env.fans?.right].filter(Boolean);
  const fanW =
    fanBase === null ||
    fanGroups.some((fan) => typeof fan?.count !== "number") ||
    fanGroups.some((fan) => (fan?.size === 140 ? profile.fan140W : profile.fan120W) === null)
      ? null
      : fanBase +
        fanGroups.reduce(
          (sum, fan) => sum + (fan?.count ?? 0) * (fan?.size === 140 ? profile.fan140W! : profile.fan120W!),
          0,
        );
  if (base === null) unknown.push("power.boardBaseW");
  if (fanW === null) unknown.push("power.fanW");

  const cpu = catalog.skus.find((sku) => sku.id === config.cpuId);
  const gpu = catalog.skus.find((sku) => sku.id === config.selection.gpuId);
  const disk = catalog.skus.find((sku) => sku.id === (config.selection.diskSkuId ?? n6Profile.defaults.diskSkuId));
  const hbaId = config.selection.hbaSkuId ?? n6Profile.hba.defaultSkuId;
  const hba = catalog.skus.find((sku) => sku.id === hbaId);
  const cpuIdle = profile.cpuIdleW;
  const cpuRead = profile.cpuReadW;
  const cpuQuickSync = profile.cpuQuickSyncW;
  const cpuPl1 = env.cpuPl1W ?? cpu?.power.tdpW ?? null;
  const cpuPl2 = env.cpuPl2W ?? (cpuPl1 === null ? null : Math.max(cpuPl1, cpuPl1 * 1.35));
  const cpuW =
    workload === "idle" ? cpuIdle : workload === "read" ? cpuRead : workload === "quicksync" ? cpuQuickSync : workload === "cpu" ? cpuPl1 : workload === "ai" || workload === "combined" ? cpuPl2 : cpuPl1;
  const gpuW = gpu
    ? workload === "idle" || workload === "read" || workload === "quicksync" || workload === "cpu"
      ? gpu.power.idleW ?? null
      : gpu.power.tgpW ?? null
    : null;
  const hbaW = needsHba(config.selection, buildSataPorts(catalog, config)) || config.selection.hbaMode === "always" ? numericAttr(hba, "tdpW") ?? hba?.power.tdpW ?? profile.hbaW : 0;
  const diskEach = workload === "idle" ? disk?.power.idleW ?? null : disk?.power.maxOperatingW ?? null;
  const hddW = diskEach === null ? null : diskEach * config.selection.diskCount;
  if (cpuW === null) unknown.push("cpu.power");
  if (gpuW === null) unknown.push("gpu.power");
  if (diskEach === null && config.selection.diskCount > 0) unknown.push("storage.power");
  if (hbaW === null && (needsHba(config.selection, buildSataPorts(catalog, config)) || config.selection.hbaMode === "always")) unknown.push("hba.power");

  const dual = config.selection.psuTopology === "dual";
  const syncW = dual && config.selection.dualStart === "sync" ? profile.dualSyncW ?? null : 0;
  if (dual && config.selection.dualStart === "sync" && syncW === null) unknown.push("power.dualSyncW");
  const mainDcW = sumNullable([base, fanW, syncW, cpuW, gpuW, hbaW, dual ? 0 : hddW]);
  const driveDcW = dual ? sumNullable([hddW, 2]) : 0;
  const dcW = sumNullable([mainDcW, driveDcW]);
  const mainPsu = catalog.skus.find((sku) => sku.id === config.selection.psuId);
  const secondaryPsu = dual
    ? catalog.skus.find((sku) => sku.id === (config.selection.secondaryPsuId ?? n6Profile.defaults.secondaryPsuSkuId))
    : undefined;
  const psuLoad = (sku: typeof mainPsu, role: PsuLoad["role"], chamber: PsuLoad["chamber"], dc: number | null): PsuLoad => {
    const capacityW = sku?.power.ratedW ?? null;
    const efficiency = numericAttr(sku, "cybeneticsEfficiency") ?? numericAttr(sku, "planningEfficiency");
    const evidence = evidenceOf(sku?.attrs?.efficiencyEvidence ?? sku?.power.evidence);
    const wallW = dc === null || efficiency === null || efficiency <= 0 ? null : dc / efficiency;
    const wasteHeatW = wallW === null || dc === null ? null : wallW - dc;
    if (sku === undefined) unknown.push(`${role}.psu`);
    if (dc === null) unknown.push(`${role}.dcLoadW`);
    if (efficiency === null) unknown.push(`${role}.efficiency`);
    return { psuId: sku?.id ?? (role === "primary" ? config.selection.psuId : config.selection.secondaryPsuId ?? "unknown"), role, chamber, capacityW, dcLoadW: dc, wallW, wasteHeatW, efficiency, evidence };
  };
  const psus = [psuLoad(mainPsu, "primary", dual ? "upper" : "upper", mainDcW)];
  if (dual) psus.push(psuLoad(secondaryPsu, "secondary", "lower", driveDcW));
  const wallW = sumNullable(psus.map((load) => load.wallW));
  const psuWasteW = sumNullable(psus.map((load) => load.wasteHeatW));
  const pathologicalDiskW = disk?.attrs?.startup12vPeakA && typeof disk.attrs.startup12vPeakA === "number" ? disk.attrs.startup12vPeakA * 12 * config.selection.diskCount : null;
  const pathologicalGpuW = gpu?.power.tgpW ?? null;
  const pathologicalDcW = sumNullable([base, fanW, cpuPl2, pathologicalGpuW, hbaW, dual ? 0 : pathologicalDiskW]);
  const pathologicalDriveW = dual ? sumNullable([pathologicalDiskW, 2]) : 0;
  const pathologicalTotalW = sumNullable([pathologicalDcW, pathologicalDriveW]);
  const pathologicalWallW = pathologicalTotalW === null ? null : dual ? sumNullable([pathologicalDcW === null ? null : psuLoad(mainPsu, "primary", "upper", pathologicalDcW).wallW, psuLoad(secondaryPsu, "secondary", "lower", pathologicalDriveW).wallW]) : psuLoad(mainPsu, "primary", "upper", pathologicalTotalW).wallW;
  const headroomRatio = psus.every((load) => load.capacityW !== null && load.dcLoadW !== null)
    ? Math.min(...psus.map((load) => ((load.capacityW ?? 0) - (load.dcLoadW ?? 0)) / (load.capacityW ?? 1)))
    : null;
  const upperDcW = sumNullable([base, fanW, cpuW, gpuW, hbaW]);
  const lowerDcW = dual ? driveDcW : 0;
  const loads = { cpuW, gpuW, hbaW, psuDcW: mainDcW };
  const scenarios = [
    { label: "当前负载", wallW },
    { label: "病态同时峰值", wallW: pathologicalWallW },
  ];
  return {
    workload,
    baseW: base,
    cpuW,
    gpuW,
    hddW,
    hbaW,
    fanW,
    mainDcW,
    driveDcW,
    dcW,
    wallW,
    pathologicalDcW: pathologicalTotalW,
    pathologicalWallW,
    headroomRatio,
    psuWasteW,
    upperDcW,
    lowerDcW,
    loads,
    psus,
    scenarios,
    unknown: [...new Set(unknown)],
  };
}

function derivePrice(bom: BuildLineItem[], catalog: SkuCatalog): PriceEvaluation {
  const items = bom.map((line) => {
    const sku = catalog.skus.find((entry) => entry.id === line.skuId);
    const currentCny = typeof sku?.price.current === "number" ? sku.price.current : null;
    const paidCny = typeof sku?.price.paid === "number" ? sku.price.paid : null;
    const msrpCny = typeof sku?.price.msrp === "number" ? sku.price.msrp : null;
    const historicalLowCny = typeof sku?.price.historicalLow === "number" ? sku.price.historicalLow : null;
    const priceKind: PriceLine["priceKind"] = currentCny !== null ? "current" : paidCny !== null ? "paid" : msrpCny !== null ? "msrp" : "unknown";
    const value = priceKind === "current" ? currentCny : priceKind === "paid" ? paidCny : priceKind === "msrp" ? msrpCny : null;
    return {
      skuId: line.skuId,
      qty: line.qty,
      priceCny: value,
      msrpCny,
      currentCny,
      paidCny,
      historicalLowCny,
      priceKind,
      evidence: value === null ? "unknown" : sku?.price.snapshot ? "snapshot" : priceKind,
      ...(sku?.price.asOf ? { asOf: sku.price.asOf } : {}),
      ...(sku?.price.snapshot ? { snapshot: sku.price.snapshot } : {}),
      ...(sku?.price.listingUrl ? { source: sku.price.listingUrl } : {}),
    };
  });
  return { knownCny: items.reduce((sum, item) => sum + (item.priceCny ?? 0) * item.qty, 0), unknownSkuIds: items.filter((item) => item.priceCny === null).map((item) => item.skuId), items, catalogUpdatedAt: catalog.updatedAt };
}

function deriveNoise(): NoiseEvaluation {
  return { totalDba: null, evidence: "unknown", parts: {}, unknown: ["fan SKU/noise profile", "in-chassis acoustic measurement"] };
}

export function deriveBom(config: BuildConfig, catalog: SkuCatalog): BuildLineItem[] {
  const d = n6Profile.defaults;
  const items: BuildLineItem[] = [
    { skuId: config.caseId, qty: 1, bucket: "owned" },
    { skuId: config.boardId, qty: 1, bucket: "owned" },
    { skuId: config.cpuId, qty: 1, bucket: "owned" },
    { skuId: d.ownedNvmeSkuId, qty: d.ownedNvmeQty, bucket: "owned" },
    { skuId: config.selection.psuId, qty: 1, bucket: "buy_now" },
    { skuId: config.selection.coolerId, qty: 1, bucket: "buy_now" },
    { skuId: config.selection.memoryId, qty: 1, bucket: "buy_now" },
  ];

  if (config.selection.gpuId !== "gpu.none") {
    items.push({ skuId: config.selection.gpuId, qty: 1, bucket: "upgrade_later" });
  }

  const diskSku = config.selection.diskSkuId ?? d.diskSkuId;
  if (config.selection.diskCount > 0) {
    items.push({ skuId: diskSku, qty: config.selection.diskCount, bucket: "buy_now" });
  }

  if (config.selection.boot === "bay") {
    items.push({ skuId: d.bootBaySkuId, qty: 1, bucket: "buy_now" });
  }

  const hbaNeeded = needsHba(config.selection, buildSataPorts(catalog, config));
  if (hbaNeeded) {
    items.push({
      skuId: config.selection.hbaSkuId ?? n6Profile.hba.defaultSkuId,
      qty: 1,
      bucket: "buy_now",
    });
  }

  // Data cables come from the wiring plan so the BOM cannot disagree with the
  // checklist about how many breakouts the chosen port mix actually needs.
  const checklist = planN6Wiring(config, catalog).checklist;
  const qtyOf = (id: string): number => checklist.find((c) => c.id === id)?.requiredQty ?? 0;
  const slimQty = qtyOf("slimsas-breakout");
  if (slimQty > 0) items.push({ skuId: d.slimsasCableSkuId, qty: slimQty, bucket: "buy_now" });
  const minisasQty = qtyOf("hba-minisas");
  if (minisasQty > 0) {
    items.push({ skuId: "accessory.minisas-hd-4xsata", qty: minisasQty, bucket: "buy_now" });
  }

  if (config.selection.psuTopology === "dual") {
    items.push({
      skuId: config.selection.secondaryPsuId ?? d.secondaryPsuSkuId,
      qty: 1,
      bucket: "optional",
    });
    if (config.selection.dualStart === "sync") {
      items.push({ skuId: d.dualSyncSkuId, qty: 1, bucket: "buy_now" });
    }
  }

  if (config.bom.length > 0) {
    const byId = new Map(items.map((i) => [i.skuId, i]));
    for (const line of config.bom) {
      byId.set(line.skuId, line);
    }
    return [...byId.values()];
  }

  for (const line of items) requireSku(catalog, line.skuId);
  return items;
}

function memoryCoolerFindings(config: BuildConfig, catalog: SkuCatalog): EngineFinding[] {
  const findings: EngineFinding[] = [];
  let cooler;
  let memory;
  try {
    cooler = requireSku(catalog, config.selection.coolerId);
    memory = requireSku(catalog, config.selection.memoryId);
  } catch {
    return findings;
  }

  const maxRam = cooler.attrs?.maxRamHeightMm;
  const ramH = memory.dims.heightMm;
  if (typeof maxRam === "number" && typeof ramH === "number" && ramH > maxRam) {
    findings.push({
      id: "mem.cooler-height",
      verdict: "bad",
      evidence: "inferred",
      message: `${memory.name} height ${ramH}mm exceeds ${cooler.name} clearance ${maxRam}mm`,
      related: [cooler.id, memory.id],
    });
  }

  if (memory.attrs?.xmp) {
    findings.push({
      id: "mem.xmp-overclock",
      verdict: "warn",
      evidence: memory.attrs?.qvl ? "official" : "unknown",
      message: `${memory.name}: XMP above i5-14500 JEDEC DDR5-4800; QVL listing does not guarantee rated speed`,
      related: [memory.id],
    });
  }

  if (memory.attrs?.speedMt === 8000) {
    findings.push({
      id: "mem.ddr5-8000",
      verdict: "warn",
      evidence: "unknown",
      message: "DDR5-8000 is not verified on this board/CPU; model only as downclock / training-fail risk",
      related: [memory.id],
    });
  }

  const fit = cooler.attrs?.fitHint;
  const psuSfx = isSfx(config.selection.psuId, catalog);
  if (fit === "sfx" && !psuSfx && config.selection.psuTopology !== "bottom") {
    findings.push({
      id: "cooler.tower-needs-sfx",
      verdict: "warn",
      evidence: "inferred",
      message: `${cooler.name} is intended for SFX / cleared upper chamber routes`,
      related: [cooler.id, config.selection.psuId],
    });
  }

  if (fit === "tight" && !psuSfx) {
    findings.push({
      id: "cooler.at-65mm-ceiling",
      verdict: "warn",
      evidence: "inferred",
      message: `${cooler.name} sits at the N6 ${n6Profile.coolerLimits.overheadAtxMm}mm cooler ceiling with no ATX intake margin`,
      related: [cooler.id],
    });
  }

  return findings;
}

function psuLengthFindings(config: BuildConfig, catalog: SkuCatalog): EngineFinding[] {
  const findings: EngineFinding[] = [];
  const check = (psuId: string) => {
    try {
      const psu = requireSku(catalog, psuId);
      const form = psu.attrs?.form;
      const len = psu.dims.lengthMm;
      if (form === "ATX" && typeof len === "number" && len > n6Profile.psuLimits.atxMaxLengthMm) {
        findings.push({
          id: `psu.atx-too-long:${psuId}`,
          verdict: "bad",
          evidence: "official",
          message: `${psu.name} length ${len}mm exceeds N6 ATX max ${n6Profile.psuLimits.atxMaxLengthMm}mm`,
          related: [psuId],
        });
      }
      if (form === "SFX" && typeof len === "number" && len > n6Profile.psuLimits.sfxMaxLengthMm) {
        findings.push({
          id: `psu.sfx-too-long:${psuId}`,
          verdict: "bad",
          evidence: "official",
          message: `${psu.name} length ${len}mm exceeds N6 SFX max ${n6Profile.psuLimits.sfxMaxLengthMm}mm`,
          related: [psuId],
        });
      }
    } catch {
      /* ignore */
    }
  };
  check(config.selection.psuId);
  if (config.selection.secondaryPsuId) check(config.selection.secondaryPsuId);
  return findings;
}

function gpuHbaFindings(config: BuildConfig, catalog: SkuCatalog): EngineFinding[] {
  const findings: EngineFinding[] = [];
  if (config.selection.gpuId === "gpu.none") return findings;
  let gpu;
  try {
    gpu = requireSku(catalog, config.selection.gpuId);
  } catch {
    return findings;
  }
  const slots = gpu.dims.slots ?? null;
  const hbaNeeded = needsHba(config.selection, buildSataPorts(catalog, config));

  if (hbaNeeded) {
    // With the x16 slot taken by the GPU, an x8 HBA has only the chipset x4 slot
    // left. Whether that slot is open-ended is not in our board data, and an x8
    // card cannot enter a closed x4 slot — so this is a check, not a verdict.
    const width = Number(
      catalog.skus.find((s) => s.id === (config.selection.hbaSkuId ?? n6Profile.hba.defaultSkuId))
        ?.attrs?.["pcieWidth"],
    );
    if (Number.isFinite(width) && width > 4) {
      findings.push({
        id: "hba.slot-width",
        verdict: "warn",
        evidence: "unknown",
        message: `显卡占用 x16 后，x${width} 的 HBA 只剩芯片组 x4 槽可用；该槽是否为开放式（免挡板尾端）我们没有确认过，闭口 x4 槽插不进 x${width} 卡。装机前先看板卡实物或改用 x4 卡。`,
        related: [config.selection.hbaSkuId ?? n6Profile.hba.defaultSkuId, "pcie.slot2"],
      });
    }
  }

  if (hbaNeeded && slots !== null && slots >= 2.5) {
    findings.push({
      id: "gpu.hba-slot-intrusion",
      verdict: "warn",
      evidence: "inferred",
      message: `${gpu.name} (~${slots} slots) likely intrudes into the chipset x4 envelope used by HBA`,
      related: [gpu.id, "pcie.slot2"],
    });
  }

  const len = gpu.dims.lengthMm ?? null;
  if (len !== null && len > n6Profile.gpuLimits.planningMinMm) {
    findings.push({
      id: "gpu.length-band",
      verdict: "warn",
      evidence: "inferred",
      message: `${gpu.name} length ${len}mm is above the softer N6 ${n6Profile.gpuLimits.planningMinMm}mm planning band; ${n6Profile.gpuLimits.publishedMaxMm}mm is the published upper endpoint without endpoint mapping`,
      related: [gpu.id],
    });
  }

  return findings;
}

/** Reads a θ band off the catalog; falls back to a declared planning envelope. */
function catalogTheta(
  sku: { attrs?: Record<string, unknown> } | undefined,
  fallback: Range,
): { theta: Range; evidence: ThermalResult["evidence"] } {
  const raw = sku?.attrs?.["thetaKPerW"] as { lo?: number; hi?: number } | undefined;
  if (typeof raw?.lo === "number" && typeof raw?.hi === "number") {
    return {
      theta: { lo: raw.lo, hi: raw.hi },
      evidence:
        (sku?.attrs?.["thetaEvidence"] as ThermalResult["evidence"] | undefined) ?? "inferred",
    };
  }
  return { theta: fallback, evidence: "unknown" };
}

/** Builds the part list the thermal model puts temperatures on. */
function componentInputs(
  config: BuildConfig,
  catalog: SkuCatalog,
  env: ThermalEnv,
  /** True only when the *primary* unit is the one sitting under the deck. */
  psuWasteInLowerChamber: boolean,
): ComponentInput[] {
  const loads = env.loads;
  if (!loads || Object.values(loads).some((value) => value === null)) return [];
  const cpuW = loads.cpuW!;
  const gpuW = loads.gpuW!;
  const hbaW = loads.hbaW!;
  const psuDcW = loads.psuDcW!;
  const out: ComponentInput[] = [];

  const cooler = catalog.skus.find((s) => s.id === config.selection.coolerId);
  const cpu = catalogTheta(cooler, { lo: 0.4, hi: 0.9 });
  out.push({
    id: "cpu",
    label: `CPU（${cooler?.name ?? "散热器未知"}）`,
    chamber: "upper",
    watts: cpuW,
    thetaKPerW: cpu.theta,
    evidence: cpu.evidence,
    thetaNote:
      (cooler?.attrs?.["thetaNote"] as string | undefined) ??
      "散热器 θ 未知，按下压风冷通用包络取值。",
  });

  if (gpuW > 0) {
    const gpu = catalog.skus.find((s) => s.id === config.selection.gpuId);
    const blower = (gpu?.tags ?? []).includes("workstation");
    const band = blower ? PLANNING_THETA["gpu-blower"]! : PLANNING_THETA["gpu-axial"]!;
    out.push({
      id: "gpu",
      label: `GPU（${gpu?.name ?? "自定义包络"}）`,
      chamber: "upper",
      watts: gpuW,
      thetaKPerW: band.theta,
      evidence: "inferred",
      thetaNote: band.note,
    });
  }

  if (hbaW > 0) {
    const directed = (env.fans.right?.count ?? 0) > 0;
    const band = directed
      ? PLANNING_THETA["hba-passive-directed"]!
      : PLANNING_THETA["hba-passive"]!;
    out.push({
      id: "hba",
      label: "HBA（被动散热）",
      chamber: "upper",
      watts: hbaW,
      thetaKPerW: band.theta,
      evidence: "inferred",
      thetaNote: band.note,
    });
  }

  const psu = catalog.skus.find((s) => s.id === config.selection.psuId);
  const eff = Number(psu?.attrs?.["cybeneticsEfficiency"] ?? psu?.attrs?.["planningEfficiency"]);
  const eta = Number.isFinite(eff) && eff > 0 ? eff : null;
  const wasteW = eta !== null && psuDcW > 0 ? psuDcW * (1 / eta - 1) : 0;
  if (wasteW > 0) {
    out.push({
      id: "psu",
      label: `电源（${psu?.name ?? "未知"}）`,
      chamber: psuWasteInLowerChamber ? "lower" : "upper",
      watts: wasteW,
      thetaKPerW: PLANNING_THETA["psu"]!.theta,
      evidence: "inferred",
      thetaNote: PLANNING_THETA["psu"]!.note,
    });
  }

  return out;
}

/** Pulls per-drive dissipation and PSU efficiency out of the catalog, then balances the air. */
function runThermal(
  config: BuildConfig,
  catalog: SkuCatalog,
  env: ThermalEnv,
  psuInLowerChamber: boolean,
): ThermalResult {
  const disk = config.selection.diskSkuId
    ? catalog.skus.find((s) => s.id === config.selection.diskSkuId)
    : undefined;
  const working = env.workload !== "idle";
  const diskW = working ? disk?.power?.maxOperatingW : disk?.power?.idleW;
  const psu = catalog.skus.find((s) => s.id === config.selection.psuId);
  const eff = Number(psu?.attrs?.["cybeneticsEfficiency"]);

  return computeThermal({
    components: componentInputs(
      config,
      catalog,
      env,
      config.selection.psuTopology === "bottom",
    ),
    ambientC: env.ambientC,
    fanMode: env.fanMode,
    // A left-side fan cannot draw air through a bracket that is no longer there.
    fans: leftFanMountAvailable(psuInLowerChamber) ? env.fans : { ...env.fans, left: null },
    diskCount: config.selection.diskCount,
    diskWattsEach: diskW!,
    diskEvidence: disk?.power?.evidence ?? "unknown",
    upperWatts: env.upperWatts,
    psuInLowerChamber,
    psuDcWatts: env.psuDcWatts,
    psuEfficiency: eff,
    psuEfficiencyEvidence:
      (psu?.attrs?.["efficiencyEvidence"] as ThermalResult["evidence"] | undefined) ?? "unknown",
  });
}

export function evaluateBuild(
  config: BuildConfig,
  catalog: SkuCatalog,
  env?: ThermalEnv,
): BuildEvaluation {
  const power = env?.power ?? derivePower(config, catalog, env ?? {});
  const geomEnv = geometryEnvFrom(env);
  const geometry = buildN6Geometry(config, catalog, geomEnv);
  const occupancyModel = buildN6Occupancy(config, catalog, geomEnv);
  const extra: EngineFinding[] = [
    ...n6DomainFindings(config),
    ...memoryCoolerFindings(config, catalog),
    ...psuLengthFindings(config, catalog),
    ...gpuHbaFindings(config, catalog),
  ];

  const claimsFront = occupancyModel.occupants.some((o) => o.slotIds.includes("fan.front"));
  const frontSfxOcc = occupancyModel.occupants.some((o) => o.slotIds.includes("psu.front_sfx"));
  if (!claimsFront && (frontSfxOcc || config.selection.psuTopology === "auto")) {
    occupancyModel.occupants.push({
      id: "occ-front-fans-default",
      skuId: "fan.front-placeholder",
      slotIds: ["fan.front"],
      evidence: "inferred",
    });
  }

  const occupancy = evaluateOccupancy(occupancyModel, extra);
  const wiring = planN6Wiring(config, catalog);
  const bom = deriveBom(config, catalog);

  const harness = wiring.backplaneHarness;
  const harnessFinding: EngineFinding = {
    id: "wiring.backplane-harness",
    verdict: harness.verdict === "unknown" ? "warn" : harness.verdict,
    evidence: harness.evidence,
    message: `背板独立线束（${harness.inlets} 口 = SATA×${harness.required.sata} + Molex×${harness.required.molex}）：${harness.notes.join(" ")}`,
    related: [harness.feedPsuId, config.caseId],
  };

  const spin = harness.spinUp;
  const spinUpFinding: EngineFinding = {
    id: "power.spin-up-surge",
    // A known surge that a single lead cannot legally carry is the harness verdict's
    // job to fail; here it stays informational unless the drive data is missing.
    verdict: spin.totalA === null ? "warn" : "ok",
    evidence: spin.evidence,
    message: `同时启转冲击：${spin.notes.join(" ")}`,
    related: [harness.feedPsuId, config.selection.diskSkuId ?? config.caseId],
  };

  const psuInLowerChamber =
    config.selection.psuTopology === "bottom" || config.selection.psuTopology === "dual";
  const bottomPsuFindings: EngineFinding[] = [];
  if (psuInLowerChamber) {
    const m = n6Profile.fanMounts;
    bottomPsuFindings.push({
      id: "psu.bottom-removes-left-fan-bracket",
      verdict: "warn",
      evidence: "official",
      message: `下置 SFX 按手册 §8.1 取下左侧风扇架，而 §14 的左侧 ${m.left.size}mm×${m.left.count} 风扇位就在这块支架上：机箱 ${m.left.count + m.right.count} 个侧风扇位只剩右侧 ${m.right.count} 个，且下置电源与盘仓同处下层腔体。`,
      related: [config.selection.psuId, config.caseId],
    });
  }

  const diskForThermal = catalog.skus.find((sku) => sku.id === (config.selection.diskSkuId ?? n6Profile.defaults.diskSkuId));
  const diskWattsForThermal = env?.workload === "idle" ? diskForThermal?.power.idleW : diskForThermal?.power.maxOperatingW;
  const psuForThermal = catalog.skus.find((sku) => sku.id === config.selection.psuId);
  const efficiencyForThermal = Number(psuForThermal?.attrs?.["cybeneticsEfficiency"] ?? psuForThermal?.attrs?.["planningEfficiency"]);
  const thermalInputsKnown = Boolean(
    env &&
      power.upperDcW !== null &&
      power.lowerDcW !== null &&
      typeof diskWattsForThermal === "number" &&
      Number.isFinite(efficiencyForThermal) &&
      efficiencyForThermal > 0,
  );
  const thermal = thermalInputsKnown ? runThermal(config, catalog, env!, psuInLowerChamber) : undefined;
  const thermalFindings: EngineFinding[] = [];
  if (env && !thermalInputsKnown) {
    thermalFindings.push({
      id: "thermal.input-unknown",
      verdict: "warn",
      evidence: "unknown",
      message: "温度模型缺少盘功耗或 PSU 效率事实；温度与废热保持 unknown，不使用默认数值填充。",
      related: [config.selection.diskSkuId ?? n6Profile.defaults.diskSkuId, config.selection.psuId],
    });
  }
  if (thermal && env) {
    if (psuInLowerChamber && (env.fans.left?.count ?? 0) > 0) {
      thermalFindings.push({
        id: "thermal.left-fan-mount-conflict",
        verdict: "bad",
        evidence: "official",
        message: `配置里装了左侧 ${env.fans.left?.count} 个风扇，但下置电源已按 §8.1 拆掉那块支架——两者不能同时成立。`,
        related: [config.selection.psuId, config.caseId],
      });
    }
    const lower = thermal.chambers.lower;
    thermalFindings.push({
      id: "thermal.lower-chamber-balance",
      verdict: lower.fanned ? "ok" : "warn",
      evidence: thermal.evidence,
      message: `下层空气热平衡（ṁ·cp·ΔT）：${thermal.notes.join(" ")}`,
      related: [config.selection.diskSkuId ?? config.caseId],
    });
    if (thermal.coupling.active) {
      thermalFindings.push({
        id: "thermal.bottom-psu-coupling",
        verdict: "warn",
        evidence: "unknown",
        message: `下置电源与盘仓共腔换热：废热 ${Math.round(thermal.coupling.psuWasteW)}W 占下层负荷 ${Math.round(thermal.coupling.shareOfLowerLoad * 100)}%，最坏情形使盘区空气再升 ${Math.round(thermal.coupling.extraRiseK * 10) / 10}K；风向未知，取包络。`,
        related: [config.selection.psuId, config.caseId],
      });
    }
  }

  // Routing runs after wiring and geometry because it needs both: the electrical
  // plan says which cables exist, the geometry says where their ends are.
  const routing = buildN6Routing(geometry, wiring, catalog);
  // Order comes last: it is a statement about the geometry and the cables, and
  // it cannot be derived before both of them exist.
  const assembly = buildN6Assembly(geometry, routing.cables);

  const findings = [
    ...occupancy.findings,
    harnessFinding,
    spinUpFinding,
    ...bottomPsuFindings,
    ...thermalFindings,
    ...routing.findings,
    ...assembly.findings,
    ...wiring.warnings.map(
      (w, i): EngineFinding => ({
        id: `wiring.warn.${i}`,
        verdict: "warn",
        evidence: "inferred",
        message: w,
      }),
    ),
    ...power.unknown.map(
      (field): EngineFinding => ({
        id: `power.unknown:${field}`,
        verdict: "warn",
        evidence: "unknown",
        message: `功耗事实缺少 ${field}；相关墙上功耗、废热或余量保持 unknown。`,
        related: [config.selection.psuId, config.cpuId],
      }),
    ),
  ];

  return {
    config,
    occupancy,
    wiring,
    findings: dedupeFindings(findings),
    bom,
    // Conflict markers ride along with the geometry so the preview can only ever
    // draw the volume the engine actually objected to.
    geometry: [...geometry, ...conflictMarkerParts(geometry, occupancy.conflicts)],
    routing,
    assembly,
    power,
    price: derivePrice(bom, catalog),
    noise: deriveNoise(),
    ...(thermal
      ? { thermal, heatField: buildFieldBounds(geometry, thermal, N6_DECK_Y) }
      : {}),
  };
}

function dedupeFindings(findings: EngineFinding[]): EngineFinding[] {
  const seen = new Set<string>();
  const out: EngineFinding[] = [];
  for (const f of findings) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}
