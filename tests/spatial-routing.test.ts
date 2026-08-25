import { describe, expect, it } from "vitest";
import { buildN6Evaluation } from "./helpers/spatial";
import { buildSpatialSceneModel } from "../src/spatial/model";
import { buildSpatialOverlayModel } from "../src/spatial/overlays";

describe("R6 spatial routing and workflow layers", () => {
  it("reuses routed cable polylines and evaluation findings", () => {
    const { evaluation, catalog } = buildN6Evaluation();
    const overlays = buildSpatialOverlayModel(evaluation, buildSpatialSceneModel(evaluation, catalog));
    expect(overlays.routes).toHaveLength(evaluation.routing.cables.length);
    for (const cable of evaluation.routing.cables) {
      const route = overlays.routes.find((item) => item.id === cable.id)!;
      expect(route.points).toEqual(cable.route?.polyline ?? [cable.from.at, cable.to.at]);
      expect(route.evidence).toBe(cable.evidence);
    }
    expect(overlays.assembly).toHaveLength(evaluation.assembly.steps.length);
  });
});
