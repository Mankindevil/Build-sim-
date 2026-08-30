import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { FileScenarioRepository } from "../src/scenarios/repository";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { configV3Hash } from "../src/topology/hash";
import { SolverArtifactStore } from "../src/server/solver-service";
import { ReadonlyWhatIfService } from "../src/solver/what-if";
import type { AuthoritativeSolverEvaluator } from "../src/solver/solve";
import type { SnapshotHashes } from "../src/hash";
import { canonicalize } from "../src/hash";
import { sha256Json } from "../src/runtime/fs.mjs";

const roots: string[] = [];
const now = "2026-08-28T00:00:00.000Z";
const digest = (value: string) => value.repeat(64);
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-what-if-")); roots.push(root);
  const coordinator = new RuntimeCoordinator({ root, now: () => now }); await coordinator.initialize();
  const base = createEmptyBuildConfigV3("plan-what-if", "What If", now);
  const baseConfigHash = await configV3Hash(base);
  const snapshots: SnapshotHashes = {
    configHash: baseConfigHash, requirementSpecHash: digest("1"), factSnapshotHash: digest("2"),
    userObservationSnapshotHash: digest("3"), priceSnapshotHash: digest("4"), ruleSetHash: digest("5"),
    systemProfileHash: digest("6"), adapterSnapshotHash: digest("7"), engineHash: digest("8"),
    simulationModelHash: digest("9"), simulationInputHash: digest("a"),
  };
  const scenarios = new FileScenarioRepository({
    coordinator, now: () => now,
    async resolveBaseAtRoot() {
      return { planId: base.id, planVersionId: "version-what-if", config: structuredClone(base), configHash: baseConfigHash, snapshotHashes: snapshots };
    },
  });
  await scenarios.createFamily({
    familyId: "family-what-if", planId: base.id, name: "What if", basePlanVersionId: "version-what-if",
    baseConfigHash, baseSnapshotHashes: snapshots,
  });
  await scenarios.createBranch({
    scenarioId: "scenario-what-if", familyId: "family-what-if", actor: "user",
    patch: [{
      op: "add", selector: { collection: "components", id: "candidate-memory" },
      value: {
        instanceId: "candidate-memory", kind: "memory_module", role: "system_memory", state: "planned",
        identity: { status: "unresolved", userText: "What-if memory" }, source: "user",
      },
    }],
  });
  const artifactRepository = new FileArtifactRepository({ coordinator, now: () => now });
  const artifacts = new SolverArtifactStore(artifactRepository, () => now);
  const evaluator: AuthoritativeSolverEvaluator = {
    authorityKind: "authoritative-solver-evaluator-v1",
    async evaluate(input) {
      const buildConfigHash = await configV3Hash(input.candidateConfig);
      const evaluationHash = sha256Json({ evaluator: "what-if-fixture", buildConfigHash });
      const coverage = [{
        domain: "identity" as const, verdict: "pass" as const,
        domainHash: sha256Json({ domain: "identity", buildConfigHash }), evaluationHash, requiredForPurchase: true,
      }, {
        // This domain is intentionally unchanged even though the outer
        // evaluation receipt hash changes with the candidate config.
        domain: "system" as const, verdict: "pass" as const,
        domainHash: sha256Json({ domain: "system", verdict: "pass" }), evaluationHash, requiredForPurchase: true,
      }];
      const receipt = await artifactRepository.put({
        bytes: Buffer.from(canonicalize({ schemaVersion: "fixture-what-if-receipt-v1", evaluationHash, buildConfigHash })),
        mediaType: "application/json", privacyClass: "runtime_internal", kind: "fixture-what-if-receipt", references: [], createdAt: now,
      });
      const coverageArtifact = await artifactRepository.put({
        bytes: Buffer.from(canonicalize({ schemaVersion: "fixture-what-if-coverage-v1", coverage })),
        mediaType: "application/json", privacyClass: "runtime_internal", kind: "fixture-what-if-coverage", references: [], createdAt: now,
      });
      return {
        schemaVersion: "authoritative-solver-evaluation-v1", planId: input.planId, basePlanVersionId: input.basePlanVersionId,
        buildConfigHash, inputHashes: { ...input.expectedInputHashes, configHash: buildConfigHash }, evaluationHash,
        evaluationReceiptRef: receipt.record.ref, coverageArtifactRef: coverageArtifact.record.ref,
        domainCoverage: coverage, residualRequirementIds: [], unsatisfiedHardConstraintIds: [],
      };
    },
  };
  const writer = artifacts.writer();
  return { coordinator, scenarios, evaluator, writer, service: new ReadonlyWhatIfService({ scenarios, evaluator, artifacts: writer, now: () => now }) };
}

describe("read-only governed what-if", () => {
  it("persists an exact receipt/diff closure in ScenarioRepository without mutating a plan", async () => {
    const { scenarios, service } = await fixture();
    const evaluated = await service.evaluate({ scenarioId: "scenario-what-if" });
    expect(evaluated.artifact.beforeInputHashes).toEqual(evaluated.artifact.baseSnapshotHashes);
    expect(evaluated.artifact.snapshotChangedFields).toEqual(["configHash"]);
    await expect(scenarios.getResult("scenario-what-if")).resolves.toEqual(evaluated.result);
    await expect(service.proposalForAcceptance("scenario-what-if", {
      planId: "plan-what-if", planVersionId: "version-what-if", configHash: evaluated.result.beforeConfigHash, draftRevision: 0,
    })).resolves.toMatchObject({ kind: "v3-change", operations: [{ op: "add" }] });
  });

  it("writes no scenario result when the runtime revision races the final CAS", async () => {
    const { coordinator, scenarios, evaluator, writer } = await fixture();
    let reads = 0;
    const racingScenarios = {
      async materializeComparison(scenarioId: string) {
        const view = await scenarios.materializeComparison(scenarioId);
        reads += 1;
        if (reads === 2) await coordinator.withWrite(async () => undefined);
        return view;
      },
      commitAuthoritativeResult: scenarios.commitAuthoritativeResult.bind(scenarios),
      proposalForAcceptance: scenarios.proposalForAcceptance.bind(scenarios),
    };
    const racing = new ReadonlyWhatIfService({
      scenarios: racingScenarios, evaluator, artifacts: writer, now: () => now,
    });
    await expect(racing.evaluate({ scenarioId: "scenario-what-if" })).rejects.toThrow(/revision|conflict/i);
    await expect(scenarios.getResult("scenario-what-if")).resolves.toBeNull();
  });

  it("persists refreshed before/after input hashes and separates snapshot changes from the config change", async () => {
    const { scenarios, evaluator, writer } = await fixture();
    const refreshed = new ReadonlyWhatIfService({
      scenarios, evaluator, artifacts: writer, now: () => now,
      snapshotAuthority: {
        authorityKind: "what-if-snapshot-authority-v1",
        async resolveRefreshed(input) {
          return {
            before: { ...input.lockedBaseSnapshotHashes, configHash: input.beforeConfigHash, priceSnapshotHash: digest("b") },
            after: { ...input.lockedBaseSnapshotHashes, configHash: input.afterConfigHash, priceSnapshotHash: digest("c") },
          };
        },
      },
    });
    const evaluated = await refreshed.evaluate({ scenarioId: "scenario-what-if", refreshSnapshots: true });
    expect(evaluated.artifact.snapshotAttribution).toBe("refreshed");
    expect(evaluated.artifact.beforeInputHashes.priceSnapshotHash).toBe(digest("b"));
    expect(evaluated.artifact.afterInputHashes.priceSnapshotHash).toBe(digest("c"));
    expect(evaluated.artifact.snapshotChangedFields).toEqual(["configHash", "priceSnapshotHash"]);
    await expect(scenarios.getResult("scenario-what-if")).resolves.toEqual(evaluated.result);
  });
});
