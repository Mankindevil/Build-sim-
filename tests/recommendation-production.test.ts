import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { evaluateProgressiveCompatibility } from "../src/compatibility/engine";
import { ProductionRecommendationService } from "../src/recommendation/production";
import { validateRecommendationProductionClosureAtRoot } from "../src/recommendation/production-closure.mjs";
import { PURCHASE_ELIGIBILITY_POLICY, type SolverCandidate } from "../src/solver/contracts";
import type { SolverRecommendationSource } from "../src/server/solver-service";
import { progressiveInput } from "./helpers/progressive-evaluation-fixture";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U10 production recommendation authority", () => {
  it("re-evaluates server-owned solver material, persists exclusion reasons, and replays after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-recommendation-production-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => "2026-08-29T00:00:00.000Z" });
    await coordinator.initialize();
    const config = createEmptyBuildConfigV3("plan-recommendation-production", "Recommendation", "2026-08-29T00:00:00.000Z");
    config.requirementSpec = {
      requirementSpecId: "requirements-recommendation-production", schemaVersion: "1.0.0",
      workloads: [{
        workloadId: "workload-recommendation", name: "Governed workload",
        metrics: [], evidenceOrBenchmarkRefs: ["benchmark:fixture"],
      }], constraints: [],
    };
    const input = await progressiveInput(config);
    input.planVersionId = "version-recommendation-production";
    const originalEvaluationHash = "1".repeat(64);
    const candidate: SolverCandidate = {
      candidateId: "candidate-recommendation-production",
      requirementSpecId: config.requirementSpec.requirementSpecId,
      basePlanVersionId: input.planVersionId,
      baseConfigHash: input.snapshotHashes.configHash,
      candidateConfigRef: "sha256:" + "2".repeat(64),
      operationsRef: "sha256:" + "3".repeat(64),
      buildConfigHash: input.snapshotHashes.configHash,
      inputHashes: structuredClone(input.snapshotHashes),
      evaluationHash: originalEvaluationHash,
      candidateKind: "feasibility_candidate",
      domainCoverage: PURCHASE_ELIGIBILITY_POLICY.requiredDomains.map((domain) => ({
        domain, verdict: "pass", domainHash: "4".repeat(64), evaluationHash: originalEvaluationHash,
        requiredForPurchase: false,
      })),
      residualRequirementIds: [], excludedReasonIds: [],
    };
    const requestRef = "sha256:" + "5".repeat(64);
    const resultRef = "sha256:" + "6".repeat(64);
    const candidateArtifactRef = "sha256:" + "7".repeat(64);
    const jobId = `job-${"8".repeat(64)}`;
    const source: SolverRecommendationSource = {
      planId: config.id, jobId, runtimeGeneration: 1, requestRef, resultRef,
      request: {
        schemaVersion: "whole-build-solver-request-v1", planId: config.id,
        request: {
          basePlanVersionId: input.planVersionId, baseConfigHash: input.snapshotHashes.configHash,
          baseSnapshotHashes: structuredClone(input.snapshotHashes), lockedInstanceIds: [],
          requirementSpecId: config.requirementSpec.requirementSpecId,
          limits: { maxEvaluations: 10, maxDurationMs: 1_000, maxCandidatesPerRequirement: 10 },
        },
        baseConfigRef: "sha256:" + "9".repeat(64), requirementClosureRef: "sha256:" + "a".repeat(64),
        requirements: [], solverVersion: "whole-build-solver-v1", seed: "b".repeat(64), runtimeGeneration: 1,
        basePlanVersionRef: "sha256:" + "c".repeat(64), evaluationLockRef: "sha256:" + "d".repeat(64),
      },
      result: {
        schemaVersion: "whole-build-solver-result-v1", jobId, requestRef,
        checkpointRef: "sha256:" + "e".repeat(64), unsatProof: null,
        result: {
          status: "feasible_complete", solverVersion: "whole-build-solver-v1", seed: "b".repeat(64),
          effectiveLimits: { maxEvaluations: 10, maxDurationMs: 1_000, maxCandidatesPerRequirement: 10 },
          explored: 1, pruned: 0, candidates: [structuredClone(candidate)], unsatisfiedHardConstraintIds: [],
          irreducibleConflictSets: [], searchSummaryRef: "sha256:" + "f".repeat(64),
        },
      },
      baseConfig: structuredClone(config),
      candidates: [{ candidateArtifactRef, candidate: structuredClone(candidate), config: structuredClone(config) }],
    };
    const calls: string[] = [];
    const build = () => new ProductionRecommendationService({
      coordinator,
      solver: {
        async recommendationSourceAtRoot(_activeRoot, requestedJobId, planId) {
          expect(requestedJobId).toBe(jobId);
          expect(planId).toBe(config.id);
          return structuredClone(source);
        },
      },
      candidateInputs: {
        authorityKind: "root-bound-solver-candidate-input-authority-v1",
        async resolveAtRoot(_activeRoot, runtimeGeneration, request) {
          expect(runtimeGeneration).toBe(1);
          expect(request.planId).toBe(config.id);
          return structuredClone(input);
        },
      },
      evaluator: {
        authorityKind: "governed-solver-candidate-evaluator-v1",
        async evaluate(governed) {
          calls.push(governed.snapshotHashes.configHash);
          return { evaluation: await evaluateProgressiveCompatibility(governed), catalogVersion: "fixture", priceSnapshotVersion: null };
        },
      },
      prices: {
        async listObservationsAtRoot() { return []; },
        async listHistoryPointsAtRoot() { return []; },
      },
      now: () => "2026-08-29T00:00:00.000Z",
    });
    const generated = await build().generate({ planId: config.id, solverJobId: jobId });
    expect(calls).toHaveLength(1);
    expect(generated.current).toBe(true);
    expect(generated.set.status).toBe("insufficient_eligible_candidates");
    expect(generated.set.recommendations).toEqual([]);
    expect(generated.set.excluded).toEqual([{
      candidateId: candidate.candidateId,
      reasonIds: expect.arrayContaining(["domain:identity:blocked"]),
    }]);
    const activeRoot = coordinator.activeRoot(await coordinator.readState());
    await expect(validateRecommendationProductionClosureAtRoot({ activeRoot, runtimeGeneration: 1 }))
      .resolves.toMatchObject({ pointers: [generated.setRef] });
    const replay = await build().view(config.id, jobId);
    expect(replay.setRef).toBe(generated.setRef);
    expect(replay.current).toBe(true);
    expect(replay.set).toEqual(generated.set);
  });
});
