import { describe, expect, it } from "vitest";
import matrixJson from "./fixtures/adapters/case-layout-matrix.json";
import { materializeCaseAdapterFixtureSeed, type CaseAdapterArtifactPayload } from "../src/adapters";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { buildAuthoritativeSpatialScene } from "../src/spatial/authoritative-scene";
import { seedForMatrixCase, type MatrixCase } from "./helpers/case-adapter-matrix";

const matrix = matrixJson as { schemaVersion: string; cases: MatrixCase[] };

describe("U8 topology-driven spatial layout matrix", () => {
  it("renders governed 3D geometry and a route for ATX, mATX and Mini-ITX layouts", async () => {
    const layouts = matrix.cases.slice(0, 3);
    expect(layouts.map((entry) => entry.layout)).toEqual([
      "atx-tower",
      "matx-compact-tower",
      "mini-itx-sandwich",
    ]);

    const scenes = [];
    for (const entry of layouts) {
      const { manifest } = await materializeCaseAdapterFixtureSeed(seedForMatrixCase(entry));
      const config = createEmptyBuildConfigV3(`plan-${entry.fixtureId}`, entry.layout, "2026-08-29T00:00:00.000Z");
      config.components = [{
        instanceId: `case-${entry.fixtureId}`,
        kind: "case",
        role: "chassis",
        state: "planned",
        identity: { status: "resolved", skuId: manifest.identity.skuId, identityClaimIds: [`claim-${entry.fixtureId}`] },
        source: "user",
      }];
      config.connections = [{
        connectionId: `connection-${entry.fixtureId}-front-usb`,
        from: { instanceId: `case-${entry.fixtureId}`, portId: `port.${entry.layout}.front-usb` },
        to: { instanceId: `case-${entry.fixtureId}`, portId: `port.${entry.layout}.board-usb` },
        status: "planned",
      }];
      const payload = {
        schemaVersion: "workspace-adapter-snapshot-v1",
        caseManifests: [manifest],
        runtimeAdapters: [{
          adapterId: manifest.adapterId,
          adapterVersion: manifest.adapterVersion,
          manifestHash: manifest.contentHash,
          executionStatus: "ready",
          runtimeId: `runtime.${entry.fixtureId}`,
          runtimeVersion: "1.0.0",
          interpreterId: "declarative-case-v1",
          modelHash: "a".repeat(64),
          modelSourceModuleId: `adapters/runtime-model/${entry.fixtureId}.json`,
          authorityStatus: "legacy_unverified",
          interpreterImplementationHash: "b".repeat(64),
          partialReason: null,
          implementationModuleIds: ["adapters/runtime-compiler"],
        }],
      } as unknown as CaseAdapterArtifactPayload;
      scenes.push(buildAuthoritativeSpatialScene({
        planId: config.id,
        planVersionId: `version-${entry.fixtureId}`,
        config,
        configHash: "c".repeat(64),
        evaluationHash: "d".repeat(64),
        evaluationLockHash: "e".repeat(64),
        adapterSnapshotHash: "f".repeat(64),
        adapterPayload: payload,
      }));
    }

    expect(new Set(scenes.map((scene) => `${scene.model.bounds.w}x${scene.model.bounds.h}x${scene.model.bounds.d}`)).size).toBe(3);
    for (const scene of scenes) {
      expect(scene.executionStatus).toBe("ready");
      expect(scene.blockedDomains).toEqual([]);
      expect(scene.model.nodes.some((node) => node.id === "case-shell")).toBe(true);
      expect(scene.model.nodes.some((node) => node.id.startsWith("route-zone:"))).toBe(true);
      expect(scene.overlays.routes).toHaveLength(1);
      expect(scene.overlays.routes[0]).toMatchObject({ pathAvailable: true, verdict: "warn", toleranceMm: 4 });
      expect(scene.overlays.routes[0]!.points.length).toBeGreaterThanOrEqual(3);
      expect(scene.overlays.routes[0]!.endpointDirections).toHaveLength(2);
      expect(scene.overlays.assembly).toHaveLength(1);
    }
  });
});
