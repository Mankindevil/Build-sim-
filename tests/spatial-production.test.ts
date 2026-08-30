import { describe, expect, it, vi } from "vitest";
import adapterSeed from "../data/cases/jonsbo-n6/adapter.json";
import { materializeCaseAdapterFixtureSeed, type CaseAdapterArtifactPayload, type CaseAdapterSeed } from "../src/adapters";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { buildAuthoritativeSpatialScene } from "../src/spatial/authoritative-scene";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";
import type { WorkspaceSpatialSceneAuthority } from "../src/server/spatial-production";

async function fixture() {
  const { manifest } = await materializeCaseAdapterFixtureSeed(adapterSeed as unknown as CaseAdapterSeed);
  const config = createEmptyBuildConfigV3("plan-spatial", "Spatial", "2026-08-29T00:00:00.000Z");
  config.components = [
    {
      instanceId: "case-spatial",
      kind: "case",
      role: "chassis",
      state: "planned",
      identity: { status: "resolved", skuId: manifest.identity.skuId, identityClaimIds: ["claim-case-spatial"] },
      source: "user",
    },
    {
      instanceId: "board-spatial",
      kind: "motherboard",
      role: "mainboard",
      state: "planned",
      identity: { status: "resolved", skuId: "board.example", identityClaimIds: ["claim-board-spatial"] },
      source: "user",
    },
  ];
  config.placements = [{ placementId: "placement-board", componentInstanceId: "board-spatial", mountOwnerInstanceId: "case-spatial", mountId: "mount.board.matx" }];
  const payload = {
    schemaVersion: "workspace-adapter-snapshot-v1",
    caseManifests: [manifest],
    runtimeAdapters: [{
      adapterId: manifest.adapterId,
      adapterVersion: manifest.adapterVersion,
      manifestHash: manifest.contentHash,
      executionStatus: "ready",
      runtimeId: "runtime.case.example",
      runtimeVersion: "1.0.0",
      interpreterId: "declarative-case-v1",
      modelHash: "a".repeat(64),
      modelSourceModuleId: "adapters/runtime-model/a.json",
      authorityStatus: "legacy_unverified",
      interpreterImplementationHash: "b".repeat(64),
      partialReason: null,
      implementationModuleIds: ["adapters/runtime-compiler"],
    }],
  } as unknown as CaseAdapterArtifactPayload;
  return buildAuthoritativeSpatialScene({
    planId: config.id,
    planVersionId: "version-spatial",
    config,
    configHash: "c".repeat(64),
    evaluationHash: "d".repeat(64),
    evaluationLockHash: "e".repeat(64),
    adapterSnapshotHash: "f".repeat(64),
    adapterPayload: payload,
  });
}

describe("U8 authoritative spatial production", () => {
  it("renders only manifest-bound geometry and keeps unresolved placement/routing domains blocked", async () => {
    const scene = await fixture();
    expect(scene.executionStatus).toBe("partial");
    expect(scene.blockedDomains).toEqual(["component_placement", "routing", "assembly"]);
    expect(scene.model.nodes.some((node) => node.id === "case-shell")).toBe(true);
    expect(scene.model.nodes.some((node) => node.id.startsWith("service:"))).toBe(true);
    expect(scene.model.nodes.some((node) => node.id === "port:port.backplane.power")).toBe(true);
    expect(scene.model.nodes.some((node) => node.skuId === "board.example")).toBe(false);
    expect(scene.overlays.routes).toEqual([]);
  });

  it("derives plan/version ownership from the route and disappears when topology V3 is disabled", async () => {
    const scene = await fixture();
    const get = vi.fn(async () => scene);
    const authority = { get } as WorkspaceSpatialSceneAuthority;
    const route = (enabled: boolean) => handleWorkspaceRoute(
      "GET",
      "/api/workspace/plans/plan%20spatial/versions/version%20spatial/spatial-scene",
      {},
      {} as never,
      { topologyV3Enabled: enabled, spatialRoutingEnabled: enabled, spatialScene: authority },
    );
    await expect(route(true)).resolves.toMatchObject({ status: 200, payload: { schemaVersion: "authoritative-spatial-scene-v1" } });
    expect(get).toHaveBeenCalledWith("plan spatial", "version spatial");
    await expect(route(false)).resolves.toEqual({ status: 404, payload: { error: "topology_v3_disabled" } });
    await expect(handleWorkspaceRoute(
      "GET",
      "/api/workspace/plans/plan%20spatial/versions/version%20spatial/spatial-scene",
      {},
      {} as never,
      { topologyV3Enabled: true, spatialRoutingEnabled: false, spatialScene: authority },
    )).resolves.toEqual({ status: 404, payload: { error: "spatial_routing_disabled" } });
  });
});
