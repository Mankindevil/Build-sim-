import { describe, expect, it } from "vitest";
import { checkBackplaneHarness, planN6Wiring } from "../src/wiring/plan";
import { loadRawCatalog } from "../src/sku/catalog";
import type { BuildConfig, PsuTopology } from "../src/config/types";
import type { HarnessSpec, SkuCatalog } from "../src/sku/types";

const catalog = loadRawCatalog();

function config(overrides: Partial<BuildConfig["selection"]> & { psuTopology?: PsuTopology } = {}): BuildConfig {
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
      ...overrides,
    },
    bom: [],
  };
}

/**
 * Clone the catalog with one PSU's harness replaced, so fixtures stay local.
 * Sockets follow the lead count, since a plugged-in lead implies a socket.
 */
function withHarness(psuId: string, harness: HarnessSpec): SkuCatalog {
  const sockets = (harness.sataLeads ?? 0) + (harness.molexLeads ?? 0);
  return {
    ...catalog,
    skus: catalog.skus.map((s) =>
      s.id === psuId ? { ...s, harness, attrs: { ...s.attrs, peripheralSockets: sockets } } : s,
    ),
  };
}

describe("backplane harness audit", () => {
  it("requires 2 SATA + 2 Molex on separate leads, per the N6 manual", () => {
    const check = checkBackplaneHarness(config(), catalog);
    expect(check.inlets).toBe(4);
    expect(check.required).toEqual({ sata: 2, molex: 2 });
    expect(check.notes.join()).toContain("不得菊链");
  });

  it("fails the SF750 on its official cable table: 2 SATA leads but only 1 Molex", () => {
    const check = checkBackplaneHarness(config(), catalog);
    expect(check.confirmed).toEqual({ sata: 2, molex: 1 });
    expect(check.uniquePeripheralLeads).toBe(3);
    expect(check.verdict).toBe("bad");
    expect(check.oneLeadPerInlet).toBe(false);
    // Three Molex plugs on that one cable can reach both inlets — by chaining.
    expect(check.daisyChainOnly).toBe(true);
  });

  it("fails on the socket ceiling before lead counts, since cables cannot add plug points", () => {
    const check = checkBackplaneHarness(config(), catalog);
    expect(check.peripheralSockets).toBe(3);
    expect(check.socketLimited).toBe(true);
    expect(check.verdict).toBe("bad");
    expect(check.notes.join()).toContain("加购线也没有插座可插");
  });

  it("only offers the extra-cable route when a socket is actually free", () => {
    const roomy = catalog.skus.map((s) =>
      s.id === "psu.corsair-sf750-atx31"
        ? { ...s, attrs: { ...s.attrs, peripheralSockets: 4 } }
        : s,
    );
    const check = checkBackplaneHarness(config(), { ...catalog, skus: roomy });
    expect(check.socketLimited).toBe(false);
    expect(check.verdict).toBe("bad");
    expect(check.notes.join()).toContain("加购同型号原厂");
  });

  it("fails the SX750 on the same three-socket ceiling, even with its cable count unpublished", () => {
    const check = checkBackplaneHarness(config({ psuId: "psu.silverstone-sx750-g" }), catalog);
    expect(check.peripheralSockets).toBe(3);
    expect(check.socketLimited).toBe(true);
    expect(check.verdict).toBe("bad");
    expect(check.confirmed).toEqual({ sata: null, molex: null });
    expect(check.connectors).toEqual({ sata: 8, molex: 3 });
  });

  it("fails the V5 ATX unit on its official three-socket ceiling", () => {
    const check = checkBackplaneHarness(
      config({ psuId: "psu.seasonic-focus-gx-850-v5", psuTopology: "auto" }),
      catalog,
    );
    expect(check.peripheralSockets).toBe(3);
    expect(check.socketLimited).toBe(true);
    expect(check.uniquePeripheralLeads).toBe(3);
    expect(check.confirmed).toEqual({ sata: 2, molex: 1 });
    expect(check.verdict).toBe("bad");
    expect(check.notes.join()).toContain("加购线也没有插座可插");
  });

  it("does not double-count FSP's two SATA+Molex mixed cables", () => {
    const check = checkBackplaneHarness(
      config({ psuId: "psu.fsp-dagger-pro-850-atx31", psuTopology: "bottom" }),
      catalog,
    );
    expect(check.confirmed).toEqual({ sata: 2, molex: 2 });
    expect(check.uniquePeripheralLeads).toBe(2);
    expect(check.peripheralSockets).toBe(2);
    expect(check.socketLimited).toBe(true);
    expect(check.verdict).toBe("bad");
  });

  it("stays unknown when neither the cable count nor the socket count is published", () => {
    const noSocketData = catalog.skus.map((s) =>
      s.id === "psu.silverstone-sx750-g"
        ? { ...s, attrs: { ...s.attrs, peripheralSockets: undefined } }
        : s,
    );
    const check = checkBackplaneHarness(config({ psuId: "psu.silverstone-sx750-g" }), {
      ...catalog,
      skus: noSocketData,
    });
    expect(check.verdict).toBe("unknown");
    expect(check.notes.join()).toContain("厂商没说分几根线");
  });

  it("passes only when every inlet has its own confirmed lead", () => {
    const full = withHarness("psu.corsair-sf750-atx31", {
      sataLeads: 2,
      molexLeads: 2,
      evidence: "official",
      leadEvidence: "official",
    });
    const check = checkBackplaneHarness(config(), full);
    expect(check.verdict).toBe("ok");
    expect(check.oneLeadPerInlet).toBe(true);
  });

  it("counts only the dedicated PSU in dual mode, never the sum", () => {
    const catalogWithLeads = withHarness("psu.seasonic-focus-gx-850-v5", {
      sataLeads: 4,
      molexLeads: 4,
      evidence: "official",
    });
    const check = checkBackplaneHarness(
      config({
        psuId: "psu.seasonic-focus-gx-850-v5",
        psuTopology: "dual",
        secondaryPsuId: "psu.sfx-450-unlocked",
      }),
      catalogWithLeads,
    );
    expect(check.feedPsuId).toBe("psu.sfx-450-unlocked");
    expect(check.feedRole).toBe("backplane-dedicated");
    expect(check.verdict).toBe("unknown");
    expect(check.notes.join()).toContain("主电源线束不参与计数");
  });

  it("labels inlets 1–2 SATA and 3–4 Molex and splits the checklist by connector", () => {
    const plan = planN6Wiring(config(), catalog);
    expect(plan.backplanePower.map((f) => f.connector)).toEqual(["sata", "sata", "molex", "molex"]);
    const ids = plan.checklist.map((c) => c.id);
    expect(ids).toContain("bp-power-sata");
    expect(ids).toContain("bp-power-molex");
    expect(plan.checklist.find((c) => c.id === "bp-power-molex")?.requiredQty).toBe(2);
  });
});

describe("spin-up surge", () => {
  it("scales the datasheet 12V startup peak across the disks and inlets", () => {
    const { spinUp } = checkBackplaneHarness(config(), catalog);
    expect(spinUp.perDiskA).toBe(2.6);
    expect(spinUp.totalA).toBe(23.4);
    expect(spinUp.perInletA).toBeCloseTo(5.9, 1);
    expect(spinUp.perSharedLeadA).toBeCloseTo(11.7, 1);
    expect(spinUp.evidence).toBe("official");
  });

  it("goes unknown without a disk SKU rather than guessing a current", () => {
    const noDisk = config();
    delete (noDisk.selection as { diskSkuId?: string }).diskSkuId;
    const { spinUp } = checkBackplaneHarness(noDisk, catalog);
    expect(spinUp.totalA).toBeNull();
    expect(spinUp.evidence).toBe("unknown");
  });

  it("flags a shared lead against the vendor's per-lead ceiling when published", () => {
    const { spinUp } = checkBackplaneHarness(config({ psuId: "psu.silverstone-sx750-g" }), catalog);
    expect(spinUp.leadLimitW).toBe(60);
    expect(spinUp.notes.join()).toContain("已超过厂商标注的单接头 60W 上限");
  });
});
