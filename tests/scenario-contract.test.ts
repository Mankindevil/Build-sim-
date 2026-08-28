import { describe, expect, it } from "vitest";
import {
  compareWhatIfSnapshots,
  SCENARIO_SCHEMA_VERSION,
  validateScenarioFamily,
  validateScenarioBranch,
  validateWhatIfResult,
  type ScenarioBranch,
} from "../src/scenarios/contracts";
import type { SnapshotHashes } from "../src/hash";

const digest = (character: string): string => character.repeat(64);

function snapshotHashes(configHash = digest("a")): SnapshotHashes {
  return {
    configHash,
    requirementSpecHash: digest("b"),
    factSnapshotHash: digest("c"),
    userObservationSnapshotHash: digest("d"),
    priceSnapshotHash: digest("e"),
    ruleSetHash: digest("f"),
    systemProfileHash: digest("1"),
    adapterSnapshotHash: digest("2"),
    engineHash: digest("3"),
    simulationModelHash: digest("4"),
    simulationInputHash: digest("5"),
  };
}

function validBranch(): ScenarioBranch {
  return {
    scenarioId: "scenario-gpu",
    familyId: "family-upgrade",
    basePlanVersionId: "plan-version-1",
    baseConfigHash: digest("a"),
    baseSnapshotHashes: snapshotHashes(),
    patch: [{ op: "add", selector: { collection: "components", id: "gpu-1" }, value: {
      instanceId: "gpu-1",
      kind: "gpu",
      role: "discrete_gpu",
      state: "planned",
      identity: { status: "unresolved", userText: "a future GPU" },
      source: "user",
    } }],
  };
}

describe("U0 scenario branch contracts", () => {
  it("uses governed V3 topology and simulation patches", () => {
    const branch = validBranch();
    branch.patch.push({
      op: "replace",
      selector: { collection: "vdevs", parentId: "layout-main", id: "vdev-data", field: "topology" },
      value: "raidz2",
    });
    branch.simulationInputPatch = [
      { op: "replace", path: "/ambientC/max", value: 30 },
      { op: "replace", path: "/storageActivity/0/logicalLayoutId", value: "layout-1" },
    ];
    expect(validateScenarioBranch(branch)).toEqual([]);
  });

  it("rejects array-index JSON Pointer, metadata/derived targets and ungoverned operations", () => {
    const branch = validBranch() as unknown as Record<string, unknown>;
    branch.patch = [
      { op: "replace", path: "/selection/gpuId", value: "gpu.example" },
      { op: "replace", path: "/scenarioId", value: "hidden-hash-change" },
      { op: "test", selector: { collection: "config", field: "name" }, value: "x" },
      { op: "replace", selector: { collection: "components", id: "gpu-1", field: "evaluation" }, value: { verdict: "pass" } },
    ];
    const errors = validateScenarioBranch(branch);
    expect(errors).toContain("patch.0: patch operation contains unknown fields");
    expect(errors).toContain("patch.1: patch operation contains unknown fields");
    expect(errors).toContain("patch.2: patch operation op is not allowlisted");
    expect(errors).toContain("patch.3: replace selector field is not allowlisted");
  });

  it("rejects selector/value mismatches and Agent confirmation bypasses", () => {
    const branch = validBranch() as unknown as Record<string, unknown>;
    branch.patch = [{
      op: "add", selector: { collection: "components", id: "gpu-1" }, value: {
        instanceId: "gpu-2", kind: "gpu", role: "discrete_gpu", state: "planned",
        identity: { status: "unresolved", userText: "GPU", currentFact: "invented" }, source: "agent",
      },
    }];
    expect(validateScenarioBranch(branch)).toEqual(expect.arrayContaining([
      "patch.0: components selector id must equal instanceId",
      "patch.0: unresolved identity contains unknown fields",
    ]));
    branch.patch = [{
      op: "replace", selector: { collection: "config", field: "system" },
      value: { profileId: "system.windows-11", versionFactId: "release-fact", source: "user", lockedByUser: true },
    }];
    expect(validateScenarioBranch(branch, { actor: "agent" })).toContain(
      "patch.0: agent patch cannot assert user source, confirmation, confirmedAt or lockedByUser",
    );
  });

  it("binds a branch to the exact base config snapshot", () => {
    const branch = validBranch();
    branch.baseConfigHash = digest("9");
    expect(validateScenarioBranch(branch)).toContain("baseConfigHash must match baseSnapshotHashes.configHash");
    expect(validateScenarioBranch({ ...validBranch(), patch: [], evaluation: {} })).toEqual(expect.arrayContaining([
      "scenario branch contains topology, evaluation or unknown fields",
      "scenario branch must contain at least one governed patch operation",
    ]));
  });

  it("attributes snapshot changes without persisting scenario metadata in topology", () => {
    const before = snapshotHashes();
    expect(compareWhatIfSnapshots(before, { ...before })).toEqual({ attribution: "same_snapshots", changedSnapshotFields: [] });
    expect(compareWhatIfSnapshots(before, { ...before, priceSnapshotHash: digest("8") })).toEqual({
      attribution: "refreshed",
      changedSnapshotFields: ["priceSnapshotHash"],
    });
  });

  it("validates immutable scenario family bindings and what-if result records", () => {
    const family = {
      schemaVersion: SCENARIO_SCHEMA_VERSION,
      familyId: "family-upgrade",
      planId: "plan-1",
      name: "GPU upgrade",
      basePlanVersionId: "version-1",
      baseConfigHash: digest("a"),
      baseSnapshotHashes: snapshotHashes(),
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
    expect(validateScenarioFamily(family)).toEqual([]);
    expect(validateScenarioFamily({ ...family, baseConfigHash: digest("9") })).toContain("baseConfigHash must match baseSnapshotHashes.configHash");
    expect(validateWhatIfResult({
      scenarioId: "scenario-gpu",
      beforeEvaluationHash: digest("1"),
      afterEvaluationHash: digest("2"),
      decisionDiffRef: `sha256:${digest("6")}`,
      domainDiffRefs: [`sha256:${digest("7")}`],
      snapshotAttribution: "same_snapshots",
    })).toEqual([]);
    expect(validateWhatIfResult({
      scenarioId: "scenario-gpu",
      beforeEvaluationHash: "not-a-hash",
      afterEvaluationHash: digest("2"),
      decisionDiffRef: `sha256:${digest("6")}`,
      domainDiffRefs: ["duplicate", "duplicate"],
      snapshotAttribution: "invented",
      config: {},
    })).toEqual(expect.arrayContaining([
      "what-if result contains topology, mutable plan data or unknown fields",
      "what-if evaluation hashes invalid",
      "what-if domain diff refs invalid",
      "what-if snapshot attribution invalid",
    ]));
  });
});
