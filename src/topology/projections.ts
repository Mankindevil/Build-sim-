import type {
  BuildConfigV3,
  ComponentInstance,
  ConnectionEdge,
  PlacementEdge,
} from "./contracts";
import { normalizeBuildConfigV3 } from "./normalize";

export type TopologyBomLine = {
  instanceId: string;
  kind: ComponentInstance["kind"];
  role: string;
  state: ComponentInstance["state"];
  quantity: 1;
} & (
  | { identityStatus: "resolved"; skuId: string; identityClaimIds: string[] }
  | { identityStatus: "unresolved"; userText: string; candidateIds?: string[] }
);

/**
 * Lossless one-instance-per-line projection. Consumers may aggregate display
 * rows, but the authoritative projection never collapses distinct slots,
 * roles, purchase states, or unresolved identities.
 */
export function projectTopologyBom(config: BuildConfigV3): TopologyBomLine[] {
  return normalizeBuildConfigV3(config).components.map((component): TopologyBomLine => (
    component.identity.status === "resolved"
      ? {
          instanceId: component.instanceId,
          kind: component.kind,
          role: component.role,
          state: component.state,
          quantity: 1,
          identityStatus: "resolved",
          skuId: component.identity.skuId,
          identityClaimIds: [...component.identity.identityClaimIds],
        }
      : {
          instanceId: component.instanceId,
          kind: component.kind,
          role: component.role,
          state: component.state,
          quantity: 1,
          identityStatus: "unresolved",
          userText: component.identity.userText,
          ...(component.identity.candidateIds ? { candidateIds: [...component.identity.candidateIds] } : {}),
        }
  ));
}

export const projectTopologyToBom = projectTopologyBom;

export type SpatialComponentProjection = Pick<ComponentInstance, "instanceId" | "kind" | "role"> & {
  identity:
    | { status: "resolved"; skuId: string }
    | { status: "unresolved"; userText: string; candidateIds?: string[] };
};

export type SpatialConnectionProjection = Omit<ConnectionEdge, "status">;

export interface SpatialTopologyProjection {
  components: SpatialComponentProjection[];
  placements: PlacementEdge[];
  connections: SpatialConnectionProjection[];
}

/**
 * Input-only physical graph. Purchase state, provenance/claim IDs,
 * requirements, notes, firmware and scenario metadata cannot perturb geometry.
 */
export function projectSpatialTopology(config: BuildConfigV3): SpatialTopologyProjection {
  const normalized = normalizeBuildConfigV3(config);
  return {
    components: normalized.components.map((component): SpatialComponentProjection => ({
      instanceId: component.instanceId,
      kind: component.kind,
      role: component.role,
      identity: component.identity.status === "resolved"
        ? { status: "resolved", skuId: component.identity.skuId }
        : {
            status: "unresolved",
            userText: component.identity.userText,
            ...(component.identity.candidateIds ? { candidateIds: [...component.identity.candidateIds] } : {}),
          },
    })),
    placements: structuredClone(normalized.placements),
    connections: normalized.connections.map(({ status: _status, ...connection }) => structuredClone(connection)),
  };
}

/** Subjects eligible for later adapter geometry; this function derives no dimensions. */
export function projectGeometrySubjects(config: BuildConfigV3): SpatialComponentProjection[] {
  return projectSpatialTopology(config).components;
}
