import type { FactAuthority } from "../facts/field-registry";
import { portKey, type InterconnectTopology, type InstantiatedCable, type InstantiatedPort } from "../interconnect";

export interface ElectricalPowerSource {
  readonly sourcePortKey: string;
  readonly pinoutFamily: string;
  readonly continuousCurrentA: number;
  readonly transientCurrentA: number;
  readonly authority: FactAuthority | "standard";
  readonly sourceFactIds: readonly string[];
}

export interface ElectricalLoad {
  readonly consumerPortKey: string;
  readonly continuousCurrentA: number;
  readonly startupCurrentA: number;
  readonly loadKind: "component" | "backplane" | "fan" | "pump";
  readonly authority: FactAuthority | "standard";
  readonly sourceFactIds: readonly string[];
}

export interface ConnectorSeatingObservation {
  readonly observationId: string;
  readonly cableInstanceId: string;
  readonly portKey: string;
  readonly fullySeated: boolean;
  readonly bendStartDistanceMm: number;
}

export interface ElectricalSafetyInput {
  readonly topology: InterconnectTopology;
  readonly sources: readonly ElectricalPowerSource[];
  readonly loads: readonly ElectricalLoad[];
  readonly seatingObservations: readonly ConnectorSeatingObservation[];
}

export interface ElectricalSafetyDecision {
  readonly decisionId: string;
  readonly cableInstanceId: string;
  readonly check: "pinout" | "continuous_current" | "startup_current" | "connector_seating" | "bend_clearance";
  readonly verdict: "pass" | "fail" | "blocked";
  readonly reason: string;
  readonly portKeys: readonly string[];
  readonly factIds: readonly string[];
  readonly observationIds: readonly string[];
}

export interface ElectricalSafetyEvaluation {
  readonly schemaVersion: "electrical-safety-evaluation-v1";
  readonly decisions: readonly ElectricalSafetyDecision[];
  readonly verdict: "pass" | "fail" | "blocked";
}

const safetyAuthority = (authority: ElectricalPowerSource["authority"] | ElectricalLoad["authority"]): boolean => (
  authority === "official" || authority === "standard"
);

function validateCurrent(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} is invalid`);
}

function allCablePortKeys(cable: InstantiatedCable): readonly string[] {
  return [...cable.endpointPortKeys, ...cable.branchPortKeys];
}

function decision(
  cable: InstantiatedCable,
  check: ElectricalSafetyDecision["check"],
  verdict: ElectricalSafetyDecision["verdict"],
  reason: string,
  portKeys: readonly string[],
  factIds: readonly string[] = [],
  observationIds: readonly string[] = [],
): ElectricalSafetyDecision {
  return {
    decisionId: `electrical:${check}:${cable.cableInstanceId}`,
    cableInstanceId: cable.cableInstanceId,
    check, verdict, reason, portKeys: [...portKeys].sort(), factIds: [...new Set(factIds)].sort(), observationIds: [...new Set(observationIds)].sort(),
  };
}

function pinoutDecision(
  cable: InstantiatedCable,
  ports: readonly InstantiatedPort[],
): ElectricalSafetyDecision {
  const keys = allCablePortKeys(cable);
  const portByKey = new Map(ports.map((port) => [portKey(port.ownerInstanceId, port.portId), port]));
  const endpointPorts = keys.map((key) => portByKey.get(key));
  if (cable.pinoutFamily === null || endpointPorts.some((port) => !port || port.pinoutFamily === null)) {
    return decision(cable, "pinout", "blocked", "pinout authority is incomplete", keys);
  }
  if (endpointPorts.some((port) => port!.pinoutFamily !== cable.pinoutFamily)) {
    return decision(cable, "pinout", "fail", "connector shell fits but pinout family differs", keys);
  }
  return decision(cable, "pinout", "pass", "cable and every endpoint share the exact pinout family", keys);
}

function currentDecisions(
  cable: InstantiatedCable,
  sources: readonly ElectricalPowerSource[],
  loads: readonly ElectricalLoad[],
): readonly ElectricalSafetyDecision[] {
  const keys = allCablePortKeys(cable);
  const cableSources = sources.filter((source) => keys.includes(source.sourcePortKey));
  const cableLoads = loads.filter((load) => keys.includes(load.consumerPortKey));
  if (cableSources.length !== 1 || cableLoads.length === 0 || cable.ratedCurrentA === null
    || cableSources.some((source) => !safetyAuthority(source.authority))
    || cableLoads.some((load) => !safetyAuthority(load.authority))) {
    return [
      decision(cable, "continuous_current", "blocked", "current rating or exact source/load authority is incomplete", keys),
      decision(cable, "startup_current", "blocked", "startup-current authority is incomplete", keys),
    ];
  }
  const source = cableSources[0]!;
  const factIds = [...source.sourceFactIds, ...cableLoads.flatMap((load) => load.sourceFactIds)];
  if (source.pinoutFamily !== cable.pinoutFamily) {
    return [
      decision(cable, "continuous_current", "fail", "modular PSU source pinout differs from cable pinout", keys, factIds),
      decision(cable, "startup_current", "fail", "modular PSU source pinout differs from cable pinout", keys, factIds),
    ];
  }
  const continuous = cableLoads.reduce((sum, load) => sum + load.continuousCurrentA, 0);
  const startup = cableLoads.reduce((sum, load) => sum + load.startupCurrentA, 0);
  return [
    decision(cable, "continuous_current",
      continuous <= Math.min(source.continuousCurrentA, cable.ratedCurrentA) ? "pass" : "fail",
      continuous <= Math.min(source.continuousCurrentA, cable.ratedCurrentA)
        ? "branch and daisy-chain load is within both cable and source rating"
        : "branch or daisy-chain load exceeds cable/source rating",
      keys, factIds),
    decision(cable, "startup_current",
      startup <= Math.min(source.transientCurrentA, cable.ratedCurrentA) ? "pass" : "fail",
      startup <= Math.min(source.transientCurrentA, cable.ratedCurrentA)
        ? "combined startup current is within transient rating"
        : cableLoads.some((load) => load.loadKind === "backplane")
          ? "backplane startup current exceeds transient rating"
          : "combined startup current exceeds transient rating",
      keys, factIds),
  ];
}

function seatingDecisions(
  cable: InstantiatedCable,
  ports: readonly InstantiatedPort[],
  observations: readonly ConnectorSeatingObservation[],
): readonly ElectricalSafetyDecision[] {
  const portByKey = new Map(ports.map((port) => [portKey(port.ownerInstanceId, port.portId), port]));
  const keys = allCablePortKeys(cable).filter((key) => portByKey.get(key)?.connectorFamily === "power.12v-2x6");
  if (keys.length === 0) return [];
  const exact = keys.map((key) => observations.find((observation) => (
    observation.cableInstanceId === cable.cableInstanceId && observation.portKey === key
  )));
  if (exact.some((observation) => !observation)) {
    return [
      decision(cable, "connector_seating", "blocked", "12V-2x6 seating requires an exact port observation", keys),
      decision(cable, "bend_clearance", "blocked", "12V-2x6 first-bend distance is unverified", keys),
    ];
  }
  const values = exact as ConnectorSeatingObservation[];
  for (const value of values) validateCurrent(value.bendStartDistanceMm, "bend start distance");
  const observationIds = values.map((value) => value.observationId);
  const seated = values.every((value) => value.fullySeated);
  const bendClear = values.every((value) => value.bendStartDistanceMm >= cable.minimumBendRadiusMm);
  return [
    decision(cable, "connector_seating", seated ? "pass" : "fail",
      seated ? "every 12V-2x6 endpoint is observed fully seated" : "a 12V-2x6 endpoint is not fully seated",
      keys, [], observationIds),
    decision(cable, "bend_clearance", bendClear ? "pass" : "fail",
      bendClear ? "first bend starts beyond the governed minimum radius" : "cable bends before the governed minimum distance",
      keys, [], observationIds),
  ];
}

export function evaluateElectricalSafety(input: ElectricalSafetyInput): ElectricalSafetyEvaluation {
  const sourceKeys = new Set<string>();
  for (const source of input.sources) {
    if (!source.sourcePortKey || sourceKeys.has(source.sourcePortKey) || !source.pinoutFamily || source.sourceFactIds.length === 0) {
      throw new TypeError("electrical source is invalid or duplicate");
    }
    validateCurrent(source.continuousCurrentA, "source continuous current");
    validateCurrent(source.transientCurrentA, "source transient current");
    sourceKeys.add(source.sourcePortKey);
  }
  const loadKeys = new Set<string>();
  for (const load of input.loads) {
    if (!load.consumerPortKey || loadKeys.has(load.consumerPortKey) || load.sourceFactIds.length === 0) {
      throw new TypeError("electrical load is invalid or duplicate");
    }
    validateCurrent(load.continuousCurrentA, "load continuous current");
    validateCurrent(load.startupCurrentA, "load startup current");
    loadKeys.add(load.consumerPortKey);
  }
  const decisions = input.topology.cables.flatMap((cable) => [
    pinoutDecision(cable, input.topology.ports),
    ...currentDecisions(cable, input.sources, input.loads),
    ...seatingDecisions(cable, input.topology.ports, input.seatingObservations),
  ]).sort((left, right) => left.decisionId.localeCompare(right.decisionId));
  return {
    schemaVersion: "electrical-safety-evaluation-v1",
    decisions,
    verdict: decisions.some((entry) => entry.verdict === "fail") ? "fail"
      : decisions.some((entry) => entry.verdict === "blocked") ? "blocked" : "pass",
  };
}
