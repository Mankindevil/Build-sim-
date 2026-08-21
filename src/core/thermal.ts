import type { EvidenceLevel } from "./evidence";
import n6Profile from "../../data/cases/jonsbo-n6/profile.json";

/**
 * Lumped-parameter (0D) thermal accounting for the N6.
 *
 * The only exact physics here is the sensible-heat balance of the air stream:
 * every watt dumped into a chamber must leave as `ṁ · cp · ΔT`. That part is
 * arithmetic, not guesswork. Everything upstream of it — how much air a fan
 * actually moves through a drive-dense chassis, and how far a drive's case sits
 * above the air around it — is a planning envelope, so results are reported as
 * ranges with the assumptions attached. This is not CFD and cannot give local
 * velocities, pressure drops, or hot spots.
 */

/** Dry air at 25 °C, 101.325 kPa. */
export const AIR_DENSITY_KG_M3 = 1.184;
export const AIR_CP_J_PER_KGK = 1005;
export const M3_S_PER_CFM = 4.719474e-4;
/** Sensible-heat capacity of one CFM of air: ρ·cp·V̇ ≈ 0.5615 W/K. */
export const W_PER_K_PER_CFM = AIR_DENSITY_KG_M3 * AIR_CP_J_PER_KGK * M3_S_PER_CFM;

export interface Range {
  lo: number;
  hi: number;
}

export type FanMode = "quiet" | "balanced" | "performance";
export type FanSize = 120 | 140;

/**
 * Free-air CFM envelopes for a generic PWM case fan at the RPM band each mode
 * implies. Deliberately wide: no fan SKU is locked, and vendor free-air ratings
 * are measured with zero back-pressure.
 */
const FAN_FREE_AIR_CFM: Record<FanSize, Record<FanMode, Range>> = {
  120: { quiet: { lo: 18, hi: 30 }, balanced: { lo: 30, hi: 44 }, performance: { lo: 44, hi: 62 } },
  140: { quiet: { lo: 24, hi: 38 }, balanced: { lo: 38, hi: 55 }, performance: { lo: 55, hi: 78 } },
};

/**
 * Fraction of free-air CFM that survives filters, the drive backplane and the
 * tray stack. Drive-dense chassis are high-impedance; the low end assumes the
 * backplane and nine trays are the dominant restriction.
 */
const SYSTEM_DERATE: Range = { lo: 0.35, hi: 0.65 };

/** Buoyancy-driven leakage when no fan serves a chamber. Wide by construction. */
const PASSIVE_CFM: Range = { lo: 2, hi: 6 };

/** Drive case-to-local-air resistance. No vendor θ is published for 3.5″ HDDs. */
const HDD_THETA_K_PER_W: Range = { lo: 0.8, hi: 1.9 };

export interface ThermalAssumption {
  id: string;
  label: string;
  value: string;
  evidence: EvidenceLevel;
  note: string;
}

export interface FanGroupInput {
  size: FanSize;
  count: number;
}

export interface ThermalInput {
  ambientC: number;
  fanMode: FanMode;
  /** Fan groups actually installed, per mount position. */
  fans: {
    front?: FanGroupInput | null;
    rear?: FanGroupInput | null;
    /** Left side pair — unavailable once the bottom PSU rack takes the bracket. */
    left?: FanGroupInput | null;
    right?: FanGroupInput | null;
  };
  diskCount: number;
  /** Per-drive dissipation at the modelled workload. */
  diskWattsEach: number;
  diskEvidence: EvidenceLevel;
  /** Everything dissipated in the board chamber (CPU + board + HBA + GPU). */
  upperWatts: number;
  /** True when an SFX unit sits in the lower chamber (bottom or dual topology). */
  psuInLowerChamber: boolean;
  /** DC load carried by that lower-chamber PSU. */
  psuDcWatts: number;
  /** 0–1. Efficiency of the lower-chamber PSU. */
  psuEfficiency: number;
  psuEfficiencyEvidence: EvidenceLevel;
}

export interface ChamberResult {
  id: "lower" | "upper";
  label: string;
  /** Heat dumped into the chamber; a range when the PSU coupling is uncertain. */
  loadW: Range;
  cfm: Range;
  /** Air temperature rise from inlet to outlet. */
  riseK: Range;
  outletC: Range;
  fanned: boolean;
}

export interface ThermalResult {
  ambientC: number;
  chambers: { lower: ChamberResult; upper: ChamberResult };
  /** Drive case temperature: inlet-side best case to outlet-side worst case. */
  hddC: Range;
  /** Air the lower PSU has to breathe, when it sits down there. */
  psuInletC: Range | null;
  coupling: {
    active: boolean;
    psuWasteW: number;
    /** Share of the lower chamber's heat that is the PSU's own loss. */
    shareOfLowerLoad: number;
    /** Extra drive-air rise caused by that waste heat, worst case. */
    extraRiseK: number;
  };
  assumptions: ThermalAssumption[];
  evidence: EvidenceLevel;
  notes: string[];
}

/** ΔT of an air stream absorbing `watts` at `cfm`. Exact given both inputs. */
export function airRiseK(watts: number, cfm: number): number {
  if (cfm <= 0) return Number.POSITIVE_INFINITY;
  return watts / (W_PER_K_PER_CFM * cfm);
}

function groupCfm(group: FanGroupInput | null | undefined, mode: FanMode): Range {
  if (!group || group.count <= 0) return { lo: 0, hi: 0 };
  const free = FAN_FREE_AIR_CFM[group.size][mode];
  return {
    lo: free.lo * group.count * SYSTEM_DERATE.lo,
    hi: free.hi * group.count * SYSTEM_DERATE.hi,
  };
}

function sumCfm(groups: Range[]): Range {
  return groups.reduce((acc, r) => ({ lo: acc.lo + r.lo, hi: acc.hi + r.hi }), { lo: 0, hi: 0 });
}

/** Weakest evidence wins — a chain is only as strong as its softest input. */
function weakest(levels: EvidenceLevel[]): EvidenceLevel {
  const order: EvidenceLevel[] = ["official", "standard", "inferred", "unknown"];
  return levels.reduce(
    (worst, l) => (order.indexOf(l) > order.indexOf(worst) ? l : worst),
    "official" as EvidenceLevel,
  );
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

export function computeThermal(input: ThermalInput): ThermalResult {
  const { ambientC, fanMode } = input;

  const lowerFans = groupCfm(input.fans.left, fanMode);
  const lowerFanned = lowerFans.hi > 0;
  const lowerCfm = lowerFanned ? lowerFans : PASSIVE_CFM;

  const upperFans = sumCfm([
    groupCfm(input.fans.front, fanMode),
    groupCfm(input.fans.rear, fanMode),
    groupCfm(input.fans.right, fanMode),
  ]);
  const upperFanned = upperFans.hi > 0;
  const upperCfm = upperFanned ? upperFans : PASSIVE_CFM;

  const driveW = input.diskCount * input.diskWattsEach;
  const eta = Math.min(0.98, Math.max(0.5, input.psuEfficiency));
  const psuWasteW =
    input.psuInLowerChamber && input.psuDcWatts > 0 ? input.psuDcWatts * (1 / eta - 1) : 0;

  // The manual never states which way the bottom PSU's 92mm fan blows, so the
  // chamber load spans "exhausts straight out" to "dumps everything inside".
  const lowerLoad: Range = { lo: driveW, hi: driveW + psuWasteW };
  const lowerRise: Range = {
    lo: airRiseK(lowerLoad.lo, lowerCfm.hi),
    hi: airRiseK(lowerLoad.hi, lowerCfm.lo),
  };
  const upperRise: Range = {
    lo: airRiseK(input.upperWatts, upperCfm.hi),
    hi: airRiseK(input.upperWatts, upperCfm.lo),
  };

  const hddC: Range = {
    lo: ambientC + 0.5 * lowerRise.lo + HDD_THETA_K_PER_W.lo * input.diskWattsEach,
    hi: ambientC + lowerRise.hi + HDD_THETA_K_PER_W.hi * input.diskWattsEach,
  };

  const extraRiseK = psuWasteW > 0 ? lowerRise.hi - airRiseK(driveW, lowerCfm.lo) : 0;

  const notes: string[] = [
    `下层热负荷 ${round1(lowerLoad.lo)}–${round1(lowerLoad.hi)}W，估算风量 ${round1(lowerCfm.lo)}–${round1(lowerCfm.hi)} CFM，出风温升 ${round1(lowerRise.lo)}–${round1(lowerRise.hi)}K。`,
  ];
  if (!lowerFanned) {
    notes.push(
      "左侧盘区风扇位没有风扇，下层只按浮升泄漏风量估算（2–6 CFM），这个区间本身就极不确定。",
    );
  }
  if (psuWasteW > 0) {
    notes.push(
      `下置电源废热 ${round1(psuWasteW)}W，占下层热负荷 ${Math.round((psuWasteW / (driveW + psuWasteW)) * 100)}%；若它把废热排进盘区，出风再升约 ${round1(extraRiseK)}K，同时它自己要吸 ${round1(ambientC + 0.5 * lowerRise.lo)}–${round1(ambientC + lowerRise.hi)}°C 的预热空气。`,
    );
    notes.push("手册没有给下置位的风向，因此上面给的是「完全排到机外」到「全部排进盘区」两端。");
  }

  const assumptions: ThermalAssumption[] = [
    {
      id: "air-props",
      label: "空气热容",
      value: `ρ·cp = ${Math.round(AIR_DENSITY_KG_M3 * AIR_CP_J_PER_KGK)} J/(m³·K) → ${W_PER_K_PER_CFM.toFixed(3)} W/(K·CFM)`,
      evidence: "standard",
      note: "25°C、101.325kPa 干空气物性；ΔT = Q /(ρ·cp·V̇) 是能量守恒，不是拟合。",
    },
    {
      id: "fan-cfm",
      label: "风扇自由风量",
      value: `${fanMode} 模式：120mm ${FAN_FREE_AIR_CFM[120][fanMode].lo}–${FAN_FREE_AIR_CFM[120][fanMode].hi} CFM / 140mm ${FAN_FREE_AIR_CFM[140][fanMode].lo}–${FAN_FREE_AIR_CFM[140][fanMode].hi} CFM`,
      evidence: "inferred",
      note: "通用 PWM 风扇在该转速带的规划区间；未锁定具体风扇 SKU，也不是厂商曲线。",
    },
    {
      id: "system-derate",
      label: "系统阻抗折减",
      value: `×${SYSTEM_DERATE.lo}–${SYSTEM_DERATE.hi}`,
      evidence: "inferred",
      note: "防尘网、背板 PCB 与九托架叠加后的通风折减；N6 未公布 P-Q 曲线，无法反算。",
    },
    {
      id: "hdd-theta",
      label: "硬盘壳-气热阻",
      value: `${HDD_THETA_K_PER_W.lo}–${HDD_THETA_K_PER_W.hi} K/W`,
      evidence: "inferred",
      note: "Seagate 只给工作温度范围，不给 θ；此区间为规划包络，装机后可用 SMART 温度反算收窄。",
    },
    {
      id: "psu-airflow-direction",
      label: "下置电源风向",
      value: input.psuInLowerChamber ? "未知（按两端取包络）" : "不适用",
      evidence: input.psuInLowerChamber ? "unknown" : "standard",
      note: "手册 §8 只画机械安装，没有画进/出风方向；实机可用一张纸或烟线判断后收窄。",
    },
  ];

  return {
    ambientC,
    chambers: {
      lower: {
        id: "lower",
        label: "下层盘仓",
        loadW: lowerLoad,
        cfm: lowerCfm,
        riseK: lowerRise,
        outletC: { lo: ambientC + lowerRise.lo, hi: ambientC + lowerRise.hi },
        fanned: lowerFanned,
      },
      upper: {
        id: "upper",
        label: "上层主机舱",
        loadW: { lo: input.upperWatts, hi: input.upperWatts },
        cfm: upperCfm,
        riseK: upperRise,
        outletC: { lo: ambientC + upperRise.lo, hi: ambientC + upperRise.hi },
        fanned: upperFanned,
      },
    },
    hddC,
    psuInletC: input.psuInLowerChamber
      ? { lo: ambientC + 0.5 * lowerRise.lo, hi: ambientC + lowerRise.hi }
      : null,
    coupling: {
      active: psuWasteW > 0,
      psuWasteW,
      shareOfLowerLoad: psuWasteW > 0 ? psuWasteW / (driveW + psuWasteW) : 0,
      extraRiseK,
    },
    assumptions,
    evidence: weakest([
      input.diskEvidence,
      input.psuEfficiencyEvidence,
      "inferred",
      input.psuInLowerChamber ? "unknown" : "standard",
    ]),
    notes,
  };
}

/** Left-side 2×120 mounts are lost to the bottom PSU rack (manual §8.1 + §14). */
export function leftFanMountAvailable(psuInLowerChamber: boolean): boolean {
  return !(psuInLowerChamber && n6Profile.bottomPsu.removesLeftFanBracket);
}
