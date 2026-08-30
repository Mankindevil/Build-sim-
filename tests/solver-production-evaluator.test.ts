import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { SolverArtifactStore } from "../src/server/solver-service";
import {
  ProductionAuthoritativeSolverEvaluator,
  type RootBoundSolverEvaluationAuthority,
  type SolverProgressiveEvaluationCoverageArtifact,
  type SolverProgressiveEvaluationReceiptArtifact,
} from "../src/server/solver-production";
import { validateSolverProgressiveEvaluationClosureRuntime } from "../src/solver/runtime-validation.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { configV3Hash } from "../src/topology/hash";
import { progressiveInput, PROGRESSIVE_FIXTURE_NOW } from "./helpers/progressive-evaluation-fixture";
import { evaluateProgressiveCompatibility } from "../src/compatibility/engine";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("U6 production solver evaluator", () => {
  it("persists and replays exact progressive receipt and domain coverage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-u6-solver-evaluator-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => PROGRESSIVE_FIXTURE_NOW });
    await coordinator.initialize();
    const repository = new FileArtifactRepository({ coordinator, now: () => PROGRESSIVE_FIXTURE_NOW });
    await repository.initialize();
    const artifacts = new SolverArtifactStore(repository, () => PROGRESSIVE_FIXTURE_NOW);
    const config = createEmptyBuildConfigV3("plan-solver-production", "Solver production", PROGRESSIVE_FIXTURE_NOW);
    const baseInput = await progressiveInput(config);
    baseInput.planVersionId = "version-solver-production-1";
    const authority: RootBoundSolverEvaluationAuthority = {
      authorityKind: "root-bound-solver-evaluation-authority-v1",
      async resolveAtRoot(_activeRoot, input) {
        return input.planId === config.id && input.basePlanVersionId === baseInput.planVersionId
          ? { planId: config.id, basePlanVersionId: baseInput.planVersionId!, input: structuredClone(baseInput) }
          : null;
      },
    };
    const evaluator = new ProductionAuthoritativeSolverEvaluator({
      coordinator, authority, artifacts, now: () => PROGRESSIVE_FIXTURE_NOW,
      governedEvaluator: {
        authorityKind: "governed-solver-candidate-evaluator-v1",
        evaluate: async (input) => ({
          evaluation: await evaluateProgressiveCompatibility(input),
          catalogVersion: `progressive:${input.snapshotHashes.adapterSnapshotHash}`,
          priceSnapshotVersion: `snapshot:${input.snapshotHashes.priceSnapshotHash}`,
        }),
      },
    });
    const buildConfigHash = await configV3Hash(config);
    const first = await evaluator.evaluate({
      planId: config.id,
      basePlanVersionId: baseInput.planVersionId,
      candidateConfig: structuredClone(config),
      expectedInputHashes: { ...baseInput.snapshotHashes, configHash: buildConfigHash },
    });

    expect(first).toMatchObject({
      schemaVersion: "authoritative-solver-evaluation-v1",
      planId: config.id,
      basePlanVersionId: baseInput.planVersionId,
      buildConfigHash,
    });
    expect(first.domainCoverage).toHaveLength(12);
    expect(first.domainCoverage.every(({ requiredForPurchase }) => requiredForPurchase === false)).toBe(true);
    const receipt = await artifacts.get<SolverProgressiveEvaluationReceiptArtifact>(
      first.evaluationReceiptRef,
      "solver-progressive-evaluation-receipt",
    );
    const coverage = await artifacts.get<SolverProgressiveEvaluationCoverageArtifact>(
      first.coverageArtifactRef,
      "solver-progressive-evaluation-coverage",
    );
    expect(validateSolverProgressiveEvaluationClosureRuntime(receipt, coverage)).toEqual([]);

    const restartedRepository = new FileArtifactRepository({ coordinator, now: () => PROGRESSIVE_FIXTURE_NOW });
    const restarted = new ProductionAuthoritativeSolverEvaluator({
      coordinator,
      authority,
      artifacts: new SolverArtifactStore(restartedRepository, () => PROGRESSIVE_FIXTURE_NOW),
      now: () => PROGRESSIVE_FIXTURE_NOW,
      governedEvaluator: {
        authorityKind: "governed-solver-candidate-evaluator-v1",
        evaluate: async (input) => ({
          evaluation: await evaluateProgressiveCompatibility(input),
          catalogVersion: `progressive:${input.snapshotHashes.adapterSnapshotHash}`,
          priceSnapshotVersion: `snapshot:${input.snapshotHashes.priceSnapshotHash}`,
        }),
      },
    });
    const second = await restarted.evaluate({
      planId: config.id,
      basePlanVersionId: baseInput.planVersionId,
      candidateConfig: structuredClone(config),
      expectedInputHashes: { ...baseInput.snapshotHashes, configHash: buildConfigHash },
    });
    expect(second.evaluationHash).toBe(first.evaluationHash);
    expect(second.evaluationReceiptRef).toBe(first.evaluationReceiptRef);
    expect(second.coverageArtifactRef).toBe(first.coverageArtifactRef);
  });

  it("rejects a candidate that changes a non-config locked input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-u6-solver-stale-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => PROGRESSIVE_FIXTURE_NOW });
    await coordinator.initialize();
    const repository = new FileArtifactRepository({ coordinator, now: () => PROGRESSIVE_FIXTURE_NOW });
    await repository.initialize();
    const config = createEmptyBuildConfigV3("plan-solver-stale", "Solver stale", PROGRESSIVE_FIXTURE_NOW);
    const baseInput = await progressiveInput(config);
    baseInput.planVersionId = "version-solver-stale-1";
    const evaluator = new ProductionAuthoritativeSolverEvaluator({
      coordinator,
      authority: {
        authorityKind: "root-bound-solver-evaluation-authority-v1",
        async resolveAtRoot() {
          return { planId: config.id, basePlanVersionId: baseInput.planVersionId!, input: structuredClone(baseInput) };
        },
      },
      artifacts: new SolverArtifactStore(repository, () => PROGRESSIVE_FIXTURE_NOW),
      now: () => PROGRESSIVE_FIXTURE_NOW,
    });
    await expect(evaluator.evaluate({
      planId: config.id,
      basePlanVersionId: baseInput.planVersionId,
      candidateConfig: structuredClone(config),
      expectedInputHashes: { ...baseInput.snapshotHashes, engineHash: "0".repeat(64) },
    })).rejects.toThrow(/expected input hashes are stale/);
  });
});
