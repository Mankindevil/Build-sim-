import { describe, expect, it } from "vitest";
import { buildN6Evaluation } from "./helpers/spatial";
import { buildSpatialSceneModel } from "../src/spatial/model";

describe("R5 spatial scene model", () => {
  it("uses the deterministic evaluation geometry without changing millimetre facts", () => {
    const { evaluation, catalog } = buildN6Evaluation();
    const model = buildSpatialSceneModel(evaluation, catalog);
    expect(model.coordinateSystem).toEqual({ units: "mm", origin: "case-envelope-center", axes: { x: "right", y: "up", z: "rear" }, anchor: "center" });
    expect(model.bounds).toEqual({ c: [0, 0, 0], w: 305, h: 318, d: 353 });
    for (const part of evaluation.geometry) {
      expect(model.nodes.find((node) => node.partId === part.id)?.box).toEqual(part.box);
    }
    expect(model.nodes.some((node) => node.kind === "board")).toBe(true);
    expect(model.nodes.some((node) => node.kind === "cpu")).toBe(true);
    expect(model.nodes.some((node) => node.kind === "drive")).toBe(true);
  });

  it("carries SKU evidence, provenance, findings and repeat groups", () => {
    const { evaluation, catalog } = buildN6Evaluation();
    const model = buildSpatialSceneModel(evaluation, catalog);
    const board = model.nodes.find((node) => node.partId === "board")!;
    expect(board.skuId).toBe(evaluation.config.boardId);
    expect(board.sizeEvidence).toBe("standard");
    expect(board.anchorEvidence).toBe("inferred");
    expect(board.evidence).toBe("inferred");
    expect(model.nodes.filter((node) => node.repeatGroup?.startsWith("tray:")).length).toBeGreaterThan(1);
  });
});
