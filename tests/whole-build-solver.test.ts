import { afterEach, describe, expect, it } from "vitest";
import { configV3Hash } from "../src/topology/hash";
import { solveWholeBuild } from "../src/solver/solve";
import { solverCandidateIndexContentHash } from "../src/solver/candidate-index";
import {
  solverCandidateIndexAuthorityReferencesRuntime,
  validateSolverCandidateIndexAuthorityClosureRuntime,
  validateSolverCandidateIndexRuntime,
} from "../src/solver/runtime-validation.mjs";
import { createSolverFixture, type SolverFixture } from "./helpers/solver-fixture";

const fixtures: SolverFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

function request(fixture: SolverFixture, limits = { maxEvaluations: 10, maxDurationMs: 60_000, maxCandidatesPerRequirement: 10 }) {
  return {
    basePlanVersionId: "version-solver-1", baseConfigHash: fixture.snapshotHashes.configHash,
    baseSnapshotHashes: fixture.snapshotHashes, lockedInstanceIds: [], requirementSpecId: "requirements-solver", limits,
  };
}

describe("bounded whole-build solver", () => {
  it("uses only root-bound candidates, preserves user locks, and persists evaluator authority", async () => {
    const fixture = await createSolverFixture(); fixtures.push(fixture);
    const output = await solveWholeBuild({
      planId: fixture.baseConfig.id, request: request(fixture), baseConfig: fixture.baseConfig,
      requirements: fixture.requirements, candidateService: fixture.candidateService,
      evaluator: fixture.evaluator, artifacts: fixture.artifacts.writer(), solverVersion: "solver-test-v1",
    });
    expect(output.result.status).toBe("feasible_complete");
    expect(output.result.candidates).toHaveLength(2);
    expect(validateSolverCandidateIndexRuntime(output.candidateIndex)).toBe(true);
    expect(validateSolverCandidateIndexAuthorityClosureRuntime(output.candidateIndex, {
      factSnapshot: fixture.factSnapshot, capabilityRecords: fixture.capabilityRecords,
      facts: fixture.facts, evidenceClaims: fixture.claims,
    })).toEqual([]);
    const tampered = structuredClone(output.candidateIndex);
    const replacedHash = tampered.pools[0]!.candidates[0]!.capabilityRecordHash;
    tampered.pools[0]!.candidates[0]!.capabilityRecordHash = "f".repeat(64);
    tampered.pools[0]!.source.capabilityRecordHashes = [
      "f".repeat(64),
      ...tampered.pools[0]!.source.capabilityRecordHashes.filter((hash) => hash !== replacedHash),
    ].sort();
    tampered.contentHash = await solverCandidateIndexContentHash(tampered);
    expect(validateSolverCandidateIndexRuntime(tampered)).toBe(false);
    expect(validateSolverCandidateIndexAuthorityClosureRuntime(tampered, {
      factSnapshot: fixture.factSnapshot, capabilityRecords: fixture.capabilityRecords,
      facts: fixture.facts, evidenceClaims: fixture.claims,
    })).not.toEqual([]);
    const omitted = structuredClone(output.candidateIndex);
    omitted.pools[0]!.candidates = omitted.pools[0]!.candidates.slice(0, 1);
    omitted.contentHash = await solverCandidateIndexContentHash(omitted);
    expect(validateSolverCandidateIndexRuntime(omitted)).toBe(true);
    const retainedClaimIds = new Set(omitted.pools[0]!.candidates.flatMap((candidate) => candidate.identityClaimIds));
    expect(validateSolverCandidateIndexAuthorityClosureRuntime(omitted, {
      factSnapshot: fixture.factSnapshot, capabilityRecords: fixture.capabilityRecords,
      facts: fixture.facts, evidenceClaims: fixture.claims.filter((claim) => retainedClaimIds.has(claim.claimId)),
    })).toContain("solver candidate pool omitted an authoritative query match without truncation/blocking");
    expect(solverCandidateIndexAuthorityReferencesRuntime(output.candidateIndex)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: expect.stringMatching(/^fact-snapshot:/) }),
      expect.objectContaining({ ref: expect.stringMatching(/^capability-record:sha256:/) }),
      expect.objectContaining({ ref: expect.stringMatching(/^fact:/) }),
      expect.objectContaining({ ref: expect.stringMatching(/^evidence-claim:claim-sha256-/) }),
    ]));
    for (const candidate of output.result.candidates) {
      expect(candidate.evaluationReceiptRef).toMatch(/^sha256:/);
      expect(candidate.coverageArtifactRef).toMatch(/^sha256:/);
      expect(candidate.candidateArtifactRef).toMatch(/^sha256:/);
      const config = await fixture.artifacts.get<typeof fixture.baseConfig>(candidate.candidateConfigRef, "solver-candidate-config");
      expect(await configV3Hash(config)).toBe(candidate.buildConfigHash);
      expect(config.components.find((component) => component.instanceId === "board-user-locked"))
        .toEqual(fixture.baseConfig.components.find((component) => component.instanceId === "board-user-locked"));
      const added = config.components.find((component) => component.source === "agent");
      expect(added?.identity.status).toBe("resolved");
      if (added?.identity.status === "resolved") expect(added.identity.identityClaimIds[0]).toMatch(/^claim-sha256-/);
    }
    await expect(solveWholeBuild({
      planId: fixture.baseConfig.id, request: request(fixture), baseConfig: fixture.baseConfig,
      requirements: fixture.requirements,
      candidateService: {
        authorityKind: "authoritative-capability-candidate-service-v1",
        query: fixture.candidateService.query.bind(fixture.candidateService),
      } as never,
      evaluator: fixture.evaluator, artifacts: fixture.artifacts.writer(), solverVersion: "solver-test-v1",
    })).rejects.toThrow(/server-issued authoritative capability candidate service/);
  });

  it("never labels blocked, residual, or incomplete governed domain coverage as complete", async () => {
    for (const options of [
      { verdict: "blocked" as const }, { residualRequirementIds: ["requirement-residual"] }, { incompleteCoverage: true },
    ]) {
      const fixture = await createSolverFixture(options); fixtures.push(fixture);
      const output = await solveWholeBuild({
        planId: fixture.baseConfig.id, request: request(fixture), baseConfig: fixture.baseConfig,
        requirements: fixture.requirements, candidateService: fixture.candidateService,
        evaluator: fixture.evaluator, artifacts: fixture.artifacts.writer(), solverVersion: "solver-test-v1",
      });
      expect(output.result.status).toBe("feasible_partial");
      expect(output.result.candidates.length).toBeGreaterThan(0);
    }
  });
});
