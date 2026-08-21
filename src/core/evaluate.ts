import type { BuildConfig, BuildLineItem } from "../config/types";
import type { SkuCatalog } from "../sku/types";
import { requireSku } from "../sku/catalog";
import { evaluateOccupancy, type EngineFinding, type EngineResult } from "./engine";
import {
  buildN6Occupancy,
  n6DomainFindings,
} from "../adapters/jonsbo-n6/occupancy";
import { planN6Wiring } from "../wiring/plan";
import type { WiringPlan } from "../wiring/types";
import { needsHba } from "./policy";
import {
  computeThermal,
  leftFanMountAvailable,
  type FanGroupInput,
  type FanMode,
  type ThermalResult,
} from "./thermal";
import n6Profile from "../../data/cases/jonsbo-n6/profile.json";

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
  workload?: "idle" | "work";
}

export interface BuildEvaluation {
  config: BuildConfig;
  occupancy: EngineResult;
  wiring: WiringPlan;
  findings: EngineFinding[];
  bom: BuildLineItem[];
  /** Present only when the caller supplies airflow inputs. */
  thermal?: ThermalResult;
}

function isSfx(psuId: string, catalog: SkuCatalog): boolean {
  try {
    return requireSku(catalog, psuId).attrs?.form === "SFX";
  } catch {
    return false;
  }
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

  const hbaNeeded = needsHba(config.selection, n6Profile.hba);
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
  const slots = gpu.dims.slots ?? 0;
  const hbaNeeded = needsHba(config.selection, n6Profile.hba);

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

  if (hbaNeeded && slots >= 2.5) {
    findings.push({
      id: "gpu.hba-slot-intrusion",
      verdict: "warn",
      evidence: "inferred",
      message: `${gpu.name} (~${slots} slots) likely intrudes into the chipset x4 envelope used by HBA`,
      related: [gpu.id, "pcie.slot2"],
    });
  }

  const len = gpu.dims.lengthMm ?? 0;
  if (len > n6Profile.gpuLimits.planningMinMm) {
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
    ambientC: env.ambientC,
    fanMode: env.fanMode,
    // A left-side fan cannot draw air through a bracket that is no longer there.
    fans: leftFanMountAvailable(psuInLowerChamber) ? env.fans : { ...env.fans, left: null },
    diskCount: config.selection.diskCount,
    diskWattsEach: diskW ?? 7,
    diskEvidence: diskW === undefined ? "inferred" : (disk?.power?.evidence ?? "inferred"),
    upperWatts: env.upperWatts,
    psuInLowerChamber,
    psuDcWatts: env.psuDcWatts,
    psuEfficiency: Number.isFinite(eff) && eff > 0 ? eff : 0.9,
    psuEfficiencyEvidence:
      (psu?.attrs?.["efficiencyEvidence"] as ThermalResult["evidence"] | undefined) ?? "inferred",
  });
}

export function evaluateBuild(
  config: BuildConfig,
  catalog: SkuCatalog,
  env?: ThermalEnv,
): BuildEvaluation {
  const occupancyModel = buildN6Occupancy(config);
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

  const thermal = env ? runThermal(config, catalog, env, psuInLowerChamber) : undefined;
  const thermalFindings: EngineFinding[] = [];
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

  const findings = [
    ...occupancy.findings,
    harnessFinding,
    spinUpFinding,
    ...bottomPsuFindings,
    ...thermalFindings,
    ...wiring.warnings.map(
      (w, i): EngineFinding => ({
        id: `wiring.warn.${i}`,
        verdict: "warn",
        evidence: "inferred",
        message: w,
      }),
    ),
  ];

  return {
    config,
    occupancy,
    wiring,
    findings: dedupeFindings(findings),
    bom,
    ...(thermal ? { thermal } : {}),
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
