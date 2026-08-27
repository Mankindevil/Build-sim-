// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mountWorkspacePages } from "../src/lab/workspace-pages";
import { WorkspaceRouter } from "../src/lab/workspace-router";
import { initializedStore, mountWorkspaceDom } from "./helpers/workspace-ui";
import { loadBundledCatalog } from "../src/sku/catalog";

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

  it("rebuilds open editor selectors after the runtime catalog gains an option", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const runtimeCatalog = loadBundledCatalog();
    const reviewed = structuredClone(runtimeCatalog.skus.find((sku) => sku.category === "gpu" && sku.id !== "gpu.none")!);
    reviewed.id = "gpu.msi-reviewed";
    reviewed.name = "MSI reviewed GPU";
    reviewed.power.tgpW = 220;
    const pages = mountWorkspacePages(root, store, new WorkspaceRouter(), undefined, undefined, () => runtimeCatalog);
    expect(root.querySelector<HTMLSelectElement>('[data-config-field="selection.gpuId"]')?.querySelector('[value="gpu.msi-reviewed"]')).toBeNull();
    runtimeCatalog.skus.push(reviewed);
    pages.refreshCatalog();
    expect(root.querySelector<HTMLSelectElement>('[data-config-field="selection.gpuId"]')?.querySelector('[value="gpu.msi-reviewed"]')?.textContent).toContain("220W");
    pages.dispose(); store.dispose();
  });

  it("edits persisted fan groups exposed by the selected case profile", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const pages = mountWorkspacePages(root, store, new WorkspaceRouter());
    expect(root.textContent).toContain("前部进风");
    expect(root.textContent).toContain("左侧盘区进风");
    const front = root.querySelector<HTMLElement>('[data-fan-mount="front"]')!;
    const count = front.querySelector<HTMLSelectElement>("[data-fan-count]")!;
    count.value = "1";
    count.dispatchEvent(new Event("change", { bubbles: true }));
    expect(store.getState().activePlan?.draft.config.selection.fanGroups).toContainEqual({ mountId: "front", sizeMm: 140, count: 1 });
    const mode = root.querySelector<HTMLSelectElement>('[data-config-field="selection.fanMode"]')!;
    mode.value = "quiet";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect(store.getState().activePlan?.draft.config.selection.fanMode).toBe("quiet");
    pages.dispose(); store.dispose();
  });

  it("reviews a case change and clears old case-specific fan mounts atomically", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const pages = mountWorkspacePages(root, store, new WorkspaceRouter());
    const caseSelect = root.querySelector<HTMLSelectElement>('[data-config-field="caseId"]')!;

    caseSelect.value = "";
    caseSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(store.getState().activePlan?.draft.config).toMatchObject({
      caseId: "case.jonsbo-n6",
      selection: { fanGroups: [{ mountId: "front", sizeMm: 140, count: 2 }] },
    });
    expect(caseSelect.value).toBe("case.jonsbo-n6");

    caseSelect.value = "";
    caseSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(store.getState().activePlan?.draft.config).toMatchObject({ caseId: "", selection: { fanGroups: [] } });
    expect(confirm).toHaveBeenCalledTimes(2);
    pages.dispose(); store.dispose();
  });
});
