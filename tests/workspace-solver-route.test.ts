import { describe, expect, it, vi } from "vitest";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";
import type { WholeBuildSolverRouteRuntime } from "../src/server/solver-production";

const jobId = `job-${"a".repeat(64)}`;

function runtime(): WholeBuildSolverRouteRuntime {
  return {
    enqueue: vi.fn(async (input) => ({
      job: { jobId, planId: (input as { planId: string }).planId, status: "queued", revision: 0 },
      created: true,
      requestRef: `sha256:${"b".repeat(64)}`,
    })) as never,
    status: vi.fn(async () => ({
      job: { jobId, planId: "plan-route-solver", status: "queued", revision: 0 },
      result: null,
    })) as never,
    cancel: vi.fn(async () => ({ jobId, planId: "plan-route-solver", status: "cancelled", revision: 1 })) as never,
    resume: vi.fn(async () => ({ jobId, planId: "plan-route-solver", status: "queued", revision: 1 })) as never,
  };
}

describe("U6 workspace solver route", () => {
  it("keeps config and snapshots server-side while exposing enqueue/status controls", async () => {
    const solver = runtime();
    const route = (method: string, pathname: string, body: unknown = {}) => handleWorkspaceRoute(
      method, pathname, body, {} as never, { wholeBuildSolver: solver, wholeBuildSolverEnabled: true },
    );
    const request = {
      basePlanVersionId: "version-route-solver",
      lockedInstanceIds: [],
      requirementSpecId: "requirements-route-solver",
      limits: { maxEvaluations: 16, maxDurationMs: 5_000, maxCandidatesPerRequirement: 4 },
    };
    const enqueued = await route("POST", "/api/workspace/plans/plan-route-solver/solver-jobs", request);
    expect(enqueued.status).toBe(202);
    expect(solver.enqueue).toHaveBeenCalledWith({ planId: "plan-route-solver", ...request });
    expect((await route("GET", `/api/workspace/plans/plan-route-solver/solver-jobs/${jobId}`)).status).toBe(200);
    expect((await route("POST", `/api/workspace/plans/plan-route-solver/solver-jobs/${jobId}/cancel`, {
      expectedRevision: 0,
    })).status).toBe(200);
    expect((await route("POST", "/api/workspace/plans/plan-route-solver/solver-jobs", {
      ...request,
      config: { schemaVersion: "3.0.0" },
    })).status).toBe(400);
  });

  it("is absent when the feature flag is off", async () => {
    const response = await handleWorkspaceRoute(
      "POST",
      "/api/workspace/plans/plan-route-solver/solver-jobs",
      {},
      {} as never,
      { wholeBuildSolverEnabled: false },
    );
    expect(response).toEqual({ status: 404, payload: { error: "whole_build_solver_disabled" } });
  });
});
