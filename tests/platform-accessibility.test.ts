// @vitest-environment happy-dom
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { mountWorkspacePages } from "../src/lab/workspace-pages";
import { WorkspaceRouter } from "../src/lab/workspace-router";
import { initializedStore, mountWorkspaceDom } from "./helpers/workspace-ui";

function luminance(hex: string): number {
  const channels = hex.match(/[a-f\d]{2}/gi)!.map((value) => Number.parseInt(value, 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
}
function contrast(foreground: string, background: string): number {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high! + .05) / (low! + .05);
}

describe("R10 accessibility gates", () => {
  it("keeps core light/dark text and semantic colors above WCAG AA normal-text contrast", () => {
    const pairs: Array<[string, string]> = [["#111820", "#f2f5f7"], ["#607080", "#ffffff"], ["#087b5a", "#ffffff"], ["#c63838", "#ffffff"], ["#f4f7fb", "#090d12"], ["#96a2b2", "#121821"], ["#6ee7bb", "#121821"], ["#ff7777", "#121821"]];
    for (const [foreground, background] of pairs) {
      expect(contrast(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("labels workspace dialogs and interactive task controls without unnamed buttons", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const pages = mountWorkspacePages(root, store, new WorkspaceRouter());
    for (const dialog of root.querySelectorAll<HTMLDialogElement>("dialog")) {
      const labelledBy = dialog.getAttribute("aria-labelledby");
      expect(labelledBy).toBeTruthy();
      expect(root.querySelector(`#${labelledBy}`)?.textContent?.trim()).toBeTruthy();
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) expect(button.textContent?.trim() || button.getAttribute("aria-label")).toBeTruthy();
    pages.dispose(); store.dispose();
  });

  it("creates empty V3 PC/NAS plans with explainable system defaults when the production capabilities are enabled", async () => {
    const root = mountWorkspaceDom();
    const { store } = await initializedStore();
    const pages = mountWorkspacePages(
      root,
      store,
      new WorkspaceRouter(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { topologyV3Enabled: true, systemProfilesEnabled: true },
    );
    const create = async (name: string, useCase: string) => {
      root.querySelector<HTMLButtonElement>("[data-open-create]")!.click();
      root.querySelector<HTMLInputElement>("[data-create-name]")!.value = name;
      root.querySelector<HTMLSelectElement>("[data-create-use-case]")!.value = useCase;
      root.querySelector<HTMLButtonElement>("[data-create-submit]")!.click();
      await vi.waitFor(() => expect(store.getState().activePlan?.name).toBe(name));
      return store.getState().activePlan!.draft.config;
    };
    const pc = await create("空白 PC", "安静办公");
    expect(pc).toMatchObject({
      schemaVersion: "3.0.0",
      intent: { state: "answered", value: "pc", source: "user", confirmedByUser: true },
      system: { profileId: "system.windows-11", source: "defaulted", lockedByUser: false },
      components: [],
    });
    const nas = await create("空白 NAS", "家庭存储 / NAS");
    expect(nas).toMatchObject({
      schemaVersion: "3.0.0",
      intent: { state: "answered", value: "nas", source: "user", confirmedByUser: true },
      system: { profileId: "system.truenas-scale", source: "defaulted", lockedByUser: false },
      components: [],
    });
    expect(root.querySelector("[data-system-panel]")?.textContent).toContain("storage-focused");
    expect(root.querySelector("[data-system-panel] [data-help-ref]")?.getAttribute("aria-label")).toContain("TrueNAS SCALE");
    pages.dispose(); store.dispose();
  });

  it("ships visible keyboard focus and reduced-motion fallbacks", async () => {
    const css = await readFile("src/lab/design-system.css", "utf8");
    const spatialCss = await readFile("src/lab/spatial-view.css", "utf8");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(spatialCss).toContain("prefers-reduced-motion:reduce");
  });
});
