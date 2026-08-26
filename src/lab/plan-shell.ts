import type { BuildConfig } from "../config/types";
import { createAgentInitializationScaffold, createDefaultN6Config } from "../plans/default-plan";
import type { PlanStore, PlanStoreState } from "../plans/client-store";
import { WorkspaceRouter, type WorkspaceRoute } from "./workspace-router";
import "./workspace-shell.css";

const navigation: Record<WorkspaceRoute, { step: string; label: string; hint: string }> = {
  workspace: { step: "01", label: "从这里开始", hint: "下一步做什么" },
  editor: { step: "02", label: "选择硬件", hint: "搭出可行方案" },
  evaluation: { step: "03", label: "安全检查", hint: "兼容、散热与噪音" },
  spatial: { step: "04", label: "空间预演", hint: "尺寸、走线与安装" },
  purchases: { step: "05", label: "放心采购", hint: "价格、清单与凭证" },
  build: { step: "06", label: "开始装机", hint: "按顺序完成任务" },
  agent: { step: "?", label: "问问助手", hint: "不懂就随时问" },
};

function statusLabel(state: PlanStoreState): string {
  if (state.activePlan?.metadata.initialization?.status === "pending") return "先告诉助手你的用途和预算";
  if (state.saveStatus === "offline") return "离线使用 · 修改仅保存在此设备";
  if (state.saveStatus === "saving") return "正在自动保存…";
  if (state.saveStatus === "saved") return state.activePlan?.draft.dirty ? "修改已自动保存" : "已保存";
  if (state.saveStatus === "conflict") return "检测到另一处修改，请重新载入";
  if (state.saveStatus === "failed") return "自动保存失败，请重试";
  if (state.saveStatus === "dirty") return "有新修改，正在等待保存";
  return "已保存";
}

export interface PlanShellController { dispose(): void; }

export function mountPlanShell(root: HTMLElement, store: PlanStore, router = new WorkspaceRouter()): PlanShellController {
  const existing = root.querySelector(".workspace-global-shell");
  existing?.remove();
  const shell = document.createElement("aside");
  shell.className = "workspace-global-shell";
  shell.setAttribute("aria-label", "方案工作区");
  shell.innerHTML = `
    <header class="workspace-brand"><span aria-hidden="true">B</span><div><strong>BUILD LAB</strong><small>零基础装机向导</small></div></header>
    <section class="workspace-plan-card" aria-label="当前方案">
      <label><span>正在进行的方案</span><select data-plan-switcher aria-label="切换当前方案"></select></label>
      <div class="workspace-plan-identity"><strong data-plan-name>读取方案…</strong><small data-plan-version>正在准备…</small></div>
      <p data-save-status aria-live="polite">正在连接工作区…</p>
    </section>
    <nav aria-label="装机向导">${Object.entries(navigation).map(([route, item]) => `<a href="#/${route}" data-route="${route}"><i>${item.step}</i><span><strong>${item.label}</strong><small>${item.hint}</small></span></a>`).join("")}</nav>
    <footer class="workspace-shell-actions">
      <button type="button" data-save-version>保存当前版本</button>
      <button type="button" data-new-plan>＋ 新建装机方案</button>
    </footer>
    <p class="workspace-inline-error" data-workspace-error role="alert" hidden></p>
    <dialog class="workspace-new-plan-dialog" data-new-plan-dialog aria-labelledby="new-plan-title">
      <form method="dialog">
        <h2 id="new-plan-title">新建方案</h2>
        <p>从空白需求开始和 Agent 对话，或继续使用当前 N6 模板。</p>
        <button type="button" data-new-agent-plan><strong>使用 Agent 初始化</strong><span>先收集预算与用途，完整提案经你批准后才写入草稿</span></button>
        <button type="button" data-new-template-plan><strong>使用 N6 模板</strong><span>立即创建现有默认配置</span></button>
        <button type="submit">取消</button>
      </form>
    </dialog>`;
  root.prepend(shell);

  const switcher = shell.querySelector<HTMLSelectElement>("[data-plan-switcher]")!;
  const error = shell.querySelector<HTMLElement>("[data-workspace-error]")!;
  const render = (state: PlanStoreState) => {
    switcher.innerHTML = state.plans.map((plan) => `<option value="${plan.id}">${plan.name}${plan.initializationStatus === "pending" ? "（待初始化）" : ""}${plan.status === "archived" ? "（已归档）" : ""}</option>`).join("");
    switcher.value = state.activePlan?.id ?? "";
    switcher.disabled = !state.plans.length;
    shell.querySelector<HTMLElement>("[data-plan-name]")!.textContent = state.activePlan?.name ?? "尚无方案";
    shell.querySelector<HTMLElement>("[data-plan-version]")!.textContent = state.activePlan?.activeVersionId ? "已有保存检查点" : "还没有保存检查点";
    const status = shell.querySelector<HTMLElement>("[data-save-status]")!;
    status.textContent = statusLabel(state);
    status.dataset.status = state.saveStatus;
    shell.querySelector<HTMLButtonElement>("[data-save-version]")!.disabled = state.activePlan?.metadata.initialization?.status === "pending";
    error.hidden = !state.error;
    error.textContent = state.error ?? "";
  };
  const unsubscribeStore = store.subscribe(render);

  switcher.addEventListener("change", () => {
    void store.activate(switcher.value).catch((cause) => {
      error.hidden = false;
      error.textContent = cause instanceof Error && cause.message === "active_plan_has_unsaved_changes" ? "当前方案仍有未版本化修改，请先保存版本后再切换。" : "无法切换方案。";
      switcher.value = store.getState().activePlan?.id ?? "";
    });
  });
  const dialog = shell.querySelector<HTMLDialogElement>("[data-new-plan-dialog]")!;
  shell.querySelector<HTMLButtonElement>("[data-new-plan]")!.addEventListener("click", () => {
    const guidedDialog = root.querySelector<HTMLDialogElement>("[data-create-dialog]");
    const target = guidedDialog ?? dialog;
    if (typeof target.showModal === "function") target.showModal();
    else target.setAttribute("open", "");
  });
  shell.querySelector<HTMLButtonElement>("[data-new-agent-plan]")!.addEventListener("click", () => {
    const timestamp = new Date().toISOString();
    const scaffold = createAgentInitializationScaffold("new-plan", timestamp);
    void store.create("待 Agent 初始化方案", scaffold.config, scaffold.metadata).then(() => {
      dialog.close?.();
      dialog.removeAttribute("open");
      router.navigate("agent");
    }).catch((cause) => {
      error.hidden = false;
      error.textContent = cause instanceof Error ? cause.message : "无法创建方案";
    });
  });
  shell.querySelector<HTMLButtonElement>("[data-new-template-plan]")!.addEventListener("click", () => {
    const timestamp = new Date().toISOString();
    const config: BuildConfig = createDefaultN6Config("new-plan", timestamp);
    void store.create(`N6 方案 ${new Date().toLocaleDateString("zh-CN")}`, config).then(() => {
      dialog.close?.();
      dialog.removeAttribute("open");
    }).catch((cause) => {
      error.hidden = false;
      error.textContent = cause instanceof Error ? cause.message : "无法创建方案";
    });
  });
  shell.querySelector<HTMLButtonElement>("[data-save-version]")!.addEventListener("click", () => {
    void store.saveVersion().catch((cause) => {
      error.hidden = false;
      error.textContent = cause instanceof Error ? cause.message : "无法保存版本";
    });
  });

  const routeLinks = [...shell.querySelectorAll<HTMLAnchorElement>("[data-route]")];
  for (const link of routeLinks) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      router.navigate(link.dataset.route as WorkspaceRoute);
    });
  }
  const unsubscribeRoute = router.subscribe((route) => {
    root.dataset.workspaceRoute = route;
    for (const link of routeLinks) link.setAttribute("aria-current", link.dataset.route === route ? "page" : "false");
    const activeLink = routeLinks.find((link) => link.dataset.route === route);
    const nav = activeLink?.parentElement;
    if (activeLink && nav && nav.scrollWidth > nav.clientWidth && typeof activeLink.scrollIntoView === "function") {
      requestAnimationFrame(() => activeLink.scrollIntoView({ block: "nearest", inline: "center" }));
    }
    document.title = `${navigation[route].label} · Build Lab`;
  });
  router.start();

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!store.shouldWarnBeforeUnload()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", beforeUnload);

  return {
    dispose() {
      unsubscribeStore();
      unsubscribeRoute();
      router.stop();
      window.removeEventListener("beforeunload", beforeUnload);
      delete root.dataset.workspaceRoute;
      shell.remove();
    },
  };
}
