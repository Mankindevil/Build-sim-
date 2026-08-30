import type { GeometryProvenance, Pose6D, Vec3Mm } from "../geometry";

export type ConnectorGender = "male" | "female" | "genderless";
export type ConnectorStyle = "straight" | "right_angle";

export interface ConnectorDefinition {
  readonly connectorStandardId: string;
  readonly family: string;
  readonly gender: ConnectorGender;
  readonly keying: string;
  readonly ratedUses: readonly string[];
  readonly matingStandards: readonly string[];
  readonly pinoutFamily: string | null;
  readonly defaultInsertionMm: number;
  readonly defaultSectionMm: readonly [number, number];
}

export interface PortDeclaration {
  readonly portId: string;
  readonly ownerInstanceId: string;
  readonly ownerGeometryEntityId: string;
  readonly connectorStandardId: string;
  readonly localPose: Pose6D;
  /** Unit direction in the owner-local frame along which a plug is removed. */
  readonly insertionDirection: Vec3Mm;
  readonly ratedUses: readonly string[];
  readonly shared: boolean;
  readonly maxConnections: number;
  readonly provenance: GeometryProvenance;
}

export interface InstantiatedPort extends PortDeclaration {
  readonly connectorFamily: string;
  readonly gender: ConnectorGender;
  readonly keying: string;
  readonly pinoutFamily: string | null;
  readonly worldPose: Pose6D;
  readonly worldInsertionDirection: Vec3Mm;
  readonly insertionMm: number;
  readonly sectionMm: readonly [number, number];
}

export interface CableEndpointDeclaration {
  readonly instanceId: string;
  readonly portId: string;
  readonly connectorStandardId: string;
  readonly connectorStyle: ConnectorStyle;
}

export interface CableBranchDeclaration {
  readonly branchId: string;
  readonly distanceFromFirstEndMm: number;
  readonly endpoint: CableEndpointDeclaration;
}

export interface CableDeclaration {
  readonly cableInstanceId: string;
  readonly endpoints: readonly [CableEndpointDeclaration, CableEndpointDeclaration];
  readonly branches: readonly CableBranchDeclaration[];
  readonly pinoutFamily: string | null;
  readonly lengthMm: number;
  readonly conductorGaugeAwg: number | null;
  readonly ratedCurrentA: number | null;
  readonly outerDiameterMm: number;
  readonly minimumBendRadiusMm: number;
  readonly ratedUses: readonly string[];
  readonly provenance: GeometryProvenance;
}

export interface InstantiatedCable extends CableDeclaration {
  readonly endpointPortKeys: readonly [string, string];
  readonly branchPortKeys: readonly string[];
}

export interface InterconnectTopology {
  readonly schemaVersion: "interconnect-topology-v1";
  readonly ports: readonly InstantiatedPort[];
  readonly cables: readonly InstantiatedCable[];
}

export function portKey(instanceId: string, portId: string): string {
  if (!instanceId || !portId) throw new TypeError("port identity is invalid");
  return `${instanceId}:${portId}`;
}
