import { describe, expect, it } from "vitest";
import { boxesOverlap, detectConflicts } from "../src/core/occupancy";
import { derivePower, evaluateBuild } from "../src/core/evaluate";
import { loadBundledCatalog } from "../src/sku/catalog";
import { parseConfig } from "../src/config/types";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import sfx9 from "../data/configs/sfx-9hdd-hba-a4000.json";
import type { BuildConfig } from "../src/config/types";
import { planN6Wiring } from "../src/wiring/plan";

const catalog = loadBundledCatalog();

describe("occupancy geometry", () => {
  it("detects AABB overlap", () => {
    expect(
      boxesOverlap(
        { x: 0, y: 0, z: 0, w: 10, h: 10, d: 10 },
        { x: 5, y: 5, z: 5, w: 10, h: 10, d: 10 },
      ),
    ).toBe(true);
    expect(
      boxesOverlap(
        { x: 0, y: 0, z: 0, w: 10, h: 10, d: 10 },
        { x: 20, y: 0, z: 0, w: 10, h: 10, d: 10 },
      ),
    ).toBe(false);
  });

  it("flags exclusiveWith slots", () => {
    const hits = detectConflicts({
      caseId: "t",
      slots: [
        {
          id: "a",
          kind: "psu",
          box: { x: 0, y: 0, z: 0, w: 1, h: 1, d: 1 },
          exclusiveWith: ["b"],
          evidence: "inferred",
        },
        {
          id: "b",
          kind: "fan",
          box: { x: 0, y: 0, z: 0, w: 1, h: 1, d: 1 },
          evidence: "official",
        },
      ],
      occupants: [
        { id: "oa", skuId: "sfx", slotIds: ["a"], evidence: "inferred" },
        { id: "ob", skuId: "fan", slotIds: ["b"], evidence: "inferred" },
      ],
    });
    expect(hits.some((h) => h.id.startsWith("excl:"))).toBe(true);
  });
});

describe("evaluateBuild", () => {
  it("baseline ATX config evaluates without hard bay9 conflict", () => {
    const result = evaluateBuild(baseline as BuildConfig, catalog);
    expect(result.findings.some((f) => f.id === "n6.bay9-boot-vs-9hdd")).toBe(false);
    expect(result.wiring.bayPaths).toHaveLength(9);
    expect(result.bom.some((b) => b.skuId === "case.jonsbo-n6")).toBe(true);
  });

  it("marks bay9 boot + 9 HDD as bad", () => {
    const cfg = structuredClone(baseline) as BuildConfig;
    cfg.selection.diskCount = 9;
    cfg.selection.boot = "bay";
    const result = evaluateBuild(cfg, catalog);
    expect(result.findings.some((f) => f.id === "n6.bay9-boot-vs-9hdd" && f.verdict === "bad")).toBe(
      true,
    );
  });

  it("sfx 9hdd plan uses HBA paths", () => {
    const result = evaluateBuild(sfx9 as BuildConfig, catalog);
    expect(result.wiring.bayPaths.filter((b) => b.target === "hba").length).toBeGreaterThanOrEqual(8);
    expect(result.bom.some((b) => b.skuId === "hba.lsi-9300-8i-it")).toBe(true);
  });

  it("IS-55 + tall XMP memory conflicts", () => {
    const cfg = structuredClone(baseline) as BuildConfig;
    cfg.selection.coolerId = "cooler.id-cooling-is-55-black";
    cfg.selection.memoryId = "memory.corsair-cmt32gx5m2x6400c38";
    const result = evaluateBuild(cfg, catalog);
    expect(result.findings.some((f) => f.id === "mem.cooler-height")).toBe(true);
  });
});

describe("wiring + config", () => {
  it("backplane always has 4 feeds", () => {
    const plan = planN6Wiring(baseline as BuildConfig, catalog);
    expect(plan.backplanePower).toHaveLength(4);
  });

  it("round-trips JSON config", () => {
    const raw = JSON.stringify(baseline);
    const parsed = parseConfig(raw);
    expect(parsed.schemaVersion).toBe("2.0.0");
    expect(parsed.selection.psuId).toContain("focus");
  });

  it("needsHba triggers past the board's derived SATA ceiling", async () => {
    const { needsHba, nativeSataCeiling } = await import("../src/core/policy");
    const ports = { nativeSata: 4, slimsasSata: 4 };
    expect(nativeSataCeiling(ports)).toBe(8);
    expect(needsHba({ hbaMode: "auto", diskCount: 8, boot: "m2" }, ports)).toBe(false);
    expect(needsHba({ hbaMode: "auto", diskCount: 8, boot: "bay" }, ports)).toBe(true);
    // Fewer breakout lanes must move the trigger with them, not leave it at a stored 8.
    expect(
      needsHba({ hbaMode: "auto", diskCount: 6, boot: "m2" }, { nativeSata: 4, slimsasSata: 0 }),
    ).toBe(true);
  });

  it("SKU appearance is present for owned case", () => {
    const n6 = catalog.skus.find((s) => s.id === "case.jonsbo-n6")!;
    expect(n6.appearance?.image).toContain("n6.webp");
  });

  it("exposes one power fact source with explicit primary/secondary PSU loads", () => {
    const cfg = structuredClone(baseline) as BuildConfig;
    cfg.selection.psuTopology = "dual";
    cfg.selection.secondaryPsuId = "psu.corsair-sf750-atx31";
    cfg.selection.dualStart = "sync";
    cfg.selection.diskCount = 8;
    const power = derivePower(cfg, catalog, {
      workload: "combined",
      cpuPl1W: 90,
      cpuPl2W: 125,
      fans: { front: { size: 140, count: 2 }, right: { size: 120, count: 2 } },
    });
    const result = evaluateBuild(cfg, catalog, {
      workload: "combined",
      cpuPl1W: 90,
      cpuPl2W: 125,
      ambientC: 25,
      fanMode: "balanced",
      fans: { front: { size: 140, count: 2 }, right: { size: 120, count: 2 } },
      upperWatts: power.upperDcW ?? 0,
      psuDcWatts: power.lowerDcW ?? 0,
      loads: power.loads,
    });
    expect(result.power.psus.map((load) => load.role)).toEqual(["primary", "secondary"]);
    expect(result.power.psus[0]?.dcLoadW).toBeGreaterThan(0);
    expect(result.power.psus[1]?.dcLoadW).toBeGreaterThan(0);
    expect(result.power.psus[1]?.chamber).toBe("lower");
    expect(result.thermal?.coupling.psuWasteW).toBeCloseTo(result.power.psus[1]?.wasteHeatW ?? -1, 6);
    expect(result.power.dcW).toBeCloseTo((result.power.mainDcW ?? 0) + (result.power.driveDcW ?? 0));
    expect(result.power).toBe(result.power);
    expect(result.price.items).toEqual(result.bom.map((line) => expect.objectContaining({ skuId: line.skuId, qty: line.qty })));
  });

  it("attributes a bottom primary PSU load and waste heat to the lower chamber", () => {
    const cfg = structuredClone(baseline) as BuildConfig;
    cfg.selection.psuTopology = "bottom";
    cfg.selection.psuId = "psu.corsair-sf750-atx31";
    cfg.selection.fanGroups = [];
    const power = derivePower(cfg, catalog, { workload: "idle", fans: {} });
    const result = evaluateBuild(cfg, catalog, {
      workload: "idle", ambientC: 25, fanMode: "balanced", fans: {},
      upperWatts: power.upperDcW ?? 0, psuDcWatts: power.lowerDcW ?? 0,
      power, loads: power.loads,
    });
    expect(power.psus[0]).toMatchObject({ role: "primary", chamber: "lower", dcLoadW: power.mainDcW });
    expect(power.lowerDcW).toBe(power.mainDcW);
    expect(result.thermal?.coupling.psuWasteW).toBeCloseTo(power.psus[0]?.wasteHeatW ?? -1, 6);
  });

  it("keeps unknown power facts structured instead of inventing a wall number", () => {
    const cfg = structuredClone(baseline) as BuildConfig;
    cfg.selection.secondaryPsuId = "psu.not-in-catalog";
    cfg.selection.psuTopology = "dual";
    cfg.selection.dualStart = "sync";
    const power = derivePower(cfg, catalog, { workload: "work", fans: {} });
    expect(power.unknown).toContain("secondary.psu");
    expect(power.psus[1]?.wallW).toBeNull();
    expect(power.pathologicalWallW).toBeNull();
  });

  it("uses the configured fan groups and preserves one evaluation snapshot", () => {
    const cfg = structuredClone(baseline) as BuildConfig;
    const noFans = derivePower(cfg, catalog, { workload: "idle", fans: {} });
    const populated = derivePower(cfg, catalog, {
      workload: "idle",
      fans: {
        front: { size: 140, count: 2 },
        rear: { size: 120, count: 1 },
        left: { size: 120, count: 2 },
        right: { size: 120, count: 2 },
      },
    });
    expect(noFans.fanW).toBe(5);
    expect(populated.fanW).toBe(5 + 2 * 2 + 1 * 2 + 2 * 2 + 2 * 2);
    const evaluation = evaluateBuild(cfg, catalog, {
      workload: "idle",
      ambientC: 25,
      fanMode: "balanced",
      fans: { front: { size: 140, count: 2 } },
      upperWatts: populated.upperDcW ?? 0,
      psuDcWatts: 0,
      power: populated,
      loads: populated.loads,
    });
    expect(evaluation.power).toBe(populated);
    expect(evaluation.bom).toEqual(expect.arrayContaining(evaluation.price.items.map((item) => expect.objectContaining({ skuId: item.skuId }))));
    expect(evaluation.wiring.bayPaths.length).toBe(9);
  });
});
