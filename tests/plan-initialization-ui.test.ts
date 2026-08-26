// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountPlanShell } from "../src/lab/plan-shell";
import { WorkspaceRouter } from "../src/lab/workspace-router";
import { initializedStore, mountWorkspaceDom } from "./helpers/workspace-ui";

describe("Agent plan initialization entry", () => {
  beforeEach(() => {
    window.location.hash = "#/workspace";
    mountWorkspaceDom();
  });

  it("creates a pending blank plan and routes the user to Agent without saving the scaffold as a version", async () => {
    const { store } = await initializedStore();
    const root = document.getElementById("n6-lab")!;
    const controller = mountPlanShell(root, store, new WorkspaceRouter());
    document.querySelector<HTMLButtonElement>("[data-new-plan]")!.click();
    expect(document.querySelector<HTMLDialogElement>("[data-new-plan-dialog]")?.hasAttribute("open")).toBe(true);
    document.querySelector<HTMLButtonElement>("[data-new-agent-plan]")!.click();
    await vi.waitFor(() => expect(store.getState().activePlan?.metadata.initialization?.status).toBe("pending"));
    expect(store.getState().activePlan).toMatchObject({
      name: "待 Agent 初始化方案",
      activeVersionId: null,
      draft: { dirty: true, config: { caseId: "case.jonsbo-n6" } },
      metadata: { initialization: { status: "pending", source: "agent" } },
    });
    expect(window.location.hash).toBe("#/agent");
    expect(document.querySelector<HTMLButtonElement>("[data-save-version]")?.disabled).toBe(true);
    expect(document.querySelector("[data-save-status]")?.textContent).toContain("先告诉助手");
    controller.dispose();
    store.dispose();
  });
});
