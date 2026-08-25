// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mountWorkspacePages } from "../src/lab/workspace-pages";
import { WorkspaceRouter } from "../src/lab/workspace-router";
import { BuildTaskStore } from "../src/plans/build-task-store";
import { evaluateBuild } from "../src/core/evaluate";
import { loadBundledCatalog } from "../src/sku/catalog";
import { initializedStore, MemoryStorage, mountWorkspaceDom } from "./helpers/workspace-ui";

describe("build task workspace UI", () => {
  it("uses one task state on workspace/build and opens the matching spatial target", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const active = store.getState().activePlan!;
    const evaluation = evaluateBuild(active.draft.config, loadBundledCatalog());
    store.setEvaluation(evaluation);
    const tasks = new BuildTaskStore(new MemoryStorage());
    tasks.reconcile({ planId: active.id, sourceVersionId: active.activeVersionId!, evaluation, purchaseFacts: [] });
    const router = new WorkspaceRouter();
    const pages = mountWorkspacePages(root, store, router, tasks);

    router.navigate("build");
    const spatialRow = [...root.querySelectorAll<HTMLElement>("[data-task-id]")].find((row) => row.querySelector("[data-task-spatial]"));
    expect(spatialRow).toBeTruthy();
    const id = spatialRow!.dataset.taskId!;
    const status = spatialRow!.querySelector<HTMLSelectElement>("[data-task-status]")!;
    status.value = "done";
    status.dispatchEvent(new Event("change", { bubbles: true }));
    expect(tasks.getState().tasks.find((item) => item.id === id)).toMatchObject({ status: "done", statusSource: "manual" });
    expect(root.querySelector(`[data-task-id="${CSS.escape(id)}"]`)?.getAttribute("data-task-status-value")).toBe("done");

    root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"] [data-task-spatial]`)!.click();
    expect(router.current()).toBe("spatial");
    expect(store.getState().selection?.partId).toBeTruthy();
    pages.dispose(); store.dispose();
  });
});
