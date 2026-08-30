import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startExecution } from "../src/build-execution/checklist";
import { initializeRuntimeCatalog } from "../scripts/price-server/catalog/repository.mjs";
import type { BuildProcedure, ProcedureDependencyContext } from "../src/build-execution/contracts";
import { ExecutionRepository } from "../src/build-execution/repository";
import type { UserObservation } from "../src/observations/contracts";
import { canonicalJson, hashPlanConfig, sha256Hex } from "../src/plans/canonical";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";
import { createWorkspaceRepositories } from "../src/server/workspace-server";
import { ProductionSystemExecutionRuntime, type SystemProcedurePreview } from "../src/server/system-execution-production";
import { DEFAULT_SYSTEM_PROFILE_REGISTRY } from "../src/system-profiles/registry";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";
import { generatedProcedure, hash } from "./helpers/u7-fixtures";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const environment = (runtimeRoot: string) => ({
  RUNTIME_ROOT: runtimeRoot,
  BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
  BUILD_SIM_FACT_GRAPH_ENABLED: "true",
  BUILD_SIM_USER_OBSERVATIONS_ENABLED: "true",
  BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "true",
  BUILD_SIM_PROGRESSIVE_EVALUATION_ENABLED: "true",
  BUILD_SIM_THERMAL_V3_ENABLED: "true",
  BUILD_SIM_ACOUSTIC_V3_ENABLED: "true",
  BUILD_SIM_SYSTEM_PROFILES_ENABLED: "true",
  BUILD_SIM_BUILD_EXECUTION_V3_ENABLED: "true",
  BUILD_SIM_STORAGE_LAYOUT_ENABLED: "true",
});

async function writeEmptyPrice(runtime: ReturnType<typeof createWorkspaceRepositories<BuildConfigV3>>): Promise<void> {
  const inputHash = createHash("sha256").update("u7-system-execution-price").digest("hex");
  const material = {
    schemaVersion: "1.1.0", asOf: "2026-08-29", snapshotId: `price-snapshot-${inputHash.slice(0, 20)}`,
    generatedAt: "2026-08-29T00:00:00.000Z", catalogVersion: "u7-system-execution", inputHash,
    priceVersion: "price-snapshot-v2", quotes: [],
  };
  await runtime.coordinator!.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
    await mkdir(path.join(activeRoot, "prices"), { recursive: true });
    await writeFile(path.join(activeRoot, "prices", "latest.json"), `${JSON.stringify({
      ...material,
      contentHash: createHash("sha256").update(JSON.stringify(material)).digest("hex"),
    })}\n`, "utf8");
  });
}

describe("U7 production system procedure and execution", () => {
  it("preserves price-only confirmations but marks dependency/safety changes stale across restart", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-u7-execution-revalidate-"));
    roots.push(runtimeRoot);
    const coordinator = new (await import("../src/runtime/coordinator.mjs")).RuntimeCoordinator({
      root: runtimeRoot,
      now: () => "2026-08-29T00:00:00.000Z",
    });
    await coordinator.initialize();
    const executions = new ExecutionRepository({ coordinator, now: () => "2026-08-29T00:10:00.000Z" });
    const generated = generatedProcedure("system.windows-11");
    let activeVersionId = "version-execution-v1";
    let switchActiveVersionAfterRead = false;
    let activeVersionReads = 0;
    const service = new ProductionSystemExecutionRuntime({
      coordinator,
      executions,
      plans: {
        versionAtRoot: vi.fn(),
        versionIdsAtRoot: vi.fn(async () => ["version-execution-v1", "version-price-only", "version-safety-change"]),
        activeVersionIdAtRoot: vi.fn(async () => {
          activeVersionReads += 1;
          return switchActiveVersionAfterRead && activeVersionReads > 1 ? "version-price-only" : activeVersionId;
        }),
      },
      locks: {} as never,
      facts: {} as never,
      observations: {} as never,
      now: () => "2026-08-29T00:10:00.000Z",
    });
    const priceOnly = structuredClone(generated);
    priceOnly.procedure.inputEvaluationHash = hash("6");
    const safetyChanged = structuredClone(generated);
    safetyChanged.procedure.procedureSafetyHash = hash("7");
    safetyChanged.procedure.steps[0]!.dependencyHash = hash("8");
    vi.spyOn(service, "preview").mockImplementation(async (_planId, planVersionId) => ({
      schemaVersion: "system-procedure-preview-v1",
      planId: "plan-execution",
      planVersionId,
      blockers: [],
      generated: planVersionId === "version-price-only" ? priceOnly : safetyChanged,
      destructiveActions: [],
    } as unknown as SystemProcedurePreview));

    const started = await startExecution({
      repository: executions,
      generated,
      planVersionId: "version-execution-v1",
      executionSessionId: "execution-revalidation",
      leaseToken: "execution-revalidation-lease",
      leaseExpiresAt: "2026-08-30T00:00:00.000Z",
      runtimeGeneration: 1,
    });
    const first = generated.procedure.steps[0]!;
    const confirmed = await service.recordStep({
      planId: "plan-execution",
      executionSessionId: started.session.executionSessionId,
      expectedRevision: started.revision,
      expectedHash: started.recordHash,
      stepId: first.stepId,
      result: "confirmed",
    });

    activeVersionId = "version-price-only";
    const priceRevalidated = await service.revalidate({
      planId: "plan-execution",
      executionSessionId: confirmed.session.executionSessionId,
      againstPlanVersionId: activeVersionId,
      expectedRevision: confirmed.revision,
      expectedHash: confirmed.recordHash,
    });
    expect(priceRevalidated).toEqual(confirmed);

    activeVersionId = "version-safety-change";
    activeVersionReads = 0;
    switchActiveVersionAfterRead = true;
    await expect(service.revalidate({
      planId: "plan-execution",
      executionSessionId: confirmed.session.executionSessionId,
      againstPlanVersionId: activeVersionId,
      expectedRevision: confirmed.revision,
      expectedHash: confirmed.recordHash,
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(executions.get(confirmed.session.executionSessionId)).resolves.toEqual(confirmed);

    activeVersionReads = 0;
    switchActiveVersionAfterRead = false;
    const stale = await service.revalidate({
      planId: "plan-execution",
      executionSessionId: confirmed.session.executionSessionId,
      againstPlanVersionId: activeVersionId,
      expectedRevision: confirmed.revision,
      expectedHash: confirmed.recordHash,
    });
    expect(stale).toMatchObject({
      revision: confirmed.revision + 1,
      session: { status: "stale", results: confirmed.session.results },
    });
    expect(stale.session.staleReason).toContain(`changed steps: ${first.stepId}`);
    expect(stale.session.staleReason).toContain(`stale confirmed steps: ${first.stepId}`);
    await expect(service.recordStep({
      planId: "plan-execution",
      executionSessionId: stale.session.executionSessionId,
      expectedRevision: stale.revision,
      expectedHash: stale.recordHash,
      stepId: generated.procedure.steps[1]!.stepId,
      result: "confirmed",
    })).rejects.toMatchObject({ code: "conflict" });
    const restarted = new ExecutionRepository({ coordinator, now: () => "2026-08-29T00:11:00.000Z" });
    await expect(restarted.get(stale.session.executionSessionId)).resolves.toEqual(stale);
  });

  it("generates from an exact saved receipt, persists a session, records a step, and replays after restart", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-u7-system-execution-"));
    roots.push(runtimeRoot);
    const runtime = createWorkspaceRepositories<BuildConfigV3>(environment(runtimeRoot));
    await runtime.coordinator!.initialize();
    await initializeRuntimeCatalog({ coordinator: runtime.coordinator!, generationAware: true });
    await writeEmptyPrice(runtime);
    const profile = DEFAULT_SYSTEM_PROFILE_REGISTRY.resolve("system.windows-11");
    const config = createEmptyBuildConfigV3("plan-u7-system", "Windows build", "2026-08-29T00:00:00.000Z");
    config.intent = { state: "answered", value: "pc", source: "user", confirmedByUser: true };
    config.system = { profileId: profile.profileId, versionFactId: profile.releaseFactId, source: "defaulted", lockedByUser: false };
    config.components = [{
      instanceId: "board-unresolved", kind: "motherboard", role: "board", state: "planned",
      identity: { status: "unresolved", userText: "motherboard pending exact identity" }, source: "user",
    }, {
      instanceId: "disk-observed", kind: "storage_drive", role: "future-install-target", state: "planned",
      identity: { status: "unresolved", userText: "disk pending exact product identity" }, source: "user",
    }];
    const plan = await runtime.repository.create({ name: config.name, config });
    const configHash = await hashPlanConfig(plan.draft.config);
    const disk = plan.draft.config.components.find(({ instanceId }) => instanceId === "disk-observed")!;
    const locatorBase = {
      observationId: "observation-disk-observed",
      planId: plan.id,
      subjectRef: { kind: "instance" as const, instanceId: disk.instanceId },
      fieldId: "storage.disk_locator" as const,
      value: "serial U7-DISK-001 in bay 1",
      method: "user_assertion" as const,
      attachmentRefs: [],
      confirmedByUser: true,
      observedAgainstConfigHash: configHash,
      subjectRevisionHash: await sha256Hex(disk),
      capturedAt: "2026-08-29T00:00:00.000Z",
      validatedAt: "2026-08-29T00:01:00.000Z",
      status: "active" as const,
    };
    const locator: UserObservation = {
      ...locatorBase,
      contentHash: createHash("sha256").update(canonicalJson(locatorBase)).digest("hex"),
    };
    await runtime.observationRepository.put({ observation: locator });
    const draftReceipt = await runtime.evaluationPipeline!.evaluateCurrent({
      planId: plan.id,
      target: { kind: "draft", expectedDraftRevision: plan.draftRevision, expectedConfigHash: configHash },
    });
    const version = await runtime.repository.saveVersion(plan.id, {
      expectedRevision: plan.draftRevision,
      expectedConfigHash: configHash,
      reason: "initial",
      evaluationHash: draftReceipt.evaluationHash,
      evaluatedAt: draftReceipt.evaluatedAt,
      evaluationLock: draftReceipt.evaluationLock,
    });

    const preview = await runtime.systemExecution!.preview(plan.id, version.id);
    expect(preview).toMatchObject({
      schemaVersion: "system-procedure-preview-v1",
      planId: plan.id,
      planVersionId: version.id,
      profile: { profileId: "system.windows-11" },
      systemEvaluation: { verdict: "blocked" },
      blockers: [],
    });
    expect(preview.generated?.procedure.steps.map(({ stepId }) => stepId)).toEqual(expect.arrayContaining([
      "prepare-inventory", "bench-minimal-post", "commission-windows-security", "commission-bitlocker-recovery",
    ]));

    const started = await runtime.systemExecution!.start(plan.id, version.id);
    expect(started.session).toMatchObject({ planVersionId: version.id, status: "active", results: [] });
    const firstStep = started.replayContext.procedure.steps.find(({ stepId }) => stepId === "prepare-inventory")!;
    const updated = await runtime.systemExecution!.recordStep({
      planId: plan.id,
      executionSessionId: started.session.executionSessionId,
      expectedRevision: started.revision,
      expectedHash: started.recordHash,
      stepId: firstStep.stepId,
      result: "confirmed",
    });
    expect(updated).toMatchObject({ revision: 1, session: { results: [{ stepId: "prepare-inventory", result: "confirmed" }] } });

    const restarted = createWorkspaceRepositories<BuildConfigV3>(environment(runtimeRoot));
    await expect(restarted.systemExecution!.get(plan.id, started.session.executionSessionId)).resolves.toEqual(updated);
    const executions = new ExecutionRepository({ coordinator: restarted.coordinator!, now: () => "2026-08-29T00:20:00.000Z" });
    const safetyHash = createHash("sha256").update("u7-destructive-safety").digest("hex");
    const stepHash = createHash("sha256").update("u7-destructive-step").digest("hex");
    const destructiveProcedure: BuildProcedure = {
      procedureId: "procedure-u7-destructive-graph",
      inputEvaluationHash: version.evaluationHash!,
      procedureSafetyHash: safetyHash,
      phases: ["system_install"],
      steps: [{
        stepId: "commission-truenas-install-target", phase: "system_install", action: "Confirm exact install target.", dependsOn: [],
        instanceIds: [disk.instanceId], requirementIds: [], expectedResult: "One exact target is selected.", failureAction: "Stop.",
        riskLevel: "destructive", stopConditions: ["locator mismatch"], failureBranchStepIds: [], confirmationPolicy: "observation_required",
        safetyCritical: true, dependencyHashes: { procedureSafetyHash: safetyHash }, dependencyHash: stepHash, evidenceRefs: ["guide:system-selection"],
      }],
    };
    const destructiveContext: ProcedureDependencyContext = {
      ...started.replayContext.dependencyContext,
      expectedInputEvaluationHash: version.evaluationHash!,
      expectedProcedureSafetyHash: safetyHash,
      expectedStepDependencyHashes: { "commission-truenas-install-target": stepHash },
    };
    const planRevisionHash = createHash("sha256").update(`buildsim:plan-version-revision-v1:${canonicalJson({
      planId: plan.id, planVersionId: version.id, configHash: version.configHash,
    })}`).digest("hex");
    await executions.create({
      session: {
        executionSessionId: "execution-u7-destructive-graph", planVersionId: version.id,
        procedureId: destructiveProcedure.procedureId, evaluationHash: version.evaluationHash!, procedureSafetyHash: safetyHash,
        status: "active", results: [], destructiveActionConfirmations: [{
          actionId: "destructive.commission-truenas-install-target",
          diskInstanceIds: [disk.instanceId], locatorObservationIds: [locator.observationId],
          inputPlanId: plan.id, inputPlanVersionId: version.id, inputConfigHash: version.configHash,
          inputPlanRevisionHash: planRevisionHash, inputProcedureSafetyHash: safetyHash,
          confirmation: "confirmed", confirmationAt: "2026-08-29T00:19:00.000Z",
        }],
      },
      procedure: destructiveProcedure,
      dependencyContext: destructiveContext,
      leaseToken: "lease-u7-destructive",
      leaseExpiresAt: "2026-08-30T00:00:00.000Z",
    });
    await expect(createProductionReferenceGraph({
      coordinator: restarted.coordinator!, now: () => "2026-08-29T00:00:00.000Z",
    })).resolves.toMatchObject({ graphVersion: "portable-reference-graph-v1" });

    const runtimeState = await restarted.coordinator!.initialize();
    const observationFile = path.join(
      restarted.coordinator!.activeRoot(runtimeState), "observations", "plans", plan.id, "records", `${locator.observationId}.json`,
    );
    const envelope = JSON.parse(await readFile(observationFile, "utf8")) as {
      checksum: string;
      payload: { recordHash: string; observation: UserObservation };
    };
    const { contentHash: _oldContentHash, ...staleObservationBase } = envelope.payload.observation;
    envelope.payload.observation = {
      ...staleObservationBase,
      observedAgainstConfigHash: "0".repeat(64),
      contentHash: createHash("sha256").update(canonicalJson({
        ...staleObservationBase,
        observedAgainstConfigHash: "0".repeat(64),
      })).digest("hex"),
    };
    envelope.payload.recordHash = createHash("sha256").update(canonicalJson(envelope.payload.observation)).digest("hex");
    envelope.checksum = createHash("sha256").update(canonicalJson(envelope.payload)).digest("hex");
    await writeFile(observationFile, `${JSON.stringify(envelope)}\n`, "utf8");
    await expect(createProductionReferenceGraph({
      coordinator: restarted.coordinator!, now: () => "2026-08-29T00:00:00.000Z",
    })).rejects.toThrow(/observation snapshot member hash|disk locator authority/);
  }, 30_000);
});
