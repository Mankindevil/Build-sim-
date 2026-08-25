import { describe, expect, it, vi } from "vitest";
import type { WorkspacePlanApi } from "../src/plans/client";
import { WorkspaceApiError } from "../src/plans/client";
import { PlanStore } from "../src/plans/client-store";
import { PLAN_SCHEMA_VERSION, type BuildPlan, type BuildPlanSummary, type PlanVersion } from "../src/plans/contracts";
import { createDefaultN6Config } from "../src/plans/default-plan";

const storage = { getItem: () => null, setItem: () => undefined };
const now = "2026-08-25T00:00:00.000Z";
function activePlan(): BuildPlan {
  return { schemaVersion: PLAN_SCHEMA_VERSION, id: "plan-12345678", name: "Plan", status: "active", createdAt: now, updatedAt: now, activeVersionId: null, draftRevision: 0, draft: { schemaVersion: PLAN_SCHEMA_VERSION, baseVersionId: null, config: createDefaultN6Config("plan-12345678", now), dirty: true, updatedAt: now }, metadata: {} };
}
function testApi(updateDraft: WorkspacePlanApi["updateDraft"]): WorkspacePlanApi {
  const plan = activePlan();
  return { list: async () => [{ ...plan, dirty: true } as unknown as BuildPlanSummary], get: async () => structuredClone(plan), create: async () => plan, updateDraft, saveVersion: async () => ({ id: "version-1" } as PlanVersion), duplicate: async () => plan, archive: async () => undefined, restore: async () => undefined, delete: async () => undefined, listVersions: async () => [] };
}

describe("R2 plan autosave", () => {
  it("debounces edits and uses the server revision as the concurrency base", async () => {
    vi.useFakeTimers();
    const update = vi.fn(async (_id: string, input: Parameters<WorkspacePlanApi["updateDraft"]>[1]) => ({ ...activePlan(), draftRevision: input.expectedRevision + 1, draft: { ...activePlan().draft, config: input.config } }));
    const store = new PlanStore({ api: testApi(update), storage, debounceMs: 250 });
    await store.initialize();
    store.patchDraft((config) => { config.selection.diskCount = 2; });
    store.patchDraft((config) => { config.selection.diskCount = 3; });
    await vi.advanceTimersByTimeAsync(249);
    expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith("plan-12345678", expect.objectContaining({ expectedRevision: 0, config: expect.objectContaining({ selection: expect.objectContaining({ diskCount: 3 }) }) }));
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
});
