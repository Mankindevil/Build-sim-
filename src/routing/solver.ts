import { inflateAabb } from "../geometry/tolerance";
import type { ResolvedGeometryEntity, Vec3Mm } from "../geometry/types";
import type { InstantiatedCable, InstantiatedPort } from "../interconnect";
import { portKey } from "../interconnect";
import { evaluatePolylineBends, type BendCheck } from "./bend";
import { pointInZone, type GenericRouteGraph, type RouteGraphEdge, type RouteGraphNode } from "./graph";

export interface CableRouteResult {
  readonly schemaVersion: "cable-route-result-v1";
  readonly cableInstanceId: string;
  readonly fromPortKey: string;
  readonly toPortKey: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly polylineMm: readonly Vec3Mm[];
  readonly geometricLengthMm: number;
  readonly requiredLengthMm: number;
  readonly availableLengthMm: number;
  readonly bends: readonly BendCheck[];
  readonly verdict: "pass" | "fail" | "blocked";
  readonly reason: "route_clear" | "no_route" | "insufficient_length" | "bend_radius";
}

function distance(left: Vec3Mm, right: Vec3Mm): number {
  return Math.hypot(right[0] - left[0], right[1] - left[1], right[2] - left[2]);
}

function segmentHitsBox(from: Vec3Mm, to: Vec3Mm, center: Vec3Mm, size: Vec3Mm): boolean {
  let low = 0;
  let high = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    const minimum = center[axis]! - size[axis]! / 2;
    const maximum = center[axis]! + size[axis]! / 2;
    const delta = to[axis]! - from[axis]!;
    if (Math.abs(delta) < 1e-9) {
      if (from[axis]! < minimum || from[axis]! > maximum) return false;
      continue;
    }
    const first = (minimum - from[axis]!) / delta;
    const second = (maximum - from[axis]!) / delta;
    low = Math.max(low, Math.min(first, second));
    high = Math.min(high, Math.max(first, second));
    if (low > high) return false;
  }
  return true;
}

function shortestPath(
  graph: GenericRouteGraph,
  startIds: readonly string[],
  endIds: ReadonlySet<string>,
  blockedEdgeIds: ReadonlySet<string>,
): { nodeIds: string[]; edgeIds: string[] } | null {
  const nodeIds = new Set(graph.nodes.map((node) => node.nodeId));
  const distanceById = new Map<string, number>();
  const previous = new Map<string, { nodeId: string; edgeId: string }>();
  const pending = new Set(nodeIds);
  for (const startId of startIds) if (nodeIds.has(startId)) distanceById.set(startId, 0);
  while (pending.size) {
    let current: string | null = null;
    let currentDistance = Infinity;
    for (const id of pending) {
      const value = distanceById.get(id) ?? Infinity;
      if (value < currentDistance) { current = id; currentDistance = value; }
    }
    if (current === null || !Number.isFinite(currentDistance)) break;
    if (endIds.has(current)) {
      const path = [current];
      const edges: string[] = [];
      while (!startIds.includes(path[0]!)) {
        const parent = previous.get(path[0]!);
        if (!parent) return null;
        path.unshift(parent.nodeId);
        edges.unshift(parent.edgeId);
      }
      return { nodeIds: path, edgeIds: edges };
    }
    pending.delete(current);
    for (const edge of graph.edges) {
      if (blockedEdgeIds.has(edge.edgeId)) continue;
      const next = edge.fromNodeId === current ? edge.toNodeId : edge.toNodeId === current ? edge.fromNodeId : null;
      if (!next || !pending.has(next)) continue;
      const candidate = currentDistance + edge.lengthMm;
      if (candidate < (distanceById.get(next) ?? Infinity)) {
        distanceById.set(next, candidate);
        previous.set(next, { nodeId: current, edgeId: edge.edgeId });
      }
    }
  }
  return null;
}

export interface RouteCableOptions {
  readonly obstacles?: readonly ResolvedGeometryEntity[];
  readonly obstacleServiceMarginMm?: number;
  readonly serviceSlackFraction?: number;
  readonly serviceLoopMm?: number;
}

export interface RouteGeometryResult {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly polylineMm: readonly Vec3Mm[];
  readonly geometricLengthMm: number;
}

/**
 * Resolve the geometric part of a route without inventing cable properties.
 * This is used by spatial previews when endpoint positions are governed but a
 * cable length/gauge has not been selected yet. Electrical and cable verdicts
 * remain unknown until a concrete cable instance is available.
 */
export function solveRouteGeometry(
  graph: GenericRouteGraph,
  fromPositionMm: Vec3Mm,
  toPositionMm: Vec3Mm,
  options: Pick<RouteCableOptions, "obstacles" | "obstacleServiceMarginMm"> = {},
): RouteGeometryResult | null {
  const startNodes = graph.zones.filter((zone) => pointInZone(fromPositionMm, zone)).map((zone) => `zone:${zone.zoneId}`);
  const endNodes = new Set(graph.zones.filter((zone) => pointInZone(toPositionMm, zone)).map((zone) => `zone:${zone.zoneId}`));
  if (startNodes.length === 0 || endNodes.size === 0) return null;
  const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const margin = options.obstacleServiceMarginMm ?? 0;
  if (!Number.isFinite(margin) || margin < 0) throw new TypeError("route obstacle margin is invalid");
  const obstacles = (options.obstacles ?? []).map((entity) => inflateAabb(entity.worstCaseAabb, margin));
  const blockedEdgeIds = new Set(graph.edges.filter((edge) => {
    const left = nodes.get(edge.fromNodeId)!;
    const right = nodes.get(edge.toNodeId)!;
    return obstacles.some((box) => segmentHitsBox(left.positionMm, right.positionMm, box.centerMm, box.sizeMm));
  }).map((edge) => edge.edgeId));
  const path = shortestPath(graph, startNodes, endNodes, blockedEdgeIds);
  if (!path) return null;
  const polylineMm = [fromPositionMm, ...path.nodeIds.map((id) => nodes.get(id)!.positionMm), toPositionMm];
  let geometricLengthMm = 0;
  for (let index = 1; index < polylineMm.length; index += 1) geometricLengthMm += distance(polylineMm[index - 1]!, polylineMm[index]!);
  return { ...path, polylineMm, geometricLengthMm };
}

export function solveCableRoute(
  graph: GenericRouteGraph,
  cable: InstantiatedCable,
  ports: readonly InstantiatedPort[],
  options: RouteCableOptions = {},
): CableRouteResult {
  const byPortKey = new Map(ports.map((port) => [portKey(port.ownerInstanceId, port.portId), port]));
  const fromPortKey = cable.endpointPortKeys[0];
  const toPortKey = cable.endpointPortKeys[1];
  const from = byPortKey.get(fromPortKey);
  const to = byPortKey.get(toPortKey);
  if (!from || !to) throw new TypeError("route cable endpoints are not instantiated");
  const geometry = solveRouteGeometry(graph, from.worldPose.positionMm, to.worldPose.positionMm, options);
  if (!geometry) return blocked(cable, fromPortKey, toPortKey, "no_route");
  const { nodeIds, edgeIds, polylineMm, geometricLengthMm } = geometry;
  const serviceSlackFraction = options.serviceSlackFraction ?? 0.15;
  const serviceLoopMm = options.serviceLoopMm ?? 0;
  if (!Number.isFinite(serviceSlackFraction) || serviceSlackFraction < 0 || !Number.isFinite(serviceLoopMm) || serviceLoopMm < 0) {
    throw new TypeError("route service allowance is invalid");
  }
  const requiredLengthMm = geometricLengthMm * (1 + serviceSlackFraction) + serviceLoopMm;
  const bends = evaluatePolylineBends(polylineMm, cable.minimumBendRadiusMm);
  const bendFailure = bends.some((bend) => !bend.pass);
  const lengthFailure = requiredLengthMm > cable.lengthMm;
  return {
    schemaVersion: "cable-route-result-v1",
    cableInstanceId: cable.cableInstanceId,
    fromPortKey,
    toPortKey,
    nodeIds,
    edgeIds,
    polylineMm,
    geometricLengthMm,
    requiredLengthMm,
    availableLengthMm: cable.lengthMm,
    bends,
    verdict: lengthFailure || bendFailure ? "fail" : "pass",
    reason: lengthFailure ? "insufficient_length" : bendFailure ? "bend_radius" : "route_clear",
  };
}

function blocked(
  cable: InstantiatedCable,
  fromPortKey: string,
  toPortKey: string,
  reason: "no_route",
): CableRouteResult {
  return {
    schemaVersion: "cable-route-result-v1",
    cableInstanceId: cable.cableInstanceId,
    fromPortKey,
    toPortKey,
    nodeIds: [], edgeIds: [], polylineMm: [], geometricLengthMm: 0, requiredLengthMm: 0,
    availableLengthMm: cable.lengthMm, bends: [], verdict: "blocked", reason,
  };
}

export function routeEdgeUsage(
  routes: readonly CableRouteResult[],
): ReadonlyMap<string, readonly string[]> {
  const values = new Map<string, string[]>();
  for (const route of routes) for (const edgeId of route.edgeIds) {
    const members = values.get(edgeId) ?? [];
    members.push(route.cableInstanceId);
    values.set(edgeId, members);
  }
  return new Map([...values].map(([edgeId, members]) => [edgeId, members.sort()]));
}
