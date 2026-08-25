import { describe, expect, it } from "vitest";
import type { BuildPlan, BuildPlanSummary, PlanRepository, PlanVersion } from "../src/plans/contracts";
import { PlanConflictError } from "../src/plans/conflict";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";

function repository(): PlanRepository {
  const plan = { id: "plan-12345678" } as BuildPlan;
  return {
    list: async () => [{ id: plan.id } as BuildPlanSummary],
    get: async () => plan,
    create: async () => plan,
    updateInfo: async () => plan,
    updateDraft: async () => plan,
    saveVersion: async () => ({ id: "version-12345678" } as PlanVersion),
    duplicate: async () => ({ ...plan, id: "plan-87654321" }),
    archive: async () => undefined,
    restore: async () => undefined,
    delete: async () => undefined,
    listVersions: async () => [],
  };
}

describe("R1 workspace plan API", () => {
  it("routes lifecycle operations independently from Agent runtime", async () => {
    const store = repository();
    await expect(handleWorkspaceRoute("GET", "/api/workspace/plans", {}, store)).resolves.toMatchObject({ status: 200, payload: { plans: [{ id: "plan-12345678" }] } });
    await expect(handleWorkspaceRoute("POST", "/api/workspace/plans", {}, store)).resolves.toMatchObject({ status: 201 });
    await expect(handleWorkspaceRoute("PATCH", "/api/workspace/plans/plan-12345678", {}, store)).resolves.toMatchObject({ status: 200 });
    await expect(handleWorkspaceRoute("PATCH", "/api/workspace/plans/plan-12345678/draft", {}, store)).resolves.toMatchObject({ status: 200 });
    await expect(handleWorkspaceRoute("POST", "/api/workspace/plans/plan-12345678/versions", {}, store)).resolves.toMatchObject({ status: 201 });
    await expect(handleWorkspaceRoute("POST", "/api/workspace/plans/plan-12345678/archive", {}, store)).resolves.toMatchObject({ status: 204 });
    await expect(handleWorkspaceRoute("POST", "/api/workspace/plans/plan-12345678/restore", {}, store)).resolves.toMatchObject({ status: 204 });
    await expect(handleWorkspaceRoute("DELETE", "/api/workspace/plans/plan-12345678", {}, store)).resolves.toMatchObject({ status: 204 });
  });

  it("returns a stable structured 404", async () => {
    await expect(handleWorkspaceRoute("GET", "/api/workspace/nope", {}, repository())).resolves.toEqual({
      status: 404,
      payload: { error: "route_not_found", route: "GET /api/workspace/nope" },
    });
  });

  it("maps stale revisions to a structured 409 without exposing internals", async () => {
    const store = repository();
    store.updateDraft = async () => { throw new PlanConflictError("stale_revision", 1, 2); };
    await expect(handleWorkspaceRoute("PATCH", "/api/workspace/plans/plan-12345678/draft", {}, store)).resolves.toMatchObject({
      status: 409,
      payload: { error: "stale_revision" },
    });
  });
});
