import { describe, expect, it } from "vitest";
import { boxesOverlap, detectConflicts } from "../src/core/occupancy";
import { evaluateBuild } from "../src/core/evaluate";
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

  it("needsHba follows case profile threshold", async () => {
    const { needsHba } = await import("../src/core/policy");
    expect(
      needsHba({ hbaMode: "auto", diskCount: 8, boot: "m2" }, { autoWhenSataDevicesOver: 8 }),
    ).toBe(false);
    expect(
      needsHba({ hbaMode: "auto", diskCount: 8, boot: "bay" }, { autoWhenSataDevicesOver: 8 }),
    ).toBe(true);
  });

  it("SKU appearance is present for owned case", () => {
    const n6 = catalog.skus.find((s) => s.id === "case.jonsbo-n6")!;
    expect(n6.appearance?.image).toContain("n6.webp");
  });
});
