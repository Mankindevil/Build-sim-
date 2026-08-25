// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { serializeConfig } from "../src/config/types";
import { mountWorkspacePages } from "../src/lab/workspace-pages";
import { WorkspaceRouter } from "../src/lab/workspace-router";
import { initializedStore, mountWorkspaceDom } from "./helpers/workspace-ui";

describe("R3 config import UI", () => {
  it("imports JSON through an explicit create-new-plan flow", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const pages = mountWorkspacePages(root, store, new WorkspaceRouter());
    root.querySelector<HTMLButtonElement>("[data-open-create]")!.click();
    const mode = root.querySelector<HTMLSelectElement>("[data-create-mode]")!;
    mode.value = "import";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    root.querySelector<HTMLInputElement>("[data-create-name]")!.value = "导入方案";
    const imported = store.getState().activePlan!.draft.config;
    imported.selection.diskCount = 7;
    const file = new File([serializeConfig(imported)], "plan.json", { type: "application/json" });
    Object.defineProperty(root.querySelector<HTMLInputElement>("[data-import-file]")!, "files", { value: [file] });
    root.querySelector<HTMLButtonElement>("[data-create-submit]")!.click();
    await vi.waitFor(() => expect(store.getState().activePlan?.name).toBe("导入方案"));
    expect(store.getState().activePlan?.draft.config.selection.diskCount).toBe(7);
    expect(store.getState().plans).toHaveLength(2);
    pages.dispose(); store.dispose();
  });
});
