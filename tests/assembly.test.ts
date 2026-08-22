import { describe, expect, it } from "vitest";
import { buildAssembly, installSweep, type AssemblyPlan } from "../src/core/assembly";
import type { PlacedPart } from "../src/core/geometry";
import { evaluateBuild } from "../src/core/evaluate";
import { loadRawCatalog } from "../src/sku/catalog";
import type { BuildConfig } from "../src/config/types";
import baseline from "../data/configs/baseline-atx-1hdd.json";

const catalog = loadRawCatalog();

const planFor = (over: Partial<BuildConfig["selection"]> = {}): AssemblyPlan => {
  const config = structuredClone(baseline) as BuildConfig;
  config.selection = { ...config.selection, ...over };
  return evaluateBuild(config, catalog).assembly;
};

const at = (plan: AssemblyPlan, id: string): number => {
  const i = plan.steps.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`no step ${id} in:\n${plan.steps.map((s) => s.id).join("\n")}`);
  return i;
};

const IS55 = { coolerId: "cooler.id-cooling-is-55-black" };
const NINE_DISKS: Partial<BuildConfig["selection"]> = { diskCount: 9, hbaMode: "always" };

describe("an install sweep is the corridor, not the seat", () => {
  const part: PlacedPart = {
    id: "ram.1",
    name: "DIMM",
    kind: "ram",
    box: { c: [90, 15, 18], w: 5, h: 30, d: 133 },
    sizeEvidence: "standard",
    anchorEvidence: "inferred",
    dimsLabel: "test",
  };

  it("extrudes outward from the entry face and stops at the part", () => {
    const sweep = installSweep(part, { match: "ram.", axis: "+y", travelMm: "self", source: "t" });
    // The DIMM's top is at y = 30; the corridor is the 30 mm above it, not the seat.
    expect(sweep.c[1]).toBeCloseTo(45, 6);
    expect(sweep.h).toBe(30);
    expect(sweep.w).toBe(5);
    expect(sweep.d).toBe(133);
  });

  it("uses a declared travel when one is given, in the declared direction", () => {
    const sweep = installSweep(part, { match: "ram.", axis: "-y", travelMm: 10, source: "t" });
    expect(sweep.c[1]).toBeCloseTo(-5, 6);
    expect(sweep.h).toBe(10);
  });
});

describe("the order respects what parts are bolted to", () => {
  const plan = planFor();

  it("puts the board before the CPU and the base before the tower on it", () => {
    expect(at(plan, "part:board")).toBeLessThan(at(plan, "part:cpu"));
    expect(at(plan, "part:cpu")).toBeLessThan(at(plan, "part:cooler.base"));
    expect(at(plan, "part:cooler.base")).toBeLessThan(at(plan, "part:cooler.column"));
  });

  it("has every step exactly once and no unsatisfiable loop", () => {
    const ids = plan.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(plan.steps.filter((s) => s.deadlocked)).toEqual([]);
  });

  it("emits an order that satisfies every constraint it derived", () => {
    for (const c of plan.constraints) {
      expect(at(plan, c.before), `${c.before} → ${c.after}`).toBeLessThan(at(plan, c.after));
    }
  });

  it("installs the bottom PSU onto the shipped rack, not the chassis", () => {
    const dual = planFor({ psuTopology: "dual" });
    expect(at(dual, "part:chassis.psu_rack_plate")).toBeLessThan(at(dual, "part:psu.secondary"));
  });
});

describe("install corridors order the parts that stand in them", () => {
  it("puts the DIMMs in before an IS-55, because its fins overhang them", () => {
    const plan = planFor(IS55);
    expect(at(plan, "part:ram.1")).toBeLessThan(at(plan, "part:cooler.overhang"));
    const edge = plan.constraints.find(
      (c) => c.before === "part:ram.1" && c.after === "part:cooler.overhang",
    );
    expect(edge?.kind).toBe("clearance");
    // A corridor is a reconstruction, so it can never be stated as published fact.
    expect(edge?.evidence).toBe("inferred");
  });

  it("says swapping the memory afterwards means taking that cooler off again", () => {
    const plan = planFor(IS55);
    const trap = plan.findings.find((f) => f.id === "assembly.service-order:cooler.overhang");
    expect(trap?.verdict).toBe("warn");
    expect(trap?.message).toContain("DDR5 DIMM 1");
  });

  it("leaves the memory unconstrained under a cooler that clears it", () => {
    // The AXP90-X53's footprint stays inside the socket keepout, so no overhang
    // part exists at all and nothing orders the DIMMs.
    const plan = planFor();
    expect(plan.steps.some((s) => s.id === "part:cooler.overhang")).toBe(false);
    expect(plan.constraints.some((c) => c.before === "part:ram.1" && c.kind === "clearance")).toBe(
      false,
    );
  });

  it("drops the cooler in before the rear-upper ATX unit closes the space above it", () => {
    const plan = planFor();
    expect(at(plan, "part:cooler.column")).toBeLessThan(at(plan, "part:psu.primary"));
  });
});

describe("a plug that something will cover gets connected first", () => {
  it("wires the HBA before the ATX unit sits over its connector", () => {
    const plan = planFor(NINE_DISKS);
    const plug = plan.steps.find((s) => s.kind === "plug" && s.portId === "port.hba.p2");
    expect(plug).toBeTruthy();
    expect(at(plan, plug!.id)).toBeLessThan(at(plan, "part:psu.primary"));
    const edge = plan.constraints.find(
      (c) => c.after === "part:psu.primary" && c.kind === "access",
    );
    expect(edge?.evidence).toBe("inferred");
  });
});

describe("what the manual states stays a declared rule, with its section", () => {
  it("takes the left bracket off before the backplane inlets, and puts it back after", () => {
    const plan = planFor();
    const off = at(plan, "off:fan.left_bracket");
    const refit = at(plan, "on:fan.left_bracket");
    const inlets = plan.steps
      .filter((s) => s.portId?.startsWith("port.backplane.power"))
      .map((s) => at(plan, s.id));
    expect(inlets.length).toBe(4);
    for (const i of inlets) {
      expect(off).toBeLessThan(i);
      expect(i).toBeLessThan(refit);
    }
    const rule = plan.constraints.find(
      (c) => c.kind === "declared" && c.before === "off:fan.left_bracket",
    );
    // The bracket rule is published, unlike everything the corridors derive.
    expect(rule?.evidence).toBe("official");
    expect(rule?.reason).toContain("§13.1");
  });

  it("drops the rule entirely once the rack has replaced the bracket", () => {
    const plan = planFor({ psuTopology: "dual" });
    expect(plan.steps.some((s) => s.kind === "remove")).toBe(false);
    expect(plan.findings.some((f) => f.id.startsWith("assembly.remove-refit"))).toBe(false);
  });
});

describe("an order nobody can perform is reported, not silently reordered", () => {
  it("names the loop instead of dropping a step", () => {
    const part = (id: string, name: string): PlacedPart => ({
      id,
      name,
      kind: "chassis",
      box: { c: [0, 0, 0], w: 10, h: 10, d: 10 },
      sizeEvidence: "inferred",
      anchorEvidence: "inferred",
      dimsLabel: "t",
    });
    const plan = buildAssembly({
      parts: [part("a", "A 件"), part("b", "B 件")],
      cables: [],
      preinstalled: [],
      install: [],
      declared: [
        { id: "r1", before: "part:a", after: "part:b", evidence: "inferred", source: "A 先" },
        { id: "r2", before: "part:b", after: "part:a", evidence: "inferred", source: "B 先" },
      ],
    });
    expect(plan.steps.every((s) => s.deadlocked)).toBe(true);
    const dead = plan.findings.find((f) => f.id === "assembly.deadlock");
    expect(dead?.verdict).toBe("warn");
    expect(dead?.message).toContain("A 件");
  });

  it("never returns a bad verdict from a reconstructed corridor", () => {
    const cases: Partial<BuildConfig["selection"]>[] = [
      {},
      IS55,
      { psuTopology: "dual" },
      NINE_DISKS,
    ];
    for (const over of cases) {
      for (const f of planFor(over).findings) expect(f.verdict).not.toBe("bad");
    }
  });
});
