import type { BuildConfig } from "../config/types";
import { createDefaultN6Config } from "../plans/default-plan";
import type { PlanStore, PlanStoreState } from "../plans/client-store";
import { WorkspaceRouter, type WorkspaceRoute } from "./workspace-router";
import "./workspace-shell.css";

const labels: Record<WorkspaceRoute, string> = {
  workspace: "工作台",
  editor: "方案编辑",
  evaluation: "评估中心",
  spatial: "空间预览",
  purchases: "采购与交易",
  build: "装机执行",
  agent: "Agent",
};

function statusLabel(state: PlanStoreState): string {
  if (state.saveStatus === "offline") return "离线 · 草稿未持久化";
  if (state.saveStatus === "saving") return "正在保存草稿…";
  if (state.saveStatus === "saved") return state.activePlan?.draft.dirty ? "草稿已保存 · 未版本化" : "已保存";
  if (state.saveStatus === "conflict") return "保存冲突 · 需要重新加载";
  if (state.saveStatus === "failed") return "保存失败 · 可重试";
  if (state.saveStatus === "dirty") return "有未保存修改";
  return "已保存版本";
}

function showLegacyPanel(root: HTMLElement, route: WorkspaceRoute): void {
  const panel = route === "agent" ? "agent" : "overview";
  for (const tab of root.querySelectorAll<HTMLElement>(".lab-tab[data-tab]")) tab.setAttribute("aria-selected", String(tab.dataset.tab === panel));
  for (const candidate of root.querySelectorAll<HTMLElement>(".lab-panel[data-panel]")) candidate.classList.toggle("is-hidden", candidate.dataset.panel !== panel);
}

export interface PlanShellController { dispose(): void; }

export function mountPlanShell(root: HTMLElement, store: PlanStore, router = new WorkspaceRouter()): PlanShellController {
  const existing = root.querySelector(".workspace-global-shell");
  existing?.remove();
  const shell = document.createElement("section");
  shell.className = "workspace-global-shell";
  shell.setAttribute("aria-label", "方案工作区");
  shell.innerHTML = `
    <div class="workspace-plan-row">
      <label><span>当前方案</span><select data-plan-switcher aria-label="切换当前方案"></select></label>
      <div class="workspace-plan-identity"><strong data-plan-name>读取方案…</strong><small data-plan-version>版本 —</small></div>
      <p data-save-status aria-live="polite">正在连接 workspace…</p>
      <button type="button" data-new-plan>新建方案</button>
      <button type="button" data-save-version>保存版本</button>
    </div>
    <nav aria-label="工作区导航">${Object.entries(labels).map(([route, label]) => `<a href="#/${route}" data-route="${route}">${label}</a>`).join("")}</nav>
    <p class="workspace-inline-error" data-workspace-error role="alert" hidden></p>`;
  root.prepend(shell);

  const switcher = shell.querySelector<HTMLSelectElement>("[data-plan-switcher]")!;
  const error = shell.querySelector<HTMLElement>("[data-workspace-error]")!;
  const render = (state: PlanStoreState) => {
    switcher.innerHTML = state.plans.map((plan) => `<option value="${plan.id}">${plan.name}${plan.status === "archived" ? "（已归档）" : ""}</option>`).join("");
    switcher.value = state.activePlan?.id ?? "";
    switcher.disabled = !state.plans.length;
    shell.querySelector<HTMLElement>("[data-plan-name]")!.textContent = state.activePlan?.name ?? "尚无方案";
    shell.querySelector<HTMLElement>("[data-plan-version]")!.textContent = state.activePlan?.activeVersionId ? `版本 ${state.activePlan.activeVersionId.slice(-8)}` : "尚未保存版本";
    const status = shell.querySelector<HTMLElement>("[data-save-status]")!;
    status.textContent = statusLabel(state);
    status.dataset.status = state.saveStatus;
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
  shell.querySelector<HTMLButtonElement>("[data-new-plan]")!.addEventListener("click", () => {
    const timestamp = new Date().toISOString();
    const config: BuildConfig = createDefaultN6Config("new-plan", timestamp);
    void store.create(`N6 方案 ${new Date().toLocaleDateString("zh-CN")}`, config).catch((cause) => {
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
    showLegacyPanel(root, route);
    const target = document.getElementById(router.target(route));
    if (target && route !== "workspace") target.scrollIntoView({ block: "start" });
    if (route === "purchases") document.querySelector<HTMLDialogElement>("#build-base-dialog")?.showModal?.();
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
