import { describe, expect, it } from "vitest";
import { buildN6Evaluation } from "./helpers/spatial";
import { buildSpatialSceneModel } from "../src/spatial/model";
import { buildSpatialOverlayModel, primaryPartForFinding } from "../src/spatial/overlays";

describe("R6 spatial findings", () => {
  it("copies verdicts and targets from BuildEvaluation without a second decision engine", () => {
    const { evaluation, catalog } = buildN6Evaluation();
    const overlays = buildSpatialOverlayModel(evaluation, buildSpatialSceneModel(evaluation, catalog));
    expect(overlays.findings.map(({ id, verdict, evidence }) => ({ id, verdict, evidence }))).toEqual(evaluation.findings.map(({ id, verdict, evidence }) => ({ id, verdict, evidence })));
    const targeted = overlays.findings.find((finding) => finding.partIds.length > 0);
    expect(targeted && primaryPartForFinding(overlays, targeted.id)).toBe(targeted?.partIds[0]);
  });

  it("offers only declared case and clearance dimensions", () => {
    const { evaluation, catalog } = buildN6Evaluation();
    const overlays = buildSpatialOverlayModel(evaluation, buildSpatialSceneModel(evaluation, catalog));
    expect(overlays.dimensions.filter((dimension) => dimension.id.startsWith("dimension.case"))).toHaveLength(3);
    expect(overlays.dimensions.every((dimension) => dimension.sourcePartIds.length > 0 && dimension.valueMm > 0)).toBe(true);
  });
});
