import type { CenteredBox, Vec3 } from "../core/geometry";
import type { SpatialSceneModel } from "./model";
import type { SpatialRouteOverlay } from "./overlays";

export interface SpatialNodeDiff {
  readonly partId: string;
  readonly status: "added" | "removed" | "moved_or_resized" | "unchanged";
  readonly beforeBox: CenteredBox | null;
  readonly afterBox: CenteredBox | null;
}

export interface SpatialRouteDiff {
  readonly cableId: string;
  readonly status: "added" | "removed" | "path_changed" | "unchanged";
  readonly beforePoints: readonly Vec3[] | null;
  readonly afterPoints: readonly Vec3[] | null;
}

export interface SpatialWhatIfOverlay {
  readonly schemaVersion: "spatial-what-if-overlay-v1";
  readonly baseSceneKey: string;
  readonly candidateSceneKey: string;
  readonly nodes: readonly SpatialNodeDiff[];
  readonly routes: readonly SpatialRouteDiff[];
  /** Scenario geometry is an overlay only and can never be installed as active scene nodes. */
  readonly proposalOnly: true;
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export function buildSpatialWhatIfOverlay(input: {
  readonly baseSceneKey: string;
  readonly candidateSceneKey: string;
  readonly beforeScene: SpatialSceneModel;
  readonly afterScene: SpatialSceneModel;
  readonly beforeRoutes: readonly SpatialRouteOverlay[];
  readonly afterRoutes: readonly SpatialRouteOverlay[];
}): SpatialWhatIfOverlay {
  if (!input.baseSceneKey || !input.candidateSceneKey || input.baseSceneKey === input.candidateSceneKey) {
    throw new TypeError("spatial what-if scene identities are invalid");
  }
  const beforeNodes = new Map(input.beforeScene.nodes.map((node) => [node.partId, node]));
  const afterNodes = new Map(input.afterScene.nodes.map((node) => [node.partId, node]));
  const nodeIds = [...new Set([...beforeNodes.keys(), ...afterNodes.keys()])].sort();
  const nodes = nodeIds.map((partId): SpatialNodeDiff => {
    const before = beforeNodes.get(partId);
    const after = afterNodes.get(partId);
    return {
      partId,
      status: !before ? "added" : !after ? "removed" : same(before.box, after.box) ? "unchanged" : "moved_or_resized",
      beforeBox: before ? structuredClone(before.box) : null,
      afterBox: after ? structuredClone(after.box) : null,
    };
  });
  const beforeRoutes = new Map(input.beforeRoutes.map((route) => [route.id, route]));
  const afterRoutes = new Map(input.afterRoutes.map((route) => [route.id, route]));
  const routeIds = [...new Set([...beforeRoutes.keys(), ...afterRoutes.keys()])].sort();
  const routes = routeIds.map((cableId): SpatialRouteDiff => {
    const before = beforeRoutes.get(cableId);
    const after = afterRoutes.get(cableId);
    return {
      cableId,
      status: !before ? "added" : !after ? "removed" : same(before.points, after.points) ? "unchanged" : "path_changed",
      beforePoints: before ? structuredClone(before.points) : null,
      afterPoints: after ? structuredClone(after.points) : null,
    };
  });
  return {
    schemaVersion: "spatial-what-if-overlay-v1",
    baseSceneKey: input.baseSceneKey,
    candidateSceneKey: input.candidateSceneKey,
    nodes,
    routes,
    proposalOnly: true,
  };
}

/** Explicitly returns only the active scene; scenario nodes remain outside it. */
export function activeSceneWithoutWhatIfPollution(active: SpatialSceneModel, _overlay: SpatialWhatIfOverlay): SpatialSceneModel {
  return structuredClone(active);
}
