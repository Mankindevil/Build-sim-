import { describe, expect, it } from "vitest";
import { buildSpatialSceneModel } from "../src/spatial/model";
import { buildSpatialOverlayModel } from "../src/spatial/overlays";
import { activeSceneWithoutWhatIfPollution, buildSpatialWhatIfOverlay } from "../src/spatial/what-if";
import { buildN6Evaluation } from "./helpers/spatial";

describe("spatial what-if overlays", () => {
  it("diffs old/new envelopes and routes without adding scenario objects to the active scene", () => {
    const { evaluation, catalog } = buildN6Evaluation();
    const beforeScene = buildSpatialSceneModel(evaluation, catalog);
    const beforeRoutes = buildSpatialOverlayModel(evaluation, beforeScene).routes;
    const afterScene = structuredClone(beforeScene);
    const moved = afterScene.nodes.find(({ partId }) => partId === "gpu") ?? afterScene.nodes.find(({ selectable }) => selectable)!;
    moved.box.c[0] += 12;
    const afterRoutes = structuredClone(beforeRoutes);
    if (afterRoutes[0]) afterRoutes[0].points = [...afterRoutes[0].points, [12, 13, 14]];
    const activeBefore = structuredClone(beforeScene);
    const overlay = buildSpatialWhatIfOverlay({
      baseSceneKey: "base", candidateSceneKey: "candidate",
      beforeScene, afterScene, beforeRoutes, afterRoutes,
    });
    expect(overlay.proposalOnly).toBe(true);
    expect(overlay.nodes.find(({ partId }) => partId === moved.partId)?.status).toBe("moved_or_resized");
    expect(overlay.routes.some(({ status }) => status === "path_changed")).toBe(true);
    const active = activeSceneWithoutWhatIfPollution(beforeScene, overlay);
    expect(active).toEqual(activeBefore);
    expect(active.nodes.some(({ id }) => id.includes("candidate"))).toBe(false);
    expect(beforeScene).toEqual(activeBefore);
  });

  it("marks added/removed instances while keeping those records outside both source scenes", () => {
    const { evaluation, catalog } = buildN6Evaluation();
    const beforeScene = buildSpatialSceneModel(evaluation, catalog);
    const afterScene = structuredClone(beforeScene);
    const removed = afterScene.nodes.findIndex(({ kind }) => kind === "drive");
    const removedPartId = afterScene.nodes[removed]!.partId;
    afterScene.nodes.splice(removed, 1);
    const template = structuredClone(afterScene.nodes.find(({ kind }) => kind === "fan")!);
    template.id = "part:scenario-only";
    template.partId = "scenario-only";
    afterScene.nodes.push(template);
    const overlay = buildSpatialWhatIfOverlay({
      baseSceneKey: "base", candidateSceneKey: "candidate", beforeScene, afterScene,
      beforeRoutes: [], afterRoutes: [],
    });
    expect(overlay.nodes.find(({ partId }) => partId === removedPartId)?.status).toBe("removed");
    expect(overlay.nodes.find(({ partId }) => partId === "scenario-only")?.status).toBe("added");
    expect(beforeScene.nodes.some(({ partId }) => partId === "scenario-only")).toBe(false);
  });
});
