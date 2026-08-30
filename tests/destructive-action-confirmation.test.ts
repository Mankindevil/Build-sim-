import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionRepository } from "../src/build-execution/repository";
import type { BuildProcedure, ProcedureDependencyContext } from "../src/build-execution/contracts";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { ProductionSystemExecutionRuntime, type SystemProcedurePreview } from "../src/server/system-execution-production";
import { createDestructiveActionPlan, type StorageDiskAuthority } from "../src/storage/truenas";
import { validateDestructiveActionPlan } from "../src/storage/contracts";
import { hash } from "./helpers/u7-fixtures";

const disk = (instanceId: string, locatorObservationId: string | null): StorageDiskAuthority => ({
  instanceId, capacityBytes: 1_000, media: "CMR", faultDomain: "case", revisionHash: hash("a"), factIds: ["fact.disk"], locatorObservationId,
  path: { controllerInstanceId: "hba", controllerPortId: instanceId, transport: "sas", controllerMode: "it", factIds: ["fact.path"] },
});

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U7 destructive action confirmation", () => {
  const base = { actionId: "wipe.install", diskInstanceIds: ["d1", "d2"], planId: "plan", planVersionId: "version", configHash: hash("a"), planRevisionHash: hash("b"), procedureSafetyHash: hash("c") };

  it("does not create an executable plan without one unique current locator per disk", () => {
    expect(createDestructiveActionPlan({ ...base, disks: [disk("d1", "obs-1"), disk("d2", null)] })).toBeNull();
    expect(createDestructiveActionPlan({ ...base, disks: [disk("d1", "obs-1"), disk("d2", "obs-1")] })).toBeNull();
  });

  it("creates only an unconfirmed plan and keeps current authority mandatory", () => {
    const plan = createDestructiveActionPlan({ ...base, disks: [disk("d1", "obs-1"), disk("d2", "obs-2")] });
    expect(plan).toMatchObject({ confirmation: "required", locatorObservationIds: ["obs-1", "obs-2"] });
    expect(validateDestructiveActionPlan(plan)).toContain("destructive action requires current plan/config/revision and disk locator context");
  });

  it("persists a separate exact-target confirmation before allowing a destructive step", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "buildsim-u7-destructive-")); roots.push(runtimeRoot);
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now: () => "2026-08-29T00:00:00.000Z" });
    await coordinator.initialize();
    const executions = new ExecutionRepository({ coordinator, now: () => "2026-08-29T00:10:00.000Z" });
    const procedure: BuildProcedure = {
      procedureId: "procedure-destructive",
      inputEvaluationHash: hash("d"),
      procedureSafetyHash: hash("c"),
      phases: ["prepare", "system_install"],
      steps: [
        { stepId: "prepare", phase: "prepare", action: "prepare", dependsOn: [], instanceIds: [], requirementIds: [], expectedResult: "ready", failureAction: "stop", riskLevel: "normal", stopConditions: [], failureBranchStepIds: [], confirmationPolicy: "user_confirm", safetyCritical: false, dependencyHashes: {}, dependencyHash: hash("e"), evidenceRefs: [] },
        { stepId: "commission-truenas-install-target", phase: "system_install", action: "install", dependsOn: ["prepare"], instanceIds: ["d1", "d2"], requirementIds: [], expectedResult: "installed", failureAction: "stop", riskLevel: "destructive", stopConditions: ["target mismatch"], failureBranchStepIds: [], confirmationPolicy: "observation_required", safetyCritical: true, dependencyHashes: { procedureSafetyHash: hash("c") }, dependencyHash: hash("f"), evidenceRefs: ["guide:truenas"] },
      ],
    };
    const context: ProcedureDependencyContext = {
      evaluatorArtifactRef: `sha256:${hash("9")}`,
      evaluatorArtifactHash: hash("9"), evaluatorVersion: "1",
      expectedInputEvaluationHash: procedure.inputEvaluationHash,
      expectedProcedureSafetyHash: procedure.procedureSafetyHash,
      expectedStepDependencyHashes: { prepare: hash("e"), "commission-truenas-install-target": hash("f") },
    };
    const stored = await executions.create({
      session: {
        executionSessionId: "execution-destructive", planVersionId: "version", procedureId: procedure.procedureId,
        evaluationHash: procedure.inputEvaluationHash, procedureSafetyHash: procedure.procedureSafetyHash, status: "active",
        results: [{ stepId: "prepare", result: "confirmed", at: "2026-08-29T00:09:00.000Z", actor: "user", confirmedAgainstDependencyHash: hash("e") }],
        destructiveActionConfirmations: [],
      },
      procedure, dependencyContext: context, leaseToken: "lease", leaseExpiresAt: "2026-08-30T00:00:00.000Z",
    });
    const service = new ProductionSystemExecutionRuntime({
      coordinator,
      plans: {
        versionAtRoot: vi.fn(),
        versionIdsAtRoot: vi.fn(async () => ["version"]),
        activeVersionIdAtRoot: vi.fn(async () => "version"),
      },
      locks: {} as never, facts: {} as never, observations: {} as never,
      executions,
      now: () => "2026-08-29T00:11:00.000Z",
    });
    const required = createDestructiveActionPlan({
      ...base,
      actionId: "destructive.commission-truenas-install-target",
      disks: [disk("d1", "obs-1"), disk("d2", "obs-2")],
    })!;
    vi.spyOn(service, "preview").mockResolvedValue({
      generated: { procedure, dependencyContext: context, firmwarePlans: [] },
      destructiveActions: [{ stepId: "commission-truenas-install-target", plan: required, blockedReason: null }],
    } as unknown as SystemProcedurePreview);

    const confirmed = await service.confirmDestructiveAction({
      planId: "plan", executionSessionId: stored.session.executionSessionId,
      expectedRevision: stored.revision, expectedHash: stored.recordHash,
      stepId: "commission-truenas-install-target",
    });
    expect(confirmed.session.destructiveActionConfirmations).toEqual([expect.objectContaining({
      actionId: "destructive.commission-truenas-install-target", confirmation: "confirmed", confirmationAt: "2026-08-29T00:11:00.000Z",
      diskInstanceIds: ["d1", "d2"], locatorObservationIds: ["obs-1", "obs-2"],
    })]);

    const completed = await service.recordStep({
      planId: "plan", executionSessionId: stored.session.executionSessionId,
      expectedRevision: confirmed.revision, expectedHash: confirmed.recordHash,
      stepId: "commission-truenas-install-target", result: "confirmed", observationIds: ["obs-1", "obs-2"],
    });
    expect(completed.session.results.at(-1)).toMatchObject({ stepId: "commission-truenas-install-target", result: "confirmed" });
    const restarted = new ExecutionRepository({ coordinator, now: () => "2026-08-29T00:12:00.000Z" });
    await expect(restarted.get("execution-destructive")).resolves.toEqual(completed);
  });
});
