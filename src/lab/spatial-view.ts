import type { SkuCatalog } from "../sku/types";
import type { PlanStore, PlanStoreState } from "../plans/client-store";
import { buildSpatialSceneModel, sceneNode, type SpatialSceneModel, type SpatialSceneNode } from "../spatial/model";
import { detectWebGl } from "../spatial/fallback";
import { SpatialSelectionController } from "../spatial/selection";
import { buildSpatialOverlayModel, configFieldPartIds, primaryPartForFinding, type SpatialOverlayModel } from "../spatial/overlays";
import type { WorkspaceRouter } from "./workspace-router";
import "./spatial-view.css";

export interface SpatialViewController {
  getModel(): SpatialSceneModel | null;
  getOverlays(): SpatialOverlayModel | null;
  getMode(): "pending" | "three" | "fallback";
  getContext(): Record<string, unknown>;
  dispose(): void;
}

interface ThreeSpatialRenderer {
  update(model: SpatialSceneModel, overlays: SpatialOverlayModel): void;
  focus(partId: string | null): void;
  setFinding(findingId: string | null): void;
  setRoutesVisible(visible: boolean): void;
  setDimensionsVisible(visible: boolean): void;
  setThermalVisible(visible: boolean): void;
  setAssemblyStep(index: number | null): void;
  capture(filename: string): void;
  getViewContext(): Record<string, unknown>;
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
      <label><input type="checkbox" data-routes> 走线</label>
      <label><input type="checkbox" data-dimensions> 关键尺寸</label>
      <label><input type="checkbox" data-thermal> 热场</label>
      <details><summary>图层</summary><div data-layer-controls></div></details>
    </div>
    <div class="three-spatial-workflow" aria-label="3D 工作流">
      <label>问题 <select data-finding-select><option value="">全部事实</option></select></label>
      <label>装机步骤 <select data-assembly-select><option value="">完整场景</option></select></label>
      <button type="button" data-assembly-prev aria-label="上一步">←</button><button type="button" data-assembly-next aria-label="下一步">→</button>
      <button type="button" data-edit-finding>定位配置</button><button type="button" data-ask-agent>询问 Agent</button><button type="button" data-capture>导出当前视图</button>
      <small data-workflow-note>图层只表达当前 BuildEvaluation，不生成独立结论。</small>
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

function renderInspector(host: HTMLElement, node: SpatialSceneNode | null, overlays: SpatialOverlayModel | null): void {
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
  add("关联问题", node.findingIds.length ? node.findingIds.map((id) => {
    const finding = overlays?.findings.find((item) => item.id === id);
    return finding ? `${finding.verdict} · ${finding.message}` : id;
  }).join("；") : "无");
  if (node.note) add("说明", node.note);
  host.append(title, facts);
}

export function mountSpatialView(stage: HTMLElement, store: PlanStore, getCatalog: () => SkuCatalog, router?: WorkspaceRouter): SpatialViewController {
  const { root, fallback } = createChrome(stage);
  const canvasHost = root.querySelector<HTMLElement>("[data-three-canvas]")!;
  const status = root.querySelector<HTMLElement>("[data-three-status]")!;
  const inspector = root.querySelector<HTMLElement>("[data-inspector]")!;
  const findingSelect = root.querySelector<HTMLSelectElement>("[data-finding-select]")!;
  const assemblySelect = root.querySelector<HTMLSelectElement>("[data-assembly-select]")!;
  const workflowNote = root.querySelector<HTMLElement>("[data-workflow-note]")!;
  let model: SpatialSceneModel | null = null;
  let overlays: SpatialOverlayModel | null = null;
  let evaluationHash: string | null = null;
  let renderer: ThreeSpatialRenderer | null = null;
  let mode: "pending" | "three" | "fallback" = "pending";
  let disposed = false;
  let loading: Promise<void> | null = null;
  const forceFallback = new URLSearchParams(location.search).get("spatialFallback") === "1";
  const capability = detectWebGl(undefined, forceFallback);
  const selection = new SpatialSelectionController({ schemaVersion: "1.0.0", coordinateSystem: { units: "mm", origin: "case-envelope-center", axes: { x: "right", y: "up", z: "rear" }, anchor: "center" }, caseSkuId: "", bounds: { c: [0, 0, 0], w: 0, h: 0, d: 0 }, nodes: [], evaluationFindingIds: [] }, (node) => {
    renderInspector(inspector, node, overlays);
    store.setSelection(node ? { partId: node.partId, view: "spatial", ...(node.findingIds[0] ? { findingId: node.findingIds[0] } : {}) } : null);
  });

  const populateWorkflow = () => {
    if (!overlays) return;
    const findingValue = findingSelect.value;
    findingSelect.replaceChildren(new Option("全部事实", ""), ...overlays.findings.filter((finding) => finding.verdict !== "ok").map((finding) => new Option(`${finding.verdict.toUpperCase()} · ${finding.message.slice(0, 46)}`, finding.id)));
    findingSelect.value = overlays.findings.some((finding) => finding.id === findingValue) ? findingValue : "";
    const assemblyValue = assemblySelect.value;
    assemblySelect.replaceChildren(new Option("完整场景", ""), ...overlays.assembly.map((step, index) => new Option(`${index + 1}. ${step.label}`, String(index))));
    assemblySelect.value = Number(assemblyValue) < overlays.assembly.length ? assemblyValue : "";
    workflowNote.textContent = overlays.thermal.available ? `${overlays.thermal.note} · ${overlays.routes.length} 条 BuildEvaluation 走线` : `热场 unavailable · ${overlays.routes.length} 条 BuildEvaluation 走线`;
  };

  const showFallback = (reason: string) => {
    mode = "fallback";
    stage.classList.remove("spatial-three-active");
    root.classList.add("is-hidden");
    fallback.classList.remove("is-hidden");
    fallback.textContent = `3D 不可用（${reason}），已保留可旋转、缩放和键盘操作的 SVG 空间视图。`;
  };

  const ensureRenderer = () => {
    if (renderer || loading || disposed || !model || !overlays) return;
    if (!capability.available) { showFallback(capability.reason); return; }
    status.textContent = "正在按需载入 Three.js…";
    loading = import("../spatial/three-renderer").then(({ createThreeSpatialRenderer }) => {
      if (disposed || !model || !overlays) return;
      renderer = createThreeSpatialRenderer({
        host: canvasHost,
        root,
        model,
        overlays,
        selection,
        onContextLost: () => showFallback("WebGL context lost"),
      });
      const state = store.getState();
      if (state.selection?.partId) renderer.focus(state.selection.partId);
      if (state.selection?.findingId) renderer.setFinding(state.selection.findingId);
      renderer.setRoutesVisible(Boolean(root.querySelector<HTMLInputElement>("[data-routes]")?.checked));
      renderer.setDimensionsVisible(Boolean(root.querySelector<HTMLInputElement>("[data-dimensions]")?.checked));
      renderer.setThermalVisible(Boolean(root.querySelector<HTMLInputElement>("[data-thermal]")?.checked));
      mode = "three";
      stage.classList.add("spatial-three-active");
      fallback.classList.add("is-hidden");
      status.textContent = "Three.js 场景已加载 · 单位 mm · 结论来自当前 BuildEvaluation";
    }).catch((error: unknown) => showFallback(error instanceof Error ? error.message : "renderer error")).finally(() => { loading = null; });
  };

  const onState = (state: PlanStoreState) => {
    if (!state.evaluation) return;
    model = buildSpatialSceneModel(state.evaluation, getCatalog());
    overlays = buildSpatialOverlayModel(state.evaluation, model);
    evaluationHash = state.evaluationSnapshot?.evaluationHash ?? null;
    populateWorkflow();
    selection.setModel(model);
    renderer?.update(model, overlays);
    if (state.selection?.findingId && !overlays.findings.some((finding) => finding.id === state.selection?.findingId)) {
      store.setSelection({ partId: state.selection.partId, view: state.selection.view });
      return;
    }
    if (state.selection) {
      if (selection.getState().selectedPartId !== state.selection.partId) selection.select(state.selection.partId, false);
      renderer?.focus(state.selection.partId);
      renderInspector(inspector, sceneNode(model, state.selection.partId), overlays);
    }
    if (state.selection?.findingId) {
      findingSelect.value = state.selection.findingId;
      renderer?.setFinding(state.selection.findingId);
    }
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

  root.querySelector<HTMLInputElement>("[data-routes]")?.addEventListener("change", (event) => renderer?.setRoutesVisible((event.target as HTMLInputElement).checked));
  root.querySelector<HTMLInputElement>("[data-dimensions]")?.addEventListener("change", (event) => renderer?.setDimensionsVisible((event.target as HTMLInputElement).checked));
  root.querySelector<HTMLInputElement>("[data-thermal]")?.addEventListener("change", (event) => renderer?.setThermalVisible((event.target as HTMLInputElement).checked));
  findingSelect.addEventListener("change", () => {
    const findingId = findingSelect.value || null;
    renderer?.setFinding(findingId);
    const partId = findingId && overlays ? primaryPartForFinding(overlays, findingId) : null;
    selection.select(partId, false);
    renderInspector(inspector, partId && model ? sceneNode(model, partId) : null, overlays);
    store.setSelection(partId ? { partId, view: "spatial", ...(findingId ? { findingId } : {}) } : null);
  });
  const setAssembly = (index: number | null) => {
    assemblySelect.value = index === null ? "" : String(index);
    renderer?.setAssemblyStep(index);
    const partId = index === null ? null : overlays?.assembly[index]?.partIds[0] ?? null;
    if (partId) { selection.select(partId); renderer?.focus(partId); }
  };
  assemblySelect.addEventListener("change", () => setAssembly(assemblySelect.value === "" ? null : Number(assemblySelect.value)));
  root.querySelector("[data-assembly-prev]")?.addEventListener("click", () => setAssembly(Math.max(0, (Number(assemblySelect.value || 0) - 1))));
  root.querySelector("[data-assembly-next]")?.addEventListener("click", () => setAssembly(Math.min((overlays?.assembly.length ?? 1) - 1, Number(assemblySelect.value || -1) + 1)));
  root.querySelector("[data-edit-finding]")?.addEventListener("click", () => {
    const finding = overlays?.findings.find((item) => item.id === findingSelect.value) ?? overlays?.findings.find((item) => item.partIds.includes(selection.getState().selectedPartId ?? ""));
    if (!finding) return;
    router?.navigate("editor");
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-editor-field="${finding.editorField}"] input, [data-editor-field="${finding.editorField}"] select`)?.focus());
  });
  root.querySelector("[data-ask-agent]")?.addEventListener("click", () => {
    const state = store.getState();
    document.dispatchEvent(new CustomEvent("build-sim:spatial-agent-context", { detail: {
      planId: state.activePlan?.id ?? null,
      planVersionId: state.activePlan?.activeVersionId ?? null,
      draftRevision: state.activePlan?.draftRevision ?? null,
      evaluationHash,
      selection: state.selection,
      camera: renderer?.getViewContext() ?? null,
    } }));
    router?.navigate("agent");
  });
  root.querySelector("[data-capture]")?.addEventListener("click", () => renderer?.capture(`build-sim-spatial-${evaluationHash?.slice(0, 12) ?? "unversioned"}.png`));
  const onFindingFocus = (event: Event) => {
    const findingId = (event as CustomEvent<{ findingId?: string }>).detail?.findingId;
    if (!findingId || !overlays) return;
    findingSelect.value = findingId;
    renderer?.setFinding(findingId);
    const partId = primaryPartForFinding(overlays, findingId);
    if (partId) store.setSelection({ partId, view: "spatial", findingId });
  };
  const onEditorFieldFocus = (event: Event) => {
    const field = (event as CustomEvent<{ field?: string }>).detail?.field;
    if (!field || !model) return;
    const partId = configFieldPartIds(field, model)[0];
    if (partId) store.setSelection({ partId, view: "editor" });
  };
  document.addEventListener("build-sim:finding-focus", onFindingFocus);
  document.addEventListener("build-sim:editor-field-focus", onEditorFieldFocus);

  const controller: SpatialViewController = {
    getModel: () => model ? structuredClone(model) : null,
    getOverlays: () => overlays ? structuredClone(overlays) : null,
    getMode: () => mode,
    getContext: () => ({ evaluationHash, selection: store.getState().selection, ...(renderer?.getViewContext() ?? {}) }),
    dispose: () => {
      disposed = true;
      observer?.disconnect();
      unsubscribe();
      document.removeEventListener("build-sim:finding-focus", onFindingFocus);
      document.removeEventListener("build-sim:editor-field-focus", onEditorFieldFocus);
      resetButton?.removeEventListener("click", onReset);
      renderer?.dispose();
      root.remove(); fallback.remove();
    },
  };
  return controller;
}
