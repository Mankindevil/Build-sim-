// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mountSpatialView, shouldRebuildSpatialModel } from "../src/lab/spatial-view";
import {
  exceedsSpatialDragThreshold,
  orthographicZoomForVisibleHeight,
  perspectiveDistanceForVisibleHeight,
  perspectiveVisibleHeight,
  SPATIAL_DRAG_THRESHOLD_PX,
} from "../src/spatial/three-renderer";
import { evaluateBuild } from "../src/core/evaluate";
import { loadBundledCatalog } from "../src/sku/catalog";
import { initializedStore } from "./helpers/workspace-ui";

describe("Three spatial interaction policy", () => {
  it("does not treat a click or an exact five-pixel move as a drag", () => {
    expect(SPATIAL_DRAG_THRESHOLD_PX).toBe(5);
    expect(exceedsSpatialDragThreshold({ x: 20, y: 20 }, { x: 20, y: 20 })).toBe(false);
    expect(exceedsSpatialDragThreshold({ x: 20, y: 20 }, { x: 23, y: 24 })).toBe(false);
    expect(exceedsSpatialDragThreshold({ x: 20, y: 20 }, { x: 26, y: 20 })).toBe(true);
  });

  it("round-trips the visible framing height across camera projections", () => {
    const distance = 730;
    const visibleHeight = perspectiveVisibleHeight(distance);
    const orthographicZoom = orthographicZoomForVisibleHeight(visibleHeight);
    expect(520 / orthographicZoom).toBeCloseTo(visibleHeight, 8);
    expect(perspectiveDistanceForVisibleHeight(visibleHeight)).toBeCloseTo(distance, 8);
  });

  it("does not rebuild for selection emissions or an unchanged evaluation hash", () => {
    const initial = { sourceKey: "plan-a:4:9", snapshotHash: null };
    expect(shouldRebuildSpatialModel(null, initial, false)).toBe(true);
    expect(shouldRebuildSpatialModel(initial, initial, true)).toBe(false);

    const hashed = { sourceKey: "plan-a:4:9", snapshotHash: "evaluation-1" };
    expect(shouldRebuildSpatialModel(initial, hashed, true)).toBe(false);
    expect(shouldRebuildSpatialModel(hashed, { sourceKey: "plan-a:5:10", snapshotHash: "evaluation-1" }, true)).toBe(false);
    expect(shouldRebuildSpatialModel(hashed, { sourceKey: "plan-a:4:9", snapshotHash: "evaluation-2" }, true)).toBe(true);
    expect(shouldRebuildSpatialModel(hashed, { sourceKey: "plan-a:5:10", snapshotHash: null }, true)).toBe(true);
    expect(shouldRebuildSpatialModel(initial, { sourceKey: "plan-a:4:10", snapshotHash: null }, true)).toBe(true);
  });

  it("mounts a dedicated Three root and temporarily removes the legacy SVG tools", async () => {
    document.body.innerHTML = `<main id="n6-lab"><div class="case-view-toolbar"></div><div class="spatial-stage" id="spatial-stage"><svg id="iso-svg" class="case-view" data-case-view="iso"></svg><div class="spatial-help"></div><div class="spatial-data-strip"></div></div></main>`;
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    const { store } = await initializedStore();
    const catalog = loadBundledCatalog();
    store.setEvaluation(evaluateBuild(store.getState().activePlan!.draft.config, catalog));
    const stage = document.getElementById("spatial-stage")!;
    const controller = mountSpatialView(stage, store, () => catalog);
    const root = stage.querySelector<HTMLElement>("[data-three-spatial-root]")!;

    expect(root).toBeTruthy();
    expect(root.classList.contains("case-view")).toBe(false);
    expect(root.hasAttribute("data-case-view")).toBe(false);
    expect(stage.classList.contains("spatial-three-pending")).toBe(true);
    expect(document.querySelector(".case-view-toolbar")?.classList.contains("is-hidden")).toBe(true);

    controller.dispose();
    expect(document.querySelector(".case-view-toolbar")?.classList.contains("is-hidden")).toBe(false);
    context.mockRestore();
    store.dispose();
  });
});
