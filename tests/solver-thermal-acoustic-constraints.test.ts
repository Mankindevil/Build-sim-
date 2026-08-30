import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { createContentAddressedRef, hashContent, legacySha256Hex, type ArtifactPayload } from "../src/hash";
import type { UserObservation } from "../src/observations/contracts";
import { createPlanEvaluationLock } from "../src/plans/evaluation-lock";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { ProductionAuthoritativeSolverEvaluator, type RootBoundSolverEvaluationAuthority, type SolverProgressiveEvaluationReceiptArtifact } from "../src/server/solver-production";
import { SolverArtifactStore } from "../src/server/solver-service";
import type { GovernedEvaluationInput, ResolvedObservationRecord } from "../src/server/evaluation-service";
import { createProductionSimulationInput } from "../src/simulation/production";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { configV3Hash } from "../src/topology/hash";
import { fact, progressiveInput, PROGRESSIVE_FIXTURE_NOW, resolvedComponent } from "./helpers/progressive-evaluation-fixture";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function quietConfig(planId: string) {
  const config = createEmptyBuildConfigV3(planId, "Quiet build", PROGRESSIVE_FIXTURE_NOW);
  const fan = resolvedComponent("fan-1", "case_fan", "fan.quiet");
  config.components.push(fan);
  config.requirementSpec = {
    requirementSpecId: `requirements-${planId}`,
    schemaVersion: "1.0.0",
    workloads: [{
      workloadId: "quiet-load",
      state: "answered",
      name: "Quiet sustained load",
      source: "user",
      confirmedByUser: true,
      evidenceOrBenchmarkRefs: [],
      metrics: [
        { metricId: "thermal.ambient", operator: "between", value: [22, 24], unitId: "celsius", priority: "must", state: "answered", source: "user", confirmedByUser: true },
        { metricId: "acoustics.noise", operator: "lte", value: 30, unitId: "dba", priority: "must", state: "answered", source: "user", confirmedByUser: true },
      ],
    }],
    constraints: [],
  };
  return { config, fan };
}

async function soundObservation(planId: string, configHash: string): Promise<ResolvedObservationRecord> {
  const material = {
    observationId: "observation-fan-sound",
    planId,
    subjectRef: { kind: "instance" as const, instanceId: "fan-1" },
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
    confirmedByUser: true,
    observedAgainstConfigHash: configHash,
    subjectRevisionHash: "b".repeat(64),
    capturedAt: PROGRESSIVE_FIXTURE_NOW,
    validatedAt: PROGRESSIVE_FIXTURE_NOW,
    status: "active" as const,
  };
  const observation: UserObservation = { ...material, contentHash: await legacySha256Hex(material) };
  return {
    recordHash: await legacySha256Hex(observation),
    observation,
    projectionContext: {
      planId,
      subjectExists: true,
      currentConfigHash: configHash,
      currentSubjectRevisionHash: observation.subjectRevisionHash,
    },
    attachmentClosureVerified: true,
  };
}

async function freezeSimulationInput(input: GovernedEvaluationInput): Promise<void> {
  if (input.config.schemaVersion !== "3.0.0") throw new TypeError("test requires V3");
  const payload = await createProductionSimulationInput({
    config: input.config,
    simulationModelHash: input.snapshotHashes.simulationModelHash,
    caseInstanceOverrides: [],
  });
  const candidate = {
    schemaVersion: "artifact-payload-v1" as const,
    artifactId: `simulation-${input.planId}`,
    mediaType: "application/vnd.buildsim.simulation-input+json",
    payload,
    contentHash: "0".repeat(64),
  };
  const contentHash = await hashContent(candidate, { domain: "artifact", schemaVersion: "artifact-payload-v1" });
  const artifact: ArtifactPayload = { ...candidate, payload: payload as never, contentHash };
  const ref = await createContentAddressedRef(artifact, { domain: "artifact", schemaVersion: "artifact-payload-v1" });
  input.externalInputs.simulationInput = { ref, payload: artifact };
  input.snapshotHashes = { ...input.snapshotHashes, simulationInputHash: ref.contentHash };
  input.evaluationLock = await createPlanEvaluationLock({
    planId: input.planId,
    snapshotHashes: input.snapshotHashes,
    factSnapshotId: input.factClosure.snapshot.snapshotId,
    userObservationSnapshotId: input.observationClosure.snapshot.snapshotId,
    artifactLockfileHash: input.artifactLockfile.lockfileHash,
  });
}

async function evaluate(input: GovernedEvaluationInput) {
  if (input.config.schemaVersion !== "3.0.0") throw new TypeError("test requires V3");
  const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-u9-solver-thermal-acoustic-"));
  roots.push(root);
  const coordinator = new RuntimeCoordinator({ root, now: () => PROGRESSIVE_FIXTURE_NOW });
  await coordinator.initialize();
  const repository = new FileArtifactRepository({ coordinator, now: () => PROGRESSIVE_FIXTURE_NOW });
  await repository.initialize();
  const artifacts = new SolverArtifactStore(repository, () => PROGRESSIVE_FIXTURE_NOW);
  input.planVersionId = "version-thermal-acoustic-1";
  const authority: RootBoundSolverEvaluationAuthority = {
    authorityKind: "root-bound-solver-evaluation-authority-v1",
    async resolveAtRoot(_activeRoot, request) {
      return request.planId === input.planId && request.basePlanVersionId === input.planVersionId
        ? { planId: input.planId, basePlanVersionId: input.planVersionId, input: structuredClone(input) }
        : null;
    },
  };
  const evaluator = new ProductionAuthoritativeSolverEvaluator({ coordinator, authority, artifacts, now: () => PROGRESSIVE_FIXTURE_NOW });
  const receipt = await evaluator.evaluate({
    planId: input.planId,
    basePlanVersionId: input.planVersionId,
    candidateConfig: structuredClone(input.config),
    expectedInputHashes: { ...input.snapshotHashes, configHash: await configV3Hash(input.config) },
  });
  const persisted = await artifacts.get<SolverProgressiveEvaluationReceiptArtifact>(receipt.evaluationReceiptRef, "solver-progressive-evaluation-receipt");
  return { receipt, persisted };
}

describe("U9 solver thermal and acoustic constraints", () => {
  it("keeps a hard quietness target blocked when comparable source data is absent", async () => {
    const { config } = quietConfig("plan-acoustic-blocked");
    const input = await progressiveInput(config);
    await freezeSimulationInput(input);
    const { receipt, persisted } = await evaluate(input);
    expect(receipt.domainCoverage.find(({ domain }) => domain === "acoustic")?.verdict).toBe("blocked");
    expect(receipt.excludedReasonIds).toContain("domain:acoustic:blocked");
    expect(persisted.evaluation.thermalAcousticEvaluation.acoustic.totalDba).toBeNull();
  });

  it("fails the hard quietness target from an exact plan-scoped measurement instead of treating missing product data as a pass", async () => {
    const { config } = quietConfig("plan-acoustic-observed");
    const configHash = await configV3Hash(config);
    const observation = await soundObservation(config.id, configHash);
    const input = await progressiveInput(config, [], [observation]);
    await freezeSimulationInput(input);
    const { receipt, persisted } = await evaluate(input);
    expect(receipt.domainCoverage.find(({ domain }) => domain === "acoustic")?.verdict).toBe("fail");
    expect(persisted.evaluation.thermalAcousticEvaluation).toMatchObject({
      calibration: { appliedAcousticObservationIds: [observation.observation.observationId] },
      acoustic: { totalDba: { lo: 39, hi: 41 }, verdict: "fail", referenceDistanceM: 1 },
    });
  });

  it("fails a hard quietness target from a comparable governed hardware curve", async () => {
    const { config, fan } = quietConfig("plan-acoustic-curve");
    const curve = fact(fan, "acoustic.sound_curve", {
      curveId: "curve.fan.quiet",
      weighting: "A",
      referenceDistanceM: 1,
      loadId: "requirements:quiet-load",
      testMethodId: "method.bounded-chamber",
      points: [{ rpm: 800, lo: 38, hi: 40 }, { rpm: 1600, lo: 43, hi: 45 }],
    });
    const input = await progressiveInput(config, [curve]);
    await freezeSimulationInput(input);
    const { receipt, persisted } = await evaluate(input);
    expect(receipt.domainCoverage.find(({ domain }) => domain === "acoustic")?.verdict).toBe("fail");
    expect(persisted.evaluation.thermalAcousticEvaluation.acoustic).toMatchObject({
      verdict: "fail",
      testMethodId: "method.bounded-chamber",
    });
  });
});
