import { matrixPose, multiplyMatrix, poseMatrix, transformPoint } from "../geometry/frames";
import { validFiniteVec3, type ResolvedGeometryEntity, type Vec3Mm } from "../geometry/types";
import { ConnectorLibrary, DEFAULT_CONNECTOR_LIBRARY } from "./connector-library";
import {
  portKey,
  type CableDeclaration,
  type CableEndpointDeclaration,
  type InstantiatedCable,
  type InstantiatedPort,
  type InterconnectTopology,
  type PortDeclaration,
} from "./types";

function transformDirection(matrix: ReturnType<typeof poseMatrix>, direction: Vec3Mm): Vec3Mm {
  const origin = transformPoint(matrix, [0, 0, 0]);
  const endpoint = transformPoint(matrix, direction);
  const vector = [endpoint[0] - origin[0], endpoint[1] - origin[1], endpoint[2] - origin[2]] as Vec3Mm;
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length <= 0) throw new TypeError("port insertion direction is invalid");
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function endpointKey(endpoint: CableEndpointDeclaration): string {
  return portKey(endpoint.instanceId, endpoint.portId);
}

export function instantiateInterconnect(
  geometry: readonly ResolvedGeometryEntity[],
  portDeclarations: readonly PortDeclaration[],
  cableDeclarations: readonly CableDeclaration[],
  presentInstanceIds: ReadonlySet<string>,
  library: ConnectorLibrary = DEFAULT_CONNECTOR_LIBRARY,
): InterconnectTopology {
  const geometryById = new Map(geometry.map((entity) => [entity.entityId, entity]));
  const ports = new Map<string, InstantiatedPort>();
  for (const declaration of portDeclarations) {
    const key = portKey(declaration.ownerInstanceId, declaration.portId);
    if (ports.has(key) || !presentInstanceIds.has(declaration.ownerInstanceId)) {
      throw new TypeError("port declaration is duplicate or references an absent instance");
    }
    const owner = geometryById.get(declaration.ownerGeometryEntityId);
    if (!owner || owner.instanceId !== declaration.ownerInstanceId) throw new TypeError("port owner geometry is invalid");
    if (!validFiniteVec3(declaration.insertionDirection)
      || !Number.isInteger(declaration.maxConnections) || declaration.maxConnections < 1
      || (!declaration.shared && declaration.maxConnections !== 1)) throw new TypeError("port declaration is invalid");
    const definition = library.resolve(declaration.connectorStandardId);
    if (declaration.ratedUses.length === 0
      || !declaration.ratedUses.every((use) => definition.ratedUses.includes(use))) {
      throw new TypeError("port rated use exceeds the connector authority");
    }
    const ownerMatrix = poseMatrix(owner.worldPose);
    const worldMatrix = multiplyMatrix(ownerMatrix, poseMatrix(declaration.localPose));
    ports.set(key, {
      ...structuredClone(declaration),
      connectorFamily: definition.family,
      gender: definition.gender,
      keying: definition.keying,
      pinoutFamily: definition.pinoutFamily,
      worldPose: matrixPose(worldMatrix),
      worldInsertionDirection: transformDirection(ownerMatrix, declaration.insertionDirection),
      insertionMm: definition.defaultInsertionMm,
      sectionMm: definition.defaultSectionMm,
    });
  }

  const occupied = new Map<string, number>();
  const cableIds = new Set<string>();
  const cables: InstantiatedCable[] = [];
  const resolveEndpoint = (cable: CableDeclaration, endpoint: CableEndpointDeclaration): string => {
    const key = endpointKey(endpoint);
    const port = ports.get(key);
    if (!port || !presentInstanceIds.has(endpoint.instanceId)) throw new TypeError("cable endpoint references an absent port");
    if (!library.compatible(endpoint.connectorStandardId, port.connectorStandardId)) {
      throw new TypeError("cable connector is not mechanically compatible with its port");
    }
    const endpointDefinition = library.resolve(endpoint.connectorStandardId);
    if (cable.pinoutFamily !== null && (endpointDefinition.pinoutFamily !== cable.pinoutFamily || port.pinoutFamily !== cable.pinoutFamily)) {
      throw new TypeError("cable pinout family does not match its endpoint");
    }
    if (!cable.ratedUses.some((use) => port.ratedUses.includes(use) && endpointDefinition.ratedUses.includes(use))) {
      throw new TypeError("cable is not rated for the endpoint use");
    }
    const count = (occupied.get(key) ?? 0) + 1;
    if (count > port.maxConnections) throw new TypeError("non-shared port is assigned more than once");
    occupied.set(key, count);
    return key;
  };

  for (const cable of cableDeclarations) {
    if (!cable.cableInstanceId || cableIds.has(cable.cableInstanceId) || !presentInstanceIds.has(cable.cableInstanceId)
      || cable.endpoints.length !== 2 || endpointKey(cable.endpoints[0]) === endpointKey(cable.endpoints[1])
      || !Number.isFinite(cable.lengthMm) || cable.lengthMm <= 0
      || !Number.isFinite(cable.outerDiameterMm) || cable.outerDiameterMm <= 0
      || !Number.isFinite(cable.minimumBendRadiusMm) || cable.minimumBendRadiusMm <= 0
      || (cable.conductorGaugeAwg !== null && (!Number.isFinite(cable.conductorGaugeAwg) || cable.conductorGaugeAwg <= 0))
      || (cable.ratedCurrentA !== null && (!Number.isFinite(cable.ratedCurrentA) || cable.ratedCurrentA <= 0))) {
      throw new TypeError("cable declaration is invalid");
    }
    cableIds.add(cable.cableInstanceId);
    const endpointPortKeys = cable.endpoints.map((endpoint) => resolveEndpoint(cable, endpoint)) as [string, string];
    const branchIds = new Set<string>();
    const branchPortKeys = cable.branches.map((branch) => {
      if (!branch.branchId || branchIds.has(branch.branchId) || !Number.isFinite(branch.distanceFromFirstEndMm)
        || branch.distanceFromFirstEndMm <= 0 || branch.distanceFromFirstEndMm >= cable.lengthMm) {
        throw new TypeError("cable branch declaration is invalid");
      }
      branchIds.add(branch.branchId);
      return resolveEndpoint(cable, branch.endpoint);
    });
    cables.push({ ...structuredClone(cable), endpointPortKeys, branchPortKeys });
  }
  return {
    schemaVersion: "interconnect-topology-v1",
    ports: [...ports.values()].sort((left, right) => portKey(left.ownerInstanceId, left.portId).localeCompare(portKey(right.ownerInstanceId, right.portId))),
    cables: cables.sort((left, right) => left.cableInstanceId.localeCompare(right.cableInstanceId)),
  };
}
