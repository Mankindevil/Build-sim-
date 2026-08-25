// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
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
});

