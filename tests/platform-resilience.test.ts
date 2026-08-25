import { describe, expect, it } from "vitest";
import type { WorkspacePlanApi } from "../src/plans/client";
import { PlanStore, ACTIVE_PLAN_KEY } from "../src/plans/client-store";
import { BuildTaskStore, BUILD_TASK_STORAGE_PREFIX } from "../src/plans/build-task-store";
import { evaluateBuild } from "../src/core/evaluate";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { loadBundledCatalog } from "../src/sku/catalog";
import { makePlan } from "./helpers/workspace-ui";

class Storage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("R10 corrupted storage and offline recovery", () => {
  it("ignores malformed task rows and deterministically rebuilds current tasks", () => {
    const storage = new Storage();
    const planId = "plan-resilience";
    storage.setItem(`${BUILD_TASK_STORAGE_PREFIX}${planId}`, JSON.stringify({ schemaVersion: 1, tasks: [{ planId, sourceRef: "purchase:bad", status: "hacked" }] }));
    const evaluation = evaluateBuild(createDefaultN6Config(planId, "2026-08-25T00:00:00.000Z"), loadBundledCatalog());
    const tasks = new BuildTaskStore(storage);
    tasks.reconcile({ planId, sourceVersionId: "version-1", evaluation });
    expect(tasks.getState().tasks.length).toBeGreaterThan(10);
    expect(tasks.getState().tasks.some((item) => item.sourceRef === "purchase:bad")).toBe(false);
  });

  it("does not trust a corrupted cached plan when the workspace service is offline", async () => {
    const storage = new Storage();
    storage.setItem(ACTIVE_PLAN_KEY, "plan-corrupt");
    storage.setItem("build-sim.workspace.plan-cache.v1:plan-corrupt", JSON.stringify({ id: "plan-corrupt", draft: { config: { injected: true } } }));
    const unavailable = async () => { throw new Error("workspace offline"); };
    const api = { list: unavailable, get: unavailable } as unknown as WorkspacePlanApi;
    const store = new PlanStore({ api, storage });
    await store.initialize();
    expect(store.getState()).toMatchObject({ initialized: true, offline: true, saveStatus: "offline", activePlan: null, plans: [] });
  });

  it("keeps online workspace usable when browser storage is disabled", async () => {
    const plan = makePlan("plan-storage-disabled");
    const storage = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } };
    const api = { list: async () => [{ ...plan, dirty: false }], get: async () => structuredClone(plan) } as unknown as WorkspacePlanApi;
    const store = new PlanStore({ api, storage });
    await store.initialize();
    expect(store.getState()).toMatchObject({ initialized: true, offline: false, activePlan: { id: plan.id } });
  });
});
