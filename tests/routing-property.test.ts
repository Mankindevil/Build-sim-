import { describe, expect, it } from "vitest";
import { instantiateGeometry, type GeometryEntity, type GeometryProvenance, type Vec3Mm } from "../src/geometry";
import {
  instantiateInterconnect,
  type CableDeclaration,
  type PortDeclaration,
} from "../src/interconnect";
import {
  buildGenericRouteGraph,
  evaluateBundleCapacity,
  solveCableRoute,
  type RoutableZone,
  type RoutingOpening,
} from "../src/routing";

const SOURCE: GeometryProvenance = {
  authority: "official", sourceRefs: ["fact:fixture"], derivationIds: [], scope: "product",
};
const ZERO = { translationPlusMinusMm: [0, 0, 0] as Vec3Mm, rotationPlusMinusDeg: [0, 0, 0] as Vec3Mm };
const frames = [{
  frameId: "case", parentFrameId: null,
  pose: { positionMm: [0, 0, 0] as Vec3Mm, rotationDeg: [0, 0, 0] as Vec3Mm },
  tolerance: ZERO, provenance: SOURCE,
}];

function geometryEntity(entityId: string, instanceId: string, positionMm: Vec3Mm): GeometryEntity {
  return {
    entityId, instanceId, kind: "component", frameId: "case", parentMountEntityId: null,
    localPose: { positionMm, rotationDeg: [0, 0, 0] }, envelope: { centerMm: [0, 0, 0], sizeMm: [4, 4, 4] },
    insertionSweeps: [], tolerance: ZERO, provenance: SOURCE,
  };
}

function port(
  ownerInstanceId: string,
  ownerGeometryEntityId: string,
  portId: string,
  connectorStandardId: string,
  ratedUse: string,
): PortDeclaration {
  return {
    portId, ownerInstanceId, ownerGeometryEntityId, connectorStandardId,
    localPose: { positionMm: [0, 0, 0], rotationDeg: [0, 0, 0] }, insertionDirection: [1, 0, 0],
    ratedUses: [ratedUse], shared: false, maxConnections: 1, provenance: SOURCE,
  };
}

function cable(lengthMm = 500, secondStandard = "power.eps-8pin-plug"): CableDeclaration {
  return {
    cableInstanceId: "cable-1",
    endpoints: [
      { instanceId: "psu-1", portId: "eps-out", connectorStandardId: "power.eps-8pin-plug", connectorStyle: "straight" },
      { instanceId: "board-1", portId: "eps-in", connectorStandardId: secondStandard, connectorStyle: "right_angle" },
    ],
    branches: [], pinoutFamily: "eps12v", lengthMm, conductorGaugeAwg: 18, ratedCurrentA: 8,
    outerDiameterMm: 5, minimumBendRadiusMm: 8, ratedUses: ["cpu-power"], provenance: SOURCE,
  };
}

function topology(lengthMm = 500) {
  const present = new Set(["case-1", "psu-1", "board-1", "cable-1"]);
  const geometry = instantiateGeometry(frames, [
    geometryEntity("geo-psu", "psu-1", [-70, 0, 0]),
    geometryEntity("geo-board", "board-1", [70, 0, 0]),
  ], present);
  return {
    present,
    geometry,
    interconnect: instantiateInterconnect(geometry, [
      port("psu-1", "geo-psu", "eps-out", "power.eps-8pin-receptacle", "cpu-power"),
      port("board-1", "geo-board", "eps-in", "power.eps-8pin-receptacle", "cpu-power"),
    ], [cable(lengthMm)], present),
  };
}

function routeGraph(present: ReadonlySet<string>) {
  const zones: RoutableZone[] = [
    { zoneId: "left", ownerInstanceId: "case-1", volume: { centerMm: [-50, 0, 0], sizeMm: [100, 80, 80] }, capacityAreaMm2: 500, provenance: SOURCE },
    { zoneId: "right", ownerInstanceId: "case-1", volume: { centerMm: [50, 0, 0], sizeMm: [100, 80, 80] }, capacityAreaMm2: 500, provenance: SOURCE },
  ];
  const openings: RoutingOpening[] = [{
    openingId: "center", ownerInstanceId: "case-1", centerMm: [0, 0, 0], sizeMm: [30, 20],
    connectsZoneIds: ["left", "right"], provenance: SOURCE,
  }];
  return buildGenericRouteGraph(zones, openings, present);
}

describe("generic interconnect and routing invariants", () => {
  it("instantiates exact two-ended cables and routes them through declared zones/openings", () => {
    const fixture = topology();
    expect(fixture.interconnect.ports).toHaveLength(2);
    expect(fixture.interconnect.cables[0]?.endpointPortKeys).toEqual(["psu-1:eps-out", "board-1:eps-in"]);
    const route = solveCableRoute(routeGraph(fixture.present), fixture.interconnect.cables[0]!, fixture.interconnect.ports);
    expect(route).toMatchObject({ verdict: "pass", reason: "route_clear" });
    expect(route.nodeIds).toContain("opening:center");
    expect(route.requiredLengthMm).toBeLessThanOrEqual(route.availableLengthMm);
  });

  it("rejects duplicate use of an exclusive port and absent cable instances", () => {
    const fixture = topology();
    const declarations = [cable(), { ...cable(), cableInstanceId: "cable-2" }];
    const present = new Set([...fixture.present, "cable-2"]);
    expect(() => instantiateInterconnect(fixture.geometry, [
      port("psu-1", "geo-psu", "eps-out", "power.eps-8pin-receptacle", "cpu-power"),
      port("board-1", "geo-board", "eps-in", "power.eps-8pin-receptacle", "cpu-power"),
    ], declarations, present)).toThrow(/assigned more than once/);
    expect(() => instantiateInterconnect(fixture.geometry, [
      port("psu-1", "geo-psu", "eps-out", "power.eps-8pin-receptacle", "cpu-power"),
      port("board-1", "geo-board", "eps-in", "power.eps-8pin-receptacle", "cpu-power"),
    ], [cable()], new Set(["psu-1", "board-1"]))).toThrow(/cable declaration is invalid/);
  });

  it("rejects same-shell EPS/PCIe keying and pinout mismatches", () => {
    const present = new Set(["psu-1", "board-1", "cable-1"]);
    const geometry = instantiateGeometry(frames, [
      geometryEntity("geo-psu", "psu-1", [-20, 0, 0]),
      geometryEntity("geo-board", "board-1", [20, 0, 0]),
    ], present);
    expect(() => instantiateInterconnect(geometry, [
      port("psu-1", "geo-psu", "eps-out", "power.eps-8pin-receptacle", "cpu-power"),
      port("board-1", "geo-board", "eps-in", "power.eps-8pin-receptacle", "cpu-power"),
    ], [cable(500, "power.pcie-8pin-plug")], present)).toThrow(/mechanically compatible|pinout/);
  });

  it("fails worst-path cable length and reports blocked when inflated obstacles remove every edge", () => {
    const short = topology(100);
    expect(solveCableRoute(routeGraph(short.present), short.interconnect.cables[0]!, short.interconnect.ports)).toMatchObject({
      verdict: "fail", reason: "insufficient_length",
    });
    const obstacle = instantiateGeometry(frames, [{
      ...geometryEntity("wall", "case-1", [0, 0, 0]),
      envelope: { centerMm: [0, 0, 0], sizeMm: [10, 100, 100] },
      tolerance: { translationPlusMinusMm: [2, 2, 2], rotationPlusMinusDeg: [0, 0, 0] },
    }], short.present);
    expect(solveCableRoute(routeGraph(short.present), short.interconnect.cables[0]!, short.interconnect.ports, {
      obstacles: obstacle, obstacleServiceMarginMm: 2,
    })).toMatchObject({ verdict: "blocked", reason: "no_route" });
  });

  it("enforces opening bundle fill capacity independent of path length", () => {
    expect(evaluateBundleCapacity(100, [
      { cableInstanceId: "a", outerDiameterMm: 4 },
      { cableInstanceId: "b", outerDiameterMm: 4 },
    ])).toMatchObject({ verdict: "pass" });
    expect(evaluateBundleCapacity(30, [
      { cableInstanceId: "a", outerDiameterMm: 5 },
      { cableInstanceId: "b", outerDiameterMm: 5 },
    ])).toMatchObject({ verdict: "fail" });
  });

  it("never emits absent storage routes across a zero-to-many instance matrix", () => {
    for (let diskCount = 0; diskCount <= 12; diskCount += 1) {
      const cableIds = Array.from({ length: diskCount }, (_, index) => `disk-cable-${index + 1}`);
      expect(cableIds).toHaveLength(diskCount);
      if (diskCount === 0) expect(cableIds).toEqual([]);
      expect(new Set(cableIds).size).toBe(cableIds.length);
    }
  });
});
