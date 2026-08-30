import { hashContent } from "../hash";
import type { CaseAdapterProjection } from "./data-driven-case";
import { verifyCaseAdapterManifest, type CaseAdapterManifest } from "./contracts";

const SPATIAL_HASH_CONTRACT = Object.freeze({
  domain: "spatial-topology",
  schemaVersion: "1.0.0",
} as const);

export interface CaseAdapterSpatialProjectionMaterial {
  schemaVersion: "case-adapter-spatial-projection-v1";
  adapterId: string;
  adapterVersion: string;
  manifestHash: string;
  geometry: CaseAdapterManifest["geometry"];
  mounts: CaseAdapterManifest["mounts"];
  ports: CaseAdapterManifest["ports"];
  routing: { zones: CaseAdapterManifest["routingZones"] };
  assembly: {
    constraints: CaseAdapterManifest["assemblyConstraints"];
    bundleItems: CaseAdapterManifest["bundleItems"];
    resourcePatterns: CaseAdapterManifest["resourcePatterns"];
  };
}

/**
 * Canonical manifest/projection preimage shared by lock assembly and the
 * executing case runtime. Non-spatial capability/provenance inputs remain
 * separately locked and cannot accidentally fork this identity contract.
 */
export function caseAdapterSpatialProjectionMaterial(
  source: CaseAdapterManifest | CaseAdapterProjection,
): CaseAdapterSpatialProjectionMaterial {
  if (source.schemaVersion === "case-adapter-manifest-v1") {
    return {
      schemaVersion: "case-adapter-spatial-projection-v1",
      adapterId: source.adapterId,
      adapterVersion: source.adapterVersion,
      manifestHash: source.contentHash,
      geometry: structuredClone(source.geometry),
      mounts: structuredClone(source.mounts),
      ports: structuredClone(source.ports),
      routing: { zones: structuredClone(source.routingZones) },
      assembly: {
        constraints: structuredClone(source.assemblyConstraints),
        bundleItems: structuredClone(source.bundleItems),
        resourcePatterns: structuredClone(source.resourcePatterns),
      },
    };
  }
  if (source.schemaVersion !== "case-adapter-projection-v1") {
    throw new TypeError("case adapter spatial projection schema invalid");
  }
  return {
    schemaVersion: "case-adapter-spatial-projection-v1",
    adapterId: source.adapterId,
    adapterVersion: source.adapterVersion,
    manifestHash: source.manifestHash,
    geometry: structuredClone(source.geometry),
    mounts: structuredClone(source.mounts),
    ports: structuredClone(source.ports),
    routing: structuredClone(source.routing),
    assembly: structuredClone(source.assembly),
  };
}

/** Hashes the shared spatial preimage in the registered spatial-topology domain. */
export async function caseAdapterSpatialProjectionHash(
  source: CaseAdapterManifest | CaseAdapterProjection,
): Promise<string> {
  if (source.schemaVersion === "case-adapter-manifest-v1" && !await verifyCaseAdapterManifest(source)) {
    throw new TypeError("case adapter spatial projection manifest invalid");
  }
  return hashContent(caseAdapterSpatialProjectionMaterial(source), SPATIAL_HASH_CONTRACT);
}
