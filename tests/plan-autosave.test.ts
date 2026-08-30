import { describe, expect, it, vi } from "vitest";
import type { WorkspacePlanApi } from "../src/plans/client";
import { WorkspaceApiError } from "../src/plans/client";
import { PlanStore } from "../src/plans/client-store";
import { PLAN_SCHEMA_VERSION, type BuildPlan, type BuildPlanSummary, type PlanVersion } from "../src/plans/contracts";
import { sha256Hex } from "../src/plans/canonical";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { createPlanPartialEvaluationV3 } from "../src/plans/evaluation";
import { hashPlanConfig } from "../src/plans/canonical";
import type { BuildConfigDocument } from "../src/config/types";

const storage = { getItem: () => null, setItem: () => undefined };
const now = "2026-08-25T00:00:00.000Z";
function activePlan(): BuildPlan {
  return { schemaVersion: PLAN_SCHEMA_VERSION, id: "plan-12345678", name: "Plan", status: "active", createdAt: now, updatedAt: now, activeVersionId: null, draftRevision: 0, draft: { schemaVersion: PLAN_SCHEMA_VERSION, baseVersionId: null, config: createDefaultN6Config("plan-12345678", now), dirty: true, updatedAt: now }, metadata: {} };
}
function testApi(updateDraft: WorkspacePlanApi["updateDraft"]): WorkspacePlanApi {
  const plan = activePlan();
  return { list: async () => [{ ...plan, dirty: true } as unknown as BuildPlanSummary], get: async () => structuredClone(plan), create: async () => plan, updateInfo: async () => plan, updateDraft, saveVersion: async () => ({ id: "version-1" } as PlanVersion), duplicate: async () => plan, archive: async () => undefined, restore: async () => undefined, delete: async () => undefined, listVersions: async () => [] };
}

describe("R2 plan autosave", () => {
  it("debounces edits and uses the server revision as the concurrency base", async () => {
    vi.useFakeTimers();
    const update = vi.fn(async (_id: string, input: Parameters<WorkspacePlanApi["updateDraft"]>[1]) => ({ ...activePlan(), draftRevision: input.expectedRevision + 1, draft: { ...activePlan().draft, config: input.config } }));
    const store = new PlanStore({ api: testApi(update), storage, debounceMs: 250 });
    await store.initialize();
    store.patchDraft((config) => { config.selection.diskCount = 2; });
    store.patchDraft((config) => { config.selection.diskCount = 3; });
    store.setEvaluationSnapshot({
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: "plan-12345678",
      planVersionId: null,
      draftRevision: 0,
      configHash: await sha256Hex(store.getState().activePlan!.draft.config),
      evaluationHash: "a".repeat(64),
      evaluatedAt: now,
      evaluation: {} as never,
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith("plan-12345678", expect.objectContaining({ expectedRevision: 0, config: expect.objectContaining({ selection: expect.objectContaining({ diskCount: 3 }) }) }));
    await vi.waitFor(() => expect(store.getState().evaluationSnapshot?.draftRevision).toBe(1));
    expect(store.getState().saveStatus).toBe("saved");
    store.dispose();
    vi.useRealTimers();
  });

  it("surfaces stale revision as conflict and retains the local draft", async () => {
    const update = vi.fn(async () => { throw new WorkspaceApiError(409, "stale_revision", "stale"); });
    const store = new PlanStore({ api: testApi(update), storage, debounceMs: 60_000 });
    await store.initialize();
    store.patchDraft((config) => { config.selection.diskCount = 4; });
    await store.saveDraftNow();
    expect(store.getState()).toMatchObject({ saveStatus: "conflict", activePlan: { draft: { config: { selection: { diskCount: 4 } } } } });
    store.dispose();
  });

  it("installs the in-flight guard before saving subscribers can re-enter", async () => {
    const update = vi.fn(async (_id: string, input: Parameters<WorkspacePlanApi["updateDraft"]>[1]) => ({
      ...activePlan(),
      draftRevision: input.expectedRevision + 1,
      draft: { ...activePlan().draft, config: input.config },
    }));
    const store = new PlanStore({ api: testApi(update), storage, debounceMs: 60_000 });
    await store.initialize();
    let reentrantSave: Promise<BuildPlan | null> | null = null;
    let reentered = false;
    const unsubscribe = store.subscribe((state) => {
      if (state.saveStatus !== "saving" || reentered) return;
      reentered = true;
      reentrantSave = store.saveDraftNow();
    });

    store.patchDraft((config) => { config.selection.diskCount = 2; });
    const primarySave = store.saveDraftNow();
    await primarySave;
    await reentrantSave;

    expect(reentered).toBe(true);
    expect(update).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({ saveStatus: "saved", activePlan: { draftRevision: 1 } });
    unsubscribe();
    store.dispose();
  });

  it("clears the old V2 snapshot before accepting a V3 server draft", async () => {
    const store = new PlanStore({ api: testApi(async () => activePlan()), storage, debounceMs: 60_000 });
    await store.initialize();
    store.setEvaluationSnapshot({
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: "plan-12345678",
      planVersionId: null,
      draftRevision: 0,
      configHash: await hashPlanConfig(store.getState().activePlan!.draft.config),
      evaluationHash: "a".repeat(64),
      evaluatedAt: now,
      evaluation: {} as never,
    });
    const applied = structuredClone(store.getState().activePlan!) as BuildPlan<BuildConfigDocument>;
    applied.draftRevision = 1;
    applied.draft.config = createEmptyBuildConfigV3(applied.id, applied.name, now);
    store.acceptServerPlan(applied);
    expect(store.getState()).toMatchObject({ activePlan: { draftRevision: 1, draft: { config: { schemaVersion: "3.0.0" } } }, evaluation: null, evaluationSnapshot: null });

    const partial = createPlanPartialEvaluationV3(applied.draft.config);
    store.setEvaluationSnapshot({
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: applied.id,
      planVersionId: applied.activeVersionId,
      draftRevision: applied.draftRevision,
      configHash: await hashPlanConfig(applied.draft.config),
      evaluationHash: "b".repeat(64),
      evaluatedAt: now,
      evaluation: partial,
    });
    expect(store.getState().evaluationSnapshot?.evaluation).toMatchObject({ kind: "topology-v3-partial" });
    expect(store.getState().evaluation).toBeNull();
    store.dispose();
  });
});
