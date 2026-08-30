import { describe, expect, it } from "vitest";
import { N6_WIRING_PROFILE, planN6PanelWiring as planPanelWiring } from "../src/adapters/jonsbo-n6/assembly";
import { planPanelWiring as planCasePanelWiring } from "../src/wiring/panel";
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

  it("shows the V5 ATX unit failing with all three peripheral sockets occupied", () => {
    const plan = planPanelWiring(
      config({ psuId: "psu.seasonic-focus-gx-850-v5", psuTopology: "auto" }),
      catalog,
    );
    expect(plan.freeSockets.filter((s) => s.group === "peripheral")).toHaveLength(0);
    expect(plan.notes.join()).toContain("加购线无处可插");
    expect(plan.unmet.join()).toContain("Molex(PATA) 线少 1 根");
  });

  it("models FSP's two mixed cables once while sharing them across four typed inlets", () => {
    const plan = planPanelWiring(
      config({ psuId: "psu.fsp-dagger-pro-850-atx31", psuTopology: "bottom" }),
      catalog,
    );
    const mixed = plan.cables.filter((c) => c.kind === "mixed");
    expect(mixed).toHaveLength(2);
    expect(mixed.every((c) => c.status === "chained")).toBe(true);
    expect(plan.inlets.filter((inlet) => inlet.shared)).toHaveLength(2);
  });

  it("refuses to draw a panel it has not counted", () => {
    const plan = planPanelWiring(
      config({ psuId: "psu.greatwall-f8-850", psuTopology: "auto" }),
      catalog,
    );
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
    expect(plan.cables.some((cable) => ["mb", "cpu", "pcie", "12v2x6", "sense"].includes(cable.kind))).toBe(false);
    expect(plan.notes.join()).toContain("主板、CPU 与 GPU 线保留在主电源面板");
  });

  it.each(["m2", "usbssd"] as const)("does not consume or report backplane leads for zero HDD + %s boot", (boot) => {
    const plan = planPanelWiring(config({ diskCount: 0, boot }), catalog);
    expect(plan.inlets).toEqual([]);
    expect(plan.cables.some((cable) => ["sata", "molex", "mixed"].includes(cable.kind))).toBe(false);
    expect(plan.unmet).toEqual([]);
    expect(plan.notes.join()).not.toMatch(/背板口|加购.*外围线|Molex.*少/);
  });

  it("adds a PCIe cable only when a GPU is selected", () => {
    const none = planPanelWiring(config(), catalog);
    const withGpu = planPanelWiring(config({ gpuId: "gpu.rtx-a4000-16gb" }), catalog);
    expect(none.cables.some((c) => c.kind === "pcie")).toBe(false);
    expect(withGpu.cables.some((c) => c.kind === "pcie")).toBe(true);
  });

  it("assigns cables to the adapter-declared interleaved inlet order", () => {
    const plan = planCasePanelWiring(config(), catalog, {
      ...N6_WIRING_PROFILE,
      backplanePower: {
        ...N6_WIRING_PROFILE.backplanePower,
        inletOrder: ["sata", "molex", "sata", "molex"],
      },
    });
    expect(plan.inlets.map((inlet) => inlet.connector)).toEqual(["sata", "molex", "sata", "molex"]);
    expect(plan.inlets[3]?.shared).toBe(true);
    expect(plan.inlets[3]?.cableId).toBe(plan.inlets[1]?.cableId);
  });
});
