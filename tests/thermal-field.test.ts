import { describe, expect, it } from "vitest";
import type { PlacedPart, Vec3 } from "../src/core/geometry";
import type { ComponentNode, ThermalResult } from "../src/core/thermal";
import {
  BARRIER_LEAK_COUPLED,
  buildFieldBounds,
  buildHeatSources,
  sampleField,
  sampleSlice,
  slicePeakC,
  type FieldBounds,
} from "../src/core/thermal-field";

const AMBIENT = 25;
const DECK_Y = -38;

function node(over: Partial<ComponentNode> & Pick<ComponentNode, "id">): ComponentNode {
  return {
    label: over.id.toUpperCase(),
    chamber: "upper",
    watts: 65,
    thetaKPerW: { lo: 0.3, hi: 0.6 },
    tempC: { lo: 50, hi: 70 },
    evidence: "inferred",
    ...over,
  };
}

function thermal(components: ComponentNode[], couplingActive = false): ThermalResult {
  const chamber = {
    heatW: 100,
    cfm: { lo: 10, hi: 20 },
    riseK: { lo: 5, hi: 12 },
    airOutC: { lo: 30, hi: 37 },
    evidence: "inferred" as const,
  };
  return {
    ambientC: AMBIENT,
    // Chamber internals are not read by the field builder; only ambient, the
    // component list and the coupling flag are.
    chambers: { lower: chamber, upper: chamber } as unknown as ThermalResult["chambers"],
    hddC: { lo: 35, hi: 48 },
    components,
    psuInletC: null,
    coupling: { active: couplingActive, psuWasteW: 40, shareOfLowerLoad: 0.3, extraRiseK: 4 },
    assumptions: [],
    evidence: "inferred",
    notes: [],
  };
}

function part(over: Partial<PlacedPart> & Pick<PlacedPart, "id">): PlacedPart {
  return {
    name: over.id,
    kind: "cpu",
    box: { c: [0, 0, 0], w: 40, h: 10, d: 40 },
    sizeEvidence: "standard",
    anchorEvidence: "inferred",
    dimsLabel: "test",
    ...over,
  };
}

/** One hot part in the upper chamber, nothing else. */
function singleSourceField(couplingActive = false): FieldBounds {
  const parts = [part({ id: "cpu", thermalId: "cpu", chamber: "upper", box: { c: [0, 20, 0], w: 40, h: 10, d: 40 } })];
  return buildFieldBounds(parts, thermal([node({ id: "cpu" })], couplingActive), DECK_Y);
}

describe("heat sources come from the geometry, not from coordinates typed twice", () => {
  it("places a source at the part's own centroid", () => {
    const sources = buildHeatSources(
      [part({ id: "gpu", thermalId: "gpu", box: { c: [12, -4, 30], w: 200, h: 40, d: 120 } })],
      thermal([node({ id: "gpu", watts: 140 })]),
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]!.at).toEqual([12, -4, 30]);
    // σ is the part's own half-extent plus a fixed spreading length, so a long
    // part reads as a bar rather than a point.
    expect(sources[0]!.sigmaMm[0]).toBeGreaterThan(sources[0]!.sigmaMm[1]!);
  });

  it("ignores parts with no thermal node and nodes with no part", () => {
    const sources = buildHeatSources(
      [part({ id: "ram" }), part({ id: "hba", thermalId: "hba" })],
      thermal([node({ id: "cpu" })]),
    );
    expect(sources).toEqual([]);
  });

  it("splits a node's watts across the parts that share it, except per-drive nodes", () => {
    const psuHalves = buildHeatSources(
      [
        part({ id: "psu.a", thermalId: "psu", box: { c: [-40, 0, 0], w: 60, h: 60, d: 100 } }),
        part({ id: "psu.b", thermalId: "psu", box: { c: [40, 0, 0], w: 60, h: 60, d: 100 } }),
      ],
      thermal([node({ id: "psu", watts: 80 })]),
    );
    expect(psuHalves.map((s) => s.watts)).toEqual([40, 40]);

    // `hdd` watts are already per drive, so nine trays must not each get a ninth.
    const drives = buildHeatSources(
      [1, 2, 3].map((i) => part({ id: `drive.${i}`, thermalId: "hdd", box: { c: [0, -60 + i * 30, 0], w: 102, h: 26, d: 147 } })),
      thermal([node({ id: "hdd", watts: 8.9, chamber: "lower" })]),
    );
    expect(drives.map((s) => s.watts)).toEqual([8.9, 8.9, 8.9]);
    // Sharing a node means the label has to say which part it is.
    expect(drives[0]!.label).toContain("drive.1");
  });
});

describe("the field only interpolates the 0D result", () => {
  it("reads its own source temperature at the source", () => {
    const field = singleSourceField();
    expect(sampleField(field, [0, 20, 0], "hi")).toBeCloseTo(70, 5);
    expect(sampleField(field, [0, 20, 0], "lo")).toBeCloseTo(50, 5);
  });

  it("never exceeds the hottest declared source and never drops below ambient", () => {
    const field = buildFieldBounds(
      [
        part({ id: "cpu", thermalId: "cpu", chamber: "upper", box: { c: [0, 20, 0], w: 40, h: 10, d: 40 } }),
        part({ id: "gpu", thermalId: "gpu", chamber: "upper", box: { c: [10, 20, 10], w: 40, h: 10, d: 40 } }),
      ],
      thermal([node({ id: "cpu" }), node({ id: "gpu", tempC: { lo: 45, hi: 62 } })]),
      DECK_Y,
    );
    // Two overlapping sources must not add up past the hottest input: nothing in a
    // lumped model can justify a point hotter than its own inputs.
    const between: Vec3 = [5, 20, 5];
    expect(sampleField(field, between, "hi")).toBeLessThanOrEqual(70 + 1e-6);
    expect(sampleField(field, [140, 150, 170], "hi")).toBeGreaterThanOrEqual(AMBIENT);
    expect(sampleField(field, [140, 150, 170], "hi")).toBeCloseTo(AMBIENT, 3);
  });

  it("decays with distance and keeps the optimistic bound below the conservative one", () => {
    const field = singleSourceField();
    const near = sampleField(field, [0, 20, 20], "hi");
    const far = sampleField(field, [0, 20, 80], "hi");
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(AMBIENT);
    for (const at of [[0, 20, 0], [0, 20, 30], [60, 20, 0]] as Vec3[]) {
      expect(sampleField(field, at, "lo")).toBeLessThanOrEqual(sampleField(field, at, "hi"));
    }
  });
});

describe("the deck blocks diffusion, because the 0D model says the chambers are separate", () => {
  it("leaves the other chamber at ambient when nothing bridges them", () => {
    const field = singleSourceField();
    expect(field.barrierLeak).toBe(0);
    // Just below the deck, only millimetres from the source's own σ.
    expect(sampleField(field, [0, DECK_Y - 1, 0], "hi")).toBeCloseTo(AMBIENT, 6);
  });

  it("lets a bounded fraction across once a bottom PSU couples them", () => {
    const coupled = singleSourceField(true);
    expect(coupled.barrierLeak).toBe(BARRIER_LEAK_COUPLED);
    const crossing = sampleField(coupled, [0, DECK_Y - 1, 0], "hi") - AMBIENT;
    const sameSide = sampleField(singleSourceField(), [0, 20 + (20 - DECK_Y + 1), 0], "hi") - AMBIENT;
    expect(crossing).toBeGreaterThan(0);
    // The leak is a fraction, so crossing the deck can never beat the same
    // distance travelled inside one chamber.
    expect(crossing).toBeLessThan(sameSide);
  });
});

describe("slices are registered in millimetres", () => {
  it("samples cell centres on the requested grid", () => {
    const field = singleSourceField();
    const slice = sampleSlice(field, "xy", 0, [-100, 100, -100, 100], 10);
    expect(slice.cols).toBe(20);
    expect(slice.rows).toBe(20);
    expect(slice.lo).toHaveLength(400);
    expect(slice.minC).toBeGreaterThanOrEqual(AMBIENT);
    expect(slicePeakC(slice, "hi")).toBeGreaterThan(slicePeakC(slice, "lo"));
    expect(slicePeakC(slice, "hi")).toBeLessThanOrEqual(70 + 1e-6);
  });

  it("puts the peak where the part is, on every plane", () => {
    const field = buildFieldBounds(
      // Centred on cell centres of the 10 mm grid below, so the peak cell is
      // unambiguous rather than a tie between two neighbours.
      [part({ id: "cpu", thermalId: "cpu", chamber: "upper", box: { c: [65, 25, -35], w: 40, h: 10, d: 40 } })],
      thermal([node({ id: "cpu" })]),
      DECK_Y,
    );
    const extent: [number, number, number, number] = [-150, 150, -150, 150];
    const peakCell = (plane: "xy" | "xz" | "yz") => {
      const slice = sampleSlice(field, plane, plane === "xy" ? -35 : plane === "xz" ? 25 : 65, extent, 10);
      let best = 0;
      for (let i = 1; i < slice.hi.length; i++) if (slice.hi[i]! > slice.hi[best]!) best = i;
      const col = best % slice.cols;
      const row = Math.floor(best / slice.cols);
      return [extent[0] + (col + 0.5) * slice.gridMm, extent[2] + (row + 0.5) * slice.gridMm];
    };
    // xy: u = x, v = y. xz: u = x, v = z. yz: u = z, v = y.
    expect(peakCell("xy")).toEqual([65, 25]);
    expect(peakCell("xz")).toEqual([65, -35]);
    expect(peakCell("yz")).toEqual([-35, 25]);
  });
});
