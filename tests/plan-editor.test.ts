// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mountWorkspacePages } from "../src/lab/workspace-pages";
import { WorkspaceRouter } from "../src/lab/workspace-router";
import { initializedStore, mountWorkspaceDom } from "./helpers/workspace-ui";

describe("R3 plan editor", () => {
  it("edits the active draft through grouped fields and supports per-plan undo", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const router = new WorkspaceRouter();
    const pages = mountWorkspacePages(root, store, router);
    router.navigate("editor");
    const disk = root.querySelector<HTMLInputElement>('[data-config-field="selection.diskCount"]')!;
    disk.value = "4";
    disk.dispatchEvent(new Event("change", { bubbles: true }));
    expect(store.getState().activePlan?.draft.config.selection.diskCount).toBe(4);
    expect(root.textContent).toContain("数据硬盘数量");
    root.querySelector<HTMLButtonElement>("[data-undo]")!.click();
    expect(store.getState().activePlan?.draft.config.selection.diskCount).toBe(1);
    pages.dispose(); store.dispose();
  });
});

