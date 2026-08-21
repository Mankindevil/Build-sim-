import { describe, expect, it } from "vitest";
import { planN6Wiring } from "../src/wiring/plan";
import { evaluateBuild } from "../src/core/evaluate";
import { loadRawCatalog } from "../src/sku/catalog";
import type { BuildConfig, BootMode } from "../src/config/types";

const catalog = loadRawCatalog();

const config = (diskCount: number, boot: BootMode): BuildConfig => ({
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
    diskCount,
    boot,
    hbaMode: "auto",
  },
  bom: [],
});

const qty = (plan: ReturnType<typeof planN6Wiring>, id: string): number =>
  plan.checklist.find((c) => c.id === id)?.requiredQty ?? 0;

describe("HBA data paths", () => {
  it("never assigns more drives than the card has ports", () => {
    const plan = planN6Wiring(config(9, "m2"), catalog);
    const onHba = plan.bayPaths.filter((b) => b.target === "hba");
    expect(onHba).toHaveLength(8);
    // The ninth drive falls back to the board rather than a port that does not exist.
    const ninth = plan.bayPaths.find((b) => b.bayIndex === 9);
    expect(ninth?.target).toBe("sata");
    expect(ninth?.portLabel).toBe("MB SATA_1");
    expect(plan.warnings.some((w) => w.includes("只有 8 个口"))).toBe(true);
  });

  it("groups HBA ports by connector so each breakout cable is countable", () => {
    const plan = planN6Wiring(config(9, "m2"), catalog);
    const labels = plan.bayPaths.filter((b) => b.target === "hba").map((b) => b.portLabel);
    expect(labels[0]).toContain("C1·P1");
    expect(labels[3]).toContain("C1·P4");
    expect(labels[4]).toContain("C2·P1");
    // Two SFF-8643 connectors, four SATA each — the eight used ports need both cables.
    expect(qty(plan, "hba-minisas")).toBe(2);
    // Below the HBA threshold nothing Mini-SAS is required at all.
    expect(qty(planN6Wiring(config(4, "m2"), catalog), "hba-minisas")).toBe(0);
  });

  it("puts the breakout cables in the BOM, not just the checklist", () => {
    const bom = evaluateBuild(config(9, "m2"), catalog).bom;
    const cable = bom.find((b) => b.skuId === "accessory.minisas-hd-4xsata");
    expect(cable?.qty).toBe(2);
    // SFF-8643 and the board's SlimSAS SFF-8654 are different connectors: budgeting
    // the board cable for an HBA build would buy a plug that does not fit.
    expect(bom.some((b) => b.skuId === "accessory.slimsas-4xsata")).toBe(false);
  });

  it("counts the tray-9 boot SSD as a board port consumer", () => {
    const plan = planN6Wiring(config(8, "bay"), catalog);
    const boot = plan.bayPaths.find((b) => b.bayIndex === 9);
    expect(boot?.portLabel).toContain("启动盘");
    expect(qty(plan, "sata-data")).toBe(1);
  });

  it("routes the boot SSD past the native ports once they are full", () => {
    // 4 data disks fill all four native ports, so the boot SSD is the fifth device.
    const plan = planN6Wiring(config(4, "bay"), catalog);
    const boot = plan.bayPaths.find((b) => b.bayIndex === 9);
    expect(boot?.target).toBe("slimsas");
    expect(qty(plan, "sata-data")).toBe(4);
    expect(qty(plan, "slimsas-breakout")).toBe(1);
  });
});
