import { describe, expect, it } from "vitest";
import { planPanelWiring } from "../src/wiring/panel";
import { loadRawCatalog } from "../src/sku/catalog";
import type { BuildConfig, PsuTopology } from "../src/config/types";

const catalog = loadRawCatalog();

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

describe("panel socket plan", () => {
  it("expands the SF750 panel into individually addressable sockets", () => {
    const plan = planPanelWiring(config(), catalog);
    expect(plan.panelKnown).toBe(true);
    expect(plan.sockets).toHaveLength(9);
    expect(plan.sockets.filter((s) => s.group === "peripheral")).toHaveLength(3);
    expect(plan.sockets.filter((s) => s.group === "mb")).toHaveLength(2);
  });

  it("gives every bundled cable a real socket, and leaves none free on the SF750", () => {
    const plan = planPanelWiring(config(), catalog);
    for (const c of plan.cables) expect(c.socketId).not.toBeNull();
    expect(plan.freeSockets.filter((s) => s.group === "peripheral")).toHaveLength(0);
    expect(plan.notes.join()).toContain("加购线无处可插");
  });

  it("names the exact inlet that ends up sharing a lead", () => {
    const plan = planPanelWiring(config(), catalog);
    expect(plan.inlets).toHaveLength(4);
    expect(plan.inlets.map((i) => i.connector)).toEqual(["sata", "sata", "molex", "molex"]);
    // One Molex lead for two Molex inlets: inlet 3 gets it, inlet 4 shares it.
    expect(plan.inlets[2]?.shared).toBe(false);
    expect(plan.inlets[3]?.shared).toBe(true);
    expect(plan.inlets[3]?.cableId).toBe(plan.inlets[2]?.cableId);
    expect(plan.unmet.join()).toContain("Molex(PATA) 线少 1 根");
  });

  it("marks the shared cable as chained rather than ok", () => {
    const plan = planPanelWiring(config(), catalog);
    const molex = plan.cables.filter((c) => c.kind === "molex");
    expect(molex).toHaveLength(1);
    expect(molex[0]?.status).toBe("chained");
    expect(molex[0]?.targets).toEqual(["背板口 3", "背板口 4"]);
  });

  it("shows the ATX unit failing with a free socket still available", () => {
    const plan = planPanelWiring(
      config({ psuId: "psu.seasonic-focus-gx-850-v5", psuTopology: "auto" }),
      catalog,
    );
    expect(plan.freeSockets.filter((s) => s.group === "peripheral")).toHaveLength(1);
    expect(plan.notes.join()).toContain("加购同型号原厂线可以插上");
    expect(plan.unmet.join()).toContain("Molex(PATA) 线少 1 根");
  });

  it("refuses to draw a panel it has not counted", () => {
    const plan = planPanelWiring(config({ psuId: "psu.gw-f8-850", psuTopology: "auto" }), catalog);
    expect(plan.panelKnown).toBe(false);
    expect(plan.evidence).toBe("unknown");
    expect(plan.notes.join()).toContain("不能当作实物布局");
  });

  it("plans the dedicated backplane PSU in dual mode, not the main one", () => {
    const plan = planPanelWiring(
      config({
        psuId: "psu.seasonic-focus-gx-850-v5",
        psuTopology: "dual",
        secondaryPsuId: "psu.corsair-sf750-atx31",
      }),
      catalog,
    );
    expect(plan.psuId).toBe("psu.corsair-sf750-atx31");
  });

  it("adds a PCIe cable only when a GPU is selected", () => {
    const none = planPanelWiring(config(), catalog);
    const withGpu = planPanelWiring(config({ gpuId: "gpu.rtx-a4000-16gb" }), catalog);
    expect(none.cables.some((c) => c.kind === "pcie")).toBe(false);
    expect(withGpu.cables.some((c) => c.kind === "pcie")).toBe(true);
  });
});
