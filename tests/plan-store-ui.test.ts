import { describe, expect, it, vi } from "vitest";
import { evaluateBuild } from "../src/core/evaluate";
import { hashPlanConfig } from "../src/plans/canonical";
import type { BuildPlan, BuildPlanSummary, PlanVersion } from "../src/plans/contracts";
import type { WorkspacePlanApi } from "../src/plans/client";
import { WorkspaceApiClient } from "../src/plans/client";
import { PlanStore } from "../src/plans/client-store";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { PLAN_SCHEMA_VERSION } from "../src/plans/contracts";
import { loadBundledCatalog } from "../src/sku/catalog";

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
    updateInfo: vi.fn(async () => structuredClone(plans[0]!)),
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

  it("pins the exact governed draft receipt to a newly saved version", async () => {
    const target = plan("plan-11111111");
    target.activeVersionId = null;
    target.draft.baseVersionId = null;
    const workspace = api([target]);
    const configHash = await hashPlanConfig(target.draft.config);
    const hashes = {
      configHash,
      requirementSpecHash: "1".repeat(64), factSnapshotHash: "2".repeat(64),
      userObservationSnapshotHash: "3".repeat(64), priceSnapshotHash: "4".repeat(64),
      ruleSetHash: "5".repeat(64), systemProfileHash: "6".repeat(64),
      adapterSnapshotHash: "7".repeat(64), engineHash: "8".repeat(64),
      simulationModelHash: "9".repeat(64), simulationInputHash: "a".repeat(64),
    };
    const evaluationLock = {
      schemaVersion: "plan-evaluation-lock-v1" as const,
      planId: target.id,
      snapshotHashes: hashes,
      factSnapshotId: "fact-snapshot-ui",
      userObservationSnapshotId: "observation-snapshot-ui",
      artifactLockfileHash: "b".repeat(64),
      contentHash: "c".repeat(64),
    };
    const version: PlanVersion = {
      schemaVersion: PLAN_SCHEMA_VERSION, id: "version-87654321", planId: target.id,
      versionNumber: 1, createdAt: "2026-08-25T00:00:10.000Z", reason: "manual-save",
      config: structuredClone(target.draft.config), configHash,
      evaluationHash: "d".repeat(64), evaluatedAt: "2026-08-25T00:00:09.000Z",
      evaluationLock, parentVersionId: null,
    };
    workspace.saveVersion = vi.fn(async () => structuredClone(version));
    const store = new PlanStore({ api: workspace, storage: new MemoryStorage() });
    await store.initialize();
    store.setEvaluationSnapshot({
      schemaVersion: PLAN_SCHEMA_VERSION, planId: target.id, planVersionId: null,
      draftRevision: target.draftRevision, configHash, evaluationHash: version.evaluationHash!,
      evaluationLock, evaluatedAt: version.evaluatedAt!,
      evaluation: evaluateBuild(target.draft.config, loadBundledCatalog()),
    });
    await store.saveVersion();
    expect(store.getState().evaluationSnapshot).toMatchObject({
      planVersionId: version.id,
      evaluationHash: version.evaluationHash,
      evaluationLock: { contentHash: evaluationLock.contentHash },
    });
    store.patchDraft((config) => { config.selection.diskCount += 1; });
    expect(store.getState()).toMatchObject({ evaluationSnapshot: null, evaluation: null, saveStatus: "dirty" });
    store.dispose();
  });
});
