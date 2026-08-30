import type { SkuCatalog } from "../sku/types";
import type { PlanStore, PlanStoreState } from "../plans/client-store";
import { buildSpatialSceneModel, sceneNode, type SpatialSceneModel, type SpatialSceneNode } from "../spatial/model";
import { detectWebGl } from "../spatial/fallback";
import { SpatialSelectionController } from "../spatial/selection";
import { buildSpatialOverlayModel, configFieldPartIds, primaryPartForFinding, type SpatialOverlayModel } from "../spatial/overlays";
import type { WorkspaceRouter } from "./workspace-router";
import { buildReadiness } from "../config/validate";
import type { BuildConfigV3 } from "../topology/contracts";
import { WorkspaceApiClient } from "../plans/client";
import type { AuthoritativeSpatialSceneSnapshot } from "../spatial/authoritative-scene";
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
  focus(partId: string | null, frame?: boolean): void;
  setFinding(findingId: string | null, frame?: boolean): void;
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
  root.className = "three-spatial-root";
  root.dataset.threeSpatialRoot = "";
  root.setAttribute("aria-label", "N6 Three.js 毫米空间场景");
  root.innerHTML = `
    <div class="three-spatial-canvas" data-three-canvas></div>
    <div class="three-spatial-toolbar" aria-label="3D 场景控制">
      <div class="three-spatial-control-group">
        <span>投影</span>
        <div class="three-spatial-segmented">
          <button type="button" data-camera="perspective" aria-pressed="true">透视</button>
          <button type="button" data-camera="orthographic" aria-pressed="false">正交</button>
        </div>
      </div>
      <div class="three-spatial-control-group">
        <span>视角</span>
        <div class="three-spatial-segmented">
          <button type="button" data-view="iso" aria-pressed="true">等轴</button>
          <button type="button" data-view="front" aria-pressed="false">正面</button>
          <button type="button" data-view="side" aria-pressed="false">侧面</button>
          <button type="button" data-view="top" aria-pressed="false">顶部</button>
        </div>
      </div>
      <details class="three-spatial-display-menu">
        <summary>显示与图层</summary>
        <div class="three-spatial-display-panel">
          <div class="three-spatial-display-toggles">
            <label><input type="checkbox" data-explode> 爆炸视图</label>
            <label><input type="checkbox" data-routes> 走线</label>
            <label><input type="checkbox" data-dimensions> 关键尺寸</label>
            <label><input type="checkbox" data-thermal> 热场</label>
          </div>
          <fieldset><legend>场景图层</legend><div data-layer-controls></div></fieldset>
        </div>
      </details>
      <button type="button" class="three-spatial-reset" data-reset>重置视图</button>
    </div>
    <div class="three-spatial-workflow" aria-label="3D 工作流">
      <label class="three-spatial-workflow-field"><span>问题定位</span><select data-finding-select><option value="">全部事实</option></select></label>
      <div class="three-spatial-step-field">
        <label class="three-spatial-workflow-field"><span>装机步骤</span><select data-assembly-select><option value="">完整场景</option></select></label>
        <div class="three-spatial-step-nav" role="group" aria-label="切换装机步骤">
          <button type="button" data-assembly-prev aria-label="上一步">← 上一步</button>
          <button type="button" data-assembly-next aria-label="下一步">下一步 →</button>
        </div>
      </div>
      <div class="three-spatial-workflow-actions">
        <button type="button" data-edit-finding>定位配置</button>
        <button type="button" data-ask-agent>询问 Agent</button>
        <button type="button" data-capture>导出视图</button>
      </div>
      <small data-workflow-note>图层只表达当前 BuildEvaluation，不生成独立结论。</small>
    </div>
    <aside class="three-spatial-inspector is-empty" data-inspector aria-live="polite"><p>点击部件查看尺寸与证据。</p></aside>
    <p class="three-spatial-status" data-three-status role="status">准备 3D 场景…</p>`;
  stage.insertBefore(root, stage.firstChild);
  const fallback = document.createElement("p");
  fallback.className = "three-spatial-fallback is-hidden";
  fallback.dataset.threeFallback = "";
  fallback.setAttribute("role", "status");
  stage.insertBefore(fallback, root.nextSibling);
  return { root, fallback };
}

function option(label: string, value: string): HTMLOptionElement {
  const element = document.createElement("option");
  element.textContent = label;
  element.value = value;
  return element;
}

export interface SpatialEvaluationIdentity {
  sourceKey: string;
  snapshotHash: string | null;
}

function emptySpatialModel(): SpatialSceneModel {
  return {
    schemaVersion: "1.0.0",
    coordinateSystem: { units: "mm", origin: "case-envelope-center", axes: { x: "right", y: "up", z: "rear" }, anchor: "center" },
    caseSkuId: "",
    bounds: { c: [0, 0, 0], w: 0, h: 0, d: 0 },
    nodes: [],
    evaluationFindingIds: [],
  };
}

function isBuildConfigV3(config: unknown): config is BuildConfigV3 {
  return Boolean(config && typeof config === "object" && (config as { schemaVersion?: unknown }).schemaVersion === "3.0.0");
}

/** Store emissions are frequent; only a changed evaluation identity may rebuild WebGL resources. */
export function shouldRebuildSpatialModel(
  previous: SpatialEvaluationIdentity | null,
  next: SpatialEvaluationIdentity,
  hasModel: boolean,
): boolean {
  if (!hasModel || !previous) return true;
  if (previous.snapshotHash !== null && next.snapshotHash === null) return true;
  if (next.snapshotHash !== null) {
    if (previous.snapshotHash !== null) return next.snapshotHash !== previous.snapshotHash;
    return previous.sourceKey !== next.sourceKey;
  }
  return previous.sourceKey !== next.sourceKey;
}

function renderInspector(host: HTMLElement, node: SpatialSceneNode | null, overlays: SpatialOverlayModel | null): void {
  host.replaceChildren();
  host.classList.toggle("is-empty", !node);
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

export function mountSpatialView(
  stage: HTMLElement,
  store: PlanStore,
  getCatalog: () => SkuCatalog,
  router?: WorkspaceRouter,
  spatialApi: Pick<WorkspaceApiClient, "spatialScene"> = new WorkspaceApiClient(),
): SpatialViewController {
  const { root, fallback } = createChrome(stage);
  const legacyToolbar = stage.previousElementSibling instanceof HTMLElement && stage.previousElementSibling.classList.contains("case-view-toolbar")
    ? stage.previousElementSibling
    : null;
  const legacyToolbarWasHidden = legacyToolbar?.classList.contains("is-hidden") ?? false;
  const hideLegacyToolbar = () => legacyToolbar?.classList.add("is-hidden");
  const restoreLegacyToolbar = () => {
    if (!legacyToolbarWasHidden) legacyToolbar?.classList.remove("is-hidden");
  };
  stage.classList.add("spatial-three-pending");
  hideLegacyToolbar();
  const canvasHost = root.querySelector<HTMLElement>("[data-three-canvas]")!;
  const status = root.querySelector<HTMLElement>("[data-three-status]")!;
  const inspector = root.querySelector<HTMLElement>("[data-inspector]")!;
  const findingSelect = root.querySelector<HTMLSelectElement>("[data-finding-select]")!;
  const assemblySelect = root.querySelector<HTMLSelectElement>("[data-assembly-select]")!;
  const assemblyPrev = root.querySelector<HTMLButtonElement>("[data-assembly-prev]")!;
  const assemblyNext = root.querySelector<HTMLButtonElement>("[data-assembly-next]")!;
  const workflowNote = root.querySelector<HTMLElement>("[data-workflow-note]")!;
  let model: SpatialSceneModel | null = null;
  let overlays: SpatialOverlayModel | null = null;
  let evaluationHash: string | null = null;
  let renderer: ThreeSpatialRenderer | null = null;
  let mode: "pending" | "three" | "fallback" = "pending";
  let disposed = false;
  let loading: Promise<void> | null = null;
  let sceneGeneration = 0;
  let evaluationIdentity: SpatialEvaluationIdentity | null = null;
  let syncedPartId: string | null = null;
  let syncedFindingId: string | null = null;
  let v3LoadedKey: string | null = null;
  let v3LoadingKey: string | null = null;
  let v3RequestGeneration = 0;
  let authoritativeSceneStatus: string | null = null;
  const forceFallback = new URLSearchParams(location.search).get("spatialFallback") === "1";
  const capability = detectWebGl(undefined, forceFallback);
  const selection = new SpatialSelectionController({ schemaVersion: "1.0.0", coordinateSystem: { units: "mm", origin: "case-envelope-center", axes: { x: "right", y: "up", z: "rear" }, anchor: "center" }, caseSkuId: "", bounds: { c: [0, 0, 0], w: 0, h: 0, d: 0 }, nodes: [], evaluationFindingIds: [] }, (node) => {
    renderInspector(inspector, node, overlays);
    publishSelection(node ? { partId: node.partId, view: "spatial" } : null);
  });

  const sameSelection = (left: PlanStoreState["selection"], right: PlanStoreState["selection"]) => left?.partId === right?.partId
    && left?.view === right?.view
    && left?.findingId === right?.findingId
    && Boolean(left) === Boolean(right);
  function publishSelection(next: PlanStoreState["selection"]): void {
    if (!sameSelection(store.getState().selection, next)) store.setSelection(next);
  }
  const updateAssemblyButtons = () => {
    const index = assemblySelect.value === "" ? null : Number(assemblySelect.value);
    assemblyPrev.disabled = index === null;
    assemblyNext.disabled = !overlays?.assembly.length || index === overlays.assembly.length - 1;
  };

  const populateWorkflow = () => {
    if (!overlays) return;
    const findingValue = findingSelect.value;
    findingSelect.replaceChildren(option("全部事实", ""), ...overlays.findings.filter((finding) => finding.verdict !== "ok").map((finding) => option(`${finding.verdict.toUpperCase()} · ${finding.message.slice(0, 46)}`, finding.id)));
    findingSelect.value = overlays.findings.some((finding) => finding.id === findingValue) ? findingValue : "";
    const assemblyValue = assemblySelect.value;
    assemblySelect.replaceChildren(option("完整场景", ""), ...overlays.assembly.map((step, index) => option(`${index + 1}. ${step.label}`, String(index))));
    assemblySelect.value = Number(assemblyValue) < overlays.assembly.length ? assemblyValue : "";
    updateAssemblyButtons();
    workflowNote.textContent = overlays.thermal.available ? `${overlays.thermal.note} · ${overlays.routes.length} 条 BuildEvaluation 走线` : `热场 unavailable · ${overlays.routes.length} 条 BuildEvaluation 走线`;
  };

  const showFallback = (reason: string) => {
    mode = "fallback";
    renderer?.dispose();
    renderer = null;
    stage.classList.remove("spatial-three-active", "spatial-three-pending");
    root.classList.add("is-hidden");
    fallback.classList.remove("is-hidden");
    restoreLegacyToolbar();
    fallback.textContent = `3D 不可用（${reason}），已保留可旋转、缩放和键盘操作的 SVG 空间视图。`;
  };

  const ensureRenderer = () => {
    if (renderer || loading || disposed || !model || !overlays) return;
    if (!capability.available) { showFallback(capability.reason); return; }
    status.textContent = authoritativeSceneStatus
      ? `${authoritativeSceneStatus} · 正在按需载入 Three.js…`
      : "正在按需载入 Three.js…";
    const generation = sceneGeneration;
    loading = import("../spatial/three-renderer").then(({ createThreeSpatialRenderer }) => {
      if (disposed || generation !== sceneGeneration || !model || !overlays) return;
      renderer = createThreeSpatialRenderer({
        host: canvasHost,
        root,
        model,
        overlays,
        selection,
        onContextLost: () => showFallback("WebGL context lost"),
      });
      const state = store.getState();
      renderer.setFinding(state.selection?.findingId ?? null, false);
      renderer.focus(state.selection?.partId ?? null, Boolean(state.selection?.partId));
      renderer.setRoutesVisible(Boolean(root.querySelector<HTMLInputElement>("[data-routes]")?.checked));
      renderer.setDimensionsVisible(Boolean(root.querySelector<HTMLInputElement>("[data-dimensions]")?.checked));
      renderer.setThermalVisible(Boolean(root.querySelector<HTMLInputElement>("[data-thermal]")?.checked));
      mode = "three";
      stage.classList.remove("spatial-three-pending");
      stage.classList.add("spatial-three-active");
      hideLegacyToolbar();
      fallback.classList.add("is-hidden");
      status.textContent = authoritativeSceneStatus
        ? `${authoritativeSceneStatus} · Three.js 已加载`
        : "Three.js 场景已加载 · 单位 mm · 结论来自当前 BuildEvaluation";
    }).catch((error: unknown) => {
      if (!disposed && generation === sceneGeneration) showFallback(error instanceof Error ? error.message : "renderer error");
    }).finally(() => {
      const retryCurrentScene = generation !== sceneGeneration && Boolean(model && overlays);
      loading = null;
      if (retryCurrentScene) ensureRenderer();
    });
  };

  /** Clear a previous V2 scene before showing any state without a V2 evaluation. */
  const clearScene = (copy: { status: string; workflow: string; findingLabel: string; assemblyLabel: string }) => {
    sceneGeneration += 1;
    renderer?.dispose();
    renderer = null;
    model = null;
    overlays = null;
    evaluationIdentity = null;
    evaluationHash = null;
    syncedPartId = null;
    syncedFindingId = null;
    authoritativeSceneStatus = null;
    selection.select(null, false);
    selection.setModel(emptySpatialModel());
    canvasHost.replaceChildren();
    findingSelect.replaceChildren(option(copy.findingLabel, ""));
    assemblySelect.replaceChildren(option(copy.assemblyLabel, ""));
    findingSelect.disabled = true;
    assemblySelect.disabled = true;
    assemblyPrev.disabled = true;
    assemblyNext.disabled = true;
    renderInspector(inspector, null, null);
    workflowNote.textContent = copy.workflow;
    status.textContent = copy.status;
    root.classList.remove("is-hidden");
    root.classList.add("is-partial");
    fallback.classList.add("is-hidden");
    stage.classList.remove("spatial-three-active");
    stage.classList.add("spatial-three-pending");
    mode = "pending";
    hideLegacyToolbar();
  };

  const syncSceneSelection = (state: PlanStoreState) => {
    if (!model || !overlays) return;
    const partId = state.selection?.partId && sceneNode(model, state.selection.partId) ? state.selection.partId : null;
    const findingId = state.selection?.findingId && overlays.findings.some((finding) => finding.id === state.selection?.findingId)
      ? state.selection.findingId
      : null;
    const normalizedSelection = partId ? { partId, view: state.selection?.view ?? "spatial", ...(findingId ? { findingId } : {}) } : null;
    const selectionChanged = partId !== syncedPartId;
    const findingChanged = findingId !== syncedFindingId;
    syncedPartId = partId;
    syncedFindingId = findingId;
    if (selection.getState().selectedPartId !== partId) selection.select(partId, false);
    findingSelect.value = findingId ?? "";
    if (findingChanged) renderer?.setFinding(findingId, false);
    if (selectionChanged || findingChanged) renderer?.focus(partId, Boolean(partId));
    renderInspector(inspector, partId ? sceneNode(model, partId) : null, overlays);
    if (!sameSelection(state.selection, normalizedSelection)) queueMicrotask(() => {
      if (!disposed) publishSelection(normalizedSelection);
    });
  };

  const installV3Scene = (snapshot: AuthoritativeSpatialSceneSnapshot, key: string) => {
    sceneGeneration += 1;
    v3LoadedKey = key;
    model = structuredClone(snapshot.model);
    overlays = structuredClone(snapshot.overlays);
    evaluationHash = snapshot.evaluationHash;
    evaluationIdentity = { sourceKey: key, snapshotHash: snapshot.evaluationHash };
    root.classList.remove("is-hidden");
    root.classList.toggle("is-partial", snapshot.executionStatus !== "ready");
    fallback.classList.add("is-hidden");
    stage.classList.add("spatial-three-pending");
    stage.classList.remove("spatial-three-active");
    mode = "pending";
    findingSelect.disabled = snapshot.overlays.findings.length === 0;
    assemblySelect.disabled = snapshot.overlays.assembly.length === 0;
    populateWorkflow();
    selection.setModel(model);
    renderer?.update(model, overlays);
    const blocked = snapshot.blockedDomains.length ? `；阻断域：${snapshot.blockedDomains.join("、")}` : "";
    authoritativeSceneStatus = snapshot.executionStatus === "ready"
      ? `已加载服务端锁定空间场景 · ${snapshot.caseIdentity.skuId} · 单位 mm`
      : `已加载服务端部分空间场景 · 仅显示有权威坐标的结构${blocked}`;
    status.textContent = authoritativeSceneStatus;
    workflowNote.textContent = snapshot.executionStatus === "ready"
      ? "场景绑定不可变方案版本与适配器制品。"
      : "未解析的部件位置、走线与装配步骤保持阻断，不使用占位结果。";
    syncSceneSelection(store.getState());
    ensureRenderer();
  };

  const onState = (state: PlanStoreState) => {
    const config = state.activePlan?.draft.config;
    if (isBuildConfigV3(config)) {
      const plan = state.activePlan;
      const versionId = plan?.activeVersionId;
      if (!plan || !versionId || plan.draft.dirty) {
        if (v3LoadedKey || v3LoadingKey || model) {
          v3RequestGeneration += 1; v3LoadedKey = null; v3LoadingKey = null;
          clearScene({
            status: plan?.draft.dirty ? "方案草稿已修改；保存并完成受治理评估后再刷新空间场景。" : "V3 方案尚无可重放版本；不会显示旧空间结论。",
            workflow: "空间场景必须绑定不可变方案版本与精确适配器制品。",
            findingLabel: "等待锁定空间评估",
            assemblyLabel: "等待锁定空间评估",
          });
        }
        if (state.selection) queueMicrotask(() => { if (!disposed && isBuildConfigV3(store.getState().activePlan?.draft.config)) publishSelection(null); });
        return;
      }
      const key = `${plan.id}:${versionId}`;
      if (v3LoadedKey === key && model && overlays) {
        syncSceneSelection(state);
        ensureRenderer();
        return;
      }
      if (v3LoadingKey === key) return;
      v3RequestGeneration += 1;
      const requestGeneration = v3RequestGeneration;
      v3LoadedKey = null;
      v3LoadingKey = key;
      clearScene({
        status: "正在读取服务端锁定的 V3 空间场景…",
        workflow: "校验方案版本、评估锁和适配器制品。",
        findingLabel: "读取空间场景",
        assemblyLabel: "读取装配场景",
      });
      if (state.selection) queueMicrotask(() => {
        const current = store.getState();
        if (!disposed && isBuildConfigV3(current.activePlan?.draft.config)) publishSelection(null);
      });
      void spatialApi.spatialScene(plan.id, versionId).then((snapshot) => {
        if (disposed || requestGeneration !== v3RequestGeneration || v3LoadingKey !== key) return;
        const current = store.getState().activePlan;
        if (!current || current.id !== plan.id || current.activeVersionId !== versionId || current.draft.dirty
          || snapshot.planId !== plan.id || snapshot.planVersionId !== versionId) return;
        v3LoadingKey = null;
        installV3Scene(snapshot, key);
      }).catch((error: unknown) => {
        if (disposed || requestGeneration !== v3RequestGeneration || v3LoadingKey !== key) return;
        v3LoadingKey = null;
        clearScene({
          status: `空间场景不可用：${error instanceof Error ? error.message : "服务端拒绝场景"}`,
          workflow: "未通过版本/制品闭包校验时保持未知，不回退到浏览器旧结果。",
          findingLabel: "空间场景不可用",
          assemblyLabel: "空间场景不可用",
        });
      });
      return;
    }
    if (v3LoadedKey || v3LoadingKey) {
      v3RequestGeneration += 1; v3LoadedKey = null; v3LoadingKey = null;
    }
    if (!state.evaluation) {
      clearScene({
        status: "尚未生成当前方案的空间评估；不会保留上一版场景。",
        workflow: "等待当前 BuildEvaluation 后再生成空间、走线或热场结论。",
        findingLabel: "等待当前评估",
        assemblyLabel: "等待当前评估",
      });
      if (state.selection) queueMicrotask(() => { if (!disposed && !store.getState().evaluation) publishSelection(null); });
      return;
    }
    const readiness = state.activePlan ? buildReadiness(state.activePlan.draft.config, getCatalog()) : state.evaluation.readiness;
    if (readiness.status === "incomplete") {
      clearScene({
        status: `方案还缺 ${readiness.missing.length} 项核心选择；完成后再生成 3D 场景。`,
        workflow: "完整配置前不生成空间、走线或热场结论。",
        findingLabel: "方案未完整",
        assemblyLabel: "等待核心选择",
      });
      if (state.selection) queueMicrotask(() => {
        const current = store.getState();
        if (!disposed && current.activePlan && !isBuildConfigV3(current.activePlan.draft.config)
          && buildReadiness(current.activePlan.draft.config, getCatalog()).status === "incomplete") publishSelection(null);
      });
      return;
    }
    root.classList.remove("is-partial", "is-hidden");
    findingSelect.disabled = false;
    assemblySelect.disabled = false;
    fallback.classList.add("is-hidden");
    if (!renderer) {
      mode = "pending";
      stage.classList.add("spatial-three-pending");
      hideLegacyToolbar();
    }
    const nextIdentity: SpatialEvaluationIdentity = {
      sourceKey: `${state.activePlan?.id ?? "no-plan"}:${state.activePlan?.draftRevision ?? -1}:${state.localRevision}`,
      snapshotHash: state.evaluationSnapshot?.evaluationHash ?? null,
    };
    const rebuildModel = shouldRebuildSpatialModel(evaluationIdentity, nextIdentity, Boolean(model && overlays));
    evaluationIdentity = nextIdentity;
    evaluationHash = nextIdentity.snapshotHash;
    if (rebuildModel) {
      model = buildSpatialSceneModel(state.evaluation, getCatalog());
      overlays = buildSpatialOverlayModel(state.evaluation, model);
      populateWorkflow();
      selection.setModel(model);
      renderer?.update(model, overlays);
    }
    if (!model || !overlays) return;

    syncSceneSelection(state);
    ensureRenderer();
  };
  const unsubscribe = store.subscribe(onState);
  let observer: IntersectionObserver | null = null;
  if ("IntersectionObserver" in window) observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) { ensureRenderer(); observer?.disconnect(); }
  }, { rootMargin: "240px" });
  observer?.observe(stage);
  if (!observer) queueMicrotask(ensureRenderer);
  root.querySelector<HTMLInputElement>("[data-routes]")?.addEventListener("change", (event) => renderer?.setRoutesVisible((event.target as HTMLInputElement).checked));
  root.querySelector<HTMLInputElement>("[data-dimensions]")?.addEventListener("change", (event) => renderer?.setDimensionsVisible((event.target as HTMLInputElement).checked));
  root.querySelector<HTMLInputElement>("[data-thermal]")?.addEventListener("change", (event) => renderer?.setThermalVisible((event.target as HTMLInputElement).checked));
  findingSelect.addEventListener("change", () => {
    const findingId = findingSelect.value || null;
    const partId = findingId && overlays ? primaryPartForFinding(overlays, findingId) : null;
    selection.select(partId, false);
    renderInspector(inspector, partId && model ? sceneNode(model, partId) : null, overlays);
    publishSelection(partId ? { partId, view: "spatial", ...(findingId ? { findingId } : {}) } : null);
  });
  const setAssembly = (index: number | null) => {
    const normalized = index !== null && Number.isInteger(index) && index >= 0 && index < (overlays?.assembly.length ?? 0) ? index : null;
    assemblySelect.value = normalized === null ? "" : String(normalized);
    renderer?.setAssemblyStep(normalized);
    updateAssemblyButtons();
    const partId = normalized === null ? null : overlays?.assembly[normalized]?.partIds[0] ?? null;
    if (partId) { selection.select(partId, false); renderer?.focus(partId); publishSelection({ partId, view: "spatial" }); }
  };
  assemblySelect.addEventListener("change", () => setAssembly(assemblySelect.value === "" ? null : Number(assemblySelect.value)));
  assemblyPrev.addEventListener("click", () => setAssembly(assemblySelect.value === "" ? null : Number(assemblySelect.value) - 1));
  assemblyNext.addEventListener("click", () => setAssembly(assemblySelect.value === "" ? 0 : Number(assemblySelect.value) + 1));
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
    const partId = primaryPartForFinding(overlays, findingId);
    if (partId) publishSelection({ partId, view: "spatial", findingId });
  };
  const onEditorFieldFocus = (event: Event) => {
    const field = (event as CustomEvent<{ field?: string }>).detail?.field;
    if (!field || !model) return;
    const partId = configFieldPartIds(field, model)[0];
    if (partId) publishSelection({ partId, view: "editor" });
  };
  const onTaskFocus = (event: Event) => {
    const detail = (event as CustomEvent<{ partId?: string; cableId?: string }>).detail;
    if (!detail || !overlays) return;
    if (detail.cableId) {
      const routesToggle = root.querySelector<HTMLInputElement>("[data-routes]");
      if (routesToggle) routesToggle.checked = true;
      renderer?.setRoutesVisible(true);
      const stepIndex = overlays.assembly.findIndex((step) => step.cableId === detail.cableId);
      if (stepIndex >= 0) setAssembly(stepIndex);
      const route = overlays.routes.find((candidate) => candidate.id === detail.cableId || candidate.id.includes(detail.cableId!));
      const endpoint = route?.endpointPartIds.find((partId) => model?.nodes.some((node) => node.partId === partId));
      if (endpoint) publishSelection({ partId: endpoint, view: "routing" });
    }
    if (detail.partId && model?.nodes.some((node) => node.partId === detail.partId)) {
      selection.select(detail.partId, false);
      renderer?.focus(detail.partId);
      publishSelection({ partId: detail.partId, view: detail.cableId ? "routing" : "spatial" });
    }
  };
  document.addEventListener("build-sim:finding-focus", onFindingFocus);
  document.addEventListener("build-sim:editor-field-focus", onEditorFieldFocus);
  document.addEventListener("build-sim:task-focus", onTaskFocus);

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
      document.removeEventListener("build-sim:task-focus", onTaskFocus);
      renderer?.dispose();
      stage.classList.remove("spatial-three-active", "spatial-three-pending");
      restoreLegacyToolbar();
      root.remove(); fallback.remove();
    },
  };
  return controller;
}
