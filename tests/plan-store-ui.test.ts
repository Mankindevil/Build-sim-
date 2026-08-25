import { describe, expect, it, vi } from "vitest";
import type { BuildPlan, BuildPlanSummary, PlanVersion } from "../src/plans/contracts";
import type { WorkspacePlanApi } from "../src/plans/client";
import { WorkspaceApiClient } from "../src/plans/client";
import { PlanStore } from "../src/plans/client-store";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { PLAN_SCHEMA_VERSION } from "../src/plans/contracts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function plan(id: string, diskCount = 1): BuildPlan {
  const now = "2026-08-25T00:00:00.000Z";
  const config = createDefaultN6Config(id, now);
  config.selection.diskCount = diskCount;
  return {
    schemaVersion: PLAN_SCHEMA_VERSION, id, name: id, status: "active", createdAt: now, updatedAt: now,
    activeVersionId: "version-12345678", draftRevision: 0,
    draft: { schemaVersion: PLAN_SCHEMA_VERSION, baseVersionId: "version-12345678", config, dirty: false, updatedAt: now },
    metadata: {},
  };
}

function api(plans: BuildPlan[]): WorkspacePlanApi {
  return {
    list: vi.fn(async () => plans.map((item) => ({ ...item, dirty: item.draft.dirty } as unknown as BuildPlanSummary))),
    get: vi.fn(async (id) => structuredClone(plans.find((item) => item.id === id)!)),
    create: vi.fn(async () => structuredClone(plans[0]!)),
    updateDraft: vi.fn(async (id, input) => {
      const current = structuredClone(plans.find((item) => item.id === id)!);
      current.draftRevision += 1;
      current.draft.config = input.config;
      current.draft.dirty = true;
      return current;
    }),
    saveVersion: vi.fn(async () => ({ id: "version-87654321" } as PlanVersion)),
    duplicate: vi.fn(async () => structuredClone(plans[0]!)),
    archive: vi.fn(async () => undefined), restore: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), listVersions: vi.fn(async () => []),
  };
}

describe("R2 client PlanStore", () => {
  it("invokes native-style fetch with the global receiver", async () => {
    const fetchImpl = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(JSON.stringify({ plans: [] }), { status: 200 }));
    }) as unknown as typeof fetch;
    const client = new WorkspaceApiClient(fetchImpl);
    await expect(client.list()).resolves.toEqual([]);
  });

  it("restores the active plan and keeps undo/redo isolated by plan", async () => {
    const storage = new MemoryStorage();
    storage.setItem("build-sim.workspace.active-plan.v1", "plan-22222222");
    const store = new PlanStore({ api: api([plan("plan-11111111"), plan("plan-22222222", 2)]), storage, debounceMs: 60_000 });
    await store.initialize();
    expect(store.getState().activePlan?.id).toBe("plan-22222222");
    store.patchDraft((config) => { config.selection.diskCount = 3; });
    expect(store.getState()).toMatchObject({ saveStatus: "dirty", canUndo: true });
    store.undo();
    expect(store.getState().activePlan?.draft.config.selection.diskCount).toBe(2);
    await store.activate("plan-11111111", true);
    expect(store.getState()).toMatchObject({ canUndo: false, canRedo: false });
    store.dispose();
  });

  it("restores a cached plan as explicitly offline without claiming it is saved", async () => {
    const storage = new MemoryStorage();
    const cached = plan("plan-11111111");
    storage.setItem("build-sim.workspace.active-plan.v1", cached.id);
    storage.setItem(`build-sim.workspace.plan-cache.v1:${cached.id}`, JSON.stringify(cached));
    const offlineApi = api([]);
    offlineApi.list = vi.fn(async () => { throw new Error("service unavailable"); });
    const store = new PlanStore({ api: offlineApi, storage });
    await store.initialize();
    expect(store.getState()).toMatchObject({ activePlan: { id: cached.id }, saveStatus: "offline", offline: true });
    store.dispose();
  });
});
