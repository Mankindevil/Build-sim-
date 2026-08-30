import type { EvidenceLevel } from "./evidence";
import type { ThermalProfile } from "./capabilities";

/**
 * Lumped-parameter (0D) thermal accounting for a case runtime profile.
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
/** Drive case-to-local-air resistance. No vendor θ is published for 3.5″ HDDs. */
const HDD_THETA_K_PER_W: Range = { lo: 0.8, hi: 1.9 };

/**
 * Case-to-local-air resistance envelopes for the parts no vendor publishes a θ
 * for. Every one of these is a planning band, not a datasheet number, and each
 * gets its own line in `assumptions` so it can be argued with. The lower bound
 * of a band is "directed airflow, clean heatsink"; the upper is "still air in a
 * drive-dense box".
 */
export const PLANNING_THETA: Record<string, { theta: Range; note: string }> = {
  "hba-passive": {
    theta: { lo: 1.6, hi: 3.0 },
    note: "被动散热 HBA 无厂商 θ；上界按无定向气流、下界按有侧吹取包络。",
  },
  "hba-passive-directed": {
    theta: { lo: 0.8, hi: 1.8 },
    note: "被动 HBA 加一组 120mm 定向侧吹后的规划 θ；仍非实测。",
  },
  "gpu-blower": {
    theta: { lo: 0.22, hi: 0.42 },
    note: "工作站涡轮卡自带风道，θ 相对稳定；厂商只给最高工作温度，不给 θ。",
  },
  "gpu-axial": {
    theta: { lo: 0.18, hi: 0.35 },
    note: "消费级轴流卡开放式散热，散热面积大但依赖机箱内空气；θ 为规划包络。",
  },
  psu: {
    theta: { lo: 0.06, hi: 0.2 },
    note: "电源废热主要由自身风扇与外壳带走；θ 按自身废热瓦数计，风扇停转时该 θ 无物理意义。",
  },
};

/**
 * Fraction of its chamber's air temperature rise a part actually breathes:
 * `lo` is inlet-side (fresh air), `hi` is outlet-side (fully preheated). This is
 * the same envelope the existing HDD number already used, named.
 */
const DEFAULT_AIR_FRACTION: Range = { lo: 0.5, hi: 1 };

export type ThermalNodeId = "cpu" | "gpu" | "hba" | "psu" | "hdd";

/** A part the caller wants a temperature for. */
export interface ComponentInput {
  id: ThermalNodeId;
  label: string;
  chamber: "lower" | "upper";
  /** Dissipation attributed to this part at the modelled workload. */
  watts: number;
  thetaKPerW: Range;
  evidence: EvidenceLevel;
  /** Overrides how much of the chamber rise it breathes. */
  airFraction?: Range;
  /** Why this θ band, in one line. Surfaced as an assumption. */
  thetaNote?: string;
}

/**
 * `ambient + f·riseK + θ·W`, evaluated at both ends of every band. Identical in
 * form to the drive temperature this model already produced, so component nodes
 * are a generalisation of existing arithmetic rather than new physics.
 */
export interface ComponentNode {
  id: ThermalNodeId;
  label: string;
  chamber: "lower" | "upper";
  watts: number;
  thetaKPerW: Range;
  tempC: Range;
  evidence: EvidenceLevel;
}

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
  /** Case-issued airflow/air-property profile; core owns no case defaults. */
  profile: ThermalProfile;
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
  /** Fan/controller heat physically located in the drive chamber. */
  lowerAuxWatts?: number;
  /** True when an SFX unit sits in the lower chamber (bottom or dual topology). */
  psuInLowerChamber: boolean;
  /** DC load carried by that lower-chamber PSU. */
  psuDcWatts: number;
  /** 0–1. Efficiency of the lower-chamber PSU. */
  psuEfficiency: number;
  psuEfficiencyEvidence: EvidenceLevel;
  /** Parts to put a temperature on. Drives are added automatically. */
  components?: ComponentInput[];
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
  /** Per-part temperatures. The `hdd` entry is the same number as `hddC`. */
  components: ComponentNode[];
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

function groupCfm(group: FanGroupInput | null | undefined, mode: FanMode, derate: Range): Range {
  if (!group || group.count <= 0) return { lo: 0, hi: 0 };
  const free = FAN_FREE_AIR_CFM[group.size][mode];
  return {
    lo: free.lo * group.count * derate.lo,
    hi: free.hi * group.count * derate.hi,
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
  const profile = input.profile;
  const systemDerate = profile.systemDerate;
  const passiveCfm = profile.passiveCfm;
  const profileWPerKPerCfm = profile.airDensityKgM3 * profile.airCpJPerKgK * M3_S_PER_CFM;
  const profileAirRiseK = (watts: number, cfm: number): number => cfm <= 0
    ? Number.POSITIVE_INFINITY
    : watts / (profileWPerKPerCfm * cfm);

  const lowerFans = groupCfm(input.fans.left, fanMode, systemDerate);
  const lowerFanned = lowerFans.hi > 0;
  const lowerCfm = lowerFanned ? lowerFans : passiveCfm;

  const upperFans = sumCfm([
    groupCfm(input.fans.front, fanMode, systemDerate),
    groupCfm(input.fans.rear, fanMode, systemDerate),
    groupCfm(input.fans.right, fanMode, systemDerate),
  ]);
  const upperFanned = upperFans.hi > 0;
  const upperCfm = upperFanned ? upperFans : passiveCfm;

  const driveW = input.diskCount * input.diskWattsEach;
  const lowerAuxW = input.lowerAuxWatts ?? 0;
  const eta = Math.min(0.98, Math.max(0.5, input.psuEfficiency));
  const psuWasteW =
    input.psuInLowerChamber && input.psuDcWatts > 0 ? input.psuDcWatts * (1 / eta - 1) : 0;

  // The manual never states which way the bottom PSU's 92mm fan blows, so the
  // chamber load spans "exhausts straight out" to "dumps everything inside".
  const lowerBaseW = driveW + lowerAuxW;
  const lowerLoad: Range = { lo: lowerBaseW, hi: lowerBaseW + psuWasteW };
  const lowerRise: Range = {
    lo: profileAirRiseK(lowerLoad.lo, lowerCfm.hi),
    hi: profileAirRiseK(lowerLoad.hi, lowerCfm.lo),
  };
  const upperRise: Range = {
    lo: profileAirRiseK(input.upperWatts, upperCfm.hi),
    hi: profileAirRiseK(input.upperWatts, upperCfm.lo),
  };

  const riseOf = (chamber: "lower" | "upper"): Range =>
    chamber === "lower" ? lowerRise : upperRise;

  const nodeTemp = (input_: ComponentInput): Range => {
    const rise = riseOf(input_.chamber);
    const f = input_.airFraction ?? DEFAULT_AIR_FRACTION;
    return {
      lo: ambientC + f.lo * rise.lo + input_.thetaKPerW.lo * input_.watts,
      hi: ambientC + f.hi * rise.hi + input_.thetaKPerW.hi * input_.watts,
    };
  };

  const hddInput: ComponentInput = {
    id: "hdd",
    label: "硬盘（最热一块）",
    chamber: "lower",
    watts: input.diskWattsEach,
    thetaKPerW: HDD_THETA_K_PER_W,
    evidence: input.diskEvidence,
  };
  const hddC = nodeTemp(hddInput);

  const componentInputs: ComponentInput[] = [
    ...(input.diskCount > 0 ? [hddInput] : []),
    ...(input.components ?? []),
  ];
  const components: ComponentNode[] = componentInputs.map((ci) => ({
    id: ci.id,
    label: ci.label,
    chamber: ci.chamber,
    watts: ci.watts,
    thetaKPerW: ci.thetaKPerW,
    tempC: nodeTemp(ci),
    evidence: ci.evidence,
  }));

  const extraRiseK = psuWasteW > 0 ? lowerRise.hi - profileAirRiseK(lowerBaseW, lowerCfm.lo) : 0;

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
      `下置电源废热 ${round1(psuWasteW)}W，占下层热负荷 ${Math.round((psuWasteW / (lowerBaseW + psuWasteW)) * 100)}%；若它把废热排进盘区，出风再升约 ${round1(extraRiseK)}K，同时它自己要吸 ${round1(ambientC + 0.5 * lowerRise.lo)}–${round1(ambientC + lowerRise.hi)}°C 的预热空气。`,
    );
    notes.push("手册没有给下置位的风向，因此上面给的是「完全排到机外」到「全部排进盘区」两端。");
  }

  const assumptions: ThermalAssumption[] = [
    {
      id: "air-props",
      label: "空气热容",
      value: `ρ·cp = ${Math.round(profile.airDensityKgM3 * profile.airCpJPerKgK)} J/(m³·K) → ${profileWPerKPerCfm.toFixed(3)} W/(K·CFM)`,
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
      value: `×${systemDerate.lo}–${systemDerate.hi}`,
      evidence: profile.evidence,
      note: "机箱 adapter 提供的系统阻抗规划折减；没有闭合 P-Q 曲线时不能反算局部流量。",
    },
    {
      id: "hdd-theta",
      label: "硬盘壳-气热阻",
      value: `${HDD_THETA_K_PER_W.lo}–${HDD_THETA_K_PER_W.hi} K/W`,
      evidence: "inferred",
      note: "Seagate 只给工作温度范围，不给 θ；此区间为规划包络，装机后可用 SMART 温度反算收窄。",
    },
    // One line per part θ, so no component temperature rests on a number that has
    // not been declared as a planning band.
    ...(input.components ?? []).map((ci) => ({
      id: `theta-${ci.id}`,
      label: `${ci.label} 壳-气热阻`,
      value: `${ci.thetaKPerW.lo}–${ci.thetaKPerW.hi} K/W × ${round1(ci.watts)}W`,
      evidence: ci.evidence,
      note: ci.thetaNote ?? "厂商未公布该件 θ；此区间为规划包络。",
    })),
    {
      id: "air-fraction",
      label: "部件所处气流位置",
      value: `按腔体温升的 ${DEFAULT_AIR_FRACTION.lo}–${DEFAULT_AIR_FRACTION.hi} 倍取包络`,
      evidence: "inferred",
      note: "0D 模型没有位置信息：下界当作贴进风口的新鲜空气，上界当作已被完全预热的出风空气。真实位置要靠 CFD 或实测。",
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
    components,
    psuInletC: input.psuInLowerChamber
      ? { lo: ambientC + 0.5 * lowerRise.lo, hi: ambientC + lowerRise.hi }
      : null,
    coupling: {
      active: psuWasteW > 0,
      psuWasteW,
      shareOfLowerLoad: psuWasteW > 0 ? psuWasteW / (lowerBaseW + psuWasteW) : 0,
      extraRiseK,
    },
    assumptions,
    evidence: weakest([
      input.diskEvidence,
      input.psuEfficiencyEvidence,
      "inferred",
      input.psuInLowerChamber ? "unknown" : "standard",
      ...componentInputs.map((ci) => ci.evidence),
    ]),
    notes,
  };
}
