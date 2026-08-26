import { parseConfig, type BuildConfig } from "../config/types";
import type { BuildEvaluation } from "../core/evaluate";
import type { PlanStore, PlanStoreState } from "../plans/client-store";
import { createDefaultN6Config } from "../plans/default-plan";
import { diffBuildConfigs } from "../plans/diff";
import { targetForFinding } from "../plans/finding-targets";
import type { BuildTask, PlanVersion } from "../plans/contracts";
import type { BuildTaskStore, BuildTaskStoreState } from "../plans/build-task-store";
import { summarizeBuildTasks } from "../plans/build-tasks";
import type { BuildProgressController, BuildProgressItem, BuildProgressSummary } from "./build-progress";
import { BUILD_STAGE_LABELS } from "./build-progress";
import { WorkspaceRouter, type WorkspaceRoute } from "./workspace-router";
import "./workspace-pages.css";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatCny(value: number | null | undefined): string {
  return typeof value === "number" ? `¥${Math.round(value).toLocaleString("zh-CN")}` : "价格待确认";
}

function componentCategoryLabel(category: string): string {
  return ({
    case: "机箱", motherboard: "主板", cpu: "处理器", psu: "电源", cooler: "散热器",
    gpu: "显卡", memory: "内存", storage: "存储", hba: "硬盘扩展卡", fan: "风扇", accessory: "配件",
  } as Record<string, string>)[category] ?? category;
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
  if (!source) return `<option value="${escapeHtml(selected)}">${escapeHtml(selected || "待选择")}</option>`;
  return [...source.options]
    .filter((option) => option.value !== "custom")
    .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selected ? " selected" : ""}>${escapeHtml(option.textContent ?? option.value)}</option>`)
    .join("");
}

function field(label: string, path: string, control: string, help: string, source = "目录事实；由评估引擎核对"): string {
  return `<article class="workspace-editor-field" data-editor-field="${escapeHtml(path)}"><label><span>${escapeHtml(label)}</span>${control}</label><p>${escapeHtml(help)}</p><details><summary>技术来源</summary><small>${escapeHtml(source)}</small></details></article>`;
}

function editorMarkup(config: BuildConfig, planName: string): string {
  return `
    <section class="workspace-editor-group" id="editor-platform"><header><span>01</span><div><h3>先确定基础平台</h3><p>机箱、主板和处理器决定了后面能选什么。</p></div></header>
      <div class="workspace-field-grid">
        ${field("给方案起个名字", "plan.name", `<input data-plan-name-input value="${escapeHtml(planName)}" maxlength="120">`, "用用途或房间命名，之后更容易找到。", "方案名称；重命名会生成新的草稿修订")}
        ${field("机箱", "caseId", `<div class="workspace-readonly-value">JONSBO N6</div>`, "决定主板尺寸、盘位和散热空间。", `正式目录 SKU · ${config.caseId}`)}
        ${field("主板", "boardId", `<div class="workspace-readonly-value">ASUS Pro WS W680M-ACE SE</div>`, "提供接口、内存规格和扩展槽。", `正式目录 SKU · ${config.boardId}`)}
        ${field("处理器", "cpuId", `<div class="workspace-readonly-value">Intel Core i5-14500</div>`, "决定主要性能、功耗和散热需求。", `正式目录 SKU · ${config.cpuId}`)}
      </div><button type="button" data-rename-plan>保存方案名称</button></section>
    <section class="workspace-editor-group" id="editor-power"><header><span>02</span><div><h3>供电与散热</h3><p>先保证装得下、带得动，再考虑静音与性能。</p></div></header><div class="workspace-field-grid">
      ${field("电源", "selection.psuId", `<select data-config-field="selection.psuId">${optionMarkup("psu-select", config.selection.psuId)}</select>`, "功率并非越大越好，还要检查尺寸和原装线束。")}
      ${field("电源安装方式", "selection.psuTopology", `<select data-config-field="selection.psuTopology">${optionMarkup("psu-position", config.selection.psuTopology)}</select>`, "不了解时保留默认，系统会按机箱空间判断。")}
      ${field("第二颗电源", "selection.secondaryPsuId", `<select data-config-field="selection.secondaryPsuId">${optionMarkup("secondary-psu-select", config.selection.secondaryPsuId ?? "psu.corsair-sf750-atx31")}</select>`, "仅双电源方案需要；普通用户通常不需要。", "仅双电源拓扑生效")}
      ${field("双电源启动", "selection.dualStart", `<select data-config-field="selection.dualStart">${optionMarkup("dual-start-select", config.selection.dualStart ?? "sync")}</select>`, "双电源必须同步启动，未确认时不要购买。", "仅双电源拓扑生效")}
      ${field("CPU 散热器", "selection.coolerId", `<select data-config-field="selection.coolerId">${optionMarkup("cooler-select", config.selection.coolerId)}</select>`, "系统会同时检查高度、热量和噪音。")}
    </div></section>
    <section class="workspace-editor-group" id="editor-storage"><header><span>03</span><div><h3>规划存储</h3><p>先想清楚需要多少容量、是否容错，再决定买几块盘。</p></div></header><div class="workspace-field-grid">
      ${field("数据硬盘数量", "selection.diskCount", `<input type="number" min="0" max="9" data-config-field="selection.diskCount" value="${config.selection.diskCount}">`, "硬盘越多，耗电、噪音和启动峰值都会增加。")}
      ${field("启动盘位置", "selection.boot", `<select data-config-field="selection.boot">${optionMarkup("boot-select", config.selection.boot)}</select>`, "启动盘可能占用盘位或 M.2 接口。")}
      ${field("NVMe 数量", "selection.nvmeCount", `<select data-config-field="selection.nvmeCount">${optionMarkup("nvme-select", String(config.selection.nvmeCount ?? 0))}</select>`, "部分接口会和 SATA 通道共享，系统会自动检查。")}
      ${field("硬盘控制方式", "selection.hbaMode", `<select data-config-field="selection.hbaMode">${optionMarkup("hba-select", config.selection.hbaMode)}</select>`, "主板接口够用时无需额外购买 HBA 卡。")}
    </div></section>
    <section class="workspace-editor-group" id="editor-expansion"><header><span>04</span><div><h3>显卡与内存</h3><p>按真实用途选择，避免为用不到的性能付费。</p></div></header><div class="workspace-field-grid">
      ${field("显卡", "selection.gpuId", `<select data-config-field="selection.gpuId">${optionMarkup("gpu-select", config.selection.gpuId)}</select>`, "纯 NAS 通常不需要独立显卡；AI、渲染或转码再考虑。")}
      ${field("内存", "selection.memoryId", `<select data-config-field="selection.memoryId">${optionMarkup("ram-select", config.selection.memoryId)}</select>`, "系统会核对代际、ECC 类型、容量与主板支持。")}
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

function taskStatusLabel(status: BuildTask["status"]): string {
  return ({ todo: "待处理", doing: "进行中", done: "已完成", blocked: "被阻断", obsolete: "已过期" } as const)[status];
}

function taskKindLabel(kind: BuildTask["kind"]): string {
  return ({ purchase: "采购准备", assembly: "安装部件", wiring: "连接线材", verification: "开机检查" } as const)[kind];
}

function taskRows(tasks: BuildTask[]): string {
  if (!tasks.length) return `<div class="workspace-empty"><strong>这一阶段还没有任务</strong><p>完成前面的配置与检查后，任务会自动生成。</p></div>`;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.map((task) => `<article class="workspace-build-task" data-task-id="${escapeHtml(task.id)}" data-task-kind="${task.kind}" data-task-status-value="${task.status}">
    <header><div><small>${taskKindLabel(task.kind)}</small><h3>${escapeHtml(task.title)}</h3></div><span data-status="${task.status}">${taskStatusLabel(task.status)}</span></header>
    ${task.staleReason ? `<p class="workspace-task-blocker">为什么暂时不能做：${escapeHtml(task.staleReason)}</p>` : ""}
    ${task.dependsOn?.length ? `<p>请先完成：${task.dependsOn.map((id) => escapeHtml(byId.get(id)?.title ?? id)).join("、")}</p>` : ""}
    <div class="workspace-task-controls">${task.status === "obsolete" ? "" : `<label>完成情况<select data-task-status><option value="todo"${task.status === "todo" ? " selected" : ""}>还没开始</option><option value="doing"${task.status === "doing" ? " selected" : ""}>正在做</option><option value="done"${task.status === "done" ? " selected" : ""}>已经完成</option><option value="blocked"${task.status === "blocked" ? " selected" : ""}>遇到问题</option></select></label>`}<label>我的备注<input data-task-note value="${escapeHtml(task.note ?? "")}" placeholder="例如：螺丝放在主板盒里"></label>${task.relatedPartId || task.cableId ? `<button type="button" data-task-spatial>在空间预演中查看</button>` : ""}</div>
    ${(task.evidenceRefs ?? []).length ? `<details><summary>查看技术依据</summary><footer>${task.evidenceRefs!.map((ref) => `<button type="button" data-task-evidence="${escapeHtml(ref)}">${escapeHtml(ref)}</button>`).join("")}</footer></details>` : ""}
  </article>`).join("");
}

function progressSummaryMarkup(summary: BuildProgressSummary | null): string {
  if (!summary) return `<div class="workspace-empty"><p>正在准备部件进度…</p></div>`;
  const purchased = summary.purchased + summary.installed;
  const percent = summary.total ? Math.round(summary.installed / summary.total * 100) : 0;
  return `<div class="workspace-progress-overview"><div><strong>${summary.installed}<small> / ${summary.total}</small></strong><span>已安装</span></div><div class="workspace-progress-track" aria-label="装机完成 ${percent}%"><i style="width:${percent}%"></i></div><dl><div><dt>待决定</dt><dd>${summary.candidate}</dd></div><div><dt>已确定</dt><dd>${summary.locked}</dd></div><div><dt>已购买</dt><dd>${purchased}</dd></div><div><dt>已投入</dt><dd>${formatCny(summary.knownSpentCny)}</dd></div></dl></div>`;
}

function progressItemsMarkup(items: BuildProgressItem[]): string {
  if (!items.length) return `<div class="workspace-empty"><p>方案评估完成后会显示全部部件。</p></div>`;
  return `<div class="workspace-component-grid">${items.map((item) => `<article data-component-stage="${item.stage}"><span data-stage="${item.stage}">${BUILD_STAGE_LABELS[item.stage]}</span><div><small>${escapeHtml(componentCategoryLabel(item.category))}</small><strong>${escapeHtml(item.name)}</strong></div><p>${item.qty} 件 · ${item.unitPriceCny === null ? "价格待确认" : `${formatCny(item.unitPriceCny)} / 件`}</p></article>`).join("")}</div>`;
}

interface EvaluationGuideItem {
  key: string;
  findingId: string;
  verdict: "bad" | "warn";
  count: number;
  title: string;
  description: string;
}

function evaluationGuideItems(evaluation: BuildEvaluation): EvaluationGuideItem[] {
  const items = new Map<string, EvaluationGuideItem>();
  for (const finding of evaluation.findings.filter((entry) => entry.verdict === "bad" || entry.verdict === "warn")) {
    const key = finding.id.startsWith("aabb:") ? "spatial-clearance"
      : finding.id.startsWith("routing.length-unknown:") ? "cable-length"
        : finding.id.startsWith("routing.insertion-blocked:") || finding.id.startsWith("physical.bend-radius:") || finding.id === "physical.plug-service-space" ? "cable-space"
          : finding.id.startsWith("assembly.") ? "assembly-order"
            : finding.id;
    const existing = items.get(key);
    if (existing) {
      existing.count += 1;
      if (finding.verdict === "bad") existing.verdict = "bad";
      continue;
    }
    let title = finding.message.slice(0, 76);
    let description = "打开详细依据核对尺寸、型号和证据后再决定是否购买。";
    if (key === "spatial-clearance") {
      title = "显卡周围有空间需要实物复核";
      description = "显卡可能碰到电源、M.2 或扩展卡的规划空间；先看 3D，再按实物尺寸确认。";
    } else if (key === "cable-length") {
      title = "线材长度尚未得到官方证实";
      description = "系统已算出最低长度，但目录没有原装线长度；购买延长线前请先实测。";
    } else if (key === "cable-space") {
      title = "部分插头或线缆转弯空间偏紧";
      description = "装机时可能难以插拔或弯折；建议调整走线、安装顺序或选择更软的线。";
    } else if (key === "assembly-order") {
      title = "当前部件存在安装顺序或返工风险";
      description = "按空间预演给出的顺序安装，避免装好显卡后又拆电源或线材。";
    } else if (finding.id === "wiring.backplane-harness") {
      title = "当前电源原装线不够，背板还缺 1 根 Molex 线";
      description = "购买前请换电源或补同型号原厂线；不要混用其他品牌模组线，也不要用 SATA 转 Molex 分流。";
    } else if (finding.id === "thermal.lower-chamber-balance") {
      title = "硬盘舱没有主动风扇，温升仍不确定";
      description = "硬盘数量增加后，噪音和温度都会上升；建议规划盘区风扇并在装机后实测。";
    }
    items.set(key, { key, findingId: finding.id, verdict: finding.verdict as "bad" | "warn", count: 1, title, description });
  }
  return [...items.values()]
    .sort((left, right) => Number(right.verdict === "bad") - Number(left.verdict === "bad") || right.count - left.count)
    .slice(0, 6)
    .map((item) => ({ ...item, title: item.count > 1 ? `${item.title}（${item.count} 处）` : item.title }));
}

const EDITABLE_FINDING_FIELDS = new Set([
  "selection.psuId", "selection.coolerId", "selection.diskCount", "selection.boot",
  "selection.hbaMode", "selection.gpuId", "selection.memoryId",
]);

function evaluationViewForFinding(findingId: string): "thermal" | "wiring" | "gpu" | null {
  const id = findingId.toLowerCase();
  if (/thermal|cool|air|noise|fan/.test(id)) return "thermal";
  if (/wiring|routing|cable|power|psu|harness|sata/.test(id)) return "wiring";
  if (/gpu|pcie|hba|aabb/.test(id)) return "gpu";
  return null;
}

function guideActionMarkup(evaluation: BuildEvaluation, item: EvaluationGuideItem): string {
  const finding = evaluation.findings.find((entry) => entry.id === item.findingId);
  const target = targetForFinding(item.findingId);
  const editField = EDITABLE_FINDING_FIELDS.has(target.field) ? target.field : null;
  const hasSpatialTarget = Boolean(target.spatialPartId || finding?.related?.length || ["spatial-clearance", "cable-length", "cable-space", "assembly-order"].includes(item.key));
  const technicalView = evaluationViewForFinding(item.findingId);
  const actions = [
    editField ? `<button type="button" data-finding-field="${escapeHtml(editField)}">修改对应配置</button>` : "",
    hasSpatialTarget ? `<button type="button" data-finding-id="${escapeHtml(item.findingId)}">在 3D 中定位</button>` : "",
    !editField && !hasSpatialTarget && technicalView ? `<button type="button" data-evaluation-view="${technicalView}">查看相关检查</button>` : "",
    !editField && !hasSpatialTarget && !technicalView ? `<button type="button" data-open-evaluation-technical>查看判断依据</button>` : "",
  ];
  return actions.join("");
}

function evaluationGuideMarkup(evaluation: BuildEvaluation | null): string {
  if (!evaluation) return `<div class="workspace-empty"><strong>正在运行安全检查</strong><p>检查完成后会先告诉你哪些会导致买错或装不上。</p></div>`;
  const blocking = evaluation.findings.filter((finding) => finding.verdict === "bad");
  const warnings = evaluation.findings.filter((finding) => finding.verdict === "warn");
  const prioritized = evaluationGuideItems(evaluation);
  const wall = evaluation.power.wallW === null ? "证据待补" : `${Math.round(evaluation.power.wallW)} W`;
  const noise = evaluation.noise.totalDba === null ? "暂不能给出可靠数值" : `${Math.round(evaluation.noise.totalDba)} dBA`;
  const hasEditableFinding = prioritized.some((item) => EDITABLE_FINDING_FIELDS.has(targetForFinding(item.findingId).field));
  const decisionAction = !blocking.length && !warnings.length
    ? `<button type="button" data-route-action="purchases">进入采购清单</button>`
    : hasEditableFinding
      ? `<button type="button" data-route-action="editor">修改可调整的配置</button>`
      : `<button type="button" data-open-evaluation-technical>查看判断依据</button>`;
  return `<article class="workspace-evaluation-decision" data-level="${blocking.length ? "bad" : warnings.length ? "warn" : "ok"}">
    <header><div><small>购买结论</small><h2>${blocking.length ? "现在不建议整套下单" : warnings.length ? "可以继续，但还有信息要确认" : "基础检查已通过"}</h2><p>${blocking.length ? `${blocking.length} 个问题可能导致部件不兼容、装不下或无法接线。` : warnings.length ? `${warnings.length} 个提醒涉及证据、温度、噪音或采购信息。` : "当前没有发现硬性阻断，仍建议逐项确认价格与实物规格。"}</p></div>${decisionAction}</header>
    <dl><div><dt>必须先解决</dt><dd>${blocking.length} 项</dd></div><div><dt>需要再确认</dt><dd>${warnings.length} 项</dd></div><div><dt>当前功耗</dt><dd>${wall}</dd></div><div><dt>噪音判断</dt><dd>${noise}</dd></div><div><dt>已知预算</dt><dd>${formatCny(evaluation.price.knownCny)}</dd></div><div><dt>价格待补</dt><dd>${evaluation.price.unknownSkuIds.length} 项</dd></div></dl>
    <section><div><small>按优先级处理</small><h3>${prioritized.length ? "先看这些问题" : "没有待处理风险"}</h3></div><ol>${prioritized.map((finding, index) => `<li data-level="${finding.verdict}"><b>${index + 1}</b><span><small>${finding.verdict === "bad" ? "必须解决" : "建议确认"}</small><strong>${escapeHtml(finding.title)}</strong><p>${escapeHtml(finding.description)}</p></span>${guideActionMarkup(evaluation, finding)}</li>`).join("") || `<li class="workspace-all-clear"><span><strong>没有发现会阻止装机的问题</strong><small>价格与实物证据仍需在采购时确认。</small></span></li>`}</ol></section>
  </article>`;
}

function adoptLegacyContent(root: HTMLElement, host: HTMLElement): void {
  const move = (selector: string, target: string, removeHidden = true) => {
    const node = root.querySelector<HTMLElement>(selector);
    const destination = host.querySelector<HTMLElement>(target);
    if (!node || !destination || destination.contains(node)) return;
    if (removeHidden) node.classList.remove("is-hidden");
    destination.append(node);
  };

  move(".lab-kpis", "[data-evaluation-summary]");
  move(".verdict-card", "[data-evaluation-summary]");
  move(".route-card", "[data-evaluation-summary]");
  move(".advice-card", "[data-evaluation-summary]");
  move('[data-panel="thermal"]', '[data-evaluation-detail="thermal"]');
  move('[data-panel="wiring"]', '[data-evaluation-detail="wiring"]');
  move('[data-panel="gpu"]', '[data-evaluation-detail="gpu"]');
  move(".lab-case-card", "[data-spatial-content]");
  move(".product-reference", "[data-spatial-evidence]");
  move("#build-base-dialog", "[data-purchase-content]", false);
  move('[data-panel="price"]', "[data-purchase-market]");
  move(".purchase-card", "[data-build-parts]");
  move('[data-panel="checklist"]', "[data-build-checklist]");
  move('[data-panel="agent"]', "[data-agent-content]");

  const dialog = host.querySelector<HTMLDialogElement>("#build-base-dialog");
  if (dialog) {
    dialog.dataset.routeSurface = "true";
    dialog.setAttribute("open", "");
  }
  root.querySelector("#workspace-results")?.remove();
  root.querySelector<HTMLElement>('[data-panel="overview"]')?.remove();
  const legacyMain = [...root.children].find((child) => child.tagName === "MAIN" && !child.classList.contains("workspace-pages"));
  if (legacyMain && !legacyMain.childElementCount) legacyMain.remove();
}

export interface WorkspacePagesController { dispose(): void; }

export function mountWorkspacePages(root: HTMLElement, store: PlanStore, router: WorkspaceRouter, taskStore?: BuildTaskStore, progress?: BuildProgressController): WorkspacePagesController {
  const host = document.createElement("main");
  host.className = "workspace-pages";
  host.innerHTML = `
    <section id="workspace-page-workspace" data-workspace-page="workspace" aria-labelledby="workspace-dashboard-title">
      <header class="workspace-page-head"><div><p>你的装机路线</p><h1 id="workspace-dashboard-title">今天，先完成最重要的一步</h1><span>这里会根据当前方案告诉你下一步做什么，不需要一次看懂所有参数。</span></div><button type="button" data-open-create>＋ 新建方案</button></header>
      <div class="workspace-dashboard-current" data-current-plan></div>
      <section class="workspace-progress-panel"><div class="workspace-section-head"><div><p>全部部件进度</p><h2>每一件硬件都看得见</h2></div><button type="button" data-route-action="build">查看装机任务</button></div><div data-workspace-progress-summary></div><div data-workspace-progress-items></div></section>
      <section><div class="workspace-section-head"><div><p>我的方案</p><h2>方案列表</h2></div><input type="search" data-plan-search placeholder="搜索方案名称" aria-label="搜索方案名称"></div><div class="workspace-plan-grid" data-plan-grid></div></section>
    </section>
    <section id="workspace-page-editor" data-workspace-page="editor" hidden aria-labelledby="workspace-editor-title">
      <header class="workspace-page-head"><div><p>第 2 步 · 选择硬件</p><h1 id="workspace-editor-title">先说需求，再选配置</h1><span>每个选择都说明影响；修改后会立即重新检查兼容、功耗、散热和预算。</span></div><div><button type="button" data-undo>撤销</button><button type="button" data-redo>恢复</button><button type="button" data-open-history>版本记录</button><button type="button" data-open-save>保存这一版</button></div></header>
      <div class="workspace-guide-callout"><strong>不确定怎么选？</strong><span>保持推荐值，或打开“问问助手”描述预算、用途和安静程度。</span><button type="button" data-route-action="agent">请助手帮我选</button></div>
      <div class="workspace-impact" data-impact aria-live="polite"></div>
      <div class="workspace-editor-layout"><aside><label>快速查找<input type="search" data-editor-search placeholder="例如：电源、硬盘、显卡"></label><nav class="workspace-editor-toc" aria-label="配置步骤"><a href="#editor-platform">1. 基础平台</a><a href="#editor-power">2. 供电散热</a><a href="#editor-storage">3. 存储</a><a href="#editor-expansion">4. 显卡内存</a></nav></aside><div data-editor-fields></div></div>
    </section>
    <section id="workspace-page-evaluation" data-workspace-page="evaluation" hidden aria-labelledby="workspace-evaluation-title">
      <header class="workspace-page-head"><div><p>第 3 步 · 安全检查</p><h1 id="workspace-evaluation-title">买之前，把风险查清楚</h1><span>先看必须解决的问题，再按需了解散热、噪音、耗电、接线和显卡空间。</span></div><button type="button" data-route-action="editor">返回修改配置</button></header>
      <nav class="workspace-subnav" aria-label="安全检查分类"><button type="button" data-evaluation-view="summary" aria-pressed="true">总览与阻断</button><button type="button" data-evaluation-view="thermal" aria-pressed="false">散热与噪音</button><button type="button" data-evaluation-view="wiring" aria-pressed="false">供电与接线</button><button type="button" data-evaluation-view="gpu" aria-pressed="false">显卡与扩展</button></nav>
      <section data-evaluation-detail="summary"><div data-evaluation-guidance></div><details class="workspace-evaluation-technical"><summary>查看功耗、温度与专业判定依据</summary><section class="workspace-evaluation-summary" data-evaluation-summary></section></details></section>
      <section data-evaluation-detail="thermal" hidden></section><section data-evaluation-detail="wiring" hidden></section><section data-evaluation-detail="gpu" hidden></section>
    </section>
    <section id="workspace-page-spatial" data-workspace-page="spatial" hidden aria-labelledby="workspace-spatial-title">
      <header class="workspace-page-head"><div><p>第 4 步 · 空间预演</p><h1 id="workspace-spatial-title">装之前，先在 3D 里试一遍</h1><span>拖动旋转、滚轮缩放、点击部件查看；问题可直接返回对应配置修正。</span></div><button type="button" data-route-action="evaluation">查看安全检查</button></header>
      <div class="workspace-spatial-help"><span data-desktop-gesture><b>左键拖动</b> 旋转</span><span data-desktop-gesture><b>右键拖动</b> 平移</span><span data-desktop-gesture><b>滚轮</b> 缩放</span><span data-desktop-gesture><b>双击空白</b> 复位</span><span data-touch-gesture><b>单指上下滑</b> 滚动页面</span><span data-touch-gesture><b>双指</b> 操控 3D</span><span data-touch-gesture><b>点按部件</b> 查看详情</span></div>
      <section data-spatial-content></section><details class="workspace-spatial-evidence"><summary>查看实物图与官方手册证据</summary><div data-spatial-evidence></div></details>
    </section>
    <section id="workspace-page-purchases" data-workspace-page="purchases" hidden aria-labelledby="workspace-purchases-title">
      <header class="workspace-page-head"><div><p>第 5 步 · 放心采购</p><h1 id="workspace-purchases-title">只买已经确认需要的硬件</h1><span>先核对安全检查，再记录成交价和订单截图；识别结果由你确认后才会归档。</span></div><button type="button" data-route-action="evaluation">先检查能不能买</button></header>
      <div class="workspace-purchase-gate" data-purchase-gate aria-live="polite"></div>
      <section data-purchase-content></section>
      <details class="workspace-market-details"><summary>查看市场行情与配件价格</summary><div data-purchase-market></div></details>
    </section>
    <section id="workspace-page-build" data-workspace-page="build" hidden aria-labelledby="workspace-build-title">
      <header class="workspace-page-head"><div><p>第 6 步 · 开始装机</p><h1 id="workspace-build-title">按顺序做，少返工</h1><span>采购、安装、接线和开机检查共用同一套任务状态。</span></div><button type="button" data-export-saved-checklist>导出离线清单</button></header>
      <section data-build-parts></section>
      <div class="workspace-task-summary" data-task-summary aria-live="polite"></div>
      <nav class="workspace-subnav" aria-label="装机任务阶段"><button type="button" data-task-filter="all" aria-pressed="true">全部任务</button><button type="button" data-task-filter="purchase" aria-pressed="false">采购准备</button><button type="button" data-task-filter="assembly" aria-pressed="false">安装部件</button><button type="button" data-task-filter="wiring" aria-pressed="false">连接线材</button><button type="button" data-task-filter="verification" aria-pressed="false">开机检查</button></nav>
      <div class="workspace-task-board" data-task-board></div>
      <details class="workspace-build-checklist"><summary>查看完整装机知识清单</summary><div data-build-checklist></div></details>
    </section>
    <section id="workspace-page-agent" data-workspace-page="agent" hidden aria-labelledby="workspace-agent-page-title">
      <header class="workspace-page-head"><div><p>全程可用 · 装机助手</p><h1 id="workspace-agent-page-title">用自己的话问，不需要懂术语</h1><span>助手会读取当前方案和检查结果，但不会替你静默修改或购买。</span></div><button type="button" data-route-action="workspace">返回下一步</button></header>
      <div class="workspace-agent-guide"><strong>可以这样问</strong><button type="button" data-agent-prompt="我希望整机尽量安静，当前配置最需要调整什么？">怎样更安静？</button><button type="button" data-agent-prompt="请用小白能理解的话解释当前所有阻断项，并告诉我先改哪一个。">阻断是什么意思？</button><button type="button" data-agent-prompt="根据当前方案，哪些部件现在可以放心购买，哪些还不能买？">现在能买什么？</button></div>
      <section data-agent-content></section>
    </section>
    <dialog data-create-dialog aria-labelledby="create-plan-title"><form method="dialog" class="workspace-dialog-card workspace-onboarding-card"><header><div><p>从 0 开始</p><h2 id="create-plan-title">先说你想装一台怎样的电脑</h2><span>这些答案会变成后续选件、预算与噪音提醒的判断依据。</span></div><button value="cancel" aria-label="关闭">×</button></header><label>方案名称<input data-create-name required maxlength="120" value="我的 N6 装机方案"></label><div class="workspace-intent-grid"><label>主要用途<select data-create-use-case><option value="家庭存储 / NAS">家庭存储 / NAS</option><option value="安静办公">安静办公</option><option value="游戏与直播">游戏与直播</option><option value="AI / 创作">AI / 创作</option><option value="混合用途">混合用途</option></select></label><label>整机预算（元）<input data-create-budget type="number" min="0" step="500" placeholder="例如 8000"></label><label>放在哪里<select data-create-location><option value="卧室或安静房间">卧室或安静房间</option><option value="书房 / 办公室">书房 / 办公室</option><option value="客厅">客厅</option><option value="机房或储物间">机房或储物间</option></select></label><label>更在意什么<select data-create-priority><option value="低噪音">尽量安静</option><option value="预算优先">控制预算</option><option value="性能优先">性能优先</option><option value="低功耗">省电低功耗</option><option value="容易安装">容易安装与维护</option></select></label></div><label>你已经有的硬件（可不填）<input data-create-owned placeholder="例如：两块 980 PRO、显示器、旧硬盘"></label><details><summary>高级：选择起点或导入</summary><label>从哪里开始<select data-create-mode><option value="template">使用推荐 N6 起点</option><option value="blank">从空白清单开始</option><option value="duplicate">复制当前方案再调整</option><option value="import">导入已有 JSON</option></select></label><label data-import-field hidden>JSON 文件<input type="file" data-import-file accept="application/json,.json"></label></details><p data-create-error role="alert"></p><footer><button value="cancel">暂不创建</button><button type="button" data-create-submit>创建并开始选择</button></footer></form></dialog>
    <dialog data-version-dialog aria-labelledby="save-version-title"><form method="dialog" class="workspace-dialog-card"><header><div><p>保存检查点</p><h2 id="save-version-title">保存当前方案版本</h2></div><button value="cancel" aria-label="关闭">×</button></header><p data-version-parent></p><label>这次改了什么<textarea data-version-summary maxlength="500" rows="3" placeholder="例如：换成更安静的散热器，并减少一块硬盘"></textarea></label><p data-version-error role="alert"></p><footer><button value="cancel">取消</button><button type="button" data-version-submit>确认保存</button></footer></form></dialog>
    <dialog data-history-dialog aria-labelledby="version-history-title"><section class="workspace-dialog-card workspace-history-card"><header><div><p>方案检查点</p><h2 id="version-history-title">版本记录</h2></div><button type="button" data-close-history aria-label="关闭">×</button></header><div data-version-list></div><div data-version-diff aria-live="polite"></div></section></dialog>`;
  root.querySelector(".workspace-global-shell")?.insertAdjacentElement("afterend", host);
  adoptLegacyContent(root, host);

  let state = store.getState();
  let baselineEvaluation: BuildEvaluation | null = null;
  let editorPlanSignature = "";
  let search = "";
  let taskFilter: "all" | BuildTask["kind"] = "all";
  let taskState: BuildTaskStoreState = taskStore?.getState() ?? { planId: null, sourceVersionId: null, tasks: [] };

  const currentHost = host.querySelector<HTMLElement>("[data-current-plan]")!;
  const grid = host.querySelector<HTMLElement>("[data-plan-grid]")!;
  const fields = host.querySelector<HTMLElement>("[data-editor-fields]")!;
  const impact = host.querySelector<HTMLElement>("[data-impact]")!;
  const createDialog = host.querySelector<HTMLDialogElement>("[data-create-dialog]")!;
  const versionDialog = host.querySelector<HTMLDialogElement>("[data-version-dialog]")!;
  const historyDialog = host.querySelector<HTMLDialogElement>("[data-history-dialog]")!;
  const taskSummaryHost = host.querySelector<HTMLElement>("[data-task-summary]")!;
  const taskBoard = host.querySelector<HTMLElement>("[data-task-board]")!;
  const currentTasks = () => taskState.planId === state.activePlan?.id ? taskState.tasks : [];
  const currentTaskSummary = () => summarizeBuildTasks(currentTasks());

  const renderProgress = () => {
    const summary = progress?.summary() ?? null;
    const items = progress?.items() ?? [];
    host.querySelector<HTMLElement>("[data-workspace-progress-summary]")!.innerHTML = progressSummaryMarkup(summary);
    host.querySelector<HTMLElement>("[data-workspace-progress-items]")!.innerHTML = progressItemsMarkup(items);
  };

  const renderTasks = () => {
    const activeTasks = currentTasks();
    const summary = currentTaskSummary();
    taskSummaryHost.innerHTML = `<div><strong>${summary.done}<small> / ${Math.max(0, summary.total - summary.obsolete)}</small></strong><span>已完成</span></div><div><strong>${summary.doing}</strong><span>正在做</span></div><div><strong>${summary.blocked}</strong><span>遇到问题</span></div><div><strong>${summary.obsolete}</strong><span>方案变化后已过期</span></div>`;
    const phases: BuildTask["kind"][] = ["purchase", "assembly", "wiring", "verification"];
    taskBoard.innerHTML = phases.filter((kind) => taskFilter === "all" || taskFilter === kind).map((kind) => `<section data-task-phase="${kind}"><header><div><small>阶段 ${phases.indexOf(kind) + 1}</small><h2>${taskKindLabel(kind)}</h2></div><span>${activeTasks.filter((task) => task.kind === kind && task.status !== "obsolete").length} 项</span></header>${taskRows(activeTasks.filter((task) => task.kind === kind))}</section>`).join("");
  };

  const renderImpact = () => {
    const current = evaluationSummary(state.evaluation);
    const before = evaluationSummary(baselineEvaluation);
    const badDelta = baselineEvaluation ? current.bad - before.bad : 0;
    const warnDelta = baselineEvaluation ? current.warn - before.warn : 0;
    const budgetDelta = baselineEvaluation && current.budget !== null && before.budget !== null ? current.budget - before.budget : null;
    impact.innerHTML = `<article data-level="${current.bad ? "bad" : "ok"}"><small>必须先解决</small><strong>${current.bad} 项</strong></article><article><small>建议再确认</small><strong>${current.warn} 项</strong></article><article><small>这次修改的预算影响</small><strong>${budgetDelta === null ? "待价格补齐" : `${budgetDelta >= 0 ? "+" : "−"}${formatCny(Math.abs(budgetDelta))}`}</strong></article><article><small>风险变化</small><strong>${badDelta > 0 ? `新增 ${badDelta} 个阻断` : badDelta < 0 ? `解决 ${Math.abs(badDelta)} 个阻断` : warnDelta ? `${warnDelta > 0 ? "+" : ""}${warnDelta} 个提醒` : "没有新增风险"}</strong></article>`;
  };

  const renderPurchaseGate = () => {
    const summary = evaluationSummary(state.evaluation);
    const gate = host.querySelector<HTMLElement>("[data-purchase-gate]")!;
    gate.dataset.level = summary.bad ? "bad" : summary.warn ? "warn" : "ok";
    gate.innerHTML = summary.bad
      ? `<div><small>采购安全门槛</small><strong>还有 ${summary.bad} 个阻断，暂时不要按整套方案下单</strong><p>可以先记录已有订单，但请先修正不兼容、装不下或接线不可行的问题。</p></div><button type="button" data-route-action="evaluation">查看必须解决的问题</button>`
      : summary.warn
        ? `<div><small>采购安全门槛</small><strong>没有硬性阻断，还有 ${summary.warn} 项需要人工确认</strong><p>确认噪音、散热、价格或证据提醒后，可逐项购买已锁定部件。</p></div><button type="button" data-route-action="evaluation">逐项确认提醒</button>`
        : `<div><small>采购安全门槛</small><strong>当前方案已通过基础检查</strong><p>仍建议比较市场价格，并按“已确定”清单逐项购买。</p></div><button type="button" data-route-action="build">查看完整清单</button>`;
  };

  const render = (next: PlanStoreState) => {
    state = next;
    const active = state.activePlan;
    const evalSummary = evaluationSummary(state.evaluation);
    const findings = state.evaluation ? evaluationGuideItems(state.evaluation).slice(0, 3) : [];
    const taskSummary = currentTaskSummary();
    const nextRoute: WorkspaceRoute = evalSummary.bad ? "evaluation" : (progress?.summary().candidate ?? 1) > 0 ? "editor" : (progress?.summary().purchased ?? 0) + (progress?.summary().installed ?? 0) < (progress?.summary().total ?? 0) ? "purchases" : "build";
    const nextTitle = evalSummary.bad ? `先解决 ${evalSummary.bad} 个购买前阻断` : nextRoute === "editor" ? "继续确认还没定下的部件" : nextRoute === "purchases" ? "开始按已确认清单采购" : "继续完成装机任务";
    const intent = active?.metadata.initialization?.intent;
    const preferences = intent?.preferences ?? [];
    const goalCopy = active ? [intent?.useCase ?? active.metadata.useCase ?? "用途待补充", intent?.budgetCny ?? active.metadata.budgetCny ? `预算 ${formatCny(intent?.budgetCny ?? active.metadata.budgetCny)}` : "预算待补充", ...preferences.slice(0, 2)].map(escapeHtml).join(" · ") : "";
    currentHost.innerHTML = active ? `<article class="workspace-next-card"><div class="workspace-next-copy"><p>建议下一步</p><h2>${escapeHtml(nextTitle)}</h2><span>${evalSummary.bad ? "这些问题可能导致买错、装不下或无法接线。" : "系统会一直保留你已经完成的进度。"}</span><button data-route-action="${nextRoute}">${evalSummary.bad ? "查看并解决" : nextRoute === "editor" ? "继续编辑" : nextRoute === "purchases" ? "打开采购清单" : "继续装机"} →</button></div><div class="workspace-plan-health"><div><small>当前方案</small><strong>${escapeHtml(active.name)}</strong><span>${active.activeVersionId ? "已有保存检查点" : "还没有保存检查点"}</span><p>${goalCopy}</p></div><dl><div><dt>必须解决</dt><dd data-level="${evalSummary.bad ? "bad" : "ok"}">${evalSummary.bad}</dd></div><div><dt>建议确认</dt><dd>${evalSummary.warn}</dd></div><div><dt>预算参考</dt><dd>${formatCny(active.metadata.budgetCny ?? evalSummary.budget)}</dd></div><div><dt>下一步任务</dt><dd>${taskSummary.next.length}</dd></div></dl></div><div class="workspace-next-details"><div><h3>最先关注</h3><ul>${findings.map((finding) => `<li data-level="${finding.verdict}"><span>${finding.verdict === "bad" ? "必须" : "提醒"}</span><p>${escapeHtml(finding.title)}</p>${state.evaluation ? guideActionMarkup(state.evaluation, finding) : ""}</li>`).join("") || "<li class=workspace-all-clear><p>目前没有阻断或警告，可以继续下一步。</p></li>"}</ul></div><div class="workspace-quick-actions"><button data-route-action="editor">继续编辑</button><button data-route-action="evaluation">查看完整检查</button><button data-route-action="spatial">打开 3D</button><button data-route-action="purchases">记录一笔购买</button><button data-route-action="agent">问问助手</button></div></div></article>` : `<article class="workspace-empty"><h2>从第一套方案开始</h2><p>告诉我们用途、预算和对噪音的要求，再一步步完成装机。</p><button data-open-create>新建装机方案</button></article>`;
    grid.innerHTML = state.plans.filter((plan) => plan.name.toLowerCase().includes(search.toLowerCase())).map((plan) => `<article data-plan-card="${escapeHtml(plan.id)}"${plan.id === active?.id ? " data-active=true" : ""}><div><small>${plan.status === "archived" ? "已归档" : plan.id === active?.id ? "正在进行" : "其他方案"}</small><h3>${escapeHtml(plan.name)}</h3><p>${plan.activeVersionId ? "已有保存检查点" : "还没有保存检查点"}</p><span>${formatDate(plan.updatedAt)} · ${plan.dirty ? "有新修改" : "已保存"}</span></div><footer>${plan.status === "archived" ? `<button data-restore-plan="${escapeHtml(plan.id)}">恢复方案</button>` : `<button data-activate-plan="${escapeHtml(plan.id)}">打开方案</button>`}<button data-delete-plan="${escapeHtml(plan.id)}">移入回收区</button></footer></article>`).join("") || `<div class="workspace-empty"><p>没有匹配的方案。</p></div>`;
    if (active) {
      const signature = `${active.id}:${active.draftRevision}:${state.localRevision}`;
      if (signature !== editorPlanSignature) { editorPlanSignature = signature; fields.innerHTML = editorMarkup(active.draft.config, active.name); }
    } else fields.innerHTML = `<div class="workspace-empty">请选择或创建方案。</div>`;
    host.querySelector<HTMLButtonElement>("[data-undo]")!.disabled = !state.canUndo;
    host.querySelector<HTMLButtonElement>("[data-redo]")!.disabled = !state.canRedo;
    renderImpact();
    host.querySelector<HTMLElement>("[data-evaluation-guidance]")!.innerHTML = evaluationGuideMarkup(state.evaluation);
    renderTasks();
    renderProgress();
    renderPurchaseGate();
  };

  const setEvaluationView = (view: string) => {
    for (const button of host.querySelectorAll<HTMLButtonElement>("[data-evaluation-view]")) button.setAttribute("aria-pressed", String(button.dataset.evaluationView === view));
    host.querySelector<HTMLElement>("[data-evaluation-summary]")!.hidden = view !== "summary";
    for (const detail of host.querySelectorAll<HTMLElement>("[data-evaluation-detail]")) detail.hidden = detail.dataset.evaluationDetail !== view;
  };

  const unsubscribeStore = store.subscribe(render);
  const unsubscribeTasks = taskStore?.subscribe((next) => { taskState = next; render(state); }) ?? (() => undefined);
  const unsubscribeProgress = progress?.subscribe(() => render(state)) ?? (() => undefined);
  const unsubscribeRoute = router.subscribe((route) => {
    for (const page of host.querySelectorAll<HTMLElement>("[data-workspace-page]")) page.hidden = page.dataset.workspacePage !== route;
    if (route === "evaluation") setEvaluationView("summary");
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });

  host.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const route = target.closest<HTMLElement>("[data-route-action]")?.dataset.routeAction;
    if (route) router.navigate(route as WorkspaceRoute);
    const evaluationView = target.closest<HTMLElement>("[data-evaluation-view]")?.dataset.evaluationView;
    if (evaluationView) setEvaluationView(evaluationView);
    if (target.closest("[data-open-evaluation-technical]")) {
      const details = host.querySelector<HTMLDetailsElement>(".workspace-evaluation-technical");
      if (details) {
        details.open = true;
        details.scrollIntoView?.({ block: "start", behavior: "smooth" });
      }
    }
    const filter = target.closest<HTMLElement>("[data-task-filter]")?.dataset.taskFilter as typeof taskFilter | undefined;
    if (filter) {
      taskFilter = filter;
      for (const button of host.querySelectorAll<HTMLButtonElement>("[data-task-filter]")) button.setAttribute("aria-pressed", String(button.dataset.taskFilter === filter));
      renderTasks();
    }
    const agentPrompt = target.closest<HTMLElement>("[data-agent-prompt]")?.dataset.agentPrompt;
    if (agentPrompt) {
      const input = document.getElementById("agent-input") as HTMLTextAreaElement | null;
      if (input) { input.value = agentPrompt; input.focus(); }
    }
    const openTaskId = target.closest<HTMLElement>("[data-open-task]")?.dataset.openTask;
    if (openTaskId) router.navigate("build");
    const spatialTaskId = target.closest<HTMLElement>("[data-task-spatial]")?.closest<HTMLElement>("[data-task-id]")?.dataset.taskId;
    if (spatialTaskId) {
      const selected = taskState.tasks.find((item) => item.id === spatialTaskId);
      const partId = selected?.relatedPartId ?? selected?.cableId;
      if (partId) store.setSelection({ partId, view: selected?.cableId ? "routing" : "spatial", ...(selected?.findingId ? { findingId: selected.findingId } : {}) });
      document.dispatchEvent(new CustomEvent("build-sim:task-focus", { detail: { taskId: spatialTaskId, partId: selected?.relatedPartId, cableId: selected?.cableId } }));
      router.navigate("spatial");
    }
    const evidenceRef = target.closest<HTMLElement>("[data-task-evidence]")?.dataset.taskEvidence;
    if (evidenceRef?.startsWith("transaction:") || evidenceRef?.startsWith("bom:") || evidenceRef?.startsWith("purchase-hint:")) router.navigate("purchases");
    if (evidenceRef?.startsWith("evidence:")) router.navigate("evaluation");
    if (evidenceRef?.startsWith("assembly:")) router.navigate("spatial");
    if (evidenceRef?.startsWith("finding:")) {
      document.dispatchEvent(new CustomEvent("build-sim:finding-focus", { detail: { findingId: evidenceRef.slice("finding:".length) } }));
      router.navigate("spatial");
    }
    if (target.closest("[data-export-saved-checklist]")) document.getElementById("cfg-export-checklist")?.click();
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
    if (deleteId && window.confirm("方案会移入可恢复的回收区，确认继续？")) await store.deletePlan(deleteId);
    if (target.closest("[data-undo]")) store.undo();
    if (target.closest("[data-redo]")) store.redo();
    if (target.closest("[data-open-save]")) {
      host.querySelector<HTMLElement>("[data-version-parent]")!.textContent = state.activePlan?.activeVersionId ? `将从当前版本 ${state.activePlan.activeVersionId.slice(-8)} 保存一个新检查点。` : "这将是这套方案的第一个检查点。";
      versionDialog.showModal();
    }
    if (target.closest("[data-version-submit]")) {
      const error = host.querySelector<HTMLElement>("[data-version-error]")!;
      try { await store.saveVersion("manual-save", host.querySelector<HTMLTextAreaElement>("[data-version-summary]")!.value); versionDialog.close(); }
      catch (cause) { error.textContent = cause instanceof Error ? cause.message : "保存版本失败"; }
    }
    if (target.closest("[data-rename-plan]")) await store.renameActive(host.querySelector<HTMLInputElement>("[data-plan-name-input]")?.value ?? "");
    if (target.closest("[data-open-history]")) { renderVersions(await store.listVersions()); historyDialog.showModal(); }
    if (target.closest("[data-close-history]")) historyDialog.close();
    const restoreVersionId = target.closest<HTMLElement>("[data-restore-version]")?.dataset.restoreVersion;
    if (restoreVersionId) {
      const version = (await store.listVersions()).find((item) => item.id === restoreVersionId);
      if (version) { store.restoreVersion(version); historyDialog.close(); router.navigate("editor"); }
    }
    const compareVersionId = target.closest<HTMLElement>("[data-compare-version]")?.dataset.compareVersion;
    if (compareVersionId) {
      const version = (await store.listVersions()).find((item) => item.id === compareVersionId);
      const active = store.getState().activePlan;
      if (version && active) renderVersionDiff(version, active.draft.config);
    }
  });

  const publishEditorField = (event: Event) => {
    const fieldPath = (event.target as HTMLElement).closest<HTMLElement>("[data-editor-field]")?.dataset.editorField;
    if (fieldPath) document.dispatchEvent(new CustomEvent("build-sim:editor-field-focus", { detail: { field: fieldPath } }));
  };
  host.addEventListener("focusin", publishEditorField);
  host.addEventListener("pointerover", publishEditorField);

  const renderVersions = (versions: PlanVersion[]) => {
    host.querySelector<HTMLElement>("[data-version-list]")!.innerHTML = versions.length ? [...versions].reverse().map((version) => `<article><div><strong>版本 ${version.versionNumber}</strong><span>${formatDate(version.createdAt)}</span><p>${escapeHtml(version.summary ?? "没有填写说明")}</p><details><summary>技术标识</summary><small>${escapeHtml(version.configHash.slice(0, 16))}…</small></details></div><footer><button data-compare-version="${escapeHtml(version.id)}">与当前方案对比</button><button data-restore-version="${escapeHtml(version.id)}">恢复为新草稿</button></footer></article>`).join("") : `<div class="workspace-empty">还没有保存过版本。</div>`;
  };
  const renderVersionDiff = (version: PlanVersion, current: BuildConfig) => {
    const diffs = diffBuildConfigs(version.config as BuildConfig, current).filter((diff) => !["/updatedAt"].includes(diff.path));
    host.querySelector<HTMLElement>("[data-version-diff]")!.innerHTML = `<h3>版本 ${version.versionNumber} 与当前方案</h3>${diffs.length ? `<table><thead><tr><th>项目</th><th>之前</th><th>现在</th></tr></thead><tbody>${diffs.map((diff) => `<tr><td>${escapeHtml(diff.path)}</td><td>${escapeHtml(String(diff.before ?? "—"))}</td><td>${escapeHtml(String(diff.after ?? "—"))}</td></tr>`).join("")}</tbody></table>` : "<p>没有配置变化。</p>"}`;
  };

  host.querySelector<HTMLSelectElement>("[data-create-mode]")!.addEventListener("change", (event) => { host.querySelector<HTMLElement>("[data-import-field]")!.hidden = (event.target as HTMLSelectElement).value !== "import"; });
  host.querySelector<HTMLButtonElement>("[data-create-submit]")!.addEventListener("click", async () => {
    const mode = host.querySelector<HTMLSelectElement>("[data-create-mode]")!.value;
    const name = host.querySelector<HTMLInputElement>("[data-create-name]")!.value.trim();
    const error = host.querySelector<HTMLElement>("[data-create-error]")!;
    try {
      if (!name) throw new Error("请先给方案起个名字");
      if (mode === "duplicate") await store.duplicate(name);
      else if (mode === "import") {
        const file = host.querySelector<HTMLInputElement>("[data-import-file]")!.files?.[0];
        if (!file) throw new Error("请选择 JSON 文件");
        await store.create(name, parseConfig(await file.text()));
      } else {
        const config = createDefaultN6Config("new-plan", new Date().toISOString());
        if (mode === "blank") config.bom = [];
        const useCase = host.querySelector<HTMLSelectElement>("[data-create-use-case]")!.value;
        const rawBudget = host.querySelector<HTMLInputElement>("[data-create-budget]")!.value.trim();
        const budgetCny = rawBudget ? Math.max(0, Number(rawBudget) || 0) : null;
        const location = host.querySelector<HTMLSelectElement>("[data-create-location]")!.value;
        const priority = host.querySelector<HTMLSelectElement>("[data-create-priority]")!.value;
        const owned = host.querySelector<HTMLInputElement>("[data-create-owned]")!.value.trim();
        await store.create(name, config, {
          useCase,
          budgetCny,
          tags: [priority, location],
          initialization: {
            status: "initialized",
            source: "template",
            initializedAt: new Date().toISOString(),
            intent: { useCase, budgetCny, preferences: [priority, location, ...(owned ? [`已有硬件：${owned}`] : [])] },
          },
        });
      }
      createDialog.close(); router.navigate("editor");
    } catch (cause) { error.textContent = cause instanceof Error ? cause.message : "无法创建方案"; }
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
  taskBoard.addEventListener("change", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-task-id]");
    const id = row?.dataset.taskId;
    if (!id || !taskStore) return;
    const status = (event.target as HTMLElement).closest<HTMLSelectElement>("[data-task-status]")?.value as "todo" | "doing" | "done" | "blocked" | undefined;
    if (status) taskStore.setStatus(id, status);
    const note = (event.target as HTMLElement).closest<HTMLInputElement>("[data-task-note]");
    if (note) taskStore.setNote(id, note.value);
  });

  return { dispose() { unsubscribeStore(); unsubscribeTasks(); unsubscribeProgress(); unsubscribeRoute(); host.remove(); } };
}
