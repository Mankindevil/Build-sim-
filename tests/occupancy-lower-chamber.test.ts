import { describe, expect, it } from "vitest";
import { buildN6Occupancy, buildN6Slots } from "../src/adapters/jonsbo-n6/occupancy";
import { detectConflicts } from "../src/core/occupancy";
import type { BuildConfig, PsuTopology } from "../src/config/types";

const config = (psuTopology: PsuTopology): BuildConfig => ({
  schemaVersion: "2.0.0",
  id: "t",
  name: "t",
  updatedAt: "2026-08-21",
  caseId: "case.jonsbo-n6",
  boardId: "board.asus-w680m-ace-se",
  cpuId: "cpu.i5-14500",
  selection: {
    psuId: psuTopology === "auto" ? "psu.seasonic-focus-gx-850-v5" : "psu.corsair-sf750-atx31",
    psuTopology,
    coolerId: "cooler.thermalright-axp90-x53-full",
    gpuId: "gpu.none",
    memoryId: "memory.kingston-kf564c32rsk2-32",
    diskSkuId: "storage.seagate-exos-x24-24tb",
    diskCount: 9,
    boot: "m2",
    hbaMode: "auto",
  },
  bom: [],
});

const has = (m: ReturnType<typeof buildN6Occupancy>, id: string): boolean =>
  m.occupants.some((o) => o.id === id);

describe("lower-chamber structure", () => {
  it("registers the chassis parts that own lower-chamber volume", () => {
    const ids = buildN6Slots().map((s) => s.id);
    expect(ids).toContain("backplane.pcb");
    expect(ids).toContain("tray.frame");
    expect(ids).toContain("fan.left_bracket");
  });

  it("keeps the backplane and tray cage present in every topology", () => {
    for (const topo of ["auto", "bottom", "dual"] as PsuTopology[]) {
      const model = buildN6Occupancy(config(topo));
      expect(has(model, "occ-backplane")).toBe(true);
      expect(has(model, "occ-tray-frame")).toBe(true);
    }
  });

  it("removes the left fan bracket exactly when a PSU takes the bottom bay", () => {
    expect(has(buildN6Occupancy(config("auto")), "occ-left-fan-bracket")).toBe(true);
    // Manual §8.1: the bracket comes out and the PSU rack replaces it.
    expect(has(buildN6Occupancy(config("bottom")), "occ-left-fan-bracket")).toBe(false);
    expect(has(buildN6Occupancy(config("dual")), "occ-left-fan-bracket")).toBe(false);
  });

  it("introduces no conflicts in either topology", () => {
    for (const topo of ["auto", "bottom"] as PsuTopology[]) {
      const hard = detectConflicts(buildN6Occupancy(config(topo))).filter(
        (f) => f.verdict === "bad",
      );
      expect(hard).toEqual([]);
    }
  });

  it("declares the bracket exclusive with the bottom PSU bay", () => {
    const bracket = buildN6Slots().find((s) => s.id === "fan.left_bracket");
    expect(bracket?.exclusiveWith).toContain("psu.bottom_sfx");
    // The conflict is official even though the envelope geometry is not.
    expect(bracket?.evidence).toBe("official");
  });
});
