import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRuntimeCatalog } from "../scripts/price-server/catalog/repository.mjs";
import { hashPlanConfig } from "../src/plans/canonical";
import { createWorkspaceRepositories } from "../src/server/workspace-server";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";
import { createProductionProgressiveEvaluationToolActions } from "../src/server/agent-server";
import { createBuildSimTools } from "../src/server/domain-tools";
import { AgentToolRegistry } from "../src/agent/tool-registry";
import type { AgentToolContext } from "../src/agent/contracts";
import { resolveObservationProjectionContext } from "../src/observations/subject-resolution";
import type { UserObservation } from "../src/observations/contracts";
import { sha256Hex } from "../src/plans/canonical";
import { progressiveThermalAcousticMarkup } from "../src/lab/workspace-pages";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writePrice(runtime: ReturnType<typeof createWorkspaceRepositories<BuildConfigV3>>): Promise<void> {
  const inputHash = createHash("sha256").update("u6-production-progressive-price").digest("hex");
  const material = {
    schemaVersion: "1.1.0",
    asOf: "2026-08-29",
    snapshotId: `price-snapshot-${inputHash.slice(0, 20)}`,
    generatedAt: "2026-08-29T00:00:00.000Z",
    catalogVersion: "u6-production-progressive",
    inputHash,
    priceVersion: "price-snapshot-v2",
    quotes: [],
  };
  await runtime.coordinator!.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
    await mkdir(path.join(activeRoot, "prices"), { recursive: true });
    await writeFile(path.join(activeRoot, "prices", "latest.json"), `${JSON.stringify({
      ...material,
      contentHash: createHash("sha256").update(JSON.stringify(material)).digest("hex"),
    })}\n`, "utf8");
  });
}

const enabledEnvironment = (runtimeRoot: string) => ({
  RUNTIME_ROOT: runtimeRoot,
  BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
  BUILD_SIM_FACT_GRAPH_ENABLED: "true",
  BUILD_SIM_USER_OBSERVATIONS_ENABLED: "true",
  BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "true",
  BUILD_SIM_SPATIAL_ROUTING_ENABLED: "true",
  BUILD_SIM_PROGRESSIVE_EVALUATION_ENABLED: "true",
  BUILD_SIM_THERMAL_V3_ENABLED: "true",
  BUILD_SIM_ACOUSTIC_V3_ENABLED: "true",
});

const solverEnvironment = (runtimeRoot: string) => ({
  ...enabledEnvironment(runtimeRoot),
  BUILD_SIM_DURABLE_JOBS_ENABLED: "true",
  BUILD_SIM_WHOLE_BUILD_SOLVER_ENABLED: "true",
});

const whatIfEnvironment = (runtimeRoot: string) => ({
  ...enabledEnvironment(runtimeRoot),
  BUILD_SIM_SCENARIO_WHAT_IF_ENABLED: "true",
});

describe("U6 production progressive evaluation", () => {
  it("applies and retracts an exact plan-scoped acoustic measurement through the production snapshot pipeline", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-u9-observation-production-"));
    roots.push(runtimeRoot);
    const services = createWorkspaceRepositories<BuildConfigV3>(enabledEnvironment(runtimeRoot));
    await services.coordinator!.initialize();
    await initializeRuntimeCatalog({ coordinator: services.coordinator!, generationAware: true });
    await writePrice(services);
    const config = createEmptyBuildConfigV3("plan-u9-observation", "Observed quiet build", "2026-08-29T00:00:00.000Z");
    config.components = [{
      instanceId: "psu-u9-observation",
      kind: "psu",
      role: "primary-power",
      state: "planned",
      identity: { status: "resolved", skuId: "psu.seasonic-focus-gx-850-v5", identityClaimIds: ["claim-psu-u9-observation"] },
      source: "user",
    }];
    config.requirementSpec = {
      requirementSpecId: "requirements-u9-observation",
      schemaVersion: "1.0.0",
      workloads: [{
        workloadId: "quiet-load",
        state: "answered",
        name: "Quiet sustained load",
        source: "user",
        confirmedByUser: true,
        evidenceOrBenchmarkRefs: [],
        metrics: [{
          metricId: "acoustics.noise",
          operator: "lte",
          value: 30,
          unitId: "dba",
          priority: "must",
          state: "answered",
          source: "user",
          confirmedByUser: true,
        }],
      }],
      constraints: [],
    };
    const plan = await services.repository.create({ name: config.name, config });
    const configHash = await hashPlanConfig(plan.draft.config);
    const request = {
      planId: plan.id,
      target: { kind: "draft" as const, expectedDraftRevision: plan.draftRevision, expectedConfigHash: configHash },
    };
    const baselineReceipt = await services.evaluationPipeline!.evaluateCurrent(request);
    expect(baselineReceipt.evaluation).toMatchObject({ thermalAcousticEvaluation: { acoustic: { totalDba: null, verdict: "blocked" } } });

    const subjectRef = { kind: "instance" as const, instanceId: "psu-u9-observation" };
    const projectionContext = await resolveObservationProjectionContext(plan.id, plan.draft.config, subjectRef);
    const proposalMaterial = {
      observationId: "observation-u9-sound-proposed",
      planId: plan.id,
      subjectRef,
      fieldId: "acoustics.sound_pressure" as const,
      value: 40,
      unit: "dba" as const,
      uncertainty: { plusMinus: 1 },
      measurementContext: {
        workloadId: "requirements:quiet-load",
        testMethodId: "method.bounded-chamber",
        referenceDistanceM: 1,
        rpm: { lo: 900, hi: 1100 },
      },
      method: "measurement" as const,
      attachmentRefs: [],
      confirmedByUser: false,
      observedAgainstConfigHash: configHash,
      subjectRevisionHash: projectionContext.currentSubjectRevisionHash,
      capturedAt: "2026-08-29T00:00:00.000Z",
      status: "proposed" as const,
    };
    const proposal: UserObservation = { ...proposalMaterial, contentHash: await sha256Hex(proposalMaterial) };
    await services.observationRepository.put({ observation: proposal });
    const active = await services.observationRepository.activate({
      planId: plan.id,
      observationId: proposal.observationId,
      expectedHash: await sha256Hex(proposal),
      replacementObservationId: "observation-u9-sound-active",
      context: projectionContext,
      validatedAt: "2026-08-29T00:00:01.000Z",
    });
    const observedReceipt = await services.evaluationPipeline!.evaluateCurrent(request);
    expect(observedReceipt.cacheStatus).toBe("miss");
    expect(observedReceipt.evaluation).toMatchObject({
      thermalAcousticEvaluation: {
        calibration: { appliedAcousticObservationIds: [active.observationId] },
        acoustic: { totalDba: { lo: 39, hi: 41 }, verdict: "fail", referenceDistanceM: 1 },
      },
    });
    expect(observedReceipt.evaluationHash).not.toBe(baselineReceipt.evaluationHash);
    if (!("thermalAcousticEvaluation" in observedReceipt.evaluation)) throw new TypeError("production receipt must be progressive");
    const uiProjection = progressiveThermalAcousticMarkup(observedReceipt.evaluation);
    expect(uiProjection).toContain("39.0–41.0 dBA @ 1m");
    expect(uiProjection).toContain(active.observationId);
    expect(uiProjection).toContain("标准化硬件声源结果，不代表房间或用户位置的实际噪音");
    const agentTools = new AgentToolRegistry(createBuildSimTools({
      progressiveEvaluationActions: createProductionProgressiveEvaluationToolActions({
        repository: services.repository,
        pipeline: services.evaluationPipeline!,
        resolvePlanScope: async () => ({ planId: plan.id, configHash }),
      }),
    }));
    const agentProjection = await agentTools.dispatch("get_build_evaluation", { sections: ["thermal", "noise"] }, {
      sessionId: "session-u9-observation",
      runId: "run-u9-observation",
      buildConfig: plan.draft.config,
      signal: new AbortController().signal,
    });
    expect(agentProjection.result).toMatchObject({
      ok: true,
      content: {
        evaluationHash: observedReceipt.evaluationHash,
        sections: {
          thermal: {
            workloadId: "requirements:quiet-load",
            evaluation: { displayNotice: "规划热场插值，非 CFD、非实测" },
          },
          noise: {
            workloadId: "requirements:quiet-load",
            calibration: { appliedObservationIds: [active.observationId] },
            evaluation: {
              totalDba: { lo: 39, hi: 41 },
              referenceDistanceM: 1,
              displayNotice: "标准化硬件声源结果，不代表房间或用户位置的实际噪音",
            },
          },
        },
      },
    });

    const observationsDisabled = createWorkspaceRepositories<BuildConfigV3>({
      ...enabledEnvironment(runtimeRoot),
      BUILD_SIM_USER_OBSERVATIONS_ENABLED: "false",
    });
    const disabledObservationReceipt = await observationsDisabled.evaluationPipeline!.evaluateCurrent(request);
    expect(disabledObservationReceipt.cacheStatus).toBe("hit");
    expect(disabledObservationReceipt.evaluationLock.userObservationSnapshotId).not.toBe(
      observedReceipt.evaluationLock.userObservationSnapshotId,
    );
    expect(disabledObservationReceipt.evaluation).toMatchObject({
      thermalAcousticEvaluation: {
        calibration: { appliedAcousticObservationIds: [] },
        acoustic: { totalDba: null, verdict: "blocked" },
      },
    });

    await services.observationRepository.retract({
      planId: plan.id,
      observationId: active.observationId,
      expectedHash: await sha256Hex(active),
      replacementObservationId: "observation-u9-sound-retracted",
      context: projectionContext,
    });
    const retractedReceipt = await services.evaluationPipeline!.evaluateCurrent(request);
    expect(retractedReceipt.cacheStatus).toBe("hit");
    expect(retractedReceipt.evaluation).toMatchObject({
      thermalAcousticEvaluation: {
        calibration: { appliedAcousticObservationIds: [] },
        acoustic: { totalDba: null, verdict: "blocked" },
      },
    });
    expect(retractedReceipt.evaluationHash).toBe(baselineReceipt.evaluationHash);

    const restarted = createWorkspaceRepositories<BuildConfigV3>(enabledEnvironment(runtimeRoot));
    const replay = await restarted.evaluationPipeline!.evaluateCurrent(request);
    expect(replay.cacheStatus).toBe("hit");
    expect(replay.evaluationHash).toBe(retractedReceipt.evaluationHash);

    const rolloutOffEnvironment = {
      ...enabledEnvironment(runtimeRoot),
      BUILD_SIM_THERMAL_V3_ENABLED: "false",
      BUILD_SIM_ACOUSTIC_V3_ENABLED: "false",
    };
    const rolloutOff = createWorkspaceRepositories<BuildConfigV3>(rolloutOffEnvironment);
    const disabled = await rolloutOff.evaluationPipeline!.evaluateCurrent(request);
    expect(disabled.cacheStatus).toBe("miss");
    expect(disabled.evaluationLock.artifactLockfileHash).not.toBe(replay.evaluationLock.artifactLockfileHash);
    expect(disabled.evaluation).toMatchObject({
      thermalAcousticEvaluation: {
        thermal: { verdict: "blocked", blockedReasonCodes: ["thermal-v3-disabled"] },
        acoustic: { verdict: "blocked", blockedReasonCodes: ["acoustic-v3-disabled"] },
      },
    });
    const rolloutOffRestarted = createWorkspaceRepositories<BuildConfigV3>(rolloutOffEnvironment);
    await expect(rolloutOffRestarted.evaluationPipeline!.evaluateCurrent(request)).resolves.toMatchObject({
      cacheStatus: "hit",
      evaluationHash: disabled.evaluationHash,
    });
  }, 30_000);

  it("hydrates a saved V3 spatial scene from the exact locked adapter artifact and replays it after restart", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-u8-spatial-production-"));
    roots.push(runtimeRoot);
    const services = createWorkspaceRepositories<BuildConfigV3>(enabledEnvironment(runtimeRoot));
    await services.coordinator!.initialize();
    await initializeRuntimeCatalog({ coordinator: services.coordinator!, generationAware: true });
    await writePrice(services);
    const config = createEmptyBuildConfigV3("plan-u8-spatial", "Spatial production", "2026-08-29T00:00:00.000Z");
    config.components = [{
      instanceId: "case-u8-spatial",
      kind: "case",
      role: "chassis",
      state: "planned",
      identity: { status: "resolved", skuId: "case.jonsbo-n6", identityClaimIds: ["claim-case-u8-spatial"] },
      source: "user",
    }];
    const plan = await services.repository.create({ name: config.name, config });
    const configHash = await hashPlanConfig(plan.draft.config);
    const draftReceipt = await services.evaluationPipeline!.evaluateCurrent({
      planId: plan.id,
      target: { kind: "draft", expectedDraftRevision: plan.draftRevision, expectedConfigHash: configHash },
    });
    const version = await services.repository.saveVersion(plan.id, {
      expectedRevision: plan.draftRevision,
      expectedConfigHash: configHash,
      reason: "initial",
      evaluationHash: draftReceipt.evaluationHash,
      evaluatedAt: draftReceipt.evaluatedAt,
      evaluationLock: draftReceipt.evaluationLock,
    });

    const scene = await services.spatialScene!.get(plan.id, version.id);
    expect(scene).toMatchObject({
      schemaVersion: "authoritative-spatial-scene-v1",
      planId: plan.id,
      planVersionId: version.id,
      configHash,
      evaluationHash: draftReceipt.evaluationHash,
      caseInstanceId: "case-u8-spatial",
      caseIdentity: { skuId: "case.jonsbo-n6" },
    });
    expect(scene.model.nodes.some((node) => node.id === "case-shell")).toBe(true);
    expect(scene.model.nodes.some((node) => node.id === "port:port.backplane.power")).toBe(true);

    const restarted = createWorkspaceRepositories<BuildConfigV3>(enabledEnvironment(runtimeRoot));
    await expect(restarted.spatialScene!.get(plan.id, version.id)).resolves.toEqual(scene);
  }, 30_000);

  it("runs the progressive rule engine through the repository-backed workspace pipeline and replays it after restart", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-u6-progressive-production-"));
    roots.push(runtimeRoot);
    const services = createWorkspaceRepositories<BuildConfigV3>(enabledEnvironment(runtimeRoot));
    await services.coordinator!.initialize();
    await initializeRuntimeCatalog({ coordinator: services.coordinator!, generationAware: true });
    await writePrice(services);
    const config = createEmptyBuildConfigV3("plan-u6-progressive", "Progressive", "2026-08-29T00:00:00.000Z");
    const plan = await services.repository.create({ name: config.name, config });
    const configHash = await hashPlanConfig(plan.draft.config);
    const request = {
      planId: plan.id,
      target: { kind: "draft" as const, expectedDraftRevision: plan.draftRevision, expectedConfigHash: configHash },
    };

    const first = await services.evaluationPipeline!.evaluateCurrent(request);
    expect(first.cacheStatus).toBe("miss");
    expect(first.evaluation).toMatchObject({
      kind: "topology-v3-progressive",
      readiness: { profileCompleteness: "empty", powerReady: false, firstBootReady: false },
    });
    expect("requirements" in first.evaluation ? first.evaluation.requirements.length : 0).toBeGreaterThan(0);

    const agentActions = createProductionProgressiveEvaluationToolActions({
      repository: services.repository,
      pipeline: services.evaluationPipeline!,
      resolvePlanScope: async () => ({ planId: plan.id, configHash }),
    });
    const agentTools = new AgentToolRegistry(createBuildSimTools({ progressiveEvaluationActions: agentActions }));
    const agentContext: AgentToolContext = {
      sessionId: "session-u6-production",
      runId: "run-u6-production",
      buildConfig: plan.draft.config,
      signal: new AbortController().signal,
    };
    const agentEvaluation = await agentTools.dispatch(
      "get_build_evaluation",
      { sections: ["findings", "bom", "power", "price"] },
      agentContext,
    );
    expect(agentEvaluation.result).toMatchObject({
      ok: true,
      content: {
        schemaVersion: "agent-progressive-evaluation-v1",
        planId: plan.id,
        configHash,
        evaluationHash: first.evaluationHash,
        evaluationLockHash: first.evaluationLock.contentHash,
        cacheStatus: "hit",
        sections: { power: { ready: false }, price: { projection: { knownSubtotalCny: 0 } } },
      },
    });

    const restarted = createWorkspaceRepositories<BuildConfigV3>(enabledEnvironment(runtimeRoot));
    const second = await restarted.evaluationPipeline!.evaluateCurrent(request);
    expect(second.cacheStatus).toBe("hit");
    expect(second.evaluationHash).toBe(first.evaluationHash);
    expect(second.evaluationLock).toEqual(first.evaluationLock);
    await expect(createProductionReferenceGraph({
      coordinator: restarted.coordinator!,
      now: () => "2026-08-29T00:00:00.000Z",
    })).resolves.toMatchObject({
      graphVersion: "portable-reference-graph-v1",
      compositionId: "buildsim-runtime-reference-composition-v1",
    });
  }, 30_000);

  it("rejects incomplete production flag combinations", () => {
    expect(() => createWorkspaceRepositories<BuildConfigV3>({
      RUNTIME_ROOT: "/tmp/build-sim-u6-invalid-flags",
      BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_PROGRESSIVE_EVALUATION_ENABLED: "true",
    })).toThrow(/requires topology V3, fact graph, and generic adapters/);
  });

  it("runs a saved V3 version through the durable whole-build solver", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-u6-workspace-solver-"));
    roots.push(runtimeRoot);
    const services = createWorkspaceRepositories<BuildConfigV3>(solverEnvironment(runtimeRoot));
    await services.coordinator!.initialize();
    await initializeRuntimeCatalog({ coordinator: services.coordinator!, generationAware: true });
    await writePrice(services);
    const config = createEmptyBuildConfigV3("plan-u6-solver-workspace", "Workspace solver", "2026-08-29T00:00:00.000Z");
    config.requirementSpec = {
      requirementSpecId: "requirements-u6-workspace-solver",
      schemaVersion: "1.0.0",
      workloads: [],
      constraints: [],
    };
    const plan = await services.repository.create({ name: config.name, config });
    const configHash = await hashPlanConfig(plan.draft.config);
    const draftReceipt = await services.evaluationPipeline!.evaluateCurrent({
      planId: plan.id,
      target: { kind: "draft", expectedDraftRevision: plan.draftRevision, expectedConfigHash: configHash },
    });
    const version = await services.repository.saveVersion(plan.id, {
      expectedRevision: plan.draftRevision,
      expectedConfigHash: configHash,
      reason: "initial",
      evaluationHash: draftReceipt.evaluationHash,
      evaluatedAt: draftReceipt.evaluatedAt,
      evaluationLock: draftReceipt.evaluationLock,
    });
    await services.evaluationPipeline!.evaluateCurrent({
      planId: plan.id,
      target: { kind: "version", versionId: version.id, expectedConfigHash: version.configHash },
    });

    const enqueued = await services.wholeBuildSolver!.enqueue({
      planId: plan.id,
      basePlanVersionId: version.id,
      lockedInstanceIds: [],
      requirementSpecId: config.requirementSpec.requirementSpecId,
      limits: { maxEvaluations: 16, maxDurationMs: 5_000, maxCandidatesPerRequirement: 4 },
    });
    expect(enqueued.job.status).toBe("queued");
    const tick = await services.wholeBuildSolver!.tick();
    expect(tick.worker.outcome).toBe("succeeded");
    const status = await services.wholeBuildSolver!.status(enqueued.job.jobId);
    expect(status.job.status).toBe("succeeded");
    expect(status.result?.result).toMatchObject({ status: "unsat_proven", candidates: [] });

    const restarted = createWorkspaceRepositories<BuildConfigV3>(solverEnvironment(runtimeRoot));
    const replay = await restarted.wholeBuildSolver!.status(enqueued.job.jobId);
    expect(replay.result).toEqual(status.result);
    await expect(createProductionReferenceGraph({
      coordinator: restarted.coordinator!,
      now: () => "2026-08-29T00:00:00.000Z",
    })).resolves.toMatchObject({ graphVersion: "portable-reference-graph-v1" });
  }, 30_000);

  it("evaluates and replays a read-only production what-if from a saved V3 version", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-u6-workspace-what-if-"));
    roots.push(runtimeRoot);
    const services = createWorkspaceRepositories<BuildConfigV3>(whatIfEnvironment(runtimeRoot));
    await services.coordinator!.initialize();
    await initializeRuntimeCatalog({ coordinator: services.coordinator!, generationAware: true });
    await writePrice(services);
    const config = createEmptyBuildConfigV3("plan-u6-what-if-workspace", "What-if base", "2026-08-29T00:00:00.000Z");
    const plan = await services.repository.create({ name: config.name, config });
    const configHash = await hashPlanConfig(plan.draft.config);
    const draftReceipt = await services.evaluationPipeline!.evaluateCurrent({
      planId: plan.id,
      target: { kind: "draft", expectedDraftRevision: plan.draftRevision, expectedConfigHash: configHash },
    });
    const version = await services.repository.saveVersion(plan.id, {
      expectedRevision: plan.draftRevision,
      expectedConfigHash: configHash,
      reason: "initial",
      evaluationHash: draftReceipt.evaluationHash,
      evaluatedAt: draftReceipt.evaluatedAt,
      evaluationLock: draftReceipt.evaluationLock,
    });
    await services.evaluationPipeline!.evaluateCurrent({
      planId: plan.id,
      target: { kind: "version", versionId: version.id, expectedConfigHash: version.configHash },
    });
    const beforePlan = await services.repository.get(plan.id);
    await services.scenarioWhatIf!.createFamily({
      familyId: "family-u6-production",
      planId: plan.id,
      name: "Production comparison",
      basePlanVersionId: version.id,
    });
    await services.scenarioWhatIf!.createBranch({
      scenarioId: "scenario-u6-production",
      familyId: "family-u6-production",
      planId: plan.id,
      patch: [{ op: "replace", selector: { collection: "config", field: "name" }, value: "What-if branch" }],
    });
    const evaluated = await services.scenarioWhatIf!.evaluate({
      planId: plan.id,
      scenarioId: "scenario-u6-production",
      refreshSnapshots: false,
    });
    expect(evaluated.artifact).toMatchObject({
      schemaVersion: "solver-what-if-result-v1",
      scenarioId: "scenario-u6-production",
      snapshotAttribution: "same_snapshots",
      proposalOnly: true,
    });
    expect(await services.repository.get(plan.id)).toEqual(beforePlan);
    await services.scenarioWhatIf!.createBranch({
      scenarioId: "scenario-u6-production-refreshed",
      familyId: "family-u6-production",
      planId: plan.id,
      patch: [{ op: "replace", selector: { collection: "config", field: "name" }, value: "What-if refreshed branch" }],
    });
    const refreshed = await services.scenarioWhatIf!.evaluate({
      planId: plan.id,
      scenarioId: "scenario-u6-production-refreshed",
      refreshSnapshots: true,
    });
    expect(refreshed.artifact.proposalOnly).toBe(true);
    expect(refreshed.artifact.snapshotAttribution).toBe(
      refreshed.artifact.snapshotChangedFields.some((field) => field !== "configHash") ? "refreshed" : "same_snapshots",
    );
    expect(await services.repository.get(plan.id)).toEqual(beforePlan);

    const restarted = createWorkspaceRepositories<BuildConfigV3>(whatIfEnvironment(runtimeRoot));
    const restored = await restarted.scenarioWhatIf!.getScenario(plan.id, "scenario-u6-production");
    expect(restored.result).toEqual(evaluated.result);
    expect((await restarted.scenarioWhatIf!.proposal(plan.id, "scenario-u6-production"))).toMatchObject({
      id: "proposal-scenario-u6-production",
      planId: plan.id,
      expectedConfigHash: version.configHash,
      expectedDraftRevision: 0,
      configSchemaVersion: "3.0.0",
      status: "proposed",
      operations: [{ op: "replace", selector: { collection: "config", field: "name" }, value: "What-if branch" }],
    });
    await expect(createProductionReferenceGraph({
      coordinator: restarted.coordinator!,
      now: () => "2026-08-29T00:00:00.000Z",
    })).resolves.toMatchObject({ graphVersion: "portable-reference-graph-v1" });
  }, 60_000);
});
