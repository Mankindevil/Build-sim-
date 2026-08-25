import { parseConfig, type BuildConfig } from "../config/types";
import type { BuildEvaluation } from "../core/evaluate";
import type { PlanStore, PlanStoreState } from "../plans/client-store";
import { createDefaultN6Config } from "../plans/default-plan";
import { diffBuildConfigs } from "../plans/diff";
import { targetForFinding } from "../plans/finding-targets";
import type { PlanVersion } from "../plans/contracts";
import { WorkspaceRouter } from "./workspace-router";
import "./workspace-pages.css";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatCny(value: number | null | undefined): string {
  return typeof value === "number" ? `¥${Math.round(value).toLocaleString("zh-CN")}` : "unknown";
}

function evaluationSummary(evaluation: BuildEvaluation | null): { bad: number; warn: number; budget: number | null; unknown: number } {
  if (!evaluation) return { bad: 0, warn: 0, budget: null, unknown: 0 };
  return {
    bad: evaluation.findings.filter((finding) => finding.verdict === "bad").length,
    warn: evaluation.findings.filter((finding) => finding.verdict === "warn").length,
    budget: evaluation.price.knownCny,
    unknown: evaluation.price.unknownSkuIds.length,
  };
}

function optionMarkup(sourceId: string, selected: string): string {
  const source = document.getElementById(sourceId) as HTMLSelectElement | null;
  if (!source) return `<option value="${escapeHtml(selected)}">${escapeHtml(selected || "unknown")}</option>`;
  return [...source.options]
    .filter((option) => option.value !== "custom")
    .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selected ? " selected" : ""}>${escapeHtml(option.textContent ?? option.value)}</option>`)
    .join("");
}

function field(label: string, path: string, control: string, source = "目录事实 · evidence 由评估引擎提供"): string {
  return `<article class="workspace-editor-field" data-editor-field="${escapeHtml(path)}"><label><span>${escapeHtml(label)}</span>${control}</label><small>${escapeHtml(source)}</small></article>`;
}

function editorMarkup(config: BuildConfig, planName: string): string {
  return `
    <section class="workspace-editor-group" id="editor-platform"><header><span>01</span><div><h3>基础平台</h3><p>方案身份与确定性平台 SKU</p></div></header>
      <div class="workspace-field-grid">
        ${field("方案名称", "plan.name", `<input data-plan-name-input value="${escapeHtml(planName)}" maxlength="120">`, "方案元数据；重命名会产生新 draft revision")}
        ${field("机箱", "caseId", `<input value="${escapeHtml(config.caseId)}" readonly>`, "catalog SKU · 无证据字段保持 unknown")}
        ${field("主板", "boardId", `<input value="${escapeHtml(config.boardId)}" readonly>`, "catalog SKU · capability 来自确定性引擎")}
        ${field("处理器", "cpuId", `<input value="${escapeHtml(config.cpuId)}" readonly>`, "catalog SKU · official provenance")}
      </div><button type="button" data-rename-plan>保存名称</button></section>
    <section class="workspace-editor-group" id="editor-power"><header><span>02</span><div><h3>电源与散热</h3><p>修改后重新运行物理、功耗与热评估</p></div></header><div class="workspace-field-grid">
      ${field("电源", "selection.psuId", `<select data-config-field="selection.psuId">${optionMarkup("psu-select", config.selection.psuId)}</select>`)}
      ${field("电源拓扑", "selection.psuTopology", `<select data-config-field="selection.psuTopology">${optionMarkup("psu-position", config.selection.psuTopology)}</select>`)}
      ${field("第二颗电源", "selection.secondaryPsuId", `<select data-config-field="selection.secondaryPsuId">${optionMarkup("secondary-psu-select", config.selection.secondaryPsuId ?? "psu.corsair-sf750-atx31")}</select>`, "仅双电源拓扑生效")}
      ${field("双电源启动", "selection.dualStart", `<select data-config-field="selection.dualStart">${optionMarkup("dual-start-select", config.selection.dualStart ?? "sync")}</select>`, "仅双电源拓扑生效；同步模块型号可保持 unknown")}
      ${field("CPU 散热", "selection.coolerId", `<select data-config-field="selection.coolerId">${optionMarkup("cooler-select", config.selection.coolerId)}</select>`)}
    </div></section>
    <section class="workspace-editor-group" id="editor-storage"><header><span>03</span><div><h3>存储</h3><p>盘位、启动介质和控制器共用同一配置</p></div></header><div class="workspace-field-grid">
      ${field("数据硬盘数量", "selection.diskCount", `<input type="number" min="0" max="9" data-config-field="selection.diskCount" value="${config.selection.diskCount}">`)}
      ${field("启动盘", "selection.boot", `<select data-config-field="selection.boot">${optionMarkup("boot-select", config.selection.boot)}</select>`)}
      ${field("NVMe 数量", "selection.nvmeCount", `<select data-config-field="selection.nvmeCount">${optionMarkup("nvme-select", String(config.selection.nvmeCount ?? 0))}</select>`)}
      ${field("存储控制", "selection.hbaMode", `<select data-config-field="selection.hbaMode">${optionMarkup("hba-select", config.selection.hbaMode)}</select>`)}
    </div></section>
    <section class="workspace-editor-group" id="editor-expansion"><header><span>04</span><div><h3>GPU 与扩展</h3><p>空间占用与 HBA 保留由 BuildEvaluation 判定</p></div></header><div class="workspace-field-grid">
      ${field("GPU", "selection.gpuId", `<select data-config-field="selection.gpuId">${optionMarkup("gpu-select", config.selection.gpuId)}</select>`)}
      ${field("内存", "selection.memoryId", `<select data-config-field="selection.memoryId">${optionMarkup("ram-select", config.selection.memoryId)}</select>`)}
    </div></section>`;
}

function updateConfigField(config: BuildConfig, path: string, value: string): void {
  if (path === "selection.diskCount") config.selection.diskCount = Math.max(0, Math.min(9, Number(value)));
  else if (path === "selection.nvmeCount") config.selection.nvmeCount = Number(value);
  else if (path === "selection.psuId") config.selection.psuId = value;
  else if (path === "selection.psuTopology") {
    config.selection.psuTopology = value as BuildConfig["selection"]["psuTopology"];
    if (value === "dual") {
      config.selection.secondaryPsuId ??= "psu.corsair-sf750-atx31";
      config.selection.dualStart ??= "sync";
    } else {
      delete config.selection.secondaryPsuId;
      delete config.selection.dualStart;
    }
  }
  else if (path === "selection.secondaryPsuId") config.selection.secondaryPsuId = value;
  else if (path === "selection.dualStart") config.selection.dualStart = value as NonNullable<BuildConfig["selection"]["dualStart"]>;
  else if (path === "selection.coolerId") config.selection.coolerId = value;
  else if (path === "selection.boot") config.selection.boot = value as BuildConfig["selection"]["boot"];
  else if (path === "selection.hbaMode") {
    config.selection.hbaMode = value as BuildConfig["selection"]["hbaMode"];
    config.selection.hbaSkuId = value === "always" ? "hba.lsi-9300-8i-it" : null;
  }
  else if (path === "selection.gpuId") config.selection.gpuId = value;
  else if (path === "selection.memoryId") config.selection.memoryId = value;
}

export interface WorkspacePagesController { dispose(): void; }

export function mountWorkspacePages(root: HTMLElement, store: PlanStore, router: WorkspaceRouter): WorkspacePagesController {
  const host = document.createElement("main");
  host.className = "workspace-pages";
  host.innerHTML = `
    <section data-workspace-page="workspace" aria-labelledby="workspace-dashboard-title">
      <header class="workspace-page-head"><div><p>PLAN WORKSPACE</p><h2 id="workspace-dashboard-title">方案工作台</h2><span>创建、切换和推进每一套独立方案。</span></div><button type="button" data-open-create>新建方案</button></header>
      <div class="workspace-dashboard-current" data-current-plan></div>
      <section><div class="workspace-section-head"><h3>全部方案</h3><input type="search" data-plan-search placeholder="搜索方案名称"></div><div class="workspace-plan-grid" data-plan-grid></div></section>
    </section>
    <section data-workspace-page="editor" hidden aria-labelledby="workspace-editor-title">
      <header class="workspace-page-head"><div><p>PLAN EDITOR</p><h2 id="workspace-editor-title">方案编辑器</h2><span>所有修改进入 active draft，并由确定性评估重算。</span></div><div><button type="button" data-undo>撤销</button><button type="button" data-redo>恢复</button><button type="button" data-open-history>版本历史</button><button type="button" data-open-save>保存版本</button></div></header>
      <div class="workspace-impact" data-impact aria-live="polite"></div>
      <label class="workspace-editor-search">搜索配置项 <input type="search" data-editor-search placeholder="例如：PSU、硬盘、GPU"></label>
      <nav class="workspace-editor-toc" aria-label="方案编辑目录"><a href="#editor-platform">基础平台</a><a href="#editor-power">电源与散热</a><a href="#editor-storage">存储</a><a href="#editor-expansion">GPU 与扩展</a></nav>
      <div data-editor-fields></div>
    </section>
    <dialog data-create-dialog aria-labelledby="create-plan-title"><form method="dialog" class="workspace-dialog-card"><header><div><p>NEW PLAN</p><h2 id="create-plan-title">新建方案</h2></div><button value="cancel" aria-label="关闭">×</button></header><label>创建方式<select data-create-mode><option value="template">推荐 N6 模板</option><option value="blank">空白 N6 草稿</option><option value="duplicate">复制当前方案</option><option value="import">导入 JSON</option></select></label><label>方案名称<input data-create-name required maxlength="120" value="我的 N6 方案"></label><label data-import-field hidden>JSON 文件<input type="file" data-import-file accept="application/json,.json"></label><p data-create-error role="alert"></p><footer><button value="cancel">取消</button><button type="button" data-create-submit>创建并编辑</button></footer></form></dialog>
    <dialog data-version-dialog aria-labelledby="save-version-title"><form method="dialog" class="workspace-dialog-card"><header><div><p>IMMUTABLE VERSION</p><h2 id="save-version-title">保存新版本</h2></div><button value="cancel" aria-label="关闭">×</button></header><p data-version-parent></p><label>版本摘要<textarea data-version-summary maxlength="500" rows="3" placeholder="本次修改了什么、为什么"></textarea></label><p data-version-error role="alert"></p><footer><button value="cancel">取消</button><button type="button" data-version-submit>保存版本</button></footer></form></dialog>
    <dialog data-history-dialog aria-labelledby="version-history-title"><section class="workspace-dialog-card workspace-history-card"><header><div><p>VERSION HISTORY</p><h2 id="version-history-title">版本历史</h2></div><button type="button" data-close-history aria-label="关闭">×</button></header><div data-version-list></div><div data-version-diff aria-live="polite"></div></section></dialog>`;
  root.querySelector(".workspace-global-shell")?.insertAdjacentElement("afterend", host);

  let state = store.getState();
  let baselineEvaluation: BuildEvaluation | null = null;
  let editorPlanSignature = "";
  let search = "";

  const currentHost = host.querySelector<HTMLElement>("[data-current-plan]")!;
  const grid = host.querySelector<HTMLElement>("[data-plan-grid]")!;
  const fields = host.querySelector<HTMLElement>("[data-editor-fields]")!;
  const impact = host.querySelector<HTMLElement>("[data-impact]")!;
  const createDialog = host.querySelector<HTMLDialogElement>("[data-create-dialog]")!;
  const versionDialog = host.querySelector<HTMLDialogElement>("[data-version-dialog]")!;
  const historyDialog = host.querySelector<HTMLDialogElement>("[data-history-dialog]")!;

  const renderImpact = () => {
    const current = evaluationSummary(state.evaluation);
    const before = evaluationSummary(baselineEvaluation);
    const badDelta = baselineEvaluation ? current.bad - before.bad : 0;
    const warnDelta = baselineEvaluation ? current.warn - before.warn : 0;
    const budgetDelta = baselineEvaluation && current.budget !== null && before.budget !== null ? current.budget - before.budget : null;
    impact.innerHTML = `<strong>${current.bad} 阻断 · ${current.warn} 警告</strong><span>风险变化 ${badDelta >= 0 ? "+" : ""}${badDelta} 阻断 / ${warnDelta >= 0 ? "+" : ""}${warnDelta} 警告</span><span>预算变化 ${budgetDelta === null ? "unknown" : `${budgetDelta >= 0 ? "+" : "−"}${formatCny(Math.abs(budgetDelta))}`}</span><span>${current.unknown} 项价格 unknown</span>`;
  };

  const render = (next: PlanStoreState) => {
    state = next;
    const active = state.activePlan;
    const evalSummary = evaluationSummary(state.evaluation);
    const findings = state.evaluation?.findings.filter((finding) => finding.verdict === "bad" || finding.verdict === "warn").slice(0, 3) ?? [];
    currentHost.innerHTML = active ? `<article><div><p>CURRENT PLAN</p><h3>${escapeHtml(active.name)}</h3><span>${active.activeVersionId ? `版本 ${escapeHtml(active.activeVersionId.slice(-8))}` : "尚无版本"} · ${state.saveStatus}</span></div><div class="workspace-current-metrics"><strong data-level="${evalSummary.bad ? "bad" : evalSummary.warn ? "warn" : "ok"}">${evalSummary.bad} 阻断</strong><span>${evalSummary.warn} 警告</span><span>预算 ${formatCny(active.metadata.budgetCny ?? evalSummary.budget)}</span></div><ul class="workspace-current-findings">${findings.map((finding) => `<li data-level="${finding.verdict}"><button data-finding-id="${escapeHtml(finding.id)}" data-finding-field="${targetForFinding(finding.id).field}">${escapeHtml(finding.message.slice(0, 72))}</button></li>`).join("") || "<li>当前没有阻断或警告。</li>"}</ul><div><button data-route-action="editor">继续编辑</button><button data-route-action="spatial">打开 3D</button><button data-route-action="purchases">上传交易</button><button data-route-action="agent">询问 Agent</button></div></article>` : `<article class="workspace-empty"><h3>还没有方案</h3><p>创建第一套 N6 方案后开始评估。</p><button data-open-create>新建方案</button></article>`;
    grid.innerHTML = state.plans.filter((plan) => plan.name.toLowerCase().includes(search.toLowerCase())).map((plan) => `<article data-plan-card="${escapeHtml(plan.id)}"${plan.id === active?.id ? " data-active=true" : ""}><div><small>${plan.status === "archived" ? "已归档" : plan.id === active?.id ? "当前方案" : "方案"}</small><h3>${escapeHtml(plan.name)}</h3><p>${plan.activeVersionId ? `版本 ${escapeHtml(plan.activeVersionId.slice(-8))}` : "尚无版本"} · ${formatDate(plan.updatedAt)}</p><span>${plan.dirty ? "有未版本化草稿" : "版本已保存"}</span></div><footer>${plan.status === "archived" ? `<button data-restore-plan="${escapeHtml(plan.id)}">恢复</button>` : `<button data-activate-plan="${escapeHtml(plan.id)}">打开</button>`}<button data-delete-plan="${escapeHtml(plan.id)}">删除</button></footer></article>`).join("") || `<div class="workspace-empty"><p>没有匹配的方案。</p></div>`;
    if (active) {
      const signature = `${active.id}:${active.draftRevision}:${state.localRevision}`;
      if (signature !== editorPlanSignature) {
        editorPlanSignature = signature;
        fields.innerHTML = editorMarkup(active.draft.config, active.name);
      }
    } else fields.innerHTML = `<div class="workspace-empty">请选择或创建方案。</div>`;
    host.querySelector<HTMLButtonElement>("[data-undo]")!.disabled = !state.canUndo;
    host.querySelector<HTMLButtonElement>("[data-redo]")!.disabled = !state.canRedo;
    renderImpact();
  };
  const unsubscribeStore = store.subscribe(render);

  const unsubscribeRoute = router.subscribe((route) => {
    for (const page of host.querySelectorAll<HTMLElement>("[data-workspace-page]")) page.hidden = page.dataset.workspacePage !== route;
  });

  host.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const route = target.closest<HTMLElement>("[data-route-action]")?.dataset.routeAction;
    if (route) router.navigate(route as Parameters<WorkspaceRouter["navigate"]>[0]);
    const findingId = target.closest<HTMLElement>("[data-finding-id]")?.dataset.findingId;
    const findingTarget = target.closest<HTMLElement>("[data-finding-field]")?.dataset.findingField;
    if (findingId) {
      document.dispatchEvent(new CustomEvent("build-sim:finding-focus", { detail: { findingId } }));
      router.navigate("spatial");
    } else if (findingTarget) {
      router.navigate("editor");
      requestAnimationFrame(() => host.querySelector<HTMLElement>(`[data-editor-field="${findingTarget}"] input, [data-editor-field="${findingTarget}"] select`)?.focus());
    }
    if (target.closest("[data-open-create]")) createDialog.showModal();
    const activateId = target.closest<HTMLElement>("[data-activate-plan]")?.dataset.activatePlan;
    if (activateId) await store.activate(activateId).catch(() => undefined);
    const restoreId = target.closest<HTMLElement>("[data-restore-plan]")?.dataset.restorePlan;
    if (restoreId) await store.restorePlan(restoreId);
    const deleteId = target.closest<HTMLElement>("[data-delete-plan]")?.dataset.deletePlan;
    if (deleteId && window.confirm("删除会把方案移入可恢复的服务器回收区。确认删除？")) await store.deletePlan(deleteId);
    if (target.closest("[data-undo]")) store.undo();
    if (target.closest("[data-redo]")) store.redo();
    if (target.closest("[data-open-save]")) {
      host.querySelector<HTMLElement>("[data-version-parent]")!.textContent = state.activePlan?.activeVersionId ? `父版本：${state.activePlan.activeVersionId}` : "这将是初始版本。";
      versionDialog.showModal();
    }
    if (target.closest("[data-version-submit]")) {
      const error = host.querySelector<HTMLElement>("[data-version-error]")!;
      try {
        await store.saveVersion("manual-save", host.querySelector<HTMLTextAreaElement>("[data-version-summary]")!.value);
        versionDialog.close();
      } catch (cause) { error.textContent = cause instanceof Error ? cause.message : "保存版本失败"; }
    }
    if (target.closest("[data-rename-plan]")) {
      const name = host.querySelector<HTMLInputElement>("[data-plan-name-input]")?.value ?? "";
      await store.renameActive(name);
    }
    if (target.closest("[data-open-history]")) {
      const versions = await store.listVersions();
      renderVersions(versions);
      historyDialog.showModal();
    }
    if (target.closest("[data-close-history]")) historyDialog.close();
    const restoreVersionId = target.closest<HTMLElement>("[data-restore-version]")?.dataset.restoreVersion;
    if (restoreVersionId) {
      const versions = await store.listVersions();
      const version = versions.find((item) => item.id === restoreVersionId);
      if (version) { store.restoreVersion(version); historyDialog.close(); router.navigate("editor"); }
    }
    const compareVersionId = target.closest<HTMLElement>("[data-compare-version]")?.dataset.compareVersion;
    if (compareVersionId) {
      const versions = await store.listVersions();
      const version = versions.find((item) => item.id === compareVersionId);
      const active = store.getState().activePlan;
      if (version && active) renderVersionDiff(version, active.draft.config);
    }
  });

  const publishEditorField = (event: Event) => {
    const field = (event.target as HTMLElement).closest<HTMLElement>("[data-editor-field]")?.dataset.editorField;
    if (field) document.dispatchEvent(new CustomEvent("build-sim:editor-field-focus", { detail: { field } }));
  };
  host.addEventListener("focusin", publishEditorField);
  host.addEventListener("pointerover", publishEditorField);

  const renderVersions = (versions: PlanVersion[]) => {
    const list = host.querySelector<HTMLElement>("[data-version-list]")!;
    list.innerHTML = versions.length ? [...versions].reverse().map((version) => `<article><div><strong>v${version.versionNumber}</strong><span>${formatDate(version.createdAt)} · ${escapeHtml(version.reason)}</span><p>${escapeHtml(version.summary ?? "无摘要")}</p><small>${escapeHtml(version.configHash.slice(0, 16))}…</small></div><footer><button data-compare-version="${escapeHtml(version.id)}">与当前草稿对比</button><button data-restore-version="${escapeHtml(version.id)}">恢复为新草稿</button></footer></article>`).join("") : `<div class="workspace-empty">尚无已保存版本。</div>`;
  };
  const renderVersionDiff = (version: PlanVersion, current: BuildConfig) => {
    const diffs = diffBuildConfigs(version.config as BuildConfig, current).filter((diff) => !["/updatedAt"].includes(diff.path));
    host.querySelector<HTMLElement>("[data-version-diff]")!.innerHTML = `<h3>v${version.versionNumber} → 当前草稿</h3>${diffs.length ? `<table><thead><tr><th>字段</th><th>版本</th><th>当前</th></tr></thead><tbody>${diffs.map((diff) => `<tr><td>${escapeHtml(diff.path)}</td><td>${escapeHtml(String(diff.before ?? "—"))}</td><td>${escapeHtml(String(diff.after ?? "—"))}</td></tr>`).join("")}</tbody></table>` : "<p>没有字段变化。</p>"}`;
  };

  host.querySelector<HTMLSelectElement>("[data-create-mode]")!.addEventListener("change", (event) => {
    const importing = (event.target as HTMLSelectElement).value === "import";
    host.querySelector<HTMLElement>("[data-import-field]")!.hidden = !importing;
  });
  host.querySelector<HTMLButtonElement>("[data-create-submit]")!.addEventListener("click", async () => {
    const mode = host.querySelector<HTMLSelectElement>("[data-create-mode]")!.value;
    const name = host.querySelector<HTMLInputElement>("[data-create-name]")!.value.trim();
    const error = host.querySelector<HTMLElement>("[data-create-error]")!;
    try {
      if (!name) throw new Error("请输入方案名称");
      if (mode === "duplicate") await store.duplicate(name);
      else if (mode === "import") {
        const file = host.querySelector<HTMLInputElement>("[data-import-file]")!.files?.[0];
        if (!file) throw new Error("请选择 JSON 文件");
        await store.create(name, parseConfig(await file.text()));
      } else {
        const config = createDefaultN6Config("new-plan", new Date().toISOString());
        if (mode === "blank") config.bom = [];
        await store.create(name, config);
      }
      createDialog.close();
      router.navigate("editor");
    } catch (cause) { error.textContent = cause instanceof Error ? cause.message : "创建方案失败"; }
  });
  host.querySelector<HTMLInputElement>("[data-plan-search]")!.addEventListener("input", (event) => { search = (event.target as HTMLInputElement).value; render(state); });
  host.querySelector<HTMLInputElement>("[data-editor-search]")!.addEventListener("input", (event) => {
    const query = (event.target as HTMLInputElement).value.trim().toLowerCase();
    for (const item of fields.querySelectorAll<HTMLElement>("[data-editor-field]")) item.hidden = Boolean(query) && !item.textContent?.toLowerCase().includes(query) && !item.dataset.editorField?.toLowerCase().includes(query);
  });
  fields.addEventListener("change", (event) => {
    const control = (event.target as HTMLElement).closest<HTMLInputElement | HTMLSelectElement>("[data-config-field]");
    if (!control) return;
    baselineEvaluation = state.evaluation;
    store.patchDraft((config) => updateConfigField(config, control.dataset.configField!, control.value));
  });

  return { dispose() { unsubscribeStore(); unsubscribeRoute(); host.remove(); } };
}
