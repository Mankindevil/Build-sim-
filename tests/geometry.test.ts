import { describe, expect, it } from "vitest";
import {
  AXES,
  clearanceGap,
  containsBox,
  toBoxMm,
  toCentered,
  type CenteredBox,
  type PlacedPart,
} from "../src/core/geometry";
import {
  N6_ENVELOPE_BOX,
  N6_INTERIOR_BOX,
  buildN6Geometry,
  trayCageBox,
  unionBox,
} from "../src/adapters/jonsbo-n6/geometry";
import { buildN6Occupancy } from "../src/adapters/jonsbo-n6/occupancy";
import { detectConflicts } from "../src/core/occupancy";
import { loadRawCatalog } from "../src/sku/catalog";
import type { BuildConfig, PsuTopology } from "../src/config/types";
import baseline from "../data/configs/baseline-atx-1hdd.json";

const catalog = loadRawCatalog();

const cfg = (over: Partial<BuildConfig["selection"]> = {}): BuildConfig => {
  const c = structuredClone(baseline) as BuildConfig;
  c.selection = { ...c.selection, ...over };
  return c;
};

const byId = (parts: PlacedPart[], id: string): PlacedPart => {
  const p = parts.find((x) => x.id === id);
  if (!p) throw new Error(`no part ${id}: have ${parts.map((x) => x.id).join(",")}`);
  return p;
};

const hardConflicts = (config: BuildConfig) =>
  detectConflicts(buildN6Occupancy(config, catalog)).filter((c) => c.verdict === "bad");

describe("centred/min-corner conversion", () => {
  it("round-trips", () => {
    const box: CenteredBox = { c: [12, -30, 5], w: 40, h: 10, d: 60 };
    const back = toCentered(toBoxMm(box));
    expect(back).toEqual(box);
  });

  it("puts the min corner at centre minus half extent", () => {
    expect(toBoxMm({ c: [0, 0, 0], w: 10, h: 20, d: 30 })).toEqual({
      x: -5,
      y: -10,
      z: -15,
      w: 10,
      h: 20,
      d: 30,
    });
  });
});

describe("clearanceGap", () => {
  const a: CenteredBox = { c: [0, 0, 0], w: 10, h: 10, d: 10 };

  it("is positive for clear air and symmetric", () => {
    const b: CenteredBox = { c: [0, 20, 0], w: 10, h: 10, d: 10 };
    expect(clearanceGap(a, b, "y")).toBe(10);
    expect(clearanceGap(b, a, "y")).toBe(10);
  });

  it("is negative when the boxes interpenetrate", () => {
    const b: CenteredBox = { c: [0, 8, 0], w: 10, h: 10, d: 10 };
    expect(clearanceGap(a, b, "y")).toBe(-2);
  });

  it("reports the ATX intake gap above a down-draft cooler as a derived number", () => {
    const parts = buildN6Geometry(cfg(), catalog);
    const gap = clearanceGap(byId(parts, "cooler.column").box, byId(parts, "psu.primary").box, "y");
    // AXP90-X53 at 53mm under the rear-upper ATX unit. Not a subtracted constant.
    expect(gap).toBeGreaterThan(8);
    expect(gap).toBeLessThan(15);
  });
});

describe("everything lives inside the published envelope", () => {
  const topologies: PsuTopology[] = ["auto", "bottom", "dual"];
  for (const topo of topologies) {
    it(`holds for psuTopology=${topo}`, () => {
      const config = cfg({
        psuTopology: topo,
        psuId: topo === "auto" ? "psu.seasonic-focus-gx-850-v5" : "psu.corsair-sf750-atx31",
        diskCount: 9,
        gpuId: "gpu.rtx-a4000-16gb",
        boot: "m2",
      });
      const parts = buildN6Geometry(config, catalog, {
        frontFans: "140x2",
        sideFans: true,
        driveFans: true,
        reserveHbaSlot: true,
      });
      const outside = parts
        // The external USB boot drive is deliberately outside the case.
        .filter((p) => p.group !== "external")
        .filter((p) => !containsBox(N6_INTERIOR_BOX, p.box, 0.01))
        .map((p) => `${p.id} ${JSON.stringify(toBoxMm(p.box))}`);
      expect(outside).toEqual([]);
    });
  }

  it("also holds for every occupancy slot box", () => {
    const bad = buildN6Occupancy(cfg(), catalog)
      .slots.filter((s) => !containsBox(N6_INTERIOR_BOX, toCentered(s.box), 0.01))
      .map((s) => s.id);
    expect(bad).toEqual([]);
  });

  it("excludes the 6mm plinth from usable volume", () => {
    expect(N6_INTERIOR_BOX.h).toBe(N6_ENVELOPE_BOX.h - 6);
  });

  it("leaves room in the lower chamber for the 120mm fans the manual puts there", () => {
    const parts = buildN6Geometry(cfg({ diskCount: 9, boot: "m2" }), catalog, { driveFans: true });
    const fans = parts.filter((p) => p.id.startsWith("fan.drive"));
    expect(fans).toHaveLength(2);
    for (const fan of fans) expect(containsBox(N6_INTERIOR_BOX, fan.box)).toBe(true);
  });

  it("derives the tray cage from its own frame bars", () => {
    const cage = trayCageBox();
    expect(cage.h).toBeCloseTo(108.5, 5);
    expect(containsBox(N6_INTERIOR_BOX, cage)).toBe(true);
  });

  it("unionBox spans all inputs on every axis", () => {
    const u = unionBox([
      { c: [-10, 0, 0], w: 4, h: 4, d: 4 },
      { c: [10, 0, 0], w: 4, h: 4, d: 4 },
    ]);
    expect(u.w).toBe(24);
    for (const axis of AXES) expect(Number.isFinite(u.c[AXES.indexOf(axis)]!)).toBe(true);
  });
});

describe("volumetric collision is live and graded", () => {
  it("recommended baseline has no hard collision", () => {
    expect(hardConflicts(cfg())).toEqual([]);
  });

  it("nine drives in the cage are nested, not colliding", () => {
    const conflicts = detectConflicts(buildN6Occupancy(cfg({ diskCount: 9 }), catalog));
    expect(conflicts.filter((c) => c.a.includes("bay") && c.b === "occ-tray-frame")).toEqual([]);
  });

  it("a cooler that overhangs the DIMMs collides only with memory taller than its published ceiling", () => {
    // 31.25mm ECC UDIMM (Kingston datasheet) passes under the 33mm ceiling;
    // the 56mm Dominator cannot.
    const low = cfg({
      coolerId: "cooler.id-cooling-is-55-black",
      memoryId: "memory.kingston-ksm48e40bd8km-32hm-x2",
    });
    const tall = cfg({
      coolerId: "cooler.id-cooling-is-55-black",
      memoryId: "memory.corsair-cmt32gx5m2x6400c38",
    });
    const ramClash = (config: BuildConfig) =>
      detectConflicts(buildN6Occupancy(config, catalog)).filter(
        (c) => c.id.startsWith("aabb:") && c.id.includes("ram") && c.id.includes("cooler"),
      );
    expect(ramClash(low)).toEqual([]);
    expect(ramClash(tall).length).toBeGreaterThan(0);
  });

  it("grades an intersection built on a reconstructed anchor as warn, never bad", () => {
    // NH-U9S is 125mm under a 65mm ceiling: the envelopes really do intersect,
    // but the anchor is our reconstruction, so it cannot claim incompatibility.
    const conflicts = detectConflicts(
      buildN6Occupancy(cfg({ coolerId: "cooler.noctua-nh-u9s" }), catalog),
    ).filter((c) => c.id.startsWith("aabb:"));
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.every((c) => c.verdict === "warn")).toBe(true);
    expect(conflicts.some((c) => c.message.includes("锚点"))).toBe(true);
  });

  it("a 2.5-slot card eats the chipset x4 envelope the HBA needs", () => {
    const config = cfg({
      gpuId: "gpu.plan.rtx-5060ti-16",
      diskCount: 9,
      boot: "m2",
      hbaMode: "always",
      hbaSkuId: "hba.lsi-9300-8i-it",
    });
    const parts = buildN6Geometry(config, catalog);
    const gap = clearanceGap(byId(parts, "gpu").box, byId(parts, "hba").box, "x");
    expect(gap).toBeLessThan(0);
    const hits = detectConflicts(buildN6Occupancy(config, catalog));
    expect(hits.some((c) => c.id === "aabb:occ-pcie-slot1:occ-pcie-slot2")).toBe(true);
  });

  it("a single-slot card leaves the HBA envelope clear", () => {
    const config = cfg({
      gpuId: "gpu.rtx-a4000-16gb",
      diskCount: 9,
      boot: "m2",
      hbaMode: "always",
      hbaSkuId: "hba.lsi-9300-8i-it",
    });
    const parts = buildN6Geometry(config, catalog);
    expect(clearanceGap(byId(parts, "gpu").box, byId(parts, "hba").box, "x")).toBeGreaterThan(0);
  });

  it("bottom SFX both takes the bracket slot and intersects its volume", () => {
    const config = cfg({ psuTopology: "bottom", psuId: "psu.corsair-sf750-atx31" });
    const parts = buildN6Geometry(config, catalog);
    expect(parts.some((p) => p.id === "fan.left_bracket")).toBe(false);
    expect(parts.some((p) => p.id === "chassis.psu_rack_plate")).toBe(true);
    // With the bracket gone the manual's own trade-off must still be reported.
    const hits = detectConflicts(buildN6Occupancy(config, catalog));
    expect(hits.some((c) => c.id.startsWith("slot:"))).toBe(false);
  });

  it("intruding on a reserved routing volume is a warn about净空, not a fit failure", () => {
    const config = cfg({ diskCount: 9, boot: "m2" });
    const hits = detectConflicts(
      buildN6Occupancy(config, catalog, { sideFans: true }),
    ).filter((c) => c.id.startsWith("clear:"));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((c) => c.verdict === "warn")).toBe(true);
  });
});

describe("thermal ids are attached to real parts", () => {
  it("marks cpu, drives and psu so the field builder needs no coordinates of its own", () => {
    const parts = buildN6Geometry(cfg({ diskCount: 4, gpuId: "gpu.rtx-a4000-16gb" }), catalog);
    const ids = new Set(parts.filter((p) => p.thermalId).map((p) => p.thermalId));
    expect(ids).toContain("cpu");
    expect(ids).toContain("psu");
    expect(ids).toContain("hdd");
    expect(ids).toContain("gpu");
    expect(parts.filter((p) => p.thermalId === "hdd")).toHaveLength(4);
  });
});
