import { afterEach, describe, expect, it } from "vitest";
import { canonicalize } from "../src/hash";
import { solveWholeBuild } from "../src/solver/solve";
import { createSolverFixture, type SolverFixture } from "./helpers/solver-fixture";

const fixtures: SolverFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

async function run(fixture: SolverFixture) {
  return solveWholeBuild({
    planId: fixture.baseConfig.id,
    request: {
      basePlanVersionId: "version-solver-1", baseConfigHash: fixture.snapshotHashes.configHash,
      baseSnapshotHashes: fixture.snapshotHashes, lockedInstanceIds: [], requirementSpecId: "requirements-solver",
      limits: { maxEvaluations: 10, maxDurationMs: 60_000, maxCandidatesPerRequirement: 10 },
    },
    baseConfig: fixture.baseConfig, requirements: fixture.requirements, candidateService: fixture.candidateService,
    evaluator: fixture.evaluator, artifacts: fixture.artifacts.writer(), solverVersion: "solver-test-v1",
    nowMs: () => 0,
  });
}

describe("solver determinism", () => {
  it("replays identical ordering, hashes, checkpoints, and result authority", async () => {
    const first = await createSolverFixture(); const second = await createSolverFixture(); fixtures.push(first, second);
    const [left, right] = await Promise.all([run(first), run(second)]);
    expect(canonicalize(left)).toBe(canonicalize(right));
  });
});
