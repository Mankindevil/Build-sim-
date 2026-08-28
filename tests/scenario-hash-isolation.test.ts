import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { configV3Hash, spatialTopologyHash } from "../src/topology/hash";
import { FileScenarioRepository, type ScenarioBaseSnapshot } from "../src/scenarios/repository";
import type { SnapshotHashes } from "../src/hash";

const roots: string[] = [];
const digest = (value: string) => value.repeat(64);
const now = () => "2026-08-27T00:00:00.000Z";

function snapshots(configHash: string): SnapshotHashes {
  return {
    configHash, requirementSpecHash: digest("1"), factSnapshotHash: digest("2"),
    userObservationSnapshotHash: digest("3"), priceSnapshotHash: digest("4"), ruleSetHash: digest("5"),
    systemProfileHash: digest("6"), adapterSnapshotHash: digest("7"), engineHash: digest("8"),
    simulationModelHash: digest("9"), simulationInputHash: digest("a"),
  };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U2 scenario hash-domain isolation", () => {
  it("keeps active config/version/config hash/spatial hash immutable and returns only a proposal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-scenario-hash-")); roots.push(root);
    const config = createEmptyBuildConfigV3("plan-hash", "Blank", now());
    const configHash = await configV3Hash(config);
    const base: ScenarioBaseSnapshot = {
      planId: "plan-hash", planVersionId: "version-hash", config, configHash, snapshotHashes: snapshots(configHash),
    };
    const baseline = structuredClone(base);
    const baselineSpatialHash = await spatialTopologyHash(config);
    const repository = new FileScenarioRepository({ root, resolveBase: async () => structuredClone(base), now });
    await repository.createFamily({
      familyId: "family-hash", planId: base.planId, name: "Hash isolation",
      basePlanVersionId: base.planVersionId, baseConfigHash: base.configHash, baseSnapshotHashes: base.snapshotHashes,
    });
    await repository.createBranch({
      scenarioId: "scenario-hash", familyId: "family-hash",
      patch: [{ op: "replace", selector: { collection: "config", field: "name" }, value: "Scenario only" }],
    });
    const materialized = await repository.materialize("scenario-hash");
    const proposal = await repository.proposalForAcceptance("scenario-hash", {
      planId: base.planId, planVersionId: base.planVersionId, configHash: base.configHash, draftRevision: 12,
    });

    expect(materialized.config.name).toBe("Scenario only");
    expect(base).toEqual(baseline);
    expect(await configV3Hash(base.config)).toBe(configHash);
    expect(await spatialTopologyHash(base.config)).toBe(baselineSpatialHash);
    expect(proposal).toMatchObject({ kind: "v3-change", expectedPlanVersionId: "version-hash", expectedConfigHash: configHash });
    expect(proposal).not.toHaveProperty("config");
    expect(proposal).not.toHaveProperty("planVersion");
  });

  it("rejects changed base config, snapshots, or version instead of rebasing a branch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-scenario-stale-")); roots.push(root);
    const config = createEmptyBuildConfigV3("plan-stale", "Blank", now());
    const configHash = await configV3Hash(config);
    const base: ScenarioBaseSnapshot = {
      planId: "plan-stale", planVersionId: "version-stale", config, configHash, snapshotHashes: snapshots(configHash),
    };
    let resolved = structuredClone(base);
    const repository = new FileScenarioRepository({ root, resolveBase: async () => structuredClone(resolved), now });
    await repository.createFamily({
      familyId: "family-stale", planId: base.planId, name: "Stale",
      basePlanVersionId: base.planVersionId, baseConfigHash: base.configHash, baseSnapshotHashes: base.snapshotHashes,
    });
    await repository.createBranch({
      scenarioId: "scenario-stale", familyId: "family-stale",
      patch: [{ op: "replace", selector: { collection: "config", field: "name" }, value: "Never silently rebase" }],
    });

    resolved = { ...resolved, snapshotHashes: { ...resolved.snapshotHashes, factSnapshotHash: digest("b") } };
    await expect(repository.materialize("scenario-stale")).rejects.toMatchObject({ code: "stale" });
    resolved = { ...base, planVersionId: "version-replaced" };
    await expect(repository.materialize("scenario-stale")).rejects.toMatchObject({ code: "stale" });
  });
});
