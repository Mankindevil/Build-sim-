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

  it("opens the transaction file picker directly from the current-plan action", async () => {
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
    expect(click).toHaveBeenCalledOnce();
    pages.dispose(); store.dispose();
  });
});
