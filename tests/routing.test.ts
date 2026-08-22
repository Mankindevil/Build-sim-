import { describe, expect, it } from "vitest";
import {
  SERVICE_SLACK,
  buildRouteGraph,
  insertionSweep,
  requiredLengthMm,
  resolvePort,
  routeCable,
  segmentBlocks,
  type Port,
  type PortDecl,
  type RouteEdge,
  type Waypoint,
} from "../src/core/routing";
import { containsBox, distanceMm, segmentHitsBox, type PlacedPart, type Vec3 } from "../src/core/geometry";
import { N6_ENVELOPE_BOX, buildN6Geometry } from "../src/adapters/jonsbo-n6/geometry";
import { buildN6Routing } from "../src/adapters/jonsbo-n6/routing";
import { planN6Wiring } from "../src/wiring/plan";
import { loadRawCatalog } from "../src/sku/catalog";
import type { BuildConfig } from "../src/config/types";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import routing from "../data/cases/jonsbo-n6/routing.json";

const catalog = loadRawCatalog();

const cfg = (over: Partial<BuildConfig["selection"]> = {}): BuildConfig => {
  const c = structuredClone(baseline) as BuildConfig;
  c.selection = { ...c.selection, ...over };
  return c;
};

const routed = (over: Partial<BuildConfig["selection"]> = {}) => {
  const config = cfg(over);
  const parts = buildN6Geometry(config, catalog, {});
  return { parts, ...buildN6Routing(parts, planN6Wiring(config, catalog), catalog) };
};

const port = (id: string, ports: Port[]): Port => {
  const p = ports.find((x) => x.id === id);
  if (!p) throw new Error(`no port ${id}: have ${ports.map((x) => x.id).join(",")}`);
  return p;
};

describe("a port is declared on a face, so it travels with its part", () => {
  const decl: PortDecl = {
    id: "port.test",
    onPart: "psu",
    face: "-z",
    offset: [10, -5],
    kind: "periph5",
    insertionMm: 24,
    sectionMm: [18, 10],
    source: "test",
  };
  const psu = (lengthMm: number, zRear: number): PlacedPart => ({
    id: "psu.primary",
    name: "psu",
    kind: "psu",
    box: { c: [15, 100, zRear - lengthMm / 2], w: 150, h: 86, d: lengthMm },
    sizeEvidence: "standard",
    anchorEvidence: "inferred",
    dimsLabel: "test",
  });

  it("moves the socket when the unit gets longer, because the rear stays put", () => {
    const short = resolvePort(psu(140, 105), decl);
    const long = resolvePort(psu(180, 105), decl);
    // Both panels face the case front; the longer unit's panel is 40 mm further forward.
    expect(long.at[2]! - short.at[2]!).toBeCloseTo(-40, 6);
    expect(short.at[0]).toBeCloseTo(25, 6);
    expect(short.at[1]).toBeCloseTo(95, 6);
  });

  it("sweeps along the outward normal, away from the part", () => {
    const p = resolvePort(psu(140, 105), decl);
    expect(p.normal).toEqual([0, 0, -1]);
    const sweep = insertionSweep(p);
    expect(sweep.c[2]).toBeCloseTo(p.at[2]! - 12, 6);
    expect(sweep.d).toBe(24);
    expect(sweep.w).toBe(18);
    expect(sweep.h).toBe(10);
  });
});

describe("every real port lands inside the case", () => {
  it("keeps ports and their insertion sweeps within the envelope", () => {
    const { ports } = routed();
    expect(ports.length).toBeGreaterThan(10);
    for (const p of ports) {
      // A sweep is where a hand and plug must fit, so it has to be inside the case.
      expect(containsBox(N6_ENVELOPE_BOX, insertionSweep(p), 1), `${p.id}`).toBe(true);
    }
  });

  it("carries the sweep it tested, so the preview cannot draw a different volume", () => {
    const { cables, ports } = routed();
    for (const cable of cables) {
      for (const ins of cable.insertion) {
        const p = port(ins.portId, ports);
        expect(ins.at).toEqual(p.at);
        expect(ins.sweep).toEqual(insertionSweep(p));
      }
    }
  });

  it("instantiates one data outlet per tray and one power port per inlet", () => {
    const { ports } = routed();
    const ids = ports.map((p) => p.id);
    for (let i = 1; i <= 9; i++) expect(ids).toContain(`port.backplane.data.${i}`);
    for (let i = 1; i <= 4; i++) expect(ids).toContain(`port.backplane.power.${i}`);
    // The data row follows the tray pitch, so neighbouring outlets are 27 mm apart.
    const first = port("port.backplane.data.1", ports);
    const second = port("port.backplane.data.2", ports);
    expect(second.at[0]! - first.at[0]!).toBeCloseTo(27, 6);
  });
});

describe("crossing the deck needs a declared opening", () => {
  const waypoints = routing.waypoints as unknown as Waypoint[];
  const edges = routing.edges as unknown as RouteEdge[];
  const upper = waypoints.find((w) => w.id === "wp.a.upper_rear")!;
  const lower = waypoints.find((w) => w.id === "wp.backplane.rear")!;
  const fakePort = (at: Vec3): Port => ({
    id: `port.at.${at.join("_")}`,
    partId: "test",
    at,
    normal: [0, 1, 0],
    kind: "test",
    insertionMm: 10,
    sectionMm: [10, 10],
    source: "test",
  });

  const deck: PlacedPart = {
    id: "chassis.deck",
    name: "分层托盘",
    kind: "chassis",
    box: { c: [0, -23, 0], w: 305, h: 4, d: 353 },
    sizeEvidence: "inferred",
    anchorEvidence: "inferred",
    dimsLabel: "test",
  };

  it("routes from the board chamber to the backplane through the A-area opening", () => {
    const graph = buildRouteGraph(waypoints, edges);
    const route = routeCable(graph, fakePort(upper.c), fakePort(lower.c), { obstacles: [deck] });
    expect(route).not.toBeNull();
    expect(route!.viaIds).toContain("wp.a.deck_opening");
  });

  it("finds no way down at all once the openings are taken out of the waypoints", () => {
    // Nothing in the code says "the deck blocks cables": the deck is a solid box
    // and only an opening waypoint is allowed to be inside one.
    const solid = waypoints.filter((w) => w.kind !== "deck_opening");
    const graph = buildRouteGraph(
      solid,
      edges.filter((e) => !e.from.includes("deck_opening") && !e.to.includes("deck_opening")),
    );
    const route = routeCable(graph, fakePort(upper.c), fakePort(lower.c), { obstacles: [deck] });
    // Any remaining path has to cut through the deck, and the run says so.
    expect(route === null || segmentBlocks(route, [deck]).length > 0).toBe(true);
  });
});

describe("route lengths", () => {
  it("is never shorter than the straight line between the two ends", () => {
    const { cables } = routed();
    expect(cables.length).toBeGreaterThan(5);
    for (const cable of cables) {
      if (!cable.route) continue;
      const straight = distanceMm(cable.from.at, cable.to.at);
      expect(cable.route.lengthMm, cable.id).toBeGreaterThanOrEqual(straight - 1e-6);
      expect(cable.requiredMm!).toBeGreaterThanOrEqual(Math.round(cable.route.lengthMm));
    }
  });

  it("adds the declared assembly slack and nothing else", () => {
    const route = { polyline: [], lengthMm: 400, viaIds: [] };
    expect(requiredLengthMm(route)).toBe(Math.round(400 * (1 + SERVICE_SLACK)));
    expect(SERVICE_SLACK).toBe(0.15);
  });

  it("asks for more than half a case diagonal to reach the far inlet from a bottom PSU", () => {
    const { cables } = routed({ psuTopology: "bottom" });
    const feeds = cables.filter((c) => c.id.startsWith("run.backplane.power."));
    expect(feeds.length).toBe(4);
    const diagonal = Math.hypot(N6_ENVELOPE_BOX.w, N6_ENVELOPE_BOX.h, N6_ENVELOPE_BOX.d);
    const longest = Math.max(...feeds.map((c) => c.requiredMm ?? 0));
    expect(longest).toBeGreaterThan(diagonal / 2);
  });
});

describe("findings stay inside what reconstructed anchors can prove", () => {
  it("never returns a bad verdict", () => {
    for (const topology of ["bottom", "auto", "dual"] as const) {
      const { findings } = routed({ psuTopology: topology });
      expect(findings.every((f) => f.verdict !== "bad"), topology).toBe(true);
      expect(findings.every((f) => f.message.includes("需实物核对")), topology).toBe(true);
    }
  });

  it("says a missing path is undocumented, not impossible", () => {
    const { cables, findings } = routed();
    const unroutable = cables.filter((c) => !c.route);
    for (const cable of unroutable) {
      const finding = findings.find((f) => f.id === `routing.no-path:${cable.id}`);
      expect(finding?.message).toContain("手册未画出");
    }
  });

  it("reports a required length for every cable the catalog has no length for", () => {
    const { cables, findings } = routed();
    const unknownLength = cables.filter((c) => c.route && c.availableLengthMm == null);
    expect(unknownLength.length).toBeGreaterThan(0);
    for (const cable of unknownLength) {
      const finding = findings.find((f) => f.id === `routing.length-unknown:${cable.id}`);
      expect(finding, cable.id).toBeDefined();
      expect(finding!.message).toContain(`${cable.requiredMm}mm`);
      expect(finding!.evidence).toBe("unknown");
    }
  });
});

describe("segment intersection", () => {
  const box = { c: [0, 0, 0] as Vec3, w: 20, h: 20, d: 20 };

  it("catches a run straight through a part and clears one going past it", () => {
    expect(segmentHitsBox([-40, 0, 0], [40, 0, 0], box)).toBe(true);
    expect(segmentHitsBox([-40, 30, 0], [40, 30, 0], box)).toBe(false);
  });

  it("treats a run laid against a face as clear, within tolerance", () => {
    expect(segmentHitsBox([-40, 10, 0], [40, 10, 0], box, 2)).toBe(false);
    expect(segmentHitsBox([-40, 5, 0], [40, 5, 0], box, 2)).toBe(true);
  });

  it("does not report a segment that stops short of the part", () => {
    expect(segmentHitsBox([-40, 0, 0], [-15, 0, 0], box)).toBe(false);
  });
});
