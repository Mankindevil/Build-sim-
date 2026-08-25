// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mountWorkspacePages } from "../src/lab/workspace-pages";
import { WorkspaceRouter } from "../src/lab/workspace-router";
import { PLAN_SCHEMA_VERSION, type PlanVersion } from "../src/plans/contracts";
import { initializedStore, makePlan, mountWorkspaceDom } from "./helpers/workspace-ui";

describe("R3 version history", () => {
  it("shows immutable history, field diff and restores a version as a new draft", async () => {
    const root = mountWorkspaceDom();
    const plan = makePlan("plan-12345678", "主方案", 3);
    const oldConfig = structuredClone(plan.draft.config);
    oldConfig.selection.diskCount = 1;
    const version: PlanVersion = { schemaVersion: PLAN_SCHEMA_VERSION, id: "version-12345678", planId: plan.id, versionNumber: 1, createdAt: "2026-08-25T00:00:00.000Z", reason: "initial", summary: "初始版本", config: oldConfig, configHash: "a".repeat(64), parentVersionId: null };
    const { store } = await initializedStore([plan], [version]);
    const pages = mountWorkspacePages(root, store, new WorkspaceRouter());
    root.querySelector<HTMLButtonElement>("[data-open-history]")!.click();
    await vi.waitFor(() => expect(root.querySelector("[data-version-list]")?.textContent).toContain("初始版本"));
    root.querySelector<HTMLButtonElement>("[data-compare-version]")!.click();
    await vi.waitFor(() => expect(root.querySelector("[data-version-diff]")?.textContent).toContain("/selection/diskCount"));
    root.querySelector<HTMLButtonElement>("[data-restore-version]")!.click();
    await vi.waitFor(() => expect(store.getState().activePlan?.draft.config.selection.diskCount).toBe(1));
    expect(store.getState().saveStatus).toBe("dirty");
    pages.dispose(); store.dispose();
  });
});

