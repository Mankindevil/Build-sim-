import { aabbBounds, aabbContains, signedAabbClearanceMm } from "../geometry/tolerance";
import { validFiniteVec3, type Aabb3Mm, type GeometryProvenance, type Vec3Mm } from "../geometry/types";

export interface RoutableZone {
  readonly zoneId: string;
  readonly ownerInstanceId: string;
  readonly volume: Aabb3Mm;
  readonly capacityAreaMm2: number;
  readonly provenance: GeometryProvenance;
}

export interface RoutingOpening {
  readonly openingId: string;
  readonly ownerInstanceId: string;
  readonly centerMm: Vec3Mm;
  readonly sizeMm: readonly [number, number];
  readonly connectsZoneIds: readonly [string, string];
  readonly provenance: GeometryProvenance;
}

export interface RouteGraphNode {
  readonly nodeId: string;
  readonly positionMm: Vec3Mm;
  readonly kind: "zone" | "opening";
  readonly zoneIds: readonly string[];
  readonly capacityAreaMm2: number;
}

export interface RouteGraphEdge {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly lengthMm: number;
  readonly capacityAreaMm2: number;
  readonly zoneIds: readonly string[];
}

export interface GenericRouteGraph {
  readonly schemaVersion: "generic-route-graph-v1";
  readonly nodes: readonly RouteGraphNode[];
  readonly edges: readonly RouteGraphEdge[];
  readonly zones: readonly RoutableZone[];
}

const distance = (left: Vec3Mm, right: Vec3Mm): number => Math.hypot(
  right[0] - left[0], right[1] - left[1], right[2] - left[2],
);

const openingArea = (opening: RoutingOpening): number => opening.sizeMm[0] * opening.sizeMm[1];

function zoneCenterNode(zone: RoutableZone): RouteGraphNode {
  return {
    nodeId: `zone:${zone.zoneId}`,
    positionMm: [...zone.volume.centerMm] as Vec3Mm,
    kind: "zone",
    zoneIds: [zone.zoneId],
    capacityAreaMm2: zone.capacityAreaMm2,
  };
}

export function pointInZone(point: Vec3Mm, zone: RoutableZone): boolean {
  return aabbContains(zone.volume, { centerMm: point, sizeMm: [0.000001, 0.000001, 0.000001] });
}

/** Builds connectivity solely from declared routable volumes and openings. */
export function buildGenericRouteGraph(
  zones: readonly RoutableZone[],
  openings: readonly RoutingOpening[],
  presentInstanceIds: ReadonlySet<string>,
): GenericRouteGraph {
  const zoneById = new Map<string, RoutableZone>();
  for (const zone of zones) {
    if (!zone.zoneId || zoneById.has(zone.zoneId) || !presentInstanceIds.has(zone.ownerInstanceId)
      || !Number.isFinite(zone.capacityAreaMm2) || zone.capacityAreaMm2 <= 0) {
      throw new TypeError("routing zone is invalid or references an absent instance");
    }
    aabbBounds(zone.volume);
    zoneById.set(zone.zoneId, structuredClone(zone));
  }
  const nodes = new Map<string, RouteGraphNode>();
  for (const zone of zoneById.values()) nodes.set(`zone:${zone.zoneId}`, zoneCenterNode(zone));
  const edges: RouteGraphEdge[] = [];
  const edgeIds = new Set<string>();
  const addEdge = (from: RouteGraphNode, to: RouteGraphNode, capacityAreaMm2: number, zoneIds: readonly string[]) => {
    const pair = [from.nodeId, to.nodeId].sort();
    const edgeId = `edge:${pair[0]}:${pair[1]}`;
    if (edgeIds.has(edgeId)) return;
    edgeIds.add(edgeId);
    edges.push({ edgeId, fromNodeId: from.nodeId, toNodeId: to.nodeId, lengthMm: distance(from.positionMm, to.positionMm), capacityAreaMm2, zoneIds: [...zoneIds].sort() });
  };
  for (const opening of openings) {
    if (!opening.openingId || nodes.has(`opening:${opening.openingId}`)
      || !presentInstanceIds.has(opening.ownerInstanceId) || !validFiniteVec3(opening.centerMm)
      || opening.sizeMm.some((entry) => !Number.isFinite(entry) || entry <= 0)
      || opening.connectsZoneIds[0] === opening.connectsZoneIds[1]) {
      throw new TypeError("routing opening is invalid or references an absent instance");
    }
    const connected = opening.connectsZoneIds.map((zoneId) => zoneById.get(zoneId));
    if (connected.some((zone) => !zone)) throw new TypeError("routing opening references a missing zone");
    const area = openingArea(opening);
    const node: RouteGraphNode = {
      nodeId: `opening:${opening.openingId}`,
      positionMm: [...opening.centerMm] as Vec3Mm,
      kind: "opening",
      zoneIds: [...opening.connectsZoneIds].sort(),
      capacityAreaMm2: area,
    };
    nodes.set(node.nodeId, node);
    for (const zone of connected as RoutableZone[]) {
      addEdge(nodes.get(`zone:${zone.zoneId}`)!, node, Math.min(area, zone.capacityAreaMm2), [zone.zoneId]);
    }
  }
  const zoneList = [...zoneById.values()];
  for (let leftIndex = 0; leftIndex < zoneList.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < zoneList.length; rightIndex += 1) {
      const left = zoneList[leftIndex]!;
      const right = zoneList[rightIndex]!;
      // Face contact does not create a passage. A declared opening is required
      // across a panel; only volumes with positive interior overlap join directly.
      if (signedAabbClearanceMm(left.volume, right.volume) < 0) {
        addEdge(nodes.get(`zone:${left.zoneId}`)!, nodes.get(`zone:${right.zoneId}`)!, Math.min(left.capacityAreaMm2, right.capacityAreaMm2), [left.zoneId, right.zoneId]);
      }
    }
  }
  return {
    schemaVersion: "generic-route-graph-v1",
    nodes: [...nodes.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    edges: edges.sort((left, right) => left.edgeId.localeCompare(right.edgeId)),
    zones: zoneList.sort((left, right) => left.zoneId.localeCompare(right.zoneId)),
  };
}
