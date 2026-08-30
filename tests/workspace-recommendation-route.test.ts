import { describe, expect, it, vi } from "vitest";
import type { PlanRepository } from "../src/plans/contracts";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";

const jobId = `job-${"a".repeat(64)}`;

describe("U10 workspace recommendation routes", () => {
  const repository = {} as PlanRepository;

  it("accepts only a solver job and optional user weights, then reads the persisted plan/job view", async () => {
    const generated = { schemaVersion: "production-recommendation-view-v1", setRef: `sha256:${"b".repeat(64)}` };
    const service = {
      generate: vi.fn(async () => generated),
      view: vi.fn(async () => generated),
    };
    const options = { recommendations: service as never, recommendationsEnabled: true };
    expect(await handleWorkspaceRoute("POST", "/api/workspace/plans/plan-a/recommendations", {
      solverJobId: jobId,
    }, repository, options)).toEqual({ status: 201, payload: generated });
    expect(service.generate).toHaveBeenCalledWith({ planId: "plan-a", solverJobId: jobId });
    expect(await handleWorkspaceRoute("GET", `/api/workspace/plans/plan-a/recommendations/${jobId}`, {}, repository, options))
      .toEqual({ status: 200, payload: generated });
    expect(service.view).toHaveBeenCalledWith("plan-a", jobId);
    expect((await handleWorkspaceRoute("POST", "/api/workspace/plans/plan-a/recommendations", {
      solverJobId: jobId, objectiveScores: { workloadValue: 1 },
    }, repository, options)).status).toBe(400);
  });

  it("keeps the route absent while recommendations are disabled", async () => {
    expect(await handleWorkspaceRoute("POST", "/api/workspace/plans/plan-a/recommendations", {
      solverJobId: jobId,
    }, repository)).toEqual({ status: 404, payload: { error: "recommendations_disabled" } });
  });
});
