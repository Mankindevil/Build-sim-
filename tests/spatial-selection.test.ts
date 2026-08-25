import { describe, expect, it, vi } from "vitest";
import { buildN6Evaluation } from "./helpers/spatial";
import { buildSpatialSceneModel } from "../src/spatial/model";
import { SpatialSelectionController } from "../src/spatial/selection";

describe("R5 spatial selection", () => {
  it("resolves raycast part ids and publishes only selectable nodes", () => {
    const { evaluation, catalog } = buildN6Evaluation();
    const model = buildSpatialSceneModel(evaluation, catalog);
    const onSelect = vi.fn();
    const selection = new SpatialSelectionController(model, onSelect);
    expect(selection.hover("board")?.skuId).toBe(evaluation.config.boardId);
    expect(selection.select("board")?.partId).toBe("board");
    expect(selection.select("case-interior")).toBeNull();
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("clears stale selection when the scene changes", () => {
    const { evaluation, catalog } = buildN6Evaluation();
    const model = buildSpatialSceneModel(evaluation, catalog);
    const selection = new SpatialSelectionController(model);
    selection.select("board");
    selection.setModel({ ...model, nodes: model.nodes.filter((node) => node.partId !== "board") });
    expect(selection.getState().selectedPartId).toBeNull();
  });

  it("can mirror global selection without publishing it again", () => {
    const { evaluation, catalog } = buildN6Evaluation();
    const onSelect = vi.fn();
    const selection = new SpatialSelectionController(buildSpatialSceneModel(evaluation, catalog), onSelect);
    selection.select("board", false);
    expect(selection.getState().selectedPartId).toBe("board");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
