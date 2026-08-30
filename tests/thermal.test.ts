import { describe, expect, it } from "vitest";
import {
  airRiseK,
  computeThermal,
  W_PER_K_PER_CFM,
  type ThermalInput,
} from "../src/core/thermal";
import { evaluateBuild, type ThermalEnv } from "../src/core/evaluate";
import { loadRawCatalog } from "../src/sku/catalog";
import type { BuildConfig, PsuTopology } from "../src/config/types";
import { N6_CASE_RUNTIME_ADAPTER } from "../src/adapters/jonsbo-n6/assembly";

const catalog = loadRawCatalog();

function input(over: Partial<ThermalInput> = {}): ThermalInput {
  return {
    profile: N6_CASE_RUNTIME_ADAPTER.thermalProfile!,
    ambientC: 25,
    fanMode: "balanced",
    fans: { front: { size: 140, count: 2 }, rear: { size: 120, count: 1 }, left: { size: 120, count: 2 } },
    diskCount: 9,
    diskWattsEach: 6.3,
    diskEvidence: "official",
    upperWatts: 90,
    psuInLowerChamber: false,
    psuDcWatts: 0,
    psuEfficiency: 0.92,
    psuEfficiencyEvidence: "inferred",
    ...over,
  };
}

function config(over: Partial<BuildConfig["selection"]> & { psuTopology?: PsuTopology } = {}): BuildConfig {
  return {
    schemaVersion: "2.0.0",
    id: "t",
    name: "t",
    updatedAt: "2026-08-21",
    caseId: "case.jonsbo-n6",
    boardId: "board.asus-w680m-ace-se",
    cpuId: "cpu.i5-14500",
    selection: {
      psuId: "psu.corsair-sf750-atx31",
      psuTopology: "bottom",
      coolerId: "cooler.thermalright-axp90-x53-full",
      gpuId: "gpu.none",
      memoryId: "memory.kingston-kf564c32rsk2-32",
      diskSkuId: "storage.seagate-exos-x24-24tb",
      diskCount: 9,
      boot: "m2",
      hbaMode: "auto",
      ...over,
    },
    bom: [],
  };
}

const env = (over: Partial<ThermalEnv> = {}): ThermalEnv => ({
  ambientC: 25,
  fanMode: "balanced",
  fans: { front: { size: 140, count: 2 }, rear: { size: 120, count: 1 } },
  upperWatts: 90,
  psuDcWatts: 150,
  workload: "idle",
  ...over,
});

describe("air-side energy balance", () => {
  it("uses dry-air properties at 25°C for the heat capacity of one CFM", () => {
    expect(W_PER_K_PER_CFM).toBeCloseTo(0.5615, 3);
  });

  it("is exact arithmetic: ΔT = Q / (ρ·cp·V̇)", () => {
    // 100W into 20 CFM: 100 / (0.5615 × 20) ≈ 8.9K
    expect(airRiseK(100, 20)).toBeCloseTo(8.9, 1);
    // Double the air, halve the rise.
    expect(airRiseK(100, 40)).toBeCloseTo(airRiseK(100, 20) / 2, 6);
    // Double the heat, double the rise.
    expect(airRiseK(200, 20)).toBeCloseTo(airRiseK(100, 20) * 2, 6);
  });

  it("returns an infinite rise rather than a number when there is no air at all", () => {
    expect(airRiseK(50, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("lower chamber", () => {
  it("carries the drive load and reports a bounded rise", () => {
    const r = computeThermal(input());
    expect(r.chambers.lower.loadW.lo).toBeCloseTo(56.7, 6);
    expect(r.chambers.lower.loadW.hi).toBeCloseTo(56.7, 6);
    expect(r.chambers.lower.fanned).toBe(true);
    expect(r.chambers.lower.riseK.lo).toBeLessThan(r.chambers.lower.riseK.hi);
    // Two derated 120mm fans at balanced: ~21–57 CFM.
    expect(r.chambers.lower.cfm.lo).toBeCloseTo(21, 0);
    expect(r.chambers.lower.cfm.hi).toBeCloseTo(57.2, 0);
  });

  it("falls back to a wide buoyancy envelope with no drive-area fan, not to zero", () => {
    const r = computeThermal(input({ fans: { front: { size: 140, count: 2 } } }));
    expect(r.chambers.lower.fanned).toBe(false);
    expect(r.chambers.lower.cfm).toEqual({ lo: 2, hi: 6 });
    expect(r.chambers.lower.riseK.hi).toBeGreaterThan(40);
    expect(r.notes.join()).toContain("浮升泄漏");
  });

  it("scales the drive load with workload, not with a fudge factor", () => {
    const idle = computeThermal(input({ diskWattsEach: 6.3 }));
    const busy = computeThermal(input({ diskWattsEach: 8.9 }));
    expect(busy.chambers.lower.riseK.hi / idle.chambers.lower.riseK.hi).toBeCloseTo(8.9 / 6.3, 3);
  });

  it("puts the drive case above local air by an explicit, labelled θ", () => {
    const r = computeThermal(input());
    expect(r.hddC.lo).toBeGreaterThan(25);
    expect(r.hddC.hi).toBeGreaterThan(r.hddC.lo);
    expect(r.assumptions.find((a) => a.id === "hdd-theta")?.evidence).toBe("inferred");
  });
});

describe("bottom PSU coupling", () => {
  const coupled = computeThermal(
    input({ psuInLowerChamber: true, psuDcWatts: 150, fans: { front: { size: 140, count: 2 } } }),
  );

  it("derives waste heat from efficiency instead of a fixed constant", () => {
    // 150W DC at 92% → 13.0W of loss.
    expect(coupled.coupling.psuWasteW).toBeCloseTo(150 * (1 / 0.92 - 1), 3);
  });

  it("spans exhaust-out to exhaust-in, because the manual never states the direction", () => {
    expect(coupled.chambers.lower.loadW.lo).toBeCloseTo(56.7, 1);
    expect(coupled.chambers.lower.loadW.hi).toBeCloseTo(56.7 + coupled.coupling.psuWasteW, 1);
    expect(coupled.coupling.extraRiseK).toBeGreaterThan(0);
    expect(coupled.assumptions.find((a) => a.id === "psu-airflow-direction")?.evidence).toBe(
      "unknown",
    );
  });

  it("reports the air the PSU itself has to breathe", () => {
    expect(coupled.psuInletC?.hi).toBeGreaterThan(25);
    expect(computeThermal(input()).psuInletC).toBeNull();
  });

  it("keeps the whole result no stronger than its weakest input", () => {
    expect(coupled.evidence).toBe("unknown");
  });
});

describe("left fan bracket", () => {
  it("is unavailable once the bottom PSU rack takes it (manual §8.1 + §14)", () => {
    const fans = { left: { size: 120 as const, count: 2 } };
    expect(N6_CASE_RUNTIME_ADAPTER.thermalFans(config({ psuTopology: "auto" }), fans).left).toEqual(fans.left);
    expect(N6_CASE_RUNTIME_ADAPTER.thermalFans(config({ psuTopology: "bottom" }), fans).left).toBeNull();
  });

  it("drops left-side fans from the balance instead of silently crediting them", () => {
    const fanGroups = [{ mountId: "left", sizeMm: 120 as const, count: 2 }];
    const withLeft = evaluateBuild(config({ psuTopology: "auto", fanGroups }), catalog, env());
    const bottom = evaluateBuild(config({ psuTopology: "bottom", fanGroups }), catalog, env());
    expect(withLeft.thermal?.chambers.lower.fanned).toBe(true);
    expect(bottom.thermal?.chambers.lower.fanned).toBe(false);
    expect(bottom.findings.find((f) => f.id === "thermal.left-fan-mount-conflict")?.verdict).toBe(
      "bad",
    );
  });

  it("cites the manual's own fan counts when warning about the bracket", () => {
    const { findings } = evaluateBuild(config({ psuTopology: "bottom" }), catalog);
    const f = findings.find((x) => x.id === "psu.bottom-removes-left-fan-bracket");
    expect(f?.evidence).toBe("official");
    expect(f?.message).toContain("只剩右侧 2 个");
  });
});

describe("engine integration", () => {
  it("stays silent about temperatures when no airflow input is supplied", () => {
    const r = evaluateBuild(config(), catalog);
    expect(r.thermal).toBeUndefined();
    expect(r.findings.some((f) => f.id.startsWith("thermal."))).toBe(false);
  });

  it("takes per-drive watts from the datasheet, switching on workload", () => {
    const idle = evaluateBuild(config(), catalog, env({ workload: "idle" }));
    const busy = evaluateBuild(config(), catalog, env({ workload: "work" }));
    expect(idle.thermal?.chambers.lower.loadW.lo).toBeCloseTo(9 * 6.3, 1);
    expect(busy.thermal?.chambers.lower.loadW.lo).toBeCloseTo(9 * 8.9, 1);
  });

  it("reports the coupling as a finding with a share and an extra rise", () => {
    const { findings } = evaluateBuild(config({ psuTopology: "bottom" }), catalog, env());
    const f = findings.find((x) => x.id === "thermal.bottom-psu-coupling");
    expect(f?.evidence).toBe("unknown");
    expect(f?.message).toMatch(/占下层负荷 \d+%/);
  });
});
