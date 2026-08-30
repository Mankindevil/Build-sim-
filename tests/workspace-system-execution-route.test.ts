import { describe, expect, it, vi } from "vitest";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";
import type { ProductionSystemExecutionRuntime } from "../src/server/system-execution-production";

function runtime(): ProductionSystemExecutionRuntime {
  return {
    preview: vi.fn(async (planId: string, planVersionId: string) => ({
      schemaVersion: "system-procedure-preview-v1", planId, planVersionId,
    })) as never,
    start: vi.fn(async () => ({ session: { executionSessionId: "execution-route" }, revision: 0 })) as never,
    list: vi.fn(async () => [{ session: { executionSessionId: "execution-route" }, revision: 0 }]) as never,
    get: vi.fn(async () => ({ session: { executionSessionId: "execution-route" }, revision: 0 })) as never,
    revalidate: vi.fn(async (input) => ({ ...input, revision: 1 })) as never,
    recordStep: vi.fn(async (input) => ({ ...input, revision: 1 })) as never,
    confirmDestructiveAction: vi.fn(async (input) => ({ ...input, revision: 1 })) as never,
  } as unknown as ProductionSystemExecutionRuntime;
}

describe("U7 workspace system execution routes", () => {
  it("publishes only the server-derived creation capabilities", async () => {
    await expect(handleWorkspaceRoute(
      "GET",
      "/api/workspace/capabilities",
      {},
      {} as never,
      {
        topologyV3Enabled: true,
        systemProfilesEnabled: true,
        userObservationsEnabled: false,
        buildExecutionV3Enabled: true,
        storageLayoutEnabled: true,
      },
    )).resolves.toEqual({
      status: 200,
      payload: {
        schemaVersion: "workspace-capabilities-v1",
        topologyV3Enabled: true,
        systemProfilesEnabled: true,
        userObservationsEnabled: false,
        buildExecutionV3Enabled: true,
        storageLayoutEnabled: true,
        recommendationsEnabled: false,
        priceHistoryEnabled: false,
        priceTargetsEnabled: false,
        wholeBuildSolverEnabled: false,
        scenarioWhatIfEnabled: false,
        jobCenterEnabled: false,
        backupRestoreEnabled: false,
        doctorEnabled: false,
        portabilityEnabled: false,
      },
    });
  });

  it("derives plan/version/session ownership from the path and exposes guarded execution controls", async () => {
    const systemExecution = runtime();
    const route = (method: string, pathname: string, body: unknown = {}) => handleWorkspaceRoute(
      method,
      pathname,
      body,
      {} as never,
      { systemExecution, systemProfilesEnabled: true, buildExecutionV3Enabled: true },
    );

    const preview = await route("GET", "/api/workspace/plans/plan%20route/versions/version%20route/system-procedure");
    expect(preview).toMatchObject({ status: 200, payload: { planId: "plan route", planVersionId: "version route" } });
    expect(systemExecution.preview).toHaveBeenCalledWith("plan route", "version route");

    expect((await route("POST", "/api/workspace/plans/plan%20route/versions/version%20route/system-procedure", {})).status).toBe(201);
    expect(systemExecution.start).toHaveBeenCalledWith("plan route", "version route");
    expect((await route("GET", "/api/workspace/plans/plan%20route/execution-sessions")).status).toBe(200);
    expect((await route("GET", "/api/workspace/plans/plan%20route/execution-sessions/execution%20route")).status).toBe(200);

    const input = {
      expectedRevision: 0,
      expectedHash: "a".repeat(64),
      stepId: "prepare-inventory",
      result: "confirmed",
      observationIds: ["observation-route"],
    };
    expect((await route("PATCH", "/api/workspace/plans/plan%20route/execution-sessions/execution%20route", input)).status).toBe(200);
    expect(systemExecution.recordStep).toHaveBeenCalledWith({
      planId: "plan route",
      executionSessionId: "execution route",
      ...input,
    });
    expect((await route("POST", "/api/workspace/plans/plan%20route/execution-sessions/execution%20route/revalidate", {
      againstPlanVersionId: "version current",
      expectedRevision: 1,
      expectedHash: "b".repeat(64),
    })).status).toBe(200);
    expect(systemExecution.revalidate).toHaveBeenCalledWith({
      planId: "plan route",
      executionSessionId: "execution route",
      againstPlanVersionId: "version current",
      expectedRevision: 1,
      expectedHash: "b".repeat(64),
    });
    expect((await route("POST", "/api/workspace/plans/plan%20route/execution-sessions/execution%20route/destructive-actions/wipe%20target/confirm", {
      expectedRevision: 1,
      expectedHash: "b".repeat(64),
      confirmed: true,
    })).status).toBe(200);
    expect(systemExecution.confirmDestructiveAction).toHaveBeenCalledWith({
      planId: "plan route",
      executionSessionId: "execution route",
      stepId: "wipe target",
      expectedRevision: 1,
      expectedHash: "b".repeat(64),
    });
  });

  it("rejects caller authority fields and disappears with the system-profile flag", async () => {
    const systemExecution = runtime();
    const options = { systemExecution, systemProfilesEnabled: true, buildExecutionV3Enabled: true };
    expect(await handleWorkspaceRoute(
      "POST",
      "/api/workspace/plans/plan-route/versions/version-route/system-procedure",
      { planId: "other-plan" },
      {} as never,
      options,
    )).toMatchObject({ status: 400, payload: { error: "invalid_request" } });
    expect(systemExecution.start).not.toHaveBeenCalled();

    expect(await handleWorkspaceRoute(
      "PATCH",
      "/api/workspace/plans/plan-route/execution-sessions/execution-route",
      { expectedRevision: 0, expectedHash: "a".repeat(64), stepId: "prepare", result: "confirmed", planId: "other" },
      {} as never,
      options,
    )).toMatchObject({ status: 400, payload: { error: "invalid_request" } });
    expect(systemExecution.recordStep).not.toHaveBeenCalled();

    expect(await handleWorkspaceRoute(
      "POST",
      "/api/workspace/plans/plan-route/execution-sessions/execution-route/revalidate",
      { againstPlanVersionId: "version-current", expectedRevision: 0, expectedHash: "a".repeat(64), procedureSafetyHash: "b".repeat(64) },
      {} as never,
      options,
    )).toMatchObject({ status: 400, payload: { error: "invalid_request" } });
    expect(systemExecution.revalidate).not.toHaveBeenCalled();

    expect(await handleWorkspaceRoute(
      "GET",
      "/api/workspace/plans/plan-route/execution-sessions",
      {},
      {} as never,
      { systemProfilesEnabled: false },
    )).toEqual({ status: 404, payload: { error: "system_profiles_disabled" } });

    expect(await handleWorkspaceRoute(
      "GET",
      "/api/workspace/plans/plan-route/execution-sessions",
      {},
      {} as never,
      { systemProfilesEnabled: true, buildExecutionV3Enabled: false },
    )).toEqual({ status: 404, payload: { error: "build_execution_v3_disabled" } });
  });
});
