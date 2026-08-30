import type { BuildConfig, BuildLineItem, CaseFanGroupSelection } from "../config/types";
import { buildReadiness, validateConfig, type BuildReadiness } from "../config/validate";
import type { SkuCatalog } from "../sku/types";
import { requireSku } from "../sku/catalog";
import { evaluateOccupancy, type EngineFinding, type EngineResult } from "./engine";
import {
  DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY,
  CaseRuntimeAdapterRegistry,
  caseRuntimeResolution,
  type CaseRuntimeAdapter,
  type CaseRuntimeEnvironmentInput,
  type CaseRuntimeFans,
  type CaseRuntimeGpuOverride,
  type CaseRuntimeRouting,
  type CaseRuntimeResolution,
  type CaseRuntimeLookupIdentity,
} from "../adapters/runtime";
import type { AssemblyPlan } from "./assembly";
import type { PlacedPart } from "./geometry";
import { buildFieldBounds, type FieldBounds } from "./thermal-field";
import type { WiringPlan } from "../wiring/types";
import { buildSataPorts, needsHba } from "./policy";
import {
  PLANNING_THETA,
  computeThermal,
  type ComponentInput,
  type FanGroupInput,
  type FanMode,
  type Range,
  type ThermalResult,
} from "./thermal";
import { PHYSICAL_RULESET_VERSION, type PhysicalEvaluation } from "./physical";
import type { CalibrationEvaluation } from "./calibration";
import { validateCaseInstanceOverrides, type CaseInstanceOverrides } from "../adapters/instance-overrides";

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
  gpuOverride?: CaseRuntimeGpuOverride | null | undefined;
  /** The exact power object used to build this thermal input, preventing a second estimate. */
  power?: PowerEvaluation;
}

export interface CaseEvaluationRuntimeInput {
  registry?: CaseRuntimeAdapterRegistry;
  /** Exact identity from the locked adapter/catalog artifact. */
  caseIdentity?: CaseRuntimeLookupIdentity;
  /** Explicit compatibility seam for V2 configs; fails closed if variants exist. */
  legacySkuFallback?: boolean;
  /** Root-resolved, immutable plan/instance override input; never read globally. */
  instanceOverrides?: Readonly<CaseInstanceOverrides>;
  /** Multi-instance/V3 caller seam; the selected instance is resolved by exact key. */
  instanceOverridesByInstanceId?: Readonly<Record<string, Readonly<CaseInstanceOverrides>>>;
  /** Exact case component instance receiving overrides. */
  caseInstanceId?: string;
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
  /** Fan electrical heat split by the physical chamber of each mount. */
  upperFanW: number | null;
  lowerFanW: number | null;
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

/**
 * A purchase requirement that is physically configured but cannot enter the
 * SKU BOM yet.  It deliberately carries no placeholder identity or estimates:
 * the concrete product must be found and reviewed before procurement closes.
 */
export interface UnresolvedProcurementRequirement {
  id: string;
  category: "case-fan";
  mountId: string;
  mountLabel: string;
  sizeMm: 120 | 140;
  qty: number;
  skuId: null;
  unitPriceCny: null;
  reason: "concrete-sku-not-reviewed";
  unknownFields: ("skuId" | "unitPriceCny" | "noiseDba" | "airflowCfm")[];
}

export interface PriceEvaluation {
  knownCny: number;
  unknownSkuIds: string[];
  /** Non-SKU requirements are excluded from knownCny and remain explicit here. */
  unresolvedRequirements: UnresolvedProcurementRequirement[];
  /** False when either a BOM price or a concrete requirement is unresolved. */
  complete: boolean;
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
export function geometryEnvFrom(env?: Pick<ThermalEnv, "fans"> & Partial<ThermalEnv>): CaseRuntimeEnvironmentInput {
  if (!env) return { fans: {} };
  return {
    fans: env.fans,
    ...(env.reserveHbaSlot ? { reserveHbaSlot: true } : {}),
    ...(env.gpuOverride ? { gpuOverride: env.gpuOverride } : {}),
  };
}

export interface BuildEvaluation {
  config: BuildConfig;
  /** Exact case adapter identity plus per-domain ready/blocked state. */
  caseRuntime: CaseRuntimeResolution;
  /** Incomplete drafts are valid workspace state, but never masquerade as a full case evaluation. */
  readiness: BuildReadiness;
  occupancy: EngineResult;
  wiring: WiringPlan;
  findings: EngineFinding[];
  bom: BuildLineItem[];
  /** The millimetre geometry every consumer shares — preview, collisions, heat field. */
  geometry: PlacedPart[];
  /** Cable runs resolved over that geometry: ports, polylines, required lengths. */
  routing: CaseRuntimeRouting;
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
  /** Physical expansion checks share the same geometry, routing and wiring facts. */
  physical: PhysicalEvaluation;
  /** Raw calibration snapshot plus optional narrowed planning ranges. */
  calibration: CalibrationEvaluation;
}

/** Resolve only the selected, registered case; absence never borrows another case's mounts. */
export function configuredFanGroups(
  config: BuildConfig,
  catalog?: SkuCatalog,
  registry: CaseRuntimeAdapterRegistry = DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY,
  identity?: CaseRuntimeLookupIdentity,
): ThermalEnv["fans"] {
  const adapter = identity?.skuId === config.caseId ? registry.resolveExact(identity) : registry.resolveLegacySku(config.caseId);
  return adapter?.configuredFanGroups(config, catalog) ?? {};
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
  registry: CaseRuntimeAdapterRegistry = DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY,
  identity?: CaseRuntimeLookupIdentity,
): PowerEvaluation {
  const adapter = identity?.skuId === config.caseId ? registry.resolveExact(identity) : registry.resolveLegacySku(config.caseId);
  if (!adapter) throw new Error(`case runtime adapter unavailable: ${config.caseId}`);
  const profile = adapter.powerProfile;
  const defaults = adapter.defaults;
  const workload: Workload = env.workload ?? "idle";
  const unknown: string[] = [];
  const base = profile.boardBaseW;
  const fanBase = profile.fanBaseW;
  const fanGroupW = (fan: FanGroupInput | null | undefined): number | null => {
    if (!fan) return 0;
    const perFan = fan.size === 140 ? profile.fan140W : profile.fan120W;
    return perFan === null ? null : fan.count * perFan;
  };
  const upperFanW = fanBase === null ? null : sumNullable([fanBase, fanGroupW(env.fans?.front), fanGroupW(env.fans?.rear), fanGroupW(env.fans?.right)]);
  const lowerFanW = fanGroupW(env.fans?.left);
  const fanW = sumNullable([upperFanW, lowerFanW]);
  if (base === null) unknown.push("power.boardBaseW");
  if (fanW === null) unknown.push("power.fanW");

  const cpu = catalog.skus.find((sku) => sku.id === config.cpuId);
  const gpu = catalog.skus.find((sku) => sku.id === config.selection.gpuId);
  const diskId = config.selection.diskSkuId ?? defaults.diskSkuId;
  const disk = diskId ? catalog.skus.find((sku) => sku.id === diskId) : undefined;
  const hbaId = config.selection.hbaSkuId ?? defaults.hbaSkuId;
  const hba = hbaId ? catalog.skus.find((sku) => sku.id === hbaId) : undefined;
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
  const hddW = config.selection.diskCount === 0 ? 0 : diskEach === null ? null : diskEach * config.selection.diskCount;
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
  const secondaryPsuId = config.selection.secondaryPsuId ?? defaults.secondaryPsuSkuId;
  const secondaryPsu = dual
    ? catalog.skus.find((sku) => sku.id === secondaryPsuId)
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
  const primaryInLowerChamber = config.selection.psuTopology === "bottom";
  const psus = [psuLoad(mainPsu, "primary", primaryInLowerChamber ? "lower" : "upper", mainDcW)];
  if (dual) psus.push(psuLoad(secondaryPsu, "secondary", "lower", driveDcW));
  const wallW = sumNullable(psus.map((load) => load.wallW));
  const psuWasteW = sumNullable(psus.map((load) => load.wasteHeatW));
  const pathologicalDiskW = config.selection.diskCount === 0 ? 0
    : disk?.attrs?.startup12vPeakA && typeof disk.attrs.startup12vPeakA === "number" ? disk.attrs.startup12vPeakA * 12 * config.selection.diskCount : null;
  const pathologicalGpuW = gpu?.power.tgpW ?? null;
  const pathologicalDcW = sumNullable([base, fanW, cpuPl2, pathologicalGpuW, hbaW, dual ? 0 : pathologicalDiskW]);
  const pathologicalDriveW = dual ? sumNullable([pathologicalDiskW, 2]) : 0;
  const pathologicalTotalW = sumNullable([pathologicalDcW, pathologicalDriveW]);
  const pathologicalWallW = pathologicalTotalW === null ? null : dual ? sumNullable([pathologicalDcW === null ? null : psuLoad(mainPsu, "primary", "upper", pathologicalDcW).wallW, psuLoad(secondaryPsu, "secondary", "lower", pathologicalDriveW).wallW]) : psuLoad(mainPsu, "primary", "upper", pathologicalTotalW).wallW;
  const headroomRatio = psus.every((load) => load.capacityW !== null && load.dcLoadW !== null)
    ? Math.min(...psus.map((load) => ((load.capacityW ?? 0) - (load.dcLoadW ?? 0)) / (load.capacityW ?? 1)))
    : null;
  const upperDcW = sumNullable([base, upperFanW, cpuW, gpuW, hbaW]);
  // This is the load carried by whichever PSU physically sits below the deck;
  // thermal coupling must not confuse it with the chamber's component heat.
  const lowerDcW = primaryInLowerChamber ? mainDcW : dual ? driveDcW : 0;
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
    upperFanW,
    lowerFanW,
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

function deriveFanProcurementRequirements(config: BuildConfig, catalog: SkuCatalog, adapter: CaseRuntimeAdapter): UnresolvedProcurementRequirement[] {
  const mounts = new Map(adapter.capabilities.fanMounts.map((mount) => [mount.id, mount]));
  return adapter.effectiveFanSelections(config, catalog).map((group) => {
    const mount = mounts.get(group.mountId);
    return {
      id: `case-fan:${group.mountId}:${group.sizeMm}mm:${group.count}`,
      category: "case-fan",
      mountId: group.mountId,
      mountLabel: mount?.label ?? group.mountId,
      sizeMm: group.sizeMm,
      qty: group.count,
      skuId: null,
      unitPriceCny: null,
      reason: "concrete-sku-not-reviewed",
      unknownFields: ["skuId", "unitPriceCny", "noiseDba", "airflowCfm"],
    };
  });
}

function derivePrice(
  bom: BuildLineItem[],
  catalog: SkuCatalog,
  unresolvedRequirements: UnresolvedProcurementRequirement[] = [],
): PriceEvaluation {
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
  const unknownSkuIds = items.filter((item) => item.priceCny === null).map((item) => item.skuId);
  return {
    knownCny: items.reduce((sum, item) => sum + (item.priceCny ?? 0) * item.qty, 0),
    unknownSkuIds,
    unresolvedRequirements,
    complete: unknownSkuIds.length === 0 && unresolvedRequirements.length === 0,
    items,
    catalogUpdatedAt: catalog.updatedAt,
  };
}

function deriveNoise(config: BuildConfig, catalog: SkuCatalog): NoiseEvaluation {
  const gpu = catalog.skus.find((sku) => sku.id === config.selection.gpuId);
  const gpuNoise = typeof gpu?.attrs?.noiseDba === "number" && Number.isFinite(gpu.attrs.noiseDba) ? gpu.attrs.noiseDba : null;
  return {
    // A component's published sound pressure cannot be arithmetically promoted
    // to an in-chassis total without distance, fan curves and the other sources.
    totalDba: null,
    evidence: "unknown",
    parts: gpuNoise === null ? {} : { gpu: gpuNoise },
    unknown: ["fan SKU/noise profile", "in-chassis acoustic measurement", ...(gpuNoise === null && config.selection.gpuId !== "gpu.none" ? ["gpu acoustic measurement"] : [])],
  };
}

export function deriveBom(
  config: BuildConfig,
  catalog: SkuCatalog,
  registry: CaseRuntimeAdapterRegistry = DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY,
  identity?: CaseRuntimeLookupIdentity,
): BuildLineItem[] {
  const adapter = identity?.skuId === config.caseId ? registry.resolveExact(identity) : registry.resolveLegacySku(config.caseId);
  if (!adapter) throw new Error(`case runtime adapter unavailable: ${config.caseId}`);
  return adapter.deriveBom(config, catalog);
}

function memoryCoolerFindings(config: BuildConfig, catalog: SkuCatalog, adapter: CaseRuntimeAdapter): EngineFinding[] {
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
    const cpu = catalog.skus.find((sku) => sku.id === config.cpuId);
    findings.push({
      id: "mem.xmp-overclock",
      verdict: "warn",
      evidence: memory.attrs?.qvl ? "official" : "unknown",
      message: `${memory.name}: XMP exceeds ${cpu?.name ?? config.cpuId} JEDEC baseline; QVL listing does not guarantee rated speed`,
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
    const limit = adapter.capabilities.coolerLimits.overheadAtxMm;
    if (limit !== null) findings.push({
      id: "cooler.at-65mm-ceiling",
      verdict: "warn",
      evidence: "inferred",
      message: `${cooler.name} sits at the registered ${limit}mm cooler ceiling with no ATX intake margin`,
      related: [cooler.id],
    });
  }

  return findings;
}

function psuLengthFindings(config: BuildConfig, catalog: SkuCatalog, adapter: CaseRuntimeAdapter): EngineFinding[] {
  const findings: EngineFinding[] = [];
  const atxLimit = adapter.capabilities.psuLimits.atxMaxLengthMm;
  const sfxLimit = adapter.capabilities.psuLimits.sfxMaxLengthMm;
  const check = (psuId: string) => {
    try {
      const psu = requireSku(catalog, psuId);
      const form = psu.attrs?.form;
      const len = psu.dims.lengthMm;
      if (form === "ATX" && typeof len === "number" && atxLimit !== null && len > atxLimit) {
        findings.push({
          id: `psu.atx-too-long:${psuId}`,
          verdict: "bad",
          evidence: "official",
          message: `${psu.name} length ${len}mm exceeds the registered ATX max ${atxLimit}mm`,
          related: [psuId],
        });
      }
      if (form === "SFX" && typeof len === "number" && sfxLimit !== null && len > sfxLimit) {
        findings.push({
          id: `psu.sfx-too-long:${psuId}`,
          verdict: "bad",
          evidence: "official",
          message: `${psu.name} length ${len}mm exceeds the registered SFX max ${sfxLimit}mm`,
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

function gpuHbaFindings(config: BuildConfig, catalog: SkuCatalog, adapter: CaseRuntimeAdapter): EngineFinding[] {
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
    const hbaSkuId = config.selection.hbaSkuId ?? adapter.defaults.hbaSkuId;
    const width = Number(catalog.skus.find((sku) => sku.id === hbaSkuId)?.attrs?.["pcieWidth"]);
    if (Number.isFinite(width) && width > 4) {
      findings.push({
        id: "hba.slot-width",
        verdict: "warn",
        evidence: "unknown",
        message: `显卡占用 x16 后，x${width} 的 HBA 只剩芯片组 x4 槽可用；该槽是否为开放式（免挡板尾端）我们没有确认过，闭口 x4 槽插不进 x${width} 卡。装机前先看板卡实物或改用 x4 卡。`,
        related: [hbaSkuId ?? "hba.unresolved", "pcie.slot2"],
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
  const planningMin = adapter.capabilities.gpuLimits.planningMinMm;
  const publishedMax = adapter.capabilities.gpuLimits.publishedMaxMm;
  if (len !== null && planningMin !== null && len > planningMin) {
    findings.push({
      id: "gpu.length-band",
      verdict: "warn",
      evidence: "inferred",
      message: `${gpu.name} length ${len}mm is above the registered ${planningMin}mm planning band${publishedMax === null ? "" : `; ${publishedMax}mm is the published upper endpoint without endpoint mapping`}`,
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
  adapter: CaseRuntimeAdapter,
): ThermalResult {
  const disk = config.selection.diskSkuId
    ? catalog.skus.find((s) => s.id === config.selection.diskSkuId)
    : undefined;
  const working = env.workload !== "idle";
  const diskW = working ? disk?.power?.maxOperatingW : disk?.power?.idleW;
  const lowerPsuId = config.selection.psuTopology === "dual"
    ? config.selection.secondaryPsuId
    : config.selection.psuId;
  const psu = catalog.skus.find((s) => s.id === lowerPsuId);
  const eff = Number(psu?.attrs?.["cybeneticsEfficiency"] ?? psu?.attrs?.["planningEfficiency"]);

  return computeThermal({
    profile: adapter.thermalProfile!,
    components: componentInputs(
      config,
      catalog,
      env,
      config.selection.psuTopology === "bottom",
    ),
    ambientC: env.ambientC,
    fanMode: env.fanMode,
    fans: adapter.thermalFans(config, env.fans),
    diskCount: config.selection.diskCount,
    diskWattsEach: diskW!,
    diskEvidence: disk?.power?.evidence ?? "unknown",
    upperWatts: env.upperWatts,
    lowerAuxWatts: env.power?.lowerFanW ?? 0,
    psuInLowerChamber,
    psuDcWatts: env.psuDcWatts,
    psuEfficiency: eff,
    psuEfficiencyEvidence:
      (psu?.attrs?.["efficiencyEvidence"] as ThermalResult["evidence"] | undefined) ?? "unknown",
  });
}

const MISSING_LABELS: Record<string, string> = {
  caseId: "机箱",
  boardId: "主板",
  cpuId: "处理器",
  "case.adapter": "机箱能力适配器",
  "selection.psuId": "电源",
  "selection.coolerId": "CPU 散热器",
  "selection.gpuId": "显卡（也可明确选择暂不安装）",
  "selection.memoryId": "内存",
  "selection.diskSkuId": "数据硬盘型号",
};

function incompleteEvaluation(
  config: BuildConfig,
  catalog: SkuCatalog,
  readiness: BuildReadiness,
  adapter: CaseRuntimeAdapter | null = null,
  spatialHash: string | null = null,
): BuildEvaluation {
  const findings: EngineFinding[] = readiness.missing.map((path) => ({
    id: `config.missing:${path}`,
    verdict: "bad",
    evidence: "unknown",
    message: `${MISSING_LABELS[path] ?? path}尚未选择；可以继续逐件加入，完整兼容、接线与空间评估会在核心部件齐全后开始。`,
    related: [path],
  }));
  const wiring: WiringPlan = {
    caseId: config.caseId,
    bayPaths: [],
    backplanePower: [],
    backplaneHarness: {
      feedPsuId: config.selection.psuId,
      feedRole: "main",
      inlets: 0,
      required: { sata: 0, molex: 0 },
      confirmed: { sata: null, molex: null },
      connectors: { sata: null, molex: null },
      uniquePeripheralLeads: null,
      oneLeadPerInlet: false,
      daisyChainOnly: false,
      peripheralSockets: null,
      socketLimited: false,
      spinUp: { diskCount: config.selection.diskCount, perDiskA: null, totalA: null, perInletA: null, perSharedLeadA: null, leadLimitW: null, evidence: "unknown", notes: ["方案尚未完整，未生成启转负载。"] },
      verdict: "unknown",
      evidence: "unknown",
      notes: ["方案尚未完整，未生成背板线束结论。"],
    },
    checklist: [],
    warnings: [],
  };
  const power: PowerEvaluation = {
    workload: "idle", baseW: null, cpuW: null, gpuW: null, hddW: null, hbaW: null, fanW: null, upperFanW: null, lowerFanW: null,
    mainDcW: null, driveDcW: null, dcW: null, wallW: null, pathologicalDcW: null, pathologicalWallW: null,
    headroomRatio: null, psuWasteW: null, upperDcW: null, lowerDcW: null,
    loads: { cpuW: null, gpuW: null, hbaW: null, psuDcW: null }, psus: [], scenarios: [], unknown: [...readiness.missing],
  };
  const physical: PhysicalEvaluation = {
    schemaVersion: "1.0.0", rulesetVersion: PHYSICAL_RULESET_VERSION, hash: "unavailable", provenance: [], plugSweeps: [], bendRadius: [],
    slotWidth: { gpuSlots: null, hbaSlots: 0, totalSlots: 0, evidence: "unknown" },
    lane: { nvmeCount: config.selection.nvmeCount ?? 0, m2Slots: 0, slimSasClaimed: false, hbaPresent: false, evidence: "unknown" },
    serviceSpace: { minimumInsertionMm: null, blockedPorts: [], evidence: "unknown" }, findings: [],
  };
  const calibration: CalibrationEvaluation = {
    snapshot: {
      schemaVersion: "1.0.0", calibrationVersion: "unavailable", caseId: config.caseId, source: "No resolved case evaluation", provenance: [],
      wallPowerW: { value: null, evidence: "unknown", unit: "W" }, smartTemperatureC: { value: null, evidence: "unknown", unit: "°C" },
      cpuTemperatureC: { value: null, evidence: "unknown", unit: "°C" }, gpuTemperatureC: { value: null, evidence: "unknown", unit: "°C" },
      noiseDba: { value: null, evidence: "unknown", unit: "dBA" }, fanCurve: { mode: null, rpm: null, cfm: null, evidence: "unknown" },
    },
    unknown: ["wallPowerW", "smartTemperatureC", "cpuTemperatureC", "gpuTemperatureC", "noiseDba", "fanCurve"], provenance: [], narrowedRanges: {}, hash: "unavailable",
  };
  return {
    config, caseRuntime: caseRuntimeResolution(adapter, config.caseId, spatialHash), readiness,
    occupancy: { verdict: "bad", findings, conflicts: [] },
    wiring, findings, bom: [], geometry: [], routing: { cables: [], ports: [], findings: [] }, assembly: { steps: [], constraints: [], findings: [] },
    power, price: derivePrice([], catalog), noise: { totalDba: null, evidence: "unknown", parts: {}, unknown: ["方案尚未完整"] }, physical, calibration,
  };
}

export function evaluateBuild(
  config: BuildConfig,
  catalog: SkuCatalog,
  env?: ThermalEnv,
  runtimeInput: CaseRuntimeAdapterRegistry | CaseEvaluationRuntimeInput = DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY,
): BuildEvaluation {
  const runtime: CaseEvaluationRuntimeInput = runtimeInput instanceof CaseRuntimeAdapterRegistry
    ? { registry: runtimeInput, legacySkuFallback: true }
    : runtimeInput;
  const registry = runtime.registry ?? DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY;
  if (runtime.caseIdentity && runtime.caseIdentity.skuId !== config.caseId) throw new TypeError("case runtime identity does not match selected case SKU");
  const adapter = runtime.caseIdentity
    ? registry.resolveExact(runtime.caseIdentity)
    : runtime.legacySkuFallback === true ? registry.resolveLegacySku(config.caseId) : null;
  if (runtime.instanceOverrides && runtime.instanceOverridesByInstanceId) {
    throw new TypeError("case runtime accepts either one instance override or an instance override map, not both");
  }
  if (runtime.instanceOverridesByInstanceId && !runtime.caseInstanceId) {
    throw new TypeError("case runtime instance override map requires an exact caseInstanceId");
  }
  for (const [instanceId, entry] of Object.entries(runtime.instanceOverridesByInstanceId ?? {})) {
    if (entry.instanceId !== instanceId) throw new TypeError("case runtime instance override map key mismatch");
  }
  const instanceOverrides = runtime.caseInstanceId
    ? runtime.instanceOverridesByInstanceId?.[runtime.caseInstanceId] ?? runtime.instanceOverrides
    : runtime.instanceOverrides;
  if (instanceOverrides) {
    const errors = validateCaseInstanceOverrides(instanceOverrides);
    if (errors.length) throw new TypeError(`case instance overrides invalid: ${errors.join("; ")}`);
    if (!adapter || instanceOverrides.planId !== config.id
      || !runtime.caseInstanceId
      || instanceOverrides.instanceId !== runtime.caseInstanceId
      || instanceOverrides.baseManifestHash !== adapter.identity.manifestHash
      || !adapter.identity.projectionHash
      || instanceOverrides.baseProjectionHash !== adapter.identity.projectionHash) {
      throw new TypeError("case instance overrides do not match the exact plan/manifest/projection runtime");
    }
  }
  const spatialHash = instanceOverrides?.spatialHash ?? null;
  const baseReadiness = buildReadiness(config, catalog, adapter?.capabilities ?? null);
  const missing = [...baseReadiness.missing];
  const readiness: BuildReadiness = { status: missing.length ? "incomplete" : "ready", missing };
  if (readiness.status === "incomplete") return incompleteEvaluation(config, catalog, readiness, adapter, spatialHash);
  // A ready evaluation can only exist with the exact selected runtime adapter.
  if (!adapter) return incompleteEvaluation(config, catalog, { status: "incomplete", missing: ["case.adapter"] });
  const fans = adapter.configuredFanGroups(config, catalog);
  const resolvedEnv = env ? { ...env, fanMode: config.selection.fanMode ?? "balanced", fans } : undefined;
  const power = resolvedEnv?.power ?? derivePower(config, catalog, { ...(resolvedEnv ?? {}), fans }, registry, adapter.identity);
  const thermalEnv = resolvedEnv ? { ...resolvedEnv, power, loads: resolvedEnv.loads ?? power.loads } : undefined;
  const geometryInput = geometryEnvFrom(resolvedEnv ?? { fans });
  if (instanceOverrides) geometryInput.instanceOverrides = instanceOverrides;
  const geomEnv = adapter.geometryEnvironment(geometryInput);
  const geometry = adapter.buildGeometry(config, catalog, geomEnv);
  const occupancyModel = adapter.buildOccupancy(config, catalog, geomEnv);
  const legacyReplayOnly = adapter.authorityStatus === "legacy_unverified";
  const replayAuthorityFinding: EngineFinding[] = legacyReplayOnly ? [{
    id: "case-runtime.authority:legacy-unverified",
    verdict: "warn",
    evidence: "unknown",
    message: "当前机箱运行时模型仅用于旧版确定性重放；它没有逐字段事实/推导绑定，因此可展示几何、接线与装配结果，但不能据此给出安全通过结论。",
    related: [config.caseId, adapter.adapterId],
  }] : [];
  const extra: EngineFinding[] = [
    ...replayAuthorityFinding,
    ...adapter.domainFindings(config, catalog),
    ...memoryCoolerFindings(config, catalog, adapter),
    ...psuLengthFindings(config, catalog, adapter),
    ...gpuHbaFindings(config, catalog, adapter),
    ...validateConfig(config, catalog, { caseCapabilities: adapter.capabilities })
      .filter((issue) => issue.verdict === "bad" && issue.path.startsWith("selection.fan"))
      .map((issue, index): EngineFinding => ({ id: `fan.config:${index}:${issue.path}`, verdict: "bad", evidence: "official", message: issue.message, related: [config.caseId, issue.path] })),
  ];

  const occupancy = evaluateOccupancy(occupancyModel, extra);
  const plannedWiring = adapter.planWiring(config, catalog);
  const wiring: WiringPlan = legacyReplayOnly && plannedWiring.backplaneHarness.verdict === "ok"
    ? {
      ...plannedWiring,
      backplaneHarness: {
        ...plannedWiring.backplaneHarness,
        verdict: "unknown",
        evidence: "unknown",
        notes: [...plannedWiring.backplaneHarness.notes, "legacy_unverified runtime 不能单独支撑电气安全通过。"],
      },
    }
    : plannedWiring;
  const bom = adapter.deriveBom(config, catalog);
  const unresolvedFanRequirements = deriveFanProcurementRequirements(config, catalog, adapter);
  const fanProcurementFindings: EngineFinding[] = unresolvedFanRequirements.map((requirement) => ({
    id: `procurement.unresolved:${requirement.id}`,
    verdict: "warn",
    evidence: "unknown",
    message: `${requirement.mountLabel}已配置 ${requirement.qty} 个 ${requirement.sizeMm}mm 风扇，但这只是安装需求；具体风扇 SKU、单价、噪音与具体产品的实际风量尚未审核，不能视为预算或采购已完成。`,
  }));

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

  const psuInLowerChamber = adapter.psuInLowerChamber(config);
  const bottomPsuFindings: EngineFinding[] = [];
  const lowerPolicy = adapter.lowerChamberPolicy;
  if (psuInLowerChamber && lowerPolicy) {
    bottomPsuFindings.push({
      id: "psu.bottom-removes-left-fan-bracket",
      verdict: "warn",
      evidence: "official",
      message: lowerPolicy.effectDescription,
      related: [config.selection.psuId, config.caseId],
    });
  }

  const diskForThermalId = config.selection.diskSkuId ?? adapter.defaults.diskSkuId;
  const diskForThermal = catalog.skus.find((sku) => sku.id === diskForThermalId);
  const diskWattsForThermal = thermalEnv?.workload === "idle" ? diskForThermal?.power.idleW : diskForThermal?.power.maxOperatingW;
  const lowerPsuId = config.selection.psuTopology === "dual"
    ? config.selection.secondaryPsuId
    : config.selection.psuId;
  const psuForThermal = catalog.skus.find((sku) => sku.id === lowerPsuId);
  const efficiencyForThermal = Number(psuForThermal?.attrs?.["cybeneticsEfficiency"] ?? psuForThermal?.attrs?.["planningEfficiency"]);
  const thermalInputsKnown = Boolean(
    thermalEnv &&
      power.upperDcW !== null &&
      power.lowerDcW !== null &&
      typeof diskWattsForThermal === "number" &&
      Number.isFinite(efficiencyForThermal) &&
      efficiencyForThermal > 0,
  );
  const thermalDomainReady = adapter.domains.thermal.status === "ready" && adapter.thermalDeckY !== undefined;
  const computedThermal = thermalInputsKnown && thermalDomainReady ? runThermal(config, catalog, thermalEnv!, psuInLowerChamber, adapter) : undefined;
  const thermal = computedThermal && legacyReplayOnly ? {
    ...computedThermal,
    evidence: "unknown" as const,
    assumptions: computedThermal.assumptions.map((assumption) => ({ ...assumption, evidence: "unknown" as const })),
    notes: [...computedThermal.notes, "legacy_unverified runtime 的热模型仅供重放，不能支撑安全通过。"],
  } : computedThermal;
  const thermalFindings: EngineFinding[] = [];
  if (thermalEnv && !thermalInputsKnown) {
    thermalFindings.push({
      id: "thermal.input-unknown",
      verdict: "warn",
      evidence: "unknown",
      message: "温度模型缺少盘功耗或 PSU 效率事实；温度与废热保持 unknown，不使用默认数值填充。",
      related: [diskForThermalId ?? config.caseId, config.selection.psuId],
    });
  }
  if (thermalEnv && !thermalDomainReady) {
    thermalFindings.push({
      id: "case-runtime.blocked:thermal",
      verdict: "warn",
      evidence: "unknown",
      message: `当前机箱 thermal 域被 adapter 阻断：${adapter.domains.thermal.reasonCodes.join(", ")}`,
      related: [config.caseId, adapter.adapterId],
    });
  }
  if (thermal && thermalEnv) {
    const unavailableMountId = lowerPolicy?.fanMountId;
    const requestedUnavailableFans = config.selection.fanGroups?.find((group) => group.mountId === unavailableMountId)?.count ?? 0;
    if (psuInLowerChamber && unavailableMountId && requestedUnavailableFans > 0) {
      thermalFindings.push({
        id: "thermal.left-fan-mount-conflict",
        verdict: "bad",
        evidence: "official",
        message: `配置里请求安装 ${unavailableMountId} 风扇位 ${requestedUnavailableFans} 个风扇，但当前电源拓扑使该安装位不可用，评估未计入该风量。`,
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
  const routing = adapter.buildRouting(geometry, wiring, catalog);
  // Order comes last: it is a statement about the geometry and the cables, and
  // it cannot be derived before both of them exist.
  const assembly = adapter.buildAssembly(geometry, routing.cables);
  const physical = adapter.evaluatePhysical(config, catalog, geometry, routing, wiring);
  const calibration = adapter.evaluateCalibration(config);

  const findings = [
    ...occupancy.findings,
    harnessFinding,
    spinUpFinding,
    ...bottomPsuFindings,
    ...thermalFindings,
    ...routing.findings,
    ...assembly.findings,
    ...physical.findings,
    ...fanProcurementFindings,
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
  ].map((finding): EngineFinding => legacyReplayOnly && finding.verdict === "ok"
    ? {
      ...finding,
      verdict: "warn",
      evidence: "unknown",
      message: `${finding.message}（legacy_unverified runtime：该通过项降级为待确认。）`,
    }
    : finding);

  return {
    config,
    caseRuntime: caseRuntimeResolution(adapter, config.caseId, spatialHash),
    readiness,
    occupancy,
    wiring,
    findings: dedupeFindings(findings),
    bom,
    // Conflict markers ride along with the geometry so the preview can only ever
    // draw the volume the engine actually objected to.
    geometry: [...geometry, ...adapter.conflictMarkerParts(geometry, occupancy.conflicts)],
    routing,
    assembly,
    power,
    price: derivePrice(bom, catalog, unresolvedFanRequirements),
    noise: deriveNoise(config, catalog),
    physical,
    calibration,
    ...(thermal
      ? { thermal, heatField: buildFieldBounds(geometry, thermal, adapter.thermalDeckY!) }
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
