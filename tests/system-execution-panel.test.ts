// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanStoreState } from "../src/plans/client-store";
import type { StoredExecutionSession } from "../src/build-execution/repository";
import { mountSystemExecutionPanel } from "../src/lab/system-execution-panel";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

afterEach(() => { document.body.replaceChildren(); });

const hash = (character: string) => character.repeat(64);

function state(): PlanStoreState {
  const config = createEmptyBuildConfigV3("plan-system-panel", "NAS", "2026-08-29T00:00:00.000Z");
  return {
    initialized: true,
    plans: [],
    activePlan: {
      schemaVersion: "3.0.0",
      id: config.id,
      name: config.name,
      status: "active",
      createdAt: config.updatedAt,
      updatedAt: config.updatedAt,
      activeVersionId: "version-system-panel",
      draftRevision: 1,
      draft: { schemaVersion: "3.0.0", baseVersionId: "version-system-panel", config, dirty: false, updatedAt: config.updatedAt },
      metadata: {},
    } as never,
    evaluation: null,
    evaluationSnapshot: null,
    saveStatus: "clean",
    selection: null,
    offline: false,
    localRevision: 0,
    error: null,
    canUndo: false,
    canRedo: false,
  };
}

describe("U7 version-bound system execution panel", () => {
  it("coalesces repeated plan notifications while one saved-version preview is pending", async () => {
    const planState = state();
    let notify = () => {};
    let resolvePreview!: (response: Response) => void;
    let resolveSessions!: (response: Response) => void;
    const previewResponse = new Promise<Response>((resolve) => { resolvePreview = resolve; });
    const sessionsResponse = new Promise<Response>((resolve) => { resolveSessions = resolve; });
    const fetchImpl = vi.fn((input: RequestInfo | URL) => (
      String(input).endsWith("/system-procedure") ? previewResponse : sessionsResponse
    )) as unknown as typeof fetch;
    const host = document.createElement("section"); document.body.append(host);
    const controller = mountSystemExecutionPanel(host, {
      getState: () => structuredClone(planState),
      subscribePlan: (listener) => { notify = listener; return () => undefined; },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    notify(); notify(); notify();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resolvePreview(new Response(JSON.stringify({
      schemaVersion: "system-procedure-preview-v1", planId: "plan-system-panel", planVersionId: "version-system-panel",
      configHash: hash("a"), evaluationHash: hash("b"), evaluationLockHash: hash("c"),
      profile: { profileId: "system.windows-11", label: "Windows 11" }, systemEvaluation: { verdict: "unknown" },
      storageLayouts: [], blockers: ["fixture"], generated: null, destructiveActions: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    resolveSessions(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await vi.waitFor(() => expect(host.textContent).toContain("Windows 11"));
    controller.dispose();
  });

  it("shows governed NAS paths and restores execution checkpoints after remount", async () => {
    const procedure = {
      procedureId: "procedure-system-panel",
      inputEvaluationHash: hash("a"),
      procedureSafetyHash: hash("b"),
      phases: ["prepare", "system_install"],
      steps: [
        {
          stepId: "prepare-inventory", phase: "prepare", action: "Match inventory.", dependsOn: [], instanceIds: [], requirementIds: [],
          expectedResult: "matched", failureAction: "stop", riskLevel: "normal", stopConditions: [], failureBranchStepIds: [],
          confirmationPolicy: "user_confirm", safetyCritical: false, dependencyHashes: {}, dependencyHash: hash("c"), evidenceRefs: [],
        },
        {
          stepId: "wipe-data", phase: "system_install", action: "Wipe exact targets.", dependsOn: ["prepare-inventory"], instanceIds: ["d1", "d2"], requirementIds: [],
          expectedResult: "targets wiped", failureAction: "stop", riskLevel: "destructive", stopConditions: [], failureBranchStepIds: [],
          confirmationPolicy: "observation_required", safetyCritical: true, dependencyHashes: { procedureSafetyHash: hash("b") }, dependencyHash: hash("d"), evidenceRefs: [],
        },
      ],
    };
    const preview = {
      schemaVersion: "system-procedure-preview-v1",
      planId: "plan-system-panel",
      planVersionId: "version-system-panel",
      configHash: hash("e"),
      evaluationHash: hash("a"),
      evaluationLockHash: hash("f"),
      profile: { profileId: "system.truenas-scale", label: "TrueNAS SCALE" },
      systemEvaluation: { verdict: "pass" },
      blockers: [],
      generated: { procedure },
      destructiveActions: [{
        stepId: "wipe-data",
        plan: {
          actionId: "destructive.wipe-data", diskInstanceIds: ["d1"], locatorObservationIds: ["obs-d1"],
          inputPlanId: "plan-system-panel", inputPlanVersionId: "version-system-panel", inputConfigHash: hash("e"),
          inputPlanRevisionHash: hash("7"), inputProcedureSafetyHash: hash("b"), confirmation: "required",
        },
        blockedReason: null,
      }],
      storageLayouts: [{
        status: "ready", layoutId: "layout-nas", disks: [],
        evaluation: {
          usableBytes: { min: 4_000_000_000_000, max: 4_000_000_000_000 }, assumptions: ["RAID/RAIDZ is not backup."],
          vdevResults: [{ vdevId: "data", estimatedUsableBytes: { min: 4_000_000_000_000, max: 4_000_000_000_000 }, faultTolerance: { diskFailures: 1 }, mixedCapacityLossBytes: 0, controllerPaths: [
            { diskInstanceId: "d1", controllerInstanceId: "hba-1", controllerPortId: "p1", transport: "sas" },
            { diskInstanceId: "d2", controllerInstanceId: "hba-1", controllerPortId: "p2", transport: "sas" },
          ] }],
        },
      }],
    };
    let sessions: Array<{
      revision: number; recordHash: string; session: {
        executionSessionId: string; planVersionId: string; procedureId: string; evaluationHash: string; procedureSafetyHash: string;
        status: string; results: Array<{ stepId: string; result: "confirmed"; at: string; actor: "user"; confirmedAgainstDependencyHash: string }>;
        destructiveActionConfirmations?: unknown[];
      }; replayContext: { procedure: typeof procedure; dependencyContext: Record<string, never> };
    }> = [];
    const stored = {
      revision: 0,
      recordHash: hash("9"),
      session: {
        executionSessionId: "execution-system-panel", planVersionId: "version-system-panel", procedureId: procedure.procedureId,
        evaluationHash: hash("a"), procedureSafetyHash: hash("b"), status: "active", results: [] as Array<{
          stepId: string; result: "confirmed"; at: string; actor: "user"; confirmedAgainstDependencyHash: string;
        }>, destructiveActionConfirmations: [] as unknown[],
      },
      replayContext: { procedure, dependencyContext: {} },
    };
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/system-procedure") && method === "GET") return json(preview);
      if (url.endsWith("/system-procedure") && method === "POST") { sessions = [structuredClone(stored)]; return json(sessions[0], 201); }
      if (url.endsWith("/execution-sessions") && method === "GET") return json({ sessions });
      if (url.includes("/destructive-actions/") && url.endsWith("/confirm") && method === "POST") {
        const current = structuredClone(sessions[0]!);
        current.revision += 1; current.recordHash = hash("7");
        current.session.destructiveActionConfirmations = [{
          ...preview.destructiveActions[0]!.plan, confirmation: "confirmed", confirmationAt: "2026-08-29T00:11:00.000Z",
        }];
        sessions = [current]; return json(current);
      }
      if (url.includes("/execution-sessions/") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { stepId: string };
        const current = structuredClone(sessions[0]!);
        current.revision += 1; current.recordHash = current.revision === 1 ? hash("8") : hash("6");
        current.session.results.push({
          stepId: body.stepId, result: "confirmed", at: `2026-08-29T00:1${current.revision}:00.000Z`, actor: "user",
          confirmedAgainstDependencyHash: body.stepId === "prepare-inventory" ? hash("c") : hash("d"),
        });
        sessions = [current]; return json(current);
      }
      return json({ error: "not_found" }, 404);
    }) as unknown as typeof fetch;
    const host = document.createElement("section"); document.body.append(host);
    const planState = state();
    const controller = mountSystemExecutionPanel(host, { getState: () => structuredClone(planState), subscribePlan: () => () => undefined, fetchImpl });
    await vi.waitFor(() => expect(host.textContent).toContain("d1 → hba-1/p1 (sas)"));
    expect(host.textContent).toContain("可容忍 1 块盘故障");
    expect(host.textContent).toContain("RAID/RAIDZ 不是备份");

    host.querySelector<HTMLButtonElement>("[data-start-system-execution]")!.click();
    await vi.waitFor(() => expect(host.querySelector("[data-execution-session='execution-system-panel']")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-confirm-execution-step='prepare-inventory']")!.click();
    await vi.waitFor(() => expect(host.querySelector("[data-step-result='confirmed']")).not.toBeNull());
    const destructiveConfirm = host.querySelector<HTMLButtonElement>("[data-confirm-destructive-action='wipe-data']")!;
    expect(destructiveConfirm.disabled).toBe(false);
    destructiveConfirm.click();
    await vi.waitFor(() => expect(host.textContent).toContain("精确磁盘目标已单独确认"));
    const locatorInput = host.querySelector<HTMLInputElement>("[data-step-observation-ids='wipe-data']")!;
    locatorInput.value = "obs-d1";
    const destructiveStep = host.querySelector<HTMLButtonElement>("[data-confirm-execution-step='wipe-data']")!;
    expect(destructiveStep.disabled).toBe(false);
    destructiveStep.click();
    await vi.waitFor(() => expect(host.querySelectorAll("[data-step-result='confirmed']")).toHaveLength(2));

    controller.dispose();
    const restored = mountSystemExecutionPanel(host, { getState: () => structuredClone(planState), subscribePlan: () => () => undefined, fetchImpl });
    await vi.waitFor(() => expect(host.querySelector("[data-step-result='confirmed']")).not.toBeNull());
    expect(host.textContent).toContain("修订 3");
    restored.dispose();
  });

  it("revalidates an older session against the current saved version and displays the stale reason", async () => {
    const planState = state();
    const procedure = {
      procedureId: "procedure-old", inputEvaluationHash: hash("a"), procedureSafetyHash: hash("b"), phases: ["prepare"],
      steps: [{
        stepId: "prepare-old", phase: "prepare", action: "Prepare old inputs.", dependsOn: [], instanceIds: [], requirementIds: [],
        expectedResult: "ready", failureAction: "stop", riskLevel: "normal", stopConditions: [], failureBranchStepIds: [],
        confirmationPolicy: "user_confirm", safetyCritical: false, dependencyHashes: {}, dependencyHash: hash("c"), evidenceRefs: [],
      }],
    };
    let stored = {
      schemaVersion: "execution-repository-v1", revision: 0, runtimeGeneration: 1,
      leaseToken: "lease", leaseExpiresAt: "2026-08-30T00:00:00.000Z", recordHash: hash("9"),
      session: {
        executionSessionId: "execution-old", planVersionId: "version-old", procedureId: procedure.procedureId,
        evaluationHash: hash("a"), procedureSafetyHash: hash("b"), status: "active", results: [],
      },
      replayContext: { procedure, dependencyContext: {}, references: {} },
    } as unknown as StoredExecutionSession;
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/system-procedure")) return json({
        schemaVersion: "system-procedure-preview-v1", planId: "plan-system-panel", planVersionId: "version-system-panel",
        configHash: hash("d"), evaluationHash: hash("e"), evaluationLockHash: hash("f"),
        profile: { profileId: "system.windows-11", label: "Windows 11" }, systemEvaluation: { verdict: "blocked" },
        storageLayouts: [], blockers: [], generated: { procedure }, destructiveActions: [],
      });
      if (url.endsWith("/execution-sessions") && method === "GET") return json({ sessions: [stored] });
      if (url.endsWith("/revalidate") && method === "POST") {
        stored = {
          ...stored,
          revision: 1,
          recordHash: hash("8"),
          session: {
            ...stored.session,
            status: "stale",
            staleReason: "revalidated against plan version version-system-panel; changed steps: prepare-old",
          },
        };
        return json(stored);
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }) as unknown as typeof fetch;
    const host = document.createElement("section"); document.body.append(host);
    const controller = mountSystemExecutionPanel(host, {
      getState: () => structuredClone(planState), subscribePlan: () => () => undefined, fetchImpl,
    });
    await vi.waitFor(() => expect(host.querySelector("[data-revalidate-execution-session='execution-old']")).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-revalidate-execution-session='execution-old']")!.click();
    await vi.waitFor(() => expect(host.querySelector("[data-execution-stale-reason]")?.textContent).toContain("changed steps: prepare-old"));
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/workspace/plans/plan-system-panel/execution-sessions/execution-old/revalidate",
      expect.objectContaining({ method: "POST" }),
    );
    controller.dispose();
  });
});
