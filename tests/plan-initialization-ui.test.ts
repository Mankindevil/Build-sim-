// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountPlanShell } from "../src/lab/plan-shell";
import { WorkspaceRouter } from "../src/lab/workspace-router";
import { initializedStore, makePlan, mountWorkspaceDom } from "./helpers/workspace-ui";

describe("Agent plan initialization entry", () => {
  beforeEach(() => {
    window.location.hash = "#/workspace";
    mountWorkspaceDom();
  });

  it("offers a normal blank plan as the default progressive path", async () => {
    const { store } = await initializedStore();
    const root = document.getElementById("n6-lab")!;
    const router = new WorkspaceRouter();
    const controller = mountPlanShell(root, store, router);
    document.querySelector<HTMLButtonElement>("[data-new-plan]")!.click();
    document.querySelector<HTMLButtonElement>("[data-new-blank-plan]")!.click();
    await vi.waitFor(() => expect(store.getState().activePlan?.draft.config.caseId).toBe(""));
    expect(store.getState().activePlan?.draft.config).toMatchObject({
      boardId: "", cpuId: "", selection: { psuId: "", coolerId: "", gpuId: "", memoryId: "", fanGroups: [] }, bom: [],
    });
    expect(store.getState().activePlan?.metadata.initialization).toBeUndefined();
    expect(router.current()).toBe("editor");
    controller.dispose();
    store.dispose();
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
      draft: { dirty: true, config: { caseId: "", boardId: "", cpuId: "", selection: { psuId: "", fanGroups: [] } } },
      metadata: { initialization: { status: "pending", source: "agent" } },
    });
    expect(window.location.hash).toBe("#/agent");
    expect(document.querySelector<HTMLButtonElement>("[data-save-version]")?.disabled).toBe(true);
    expect(document.querySelector("[data-save-status]")?.textContent).toContain("先告诉助手");
    controller.dispose();
    store.dispose();
  });

  it("renders persisted Agent plan ids and names as option values/text, never markup", async () => {
    const maliciousId = 'plan-12345678\"><img src=x onerror="globalThis.pwned=1">';
    const maliciousName = '<img src=x onerror="globalThis.pwned=2"> Agent 方案';
    const { store } = await initializedStore([makePlan(maliciousId, maliciousName)]);
    const root = document.getElementById("n6-lab")!;
    const controller = mountPlanShell(root, store, new WorkspaceRouter());

    const switcher = document.querySelector<HTMLSelectElement>("[data-plan-switcher]")!;
    expect(switcher.options).toHaveLength(1);
    expect(switcher.options[0]?.value).toBe(maliciousId);
    expect(switcher.options[0]?.textContent).toBe(maliciousName);
    expect(switcher.querySelector("img")).toBeNull();
    expect(document.querySelector("[onerror]")).toBeNull();

    controller.dispose();
    store.dispose();
  });
});
