import type { SkuCatalog } from "../sku/types";
import type { PlanStore, PlanStoreState } from "../plans/client-store";
import { buildSpatialSceneModel, type SpatialSceneModel, type SpatialSceneNode } from "../spatial/model";
import { detectWebGl } from "../spatial/fallback";
import { SpatialSelectionController } from "../spatial/selection";
import "./spatial-view.css";

export interface SpatialViewController {
  getModel(): SpatialSceneModel | null;
  getMode(): "pending" | "three" | "fallback";
  dispose(): void;
}

interface ThreeSpatialRenderer {
  update(model: SpatialSceneModel): void;
  reset(): void;
  dispose(): void;
}

function createChrome(stage: HTMLElement) {
  const root = document.createElement("section");
  root.className = "three-spatial-root case-view";
  root.dataset.caseView = "iso";
  root.setAttribute("aria-label", "N6 Three.js 毫米空间场景");
  root.innerHTML = `
    <div class="three-spatial-canvas" data-three-canvas></div>
    <div class="three-spatial-toolbar" aria-label="3D 场景控制">
      <button type="button" data-camera="perspective" aria-pressed="true">透视</button>
      <button type="button" data-camera="orthographic" aria-pressed="false">正交</button>
      <button type="button" data-view="iso">等轴</button><button type="button" data-view="front">前</button><button type="button" data-view="side">侧</button><button type="button" data-view="top">顶</button>
      <button type="button" data-reset>复位</button>
      <label><input type="checkbox" data-explode> 爆炸</label>
      <details><summary>图层</summary><div data-layer-controls></div></details>
    </div>
    <aside class="three-spatial-inspector" data-inspector aria-live="polite"><p>点击部件查看尺寸与证据。</p></aside>
    <p class="three-spatial-status" data-three-status role="status">准备 3D 场景…</p>`;
  stage.insertBefore(root, stage.firstChild);
  const fallback = document.createElement("p");
  fallback.className = "three-spatial-fallback is-hidden";
  fallback.dataset.threeFallback = "";
  fallback.setAttribute("role", "status");
  stage.insertBefore(fallback, root.nextSibling);
  return { root, fallback };
}

function renderInspector(host: HTMLElement, node: SpatialSceneNode | null): void {
  host.replaceChildren();
  if (!node) {
    const hint = document.createElement("p");
    hint.textContent = "点击部件查看尺寸与证据。";
    host.append(hint);
    return;
  }
  const title = document.createElement("h4");
  title.textContent = node.name;
  const facts = document.createElement("dl");
  const add = (label: string, value: string) => {
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value;
    facts.append(dt, dd);
  };
  add("部件", node.partId);
  add("SKU", node.skuId ? `${node.skuName ?? node.skuId} · ${node.skuId}` : "非采购结构件");
  add("尺寸", `${node.box.w} × ${node.box.d} × ${node.box.h} mm · ${node.dimsLabel}`);
  add("位置", `x ${node.box.c[0]} · y ${node.box.c[1]} · z ${node.box.c[2]} mm`);
  add("证据", `尺寸 ${node.sizeEvidence} · 锚点 ${node.anchorEvidence} · 合并 ${node.evidence}`);
  add("来源", node.provenance.length ? node.provenance.map((item) => `${item.field}: ${item.sourceKind}${item.locator ? ` (${item.locator})` : ""}`).join("；") : "目录未提供字段级 provenance；保留 unknown/现有证据，不升级。 ");
  add("关联问题", node.findingIds.length ? node.findingIds.join("；") : "无");
  if (node.note) add("说明", node.note);
  host.append(title, facts);
}

export function mountSpatialView(stage: HTMLElement, store: PlanStore, getCatalog: () => SkuCatalog): SpatialViewController {
  const { root, fallback } = createChrome(stage);
  const canvasHost = root.querySelector<HTMLElement>("[data-three-canvas]")!;
  const status = root.querySelector<HTMLElement>("[data-three-status]")!;
  const inspector = root.querySelector<HTMLElement>("[data-inspector]")!;
  let model: SpatialSceneModel | null = null;
  let renderer: ThreeSpatialRenderer | null = null;
  let mode: "pending" | "three" | "fallback" = "pending";
  let disposed = false;
  let loading: Promise<void> | null = null;
  const forceFallback = new URLSearchParams(location.search).get("spatialFallback") === "1";
  const capability = detectWebGl(undefined, forceFallback);
  const selection = new SpatialSelectionController({ schemaVersion: "1.0.0", coordinateSystem: { units: "mm", origin: "case-envelope-center", axes: { x: "right", y: "up", z: "rear" }, anchor: "center" }, caseSkuId: "", bounds: { c: [0, 0, 0], w: 0, h: 0, d: 0 }, nodes: [], evaluationFindingIds: [] }, (node) => {
    renderInspector(inspector, node);
    store.setSelection(node ? { partId: node.partId, view: "spatial", ...(node.findingIds[0] ? { findingId: node.findingIds[0] } : {}) } : null);
  });

  const showFallback = (reason: string) => {
    mode = "fallback";
    stage.classList.remove("spatial-three-active");
    root.classList.add("is-hidden");
    fallback.classList.remove("is-hidden");
    fallback.textContent = `3D 不可用（${reason}），已保留可旋转、缩放和键盘操作的 SVG 空间视图。`;
  };

  const ensureRenderer = () => {
    if (renderer || loading || disposed || !model) return;
    if (!capability.available) { showFallback(capability.reason); return; }
    status.textContent = "正在按需载入 Three.js…";
    loading = import("../spatial/three-renderer").then(({ createThreeSpatialRenderer }) => {
      if (disposed || !model) return;
      renderer = createThreeSpatialRenderer({
        host: canvasHost,
        root,
        model,
        selection,
        onContextLost: () => showFallback("WebGL context lost"),
      });
      mode = "three";
      stage.classList.add("spatial-three-active");
      fallback.classList.add("is-hidden");
      status.textContent = "Three.js 场景已加载 · 单位 mm · 结论来自当前 BuildEvaluation";
    }).catch((error: unknown) => showFallback(error instanceof Error ? error.message : "renderer error")).finally(() => { loading = null; });
  };

  const onState = (state: PlanStoreState) => {
    if (!state.evaluation) return;
    model = buildSpatialSceneModel(state.evaluation, getCatalog());
    selection.setModel(model);
    renderer?.update(model);
    if (state.selection?.view === "spatial" && selection.getState().selectedPartId !== state.selection.partId) selection.select(state.selection.partId, false);
    ensureRenderer();
  };
  const unsubscribe = store.subscribe(onState);
  let observer: IntersectionObserver | null = null;
  if ("IntersectionObserver" in window) observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) { ensureRenderer(); observer?.disconnect(); }
  }, { rootMargin: "240px" });
  observer?.observe(stage);
  if (!observer) queueMicrotask(ensureRenderer);
  const resetButton = document.getElementById("spatial-reset");
  const onReset = () => renderer?.reset();
  resetButton?.addEventListener("click", onReset);

  const controller: SpatialViewController = {
    getModel: () => model ? structuredClone(model) : null,
    getMode: () => mode,
    dispose: () => {
      disposed = true;
      observer?.disconnect();
      unsubscribe();
      resetButton?.removeEventListener("click", onReset);
      renderer?.dispose();
      root.remove(); fallback.remove();
    },
  };
  return controller;
}
