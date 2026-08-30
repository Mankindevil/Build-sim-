import { describe, expect, it } from "vitest";
import { N6_WIRING_PROFILE, planN6Wiring } from "../src/adapters/jonsbo-n6/assembly";
import { planCaseWiring } from "../src/wiring/plan";
import { loadRawCatalog } from "../src/sku/catalog";
import type { BootMode, BuildConfig } from "../src/config/types";

const catalog = loadRawCatalog();

function config(diskCount: number, boot: BootMode): BuildConfig {
  return {
    schemaVersion: "2.0.0", id: "zero-storage", name: "zero-storage", updatedAt: "2026-08-28",
    caseId: "case.jonsbo-n6", boardId: "board.asus-w680m-ace-se", cpuId: "cpu.i5-14500",
    selection: {
      psuId: "psu.corsair-sf750-atx31", psuTopology: "bottom",
      coolerId: "cooler.thermalright-axp90-x53-full", gpuId: "gpu.none",
      memoryId: "memory.kingston-kf564c32rsk2-32", diskSkuId: "storage.seagate-exos-x24-24tb",
      diskCount, nvmeCount: 1, boot, hbaMode: "auto",
    },
    bom: [],
  };
}

function qty(plan: ReturnType<typeof planN6Wiring>, id: string): number {
  return plan.checklist.find((item) => item.id === id)?.requiredQty ?? 0;
}

describe("wiring follows populated storage instances", () => {
  it("generates no data/HBA/backplane cable or power requirement for zero HDD + M.2 boot", () => {
    const plan = planN6Wiring(config(0, "m2"), catalog);
    expect(plan.bayPaths.every(({ target, assignment }) => target === "empty" && assignment.controller === "none")).toBe(true);
    expect(plan.backplanePower).toEqual([]);
    expect(plan.backplaneHarness.required).toEqual({ sata: 0, molex: 0 });
    expect(plan.backplaneHarness.socketLimited).toBe(false);
    expect(plan.backplaneHarness.spinUp).toMatchObject({ diskCount: 0, totalA: 0, perInletA: 0, perSharedLeadA: 0 });
    expect(qty(plan, "sata-data")).toBe(0);
    expect(qty(plan, "slimsas-breakout")).toBe(0);
    expect(qty(plan, "hba-minisas")).toBe(0);
    expect(qty(plan, "bp-power-sata")).toBe(0);
    expect(qty(plan, "bp-power-molex")).toBe(0);
    expect(plan.warnings.join(" ")).not.toMatch(/HBA|SATA 端口数|没有数据端口/);
  });

  it("generates no bay/backplane path for zero HDD + USB SSD boot", () => {
    const plan = planN6Wiring(config(0, "usbssd"), catalog);
    expect(plan.bayPaths.every(({ target }) => target === "empty")).toBe(true);
    expect(plan.backplanePower).toEqual([]);
    expect(qty(plan, "sata-data")).toBe(0);
    expect(qty(plan, "slimsas-breakout")).toBe(0);
    expect(qty(plan, "hba-minisas")).toBe(0);
    expect(qty(plan, "bp-power-sata")).toBe(0);
    expect(qty(plan, "bp-power-molex")).toBe(0);
  });

  it("adds exactly one native SATA path for one HDD and powers the populated backplane", () => {
    const plan = planN6Wiring(config(1, "m2"), catalog);
    expect(plan.bayPaths.filter(({ assignment }) => assignment.controller !== "none")).toHaveLength(1);
    expect(plan.bayPaths.filter(({ target }) => target === "sata")).toHaveLength(1);
    expect(qty(plan, "sata-data")).toBe(1);
    expect(qty(plan, "slimsas-breakout")).toBe(0);
    expect(qty(plan, "hba-minisas")).toBe(0);
    expect(plan.backplanePower).toHaveLength(4);
    expect(plan.backplaneHarness.required).toEqual({ sata: 2, molex: 2 });
  });

  it("derives cable quantities from the real controller path as drives are added", () => {
    const five = planN6Wiring(config(5, "m2"), catalog);
    expect(five.bayPaths.filter(({ target }) => target === "sata")).toHaveLength(4);
    expect(five.bayPaths.filter(({ target }) => target === "slimsas")).toHaveLength(1);
    expect(qty(five, "sata-data")).toBe(4);
    expect(qty(five, "slimsas-breakout")).toBe(1);
    expect(qty(five, "hba-minisas")).toBe(0);

    const nine = planN6Wiring(config(9, "m2"), catalog);
    expect(nine.bayPaths.filter(({ target }) => target === "hba")).toHaveLength(8);
    expect(nine.bayPaths.filter(({ target }) => target === "sata")).toHaveLength(1);
    expect(qty(nine, "hba-minisas")).toBe(2);
    expect(qty(nine, "sata-data")).toBe(1);
  });

  it("retains data and backplane power only when a bay boot device is explicit", () => {
    const plan = planN6Wiring(config(0, "bay"), catalog);
    expect(plan.bayPaths.filter(({ assignment }) => assignment.controller !== "none")).toHaveLength(1);
    expect(qty(plan, "sata-data")).toBe(1);
    expect(plan.backplanePower).toHaveLength(4);
  });

  it("rejects a profile whose connector counts do not close to its inlet count", () => {
    expect(() => planCaseWiring(config(1, "m2"), catalog, {
      ...N6_WIRING_PROFILE,
      backplanePower: {
        inlets: 4,
        connectors: { sataPower: 1, molex: 1 },
        inletOrder: ["sata", "molex", "sata", "molex"],
      },
    })).toThrow(/connector order\/counts.*do not close/);
  });
});
