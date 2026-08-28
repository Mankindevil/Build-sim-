import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { FileScenarioRepository, ScenarioRepositoryError, type ScenarioBaseSnapshot } from "../src/scenarios/repository";
import type { SnapshotHashes } from "../src/hash";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { sha256Json } from "../src/runtime/fs.mjs";
import { createScenarioSnapshotSetManifest } from "../src/scenarios/runtime-validation.mjs";

const roots: string[] = [];
const digest = (character: string): string => character.repeat(64);
const now = () => "2026-08-27T00:00:00.000Z";

function hashes(configHash = digest("a")): SnapshotHashes {
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

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-scenarios-"));
  roots.push(root);
  const base: ScenarioBaseSnapshot = {
    planId: "plan-base",
    planVersionId: "version-base",
    config: createEmptyBuildConfigV3("plan-base", "Blank", now()),
    configHash: digest("a"),
    snapshotHashes: hashes(),
  };
  const resolveBase = async (versionId: string) => versionId === base.planVersionId ? structuredClone(base) : null;
  const repository = new FileScenarioRepository({ root, resolveBase, now });
  return { root, base, resolveBase, repository };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U2 immutable what-if repository", () => {
  it("persists a branch independently and materializes without mutating the active base", async () => {
    const { root, base, resolveBase, repository } = await fixture();
    await repository.createFamily({
      familyId: "family-upgrade", planId: base.planId, name: "Upgrade", basePlanVersionId: base.planVersionId,
      baseConfigHash: base.configHash, baseSnapshotHashes: base.snapshotHashes,
    });
    const snapshotManifest = createScenarioSnapshotSetManifest(base.snapshotHashes);
    expect(JSON.parse(await readFile(path.join(root, "snapshots", `${snapshotManifest.snapshotSetId}.json`), "utf8")))
      .toEqual(snapshotManifest);
    await repository.createBranch({
      scenarioId: "scenario-gpu", familyId: "family-upgrade",
      patch: [{ op: "add", selector: { collection: "components", id: "gpu-1" }, value: {
        instanceId: "gpu-1", kind: "gpu", role: "discrete_gpu", state: "planned",
        identity: { status: "unresolved", userText: "future GPU" }, source: "user",
      } }],
    });

    const materialized = await repository.materialize("scenario-gpu");
    expect(materialized.config.components).toHaveLength(1);
    expect(base.config.components).toEqual([]);

    const restarted = new FileScenarioRepository({ root, resolveBase, now });
    expect((await restarted.listBranches("family-upgrade")).map((branch) => branch.scenarioId)).toEqual(["scenario-gpu"]);
    expect(await restarted.proposalForAcceptance("scenario-gpu", {
      planId: base.planId, planVersionId: base.planVersionId, configHash: base.configHash, draftRevision: 7,
    })).toMatchObject({ kind: "v3-change", expectedDraftRevision: 7, operations: [{ op: "add" }] });
  });

  it("rejects stale bases and never turns acceptance into a direct plan write", async () => {
    const { base, repository } = await fixture();
    await repository.createFamily({ familyId: "family-upgrade", planId: base.planId, name: "Upgrade", basePlanVersionId: base.planVersionId, baseConfigHash: base.configHash, baseSnapshotHashes: base.snapshotHashes });
    await repository.createBranch({ scenarioId: "scenario-name", familyId: "family-upgrade", patch: [{ op: "replace", selector: { collection: "config", field: "name" }, value: "Changed only in scenario" }] });
    await expect(repository.proposalForAcceptance("scenario-name", {
      planId: base.planId, planVersionId: base.planVersionId, configHash: digest("9"), draftRevision: 0,
    })).rejects.toMatchObject({ code: "stale" });
    expect(base.config.name).toBe("Blank");
  });

  it("fails closed on corrupt envelopes and conflicting immutable IDs", async () => {
    const { root, base, repository } = await fixture();
    const input = { familyId: "family-upgrade", planId: base.planId, name: "Upgrade", basePlanVersionId: base.planVersionId, baseConfigHash: base.configHash, baseSnapshotHashes: base.snapshotHashes };
    await repository.createFamily(input);
    await expect(repository.createFamily({ ...input, name: "Different" })).rejects.toMatchObject({ code: "conflict" });
    await writeFile(path.join(root, "families", "family-upgrade.json"), JSON.stringify({ schemaVersion: "scenario-repository-envelope-v1", kind: "family", checksum: digest("0"), payload: input }));
    await expect(repository.getFamily("family-upgrade")).rejects.toBeInstanceOf(ScenarioRepositoryError);
  });

  it("fails closed when the content-addressed snapshot-set manifest is missing or tampered", async () => {
    const { root, base, repository } = await fixture();
    const input = { familyId: "family-snapshots", planId: base.planId, name: "Snapshots", basePlanVersionId: base.planVersionId, baseConfigHash: base.configHash, baseSnapshotHashes: base.snapshotHashes };
    await repository.createFamily(input);
    const manifest = createScenarioSnapshotSetManifest(base.snapshotHashes);
    const file = path.join(root, "snapshots", `${manifest.snapshotSetId}.json`);
    const tampered = structuredClone(manifest); tampered.snapshotHashes.priceSnapshotHash = digest("9");
    await writeFile(file, JSON.stringify(tampered));
    await expect(repository.getFamily(input.familyId)).rejects.toMatchObject({ code: "corrupt_data" });
    await rm(file);
    await expect(repository.getFamily(input.familyId)).rejects.toMatchObject({ code: "corrupt_data" });
  });

  it("uses the active runtime generation and is fenced by maintenance", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-scenario-runtime-"));
    roots.push(runtimeRoot);
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now });
    const base: ScenarioBaseSnapshot = {
      planId: "plan-base", planVersionId: "version-base",
      config: createEmptyBuildConfigV3("plan-base", "Blank", now()),
      configHash: digest("a"), snapshotHashes: hashes(),
    };
    const resolvedRoots: string[] = [];
    const repository = new FileScenarioRepository({
      coordinator, runtimeRoot,
      resolveBaseAtRoot: async (activeRoot) => { resolvedRoots.push(activeRoot); return structuredClone(base); },
      now,
    });
    await repository.createFamily({ familyId: "family-runtime", planId: base.planId, name: "Runtime", basePlanVersionId: base.planVersionId, baseConfigHash: base.configHash, baseSnapshotHashes: base.snapshotHashes });
    const state = await coordinator.readState();
    await expect(access(path.join(runtimeRoot, state.activeRoot, "scenarios", "families", "family-runtime.json"))).resolves.toBeUndefined();
    expect(new Set(resolvedRoots)).toEqual(new Set([coordinator.activeRoot(state)]));

    await coordinator.acquireMaintenanceLease("restore", 60_000);
    await expect(repository.createBranch({ scenarioId: "scenario-fenced", familyId: "family-runtime", patch: [{ op: "replace", selector: { collection: "config", field: "name" }, value: "Blocked" }] }))
      .rejects.toThrow(/maintenance lease/i);
  });

  it("binds the creation actor and rejects checksum-valid actor laundering on restart", async () => {
    const { root, base, resolveBase, repository } = await fixture();
    await repository.createFamily({ familyId: "family-agent", planId: base.planId, name: "Agent", basePlanVersionId: base.planVersionId, baseConfigHash: base.configHash, baseSnapshotHashes: base.snapshotHashes });
    await repository.createBranch({
      scenarioId: "scenario-agent", familyId: "family-agent", actor: "agent",
      patch: [{ op: "add", selector: { collection: "components", id: "gpu-agent" }, value: {
        instanceId: "gpu-agent", kind: "gpu", role: "discrete_gpu", state: "planned",
        identity: { status: "unresolved", userText: "proposal" }, source: "agent",
      } }],
    });
    await expect(repository.createBranch({
      scenarioId: "scenario-agent-migration", familyId: "family-agent", actor: "agent",
      patch: [{ op: "add", selector: { collection: "components", id: "gpu-migration" }, value: {
        instanceId: "gpu-migration", kind: "gpu", role: "discrete_gpu", state: "planned",
        identity: { status: "unresolved", userText: "proposal" }, source: "migration",
      } }],
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.createBranch({
      scenarioId: "scenario-agent-default", familyId: "family-agent", actor: "agent",
      patch: [{ op: "replace", selector: { collection: "config", field: "intent" }, value: {
        state: "answered", value: "nas", source: "defaulted", confirmedByUser: false,
      } }],
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.createBranch({
      scenarioId: "scenario-user-migration", familyId: "family-agent", actor: "user",
      patch: [{ op: "add", selector: { collection: "components", id: "gpu-user-migration" }, value: {
        instanceId: "gpu-user-migration", kind: "gpu", role: "discrete_gpu", state: "planned",
        identity: { status: "unresolved", userText: "proposal" }, source: "migration",
      } }],
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.createBranch({
      scenarioId: "scenario-system-component", familyId: "family-agent", actor: "system",
      patch: [{ op: "add", selector: { collection: "components", id: "gpu-system" }, value: {
        instanceId: "gpu-system", kind: "gpu", role: "discrete_gpu", state: "planned",
        identity: { status: "unresolved", userText: "proposal" }, source: "agent",
      } }],
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.createBranch({
      scenarioId: "scenario-user-intent", familyId: "family-agent", actor: "user",
      patch: [{ op: "replace", selector: { collection: "config", field: "intent" }, value: {
        state: "answered", value: "nas", source: "user", confirmedByUser: true,
      } }],
    })).resolves.toMatchObject({ createdByActor: "user" });
    await expect(repository.createBranch({
      scenarioId: "scenario-system-intent", familyId: "family-agent", actor: "system",
      patch: [{ op: "replace", selector: { collection: "config", field: "intent" }, value: {
        state: "answered", value: "nas", source: "defaulted", confirmedByUser: false,
      } }],
    })).resolves.toMatchObject({ createdByActor: "system" });
    await expect(repository.createBranch({
      scenarioId: "scenario-agent-system", familyId: "family-agent", actor: "agent",
      patch: [{ op: "replace", selector: { collection: "config", field: "system" }, value: {
        profileId: "system.linux-desktop", versionFactId: "release-1", source: "defaulted", lockedByUser: false,
      } }],
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.createBranch({
      scenarioId: "scenario-user-system-spoof", familyId: "family-agent", actor: "user",
      patch: [{ op: "replace", selector: { collection: "config", field: "system" }, value: {
        profileId: "system.linux-desktop", versionFactId: "release-1", source: "defaulted", lockedByUser: false,
      } }],
    })).rejects.toMatchObject({ code: "invalid_input" });
    const file = path.join(root, "branches", "scenario-agent.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.payload.patch = [{ op: "add", selector: { collection: "roleDecisions", id: "decision-user" }, value: {
      roleDecisionId: "decision-user", role: "discrete_gpu", decision: "not_needed", source: "user", confirmedAt: now(),
    } }];
    stored.checksum = sha256Json(stored.payload);
    await writeFile(file, JSON.stringify(stored));
    const restarted = new FileScenarioRepository({ root, resolveBase, now });
    await expect(restarted.getBranch("scenario-agent")).rejects.toMatchObject({ code: "corrupt_data" });
  });

  it("rejects resolved scenario identities that the catalog cannot prove at write time", async () => {
    const { base, repository } = await fixture();
    await repository.createFamily({
      familyId: "family-catalog", planId: base.planId, name: "Catalog", basePlanVersionId: base.planVersionId,
      baseConfigHash: base.configHash, baseSnapshotHashes: base.snapshotHashes,
    });
    for (const [scenarioId, skuId] of [["scenario-wrong-kind", "case.jonsbo-n6"], ["scenario-missing-sku", "nic.does-not-exist"]] as const) {
      await expect(repository.createBranch({
        scenarioId, familyId: "family-catalog", actor: "user",
        patch: [{ op: "add", selector: { collection: "components", id: scenarioId }, value: {
          instanceId: scenarioId, kind: "nic", role: "network_adapter", state: "planned",
          identity: { status: "resolved", skuId, identityClaimIds: [`claim-${scenarioId}`] }, source: "user",
        } }],
      })).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("keeps persisted results fail-closed until a governed replay evaluator exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-scenario-result-")); roots.push(root);
    const base: ScenarioBaseSnapshot = {
      planId: "plan-result", planVersionId: "version-result",
      config: createEmptyBuildConfigV3("plan-result", "Blank", now()),
      configHash: digest("a"), snapshotHashes: hashes(),
    };
    const available: ScenarioBaseSnapshot | null = structuredClone(base);
    const repository = new FileScenarioRepository({
      root, resolveBase: async () => available ? structuredClone(available) : null, now,
    });
    await repository.createFamily({ familyId: "family-result", planId: base.planId, name: "Result", basePlanVersionId: base.planVersionId, baseConfigHash: base.configHash, baseSnapshotHashes: base.snapshotHashes });
    const originalBaseHash = sha256Json(base.config);
    await repository.createBranch({ scenarioId: "scenario-result", familyId: "family-result", patch: [{ op: "replace", selector: { collection: "config", field: "name" }, value: "Evaluated scenario" }] });
    await expect(repository.saveResult("scenario-result")).rejects.toMatchObject({ code: "evaluation_authority_unavailable" });
    expect(await repository.getResult("scenario-result")).toBeNull();
    expect(sha256Json(base.config)).toBe(originalBaseHash);
  });
});
