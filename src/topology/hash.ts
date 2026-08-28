import { hashContent } from "../hash";
import type { BuildConfigV3 } from "./contracts";
import { normalizeBuildConfigV3 } from "./normalize";
import { projectSpatialTopology } from "./projections";

const CONFIG_HASH_CONTRACT = Object.freeze({ domain: "build-config", schemaVersion: "3.0.0" } as const);
const SPATIAL_HASH_CONTRACT = Object.freeze({ domain: "spatial-topology", schemaVersion: "1.0.0" } as const);

/** Domain-scoped hash of the complete, normalized persisted V3 input. */
export async function configV3Hash(config: BuildConfigV3): Promise<string> {
  return hashContent(normalizeBuildConfigV3(config), CONFIG_HASH_CONTRACT);
}

/**
 * Independently domain-scoped hash of only the physical topology.
 */
export async function spatialTopologyHash(config: BuildConfigV3): Promise<string> {
  return hashContent({
    schemaVersion: "3.0.0",
    projection: "spatial-topology-v1",
    topology: projectSpatialTopology(config),
  }, SPATIAL_HASH_CONTRACT);
}

export const hashBuildConfigV3 = configV3Hash;
export const hashSpatialTopologyV3 = spatialTopologyHash;
