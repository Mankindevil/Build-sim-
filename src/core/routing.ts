import type { EvidenceLevel } from "./evidence";
import {
  boxContainsPoint,
  distanceMm,
  maxOn,
  minOn,
  segmentHitsBox,
  type CenteredBox,
  type PlacedPart,
  type Vec3,
} from "./geometry";

/**
 * Cable routing over the geometry source of truth, in millimetres.
 *
 * Three ideas keep this from becoming a second, competing coordinate system:
 *
 * - A port is declared as a **face plus an offset on that face**, never as an
 *   absolute point. Swap a 100 mm PSU for a 130 mm one, or move it from the rear
 *   shelf to the bottom rack, and its sockets travel with it.
 * - What a cable may pass through is a **graph**, not a rule. The deck has no
 *   edge across it unless a `deck_opening` waypoint declares one, so "this cable
 *   cannot get to the other chamber" falls out of the data instead of being
 *   written twice.
 * - Every anchor here is a reconstruction from schematic manual figures, so no
 *   routing verdict may exceed `warn`. See PROVENANCE.
 */

export type PortFace = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

export interface PortDecl {
  id: string;
  onPart: string;
  face: PortFace;
  /** Millimetres from the face centre, in that face's own two axes. */
  offset: [number, number];
  kind: string;
  /** Straight travel the plug needs along the face normal to seat or release. */
  insertionMm: number;
  /** Plug cross-section on the face, `[u, v]`; sizes the insertion sweep. */
  sectionMm: [number, number];
  source: string;
  /** Restricts a declaration to a part mounted in one of these slots. */
  whenSlot?: string[];
}

export interface Port {
  id: string;
  partId: string;
  at: Vec3;
  /** Unit outward normal: the direction the plug is pulled. */
  normal: Vec3;
  kind: string;
  insertionMm: number;
  sectionMm: [number, number];
  source: string;
}

/** `[u axis, v axis, normal axis, normal sign]` for each face. */
const FACE_AXES: Record<PortFace, [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2, 1 | -1]> = {
  "+x": [2, 1, 0, 1],
  "-x": [2, 1, 0, -1],
  "+y": [0, 2, 1, 1],
  "-y": [0, 2, 1, -1],
  "+z": [0, 1, 2, 1],
  "-z": [0, 1, 2, -1],
};

const HALF: [ "w", "h", "d" ] = ["w", "h", "d"];

function halfExtent(box: CenteredBox, axis: 0 | 1 | 2): number {
  return box[HALF[axis]!] / 2;
}

/**
 * One declaration repeated along an axis: the nine backplane outlets are one
 * connector spec at the tray pitch, so correcting that pitch moves all nine.
 */
export interface PortRowDecl extends Omit<PortDecl, "offset"> {
  offsetsAlong: "x" | "y" | "z";
  offsetPitchMm: number;
  /** Fixed offset on the face's other axis. */
  offsetV: number;
}

/** Face + offset → an absolute anchor that moves when the part does. */
export function resolvePort(part: PlacedPart, decl: PortDecl): Port {
  const [uAxis, vAxis, nAxis, sign] = FACE_AXES[decl.face];
  const at: Vec3 = [...part.box.c] as Vec3;
  at[uAxis] += decl.offset[0];
  at[vAxis] += decl.offset[1];
  at[nAxis] += sign * halfExtent(part.box, nAxis);
  const normal: Vec3 = [0, 0, 0];
  normal[nAxis] = sign;
  return {
    id: decl.id,
    partId: part.id,
    at,
    normal,
    kind: decl.kind,
    insertionMm: decl.insertionMm,
    sectionMm: decl.sectionMm,
    source: decl.source,
  };
}

/**
 * The volume a hand and plug sweep to seat or unseat the connector: the plug
 * cross-section extruded along the normal. Anything solid inside it is the
 * difference between "fits on paper" and "fits with the cable attached".
 */
export function insertionSweep(port: Port): CenteredBox {
  const nAxis = port.normal.findIndex((v) => v !== 0) as 0 | 1 | 2;
  const sign = port.normal[nAxis]! > 0 ? 1 : -1;
  const c: Vec3 = [...port.at] as Vec3;
  c[nAxis] += (sign * port.insertionMm) / 2;
  const size: [number, number, number] = [0, 0, 0];
  const axes: (0 | 1 | 2)[] = [0, 1, 2];
  const [uAxis, vAxis] = axes.filter((a) => a !== nAxis) as [0 | 1 | 2, 0 | 1 | 2];
  size[uAxis] = port.sectionMm[0];
  size[vAxis] = port.sectionMm[1];
  size[nAxis] = port.insertionMm;
  return { c, w: size[0], h: size[1], d: size[2] };
}

export type WaypointKind = "grommet" | "channel" | "deck_opening" | "free";

export interface Waypoint {
  id: string;
  c: Vec3;
  kind: WaypointKind;
  /** Narrowest dimension of the opening; a hint for the reader, not a capacity model. */
  apertureMm: number;
  source: string;
}

/** Waypoints that pierce a structure rather than sit in free space. */
export function isOpening(w: Waypoint): boolean {
  return w.kind === "deck_opening" || w.kind === "grommet";
}

/**
 * The parts an opening is a hole in — derived by asking which boxes contain the
 * waypoint, rather than naming the deck in code. A cable through a declared
 * grommet is not "cutting through" the panel the grommet is set into.
 */
export function piercedParts(w: Waypoint, parts: PlacedPart[]): Set<string> {
  if (!isOpening(w)) return new Set();
  return new Set(parts.filter((p) => boxContainsPoint(p.box, w.c, 1)).map((p) => p.id));
}

export interface RouteEdge {
  from: string;
  to: string;
  note?: string;
}

export interface RouteGraph {
  waypoints: Map<string, Waypoint>;
  /** Adjacency with straight-line lengths. */
  neighbours: Map<string, { id: string; lengthMm: number }[]>;
}

export function buildRouteGraph(waypoints: Waypoint[], edges: RouteEdge[]): RouteGraph {
  const byId = new Map(waypoints.map((w) => [w.id, w]));
  const neighbours = new Map<string, { id: string; lengthMm: number }[]>();
  for (const w of waypoints) neighbours.set(w.id, []);
  for (const edge of edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;
    const lengthMm = distanceMm(a.c, b.c);
    neighbours.get(a.id)!.push({ id: b.id, lengthMm });
    neighbours.get(b.id)!.push({ id: a.id, lengthMm });
  }
  return { waypoints: byId, neighbours };
}

export interface Route {
  polyline: Vec3[];
  lengthMm: number;
  viaIds: string[];
}

/** Assembly slack on top of the geometric path. A declared allowance, not a physical quantity. */
export const SERVICE_SLACK = 0.15;

export function requiredLengthMm(route: Route): number {
  return Math.round(route.lengthMm * (1 + SERVICE_SLACK));
}

function polylineLength(points: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceMm(points[i - 1]!, points[i]!);
  return total;
}

/**
 * Shortest waypoint path between two ports, with a straight leg from each port to
 * its entry waypoint. `null` when the graph declares no way through — which is a
 * statement about the manual, not about the case.
 *
 * Entry legs are collision-checked when `obstacles` are given, because otherwise
 * the cheapest way into the graph is through the deck: a cable that dives from
 * the PSU straight down to the backplane is shorter than one that goes round via
 * the declared opening, and it is also impossible. A leg that clears everything
 * always wins; if none does, the shortest blocked one is still returned so the
 * blocking part can be named rather than the run reported as unroutable.
 */
export function routeCable(
  graph: RouteGraph,
  from: Port,
  to: Port,
  options: { entryLimit?: number; obstacles?: PlacedPart[] } = {},
): Route | null {
  const limit = options.entryLimit ?? 6;
  const obstacles = (options.obstacles ?? []).filter(
    (p) =>
      p.kind !== "clearance" &&
      p.kind !== "conflict" &&
      p.kind !== "reserve" &&
      p.id !== from.partId &&
      p.id !== to.partId &&
      p.mountedOn !== from.partId &&
      p.mountedOn !== to.partId,
  );
  // A declared opening *is* a hole in whatever it sits in, so that panel cannot
  // block a leg ending there. Every other part still does.
  const legClear = (port: Port, w: Waypoint): boolean => {
    const pierced = piercedParts(w, obstacles);
    return !obstacles.some((p) => !pierced.has(p.id) && segmentHitsBox(port.at, w.c, p.box, 2));
  };

  const entries = (port: Port): { id: string; clear: boolean }[] =>
    [...graph.waypoints.values()]
      .sort((a, b) => distanceMm(port.at, a.c) - distanceMm(port.at, b.c))
      .slice(0, limit)
      .map((w) => ({ id: w.id, clear: legClear(port, w) }));

  let best: Route | null = null;
  let bestClear = false;
  for (const start of entries(from)) {
    for (const end of entries(to)) {
      const via = shortestPath(graph, start.id, end.id);
      if (!via) continue;
      const polyline = [from.at, ...via.map((id) => graph.waypoints.get(id)!.c), to.at];
      const lengthMm = polylineLength(polyline);
      const clear = start.clear && end.clear;
      if (best && bestClear && !clear) continue;
      if (!best || (clear && !bestClear) || lengthMm < best.lengthMm) {
        best = { polyline, lengthMm, viaIds: via };
        bestClear = clear;
      }
    }
  }
  return best;
}

function shortestPath(graph: RouteGraph, startId: string, endId: string): string[] | null {
  if (!graph.waypoints.has(startId) || !graph.waypoints.has(endId)) return null;
  if (startId === endId) return [startId];

  const dist = new Map<string, number>([[startId, 0]]);
  const prev = new Map<string, string>();
  const pending = new Set(graph.waypoints.keys());

  while (pending.size) {
    let current: string | null = null;
    let currentDist = Infinity;
    for (const id of pending) {
      const d = dist.get(id) ?? Infinity;
      if (d < currentDist) {
        current = id;
        currentDist = d;
      }
    }
    if (current === null || currentDist === Infinity) break;
    if (current === endId) break;
    pending.delete(current);
    for (const edge of graph.neighbours.get(current) ?? []) {
      if (!pending.has(edge.id)) continue;
      const candidate = currentDist + edge.lengthMm;
      if (candidate < (dist.get(edge.id) ?? Infinity)) {
        dist.set(edge.id, candidate);
        prev.set(edge.id, current);
      }
    }
  }

  if (!dist.has(endId)) return null;
  const path: string[] = [endId];
  let cursor = endId;
  while (cursor !== startId) {
    const parent = prev.get(cursor);
    if (parent === undefined) return null;
    path.unshift(parent);
    cursor = parent;
  }
  return path;
}

/** A part is exempt from a port's own sweep when it owns or is owned by it. */
function sameAssembly(part: PlacedPart, owner: PlacedPart | undefined): boolean {
  if (!owner) return false;
  if (part.id === owner.id) return true;
  if (part.mountedOn === owner.id || owner.mountedOn === part.id) return true;
  return Boolean(part.group && part.group === owner.group);
}

export interface InsertionBlock {
  partId: string;
  partName: string;
  /** How far into the sweep the part reaches, along the normal. */
  depthMm: number;
  /** True when the normal is blocked but the sides are open: an angled plug fixes it. */
  sidewaysClear: boolean;
}

/**
 * Solids inside a port's insertion sweep. The part the port belongs to, its
 * parent and its children are exempt: a socket is supposed to be inside the
 * component that carries it.
 */
export function insertionBlocks(port: Port, parts: PlacedPart[]): InsertionBlock[] {
  const sweep = insertionSweep(port);
  const owner = parts.find((p) => p.id === port.partId);
  const nAxis = port.normal.findIndex((v) => v !== 0) as 0 | 1 | 2;
  const axis = (["x", "y", "z"] as const)[nAxis]!;
  const blocks: InsertionBlock[] = [];

  for (const part of parts) {
    if (part.kind === "clearance" || part.kind === "conflict" || part.kind === "reserve") continue;
    if (sameAssembly(part, owner)) continue;
    const overlap = Math.min(
      Math.min(maxOn(sweep, axis), maxOn(part.box, axis)) -
        Math.max(minOn(sweep, axis), minOn(part.box, axis)),
      port.insertionMm,
    );
    if (overlap <= 0) continue;
    if (!overlapsOtherAxes(sweep, part.box, nAxis)) continue;
    blocks.push({
      partId: part.id,
      partName: part.name,
      depthMm: Math.round(overlap * 10) / 10,
      sidewaysClear: sidewaysClear(port, part),
    });
  }
  return blocks.sort((a, b) => b.depthMm - a.depthMm);
}

function overlapsOtherAxes(sweep: CenteredBox, box: CenteredBox, nAxis: 0 | 1 | 2): boolean {
  const axes = (["x", "y", "z"] as const).filter((_, i) => i !== nAxis);
  return axes.every((a) => Math.min(maxOn(sweep, a), maxOn(box, a)) - Math.max(minOn(sweep, a), minOn(box, a)) > 0);
}

/**
 * Whether the plug could come in from the side instead. Approximated by asking
 * if the obstruction stops short of the port's own plane: if it does, there is
 * room beside the socket and an angled connector is the fix.
 */
function sidewaysClear(port: Port, part: PlacedPart): boolean {
  const nAxis = port.normal.findIndex((v) => v !== 0) as 0 | 1 | 2;
  const axis = (["x", "y", "z"] as const)[nAxis]!;
  const sign = port.normal[nAxis]! > 0 ? 1 : -1;
  const nearFace = sign > 0 ? minOn(part.box, axis) : -maxOn(part.box, axis);
  const portPlane = sign > 0 ? port.at[nAxis]! : -port.at[nAxis]!;
  return nearFace - portPlane > 2;
}

export interface SegmentBlock {
  partId: string;
  partName: string;
  /** Index of the polyline segment, so the UI can point at it. */
  segment: number;
}

/**
 * Parts a route's polyline cuts through, ignoring the two parts it connects.
 * `piercedAt` maps a polyline vertex to the parts a declared opening there is a
 * hole in, so passing through the hole is not counted as passing through the panel.
 */
export function segmentBlocks(
  route: Route,
  parts: PlacedPart[],
  exemptPartIds: string[] = [],
  piercedAt: Map<number, Set<string>> = new Map(),
): SegmentBlock[] {
  const exempt = new Set(exemptPartIds);
  const hits: SegmentBlock[] = [];
  for (let i = 1; i < route.polyline.length; i++) {
    const a = route.polyline[i - 1]!;
    const b = route.polyline[i]!;
    const throughOpening = new Set([
      ...(piercedAt.get(i - 1) ?? []),
      ...(piercedAt.get(i) ?? []),
    ]);
    for (const part of parts) {
      if (exempt.has(part.id)) continue;
      if (part.kind === "clearance" || part.kind === "conflict" || part.kind === "reserve") continue;
      if (part.mountedOn && exempt.has(part.mountedOn)) continue;
      if (throughOpening.has(part.id)) continue;
      // 2 mm of tolerance: a run laid against a face is normal, a run through
      // the middle of the drive cage is not.
      if (segmentHitsBox(a, b, part.box, 2)) {
        hits.push({ partId: part.id, partName: part.name, segment: i - 1 });
      }
    }
  }
  return hits;
}

export interface CableRunSpec {
  id: string;
  label: string;
  fromPortId: string;
  toPortId: string;
  /** Catalog cable, when the run has one; its `lengthMm` is checked if present. */
  cableSkuId?: string;
  availableLengthMm?: number | null;
  kind: "power" | "data" | "fan" | "other";
}

export interface RoutedCable extends CableRunSpec {
  from: Port;
  to: Port;
  route: Route | null;
  requiredMm: number | null;
  insertion: { portId: string; blocks: InsertionBlock[] }[];
  segmentHits: SegmentBlock[];
  evidence: EvidenceLevel;
}

export function routeRun(
  spec: CableRunSpec,
  from: Port,
  to: Port,
  graph: RouteGraph,
  parts: PlacedPart[],
): RoutedCable {
  const route = routeCable(graph, from, to, { obstacles: parts });
  // Polyline vertex 0 is the source port, so waypoint k sits at vertex k + 1.
  const openings = new Map<number, Set<string>>();
  (route?.viaIds ?? []).forEach((id, k) => {
    const pierced = piercedParts(graph.waypoints.get(id)!, parts);
    if (pierced.size) openings.set(k + 1, pierced);
  });
  return {
    ...spec,
    from,
    to,
    route,
    requiredMm: route ? requiredLengthMm(route) : null,
    insertion: [
      { portId: from.id, blocks: insertionBlocks(from, parts) },
      { portId: to.id, blocks: insertionBlocks(to, parts) },
    ],
    segmentHits: route ? segmentBlocks(route, parts, [from.partId, to.partId], openings) : [],
    // Every anchor in routing.json is reconstructed from schematic figures.
    evidence: "inferred",
  };
}
