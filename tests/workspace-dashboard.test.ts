// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mountWorkspacePages } from "../src/lab/workspace-pages";
import { WorkspaceRouter } from "../src/lab/workspace-router";
import { initializedStore, makePlan, mountWorkspaceDom } from "./helpers/workspace-ui";

describe("R3 workspace dashboard", () => {
  it("renders active, alternate and archived plans with explicit next actions", async () => {
    const root = mountWorkspaceDom();
    const archived = makePlan("plan-87654321", "归档方案");
    archived.status = "archived";
    const { store } = await initializedStore([makePlan("plan-12345678", "主方案"), archived]);
    const router = new WorkspaceRouter();
    const pages = mountWorkspacePages(root, store, router);
    expect(root.querySelector("[data-current-plan]")?.textContent).toContain("主方案");
    expect(root.querySelectorAll("[data-plan-card]")).toHaveLength(2);
    expect(root.textContent).toContain("继续编辑");
    expect(root.textContent).toContain("恢复");
    pages.dispose(); store.dispose();
  });

  it("opens the guided purchases page before asking a beginner for a file", async () => {
    const root = mountWorkspaceDom();
    const input = document.createElement("input");
    input.id = "transaction-screenshot-input";
    input.type = "file";
    root.append(input);
    const click = vi.spyOn(input, "click").mockImplementation(() => undefined);
    const { store } = await initializedStore();
    const router = new WorkspaceRouter();
    const pages = mountWorkspacePages(root, store, router);
    root.querySelector<HTMLButtonElement>('[data-route-action="purchases"]')!.click();
    expect(router.current()).toBe("purchases");
    expect(click).not.toHaveBeenCalled();
    pages.dispose(); store.dispose();
  });

  it("renders every primary destination as one isolated route page", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const router = new WorkspaceRouter();
    const pages = mountWorkspacePages(root, store, router);
    for (const route of ["workspace", "editor", "evaluation", "spatial", "purchases", "build", "agent"] as const) {
      router.navigate(route);
      const visible = [...root.querySelectorAll<HTMLElement>("[data-workspace-page]")].filter((page) => !page.hidden);
      expect(visible).toHaveLength(1);
      expect(visible[0]?.dataset.workspacePage).toBe(route);
    }
    expect(root.querySelector("#workspace-page-evaluation")?.textContent).toContain("买之前，把风险查清楚");
    expect(root.querySelector("#workspace-page-purchases")?.textContent).toContain("只买已经确认需要的硬件");
    root.querySelector<HTMLButtonElement>('[data-evaluation-view="wiring"]')!.click();
    expect(root.querySelector<HTMLElement>('[data-evaluation-detail="wiring"]')!.hidden).toBe(false);
    router.navigate("workspace");
    router.navigate("evaluation");
    expect(root.querySelector<HTMLElement>('[data-evaluation-detail="summary"]')!.hidden).toBe(false);
    expect(root.querySelector('[data-evaluation-view="summary"]')?.getAttribute("aria-pressed")).toBe("true");
    pages.dispose(); store.dispose();
  });

  it("captures beginner goals before creating a new plan", async () => {
    const root = mountWorkspaceDom();
    const { api, store } = await initializedStore();
    const router = new WorkspaceRouter();
    const pages = mountWorkspacePages(root, store, router);
    root.querySelector<HTMLButtonElement>("[data-open-create]")!.click();
    root.querySelector<HTMLInputElement>("[data-create-name]")!.value = "卧室静音 NAS";
    root.querySelector<HTMLSelectElement>("[data-create-use-case]")!.value = "家庭存储 / NAS";
    root.querySelector<HTMLInputElement>("[data-create-budget]")!.value = "9000";
    root.querySelector<HTMLSelectElement>("[data-create-location]")!.value = "卧室或安静房间";
    root.querySelector<HTMLSelectElement>("[data-create-priority]")!.value = "低噪音";
    root.querySelector<HTMLInputElement>("[data-create-owned]")!.value = "两块 NVMe";
    root.querySelector<HTMLButtonElement>("[data-create-submit]")!.click();
    await vi.waitFor(() => expect(api.plans).toHaveLength(2));
    expect(api.plans.at(-1)?.metadata).toMatchObject({
      useCase: "家庭存储 / NAS",
      budgetCny: 9000,
      initialization: { status: "initialized", intent: { preferences: ["低噪音", "卧室或安静房间", "已有硬件：两块 NVMe"] } },
    });
    pages.dispose(); store.dispose();
  });
});
