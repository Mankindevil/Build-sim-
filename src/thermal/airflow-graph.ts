import type { EvidenceLevel } from "../core/evidence";
import { solveFanOperatingPoint } from "./fan-operating-point";
import { assertRange, type AirflowEdge, type AirflowNetwork, type AirflowNetworkResult, type NumericRange } from "./types";

const AMBIENT = "@ambient";

function node(value: string | null): string { return value ?? AMBIENT; }

function validateNetwork(network: AirflowNetwork): void {
  if (network.schemaVersion !== "airflow-network-v1" || network.chambers.length === 0) throw new TypeError("airflow network invalid");
  const chamberIds = new Set<string>();
  for (const chamber of network.chambers) {
    if (!chamber.chamberId || chamberIds.has(chamber.chamberId) || !Number.isFinite(chamber.volumeLitres) || chamber.volumeLitres <= 0
      || (chamber.maximumTemperatureC !== null && (!Number.isFinite(chamber.maximumTemperatureC) || chamber.maximumTemperatureC <= -273.15))) {
      throw new TypeError("airflow chamber invalid");
    }
    chamberIds.add(chamber.chamberId);
  }
  const edgeIds = new Set<string>();
  for (const edge of network.edges) {
    if (!edge.edgeId || edgeIds.has(edge.edgeId) || (edge.fromChamberId === null && edge.toChamberId === null)
      || (edge.fromChamberId !== null && !chamberIds.has(edge.fromChamberId))
      || (edge.toChamberId !== null && !chamberIds.has(edge.toChamberId))) throw new TypeError("airflow edge invalid");
    edgeIds.add(edge.edgeId);
    assertRange(edge.resistancePaPerCfm2, `airflow edge ${edge.edgeId} resistance`, { nonnegative: true });
    if ((edge.kind === "fan") !== Boolean(edge.fanCurve)) throw new TypeError("fan airflow edge curve invalid");
  }
}

function shortestResistance(
  network: AirflowNetwork,
  start: string,
  end: string,
  bound: "lo" | "hi",
  excludedEdgeId: string,
): number | null {
  if (start === end) return 0;
  const nodes = new Set([AMBIENT, ...network.chambers.map(({ chamberId }) => chamberId)]);
  const pending = new Set(nodes);
  const distances = new Map<string, number>([[start, 0]]);
  while (pending.size) {
    let current: string | null = null;
    let currentDistance = Infinity;
    for (const candidate of pending) {
      const distance = distances.get(candidate) ?? Infinity;
      if (distance < currentDistance) { current = candidate; currentDistance = distance; }
    }
    if (current === null || !Number.isFinite(currentDistance)) return null;
    if (current === end) return currentDistance;
    pending.delete(current);
    for (const edge of network.edges) {
      if (!edge.enabled || edge.edgeId === excludedEdgeId || edge.kind === "fan") continue;
      const left = node(edge.fromChamberId);
      const right = node(edge.toChamberId);
      const next = left === current ? right : right === current ? left : null;
      if (!next || !pending.has(next)) continue;
      const candidate = currentDistance + edge.resistancePaPerCfm2[bound];
      if (candidate < (distances.get(next) ?? Infinity)) distances.set(next, candidate);
    }
  }
  return null;
}

function systemResistance(network: AirflowNetwork, fan: AirflowEdge): NumericRange | null {
  const beforeStart = node(fan.fromChamberId);
  const afterStart = node(fan.toChamberId);
  const beforeLo = shortestResistance(network, AMBIENT, beforeStart, "lo", fan.edgeId);
  const beforeHi = shortestResistance(network, AMBIENT, beforeStart, "hi", fan.edgeId);
  const afterLo = shortestResistance(network, afterStart, AMBIENT, "lo", fan.edgeId);
  const afterHi = shortestResistance(network, afterStart, AMBIENT, "hi", fan.edgeId);
  if ([beforeLo, beforeHi, afterLo, afterHi].some((value) => value === null)) return null;
  return {
    lo: beforeLo! + fan.resistancePaPerCfm2.lo + afterLo!,
    hi: beforeHi! + fan.resistancePaPerCfm2.hi + afterHi!,
  };
}

function passiveComponent(network: AirflowNetwork, chamberId: string): Set<string> {
  const result = new Set([chamberId]);
  const pending = [chamberId];
  while (pending.length) {
    const current = pending.pop()!;
    for (const edge of network.edges) {
      if (!edge.enabled || edge.kind === "fan" || edge.fromChamberId === null || edge.toChamberId === null) continue;
      const next = edge.fromChamberId === current ? edge.toChamberId : edge.toChamberId === current ? edge.fromChamberId : null;
      if (next && !result.has(next)) { result.add(next); pending.push(next); }
    }
  }
  return result;
}

function weakest(values: readonly EvidenceLevel[]): EvidenceLevel {
  const rank: Record<EvidenceLevel, number> = { official: 0, standard: 1, inferred: 2, unknown: 3 };
  return values.reduce((result, value) => rank[value] > rank[result] ? value : result, "official");
}

export function solveAirflowNetwork(network: AirflowNetwork): AirflowNetworkResult {
  validateNetwork(network);
  const blockedReasonCodes: string[] = [];
  const fanOperatingPoints = network.edges.filter((edge) => edge.kind === "fan" && edge.enabled).flatMap((edge) => {
    const resistance = systemResistance(network, edge);
    if (!resistance) {
      blockedReasonCodes.push(`fan-path-open:${edge.edgeId}`);
      return [];
    }
    return [solveFanOperatingPoint(edge.edgeId, edge.fanCurve!, resistance)];
  });
  const fanById = new Map(fanOperatingPoints.map((point) => [point.edgeId, point]));
  const chambers = network.chambers.map((chamber) => {
    const component = passiveComponent(network, chamber.chamberId);
    const fanEdges = network.edges.filter((edge) => edge.kind === "fan" && edge.enabled
      && ((edge.fromChamberId !== null && component.has(edge.fromChamberId)) || (edge.toChamberId !== null && component.has(edge.toChamberId))));
    const points = fanEdges.flatMap((edge) => fanById.get(edge.edgeId) ? [fanById.get(edge.edgeId)!] : []);
    if (points.length === 0) blockedReasonCodes.push(`chamber-airflow-missing:${chamber.chamberId}`);
    return {
      chamberId: chamber.chamberId,
      airflowCfm: points.reduce((range, point) => ({ lo: range.lo + point.airflowCfm.lo, hi: range.hi + point.airflowCfm.hi }), { lo: 0, hi: 0 }),
      evidence: points.length ? weakest(points.map(({ evidence }) => evidence)) : "unknown" as const,
      fanEdgeIds: fanEdges.map(({ edgeId }) => edgeId).sort(),
    };
  }).sort((left, right) => left.chamberId.localeCompare(right.chamberId));
  return {
    schemaVersion: "airflow-network-result-v1",
    fanOperatingPoints: fanOperatingPoints.sort((left, right) => left.edgeId.localeCompare(right.edgeId)),
    chambers,
    blockedReasonCodes: [...new Set(blockedReasonCodes)].sort(),
    assumptions: ["pressure drop uses K·Q² intervals", "passive edges use the minimum governed resistance path", "parallel recirculation is not modelled"],
  };
}
