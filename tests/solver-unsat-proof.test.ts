import { afterEach, describe, expect, it } from "vitest";
import { solveWholeBuild } from "../src/solver/solve";
import { validateSolverUnsatClosureRuntime } from "../src/solver/runtime-validation.mjs";
import { sha256Json } from "../src/runtime/fs.mjs";
import { createSolverFixture, type SolverFixture } from "./helpers/solver-fixture";

const fixtures: SolverFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

function request(fixture: SolverFixture, maxCandidatesPerRequirement: number) {
  return {
    basePlanVersionId: "version-solver-1", baseConfigHash: fixture.snapshotHashes.configHash,
    baseSnapshotHashes: fixture.snapshotHashes, lockedInstanceIds: [], requirementSpecId: "requirements-solver",
    limits: { maxEvaluations: 10, maxDurationMs: 60_000, maxCandidatesPerRequirement },
  };
}

async function run(fixture: SolverFixture, maxCandidates = 10) {
  return solveWholeBuild({
    planId: fixture.baseConfig.id, request: request(fixture, maxCandidates), baseConfig: fixture.baseConfig,
    requirements: fixture.requirements, candidateService: fixture.candidateService,
    evaluator: fixture.evaluator, artifacts: fixture.artifacts.writer(), solverVersion: "solver-test-v1",
  });
}

describe("whole-build unsat authority", () => {
  it("claims unsat only after every assignment has an authoritative rejection", async () => {
    const fixture = await createSolverFixture({ verdict: "fail" }); fixtures.push(fixture);
    const output = await run(fixture);
    expect(output.result.status).toBe("unsat_proven");
    expect(output.unsatProof).toEqual({ kind: "exhaustive", exploredSearchSpaceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(output.checkpoint.rejections).toHaveLength(2);
    expect(output.checkpoint.rejections.every((item) => item.evaluationReceiptRef?.startsWith("sha256:"))).toBe(true);
    const requestRef = `sha256:${"b".repeat(64)}`;
    const checkpoint = {
      schemaVersion: "solver-job-checkpoint-v1" as const,
      jobId: `job-${"a".repeat(64)}`,
      requestRef,
      runtimeGeneration: 1,
      phase: "result_ready" as const,
      search: output.checkpoint,
      resultRef: null,
      approvalRef: null,
    };
    const checkpointRef = `sha256:${sha256Json(checkpoint)}`;
    const result = {
      schemaVersion: "whole-build-solver-result-v1" as const,
      jobId: checkpoint.jobId,
      requestRef,
      checkpointRef,
      result: output.result,
      unsatProof: output.unsatProof!,
    };
    expect(validateSolverUnsatClosureRuntime(
      result,
      { ref: checkpointRef, value: checkpoint },
      { ref: output.checkpoint.candidateIndexRef, value: output.candidateIndex },
    )).toEqual([]);
    expect(validateSolverUnsatClosureRuntime(
      { ...result, unsatProof: { ...result.unsatProof, exploredSearchSpaceHash: "f".repeat(64) } },
      { ref: checkpointRef, value: checkpoint },
      { ref: output.checkpoint.candidateIndexRef, value: output.candidateIndex },
    )).toContain("solver exhaustive unsat proof hash is not recomputable");
  });

  it("never turns truncation or missing identity authority into a false unsat/feasible result", async () => {
    const truncated = await createSolverFixture({ verdict: "fail" }); fixtures.push(truncated);
    const partialSearch = await run(truncated, 1);
    expect(partialSearch.result.status).toBe("blocked_inputs");
    expect(partialSearch.unsatProof).toBeUndefined();

    const identityBlocked = await createSolverFixture({ includeIdentityClaims: false }); fixtures.push(identityBlocked);
    const blocked = await run(identityBlocked);
    expect(blocked.result.status).toBe("blocked_inputs");
    expect(blocked.result.candidates).toEqual([]);
    expect(blocked.unsatProof).toBeUndefined();
  });
});
