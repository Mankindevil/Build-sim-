import { describe, expect, it, vi } from "vitest";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";
import type { ScenarioWhatIfRouteRuntime } from "../src/server/what-if-production";

function runtime(): ScenarioWhatIfRouteRuntime {
  return {
    createFamily: vi.fn(async (input) => ({ familyId: "family-route", ...input })) as never,
    createBranch: vi.fn(async (input) => ({ scenarioId: "scenario-route", ...input })) as never,
    getScenario: vi.fn(async () => ({
      family: { planId: "plan-route-what-if" },
      branch: { scenarioId: "scenario-route" },
      config: { schemaVersion: "3.0.0" },
      result: { scenarioId: "scenario-route" },
    })) as never,
    evaluate: vi.fn(async (input) => ({ artifactRef: `sha256:${"a".repeat(64)}`, ...input })) as never,
    proposal: vi.fn(async () => ({ kind: "v3-change", scenarioId: "scenario-route" })) as never,
  };
}

describe("U6 workspace what-if routes", () => {
  it("derives plan ownership from the path and exposes immutable scenario evaluation", async () => {
    const scenarios = runtime();
    const route = (method: string, pathname: string, body: unknown = {}) => handleWorkspaceRoute(
      method,
      pathname,
      body,
      {} as never,
      { scenarioWhatIf: scenarios, scenarioWhatIfEnabled: true },
    );
    expect((await route("POST", "/api/workspace/plans/plan-route-what-if/scenario-families", {
      familyId: "family-route",
      name: "Route family",
      basePlanVersionId: "version-route",
    })).status).toBe(201);
    expect(scenarios.createFamily).toHaveBeenCalledWith({
      familyId: "family-route",
      planId: "plan-route-what-if",
      name: "Route family",
      basePlanVersionId: "version-route",
    });
    expect((await route("POST", "/api/workspace/plans/plan-route-what-if/scenarios", {
      scenarioId: "scenario-route",
      familyId: "family-route",
      patch: [],
    })).status).toBe(201);
    expect((await route("POST", "/api/workspace/plans/plan-route-what-if/scenarios/scenario-route/evaluate", {
      refreshSnapshots: false,
    })).status).toBe(200);
    expect(scenarios.evaluate).toHaveBeenCalledWith({
      planId: "plan-route-what-if",
      scenarioId: "scenario-route",
      refreshSnapshots: false,
    });
    expect((await route("GET", "/api/workspace/plans/plan-route-what-if/scenarios/scenario-route/result")).status).toBe(200);
    expect((await route("POST", "/api/workspace/plans/plan-route-what-if/scenarios/scenario-route/proposal", {})).status).toBe(200);
  });

  it("rejects caller plan authority and disappears when disabled", async () => {
    const scenarios = runtime();
    const injected = await handleWorkspaceRoute(
      "POST",
      "/api/workspace/plans/plan-route-what-if/scenario-families",
      { familyId: "family-route", name: "Route family", basePlanVersionId: "version-route", planId: "other-plan" },
      {} as never,
      { scenarioWhatIf: scenarios, scenarioWhatIfEnabled: true },
    );
    expect(injected.status).toBe(400);
    expect(scenarios.createFamily).not.toHaveBeenCalled();
    expect(await handleWorkspaceRoute(
      "POST",
      "/api/workspace/plans/plan-route-what-if/scenarios/scenario-route/evaluate",
      { refreshSnapshots: false },
      {} as never,
      { scenarioWhatIfEnabled: false },
    )).toEqual({ status: 404, payload: { error: "scenario_what_if_disabled" } });
  });
});
