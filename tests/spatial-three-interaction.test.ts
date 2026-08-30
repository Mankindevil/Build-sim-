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
import { createEmptyBuildConfig } from "../src/plans/default-plan";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import type { BuildConfigDocument } from "../src/config/types";
import type { BuildPlan } from "../src/plans/contracts";
import type { AuthoritativeSpatialSceneSnapshot } from "../src/spatial/authoritative-scene";

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

  it("drops a resolved scene as soon as the active draft becomes partial", async () => {
    document.body.innerHTML = `<main id="n6-lab"><div class="case-view-toolbar"></div><div class="spatial-stage" id="spatial-stage"><svg id="iso-svg" class="case-view" data-case-view="iso"></svg><div class="spatial-help"></div><div class="spatial-data-strip">old scene facts</div></div></main>`;
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    const { store } = await initializedStore();
    const catalog = loadBundledCatalog();
    const ready = store.getState().activePlan!.draft.config;
    store.setEvaluation(evaluateBuild(ready, catalog));
    const controller = mountSpatialView(document.getElementById("spatial-stage")!, store, () => catalog);
    expect(controller.getModel()?.nodes.some((node) => node.partId === "board")).toBe(true);

    store.setSelection({ partId: "board", view: "spatial" });
    store.replaceDraft(createEmptyBuildConfig(ready.id, "2026-08-27T00:00:00.000Z"));
    await Promise.resolve();

    expect(controller.getModel()).toBeNull();
    expect(controller.getOverlays()).toBeNull();
    expect(document.querySelector("[data-three-spatial-root]")?.classList.contains("is-partial")).toBe(true);
    expect(document.querySelector("[data-three-status]")?.textContent).toContain("不会保留上一版场景");
    expect(store.getState().selection).toBeNull();

    store.replaceDraft(ready);
    expect(controller.getModel()).toBeNull();
    store.setEvaluation(evaluateBuild(ready, catalog));
    expect(controller.getModel()?.nodes.some((node) => node.partId === "board")).toBe(true);
    expect(document.querySelector("[data-three-spatial-root]")?.classList.contains("is-partial")).toBe(false);

    controller.dispose();
    context.mockRestore();
    store.dispose();
  });

  it("clears a V2 Three scene and selection when acceptServerPlan installs a V3 partial draft", async () => {
    document.body.innerHTML = `<main id="n6-lab"><div class="case-view-toolbar"></div><div class="spatial-stage" id="spatial-stage"><svg id="iso-svg" class="case-view" data-case-view="iso"></svg></div></main>`;
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    const { store } = await initializedStore();
    const catalog = loadBundledCatalog();
    store.setEvaluation(evaluateBuild(store.getState().activePlan!.draft.config, catalog));
    const controller = mountSpatialView(
      document.getElementById("spatial-stage")!,
      store,
      () => catalog,
      undefined,
      { spatialScene: vi.fn(async () => { throw new Error("version is not a governed V3 scene"); }) },
    );
    expect(controller.getModel()?.nodes.length).toBeGreaterThan(0);
    store.setSelection({ partId: "board", view: "spatial" });

    const v3 = createEmptyBuildConfigV3("plan-12345678", "V3 partial", "2026-08-27T13:00:00.000Z");
    const accepted = structuredClone(store.getState().activePlan!) as BuildPlan<BuildConfigDocument>;
    accepted.draft.config = v3;
    accepted.draftRevision += 1;
    store.acceptServerPlan(accepted);
    await Promise.resolve();

    expect(controller.getModel()).toBeNull();
    expect(controller.getOverlays()).toBeNull();
    expect(document.querySelector("[data-three-spatial-root]")?.classList.contains("is-partial")).toBe(true);
    await vi.waitFor(() => expect(document.querySelector("[data-three-status]")?.textContent).toContain("空间场景不可用"));
    expect(store.getState().selection).toBeNull();

    controller.dispose();
    context.mockRestore();
    store.dispose();
  });

  it("loads a server-owned V3 scene for the exact active version and clears it on a draft edit", async () => {
    document.body.innerHTML = `<main id="n6-lab"><div class="case-view-toolbar"></div><div class="spatial-stage" id="spatial-stage"><svg id="iso-svg" class="case-view" data-case-view="iso"></svg></div></main>`;
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    const { store } = await initializedStore();
    const current = structuredClone(store.getState().activePlan!) as BuildPlan<BuildConfigDocument>;
    const v3 = createEmptyBuildConfigV3(current.id, "V3 spatial", "2026-08-29T00:00:00.000Z");
    v3.components = [{
      instanceId: "case-v3",
      kind: "case",
      role: "chassis",
      state: "planned",
      identity: { status: "resolved", skuId: "case.example", identityClaimIds: ["claim-case-v3"] },
      source: "user",
    }];
    current.draft.config = v3;
    current.draft.dirty = false;
    current.activeVersionId = "version-v3";
    current.draft.baseVersionId = "version-v3";
    store.acceptServerPlan(current);
    const scene: AuthoritativeSpatialSceneSnapshot = {
      schemaVersion: "authoritative-spatial-scene-v1",
      planId: current.id,
      planVersionId: "version-v3",
      configHash: "a".repeat(64),
      evaluationHash: "b".repeat(64),
      evaluationLockHash: "c".repeat(64),
      adapterSnapshotHash: "d".repeat(64),
      caseInstanceId: "case-v3",
      caseIdentity: { skuId: "case.example", region: "global", revision: "rev-a", manifestHash: "e".repeat(64) },
      executionStatus: "partial",
      blockedDomains: ["component_placement", "routing", "assembly"],
      model: {
        schemaVersion: "1.0.0",
        coordinateSystem: { units: "mm", origin: "case-envelope-center", axes: { x: "right", y: "up", z: "rear" }, anchor: "center" },
        caseSkuId: "case.example",
        bounds: { c: [0, 0, 0], w: 200, h: 300, d: 350 },
        nodes: [{
          id: "case-shell", partId: "case-shell", name: "Case", kind: "shell", layer: "shell",
          box: { c: [0, 0, 0], w: 200, h: 300, d: 350 }, rotation: [0, 0, 0], anchor: "center",
          skuId: "case.example", skuName: null, dimsLabel: "200 × 350 × 300 mm", sizeEvidence: "unknown",
          anchorEvidence: "unknown", evidence: "unknown", provenance: [], findingIds: [], mountedOn: null,
          repeatGroup: null, explodedOffset: [0, 0, 0], selectable: true, note: null,
        }],
        evaluationFindingIds: [],
      },
      overlays: {
        findings: [], routes: [], dimensions: [],
        thermal: { available: false, ambientC: null, note: "规划热场插值，非 CFD、非实测", sources: [] },
        assembly: [],
      },
    };
    const spatialScene = vi.fn(async () => structuredClone(scene));
    const controller = mountSpatialView(
      document.getElementById("spatial-stage")!,
      store,
      loadBundledCatalog,
      undefined,
      { spatialScene },
    );
    await vi.waitFor(() => expect(controller.getModel()?.caseSkuId).toBe("case.example"));
    expect(spatialScene).toHaveBeenCalledWith(current.id, "version-v3");
    expect(document.querySelector("[data-three-status]")?.textContent).toContain("服务端部分空间场景");

    const edited = structuredClone(v3);
    edited.notes = ["changed"];
    const editedPlan = structuredClone(store.getState().activePlan!) as BuildPlan<BuildConfigDocument>;
    editedPlan.draft.config = edited;
    editedPlan.draft.dirty = true;
    editedPlan.draftRevision += 1;
    store.acceptServerPlan(editedPlan);
    expect(controller.getModel()).toBeNull();
    expect(document.querySelector("[data-three-status]")?.textContent).toContain("草稿已修改");

    controller.dispose();
    context.mockRestore();
    store.dispose();
  });
});
